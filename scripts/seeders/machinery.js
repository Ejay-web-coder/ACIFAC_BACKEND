import { computeServiceFee, findRateForDate, rateForClient } from '../../src/services/machineryFees.js';
import { centsToString, toCents } from '../../src/utils/money.js';
import { addDays, stampSql } from './support.js';

// A year of machinery records on the machines and rates already in the
// database (hand tractors with rotavator, squadrone and tudling rates;
// harvesters paid in bags of palay; machines rented by the day). The fee of
// each service comes from the rate in force on its date, as on the Machinery
// page; a service no rate covers is skipped. The work follows the farming
// year: land preparation in the planting months, the harvester at harvest.
// Everything is written a statement at a time for all records together.
//   [service type, days ago, member key or non-member { name, address }, area (ha), bags harvested, paid]
const NAMED_SERVICES = [
  ['Rotavator', 120, 'juan', '2.5', null, 'full'],
  ['Rotavator', 116, 'pedro', '1.5', null, 'partial'],
  ['Squadrone', 112, 'maria', '2', null, 'full'],
  ['Tudling', 110, 'maria', '2', null, 'full'],
  ['Rotavator', 64, 'antonio', '2', null, 'none'],
  ['Tudling', 60, { name: 'Pedro Villareal', address: 'Poblacion, Calintaan, Occidental Mindoro' }, '1', null, 'full'],
  ['Harvesting', 46, 'juan', '2.5', '250', 'full'],
  ['Harvesting', 41, 'rosario', '1.2', '120', 'full'],
  ['Harvesting', 37, 'ricardo', '1.8', '170', 'partial'],
  ['Harvesting', 31, { name: 'Lito Manalo', address: 'Lumangbayan, Santa Cruz, Occidental Mindoro' }, '1', '95', 'none'],
  ['Harvesting', 28, 'ernesto', '1.4', '140', 'full'],
  ['Rotavator', 12, 'elena', '1.2', null, 'partial'],
  ['Squadrone', 6, 'roberto', '1.5', null, 'none'],
];
const NON_MEMBERS = [
  { name: 'Cesar Malabanan', address: 'San Vicente, Santa Cruz, Occidental Mindoro' }, { name: 'Lito Manalo', address: 'Lumangbayan, Santa Cruz, Occidental Mindoro' },
  { name: 'Wilma Ocampo', address: 'Poblacion, Calintaan, Occidental Mindoro' }, { name: 'Pedro Villareal', address: 'Poblacion, Calintaan, Occidental Mindoro' },
];
// Harvest in April-May and October-November; land preparation before the two plantings.
const HARVEST_MONTHS = new Set([4, 5, 10, 11]);
const PREPARATION = ['Rotavator', 'Rotavator', 'Squadrone', 'Tudling'];
// One bag of fresh palay: 50 kg at PHP 18 a kilo.
const BAG = { kgPerBag: '50', pricePerKg: '18' };
// Running costs of a machine in a month it worked: [category, amount, what for].
const MONTHLY_COSTS = [['fuel', '3200', 'Diesel, 50 L'], ['labor', '1500', 'Operator']];
const OCCASIONAL_COSTS = [['repair_maintenance', '4800', 'Blades replaced'], ['repair_maintenance', '2500', 'Oil change and filters'], ['other', '800', 'Sacks for the harvester fee']];
// Day rentals: [days from today it starts, days, member key or non-member { name }, status]; and one every
// RENTAL_EVERY days over the past year for the generated members.
const NAMED_RENTALS = [
  [-50, 3, 'teresita', 'approved'],
  [-20, 1, { name: 'Ramon Bello' }, 'approved'],
  [5, 2, 'ernesto', 'approved'],
  [12, 2, 'gloria', 'pending'],
];
const RENTAL_EVERY = 16;

const purposeFor = (machine) => (/pump|irrigat/i.test(`${machine.name} ${machine.type}`) ? 'Irrigating the rice field'
  : /thresh/i.test(`${machine.name} ${machine.type}`) ? 'Threshing palay' : 'Land preparation');

// The services of the year: the named ones, then about one every six days for the generated members.
function servicePlan(ctx) {
  const plan = NAMED_SERVICES.map(([serviceType, daysAgo, who, areaHa, totalBags, paid]) => ({ serviceType, daysAgo, who, areaHa, totalBags, paid }));
  const generated = ctx.members.slice(15);
  for (let daysAgo = 360, n = 0; daysAgo > 3; daysAgo -= 5 + (n % 3), n += 1) {
    const month = Number(addDays(ctx.today, -daysAgo).slice(5, 7));
    const member = n % 6 === 5 ? null : generated[(n * 7) % generated.length];
    const area = member ? member.farmArea : ['0.8', '1', '1.5'][n % 3];
    const harvest = HARVEST_MONTHS.has(month);
    plan.push({
      serviceType: harvest ? 'Harvesting' : PREPARATION[n % PREPARATION.length], daysAgo, who: member ? member.key : NON_MEMBERS[n % NON_MEMBERS.length],
      areaHa: area, totalBags: harvest ? String(Math.round(Number(area) * (85 + (n % 4) * 10))) : null,
      // Recent work is more often still unpaid.
      paid: daysAgo < 30 && n % 3 === 0 ? 'none' : n % 7 === 3 ? 'partial' : 'full',
    });
  }
  return plan;
}

async function seedServices(ctx) {
  const { client, today } = ctx;
  const rates = (await client.query(
    `SELECT r.id, r.machinery_id AS "machineryId", r.service_type AS "serviceType", r.unit, r.member_rate AS "memberRate",
            r.non_member_rate AS "nonMemberRate", r.effective_from::text AS "effectiveFrom", r.effective_to::text AS "effectiveTo"
     FROM machinery_service_rates r JOIN machinery m ON m.id = r.machinery_id ORDER BY r.machinery_id, r.effective_from`
  )).rows;
  const rows = [];
  let skippedForRate = 0;
  for (const [index, { serviceType, daysAgo, who, areaHa, totalBags, paid }] of servicePlan(ctx).entries()) {
    const serviceDate = addDays(today, -daysAgo);
    // The machines with a rate for this service on that date, taken in turn.
    const choices = [...new Set(rates.map((rate) => rate.machineryId))]
      .map((machineryId) => findRateForDate(rates.filter((rate) => rate.machineryId === machineryId), serviceType, serviceDate))
      .filter(Boolean);
    if (!choices.length) { skippedForRate += 1; continue; }
    const rate = choices[index % choices.length];
    const member = typeof who === 'string' ? ctx.member(who) : null;
    const clientCategory = member ? 'member' : 'non_member';
    const bags = rate.unit === 'per_100_bags';
    const fee = computeServiceFee({ unit: rate.unit, rate: rateForClient(rate, clientCategory), areaHa, days: null, totalBags: bags ? totalBags || String(Math.round(Number(areaHa) * 95)) : totalBags, ...BAG });
    const paidCents = paid === 'full' ? toCents(fee.feeAmount) : paid === 'partial' ? Math.floor(toCents(fee.feeAmount) / 200) * 100 : 0;
    rows.push({
      machineryId: rate.machineryId, serviceType: rate.serviceType, date: serviceDate, clientCategory, memberId: member?.id ?? null,
      name: member?.fullName ?? who.name, address: member?.address ?? who.address, unit: rate.unit, areaHa,
      totalBags: bags ? totalBags || String(Math.round(Number(areaHa) * 95)) : null, feeBags: fee.feeBags, bagValue: fee.bagValue,
      rateId: rate.id, rateUsed: fee.rateUsed, feeAmount: fee.feeAmount, paid: paidCents > 0 ? centsToString(paidCents) : null, bagsUnit: bags,
    });
  }
  if (skippedForRate) ctx.skipped(`${skippedForRate} machinery services: no machine had a rate for their date`);
  if (!rows.length) return [];

  const column = (pick) => rows.map(pick);
  const ids = (await client.query(
    `INSERT INTO machinery_services (machinery_id, service_type, service_date, cropping_period, year, client_category, member_id, client_name, client_address,
       unit, area_ha, total_bags, fee_bags, bag_value, kg_per_bag, price_per_kg, rate_id, rate_used, fee_amount, recorded_by, created_at, updated_at)
     SELECT r.machinery_id, r.service_type, r.day, CASE WHEN EXTRACT(MONTH FROM r.day) <= 7 THEN '1st' ELSE '2nd' END, EXTRACT(YEAR FROM r.day)::int,
            r.client_category, r.member_id, r.client_name, r.client_address, r.unit, r.area, r.total_bags, r.fee_bags, r.bag_value,
            CASE WHEN r.bags THEN $17::numeric END, CASE WHEN r.bags THEN $18::numeric END, r.rate_id, r.rate_used, r.fee, $19, ${stampSql('r.day', '16:00')}, ${stampSql('r.day', '16:00')}
     FROM unnest($1::text[], $2::text[], $3::date[], $4::text[], $5::int[], $6::text[], $7::text[], $8::text[], $9::numeric[], $10::numeric[], $11::numeric[],
                 $12::numeric[], $13::int[], $14::numeric[], $15::numeric[], $16::boolean[]) WITH ORDINALITY
          AS r(machinery_id, service_type, day, client_category, member_id, client_name, client_address, unit, area, total_bags, fee_bags, bag_value,
               rate_id, rate_used, fee, bags, ord)
     ORDER BY r.ord
     RETURNING id`,
    [column((r) => r.machineryId), column((r) => r.serviceType), column((r) => r.date), column((r) => r.clientCategory), column((r) => r.memberId),
      column((r) => r.name), column((r) => r.address), column((r) => r.unit), column((r) => r.areaHa), column((r) => r.totalBags), column((r) => r.feeBags),
      column((r) => r.bagValue), column((r) => r.rateId), column((r) => r.rateUsed), column((r) => r.feeAmount), column((r) => r.bagsUnit),
      BAG.kgPerBag, BAG.pricePerKg, ctx.admin.id]
  )).rows.map((row) => row.id);
  rows.forEach((row, index) => { row.id = ids[index]; });
  // Payments keep machinery_services.amount_paid up to date through a trigger.
  const paidRows = rows.filter((row) => row.paid);
  if (paidRows.length) {
    await client.query(
      `INSERT INTO machinery_service_payments (service_id, amount, payment_date, notes, recorded_by, created_at)
       SELECT r.id, r.amount, r.day, 'Paid when the service was recorded', $4, ${stampSql('r.day', '16:00')}
       FROM unnest($1::int[], $2::numeric[], $3::date[]) AS r(id, amount, day)`,
      [paidRows.map((row) => row.id), paidRows.map((row) => row.paid), paidRows.map((row) => row.date), ctx.admin.id]
    );
  }
  ctx.count('machinery services', rows.length);
  return rows;
}

// Running costs: fuel and the operator in every month a machine worked, and now and then a repair.
async function seedExpenses(ctx, services) {
  const months = new Map();
  for (const service of services) {
    const key = `${service.machineryId}|${service.date.slice(0, 7)}`;
    if (!months.has(key) || months.get(key) < service.date) months.set(key, service.date);
  }
  const rows = [];
  [...months.entries()].forEach(([key, lastDay], n) => {
    const machineryId = key.split('|')[0];
    for (const [category, amount, description] of MONTHLY_COSTS) rows.push({ machineryId, date: lastDay, category, amount, description });
    if (n % 3 === 1) rows.push({ machineryId, date: lastDay, ...Object.fromEntries(['category', 'amount', 'description'].map((field, i) => [field, OCCASIONAL_COSTS[n % OCCASIONAL_COSTS.length][i]])) });
  });
  if (!rows.length) return;
  await ctx.client.query(
    `INSERT INTO machinery_expenses (machinery_id, expense_date, cropping_period, year, category, amount, description, recorded_by, created_at, updated_at)
     SELECT r.machinery_id, r.day, CASE WHEN EXTRACT(MONTH FROM r.day) <= 7 THEN '1st' ELSE '2nd' END, EXTRACT(YEAR FROM r.day)::int, r.category, r.amount, r.description, $6,
            ${stampSql('r.day', '17:00')}, ${stampSql('r.day', '17:00')}
     FROM unnest($1::text[], $2::date[], $3::text[], $4::numeric[], $5::text[]) AS r(machinery_id, day, category, amount, description)`,
    [rows.map((r) => r.machineryId), rows.map((r) => r.date), rows.map((r) => r.category), rows.map((r) => r.amount), rows.map((r) => r.description), ctx.admin.id]
  );
  ctx.count('machinery expenses', rows.length);
}

// Day rentals over the past year (and, without real members, two still to come),
// never overlapping a booking or request already there, with their payments.
async function seedRentals(ctx) {
  const { client, today } = ctx;
  const machines = (await client.query(
    `SELECT id, name, type, daily_fee FROM machinery WHERE pricing_mode = 'per_day' AND daily_fee > 0 AND parent_machinery_id IS NULL ORDER BY id`
  )).rows;
  if (!machines.length) {
    ctx.skipped('rentals: no machine is rented by the day');
    return;
  }
  const taken = (await client.query(
    `SELECT machinery_id, start_date::text AS start_date, end_date::text AS end_date FROM machinery_operations WHERE machinery_id = ANY($1::text[])
     UNION ALL
     SELECT machinery_id, start_date::text, end_date::text FROM rental_requests WHERE machinery_id = ANY($1::text[]) AND status IN ('pending', 'approved')`,
    [machines.map((machine) => machine.id)]
  )).rows;
  const generated = ctx.members.slice(15);
  const plan = [...NAMED_RENTALS];
  for (let startsIn = -360, n = 0; startsIn < -2; startsIn += RENTAL_EVERY + (n % 4), n += 1) {
    plan.push([startsIn, 1 + (n % 3), n % 5 === 4 ? { name: ['Ramon Bello', 'Susan Robles', 'Carlo Dimaano'][n % 3] } : generated[(n * 11) % generated.length].key, 'approved']);
  }

  const rentals = [];
  for (const [index, [startsIn, days, renter, status]] of plan.entries()) {
    const startDate = addDays(today, startsIn);
    const endDate = addDays(startDate, days);
    // Next to real records, a booking from today on could keep a real member from booking.
    if (ctx.alongside && startsIn >= 0) {
      ctx.skipped(`rental from ${startDate}: real members are in this database`);
      continue;
    }
    const free = (machine) => ![...taken, ...rentals.map((r) => ({ machinery_id: r.machine.id, start_date: r.startDate, end_date: r.endDate }))]
      .some((booking) => booking.machinery_id === machine.id && booking.start_date <= endDate && booking.end_date >= startDate);
    let machine = null;
    for (let step = 0; step < machines.length && !machine; step += 1) {
      const candidate = machines[(index + step) % machines.length];
      if (free(candidate)) machine = candidate;
    }
    if (!machine) continue;
    const member = typeof renter === 'string' ? ctx.member(renter) : null;
    const duration = Math.max(1, days);
    rentals.push({
      machine, member, name: member?.fullName ?? renter.name, startDate, endDate, duration, status,
      fee: centsToString(toCents(machine.daily_fee) * duration), submittedOn: addDays(startDate, -7) < today ? addDays(startDate, -7) : today,
      // Most past rentals were paid; a few recent ones are still owed.
      paid: status === 'approved' && endDate < today && !(startsIn > -45 && index % 3 === 0),
    });
  }
  if (!rentals.length) return;

  const column = (pick) => rentals.map(pick);
  const requestIds = (await client.query(
    `INSERT INTO rental_requests (machinery_id, client_category, member_id, member_name, purpose, start_date, end_date, duration, rental_fee, notes,
       status, submitted_at, reviewed_at, reviewed_by)
     SELECT r.machinery_id, r.category, r.member_id, r.name, r.purpose, r.start_date, r.end_date, r.duration, r.fee, '',
            r.status, ${stampSql('r.submitted')}, CASE WHEN r.status = 'pending' THEN NULL ELSE ${stampSql('r.submitted', '15:00')} END,
            CASE WHEN r.status = 'pending' THEN NULL ELSE $12::int END
     FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::text[], $6::date[], $7::date[], $8::int[], $9::numeric[], $10::text[], $11::date[]) WITH ORDINALITY
          AS r(machinery_id, category, member_id, name, purpose, start_date, end_date, duration, fee, status, submitted, ord)
     ORDER BY r.ord
     RETURNING id`,
    [column((r) => r.machine.id), column((r) => (r.member ? 'member' : 'non_member')), column((r) => r.member?.id ?? null), column((r) => r.name),
      column((r) => purposeFor(r.machine)), column((r) => r.startDate), column((r) => r.endDate), column((r) => r.duration), column((r) => r.fee),
      column((r) => r.status), column((r) => r.submittedOn), ctx.admin.id]
  )).rows.map((row) => row.id);
  rentals.forEach((rental, index) => { rental.requestId = requestIds[index]; });
  ctx.count('rental requests', rentals.length);

  const booked = rentals.filter((rental) => rental.status === 'approved');
  if (!booked.length) return;
  const bc = (pick) => booked.map(pick);
  const operationIds = (await client.query(
    `INSERT INTO machinery_operations (rental_request_id, machinery_id, machinery_name, client_category, member_id, member_name, purpose, start_date, end_date, duration, rental_fee, status)
     SELECT r.request_id, r.machinery_id, r.machinery_name, r.category, r.member_id, r.name, r.purpose, r.start_date, r.end_date, r.duration, r.fee,
            CASE WHEN r.end_date < $12::date THEN 'completed' WHEN r.start_date <= $12::date THEN 'ongoing' ELSE 'scheduled' END
     FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[], $8::date[], $9::date[], $10::int[], $11::numeric[]) WITH ORDINALITY
          AS r(request_id, machinery_id, machinery_name, category, member_id, name, purpose, start_date, end_date, duration, fee, ord)
     ORDER BY r.ord
     RETURNING id`,
    [bc((r) => r.requestId), bc((r) => r.machine.id), bc((r) => r.machine.name), bc((r) => (r.member ? 'member' : 'non_member')), bc((r) => r.member?.id ?? null),
      bc((r) => r.name), bc((r) => purposeFor(r.machine)), bc((r) => r.startDate), bc((r) => r.endDate), bc((r) => r.duration), bc((r) => r.fee), today]
  )).rows.map((row) => row.id);
  booked.forEach((rental, index) => { rental.operationId = operationIds[index]; });
  ctx.count('machinery bookings', booked.length);

  const paid = booked.filter((rental) => rental.paid);
  if (paid.length) {
    await client.query(
      `INSERT INTO machinery_rental_payments (operation_id, amount, payment_date, notes, recorded_by, created_at)
       SELECT r.id, r.amount, r.day, 'Paid at the office', $4, ${stampSql('r.day', '15:30')}
       FROM unnest($1::int[], $2::numeric[], $3::date[]) AS r(id, amount, day)`,
      [paid.map((r) => r.operationId), paid.map((r) => r.fee), paid.map((r) => r.endDate), ctx.admin.id]
    );
    ctx.count('rental payments', paid.length);
  }
}

export default async function seedMachinery(ctx) {
  const services = await seedServices(ctx);
  await seedExpenses(ctx, services);
  await seedRentals(ctx);
}
