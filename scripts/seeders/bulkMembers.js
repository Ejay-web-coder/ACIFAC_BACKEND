import { TIME_ZONE } from '../../src/config/env.js';
import { nextMemberNumber, parseShareCapital, validateMemberInput } from '../../src/controllers/memberController.js';
import { centsToString } from '../../src/utils/money.js';
import { hashPassword } from '../../src/utils/password.js';
import { addDays } from './support.js';

// Many sample members at once (npm run seed -- --add-members=500), each with an
// active login of their own: member001, member002, ... with the sample member
// password and an initial share capital; no loans, savings or attendance of
// their own. Each one is checked by the Add Member form's validation and gets
// the next ACIFAC-YYYY-NNN number, but they are written a few hundred at a time,
// so that adding them to a database across the internet takes seconds.
const MALE = ['Jose', 'Mario', 'Rogelio', 'Eduardo', 'Renato', 'Rolando', 'Arnel', 'Benjamin', 'Romeo', 'Alfredo', 'Reynaldo', 'Felipe', 'Rodel', 'Jonathan', 'Michael', 'Mark', 'Christian', 'Joel', 'Ramil', 'Noel'];
const FEMALE = ['Maricel', 'Rowena', 'Erlinda', 'Josefina', 'Marites', 'Cristina', 'Nenita', 'Analyn', 'Lorna', 'Evelyn', 'Remedios', 'Imelda', 'Jocelyn', 'Marilou', 'Rosalie', 'Mary Ann', 'Divina', 'Shirley', 'Jennifer', 'Aileen'];
const SURNAMES = ['Abad', 'Agustin', 'Alvarez', 'Bernardo', 'Cabrera', 'Concepcion', 'David', 'De Guzman', 'De Leon', 'Del Rosario', 'Dizon', 'Enriquez', 'Esguerra', 'Francisco', 'Galang', 'Gutierrez',
  'Hernandez', 'Ignacio', 'Lim', 'Lozada', 'Macaraeg', 'Magbanua', 'Manalo', 'Marquez', 'Medina', 'Miranda', 'Natividad', 'Ocampo', 'Padilla', 'Panganiban', 'Perez', 'Quiambao', 'Robles', 'Rosales',
  'Samonte', 'Santiago', 'Soriano', 'Tolentino', 'Valenzuela', 'Velasco', 'Villanueva', 'Yap', 'Zamora', 'Sison'];
const CIVIL = ['Married', 'Married', 'Married', 'Single', 'Widowed', 'Separated'];
const EDUCATION = ['Elementary', 'High School', 'High School', 'Vocational', 'College'];
const SHARE = ['1000', '1500', '2000', '2500', '3000', '5000'];
const BATCH = 500;

const pick = (list, n) => list[n % list.length];
const stamp = (dayParam, time) => `((${dayParam})::date + TIME '${time}') AT TIME ZONE '${TIME_ZONE}'`;

function generate(seq, index, count, today) {
  const female = seq % 2 === 0;
  const first = pick(female ? FEMALE : MALE, Math.floor(seq / 2) * 7 + seq);
  const last = pick(SURNAMES, seq * 5 + Math.floor(seq / SURNAMES.length));
  const middle = pick(SURNAMES, seq * 11 + 3);
  const username = `member${String(seq).padStart(3, '0')}`;
  const palay = (0.5 + (seq % 6) * 0.4).toFixed(1);
  const body = {
    first_name: first, middle_name: middle === last ? pick(SURNAMES, seq + 1) : middle, last_name: last,
    email: `${username}@example.com`,
    // Made-up numbers; texts are switched off for these logins.
    phone: `0900 ${String(100 + Math.floor(seq / 10000)).padStart(3, '0')} ${String(seq % 10000).padStart(4, '0')}`,
    address: `Purok ${(seq % 7) + 1}, Barahan, Santa Cruz, Occidental Mindoro`,
    barangay: 'Barahan', municipality: 'Santa Cruz', province: 'Occidental Mindoro',
    // A different birthday for each of 14,600 members in a row (1960 to 1999).
    date_of_birth: addDays('1960-01-01', (seq * 37) % 14600),
    gender: female ? 'Female' : 'Male', civil_status: pick(CIVIL, seq), education: pick(EDUCATION, seq * 3),
    livelihood: seq % 5 === 0 ? 'Corn farming' : 'Rice farming', farm_area_ha: palay, palay_area_ha: seq % 5 === 0 ? null : palay, corn_area_ha: seq % 5 === 0 ? palay : null,
    yearly_income: String(50000 + (seq % 15) * 10000),
    // Spread over the last three years, oldest first.
    membership_date: addDays(today, -Math.max(1, Math.round(((count - index) / count) * 3 * 365))),
    status: 'active', share_capital: pick(SHARE, seq),
  };
  const { errors, values } = validateMemberInput(body);
  const shareCapitalCents = parseShareCapital(body, errors);
  if (errors.length) throw new Error(`Generated member ${username}: ${errors.join(' ')}`);
  return { username, body, values, share: centsToString(shareCapitalCents) };
}

export default async function addBulkMembers(ctx, count) {
  const { client, today } = ctx;
  // Numbering continues after logins already added this way (member001 ... member500, then member501 ...).
  const lastLogin = Number((await client.query(
    `SELECT COALESCE(MAX(SUBSTRING(username FROM '^member([0-9]+)$')::int), 0) AS n FROM users WHERE username ~ '^member[0-9]+$'`
  )).rows[0].n);
  const people = Array.from({ length: count }, (_, index) => generate(lastLogin + index + 1, index, count, today));

  // Registration refuses a second member with the same name and birthday: such a
  // generated member is born a day later instead (emails are unique by their number).
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const clashes = (await client.query(
      `SELECT DISTINCT p.i FROM unnest($1::text[], $2::text[], $3::date[]) WITH ORDINALITY AS p(first_name, last_name, born, i)
       JOIN members m ON m.date_of_birth = p.born AND lower(m.first_name) = lower(p.first_name) AND lower(m.last_name) = lower(p.last_name)`,
      [people.map((p) => p.values.firstName), people.map((p) => p.values.lastName), people.map((p) => p.body.date_of_birth)]
    )).rows.map((row) => Number(row.i) - 1);
    if (!clashes.length) break;
    if (attempt === 29) throw new Error('Could not give the generated members birthdays of their own.');
    for (const index of clashes) people[index].body.date_of_birth = addDays(people[index].body.date_of_birth, 1);
  }

  // The next ACIFAC-YYYY-NNN numbers, under the same lock as the Add Member form.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['acifac-member-number']);
  const [prefix, firstNumber] = (await nextMemberNumber(client)).match(/^(ACIFAC-\d{4}-)(\d+)$/).slice(1);
  people.forEach((person, index) => { person.memberNumber = `${prefix}${String(Number(firstNumber) + index).padStart(3, '0')}`; });

  const passwordHash = await hashPassword(ctx.passwords.member);
  const quiet = JSON.stringify({ emailNotifications: false, smsNotifications: false, loanReminders: true });
  const admin = ctx.admin;
  for (let start = 0; start < people.length; start += BATCH) {
    const batch = people.slice(start, start + BATCH);
    const column = (pickValue) => batch.map(pickValue);
    const ids = (await client.query(
      `INSERT INTO members (member_number, first_name, middle_name, last_name, email, phone, address, barangay, municipality, province,
                            date_of_birth, gender, civil_status, education, livelihood, farm_area_ha, corn_area_ha, palay_area_ha, yearly_income,
                            membership_date, share_capital, status, created_at, updated_at)
       SELECT r.member_number, r.first_name, r.middle_name, r.last_name, r.email, r.phone, r.address, r.barangay, r.municipality, r.province,
              r.born, r.gender, r.civil_status, r.education, r.livelihood, r.farm_area, r.corn_area, r.palay_area, r.income,
              r.joined, r.share, 'active', ${stamp('r.joined', '09:00')}, ${stamp('r.joined', '09:00')}
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[],
                   $11::date[], $12::text[], $13::text[], $14::text[], $15::text[], $16::numeric[], $17::numeric[], $18::numeric[], $19::numeric[],
                   $20::date[], $21::numeric[]) WITH ORDINALITY
            AS r(member_number, first_name, middle_name, last_name, email, phone, address, barangay, municipality, province,
                 born, gender, civil_status, education, livelihood, farm_area, corn_area, palay_area, income, joined, share, ord)
       ORDER BY r.ord
       RETURNING id`,
      [column((p) => p.memberNumber), column((p) => p.values.firstName), column((p) => p.body.middle_name), column((p) => p.values.lastName), column((p) => p.values.email),
        column((p) => p.values.phone), column((p) => p.values.address), column((p) => p.body.barangay), column((p) => p.body.municipality), column((p) => p.body.province),
        column((p) => p.body.date_of_birth), column((p) => p.body.gender), column((p) => p.body.civil_status), column((p) => p.body.education), column((p) => p.body.livelihood),
        column((p) => p.body.farm_area_ha), column((p) => p.body.corn_area_ha), column((p) => p.body.palay_area_ha), column((p) => p.body.yearly_income),
        column((p) => p.values.membershipDate), column((p) => p.share)]
    )).rows.map((row) => row.id);
    batch.forEach((person, index) => { person.id = ids[index]; });

    // Initial share capital, as registration records it.
    await client.query(
      `INSERT INTO share_contributions (member_id, amount, contribution_date, payment_method, reference_number, notes, recorded_by, created_at, updated_at)
       SELECT r.id, r.amount, r.joined, 'Initial', 'INITIAL-' || r.member_number, 'Initial share capital recorded with member registration.', $5, ${stamp('r.joined', '09:00')}, ${stamp('r.joined', '09:00')}
       FROM unnest($1::int[], $2::numeric[], $3::date[], $4::text[]) AS r(id, amount, joined, member_number)`,
      [column((p) => p.id), column((p) => p.share), column((p) => p.values.membershipDate), column((p) => p.memberNumber), admin.id]
    );
    await client.query(
      `INSERT INTO users (member_id, username, email, password_hash, role, account_status, must_change_password, password_changed_at, full_name, phone, notification_preferences, created_at, updated_at)
       SELECT r.id, r.username, r.email, $5, 'MEMBER', 'ACTIVE', FALSE, NOW(), r.full_name, r.phone, $6::jsonb, ${stamp('LEAST(r.joined + 3, $7::date)', '10:00')}, NOW()
       FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $8::text[], $9::date[]) AS r(id, username, email, full_name, phone, joined)`,
      [column((p) => p.id), column((p) => p.username), column((p) => p.values.email), column((p) => [p.values.firstName, p.body.middle_name, p.values.lastName].join(' ')),
        passwordHash, quiet, today, column((p) => p.values.phone), column((p) => p.values.membershipDate)]
    );
    // One audit entry per member, as the Add Member form writes.
    await client.query(
      `INSERT INTO audit_logs (user_id, user_name_snapshot, user_role_snapshot, action, module, entity_type, entity_id, description, new_values, user_agent)
       SELECT $3, $4, $5, 'MEMBER_CREATED', 'Members', 'member', r.id::text, 'Created member ' || r.member_number,
              jsonb_build_object('member_number', r.member_number, 'source', 'registration'), $6
       FROM unnest($1::int[], $2::text[]) AS r(id, member_number)`,
      [column((p) => p.id), column((p) => p.memberNumber), admin.id, admin.username, admin.role, ctx.req.headers['user-agent']]
    );
    ctx.count('members', batch.length);
    ctx.count('member logins', batch.length);
    if (count >= 2000) console.log(`  ${Math.min(start + BATCH, count)} of ${count} members added...`);
  }
  if (count > 0) {
    const first = `member${String(lastLogin + 1).padStart(3, '0')}`;
    const lastName = `member${String(lastLogin + count).padStart(3, '0')}`;
    ctx.logins.push(['Members', count === 1 ? first : `${first} ... ${lastName}`, ctx.passwords.member]);
  }
}
