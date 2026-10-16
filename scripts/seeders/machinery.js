import { computeServiceFee, findRateForDate, rateForClient } from '../../src/services/machineryFees.js';
import { centsToString, toCents } from '../../src/utils/money.js';
import { addDays, croppingPeriodOf, stampSql } from './support.js';

// Machinery records for the machines and rates the migrations already add
// (hand tractor with rotavator, squadrone and tudling rates; harvesters paid in
// bags of palay). The fee of each service comes from the rate in force on the
// service date, as on the Machinery page; a service no rate covers is skipped.
//   [service type, days ago, member key or non-member { name, address }, area (ha), bags harvested, paid]
const SERVICES = [
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
// One bag of fresh palay: 50 kg at PHP 18 a kilo.
const BAG = { kgPerBag: '50', pricePerKg: '18' };
// Running costs of the machines that did the work: [category, days ago, amount, what for].
const EXPENSES = [
  ['fuel', 118, '3200', 'Diesel, 50 L'], ['labor', 118, '1500', 'Operator'], ['repair_maintenance', 90, '4800', 'Rotavator blades replaced'],
  ['fuel', 44, '6500', 'Diesel, 100 L'], ['labor', 44, '3000', 'Operator and helper'], ['other', 30, '800', 'Sacks for the harvester fee'],
];
// Day rentals of the machines rented by the day: [days from today it starts, days, member key or non-member { name }, status].
const RENTALS = [
  [-50, 3, 'teresita', 'approved'],
  [-20, 1, { name: 'Ramon Bello' }, 'approved'],
  [5, 2, 'ernesto', 'approved'],
  [12, 2, 'gloria', 'pending'],
];

async function seedServices(ctx) {
  const { client, today } = ctx;
  const rates = (await client.query(
    `SELECT r.id, r.machinery_id AS "machineryId", r.service_type AS "serviceType", r.unit, r.member_rate AS "memberRate",
            r.non_member_rate AS "nonMemberRate", r.effective_from AS "effectiveFrom", r.effective_to AS "effectiveTo"
     FROM machinery_service_rates r JOIN machinery m ON m.id = r.machinery_id ORDER BY r.machinery_id, r.effective_from`
  )).rows;
  const machinesUsed = new Map();
  for (const [index, [serviceType, daysAgo, who, areaHa, totalBags, paid]] of SERVICES.entries()) {
    const serviceDate = addDays(today, -daysAgo);
    // The machines with a rate for this service on that date, taken in turn.
    const choices = [...new Set(rates.map((rate) => rate.machineryId))]
      .map((machineryId) => findRateForDate(rates.filter((rate) => rate.machineryId === machineryId), serviceType, serviceDate))
      .filter(Boolean);
    if (!choices.length) {
      ctx.skipped(`${serviceType} on ${serviceDate}: no machine has a rate for that date`);
      continue;
    }
    const rate = choices[index % choices.length];
    const member = typeof who === 'string' ? ctx.member(who) : null;
    const clientCategory = member ? 'member' : 'non_member';
    const fee = computeServiceFee({ unit: rate.unit, rate: rateForClient(rate, clientCategory), areaHa, days: null, totalBags, ...BAG });
    const bags = rate.unit === 'per_100_bags';
    const serviceId = (await client.query(
      `INSERT INTO machinery_services (machinery_id, service_type, service_date, cropping_period, year, client_category, member_id, client_name, client_address,
         unit, area_ha, total_bags, fee_bags, bag_value, kg_per_bag, price_per_kg, rate_id, rate_used, fee_amount, recorded_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::numeric, $12::numeric, $13::numeric, $14::numeric, $15::numeric, $16::numeric, $17, $18::numeric, $19::numeric, $20,
         ${stampSql('$3', '16:00')}, ${stampSql('$3', '16:00')})
       RETURNING id`,
      [rate.machineryId, rate.serviceType, serviceDate, croppingPeriodOf(serviceDate), Number(serviceDate.slice(0, 4)), clientCategory, member?.id ?? null,
        member?.fullName ?? who.name, member?.address ?? who.address, rate.unit, areaHa, bags ? totalBags : null, fee.feeBags, fee.bagValue,
        bags ? BAG.kgPerBag : null, bags ? BAG.pricePerKg : null, rate.id, fee.rateUsed, fee.feeAmount, ctx.admin.id]
    )).rows[0].id;
    // Payments keep machinery_services.amount_paid up to date through a trigger.
    const paidCents = paid === 'full' ? toCents(fee.feeAmount) : paid === 'partial' ? Math.floor(toCents(fee.feeAmount) / 200) * 100 : 0;
    if (paidCents > 0) {
      await client.query(
        `INSERT INTO machinery_service_payments (service_id, amount, payment_date, notes, recorded_by, created_at)
         VALUES ($1, $2::numeric, $3, 'Paid when the service was recorded', $4, ${stampSql('$3', '16:00')})`,
        [serviceId, centsToString(paidCents), serviceDate, ctx.admin.id]
      );
    }
    machinesUsed.set(rate.machineryId, (machinesUsed.get(rate.machineryId) || 0) + 1);
    ctx.count('machinery services');
  }

  // Expenses go to the machine that did the most work before them.
  const busiest = [...machinesUsed.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  for (const [index, [category, daysAgo, amount, description]] of EXPENSES.entries()) {
    if (!busiest.length) break;
    const expenseDate = addDays(today, -daysAgo);
    await client.query(
      `INSERT INTO machinery_expenses (machinery_id, expense_date, cropping_period, year, category, amount, description, recorded_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, ${stampSql('$2', '17:00')}, ${stampSql('$2', '17:00')})`,
      [busiest[index < 3 ? 0 : Math.min(1, busiest.length - 1)], expenseDate, croppingPeriodOf(expenseDate), Number(expenseDate.slice(0, 4)), category, amount, description, ctx.admin.id]
    );
    ctx.count('machinery expenses');
  }
}

const purposeFor = (machine) => (/pump|irrigat/i.test(`${machine.name} ${machine.type}`) ? 'Irrigating the rice field'
  : /thresh/i.test(`${machine.name} ${machine.type}`) ? 'Threshing palay' : 'Land preparation');

async function seedRentals(ctx) {
  const { client, today } = ctx;
  const machines = (await client.query(
    `SELECT id, name, type, daily_fee FROM machinery WHERE pricing_mode = 'per_day' AND daily_fee > 0 AND parent_machinery_id IS NULL ORDER BY id`
  )).rows;
  if (!machines.length) {
    ctx.skipped('rentals: no machine is rented by the day');
    return;
  }
  for (const [index, [startsIn, days, renter, status]] of RENTALS.entries()) {
    const member = typeof renter === 'string' ? ctx.member(renter) : null;
    const startDate = addDays(today, startsIn);
    const endDate = addDays(startDate, days);
    // Next to real records, a booking from today on could keep a real member from booking.
    if (ctx.alongside && startsIn >= 0) {
      ctx.skipped(`rental from ${startDate}: real members are in this database`);
      continue;
    }
    // The machines in turn, skipping any already booked (or requested) for those days.
    let machine = null;
    for (let step = 0; step < machines.length && !machine; step += 1) {
      const candidate = machines[(index + step) % machines.length];
      const taken = (await client.query(
        `SELECT 1 FROM machinery_operations WHERE machinery_id = $1 AND start_date <= $3::date AND end_date >= $2::date
         UNION ALL
         SELECT 1 FROM rental_requests WHERE machinery_id = $1 AND status IN ('pending', 'approved') AND start_date <= $3::date AND end_date >= $2::date
         LIMIT 1`,
        [candidate.id, startDate, endDate]
      )).rows.length > 0;
      if (!taken) machine = candidate;
    }
    if (!machine) {
      ctx.skipped(`rental ${startDate} to ${endDate}: every machine rented by the day is booked`);
      continue;
    }
    const submittedOn = addDays(startDate, -7) < today ? addDays(startDate, -7) : today;
    const reviewed = status !== 'pending';
    // Days and fee as the rental form works them out: daily fee x (end - start), at least one day.
    const rental = (await client.query(
      `INSERT INTO rental_requests (machinery_id, client_category, member_id, member_name, purpose, start_date, end_date, duration, rental_fee, notes,
         status, submitted_at, reviewed_at, reviewed_by)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, GREATEST(1, $7::date - $6::date), $8::numeric * GREATEST(1, $7::date - $6::date), '',
         $9, ${stampSql('$10')}, ${stampSql('$11', '15:00')}, $12)
       RETURNING *`,
      [machine.id, member ? 'member' : 'non_member', member?.id ?? null, member?.fullName ?? renter.name, purposeFor(machine), startDate, endDate,
        machine.daily_fee, status, submittedOn, reviewed ? submittedOn : null, reviewed ? ctx.admin.id : null]
    )).rows[0];
    ctx.count('rental requests');
    if (status !== 'approved') continue;
    await client.query(
      `INSERT INTO machinery_operations (rental_request_id, machinery_id, machinery_name, client_category, member_id, member_name, purpose, start_date, end_date, duration, rental_fee, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $9::date < $12::date THEN 'completed' WHEN $8::date <= $12::date THEN 'ongoing' ELSE 'scheduled' END)`,
      [rental.id, machine.id, machine.name, rental.client_category, rental.member_id, rental.member_name, rental.purpose, rental.start_date, rental.end_date,
        rental.duration, rental.rental_fee, today]
    );
    ctx.count('machinery bookings');
  }
}

export default async function seedMachinery(ctx) {
  await seedServices(ctx);
  await seedRentals(ctx);
}
