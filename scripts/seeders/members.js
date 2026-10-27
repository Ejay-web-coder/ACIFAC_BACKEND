import { nextMemberNumber, parseShareCapital, readAdditionalInfo, validateMemberInput } from '../../src/controllers/memberController.js';
import { centsToString } from '../../src/utils/money.js';
import { createMemberLogins } from './accounts.js';
import { addDays, addMonths, stampSql } from './support.js';

// The sample members of the cooperative: SAMPLE_MEMBER_COUNT (100) members
// with every field of the Add Member form filled in (ID, RSBSA No., family,
// mother's maiden name, income sources, membership fee and seminar records),
// checked by the Add Member form's validation and registered as it registers
// them (numbers ACIFAC-YYYY-NNN, initial share capital, audit entry). The 15
// named below come first (the other seeders give them their loans, savings,
// services and rentals); the rest are generated. `joined` is how many months
// ago they became members; `more` lists later share capital contributions as
// [months ago, amount] (at most PHP 20,000 in all). Every member gets an
// active login of their own: member001, member002, ...
export const SAMPLE_MEMBER_COUNT = 100;

const NAMED = [
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

const MALE = ['Jose', 'Mario', 'Rogelio', 'Eduardo', 'Renato', 'Rolando', 'Arnel', 'Benjamin', 'Romeo', 'Alfredo', 'Reynaldo', 'Felipe', 'Rodel', 'Jonathan', 'Michael', 'Mark', 'Christian', 'Joel', 'Ramil', 'Noel', 'Wilfredo', 'Nestor', 'Ariel', 'Dennis'];
const FEMALE = ['Maricel', 'Rowena', 'Erlinda', 'Josefina', 'Marites', 'Cristina', 'Nenita', 'Analyn', 'Lorna', 'Evelyn', 'Remedios', 'Imelda', 'Jocelyn', 'Marilou', 'Rosalie', 'Mary Ann', 'Divina', 'Shirley', 'Jennifer', 'Aileen', 'Leonora', 'Perla'];
const SURNAMES = ['Abad', 'Agustin', 'Alvarez', 'Bernardo', 'Cabrera', 'Concepcion', 'David', 'De Guzman', 'De Leon', 'Del Rosario', 'Dizon', 'Enriquez', 'Esguerra', 'Francisco', 'Galang', 'Gutierrez',
  'Hernandez', 'Ignacio', 'Lim', 'Lozada', 'Macaraeg', 'Magbanua', 'Manalo', 'Marquez', 'Medina', 'Miranda', 'Natividad', 'Ocampo', 'Padilla', 'Panganiban', 'Perez', 'Quiambao', 'Robles', 'Rosales',
  'Samonte', 'Santiago', 'Soriano', 'Tolentino', 'Valenzuela', 'Velasco', 'Yap', 'Zamora', 'Sison', 'Tabios', 'Gatdula'];
const CIVIL = ['Married', 'Married', 'Married', 'Single', 'Widowed', 'Married', 'Separated'];
const EDUCATION = ['Elementary', 'High School', 'High School', 'Vocational', 'College', 'High School'];
const SHARE = ['1000', '1500', '2000', '2500', '3000', '5000'];
// Where the members live: the barangays of Santa Cruz, Occidental Mindoro the cooperative serves.
const BARANGAYS = ['Amnay', 'Cabagan', 'Barahan', 'Lumangbayan', 'Pinagturilan'];
const ID_TYPES = ['PhilSys National ID', 'PhilSys National ID', "Driver's License", "Voter's ID", 'UMID', 'Postal ID', 'Senior Citizen ID'];
const INCOME_EXTRA = [['Hog raising', '25000'], ['Sari-sari store', '36000'], ['Tricycle driving', '48000'], ['Vegetable garden', '18000'], ['Poultry', '15000'], ['Carpentry', '30000']];
const OFFICERS = ['Lorna Cruz', 'Ramon Bautista', 'Elvira Santos'];

const pick = (list, n) => list[n % list.length];
const digits = (seed, length) => String((seed * 7919 + 104729) % 10 ** length).padStart(length, '0');

// The 85 generated members, oldest members first, with a varied but repeatable mix.
function generated(count, today) {
  return Array.from({ length: count }, (_, index) => {
    const seq = index + NAMED.length + 1;
    const female = seq % 2 === 0;
    const first = pick(female ? FEMALE : MALE, seq * 7 + Math.floor(seq / 3));
    const last = pick(SURNAMES, seq * 5 + 1);
    const corn = seq % 6 === 0;
    const area = (0.5 + (seq % 7) * 0.35).toFixed(2);
    const civil = pick(CIVIL, seq);
    return {
      key: `m${String(seq).padStart(3, '0')}`, first, middle: pick(SURNAMES, seq * 11 + 4) === last ? pick(SURNAMES, seq + 2) : pick(SURNAMES, seq * 11 + 4), last,
      suffix: !female && seq % 17 === 0 ? 'Jr.' : null, gender: female ? 'Female' : 'Male',
      born: addDays('1958-01-01', (seq * 211) % 15000), civil,
      spouse: civil === 'Married' ? `${pick(female ? MALE : FEMALE, seq * 3)} ${last}` : null,
      education: pick(EDUCATION, seq * 3), livelihood: corn ? 'Corn farming' : seq % 9 === 0 ? 'Rice and vegetable farming' : 'Rice farming',
      palay: corn ? null : area, corn: corn ? area : null, income: String(48000 + (seq % 16) * 9000),
      // Spread over the last three years, oldest first; a few joined this month.
      joinedOn: addDays(today, -Math.max(2, Math.round(((count - index) / count) * 3 * 365) - 5)),
      share: pick(SHARE, seq), more: seq % 3 === 0 ? [[Math.max(1, (seq % 10) + 1), pick(['500', '1000', '1500', '2000'], seq)]] : [],
    };
  });
}

// Every field of the Add Member form, from a person above.
function memberBody(person, index, today) {
  const seq = index + 1;
  const barangay = pick(BARANGAYS, seq * 3 + 1);
  const farmArea = String(Number(person.palay || 0) + Number(person.corn || 0));
  const membershipDate = person.joinedOn ?? addDays(addMonths(today, -person.joined), -(index % 5));
  const children = person.civil === 'Single' ? [] : Array.from({ length: seq % 4 }, (_, n) => ({
    name: `${pick(n % 2 ? MALE : FEMALE, seq + n * 5)} ${person.last}`, age: String(3 + ((seq + n * 4) % 20)),
  }));
  const extra = seq % 3 === 0 ? pick(INCOME_EXTRA, seq) : null;
  const farmIncome = String(Number(person.income) - (extra ? Number(extra[1]) : 0));
  const idType = pick(ID_TYPES, seq * 5);
  const idNumber = idType === 'PhilSys National ID' ? `${digits(seq, 4)}-${digits(seq + 1, 4)}-${digits(seq + 2, 4)}-${digits(seq + 3, 4)}`
    : idType === "Driver's License" ? `D${digits(seq, 2)}-${digits(seq + 5, 2)}-${digits(seq + 9, 6)}`
      : idType === 'UMID' ? `CRN-${digits(seq, 4)}-${digits(seq + 3, 7)}-${seq % 10}` : `${idType.slice(0, 3).toUpperCase()}-${digits(seq, 8)}`;
  const year = membershipDate.slice(0, 4);
  const officer = pick(OFFICERS, seq);
  return {
    first_name: person.first, middle_name: person.middle, last_name: person.last, suffix: person.suffix ?? null,
    // Made-up addresses and numbers: sample logins also have emails and texts switched off.
    email: `member${String(seq).padStart(3, '0')}@example.com`,
    phone: `0900 ${String(Math.floor(seq / 10000)).padStart(3, '0')} ${String(seq).padStart(4, '0')}`,
    address: `Purok ${(seq % 7) + 1}, ${barangay}, Santa Cruz, Occidental Mindoro`,
    barangay, municipality: 'Santa Cruz', province: 'Occidental Mindoro',
    date_of_birth: person.born, gender: person.gender, civil_status: person.civil, education: person.education,
    id_type: idType, id_number: idNumber, rsbsa_no: `17-51-08-0${String(10 + BARANGAYS.indexOf(barangay)).padStart(2, '0')}-${String(1000 + seq * 13).padStart(6, '0')}`,
    livelihood: person.livelihood || 'Rice farming', farm_area_ha: farmArea, palay_area_ha: person.palay ?? null, corn_area_ha: person.corn ?? null,
    yearly_income: person.income,
    spouse_name: person.spouse ?? null, spouse_age: person.spouse ? String(Math.max(20, Number(today.slice(0, 4)) - Number(person.born.slice(0, 4)) + ((seq % 7) - 3))) : null,
    spouse_contact: person.spouse ? `0900 001 ${String(seq).padStart(4, '0')}` : null,
    children: children.map((child) => `${child.name} (${child.age})`).join('; '),
    emergency_contact: person.spouse ? `${person.spouse} (spouse), 0900 001 ${String(seq).padStart(4, '0')}` : `${pick(FEMALE, seq + 9)} ${person.last} (sibling), 0900 002 ${String(seq).padStart(4, '0')}`,
    membership_date: membershipDate, status: 'active', share_capital: person.share,
    additional_info: {
      motherLastName: pick(SURNAMES, seq * 13 + 7), motherFirstName: pick(FEMALE, seq * 3 + 2), motherMiddleName: pick(SURNAMES, seq * 17 + 1),
      motherMaidenName: `${pick(FEMALE, seq * 3 + 2)} ${pick(SURNAMES, seq * 17 + 1)} ${pick(SURNAMES, seq * 13 + 7)}`,
      children, incomeSources: [{ source: person.livelihood || 'Rice farming', amount: farmIncome }, ...(extra ? [{ source: extra[0], amount: extra[1] }] : [])],
      membershipType: seq % 8 === 0 ? 'Associate' : 'Regular', bodResolution: `BOD Res. No. ${year}-${String((seq % 40) + 1).padStart(3, '0')}`,
      membershipFee: '500', dateReceived: membershipDate,
      preMembershipSeminar: 'Yes', seminarOrNumber: `OR-${year}-${String(seq * 3).padStart(4, '0')}`, seminarCertifiedBy: officer,
      paymentOfMembershipFee: 'Yes', orNumber: `OR-${year}-${String(seq * 3 + 1).padStart(4, '0')}`, feeCertifiedBy: officer,
      initialPaidUpCapital: person.share, capitalOrNumber: `OR-${year}-${String(seq * 3 + 2).padStart(4, '0')}`, capitalCertifiedBy: officer,
    },
  };
}

export default async function seedMembers(ctx) {
  const { client, today, admin } = ctx;
  const persons = [...NAMED, ...generated(SAMPLE_MEMBER_COUNT - NAMED.length, today)];
  const people = persons.map((person, index) => {
    const body = memberBody(person, index, today);
    // The Add Member form's own checks.
    const { errors, values } = validateMemberInput(body);
    const shareCapitalCents = parseShareCapital(body, errors);
    if (errors.length) throw new Error(`Sample member ${person.first} ${person.last}: ${errors.join(' ')}`);
    return { person, body, values, info: readAdditionalInfo(body.additional_info), share: centsToString(shareCapitalCents), farmArea: body.farm_area_ha };
  });

  // Registration refuses a member already registered (same email, or same name and birthday).
  const duplicate = (await client.query(
    `SELECT m.member_number FROM members m JOIN unnest($1::text[], $2::text[], $3::text[], $4::date[]) AS p(email, first_name, last_name, born)
       ON lower(m.email) = lower(p.email) OR (m.date_of_birth = p.born AND lower(m.first_name) = lower(p.first_name) AND lower(m.last_name) = lower(p.last_name))
     LIMIT 1`,
    [people.map((p) => p.values.email), people.map((p) => p.values.firstName), people.map((p) => p.values.lastName), people.map((p) => p.body.date_of_birth)]
  )).rows[0];
  if (duplicate) throw new Error(`A sample member is already registered here (${duplicate.member_number}).`);

  // Member numbers in the order they joined, as if each had been registered on the day.
  const order = people.map((p, index) => index).sort((a, b) => people[a].values.membershipDate.localeCompare(people[b].values.membershipDate) || a - b);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['acifac-member-number']);
  const [prefix, firstNumber] = (await nextMemberNumber(client)).match(/^(ACIFAC-\d{4}-)(\d+)$/).slice(1);
  order.forEach((index, position) => { people[index].memberNumber = `${prefix}${String(Number(firstNumber) + position).padStart(3, '0')}`; });

  const column = (pick) => people.map(pick);
  const ids = (await client.query(
    `INSERT INTO members (member_number, first_name, middle_name, last_name, suffix, email, phone, address, barangay, municipality, province,
                          date_of_birth, gender, civil_status, education, id_type, id_number, rsbsa_no, livelihood, farm_area_ha, corn_area_ha, palay_area_ha,
                          yearly_income, spouse_name, spouse_age, spouse_contact, children, emergency_contact, membership_date, share_capital, status,
                          additional_info, created_at, updated_at)
     SELECT r.member_number, r.first_name, r.middle_name, r.last_name, r.suffix, r.email, r.phone, r.address, r.barangay, r.municipality, r.province,
            r.born, r.gender, r.civil_status, r.education, r.id_type, r.id_number, r.rsbsa_no, r.livelihood, r.farm_area, r.corn_area, r.palay_area,
            r.income, r.spouse, r.spouse_age, r.spouse_contact, r.children, r.emergency, r.joined, r.share, 'active',
            r.info, ${stampSql('r.joined')}, ${stampSql('r.joined')}
     FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[],
                 $12::date[], $13::text[], $14::text[], $15::text[], $16::text[], $17::text[], $18::text[], $19::text[], $20::numeric[], $21::numeric[], $22::numeric[],
                 $23::numeric[], $24::text[], $25::int[], $26::text[], $27::text[], $28::text[], $29::date[], $30::numeric[], $31::jsonb[]) WITH ORDINALITY
          AS r(member_number, first_name, middle_name, last_name, suffix, email, phone, address, barangay, municipality, province,
               born, gender, civil_status, education, id_type, id_number, rsbsa_no, livelihood, farm_area, corn_area, palay_area,
               income, spouse, spouse_age, spouse_contact, children, emergency, joined, share, info, ord)
     ORDER BY r.ord
     RETURNING id`,
    [column((p) => p.memberNumber), column((p) => p.values.firstName), column((p) => p.body.middle_name), column((p) => p.values.lastName), column((p) => p.body.suffix),
      column((p) => p.values.email), column((p) => p.values.phone), column((p) => p.values.address), column((p) => p.body.barangay), column((p) => p.body.municipality),
      column((p) => p.body.province), column((p) => p.body.date_of_birth), column((p) => p.body.gender), column((p) => p.body.civil_status), column((p) => p.body.education),
      column((p) => p.body.id_type), column((p) => p.body.id_number), column((p) => p.body.rsbsa_no), column((p) => p.body.livelihood),
      column((p) => p.body.farm_area_ha), column((p) => p.body.corn_area_ha), column((p) => p.body.palay_area_ha), column((p) => p.body.yearly_income),
      column((p) => p.body.spouse_name), column((p) => (p.body.spouse_age === null ? null : Number(p.body.spouse_age))), column((p) => p.body.spouse_contact),
      column((p) => p.body.children || null), column((p) => p.body.emergency_contact), column((p) => p.values.membershipDate), column((p) => p.share),
      column((p) => JSON.stringify(p.info))]
  )).rows.map((row) => row.id);
  people.forEach((p, index) => { p.id = ids[index]; });

  // Share capital: the initial amount recorded with the registration, then later contributions.
  const contributions = people.flatMap((p) => [
    ...(Number(p.share) > 0 ? [{ id: p.id, amount: p.share, date: p.values.membershipDate, method: 'Initial', reference: `INITIAL-${p.memberNumber}`, notes: 'Initial share capital recorded with member registration.' }] : []),
    ...(p.person.more || []).map(([monthsAgo, amount]) => ({ id: p.id, amount, date: addMonths(today, -monthsAgo), method: 'Cash', reference: null, notes: 'Additional share capital' }))
      .filter((contribution) => contribution.date > p.values.membershipDate),
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
      farmArea: p.farmArea, membershipDate: p.values.membershipDate, barangay: p.body.barangay, gender: p.body.gender,
      civilStatus: p.body.civil_status, born: p.body.date_of_birth, livelihood: p.body.livelihood, crop: p.person.corn && !p.person.palay ? 'Corn' : 'Rice',
    });
  }
  ctx.count('members', people.length);
  const logins = ctx.members.map((member, index) => ({ member, username: `member${String(index + 1).padStart(3, '0')}` }));
  await createMemberLogins(ctx, logins);
  ctx.logins.push(['Members', `${logins[0].username} ... ${logins.at(-1).username}`, ctx.passwords.member]);
}
