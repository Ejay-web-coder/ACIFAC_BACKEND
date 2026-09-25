import { query, withTransaction } from '../config/db.js';
import { isValidDateOnly, todayDateOnly } from '../utils/dates.js';
import { badRequest, toHttpError } from '../utils/http.js';
import { parseMoneyInput } from '../utils/money.js';
import { insertMemberRecord, parseShareCapital, SAVINGS_METHODS, insertSavingsDeposit, validateMemberInput } from '../controllers/memberController.js';
import { insertLoanRequest, memberApplicationSelect, prepareApplication } from '../controllers/loanController.js';
import { insertRentalRequest } from '../controllers/machineryController.js';
import { insertKadiwaSale } from '../controllers/kadiwaController.js';

// Scanned cooperative forms: what each one contains, how the AI must report
// it, how it is checked against the database, and where it is saved.
//
// Flow: AI reads the form -> fields are normalised -> authenticity + database
// checks run -> the save is rehearsed in a rolled-back transaction -> the form
// is posted to its module (automatically when every check passes, otherwise
// after an admin reviews it).

export const UNRECOGNIZED = 'Document Type Not Recognized';

const f = (key, label, options = {}) => ({ key, label, kind: 'text', required: false, ...options });

export const FORM_DEFINITIONS = {
  'Membership Form': {
    module: 'members', moduleLabel: 'Membership Management', signatureExpected: true,
    description: 'Membership application / registration form of a new cooperative member.',
    fields: [
      f('firstName', 'First Name', { required: true }), f('middleName', 'Middle Name'), f('lastName', 'Last Name', { required: true }), f('suffix', 'Suffix'),
      f('email', 'Email', { required: true }), f('phone', 'Phone Number', { required: true }), f('address', 'Address', { required: true }),
      f('barangay', 'Barangay'), f('municipality', 'Municipality'), f('province', 'Province'),
      f('dateOfBirth', 'Date of Birth', { kind: 'date' }), f('gender', 'Gender'), f('civilStatus', 'Civil Status'),
      f('rsbsaNo', 'RSBSA Number'), f('livelihood', 'Livelihood'), f('farmAreaHa', 'Farm Area (ha)', { kind: 'number' }),
      f('membershipDate', 'Membership Date', { kind: 'date', required: true }), f('shareCapital', 'Initial Share Capital', { kind: 'money' }),
    ],
  },
  'Loan Form': {
    module: 'loans', moduleLabel: 'Loans & Payments (pending approval)', signatureExpected: true,
    description: 'Loan application form filled in by a member.',
    fields: [
      f('memberNumber', 'Member ID', { required: true }), f('memberName', 'Member Name', { required: true }),
      f('loanType', 'Loan Type (agricultural, personal, emergency)', { required: true }), f('amount', 'Loan Amount', { kind: 'money', required: true }),
      f('term', 'Loan Term (months)', { kind: 'integer', required: true }), f('purpose', 'Loan Purpose', { required: true }),
      f('loanMode', 'Loan Mode (cash, in-kind, combination)'), f('farmArea', 'Farm Area (ha)', { kind: 'number' }),
      f('monthlyIncome', 'Monthly Income', { kind: 'money' }), f('borrowerPhone', 'Contact Number'), f('borrowerAddress', 'Address'),
      f('coMakerName', 'Co-maker Name'), f('coMakerAddress', 'Co-maker Address'), f('coMakerContact', 'Co-maker Contact'), f('coMakerRelationship', 'Co-maker Relationship'),
      f('collateralType', 'Collateral Type'), f('collateralDetails', 'Collateral Details'), f('applicationDate', 'Application Date', { kind: 'date' }),
    ],
  },
  'Savings Form': {
    module: 'savings', moduleLabel: 'Savings', signatureExpected: true,
    description: 'Savings deposit slip / savings form.',
    fields: [
      f('memberNumber', 'Member ID', { required: true }), f('memberName', 'Member Name', { required: true }),
      f('amount', 'Deposit Amount', { kind: 'money', required: true }), f('date', 'Deposit Date', { kind: 'date', required: true }),
      f('paymentMethod', `Payment Method (${SAVINGS_METHODS.join(', ')})`), f('referenceNumber', 'Reference / OR Number'), f('notes', 'Notes'),
    ],
  },
  'Machinery Form': {
    module: 'machinery', moduleLabel: 'Machinery Operations (pending approval)', signatureExpected: true,
    description: 'Farm machinery rental / booking request form.',
    fields: [
      f('memberNumber', 'Member ID', { required: true }), f('memberName', 'Member Name', { required: true }),
      f('machinery', 'Machinery (name or ID)', { required: true }), f('purpose', 'Purpose', { required: true }),
      f('startDate', 'Start Date', { kind: 'date', required: true }), f('endDate', 'End Date', { kind: 'date', required: true }), f('notes', 'Notes'),
    ],
  },
  'Kadiwa Sales Form': {
    module: 'kadiwa', moduleLabel: 'Kadiwa Store sales', signatureExpected: false,
    description: 'Kadiwa store daily / new sales form with sales per category.',
    fields: [
      f('encoderName', 'Encoder / Prepared By', { required: true }), f('saleDate', 'Sale Date', { kind: 'date' }),
      f('groceriesPrice', 'Groceries Sales', { kind: 'money' }), f('vegetablesPrice', 'Vegetables Sales', { kind: 'money' }),
      f('meatPrice', 'Meat Sales', { kind: 'money' }), f('totalExpenses', 'Total Expenses', { kind: 'money' }),
      f('netSales', 'Net Sales written on the form', { kind: 'money' }),
    ],
  },
};

// Recognised but kept for reference only; they are not posted anywhere.
export const REFERENCE_TYPES = ['Payment Receipt', 'ID Document', 'Cooperative Form'];
export const DOCUMENT_TYPES = [...Object.keys(FORM_DEFINITIONS), ...REFERENCE_TYPES, UNRECOGNIZED];
const LEGACY_TYPES = { 'Loan Application': 'Loan Form' };

export function normalizeDocumentType(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const legacy = LEGACY_TYPES[text];
  if (legacy) return legacy;
  return DOCUMENT_TYPES.find((type) => type.toLowerCase() === text.toLowerCase()) || UNRECOGNIZED;
}

export function isPostable(documentType) {
  return Boolean(FORM_DEFINITIONS[documentType]);
}

export function publicFormDefinitions() {
  return Object.entries(FORM_DEFINITIONS).map(([type, definition]) => ({
    type, module: definition.module, moduleLabel: definition.moduleLabel, description: definition.description,
    fields: definition.fields.map(({ key, label, kind, required }) => ({ key, label, kind, required })),
  }));
}

export function buildAnalysisPrompt(captureSource) {
  const forms = Object.entries(FORM_DEFINITIONS).map(([type, definition]) => (
    `- "${type}": ${definition.description} extractedData keys: ${definition.fields.map((field) => `${field.key}${field.required ? ' (required)' : ''}`).join(', ')}.`
  )).join('\n');
  return `You read paper forms of ACIFAC, an agricultural cooperative in the Philippines. Return JSON only with exactly these fields:
documentType (string), confidence (number 0-100, required), ocrText (string, all readable text), extractedData (object of strings), authenticity (object).

documentType must be one of:
${forms}
- "Payment Receipt", "ID Document", "Cooperative Form": reference documents; extractedData may use any short field names.
- "${UNRECOGNIZED}": anything else, or when confidence is below 70.

Extraction rules: use exactly the listed keys for the five forms. Copy values as written; never invent, complete or guess a value — use "" when a field is blank, missing or illegible. Dates as YYYY-MM-DD. Money and numbers as plain digits with optional 2 decimals (no currency sign, no commas).

authenticity must be: { "score": number 0-100 (how likely this is a genuine, unaltered, actually filled-in cooperative form), "verdict": "genuine" | "suspicious" | "fake", "physicalDocument": boolean (true if this is a photo or scan of real paper; false for a photo of a screen, a screenshot, or a digitally generated/edited image), "filledIn": boolean (false if the form is blank or only a template/sample), "signaturePresent": boolean, "issues": [short strings] }.
Look for: altered, overwritten or erased values; mismatched fonts or ink inside a field; pasted or digitally edited areas; totals that do not add up; SAMPLE/SPECIMEN/VOID marks; screen moiré or pixels; missing signatures; a form that is not an ACIFAC/cooperative form. Report every problem found in issues.${captureSource === 'camera' ? '\nThis document was photographed with a phone camera at the office, so normal perspective, shadows and paper texture are expected and are not signs of tampering.' : ''}`;
}

// ---------------------------------------------------------------------------
// Normalisation of AI output and admin edits.

const compact = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');

function normalizeMoney(value) {
  const text = String(value ?? '').replace(/₱|php|p(?=\s*\d)|,|\s/gi, '').trim();
  return /^\d+(\.\d{1,2})?$/.test(text) ? text : String(value ?? '').trim();
}

function normalizeDate(value) {
  const text = String(value ?? '').trim();
  if (!text || isValidDateOnly(text)) return text;
  const slash = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (slash) {
    const candidate = `${slash[3]}-${slash[1].padStart(2, '0')}-${slash[2].padStart(2, '0')}`; // MM/DD/YYYY as used in the Philippines
    return isValidDateOnly(candidate) ? candidate : text;
  }
  const parsed = Date.parse(`${text} 12:00 UTC`);
  if (Number.isNaN(parsed)) return text;
  return new Date(parsed).toISOString().slice(0, 10);
}

function normalizeValue(field, value) {
  const text = value === null || value === undefined ? '' : String(value).trim().slice(0, 2000);
  if (!text) return '';
  if (field.kind === 'money') return normalizeMoney(text);
  if (field.kind === 'date') return normalizeDate(text);
  if (field.kind === 'number' || field.kind === 'integer') return text.replace(/,/g, '').replace(/\s*(ha|hectares?|months?|mos?\.?)$/i, '');
  return text;
}

// Maps whatever keys the AI (or an older scan) used onto the form's own keys.
export function normalizeExtractedData(documentType, raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const definition = FORM_DEFINITIONS[documentType];
  if (!definition) {
    return Object.fromEntries(Object.entries(source).filter(([key]) => key).slice(0, 60).map(([key, value]) => [String(key).slice(0, 100), value === null || value === undefined ? '' : String(value).slice(0, 2000)]));
  }
  const byCompactKey = new Map(Object.entries(source).map(([key, value]) => [compact(key), value]));
  return Object.fromEntries(definition.fields.map((field) => {
    const value = byCompactKey.get(compact(field.key)) ?? byCompactKey.get(compact(field.label.replace(/\(.*\)/, '')));
    return [field.key, normalizeValue(field, value)];
  }));
}

export function normalizeAuthenticity(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const score = Number(value.score);
  const bool = (input) => (typeof input === 'boolean' ? input : null);
  const verdict = ['genuine', 'suspicious', 'fake'].includes(String(value.verdict).toLowerCase()) ? String(value.verdict).toLowerCase() : 'unknown';
  return {
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null,
    verdict,
    physicalDocument: bool(value.physicalDocument),
    filledIn: bool(value.filledIn),
    signaturePresent: bool(value.signaturePresent),
    issues: Array.isArray(value.issues) ? value.issues.map((issue) => String(issue).slice(0, 300)).filter(Boolean).slice(0, 12) : [],
  };
}

// ---------------------------------------------------------------------------
// Verification.

const nameTokens = (name) => String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((token) => token.length > 1);

function nameSimilarity(a, b) {
  const left = new Set(nameTokens(a));
  const right = new Set(nameTokens(b));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

const memberLookupSelect = `SELECT id, member_number, status, TRIM(CONCAT_WS(' ', first_name, middle_name, last_name, suffix)) AS full_name FROM members`;

async function findMember(db, data, { requireActive }) {
  const number = String(data.memberNumber || '').trim();
  const name = String(data.memberName || '').trim();
  let member = null;
  let matchedBy = 'number';
  if (number) {
    member = (await db.query(`${memberLookupSelect} WHERE UPPER(member_number) = UPPER($1)`, [number])).rows[0] || null;
    if (!member) return { check: ['fail', `Member ID ${number} does not exist in the member records.`] };
  } else if (name) {
    const rows = (await db.query(`${memberLookupSelect} WHERE LOWER(TRIM(CONCAT_WS(' ', first_name, middle_name, last_name, suffix))) = LOWER($1) OR LOWER(TRIM(CONCAT_WS(' ', first_name, last_name))) = LOWER($1) LIMIT 2`, [name])).rows;
    if (rows.length !== 1) return { check: ['fail', rows.length ? `More than one member is named "${name}". Enter the Member ID from the form.` : `No member named "${name}" was found. Enter the Member ID from the form.`] };
    [member] = rows;
    matchedBy = 'name';
  } else {
    return { check: ['fail', 'The form has no Member ID or member name.'] };
  }

  if (member.status === 'archived' || (requireActive && member.status !== 'active')) {
    return { member, check: ['fail', `${member.full_name} (${member.member_number}) is ${member.status}; this form cannot be recorded for them.`] };
  }
  if (matchedBy === 'name') return { member, check: ['warn', `Matched by name only to ${member.full_name} (${member.member_number}); the form has no Member ID.`] };
  if (!name) return { member, check: ['warn', `The form has no member name to confirm Member ID ${member.member_number} (${member.full_name}).`] };
  const similarity = nameSimilarity(name, member.full_name);
  if (similarity < 0.5) return { member, check: ['fail', `The name on the form ("${name}") does not match the owner of ${member.member_number} (${member.full_name}).`] };
  if (similarity < 1) return { member, check: ['warn', `The name on the form ("${name}") only partly matches ${member.full_name} (${member.member_number}).`] };
  return { member, check: ['pass', `${member.full_name} (${member.member_number}) found and the name matches.`] };
}

async function findMachine(db, reference) {
  const text = String(reference || '').trim();
  if (!text) return { error: 'The form does not name the machinery.' };
  const exact = (await db.query('SELECT id, name, status FROM machinery WHERE LOWER(id) = LOWER($1) OR LOWER(name) = LOWER($1) LIMIT 2', [text])).rows;
  if (exact.length === 1) return { machine: exact[0] };
  const partial = (await db.query(`SELECT id, name, status FROM machinery WHERE name ILIKE '%' || $1 || '%' LIMIT 2`, [text])).rows;
  if (partial.length === 1) return { machine: partial[0], partial: true };
  return { error: partial.length ? `"${text}" matches more than one machine. Use the exact machinery name or ID.` : `No machinery named "${text}" is registered.` };
}

// Fields that identify a form's content, so the same paper form photographed
// twice (different file, same data) is not posted twice.
const FINGERPRINT_KEYS = {
  'Membership Form': ['firstName', 'lastName', 'dateOfBirth', 'email'],
  'Loan Form': ['memberNumber', 'loanType', 'amount', 'term'],
  'Savings Form': ['memberNumber', 'amount', 'date', 'referenceNumber'],
  'Machinery Form': ['memberNumber', 'machinery', 'startDate', 'endDate'],
  'Kadiwa Sales Form': ['encoderName', 'saleDate', 'groceriesPrice', 'vegetablesPrice', 'meatPrice', 'totalExpenses'],
};

const moneyCents = (value) => (value ? parseMoneyInput(value, { allowZero: true }) : 0);

function checkFields(definition, data, add) {
  const missing = definition.fields.filter((field) => field.required && !String(data[field.key] || '').trim()).map((field) => field.label.replace(/\s*\(.*\)$/, ''));
  if (missing.length) add('required', 'Required information', 'fail', `Missing on the form: ${missing.join(', ')}.`);
  else add('required', 'Required information', 'pass', 'All required fields were read from the form.');

  const invalid = [];
  const today = todayDateOnly();
  for (const field of definition.fields) {
    const value = String(data[field.key] || '').trim();
    if (!value) continue;
    if (field.kind === 'date' && !isValidDateOnly(value)) invalid.push(`${field.label} is not a valid date`);
    else if (field.kind === 'date' && !['startDate', 'endDate'].includes(field.key) && value > today) invalid.push(`${field.label} is in the future`);
    else if (field.kind === 'money' && parseMoneyInput(value, { allowZero: true }) === null) invalid.push(`${field.label} is not a valid amount`);
    else if (field.kind === 'number' && !/^\d+(\.\d{1,2})?$/.test(value)) invalid.push(`${field.label} is not a valid number`);
    else if (field.kind === 'integer' && !/^\d+$/.test(value)) invalid.push(`${field.label} must be a whole number`);
  }
  if (invalid.length) add('format', 'Values are valid', 'fail', `${invalid.join('; ')}.`);
  else add('format', 'Values are valid', 'pass', 'Dates, amounts and numbers are readable and valid.');
}

function checkAuthenticity(definition, authenticity, confidence, add) {
  const { score, verdict, issues } = authenticity;
  const issueText = issues.length ? ` Issues: ${issues.join('; ')}.` : '';
  if (verdict === 'fake' || (score !== null && score < 50)) add('authenticity', 'Document authenticity', 'fail', `AI judged this document as likely not genuine${score !== null ? ` (${score}/100)` : ''}.${issueText}`);
  else if (verdict === 'unknown' || score === null) add('authenticity', 'Document authenticity', 'warn', 'AI did not return an authenticity assessment. Compare the data with the paper form.');
  else if (verdict === 'suspicious' || score < 80) add('authenticity', 'Document authenticity', 'warn', `AI found possible problems (${score}/100).${issueText}`);
  else add('authenticity', 'Document authenticity', 'pass', `AI judged the document genuine (${score}/100).${issueText}`);

  if (authenticity.filledIn === false) add('filled', 'Form is filled in', 'fail', 'The form appears to be blank or a sample template.');
  if (authenticity.physicalDocument === false) add('physical', 'Original paper form', 'warn', 'This looks like a screen photo, screenshot or digitally made image rather than the paper form.');
  if (definition.signatureExpected && authenticity.signaturePresent === false) add('signature', 'Signature', 'warn', 'No signature was detected on the form.');
  else if (definition.signatureExpected && authenticity.signaturePresent) add('signature', 'Signature', 'pass', 'A signature is present.');

  if (confidence === null || confidence < 85) add('confidence', 'Reading confidence', 'warn', `AI reading confidence is ${confidence === null ? 'unknown' : `${confidence}%`}. Compare each field with the paper form.`);
  else add('confidence', 'Reading confidence', 'pass', `AI read the form with ${confidence}% confidence.`);
}

async function checkRecords(db, documentType, data, add) {
  if (documentType === 'Membership Form') {
    const duplicate = (await db.query(
      `SELECT member_number FROM members
       WHERE ($1 <> '' AND LOWER(email) = LOWER($1))
          OR ($2 <> '' AND LOWER(TRIM(rsbsa_no)) = LOWER(TRIM($2)))
          OR ($3 <> '' AND date_of_birth = NULLIF($3, '')::date AND LOWER(first_name) = LOWER($4) AND LOWER(last_name) = LOWER($5))
       LIMIT 1`,
      [data.email || '', data.rsbsaNo || '', isValidDateOnly(data.dateOfBirth) ? data.dateOfBirth : '', data.firstName || '', data.lastName || '']
    )).rows[0];
    if (duplicate) add('records', 'Not already registered', 'fail', `This applicant appears to be already registered as ${duplicate.member_number}.`);
    else add('records', 'Not already registered', 'pass', 'No existing member has the same email, RSBSA number, or name and birth date.');
    return {};
  }

  if (documentType === 'Kadiwa Sales Form') {
    const sales = ['groceriesPrice', 'vegetablesPrice', 'meatPrice'].map((key) => moneyCents(data[key]));
    const expenses = moneyCents(data.totalExpenses);
    if ([...sales, expenses].some((value) => value === null)) return {};
    const gross = sales.reduce((sum, value) => sum + value, 0);
    if (gross === 0) add('totals', 'Sales totals', 'fail', 'No sales amount was read from the form.');
    else if (data.netSales && moneyCents(data.netSales) !== null && Math.abs(moneyCents(data.netSales) - (gross - expenses)) > 100) {
      add('totals', 'Sales totals', 'fail', `The net sales written on the form (PHP ${data.netSales}) does not equal sales minus expenses (PHP ${((gross - expenses) / 100).toFixed(2)}).`);
    } else add('totals', 'Sales totals', 'pass', data.netSales ? 'Category sales minus expenses equal the net sales on the form.' : 'Sales amounts are valid (no net total on the form to cross-check).');
    return {};
  }

  const requireActive = documentType !== 'Savings Form';
  const { member, check } = await findMember(db, data, { requireActive });
  add('member', 'Member on record', check[0], check[1]);
  const target = { memberId: member?.id ? Number(member.id) : null };

  if (documentType === 'Machinery Form') {
    const { machine, partial, error } = await findMachine(db, data.machinery);
    if (error) add('machinery', 'Machinery on record', 'fail', error);
    else if (partial) add('machinery', 'Machinery on record', 'warn', `"${data.machinery}" was matched to ${machine.name} (${machine.id}).`);
    else add('machinery', 'Machinery on record', 'pass', `${machine.name} (${machine.id}) found.`);
    if (machine) target.machineryId = machine.id;
    if (isValidDateOnly(data.startDate) && data.startDate < todayDateOnly()) add('dates', 'Booking dates', 'fail', 'The rental start date has already passed.');
    else if (isValidDateOnly(data.startDate) && isValidDateOnly(data.endDate) && data.endDate < data.startDate) add('dates', 'Booking dates', 'fail', 'The end date is before the start date.');
  }
  return target;
}

async function findPostedTwin(db, scanId, documentType, data) {
  const keys = FINGERPRINT_KEYS[documentType] || [];
  const fingerprint = Object.fromEntries(keys.filter((key) => data[key]).map((key) => [key, data[key]]));
  if (Object.keys(fingerprint).length < 2) return null;
  return (await db.query(
    `SELECT id, posted_module, posted_record_id FROM document_scans
     WHERE id <> $1 AND posted_at IS NOT NULL AND detected_document_type = $2 AND extracted_data @> $3::jsonb LIMIT 1`,
    [scanId, documentType, JSON.stringify(fingerprint)]
  )).rows[0] || null;
}

class RehearsalRollback extends Error {}

// Returns { status: passed|warning|failed, canPost, checks[], target, checkedAt }.
export async function verifyDocument(req, scan, { documentType, extractedData, authenticity, confidence }) {
  const definition = FORM_DEFINITIONS[documentType];
  const checks = [];
  const add = (id, label, status, message) => checks.push({ id, label, status, message });
  if (!definition) {
    add('type', 'Document type', documentType === UNRECOGNIZED ? 'fail' : 'warn', documentType === UNRECOGNIZED
      ? 'The document type was not recognised. Choose the correct form type.'
      : `${documentType} documents are kept for reference and are not posted to a module.`);
    return { status: documentType === UNRECOGNIZED ? 'failed' : 'warning', canPost: false, checks, target: {}, checkedAt: new Date().toISOString() };
  }

  checkAuthenticity(definition, authenticity, confidence, add);
  checkFields(definition, extractedData, add);
  const target = await checkRecords({ query }, documentType, extractedData, add);

  const twin = await findPostedTwin({ query }, scan.id, documentType, extractedData);
  if (twin) add('duplicate', 'Not already posted', 'fail', `The same form data was already posted from scan #${twin.id} (${twin.posted_module} ${twin.posted_record_id}).`);
  else add('duplicate', 'Not already posted', 'pass', 'No other scan posted the same form.');

  // Rehearse the real save with the module's own rules, then roll it back.
  if (!checks.some((check) => check.status === 'fail')) {
    try {
      await withTransaction(async (client) => {
        await saveToModule(client, req, scan, documentType, extractedData, target);
        throw new RehearsalRollback();
      });
    } catch (error) {
      if (!(error instanceof RehearsalRollback)) {
        const httpError = toHttpError(error);
        if (httpError.status >= 500) throw error;
        add('rules', `${definition.moduleLabel} rules`, 'fail', httpError.message);
      }
    }
    if (!checks.some((check) => check.id === 'rules')) add('rules', `${definition.moduleLabel} rules`, 'pass', `The record passes every ${definition.moduleLabel} rule.`);
  }

  const status = checks.some((check) => check.status === 'fail') ? 'failed' : checks.some((check) => check.status === 'warn') ? 'warning' : 'passed';
  return { status, canPost: status !== 'failed', checks, target, checkedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Posting.

const LOAN_TYPE_WORDS = [['agri', 'agricultural'], ['farm', 'agricultural'], ['crop', 'agricultural'], ['personal', 'personal'], ['emergency', 'emergency']];

function loanTypeOf(value) {
  const text = String(value || '').toLowerCase();
  return LOAN_TYPE_WORDS.find(([word]) => text.includes(word))?.[1] || text;
}

function loanModeOf(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return 'cash';
  if (text.includes('combin') || (text.includes('cash') && text.includes('kind'))) return 'combination';
  if (text.includes('kind')) return 'in-kind';
  return text.includes('cash') ? 'cash' : text;
}

function savingsMethodOf(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 'Deposit';
  return SAVINGS_METHODS.find((method) => method.toLowerCase() === text) || (text.includes('gcash') ? 'GCash' : text.includes('bank') ? 'Bank Transfer' : text.includes('check') || text.includes('cheque') ? 'Check' : text.includes('cash') ? 'Cash' : 'Other');
}

// Writes the document's record through the module's own insert function, in
// the caller's transaction. Returns { module, recordId, label }.
async function saveToModule(client, req, scan, documentType, data, target) {
  if (documentType === 'Membership Form') {
    const body = {
      first_name: data.firstName, middle_name: data.middleName, last_name: data.lastName, suffix: data.suffix, email: data.email, phone: data.phone,
      address: data.address, barangay: data.barangay, municipality: data.municipality, province: data.province, date_of_birth: data.dateOfBirth || undefined,
      gender: data.gender, civil_status: data.civilStatus, rsbsa_no: data.rsbsaNo, livelihood: data.livelihood, farm_area_ha: data.farmAreaHa,
      membership_date: data.membershipDate, share_capital: data.shareCapital, status: 'active',
    };
    const { errors, values } = validateMemberInput(body);
    const shareCapitalCents = parseShareCapital(body, errors);
    if (errors.length) throw badRequest(errors[0], errors);
    // The scanned membership form is kept as the member's supporting document.
    const { id, memberNumber } = await insertMemberRecord(client, req, {
      body, values, shareCapitalCents, source: 'ocr', idDocumentRef: scan.stored_file_path,
      idDocument: { originalname: scan.original_file_name, mimetype: scan.mime_type, size: Number(scan.file_size) },
    });
    return { module: 'members', recordId: memberNumber, databaseId: Number(id), label: `Member ${memberNumber} registered` };
  }

  if (documentType === 'Loan Form') {
    const member = (await client.query(memberApplicationSelect, [target.memberId])).rows[0];
    if (!member) throw badRequest('The member must be active to apply for a loan.');
    const application = await prepareApplication(client, {
      loanType: loanTypeOf(data.loanType), purpose: data.purpose, loanMode: loanModeOf(data.loanMode), term: data.term, amount: data.amount,
      farmArea: data.farmArea || undefined, borrowerPhone: data.borrowerPhone, borrowerAddress: data.borrowerAddress,
      coMakerName: data.coMakerName, coMakerAddress: data.coMakerAddress, coMakerContact: data.coMakerContact, coMakerRelationship: data.coMakerRelationship,
      collateralType: data.collateralType, collateralDetails: data.collateralDetails,
    }, member);
    const request = await insertLoanRequest(client, req, { member, application, income: data.monthlyIncome || '0', submittedBy: 'admin' });
    return { module: 'loans', recordId: String(request.id), label: `Loan application #${request.id} submitted for approval` };
  }

  if (documentType === 'Savings Form') {
    const amountCents = parseMoneyInput(data.amount);
    if (amountCents === null) throw badRequest('Deposit amount must be greater than zero with at most two decimals.');
    const result = await insertSavingsDeposit(client, req, {
      memberId: target.memberId, amountCents, date: data.date, paymentMethod: savingsMethodOf(data.paymentMethod),
      reference: data.referenceNumber || null, notes: [data.notes, `Recorded from scanned savings form #${scan.id}.`].filter(Boolean).join(' ').slice(0, 1000),
    });
    return { module: 'savings', recordId: String(result.record.id), label: `Savings deposit #${result.record.id} recorded` };
  }

  if (documentType === 'Machinery Form') {
    const request = await insertRentalRequest(client, req, {
      machineryId: target.machineryId, memberId: target.memberId, purpose: data.purpose,
      notes: [data.notes, `From scanned machinery form #${scan.id}.`].filter(Boolean).join(' ').slice(0, 1000), startDate: data.startDate, endDate: data.endDate,
    });
    return { module: 'machinery', recordId: String(request.id), label: `Rental request #${request.id} submitted for approval` };
  }

  if (documentType === 'Kadiwa Sales Form') {
    const manual = { Groceries: moneyCents(data.groceriesPrice), Vegetables: moneyCents(data.vegetablesPrice), Meat: moneyCents(data.meatPrice) };
    const expensesCents = moneyCents(data.totalExpenses);
    if ([...Object.values(manual), expensesCents].some((value) => value === null)) throw badRequest('Sales amounts must be non-negative with at most two decimals.');
    const saleId = await insertKadiwaSale(client, req, { encoderName: String(data.encoderName || '').slice(0, 200), manual, expensesCents, items: [] });
    return { module: 'kadiwa', recordId: saleId, label: `Kadiwa sale ${saleId} recorded` };
  }

  throw badRequest(`${documentType} documents are not posted to a module.`);
}

export async function postDocument(client, req, scan, documentType, data, target) {
  return saveToModule(client, req, scan, documentType, data, target);
}
