import { query } from '../config/db.js';
import { SQL_TODAY, TIME_ZONE } from '../config/env.js';
import { todayDateOnly } from '../utils/dates.js';
import { aiFailureReason, askAiText } from './aiClient.js';

// The machinery part of Analytics: bookings and schedule, utilization, revenue
// and cost per machine, maintenance alerts and downtime for a period, plus a
// seasonal demand forecast, the return on investment per machine and
// recommendations (AI, or the rules below when AI is not available).
//
// Revenue follows the cooperative's net income (services/netIncome.js): fees
// of rentals that have started, a rental also recorded as a service counted
// once (as the service), plus service fees (billed; the unpaid part is
// "uncollected"). Costs are the machinery expenses entered per machine.

// The thresholds of the alerts and rule-based recommendations.
const HIGH_UTILIZATION = 75;
const LOW_UTILIZATION = 20;
const HIGH_DOWNTIME_SHARE = 20;
const HIGH_REPAIR_SHARE = 40;
const MAINTENANCE_DUE_SOON_DAYS = 14;
const STALE_MAINTENANCE_DAYS = 180;
const UPCOMING_DAYS = 14;
const FORECAST_MONTHS = 6;

export const MACHINERY_METHODOLOGY = {
  utilization: 'Days a machine was booked or did a service, divided by the days of the period it was owned, up to today. Days a machine worked under both a booking and a service count once.',
  revenue: 'Fees of rentals that have started (a rental also recorded as a service counts once, as the service) plus the fees of services done. Uncollected is the unpaid part of those service fees.',
  cost: 'Fuel, labor, repair & maintenance and other expenses entered for the machine in the period.',
  downtime: 'Time the machine was set to "maintenance", from the status changes in the audit log. A machine already in maintenance before status changes were recorded is shown as down, but its days cannot be counted.',
  forecast: 'Machine-days per month: the average of the same month in past years, times the trend (each of the last 12 complete months against the same month a year before, where records go back that far; kept between 0.5 and 2). Months with no history use the average of the last 3 complete months.',
  roi: 'Earned back = lifetime net (revenue less costs since delivery) divided by the purchase cost. Per year = that net per year owned divided by the purchase cost. Payback = purchase cost divided by the net per year.',
  rules: `High use is ${HIGH_UTILIZATION}% or more of the days owned, low use under ${LOW_UTILIZATION}%; high downtime is ${HIGH_DOWNTIME_SHARE}% or more of the days owned; high repair cost is ${HIGH_REPAIR_SHARE}% or more of revenue. Recommendations use the last 12 months.`,
};

const round = (value, places = 2) => { const factor = 10 ** places; return Math.round((Number(value) || 0) * factor) / factor; };
const percent = (part, whole) => (whole > 0 ? round((part / whole) * 100, 1) : null);
const dayNumber = (date) => { const [y, m, d] = String(date).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const fromDayNumber = (day) => new Date(day * 86400000).toISOString().slice(0, 10);
const addDays = (date, days) => fromDayNumber(dayNumber(date) + days);
const maxDate = (a, b) => (a > b ? a : b);
const minDate = (a, b) => (a < b ? a : b);
const monthLabel = (month) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthName = (month) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
const peso = (value) => `₱${Number(value).toLocaleString('en-PH', { maximumFractionDigits: 0 })}`;

// Per machine, for the days from..to: days worked (up to today), bookings,
// jobs, revenue, costs by category and the rental requests sent.
async function machineFigures(from, to) {
  const result = await query(`
    WITH bounds AS (SELECT $1::date AS d_from, $2::date AS d_to, LEAST($2::date, ${SQL_TODAY}) AS d_elapsed),
    work_days AS (
      SELECT o.machinery_id, d::date AS day
      FROM machinery_operations o CROSS JOIN bounds b
      CROSS JOIN LATERAL generate_series(GREATEST(o.start_date, b.d_from)::timestamp, LEAST(o.start_date + o.duration - 1, b.d_elapsed)::timestamp, INTERVAL '1 day') d
      WHERE o.start_date <= b.d_elapsed AND o.start_date + o.duration - 1 >= b.d_from
      UNION
      SELECT s.machinery_id, d::date
      FROM machinery_services s CROSS JOIN bounds b
      CROSS JOIN LATERAL generate_series(GREATEST(s.service_date, b.d_from)::timestamp, LEAST(s.service_date + COALESCE(s.days, 1) - 1, b.d_elapsed)::timestamp, INTERVAL '1 day') d
      WHERE s.service_date <= b.d_elapsed AND s.service_date + COALESCE(s.days, 1) - 1 >= b.d_from
    ), used AS (
      SELECT machinery_id, COUNT(*)::int AS days FROM work_days GROUP BY machinery_id
    ), rentals AS (
      SELECT o.machinery_id, COUNT(*)::int AS bookings, COALESCE(SUM(o.duration), 0)::int AS booked_days,
             COALESCE(SUM(o.rental_fee) FILTER (WHERE o.start_date <= ${SQL_TODAY} AND linked.id IS NULL), 0) AS revenue
      FROM machinery_operations o CROSS JOIN bounds b
      LEFT JOIN LATERAL (SELECT s.id FROM machinery_services s WHERE s.rental_request_id = o.rental_request_id LIMIT 1) linked ON TRUE
      WHERE o.start_date BETWEEN b.d_from AND b.d_to
      GROUP BY o.machinery_id
    ), services AS (
      SELECT s.machinery_id, COUNT(*)::int AS jobs, COALESCE(SUM(s.fee_amount), 0) AS revenue,
             COALESCE(SUM(s.balance), 0) AS uncollected, COALESCE(SUM(s.area_ha), 0) AS area_ha
      FROM machinery_services s CROSS JOIN bounds b
      WHERE s.service_date BETWEEN b.d_from AND b.d_to
      GROUP BY s.machinery_id
    ), costs AS (
      SELECT e.machinery_id, COALESCE(SUM(e.amount), 0) AS total,
             COALESCE(SUM(e.amount) FILTER (WHERE e.category = 'fuel'), 0) AS fuel,
             COALESCE(SUM(e.amount) FILTER (WHERE e.category = 'labor'), 0) AS labor,
             COALESCE(SUM(e.amount) FILTER (WHERE e.category = 'repair_maintenance'), 0) AS repair,
             COALESCE(SUM(e.amount) FILTER (WHERE e.category = 'other'), 0) AS other
      FROM machinery_expenses e CROSS JOIN bounds b
      WHERE e.expense_date BETWEEN b.d_from AND b.d_to
      GROUP BY e.machinery_id
    ), requests AS (
      SELECT r.machinery_id, COUNT(*)::int AS sent,
             COUNT(*) FILTER (WHERE r.status = 'declined')::int AS declined,
             COUNT(*) FILTER (WHERE r.status = 'pending')::int AS pending
      FROM rental_requests r CROSS JOIN bounds b
      WHERE (r.submitted_at AT TIME ZONE '${TIME_ZONE}')::date BETWEEN b.d_from AND b.d_to
      GROUP BY r.machinery_id
    )
    SELECT m.id, COALESCE(u.days, 0) AS "usedDays", COALESCE(r.bookings, 0) AS bookings, COALESCE(r.booked_days, 0) AS "bookedDays",
           COALESCE(r.revenue, 0) AS "rentalRevenue", COALESCE(s.jobs, 0) AS jobs, COALESCE(s.revenue, 0) AS "serviceRevenue",
           COALESCE(s.uncollected, 0) AS uncollected, COALESCE(s.area_ha, 0) AS "areaHa",
           COALESCE(c.total, 0) AS cost, COALESCE(c.fuel, 0) AS fuel, COALESCE(c.labor, 0) AS labor,
           COALESCE(c.repair, 0) AS repair, COALESCE(c.other, 0) AS other,
           COALESCE(q.sent, 0) AS "requestsSent", COALESCE(q.declined, 0) AS declined, COALESCE(q.pending, 0) AS pending
    FROM machinery m
    LEFT JOIN used u ON u.machinery_id = m.id
    LEFT JOIN rentals r ON r.machinery_id = m.id
    LEFT JOIN services s ON s.machinery_id = m.id
    LEFT JOIN costs c ON c.machinery_id = m.id
    LEFT JOIN requests q ON q.machinery_id = m.id
  `, [from, to]);
  return new Map(result.rows.map((row) => [row.id, Object.fromEntries(Object.entries(row).map(([key, value]) => [key, key === 'id' ? value : Number(value)]))]));
}

// Maintenance periods rebuilt from the audit log: each change of a machine's
// status to or from "maintenance" (set by an admin, or when it was added).
async function maintenanceSpans() {
  const result = await query(`
    WITH events AS (
      SELECT a.entity_id AS id, a.created_at AS at, a.id AS seq, a.new_values ->> 'status' AS status
      FROM audit_logs a
      WHERE a.entity_type = 'machinery' AND a.action IN ('MACHINERY_CREATED', 'MACHINERY_UPDATED')
        AND a.status = 'SUCCESS' AND a.new_values ? 'status'
    ), marked AS (
      SELECT id, at, seq, status, LAG(status) OVER (PARTITION BY id ORDER BY at, seq) AS previous FROM events
    ), changes AS (
      SELECT id, at, seq, status FROM marked WHERE previous IS DISTINCT FROM status
    ), spans AS (
      SELECT id, status, at AS started_at, LEAD(at) OVER (PARTITION BY id ORDER BY at, seq) AS ended_at FROM changes
    )
    SELECT id, started_at AS "startedAt", ended_at AS "endedAt" FROM spans WHERE status = 'maintenance' ORDER BY id, started_at
  `);
  const byMachine = new Map();
  for (const row of result.rows) byMachine.set(row.id, [...(byMachine.get(row.id) || []), row]);
  return byMachine;
}

// The start of from and the end of to in the cooperative's time zone (the end
// no later than now), as instants.
async function windowOf(from, to) {
  const result = await query(`
    SELECT ($1::date::timestamp AT TIME ZONE '${TIME_ZONE}') AS start,
           LEAST((($2::date + 1)::timestamp AT TIME ZONE '${TIME_ZONE}'), NOW()) AS "end", NOW() AS now
  `, [from, to]);
  return result.rows[0];
}

// Days (one decimal) a machine was in maintenance within the window, how many
// maintenance periods touched it, and since when it is down (if it is now). A
// machine in maintenance with no recorded start is flagged, not counted: any
// number of days would be a guess.
function downtimeIn(machine, spans, window) {
  const list = spans.get(machine.id) || [];
  const open = list.find((span) => !span.endedAt);
  const startUnknown = machine.status === 'maintenance' && !open;
  const windowStart = new Date(window.start).getTime();
  const windowEnd = new Date(window.end).getTime();
  let ms = 0;
  let events = 0;
  for (const span of list) {
    const start = new Date(span.startedAt).getTime();
    const end = new Date(span.endedAt ?? (machine.status === 'maintenance' ? window.now : machine.updatedAt)).getTime();
    if (start > windowEnd || end < windowStart) continue;
    events += 1;
    ms += Math.max(0, Math.min(end, windowEnd) - Math.max(start, windowStart));
  }
  const current = machine.status === 'maintenance' ? (open?.startedAt ?? null) : null;
  return { days: round(ms / 86400000, 1), events, downSince: current ? new Date(current).toISOString() : null, startUnknown };
}

// Days of from..to (up to today) that the machine was owned.
function ownedDays(machine, from, to, today) {
  const start = maxDate(from, machine.inServiceFrom);
  const end = minDate(to, today);
  return end < start ? 0 : dayNumber(end) - dayNumber(start) + 1;
}

function periodMetrics(machine, figures, owned, downtime) {
  const revenue = figures.rentalRevenue + figures.serviceRevenue;
  return {
    usedDays: figures.usedDays,
    ownedDays: owned,
    utilization: owned > 0 ? round((figures.usedDays / owned) * 100, 1) : null,
    bookings: figures.bookings,
    bookedDays: figures.bookedDays,
    jobs: figures.jobs,
    areaHa: round(figures.areaHa, 2),
    requestsSent: figures.requestsSent,
    declined: figures.declined,
    revenue: round(revenue),
    rentalRevenue: round(figures.rentalRevenue),
    serviceRevenue: round(figures.serviceRevenue),
    uncollected: round(figures.uncollected),
    cost: round(figures.cost),
    costByCategory: { fuel: round(figures.fuel), labor: round(figures.labor), repair_maintenance: round(figures.repair), other: round(figures.other) },
    net: round(revenue - figures.cost),
    downtimeDays: Math.min(downtime.days, owned),
    downtimeEvents: downtime.events,
  };
}

function maintenanceAlerts(machine, period, downtime, today) {
  const alerts = [];
  const add = (kind, severity, message) => alerts.push({ machineryId: machine.id, machineryName: machine.name, kind, severity, message });
  const next = machine.nextMaintenance;
  if (machine.status === 'maintenance') {
    add('in_maintenance', 'medium', downtime.downSince
      ? `In maintenance since ${todayDateOnly(new Date(downtime.downSince))}.`
      : 'In maintenance since before status changes were recorded, so its downtime days are not counted.');
  }
  if (machine.condition === 'non_operational') add('non_operational', 'high', machine.status === 'maintenance' ? 'Marked non-operational.' : 'Marked non-operational but still open for booking.');
  if (machine.condition === 'always_repair') add('always_repair', 'medium', 'Marked as always under repair. Check its repair costs.');
  if (next && next < today) add('overdue', 'high', `Maintenance overdue since ${next} (${dayNumber(today) - dayNumber(next)} days).`);
  else if (next && dayNumber(next) - dayNumber(today) <= MAINTENANCE_DUE_SOON_DAYS) add('due_soon', 'medium', `Maintenance due on ${next}.`);
  if (machine.maintenanceClash) add('booking_clash', 'medium', `The next maintenance date (${next}) falls during a booking.`);
  if (!next && !machine.lastMaintenance) add('no_schedule', 'low', 'No maintenance dates recorded.');
  else if (!next && machine.lastMaintenance && dayNumber(today) - dayNumber(machine.lastMaintenance) > STALE_MAINTENANCE_DAYS) add('stale', 'low', `Last maintenance was on ${machine.lastMaintenance}, over 6 months ago, and none is scheduled.`);
  const repairShare = percent(period.costByCategory.repair_maintenance, period.revenue);
  if (period.costByCategory.repair_maintenance > 0 && (repairShare === null || repairShare >= HIGH_REPAIR_SHARE)) {
    add('repair_cost', 'medium', repairShare === null
      ? `${peso(period.costByCategory.repair_maintenance)} spent on repairs with no revenue this period.`
      : `Repairs cost ${repairShare}% of its revenue this period.`);
  }
  return alerts;
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

// Fleet demand per month (machine-days and jobs), the last 36 months up to now.
async function demandHistory() {
  const result = await query(`
    WITH months AS (
      SELECT generate_series(DATE_TRUNC('month', ${SQL_TODAY}::timestamp) - INTERVAL '35 months', DATE_TRUNC('month', ${SQL_TODAY}::timestamp), INTERVAL '1 month')::date AS month
    ), work AS (
      SELECT DATE_TRUNC('month', o.start_date::timestamp)::date AS month, o.duration AS days FROM machinery_operations o
      WHERE NOT EXISTS (SELECT 1 FROM machinery_services s WHERE s.rental_request_id = o.rental_request_id)
      UNION ALL
      SELECT DATE_TRUNC('month', s.service_date::timestamp)::date, COALESCE(s.days, 1) FROM machinery_services s
    )
    SELECT TO_CHAR(m.month, 'YYYY-MM') AS month, COALESCE(SUM(w.days), 0)::int AS "machineDays", COUNT(w.month)::int AS jobs
    FROM months m LEFT JOIN work w ON w.month = m.month
    GROUP BY m.month ORDER BY m.month
  `);
  return result.rows;
}

// Seasonal forecast from the complete months (the current month is still
// running): see MACHINERY_METHODOLOGY.forecast.
function forecastDemand(history) {
  const complete = history.slice(0, -1);
  const current = history[history.length - 1];
  const sum = (rows) => rows.reduce((total, row) => total + row.machineDays, 0);
  const recent = complete.slice(-3);
  const recentAverage = recent.length ? sum(recent) / recent.length : 0;
  const firstActive = complete.findIndex((row) => row.machineDays > 0 || row.jobs > 0);
  const known = firstActive === -1 ? [] : complete.slice(firstActive);
  // The trend compares each of the last 12 complete months with the same month
  // a year before, only where records go back that far (so a history that
  // starts mid-year does not look like growth), and needs 6 such months.
  const pairs = [];
  for (let index = complete.length - 12; index < complete.length; index += 1) {
    if (firstActive !== -1 && index - 12 >= firstActive) pairs.push([complete[index], complete[index - 12]]);
  }
  const lastYear = sum(pairs.map(([, before]) => before));
  const trend = pairs.length >= 6 && lastYear > 0 ? Math.min(2, Math.max(0.5, sum(pairs.map(([now]) => now)) / lastYear)) : 1;

  const forecast = [];
  for (let step = 0; step < FORECAST_MONTHS; step += 1) {
    const [year, month] = current.month.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1 + step, 1));
    const key = date.toISOString().slice(0, 7);
    const sameMonth = known.filter((row) => row.month.slice(5) === key.slice(5));
    const seasonal = sameMonth.length ? sum(sameMonth) / sameMonth.length : null;
    const machineDays = round((seasonal ?? recentAverage) * (seasonal === null ? 1 : trend), 0);
    const basis = sameMonth.length ? `${monthName(key)} in ${sameMonth.map((row) => row.month.slice(0, 4)).join(', ')}` : 'the last 3 months';
    forecast.push({ month: key, label: monthLabel(key), machineDays, basis });
  }

  const byCalendarMonth = new Map();
  for (const row of known) byCalendarMonth.set(row.month.slice(5), [...(byCalendarMonth.get(row.month.slice(5)) || []), row.machineDays]);
  const peaks = [...byCalendarMonth.entries()]
    .map(([month, values]) => ({ month, average: values.reduce((a, b) => a + b, 0) / values.length }))
    .filter((entry) => entry.average > 0)
    .sort((a, b) => b.average - a.average)
    .slice(0, 3)
    .map((entry) => monthName(`2000-${entry.month}`));

  return {
    history: history.slice(-13).map((row, index, rows) => ({ ...row, label: monthLabel(row.month), partial: index === rows.length - 1 })),
    forecast,
    trend: round(trend, 2),
    monthsOfHistory: known.length,
    peakMonths: peaks,
    insufficientData: known.length < 3,
  };
}

// Lifetime revenue and costs per machine, and the last 12 months, for the ROI.
async function lifetimeFigures() {
  const result = await query(`
    SELECT m.id,
      (SELECT COALESCE(SUM(o.rental_fee), 0) FROM machinery_operations o
        WHERE o.machinery_id = m.id AND o.start_date <= ${SQL_TODAY}
          AND NOT EXISTS (SELECT 1 FROM machinery_services s WHERE s.rental_request_id = o.rental_request_id)) AS "rentalRevenue",
      (SELECT COALESCE(SUM(s.fee_amount), 0) FROM machinery_services s WHERE s.machinery_id = m.id AND s.service_date <= ${SQL_TODAY}) AS "serviceRevenue",
      (SELECT COALESCE(SUM(e.amount), 0) FROM machinery_expenses e WHERE e.machinery_id = m.id AND e.expense_date <= ${SQL_TODAY}) AS cost
    FROM machinery m
  `);
  return new Map(result.rows.map((row) => [row.id, { revenue: Number(row.rentalRevenue) + Number(row.serviceRevenue), cost: Number(row.cost) }]));
}

function returnOnInvestment(machine, lifetime, today) {
  const daysOwned = Math.max(0, dayNumber(today) - dayNumber(machine.inServiceFrom) + 1);
  const yearsOwned = daysOwned / 365.25;
  const net = lifetime.revenue - lifetime.cost;
  const cost = machine.purchaseCost;
  const perYear = daysOwned >= 30 ? net / yearsOwned : null;
  const row = {
    id: machine.id, name: machine.name, type: machine.type, inServiceFrom: machine.inServiceFrom,
    purchaseCost: cost, yearsOwned: round(yearsOwned, 1),
    lifetimeRevenue: round(lifetime.revenue), lifetimeCost: round(lifetime.cost), lifetimeNet: round(net),
    netPerYear: perYear === null ? null : round(perYear),
    earnedBack: null, roiPerYear: null, paybackYears: null, yearsToPayback: null,
    status: cost === null ? 'no_cost' : cost === 0 ? 'grant' : daysOwned < 30 ? 'too_new' : 'ok',
  };
  if (row.status === 'ok') {
    row.earnedBack = round((net / cost) * 100, 1);
    row.roiPerYear = round((perYear / cost) * 100, 1);
    if (perYear > 0) {
      row.paybackYears = round(cost / perYear, 1);
      row.yearsToPayback = round(Math.max(0, cost / perYear - yearsOwned), 1);
    }
  }
  return row;
}

// Rule-based recommendations from the last 12 months. They are shown when AI
// is not available and given to the AI as a starting point.
function ruleRecommendations(machines, forecast) {
  const list = [];
  const idle = [];
  const add = (machine, type, priority, title, reason) => list.push({ type, priority, machineId: machine?.id ?? null, machine: machine?.name ?? null, title, reason, impact: '' });
  for (const machine of machines) {
    const year = machine.last12;
    if (year.ownedDays < 30) continue;
    const downtimeShare = percent(year.downtimeDays, year.ownedDays) ?? 0;
    const repairShare = percent(year.costByCategory.repair_maintenance, year.revenue);
    const used = `${year.utilization}% of its days used in the last 12 months`;
    if (year.utilization >= HIGH_UTILIZATION && year.declined > 0) {
      add(machine, 'buy', 'high', `Consider another ${machine.type.toLowerCase()}`, `${machine.name}: ${used}, and ${year.declined} rental request${year.declined === 1 ? ' was' : 's were'} declined.`);
    } else if (year.utilization >= HIGH_UTILIZATION) {
      add(machine, 'rates', 'medium', `Review the rate of ${machine.name}`, `${used}. Demand is high, so a modest rate increase or a second unit could be considered.`);
    }
    if (year.utilization < LOW_UTILIZATION && year.net < 0) {
      add(machine, 'retire', 'high', `Review whether to keep ${machine.name}`, `Only ${used}, and it lost ${peso(-year.net)} (revenue ${peso(year.revenue)}, costs ${peso(year.cost)}).`);
    } else if (year.utilization < LOW_UTILIZATION && machine.status !== 'maintenance') {
      idle.push(machine);
    } else if (year.net < 0 && year.revenue > 0) {
      add(machine, 'rates', 'medium', `${machine.name} costs more than it earns`, `Costs of ${peso(year.cost)} against revenue of ${peso(year.revenue)} in the last 12 months. Review its rates and costs.`);
    }
    if (downtimeShare >= HIGH_DOWNTIME_SHARE) {
      add(machine, 'maintenance', 'medium', `Reduce the downtime of ${machine.name}`, `Down ${year.downtimeDays} of ${year.ownedDays} days (${downtimeShare}%). Plan preventive maintenance, or consider replacing it.`);
    } else if (year.costByCategory.repair_maintenance > 0 && repairShare !== null && repairShare >= HIGH_REPAIR_SHARE) {
      add(machine, 'maintenance', 'medium', `High repair costs on ${machine.name}`, `Repairs of ${peso(year.costByCategory.repair_maintenance)} are ${repairShare}% of its revenue in the last 12 months.`);
    }
  }
  // Machines with little work are one recommendation, not one each.
  if (idle.length === 1) {
    add(idle[0], 'promote', 'low', `Find more work for ${idle[0].name}`, `Only ${idle[0].last12.utilization}% of its days used in the last 12 months. Offer it to more members or non-members, or lower its rate in slow months.`);
  } else if (idle.length > 1) {
    add(null, 'promote', 'low', `Find more work for ${idle.length} machines`, `${idle.map((machine) => `${machine.name} (${machine.last12.utilization}%)`).join(', ')} were used on fewer than ${LOW_UTILIZATION}% of their days in the last 12 months. Offer them to more members or non-members, or lower their rates in slow months.`);
  }
  if (forecast.peakMonths.length && !forecast.insufficientData) {
    add(null, 'schedule', 'low', `Prepare for the busy months: ${forecast.peakMonths.join(', ')}`, 'These months had the most machine-days. Do maintenance before them and open bookings early.');
  }
  return list.sort((a, b) => SEVERITY_ORDER[a.priority] - SEVERITY_ORDER[b.priority]);
}

export async function machineryAnalytics(from, to) {
  const today = todayDateOnly();
  const yearFrom = addDays(today, -364);
  const [machinesResult, period, last12, spans, periodWindow, yearWindow, bookings, operations, upcoming, history, lifetime, rates] = await Promise.all([
    query(`
      SELECT m.id, m.name, m.type, m.status, m.condition, m.pricing_mode AS "pricingMode", m.parent_machinery_id AS "parentMachineryId",
             m.daily_fee AS "dailyFee", m.purchase_cost AS "purchaseCost", m.acquisition_date AS "acquisitionDate", m.delivery_date AS "deliveryDate",
             COALESCE(m.delivery_date, m.acquisition_date) AS "inServiceFrom",
             m.last_maintenance AS "lastMaintenance", m.next_maintenance AS "nextMaintenance", m.updated_at AS "updatedAt",
             m.next_maintenance IS NOT NULL AND EXISTS (
               SELECT 1 FROM machinery_operations o WHERE o.machinery_id = m.id AND o.status <> 'completed' AND m.next_maintenance BETWEEN o.start_date AND o.end_date
             ) AS "maintenanceClash"
      FROM machinery m ORDER BY m.id
    `),
    machineFigures(from, to),
    machineFigures(yearFrom, today),
    maintenanceSpans(),
    windowOf(from, to),
    windowOf(yearFrom, today),
    query(`
      SELECT COUNT(*)::int AS submitted,
             COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
             COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
             COUNT(*) FILTER (WHERE status = 'declined')::int AS declined,
             AVG(start_date - (submitted_at AT TIME ZONE '${TIME_ZONE}')::date) AS "avgLeadDays",
             AVG(EXTRACT(EPOCH FROM (reviewed_at - submitted_at)) / 3600) FILTER (WHERE reviewed_at IS NOT NULL) AS "avgReviewHours",
             (SELECT COUNT(*)::int FROM rental_requests WHERE status = 'pending') AS "pendingNow"
      FROM rental_requests WHERE (submitted_at AT TIME ZONE '${TIME_ZONE}')::date BETWEEN $1::date AND $2::date
    `, [from, to]),
    query(`
      SELECT COUNT(*) FILTER (WHERE status = 'scheduled')::int AS scheduled,
             COUNT(*) FILTER (WHERE status = 'ongoing')::int AS ongoing,
             COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
             COALESCE(SUM(duration), 0)::int AS "bookedDays"
      FROM machinery_operations WHERE start_date BETWEEN $1::date AND $2::date
    `, [from, to]),
    // The next two weeks from today, whatever period is picked: confirmed
    // bookings, and requests still to be reviewed (conflict = the dates are
    // already booked, so approving it would be refused).
    query(`
      SELECT * FROM (
        SELECT 'booking' AS kind, o.id, o.machinery_id AS "machineryId", o.machinery_name AS "machineryName", o.member_name AS "memberName",
               o.start_date AS "startDate", o.end_date AS "endDate", o.duration, o.status, FALSE AS conflict
        FROM machinery_operations o
        WHERE o.status <> 'completed' AND o.end_date >= ${SQL_TODAY} AND o.start_date <= ${SQL_TODAY} + ${UPCOMING_DAYS}
        UNION ALL
        SELECT 'request', r.id, r.machinery_id, m.name, r.member_name, r.start_date, r.end_date, r.duration, r.status,
               EXISTS (SELECT 1 FROM machinery_operations o WHERE o.machinery_id = r.machinery_id AND o.status <> 'completed'
                         AND o.start_date <= r.end_date AND o.end_date >= r.start_date)
        FROM rental_requests r JOIN machinery m ON m.id = r.machinery_id
        WHERE r.status = 'pending' AND r.end_date >= ${SQL_TODAY} AND r.start_date <= ${SQL_TODAY} + ${UPCOMING_DAYS}
      ) upcoming ORDER BY "startDate", kind, id LIMIT 12
    `),
    demandHistory(),
    lifetimeFigures(),
    query(`
      SELECT machinery_id AS id, service_type AS "serviceType", unit, member_rate AS "memberRate", non_member_rate AS "nonMemberRate"
      FROM machinery_service_rates WHERE effective_from <= ${SQL_TODAY} AND (effective_to IS NULL OR effective_to >= ${SQL_TODAY})
      ORDER BY machinery_id, service_type
    `),
  ]);

  const machines = machinesResult.rows.map((row) => {
    const machine = { ...row, dailyFee: Number(row.dailyFee), purchaseCost: row.purchaseCost === null ? null : Number(row.purchaseCost) };
    const downtime = downtimeIn(machine, spans, periodWindow);
    const metrics = periodMetrics(machine, period.get(machine.id), ownedDays(machine, from, to, today), downtime);
    const yearDowntime = downtimeIn(machine, spans, yearWindow);
    return {
      id: machine.id, name: machine.name, type: machine.type, status: machine.status, condition: machine.condition,
      pricingMode: machine.pricingMode, parentMachineryId: machine.parentMachineryId, dailyFee: machine.dailyFee,
      lastMaintenance: machine.lastMaintenance, nextMaintenance: machine.nextMaintenance,
      ...metrics,
      downSince: downtime.downSince,
      downtimeStartUnknown: downtime.startUnknown,
      alerts: maintenanceAlerts(machine, metrics, downtime, today),
      last12: periodMetrics(machine, last12.get(machine.id), ownedDays(machine, yearFrom, today, today), yearDowntime),
      roi: returnOnInvestment(machine, lifetime.get(machine.id), today),
      rates: rates.rows.filter((rate) => rate.id === machine.id).map(({ id: _id, ...rate }) => ({ ...rate, memberRate: Number(rate.memberRate), nonMemberRate: Number(rate.nonMemberRate) })),
    };
  });

  const total = (key) => machines.reduce((sum, machine) => sum + machine[key], 0);
  const usedDays = total('usedDays');
  const owned = total('ownedDays');
  const booking = bookings.rows[0];
  const reviewed = booking.approved + booking.declined;
  const forecast = forecastDemand(history);

  return {
    period: { from, to, today, elapsedDays: Math.max(0, dayNumber(minDate(to, today)) - dayNumber(from) + 1) },
    fleet: {
      machines: machines.length,
      inMaintenance: machines.filter((machine) => machine.status === 'maintenance').length,
      inUse: machines.filter((machine) => machine.status === 'in-use').length,
      usedDays,
      ownedDays: owned,
      utilization: percent(usedDays, owned),
      revenue: round(total('revenue')),
      rentalRevenue: round(total('rentalRevenue')),
      serviceRevenue: round(total('serviceRevenue')),
      uncollected: round(total('uncollected')),
      cost: round(total('cost')),
      net: round(total('revenue') - total('cost')),
      downtimeDays: round(total('downtimeDays'), 1),
      availability: owned > 0 ? round(100 - (total('downtimeDays') / owned) * 100, 1) : null,
    },
    bookings: {
      requests: {
        submitted: booking.submitted, pending: booking.pending, approved: booking.approved, declined: booking.declined, pendingNow: booking.pendingNow,
        approvalRate: percent(booking.approved, reviewed),
        avgLeadDays: booking.avgLeadDays === null ? null : round(booking.avgLeadDays, 1),
        avgReviewHours: booking.avgReviewHours === null ? null : round(booking.avgReviewHours, 1),
      },
      operations: operations.rows[0],
      services: { jobs: total('jobs'), areaHa: round(total('areaHa'), 2) },
      upcoming: upcoming.rows.map((row) => ({ ...row, duration: Number(row.duration) })),
    },
    machines,
    alerts: machines.flatMap((machine) => machine.alerts).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
    forecast,
    ruleRecommendations: ruleRecommendations(machines, forecast),
    methodology: MACHINERY_METHODOLOGY,
  };
}

const RECOMMENDATION_TYPES = ['buy', 'rates', 'retire', 'maintenance', 'schedule', 'promote', 'other'];
const PRIORITIES = ['high', 'medium', 'low'];

const SYSTEM_PROMPT = `You advise the officers of ACIFAC, a farmers' cooperative in the Philippines, on its farm machinery rental business (tractors, harvesters and implements rented to members and non-members for rice farming).
You get the cooperative's own figures as JSON. Recommend what to do next to grow the operation: buy more units, adjust rental rates, retire or sell machines that lose money, plan maintenance, and prepare for the busy cropping months.
Rules:
- Use only the figures given. Never invent numbers, prices or market data.
- Quote the figures behind each recommendation (amounts in PHP written like ₱12,500; utilization in %).
- The "ruleSignals" are checks the system already made; confirm, refine or drop them, and add what they miss.
- When the data is too thin for a decision (few months, no costs entered, no purchase cost), say what data to collect instead of guessing.
- At most 6 recommendations, the most important first. Plain English for cooperative officers, no jargon.
Answer with JSON only:
{"summary": "two or three sentences on the fleet", "recommendations": [{"type": "buy|rates|retire|maintenance|schedule|promote|other", "priority": "high|medium|low", "machineId": "the machine's id, or null for the whole fleet", "title": "short action", "reason": "the figures behind it", "impact": "what it should change"}]}`;

// What the AI is given: the figures of the period and of the last 12 months,
// lifetime ROI, demand by month and the forecast, alerts and rule signals.
function factsFor(data) {
  return {
    today: data.period.today,
    selectedPeriod: { from: data.period.from, to: data.period.to },
    fleet: data.fleet,
    bookings: { ...data.bookings.requests, ...data.bookings.operations, serviceJobs: data.bookings.services.jobs },
    machines: data.machines.map((machine) => ({
      id: machine.id, name: machine.name, type: machine.type, status: machine.status, condition: machine.condition,
      attachedTo: machine.parentMachineryId,
      pricing: machine.pricingMode === 'per_service' ? 'per service' : `per day, ₱${machine.dailyFee}`,
      currentRates: machine.rates,
      selectedPeriod: { utilization: machine.utilization, usedDays: machine.usedDays, ownedDays: machine.ownedDays, bookings: machine.bookings, jobs: machine.jobs, revenue: machine.revenue, uncollected: machine.uncollected, cost: machine.cost, net: machine.net, downtimeDays: machine.downtimeDays },
      last12Months: { utilization: machine.last12.utilization, usedDays: machine.last12.usedDays, ownedDays: machine.last12.ownedDays, bookings: machine.last12.bookings, jobs: machine.last12.jobs, requestsSent: machine.last12.requestsSent, declined: machine.last12.declined, revenue: machine.last12.revenue, cost: machine.last12.cost, costByCategory: machine.last12.costByCategory, net: machine.last12.net, downtimeDays: machine.last12.downtimeDays },
      lifetime: { inServiceFrom: machine.roi.inServiceFrom, purchaseCost: machine.roi.purchaseCost, revenue: machine.roi.lifetimeRevenue, cost: machine.roi.lifetimeCost, net: machine.roi.lifetimeNet, earnedBackPercent: machine.roi.earnedBack, paybackYears: machine.roi.paybackYears },
      nextMaintenance: machine.nextMaintenance, lastMaintenance: machine.lastMaintenance,
    })),
    demandByMonth: data.forecast.history.map(({ month, machineDays, jobs, partial }) => ({ month, machineDays, jobs, ...(partial ? { monthStillRunning: true } : {}) })),
    forecast: data.forecast.forecast.map(({ month, machineDays }) => ({ month, machineDays })),
    peakMonths: data.forecast.peakMonths,
    monthsOfHistory: data.forecast.monthsOfHistory,
    alerts: data.alerts.map(({ machineryName, message }) => `${machineryName}: ${message}`),
    ruleSignals: data.ruleRecommendations.map(({ type, priority, machine, title, reason }) => ({ type, priority, machine, title, reason })),
  };
}

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function cleanRecommendations(answer, machines) {
  const ids = new Map(machines.map((machine) => [machine.id, machine.name]));
  const list = Array.isArray(answer?.recommendations) ? answer.recommendations : [];
  return list.slice(0, 6).map((item) => {
    const machineId = ids.has(item?.machineId) ? item.machineId : null;
    return {
      type: RECOMMENDATION_TYPES.includes(item?.type) ? item.type : 'other',
      priority: PRIORITIES.includes(item?.priority) ? item.priority : 'medium',
      machineId,
      machine: machineId ? ids.get(machineId) : null,
      title: text(item?.title, 160),
      reason: text(item?.reason, 600),
      impact: text(item?.impact, 400),
    };
  }).filter((item) => item.title);
}

// Asks the AI only when an admin opens the recommendations; when AI is not
// configured or does not answer, the rule-based recommendations are returned.
export async function machineryRecommendations(from, to) {
  const data = await machineryAnalytics(from, to);
  const base = { period: { from, to }, generatedAt: new Date().toISOString(), methodology: MACHINERY_METHODOLOGY.rules };
  const fallback = (notice) => ({ ...base, source: 'rules', summary: '', recommendations: data.ruleRecommendations, notice });
  if (!process.env.GEMINI_API_KEY && !process.env.OCR_AI_API_KEY && !process.env.OPENAI_API_KEY) {
    return fallback('AI is not set up on the server, so these are the rule-based recommendations.');
  }
  try {
    const answer = await askAiText(SYSTEM_PROMPT, `The cooperative's machinery figures:\n${JSON.stringify(factsFor(data))}`);
    const recommendations = cleanRecommendations(answer, data.machines);
    if (!recommendations.length) return fallback('The AI gave no usable recommendations, so these are the rule-based ones.');
    return { ...base, source: 'ai', summary: text(answer.summary, 800), recommendations, notice: '' };
  } catch (error) {
    console.warn('Machinery recommendations: AI failed:', error instanceof Error ? error.message : error);
    return fallback(`AI could not answer (${aiFailureReason(error)}), so these are the rule-based recommendations.`);
  }
}
