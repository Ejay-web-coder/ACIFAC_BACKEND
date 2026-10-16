import { nextMemberNumber, parseShareCapital, validateMemberInput } from '../../src/controllers/memberController.js';
import { centsToString } from '../../src/utils/money.js';
import { createMemberLogins, loginName } from './accounts.js';
import { addDays, addMonths, stampSql } from './support.js';

// Sample members of the cooperative, checked by the Add Member form's validation
// and registered as it registers them (numbers ACIFAC-YYYY-NNN, initial share
// capital, audit entry), a few statements for all of them. `joined` is
// how many months ago they became members; `more` lists later share capital
// contributions as [months ago, amount] (at most PHP 20,000 in all). Every
// member gets an active sign-in of their own: first.lastname (juan.delacruz).
const MEMBERS = [
  { key: 'juan', first: 'Juan', middle: 'Santos', last: 'Dela Cruz', gender: 'Male', born: '1974-03-14', civil: 'Married', spouse: 'Lorna Dela Cruz', education: 'High School', palay: '2.5', income: '180000', joined: 34, share: '5000', more: [[24, '3000'], [12, '3000'], [5, '2000']] },
  { key: 'maria', first: 'Maria', middle: 'Reyes', last: 'Santos', gender: 'Female', born: '1980-07-02', civil: 'Married', spouse: 'Ramon Santos', education: 'College', palay: '2', income: '165000', joined: 30, share: '5000', more: [[18, '5000'], [6, '10000']] },
  { key: 'pedro', first: 'Pedro', middle: 'Garcia', last: 'Reyes', gender: 'Male', born: '1968-11-20', civil: 'Married', spouse: 'Nena Reyes', education: 'Elementary', palay: '1.5', corn: '0.5', income: '140000', joined: 28, share: '3000', more: [[10, '2000']] },
  { key: 'rosario', first: 'Rosario', middle: 'Mendoza', last: 'Villanueva', gender: 'Female', born: '1972-05-09', civil: 'Widowed', education: 'High School', palay: '1.2', income: '95000', joined: 26, share: '2000', more: [[8, '1000']] },
  { key: 'antonio', first: 'Antonio', middle: 'Cruz', last: 'Bautista', gender: 'Male', born: '1985-01-30', civil: 'Married', spouse: 'Liza Bautista', education: 'Vocational', palay: '2', income: '170000', joined: 24, share: '5000', more: [[14, '5000']] },
  { key: 'elena', first: 'Elena', middle: 'Ramos', last: 'Aquino', gender: 'Female', born: '1990-09-12', civil: 'Single', education: 'College', palay: '1.2', income: '90000', joined: 20, share: '2000' },
  { key: 'ricardo', first: 'Ricardo', middle: 'Lopez', last: 'Gonzales', gender: 'Male', born: '1978-04-25', civil: 'Married', spouse: 'Mila Gonzales', education: 'High School', palay: '1.8', income: '150000', joined: 22, share: '3000', more: [[9, '2000']] },
  { key: 'lourdes', first: 'Lourdes', middle: 'Castillo', last: 'Fernandez', gender: 'Female', born: '1983-12-03', civil: 'Married', spouse: 'Ben Fernandez', education: 'College', livelihood: 'Rice farming and sari-sari store', palay: '1', income: '120000', joined: 20, share: '2500' },
  { key: 'roberto', first: 'Roberto', middle: 'Torres', last: 'Navarro', gender: 'Male', born: '1970-08-17', civil: 'Married', spouse: 'Edna Navarro', education: 'Elementary', livelihood: 'Corn farming', corn: '1.5', income: '85000', joined: 18, share: '2000', more: [[7, '1500']] },
  { key: 'teresita', first: 'Teresita', middle: 'Flores', last: 'Domingo', gender: 'Female', born: '1965-02-28', civil: 'Widowed', education: 'Elementary', palay: '0.8', income: '60000', joined: 16, share: '2000' },
  { key: 'ernesto', first: 'Ernesto', middle: 'Pascual', last: 'Salazar', gender: 'Male', born: '1982-06-06', civil: 'Married', spouse: 'Joy Salazar', education: 'High School', palay: '1.4', income: '110000', joined: 14, share: '3000' },
  { key: 'gloria', first: 'Gloria', middle: 'Mercado', last: 'Ramirez', gender: 'Female', born: '1988-10-21', civil: 'Married', spouse: 'Noel Ramirez', education: 'Vocational', palay: '1', income: '80000', joined: 12, share: '2000' },
  { key: 'danilo', first: 'Danilo', middle: 'Aguilar', last: 'Castro', gender: 'Male', born: '1992-03-08', civil: 'Single', education: 'College', livelihood: 'Corn farming', corn: '1', income: '70000', joined: 10, share: '1500' },
  { key: 'corazon', first: 'Corazon', middle: 'Valdez', last: 'Morales', gender: 'Female', born: '1976-07-15', civil: 'Married', spouse: 'Jun Morales', education: 'High School', palay: '1.1', income: '75000', joined: 3, share: '1000' },
  { key: 'manuel', first: 'Manuel', middle: 'Jimenez', last: 'Rivera', suffix: 'Jr.', gender: 'Male', born: '1995-11-11', civil: 'Single', education: 'College', palay: '0.6', income: '55000', joined: 1, share: '1000' },
];

export default async function seedMembers(ctx) {
  const { client, today, admin } = ctx;
  const people = MEMBERS.map((person, index) => {
    const purok = (index % 7) + 1;
    const farmArea = String(Number(person.palay || 0) + Number(person.corn || 0));
    const body = {
      first_name: person.first, middle_name: person.middle, last_name: person.last, suffix: person.suffix ?? null,
      email: `${person.first}.${person.last}`.toLowerCase().replace(/\s+/g, '') + '@example.com',
      // Made-up numbers; sample logins also have texts switched off.
      phone: `0900 000 ${String(index + 1).padStart(4, '0')}`,
      address: `Purok ${purok}, Barahan, Santa Cruz, Occidental Mindoro`,
      barangay: 'Barahan', municipality: 'Santa Cruz', province: 'Occidental Mindoro',
      date_of_birth: person.born, gender: person.gender, civil_status: person.civil, education: person.education,
      livelihood: person.livelihood || 'Rice farming', farm_area_ha: farmArea, palay_area_ha: person.palay ?? null, corn_area_ha: person.corn ?? null,
      yearly_income: person.income, spouse_name: person.spouse ?? null,
      membership_date: addDays(addMonths(today, -person.joined), -(index % 5)),
      status: 'active', share_capital: person.share,
    };
    // The Add Member form's own checks.
    const { errors, values } = validateMemberInput(body);
    const shareCapitalCents = parseShareCapital(body, errors);
    if (errors.length) throw new Error(`Sample member ${person.first} ${person.last}: ${errors.join(' ')}`);
    return { person, body, values, share: centsToString(shareCapitalCents), farmArea };
  });

  // Registration refuses a member already registered (same email, or same name and birthday).
  const duplicate = (await client.query(
    `SELECT m.member_number FROM members m JOIN unnest($1::text[], $2::text[], $3::text[], $4::date[]) AS p(email, first_name, last_name, born)
       ON lower(m.email) = lower(p.email) OR (m.date_of_birth = p.born AND lower(m.first_name) = lower(p.first_name) AND lower(m.last_name) = lower(p.last_name))
     LIMIT 1`,
    [people.map((p) => p.values.email), people.map((p) => p.values.firstName), people.map((p) => p.values.lastName), people.map((p) => p.body.date_of_birth)]
  )).rows[0];
  if (duplicate) throw new Error(`A sample member is already registered here (${duplicate.member_number}).`);

  // The next ACIFAC-YYYY-NNN numbers, under the same lock as the Add Member form. All
  // members are written a few statements at a time: the seeder may run across the internet.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['acifac-member-number']);
  const [prefix, firstNumber] = (await nextMemberNumber(client)).match(/^(ACIFAC-\d{4}-)(\d+)$/).slice(1);
  people.forEach((p, index) => { p.memberNumber = `${prefix}${String(Number(firstNumber) + index).padStart(3, '0')}`; });
  const column = (pick) => people.map(pick);
  const ids = (await client.query(
    `INSERT INTO members (member_number, first_name, middle_name, last_name, suffix, email, phone, address, barangay, municipality, province,
                          date_of_birth, gender, civil_status, education, livelihood, farm_area_ha, corn_area_ha, palay_area_ha, yearly_income,
                          spouse_name, membership_date, share_capital, status, created_at, updated_at)
     SELECT r.member_number, r.first_name, r.middle_name, r.last_name, r.suffix, r.email, r.phone, r.address, r.barangay, r.municipality, r.province,
            r.born, r.gender, r.civil_status, r.education, r.livelihood, r.farm_area, r.corn_area, r.palay_area, r.income,
            r.spouse, r.joined, r.share, 'active', ${stampSql('r.joined')}, ${stampSql('r.joined')}
     FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[],
                 $12::date[], $13::text[], $14::text[], $15::text[], $16::text[], $17::numeric[], $18::numeric[], $19::numeric[], $20::numeric[],
                 $21::text[], $22::date[], $23::numeric[]) WITH ORDINALITY
          AS r(member_number, first_name, middle_name, last_name, suffix, email, phone, address, barangay, municipality, province,
               born, gender, civil_status, education, livelihood, farm_area, corn_area, palay_area, income, spouse, joined, share, ord)
     ORDER BY r.ord
     RETURNING id`,
    [column((p) => p.memberNumber), column((p) => p.values.firstName), column((p) => p.body.middle_name), column((p) => p.values.lastName), column((p) => p.body.suffix),
      column((p) => p.values.email), column((p) => p.values.phone), column((p) => p.values.address), column((p) => p.body.barangay), column((p) => p.body.municipality),
      column((p) => p.body.province), column((p) => p.body.date_of_birth), column((p) => p.body.gender), column((p) => p.body.civil_status), column((p) => p.body.education),
      column((p) => p.body.livelihood), column((p) => p.body.farm_area_ha), column((p) => p.body.corn_area_ha), column((p) => p.body.palay_area_ha),
      column((p) => p.body.yearly_income), column((p) => p.body.spouse_name), column((p) => p.values.membershipDate), column((p) => p.share)]
  )).rows.map((row) => row.id);
  people.forEach((p, index) => { p.id = ids[index]; });

  // Share capital: the initial amount recorded with the registration, then later contributions.
  const contributions = people.flatMap((p) => [
    ...(Number(p.share) > 0 ? [{ id: p.id, amount: p.share, date: p.values.membershipDate, method: 'Initial', reference: `INITIAL-${p.memberNumber}`, notes: 'Initial share capital recorded with member registration.' }] : []),
    ...(p.person.more || []).map(([monthsAgo, amount]) => ({ id: p.id, amount, date: addMonths(today, -monthsAgo), method: 'Cash', reference: null, notes: 'Additional share capital' })),
  ]);
  await client.query(
    `INSERT INTO share_contributions (member_id, amount, contribution_date, payment_method, reference_number, notes, recorded_by, created_at, updated_at)
     SELECT r.id, r.amount, r.day, r.method, r.reference, r.notes, $7, ${stampSql('r.day')}, ${stampSql('r.day')}
     FROM unnest($1::int[], $2::numeric[], $3::date[], $4::text[], $5::text[], $6::text[]) AS r(id, amount, day, method, reference, notes)`,
    [contributions.map((c) => c.id), contributions.map((c) => c.amount), contributions.map((c) => c.date), contributions.map((c) => c.method),
      contributions.map((c) => c.reference), contributions.map((c) => c.notes), admin.id]
  );
  ctx.count('share contributions', contributions.length);
  // members.share_capital is the sum of the contributions, as the Shares page keeps it.
  await client.query(`UPDATE members m SET share_capital = s.total FROM (SELECT member_id, SUM(amount) AS total FROM share_contributions WHERE member_id = ANY($1::int[]) GROUP BY member_id) s WHERE m.id = s.member_id`, [ids]);
  await client.query(
    `INSERT INTO audit_logs (user_id, user_name_snapshot, user_role_snapshot, action, module, entity_type, entity_id, description, new_values, user_agent, created_at)
     SELECT $3, $4, $5, 'MEMBER_CREATED', 'Members', 'member', r.id::text, 'Created member ' || r.member_number,
            jsonb_build_object('member_number', r.member_number, 'share_capital', r.share, 'source', 'registration'), $6, ${stampSql('r.joined')}
     FROM unnest($1::int[], $2::text[], $7::numeric[], $8::date[]) AS r(id, member_number, share, joined)`,
    [ids, column((p) => p.memberNumber), admin.id, admin.username, admin.role, ctx.req.headers['user-agent'], column((p) => p.share), column((p) => p.values.membershipDate)]
  );

  for (const p of people) {
    ctx.members.push({
      id: p.id, key: p.person.key, memberNumber: p.memberNumber, email: p.values.email, phone: p.values.phone, address: p.values.address,
      fullName: [p.person.first, p.person.middle, p.person.last, p.person.suffix].filter(Boolean).join(' '),
      farmArea: p.farmArea, membershipDate: p.values.membershipDate,
    });
  }
  ctx.count('members', people.length);
  await createMemberLogins(ctx, ctx.members.map((member, index) => ({ member, username: loginName(people[index].person.first, people[index].person.last) })));
  ctx.logins.push(['Members', 'juan.delacruz, maria.santos, ... (first.lastname of each)', ctx.passwords.member]);
}
