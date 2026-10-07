import { query, withTransaction } from '../config/db.js';
import { isValidDateOnly, todayDateOnly } from '../utils/dates.js';
import { badRequest, toHttpError } from '../utils/http.js';
import { parseMoneyInput } from '../utils/money.js';
import { insertMemberRecord, nextMemberNumber, parseShareCapital, SAVINGS_METHODS, insertSavingsDeposit, validateMemberInput } from '../controllers/memberController.js';
import { insertLoanRequest, memberApplicationSelect, prepareApplication } from '../controllers/loanController.js';
import { insertRentalRequest } from '../controllers/machineryController.js';
import { insertKadiwaSale } from '../controllers/kadiwaController.js';
import { loanApplicationReceivedEmail, rentalRequestReceivedEmail, savingsDepositEmail, welcomeMemberEmail } from './emailTemplates.js';

// Scanned cooperative forms: what each one contains, how the AI must report
// it, how it is checked against the database, and where it is saved.
//
// Flow: AI reads the form -> fields are normalised -> authenticity + database
// checks run -> the save is rehearsed in a rolled-back transaction -> the form
// is posted to its module (automatically when every check passes, otherwise
// after an admin reviews it).

export const UNRECOGNIZED = 'Document Type Not Recognized';

const f = (key, label, options = {}) => ({ key, label, kind: 'text', required: false, ...options });

// Rows of the in-kind farm inputs table on the paper loan form.
const LOAN_INPUT_ROWS = [
  ['fertilizer', 'Fertilizer'], ['pesticides', 'Pesticides'], ['herbicides', 'Herbicides'],
  ['insecticides', 'Insecticides'], ['seeds', 'Seeds'], ['plantChemicals', 'Plant Chemicals for Spray'],
];
// Loan term used when the paper form (which has no term) is posted.
const DEFAULT_LOAN_TERM = '12';
// Rows of the children and source-of-income tables on the paper membership form.
const CHILD_ROWS = [1, 2, 3];
const INCOME_ROWS = [1, 2];
// The paper membership form is the associate member form.
const DEFAULT_MEMBERSHIP_TYPE = 'Associate';
// Specimen signatures required on a back-to-back copy of a valid ID.
export const REQUIRED_ID_SIGNATURES = 3;

// Where each valid ID submitted with a scanned form is kept on document_scans:
// holder = the membership applicant or the loan borrower; coMaker = the loan co-maker.
export const ID_SLOTS = {
  holder: { path: 'id_document_path', name: 'id_document_name', type: 'id_document_type', size: 'id_document_size', source: 'id_document_source', check: 'id_document_check' },
  coMaker: { path: 'co_maker_id_path', name: 'co_maker_id_name', type: 'co_maker_id_type', size: 'co_maker_id_size', source: 'co_maker_id_source', check: 'co_maker_id_check' },
};

export const FORM_DEFINITIONS = {
  'Membership Form': {
    module: 'members', moduleLabel: 'Membership Management', formName: 'membership form', signatureExpected: true, photoExpected: true,
    // The applicant's ID: a back-to-back copy with the specimen signatures, or
    // the ID card itself captured with the live camera (cardCapture).
    idDocuments: [{ slot: 'holder', person: 'applicant', cardCapture: true, checkId: 'idDocument', matchId: 'idMatch' }],
    description: 'ACIFAC associate membership form (one page): name, birthday, age, civil status, gender, CP no., educational attainment, ID type and number, RSBSA no., farm area, permanent address, family members (spouse, mother\'s maiden name, children), sources of income, membership acceptance / separation, the applicant signature, and the "For Cooperative" certification section.',
    notes: 'Ignore the MEMBERSHIP NO. box at the top: the system gives the membership number. The form has no email; use "" for email unless one is written on it. phone is the CP #. address is only the house, street, sitio or purok written with the permanent address; barangay, municipality and province have their own keys. Mother\'s maiden name goes in motherLastName, motherFirstName and motherMiddleName. Children rows: child1Name/child1Age to child3Name/child3Age. Income rows: income1Source/income1Amount and income2Source/income2Amount (annual income). From the ACCEPTANCE row: membershipDate (its date), bodResolution and membershipType; from the SEPARATION row only separationDate. From FOR COOPERATIVE: membershipFee and dateReceived; the OR no. and certified-by name of the pre-membership education seminar (seminarOrNo, seminarCertifiedBy), the payment of membership fee (membershipFeeOrNo, feeCertifiedBy) and the initial paid-up capital (paidUpCapitalOrNo, capitalCertifiedBy); and shareCapital only when an initial paid-up capital amount is written.',
    fields: [
      f('lastName', 'Last Name', { required: true }), f('firstName', 'First Name', { required: true }), f('middleName', 'Middle Name'), f('suffix', 'Suffix (Jr., Sr., III)'),
      f('dateOfBirth', 'Birthday', { kind: 'date', required: true }), f('age', 'Age', { kind: 'integer' }), f('civilStatus', 'Civil Status'), f('gender', 'Gender'),
      f('phone', 'CP No.', { required: true }), f('email', 'Email (not on the paper form)', { required: true, typedIn: true }),
      f('education', 'Highest Educational Attainment'), f('idType', 'ID Type'), f('idNumber', 'ID No.'),
      f('rsbsaNo', 'RSBSA No.'), f('farmAreaHa', 'Farm Area (ha)', { kind: 'number' }),
      f('address', 'Permanent Address (house, street, sitio or purok)'),
      f('barangay', 'Barangay', { required: true }), f('municipality', 'Municipality', { required: true }), f('province', 'Province', { required: true }),
      f('spouseName', 'Spouse Name'), f('spouseAge', 'Spouse Age', { kind: 'integer' }), f('spouseContact', 'Spouse Contact No.'),
      f('motherLastName', 'Mother\'s Maiden Name - Last Name'), f('motherFirstName', 'Mother\'s Maiden Name - First Name'), f('motherMiddleName', 'Mother\'s Maiden Name - Middle Name'),
      ...CHILD_ROWS.flatMap((row) => [f(`child${row}Name`, `Child ${row} - Name`), f(`child${row}Age`, `Child ${row} - Age`, { kind: 'integer' })]),
      ...INCOME_ROWS.flatMap((row) => [f(`income${row}Source`, `Source of Income ${row}`), f(`income${row}Amount`, `Source of Income ${row} - Annual Income`, { kind: 'money' })]),
      f('membershipDate', 'Acceptance Date (today if blank)', { kind: 'date' }), f('bodResolution', 'Acceptance B.O.D. Resolution'),
      f('membershipType', `Type of Membership (${DEFAULT_MEMBERSHIP_TYPE} if blank)`), f('separationDate', 'Separation Date', { kind: 'date' }),
      f('membershipFee', 'Membership Fee', { kind: 'money' }), f('dateReceived', 'Date Received', { kind: 'date' }),
      f('seminarOrNo', 'Pre-Membership Education Seminar - OR No.'), f('seminarCertifiedBy', 'Pre-Membership Education Seminar - Certified By'),
      f('membershipFeeOrNo', 'Payment of Membership Fee - OR No.'), f('feeCertifiedBy', 'Payment of Membership Fee - Certified By'),
      f('paidUpCapitalOrNo', 'Initial Paid-Up Capital - OR No.'), f('capitalCertifiedBy', 'Initial Paid-Up Capital - Certified By'),
      f('shareCapital', 'Initial Paid-Up Capital (amount)', { kind: 'money' }),
    ],
  },
  'Loan Form': {
    module: 'loans', moduleLabel: 'Loans & Payments (pending approval)', formName: 'loan application form', signatureExpected: true,
    // The borrower's and the co-maker's IDs, each a back-to-back copy with their specimen signatures.
    idDocuments: [
      { slot: 'holder', person: 'borrower', checkId: 'idDocument', matchId: 'idMatch' },
      { slot: 'coMaker', person: 'co-maker', checkId: 'coMakerId', matchId: 'coMakerMatch' },
    ],
    description: 'ACIFAC "Loan Application Form (Agri)" for an agricultural loan, usually two pages: borrower details, farm details, loan mode with the in-kind farm inputs table, cash amount, co-maker, and collateral with the borrower signature.',
    notes: 'For the in-kind table use the keys <row>Description, <row>Quantity, <row>Unit, <row>UnitPrice and <row>Total for the rows fertilizer, pesticides, herbicides, insecticides, seeds and plantChemicals (Plant Chemicals for Spray); leave a row empty when it is not filled. loanMode is the ticked box: cash, in-kind or combination. sex is Male or Female. irrigationType is rainfed, irrigated or other. collateralType is the ticked box: Land Title / Property, Harvest, or Savings Deposit / Share Capital. Ignore the office-use approval section (APPROVED / DISAPPROVED / FOR EVALUATION and approved amounts).',
    fields: [
      f('formNo', 'Form No.'), f('applicationDate', 'Date of Application', { kind: 'date' }),
      f('memberName', 'Borrower Name', { required: true }), f('memberNumber', 'Member No.'),
      f('occupation', 'Occupation'), f('yearsFarming', 'Years of Farming', { kind: 'number' }),
      f('age', 'Age', { kind: 'integer' }), f('civilStatus', 'Civil Status'), f('sex', 'Sex'),
      f('address', 'Address'), f('contactNo', 'Contact No.'), f('email', 'Email'),
      f('farmLocation', 'Farm Location / Sitio & Barangay'), f('farmArea', 'Total Farm Area (hectares)', { kind: 'number' }),
      f('cropsPlanted', 'Crops Planted'), f('cropSeason', 'Crop Season / Year'),
      f('irrigationType', 'Irrigation Type (rainfed, irrigated, other)'), f('irrigationOther', 'Irrigation Other'),
      f('loanMode', 'Loan Mode (cash, in-kind, combination)', { required: true }),
      ...LOAN_INPUT_ROWS.flatMap(([key, label]) => [
        f(`${key}Description`, `${label} - Description`), f(`${key}Quantity`, `${label} - Quantity`, { kind: 'number' }),
        f(`${key}Unit`, `${label} - Unit`), f(`${key}UnitPrice`, `${label} - Unit Price`, { kind: 'money' }),
        f(`${key}Total`, `${label} - Total Amount`, { kind: 'money' }),
      ]),
      f('grandTotal', 'In-Kind Grand Total', { kind: 'money' }), f('cashAmount', 'Cash Amount Requested (Php)', { kind: 'money' }),
      f('coMakerName', 'Co-Maker Name', { required: true }), f('coMakerAddress', 'Co-Maker Address'), f('coMakerContact', 'Co-Maker Contact No.'),
      f('coMakerRelationship', 'Relationship to Borrower'),
      f('collateralType', 'Collateral Offered'), f('collateralDetails', 'Description / Details of Collateral'),
      f('term', 'Loan Term (months) - not on the paper form; 12 if blank', { kind: 'integer' }),
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

// "Borrower's valid ID", "Co-maker's valid ID", "Applicant's valid ID".
export const idLabel = (person) => `${person.charAt(0).toUpperCase()}${person.slice(1)}'s valid ID`;

// The valid IDs a scanned form must come with, in the order they are asked for.
export function idRequirements(documentType) {
  return FORM_DEFINITIONS[documentType]?.idDocuments || [];
}

export function idRequirement(documentType, slot) {
  return idRequirements(documentType).find((requirement) => requirement.slot === slot) || null;
}

// What the admin page needs to ask for each ID.
export function publicIdRequirements(documentType) {
  return idRequirements(documentType).map(({ slot, person, cardCapture }) => ({ slot, person, label: idLabel(person), cardCapture: Boolean(cardCapture) }));
}

export function publicFormDefinitions() {
  return Object.entries(FORM_DEFINITIONS).map(([type, definition]) => ({
    type, module: definition.module, moduleLabel: definition.moduleLabel, description: definition.description,
    requiresIdDocument: requiresIdDocument(type), idDocuments: publicIdRequirements(type), photoExpected: Boolean(definition.photoExpected),
    fields: definition.fields.map(({ key, label, kind, required }) => ({ key, label, kind, required })),
  }));
}

export function requiresIdDocument(documentType) {
  return idRequirements(documentType).length > 0;
}

export function photoExpected(documentType) {
  return Boolean(FORM_DEFINITIONS[documentType]?.photoExpected);
}

export function buildAnalysisPrompt(captureSource) {
  const forms = Object.entries(FORM_DEFINITIONS).map(([type, definition]) => (
    `- "${type}": ${definition.description} extractedData keys: ${definition.fields.map((field) => `${field.key}${field.required ? ' (required)' : ''}`).join(', ')}.${definition.notes ? ` ${definition.notes}` : ''}`
  )).join('\n');
  return `You read paper forms of ACIFAC, an agricultural cooperative in the Philippines. Return JSON only with exactly these fields:
documentType (string), confidence (number 0-100, required), ocrText (string, all readable text), extractedData (object of strings), authenticity (object).

documentType must be one of:
${forms}
- "Payment Receipt", "ID Document", "Cooperative Form": reference documents; extractedData may use any short field names.
- "${UNRECOGNIZED}": anything else, or when confidence is below 70.

A form may span several pages (one PDF or image per page); read every page. Pages may be photographed sideways or upside down; read them in any orientation.
Extraction rules: use exactly the listed keys for the five forms. Copy values as written; never invent, complete or guess a value — use "" when a field is blank, missing or illegible. Dates as YYYY-MM-DD. Money and numbers as plain digits with optional 2 decimals (no currency sign, no commas).

authenticity must be: { "score": number 0-100 (how likely this is a genuine, unaltered, actually filled-in cooperative form), "verdict": "genuine" | "suspicious" | "fake", "physicalDocument": boolean (true if this is a photo or scan of real paper; false for a photo of a screen, a screenshot, or a digitally generated/edited image), "filledIn": boolean (false if the form is blank or only a template/sample), "signaturePresent": boolean, "photoRecognized": boolean or null (Membership Form only: true when a 2x2 ID picture is attached in the photo box at the top right and the person's face is clearly recognizable; false when the box is empty or the face cannot be made out; null for other forms), "issues": [short strings] }.
Look for: altered, overwritten or erased values; mismatched fonts or ink inside a field; pasted or digitally edited areas; totals that do not add up; SAMPLE/SPECIMEN/VOID marks; screen moiré or pixels; missing signatures; a form that is not an ACIFAC/cooperative form. Report every problem found in issues.${captureSource === 'camera' ? '\nThis document was photographed with a phone camera at the office, so normal perspective, shadows and paper texture are expected and are not signs of tampering.' : ''}`;
}

export const ID_READING_INSTRUCTION = 'Read this identification document: its type, number, name, birthday and address, which sides are shown, and the specimen signatures written around it.';

// A valid ID submitted with a scanned form: a back-to-back copy with the
// person's specimen signatures (uploaded, or for a loan form also photographed
// with the camera), or, for a membership applicant, the card itself captured
// with the live camera (front and back joined into one picture).
// requirement: a different one than the form's, such as MEMBER_APPLICANT_ID.
export function buildIdPrompt(source, documentType = 'Membership Form', slot = 'holder', requirement = idRequirement(documentType, slot)) {
  const { person, cardCapture } = requirement || { person: 'applicant', cardCapture: true };
  const formName = FORM_DEFINITIONS[documentType]?.formName || 'cooperative form';
  const copy = source === 'camera'
    ? 'the front and back of the ID on one page, photographed with a phone camera at the cooperative office (perspective and shadows are expected)'
    : 'the front and back of the ID photocopied on one page';
  return `You check the valid ID that ${person === 'applicant' ? 'an applicant' : `the ${person}`} submits with an ACIFAC cooperative ${formName} in the Philippines. Return JSON only with exactly these fields:
isId (boolean: the file shows a valid identification card, e.g. PhilSys National ID, driver's license, UMID, SSS, passport, voter's ID, postal ID, PRC, senior citizen or barangay ID),
idType (string), idNumber (string, as printed), name (string, the full name printed on the ID), dateOfBirth (YYYY-MM-DD, or ""), address (string, the address printed on the ID, or ""),
frontVisible (boolean: the front of the ID is shown), backVisible (boolean: the back of the ID is shown),
photocopy (boolean: a paper photocopy or printout of the ID), physicalCard (boolean: the ID card itself is photographed), screen (boolean: a photo of a screen, a screenshot, or a digitally made or edited image),
signatureCount (integer: handwritten specimen signatures written on the page around the ID copy; do not count the signature printed on the ID card), expired (boolean, or null when there is no expiry date),
issues (array of short strings: problems such as unreadable text, a cut-off side, signs of editing, or a name that differs between the two sides).
Copy values exactly as printed; never guess. Use "" for anything unreadable.
${cardCapture && source === 'camera'
    ? 'This ID was captured with the live camera at the cooperative office: the front of the card, then the back, joined into one picture. Perspective, glare and the background are expected. There are no specimen signatures; report signatureCount 0.'
    : `This should be a back-to-back copy: ${copy}, with the ${person}'s ${REQUIRED_ID_SIGNATURES} specimen signatures written on the page.`}`;
}

// The applicant's 2x2 picture, uploaded when the one on the form cannot be recognised.
export function buildPhotoPrompt() {
  return `You check the 2x2 ID picture that an applicant submits with an ACIFAC cooperative membership form in the Philippines. Return JSON only with exactly these fields:
portrait (boolean: an ID-style picture of one person, head and shoulders), faceVisible (boolean: the face is clear and recognizable, not blurred, covered, cut off or too dark),
screen (boolean: a photo of a screen, a screenshot, or a digitally made or edited image), issues (array of short strings).`;
}

export function normalizePhotoReading(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const bool = (input) => (typeof input === 'boolean' ? input : null);
  return {
    portrait: bool(value.portrait), faceVisible: bool(value.faceVisible), screen: bool(value.screen),
    issues: Array.isArray(value.issues) ? value.issues.map((issue) => String(issue).slice(0, 300)).filter(Boolean).slice(0, 12) : [],
  };
}

export function normalizeIdReading(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const bool = (input) => (typeof input === 'boolean' ? input : null);
  const text = (input, max = 200) => (typeof input === 'string' || typeof input === 'number' ? String(input).trim().slice(0, max) : '');
  const count = typeof value.signatureCount === 'number' || (typeof value.signatureCount === 'string' && value.signatureCount.trim()) ? Number(value.signatureCount) : NaN;
  const dateOfBirth = normalizeDate(text(value.dateOfBirth, 40));
  return {
    isId: bool(value.isId), idType: text(value.idType, 50), idNumber: text(value.idNumber, 100), name: text(value.name),
    dateOfBirth: isValidDateOnly(dateOfBirth) ? dateOfBirth : '', address: text(value.address, 300),
    frontVisible: bool(value.frontVisible), backVisible: bool(value.backVisible),
    photocopy: bool(value.photocopy), physicalCard: bool(value.physicalCard), screen: bool(value.screen),
    signatureCount: Number.isInteger(count) && count >= 0 ? Math.min(count, 20) : null,
    expired: bool(value.expired),
    issues: Array.isArray(value.issues) ? value.issues.map((issue) => String(issue).slice(0, 300)).filter(Boolean).slice(0, 12) : [],
  };
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
    photoRecognized: bool(value.photoRecognized),
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

// Every word of the shorter name is in the other, and a Jr. or Sr. matches too.
const GENERATION_WORDS = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);
function samePerson(a, b) {
  const generation = (name) => nameTokens(name).filter((token) => GENERATION_WORDS.has(token)).sort().join(' ');
  return nameSimilarity(a, b) === 1 && generation(a) === generation(b);
}

// Place words in an address, without the words every address has.
const ADDRESS_FILLER = new Set(['brgy', 'bgy', 'barangay', 'sitio', 'purok', 'prk', 'street', 'blk', 'block', 'lot', 'zone', 'city', 'municipality',
  'mun', 'province', 'prov', 'philippines', 'phils', 'occidental', 'occ', 'oriental', 'mindoro', 'the', 'and']);
const addressWords = (address) => new Set(String(address || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/)
  .filter((word) => word.length >= 3 && !/^\d+$/.test(word) && !ADDRESS_FILLER.has(word)));
function addressesOverlap(a, b) {
  const left = addressWords(a);
  const right = addressWords(b);
  if (!left.size || !right.size) return true;
  return [...left].some((word) => right.has(word));
}

const memberLookupSelect = `SELECT id, member_number, status, date_of_birth, address, id_number, TRIM(CONCAT_WS(' ', first_name, middle_name, last_name, suffix)) AS full_name FROM members`;

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
  'Loan Form': ['memberName', 'formNo', 'applicationDate', 'cashAmount', 'grandTotal', 'loanMode'],
  'Savings Form': ['memberNumber', 'amount', 'date', 'referenceNumber'],
  'Machinery Form': ['memberNumber', 'machinery', 'startDate', 'endDate'],
  'Kadiwa Sales Form': ['encoderName', 'saleDate', 'groceriesPrice', 'vegetablesPrice', 'meatPrice', 'totalExpenses'],
};

const moneyCents = (value) => (value ? parseMoneyInput(value, { allowZero: true }) : 0);

function checkFields(definition, data, add) {
  const missing = definition.fields.filter((field) => field.required && !String(data[field.key] || '').trim());
  const names = (fields) => fields.map((field) => field.label.replace(/\s*\(.*\)$/, '')).join(', ');
  const onForm = missing.filter((field) => !field.typedIn);
  const typedIn = missing.filter((field) => field.typedIn);
  if (missing.length) {
    add('required', 'Required information', 'fail', [onForm.length && `Missing on the form: ${names(onForm)}.`, typedIn.length && `Type in the ${names(typedIn)}; it is not on the paper form.`].filter(Boolean).join(' '));
  } else add('required', 'Required information', 'pass', 'All required fields were read from the form.');

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

// Whole years between a YYYY-MM-DD birthday and today.
function ageOn(dateOfBirth, today = todayDateOnly()) {
  const [birthYear, birthMonth, birthDay] = dateOfBirth.split('-').map(Number);
  const [year, month, day] = today.split('-').map(Number);
  return year - birthYear - (month < birthMonth || (month === birthMonth && day < birthDay) ? 1 : 0);
}

// Who a submitted ID must belong to, from the form (and, for a borrower, the
// member record): names to compare, and details that should agree with the ID.
// holderReading: AI's reading of the borrower's ID, which the co-maker's must not be.
function expectedIdHolder(documentType, requirement, data, member, holderReading) {
  if (documentType === 'Membership Form') {
    const name = [data.firstName, data.middleName, data.lastName, data.suffix].filter(Boolean).join(' ');
    return { names: [['the applicant on the form', name]], dateOfBirth: [data.dateOfBirth, 'the form'], formIdNumber: data.idNumber };
  }
  const borrowerNames = [data.memberName, member?.full_name].filter(Boolean);
  if (requirement.slot === 'coMaker') {
    return {
      names: [['the co-maker on the form', data.coMakerName]], address: data.coMakerAddress,
      notBorrower: { names: borrowerNames, idNumber: holderReading?.idNumber || '' },
    };
  }
  const names = [['the borrower on the form', data.memberName]];
  if (member && compact(member.full_name) !== compact(data.memberName || '')) names.push([`the member on record (${member.member_number})`, member.full_name]);
  return { names, dateOfBirth: [member?.date_of_birth || '', 'the member record'], age: data.age, address: data.address || member?.address, recordIdNumber: member?.id_number };
}

// A valid ID submitted with a scanned form: a back-to-back copy (front and back
// of the ID on one page) with three specimen signatures, or, for a membership
// applicant, the ID card captured with the live camera. Then: does the ID
// belong to that person on the form?
// submitted: { reading, source } of the ID, or null when it was not submitted.
function checkIdDocument(submitted, requirement, expected, add) {
  const label = idLabel(requirement.person);
  const whose = `${requirement.person}'s`;
  if (!submitted) {
    add(requirement.checkId, label, 'fail', requirement.cardCapture
      ? `Submit the ${whose} valid ID: upload a back-to-back copy with ${REQUIRED_ID_SIGNATURES} specimen signatures, or capture the ID with the live camera.`
      : `Submit the ${whose} valid ID: a back-to-back copy (front and back of the ID on one page) with ${REQUIRED_ID_SIGNATURES} specimen signatures, uploaded or taken with the camera.`);
    return;
  }
  const reading = submitted.reading || {};
  const camera = Boolean(requirement.cardCapture) && submitted.source === 'camera';
  const idName = reading.idType || 'ID';
  if (reading.error) {
    add(requirement.checkId, label, 'warn', `AI could not read the ID (${reading.error}). Open it and check it yourself${camera ? '' : `: front and back on one page with ${REQUIRED_ID_SIGNATURES} specimen signatures`}, or submit it again.`);
    return;
  }

  const problems = [];
  const concerns = [];
  if (reading.isId === false) problems.push('the file does not show an identification card');
  else if (camera) {
    if (reading.screen) problems.push('it is a picture of a screen, not the ID card');
    else if (reading.photocopy) concerns.push('it looks like a photocopy rather than the ID card itself');
    if (reading.frontVisible === false) problems.push('the front of the ID is not visible');
    if (reading.backVisible === false) concerns.push('the back of the ID is not visible');
  } else {
    if (reading.frontVisible === false || reading.backVisible === false) problems.push('the copy must show both the front and the back of the ID');
    if (reading.signatureCount === null) concerns.push('the specimen signatures could not be counted');
    else if (reading.signatureCount < REQUIRED_ID_SIGNATURES) problems.push(`it has ${reading.signatureCount} specimen signature${reading.signatureCount === 1 ? '' : 's'}; ${REQUIRED_ID_SIGNATURES} are required`);
    if (reading.screen) concerns.push('it looks like a screen picture or edited image rather than the signed paper copy');
  }
  if (reading.isId === null) concerns.push('AI could not confirm that it is an ID');
  if (reading.expired === true) concerns.push('the ID is expired');
  const issues = reading.issues?.length ? ` AI noted: ${reading.issues.join('; ')}.` : '';
  const sentence = (list) => `${list.join('; ').replace(/^./, (letter) => letter.toUpperCase())}.`;
  const again = requirement.cardCapture
    ? `${camera ? 'Capture the ID card again' : `Upload a back-to-back copy with ${REQUIRED_ID_SIGNATURES} specimen signatures`}, or use the other option.`
    : `Submit a back-to-back copy with the ${whose} ${REQUIRED_ID_SIGNATURES} specimen signatures.`;
  if (problems.length) add(requirement.checkId, label, 'fail', `${sentence(problems)} ${again}${issues}`);
  else if (concerns.length) add(requirement.checkId, label, 'warn', `${sentence(concerns)} Compare the ID with the ${requirement.person}.${issues}`);
  else if (camera) add(requirement.checkId, label, 'pass', `${idName} captured with the live camera; the front${reading.backVisible ? ' and back are' : ' is'} visible.${issues}`);
  else add(requirement.checkId, label, 'pass', `Back-to-back copy of the ${idName} with ${reading.signatureCount} specimen signatures.${issues}`);
  checkIdMatch(requirement, reading, expected, add);
}

// The verification checks about each ID: the ID itself, and whether it is the person's.
export const ID_CHECK_IDS = Object.fromEntries(Object.values(FORM_DEFINITIONS).flatMap((definition) => definition.idDocuments || [])
  .map((requirement) => [requirement.slot, [requirement.checkId, requirement.matchId]]));

// The borrower's and co-maker's IDs of a loan application typed into the app,
// checked like those of a scanned loan form. ids: { holder, coMaker }, each
// { reading, source } or null; data: memberName, address, age, coMakerName and
// coMakerAddress as on the loan form; member: the borrower's member record.
export function checkLoanIds(ids, data, member) {
  const checks = [];
  const add = (id, label, status, message) => checks.push({ id, label, status, message });
  if (data.coMakerName && member && samePerson(data.coMakerName, member.full_name)) add('coMaker', 'Co-maker', 'fail', `The co-maker (${data.coMakerName}) is the borrower; the co-maker must be another person.`);
  for (const requirement of idRequirements('Loan Form')) {
    checkIdDocument(ids[requirement.slot] || null, requirement, expectedIdHolder('Loan Form', requirement, data, member, ids.holder?.reading), add);
  }
  return checks;
}

// The applicant's valid ID in Add Member and Edit Member: like the co-maker's
// on a loan form, only a back-to-back copy with the 3 specimen signatures,
// uploaded or photographed (no live capture of the card itself).
export const MEMBER_APPLICANT_ID = { slot: 'holder', person: 'applicant', cardCapture: false, checkId: 'idDocument', matchId: 'idMatch' };

// submitted: { reading, source } of the applicant's ID, or null; data:
// firstName, middleName, lastName, suffix, dateOfBirth and idNumber as on the form.
export function checkMemberId(submitted, data) {
  const checks = [];
  const add = (id, label, status, message) => checks.push({ id, label, status, message });
  checkIdDocument(submitted, MEMBER_APPLICANT_ID, expectedIdHolder('Membership Form', MEMBER_APPLICANT_ID, data), add);
  return checks;
}

// AI's reading of the ID against the person on the form: the name, and the
// birthday, age, ID No. and address where the form or the record has them.
function checkIdMatch(requirement, reading, expected, add) {
  const mismatches = [];
  if (!reading.name) mismatches.push(['warn', 'The name on the ID could not be read']);
  for (const [who, name] of expected.names) {
    if (!reading.name) break;
    if (!String(name || '').trim()) { mismatches.push(['warn', `There is no name for ${who} to compare with the ID`]); continue; }
    const similarity = nameSimilarity(reading.name, name);
    if (similarity < 0.5) mismatches.push(['fail', `The name on the ID ("${reading.name}") is not ${who} (${name})`]);
    else if (similarity < 1) mismatches.push(['warn', `The name on the ID ("${reading.name}") only partly matches ${who} (${name})`]);
  }
  if (expected.notBorrower) {
    const borrower = expected.notBorrower.names.find((name) => reading.name && samePerson(reading.name, name));
    if (borrower) mismatches.push(['fail', `This ID is in the borrower's name (${borrower}); the co-maker must be another person`]);
    else if (reading.idNumber && expected.notBorrower.idNumber && compact(reading.idNumber) === compact(expected.notBorrower.idNumber)) mismatches.push(['fail', `This ID has the same ID No. as the borrower's ID (${reading.idNumber})`]);
  }
  if (reading.idNumber && expected.formIdNumber && compact(reading.idNumber) !== compact(expected.formIdNumber)) mismatches.push(['warn', `The ID No. on the form (${expected.formIdNumber}) differs from the ID (${reading.idNumber})`]);
  const [dateOfBirth, dateSource] = expected.dateOfBirth || [];
  if (reading.dateOfBirth && isValidDateOnly(dateOfBirth) && reading.dateOfBirth !== dateOfBirth) mismatches.push(['warn', `The birthday on the ID (${reading.dateOfBirth}) differs from ${dateSource} (${dateOfBirth})`]);
  const age = String(expected.age || '').trim();
  if (reading.dateOfBirth && /^\d+$/.test(age) && Math.abs(ageOn(reading.dateOfBirth) - Number(age)) > 1) mismatches.push(['warn', `The form says age ${age}, but the birthday on the ID (${reading.dateOfBirth}) makes the ${requirement.person} ${ageOn(reading.dateOfBirth)}`]);
  if (reading.address && expected.address && !addressesOverlap(reading.address, expected.address)) mismatches.push(['warn', `The address on the ID (${reading.address}) does not match the address on the form (${expected.address})`]);

  const label = `ID belongs to the ${requirement.person}`;
  if (mismatches.length) {
    add(requirement.matchId, label, mismatches.some(([status]) => status === 'fail') ? 'fail' : 'warn', `${mismatches.map(([, message]) => message).join('. ')}.`);
    return;
  }
  const onFile = reading.idNumber && expected.recordIdNumber && compact(reading.idNumber) === compact(expected.recordIdNumber) ? ' (the ID on file)' : '';
  const agreed = [isValidDateOnly(dateOfBirth) && reading.dateOfBirth && 'birthday', reading.address && expected.address && 'address'].filter(Boolean);
  add(requirement.matchId, label, 'pass', `The ID is in the name of ${reading.name}${reading.idNumber ? `, ID No. ${reading.idNumber}${onFile}` : ''}${agreed.length ? `; the ${agreed.join(' and ')} ${agreed.length > 1 ? 'match' : 'matches'}` : ''}.`);
}

// The applicant's 2x2 picture: the one in the form's photo box when AI can
// recognise the face in it, otherwise one the admin uploads.
function checkPhoto(scan, authenticity, add) {
  if (scan.photo_path) {
    const reading = scan.photo_check || {};
    const issues = reading.issues?.length ? ` AI noted: ${reading.issues.join('; ')}.` : '';
    if (reading.error) add('photo', '2x2 picture', 'warn', `AI could not check the uploaded 2x2 picture (${reading.error}). Open it and check it yourself, or upload it again.`);
    else if (reading.portrait === false || reading.faceVisible === false) add('photo', '2x2 picture', 'fail', `The uploaded picture does not show the applicant's face clearly.${issues} Upload a clear 2x2 picture.`);
    else if (reading.screen) add('photo', '2x2 picture', 'warn', `The uploaded picture looks like a screen photo or an edited image.${issues}`);
    else if (reading.portrait === null || reading.faceVisible === null) add('photo', '2x2 picture', 'warn', `AI could not confirm that the uploaded picture shows the applicant's face.${issues}`);
    else add('photo', '2x2 picture', 'pass', `2x2 picture uploaded; the face is clear.${issues}`);
    return;
  }
  if (authenticity.photoRecognized === true) add('photo', '2x2 picture', 'pass', 'The 2x2 picture on the form shows the applicant\'s face clearly.');
  else if (authenticity.photoRecognized === false) add('photo', '2x2 picture', 'fail', 'The 2x2 picture on the form cannot be recognized. Upload the applicant\'s 2x2 picture.');
  else add('photo', '2x2 picture', 'warn', 'AI could not tell whether the form has a clear 2x2 picture. Check the form, or upload the applicant\'s 2x2 picture.');
}

const pesoText = (cents) => `PHP ${(cents / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

// In-kind rows with anything written in them, with their line totals.
function loanInputLines(data) {
  return LOAN_INPUT_ROWS.map(([key, label]) => {
    const quantity = String(data[`${key}Quantity`] || '').trim();
    const unitPrice = String(data[`${key}UnitPrice`] || '').trim();
    const written = moneyCents(data[`${key}Total`]);
    const computed = /^\d+(\.\d{1,2})?$/.test(quantity) && moneyCents(unitPrice) !== null ? Math.round(Number(quantity) * moneyCents(unitPrice)) : null;
    const filled = [data[`${key}Description`], quantity, data[`${key}Unit`], unitPrice, data[`${key}Total`]].some((value) => String(value || '').trim());
    return { key, label, quantity, unitPrice, unit: String(data[`${key}Unit`] || '').trim(), description: String(data[`${key}Description`] || '').trim(), written, computed, filled };
  }).filter((line) => line.filled);
}

function loanAmounts(data) {
  const lines = loanInputLines(data);
  const inKindCents = lines.reduce((sum, line) => sum + (line.computed ?? line.written ?? 0), 0);
  const cashCents = moneyCents(data.cashAmount) || 0;
  return { lines, inKindCents, cashCents };
}

// Amount requested and the in-kind table must add up on the paper form.
function checkLoanAmounts(data, add) {
  const mode = loanModeOf(data.loanMode);
  const { lines, inKindCents, cashCents } = loanAmounts(data);
  const problems = [];
  for (const line of lines) {
    if (line.computed !== null && line.written !== null && Math.abs(line.computed - line.written) > 100) {
      problems.push(`${line.label}: ${line.quantity} x ${pesoText(moneyCents(line.unitPrice))} = ${pesoText(line.computed)}, but the form says ${pesoText(line.written)}`);
    }
  }
  const grand = moneyCents(data.grandTotal);
  if (grand && lines.length && Math.abs(grand - inKindCents) > 100) problems.push(`the in-kind rows add up to ${pesoText(inKindCents)}, but the grand total says ${pesoText(grand)}`);
  if (mode !== 'cash' && !lines.length) problems.push('an in-kind or combination loan needs the farm inputs table filled in');
  if (mode !== 'in-kind' && !cashCents) problems.push('no cash amount requested is written on the form');
  if (problems.length) add('amounts', 'Loan amounts', 'fail', `${problems.join('; ')}.`);
  else add('amounts', 'Loan amounts', 'pass', `Requested ${pesoText(cashCents + inKindCents)}${lines.length ? ` (cash ${pesoText(cashCents)} + in-kind ${pesoText(inKindCents)})` : ''}; the table adds up.`);
  if (!String(data.term || '').trim()) add('term', 'Loan term', 'pass', `The paper form has no loan term; the standard ${DEFAULT_LOAN_TERM} months will be used. Change it above if the member agreed another term.`);
}

// `found` receives the member the form is for, for the ID checks that follow.
async function checkRecords(db, documentType, data, add, found = {}) {
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

    const idNumber = compact(data.idNumber || '');
    if (idNumber.length >= 5) {
      const holder = (await db.query(`SELECT member_number FROM members WHERE regexp_replace(LOWER(COALESCE(id_number, '')), '[^a-z0-9]', '', 'g') = $1 LIMIT 1`, [idNumber])).rows[0];
      if (holder) add('idRegistered', 'ID not used by another member', 'fail', `ID No. ${data.idNumber} is already registered to member ${holder.member_number}.`);
    }
    const age = String(data.age || '').trim();
    if (isValidDateOnly(data.dateOfBirth) && /^\d+$/.test(age) && Math.abs(ageOn(data.dateOfBirth) - Number(age)) > 1) {
      add('age', 'Age matches the birthday', 'warn', `The form says age ${age}, but the birthday ${data.dateOfBirth} makes the applicant ${ageOn(data.dateOfBirth)}.`);
    }
    if (!String(data.membershipDate || '').trim()) add('acceptance', 'Acceptance date', 'pass', `The form has no acceptance date yet; today (${todayDateOnly()}) will be the membership date.`);
    // The system gives the membership number; shown so it can be written on the paper form.
    return { memberNumber: await nextMemberNumber(db) };
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

  if (documentType === 'Loan Form') checkLoanAmounts(data, add);

  const requireActive = documentType !== 'Savings Form';
  const { member, check } = await findMember(db, data, { requireActive });
  add('member', 'Member on record', check[0], check[1]);
  found.member = member || null;
  const target = { memberId: member?.id ? Number(member.id) : null };

  if (documentType === 'Loan Form' && data.coMakerName) {
    const borrower = [data.memberName, member?.full_name].find((name) => name && samePerson(data.coMakerName, name));
    if (borrower) add('coMaker', 'Co-maker', 'fail', `The co-maker on the form (${data.coMakerName}) is the borrower (${borrower}); the co-maker must be another person.`);
  }

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
  const found = {};
  const target = await checkRecords({ query }, documentType, extractedData, add, found);
  const submitted = (slot) => (scan[ID_SLOTS[slot].path] ? { reading: scan[ID_SLOTS[slot].check] || {}, source: scan[ID_SLOTS[slot].source] } : null);
  for (const requirement of idRequirements(documentType)) {
    checkIdDocument(submitted(requirement.slot), requirement, expectedIdHolder(documentType, requirement, extractedData, found.member, submitted('holder')?.reading), add);
  }
  if (definition.photoExpected) checkPhoto(scan, authenticity, add);

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

function irrigationOf(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return undefined;
  if (text.includes('rain')) return 'rainfed';
  if (text.includes('irrig')) return 'irrigated';
  return 'other';
}

function collateralOf(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return undefined;
  if (text.includes('land') || text.includes('title') || text.includes('property')) return 'Land Title / Property';
  if (text.includes('harvest')) return 'Harvest';
  if (text.includes('saving') || text.includes('share')) return 'Savings Deposit / Share Capital';
  return String(value).trim();
}

function membershipTypeOf(value) {
  const text = String(value || '').trim();
  if (!text) return DEFAULT_MEMBERSHIP_TYPE;
  return ['Regular', 'Associate', 'Lifetime'].find((type) => text.toLowerCase().startsWith(type.toLowerCase().slice(0, 4))) || text;
}

function savingsMethodOf(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 'Deposit';
  return SAVINGS_METHODS.find((method) => method.toLowerCase() === text) || (text.includes('gcash') ? 'GCash' : text.includes('bank') ? 'Bank Transfer' : text.includes('check') || text.includes('cheque') ? 'Check' : text.includes('cash') ? 'Cash' : 'Other');
}

// Writes the document's record through the module's own insert function, in
// the caller's transaction. Returns { module, recordId, label }.
async function saveToModule(client, req, scan, documentType, data, target) {
  const missingId = idRequirements(documentType).find((requirement) => !scan[ID_SLOTS[requirement.slot].path]);
  if (missingId) throw badRequest(`The ${missingId.person}'s valid ID must be submitted before the ${FORM_DEFINITIONS[documentType].formName} is saved.`);

  if (documentType === 'Membership Form') {
    const children = CHILD_ROWS.map((row) => ({ name: String(data[`child${row}Name`] || '').trim(), age: String(data[`child${row}Age`] || '').trim() })).filter((child) => child.name || child.age);
    const incomeSources = INCOME_ROWS.map((row) => ({ source: String(data[`income${row}Source`] || '').trim(), amount: String(data[`income${row}Amount`] || '').trim() })).filter((income) => income.source || income.amount);
    const incomeCents = incomeSources.reduce((sum, income) => sum + (moneyCents(income.amount) || 0), 0);
    const body = {
      first_name: data.firstName, middle_name: data.middleName, last_name: data.lastName, suffix: data.suffix, email: data.email, phone: data.phone,
      address: [data.address, data.barangay, data.municipality, data.province].filter(Boolean).join(', '),
      barangay: data.barangay, municipality: data.municipality, province: data.province, date_of_birth: data.dateOfBirth || undefined,
      gender: data.gender, civil_status: data.civilStatus, education: data.education, id_type: data.idType, id_number: data.idNumber,
      rsbsa_no: data.rsbsaNo, livelihood: incomeSources[0]?.source, farm_area_ha: data.farmAreaHa, yearly_income: incomeCents ? (incomeCents / 100).toFixed(2) : undefined,
      spouse_name: data.spouseName, spouse_age: data.spouseAge, spouse_contact: data.spouseContact,
      children: children.filter((child) => child.name).map((child) => `${child.name} (${child.age || 'Age not provided'})`).join('; '),
      membership_date: data.membershipDate || todayDateOnly(), share_capital: data.shareCapital, status: 'active',
      additional_info: {
        motherMaidenName: [data.motherFirstName, data.motherMiddleName, data.motherLastName].filter(Boolean).join(' '),
        motherLastName: data.motherLastName, motherFirstName: data.motherFirstName, motherMiddleName: data.motherMiddleName,
        children, incomeSources, membershipType: membershipTypeOf(data.membershipType), separationDate: data.separationDate, bodResolution: data.bodResolution,
        // The For Cooperative certifications, under the keys the Add Member form uses.
        membershipFee: data.membershipFee, dateReceived: data.dateReceived, initialPaidUpCapital: data.shareCapital,
        preMembershipSeminar: data.seminarOrNo || data.seminarCertifiedBy ? 'Yes' : 'No', seminarOrNumber: data.seminarOrNo, seminarCertifiedBy: data.seminarCertifiedBy,
        paymentOfMembershipFee: data.membershipFeeOrNo || data.feeCertifiedBy ? 'Yes' : 'No', orNumber: data.membershipFeeOrNo, feeCertifiedBy: data.feeCertifiedBy,
        capitalOrNumber: data.paidUpCapitalOrNo, capitalCertifiedBy: data.capitalCertifiedBy,
      },
    };
    const { errors, values } = validateMemberInput(body);
    const shareCapitalCents = parseShareCapital(body, errors);
    if (errors.length) throw badRequest(errors[0], errors);
    // The applicant's ID submitted with the scan becomes the member's ID
    // document; the scanned form itself stays in the OCR records.
    // An uploaded 2x2 picture becomes the member's photo.
    const { id, memberNumber } = await insertMemberRecord(client, req, {
      body, values, shareCapitalCents, source: 'ocr', idDocumentRef: scan.id_document_path, photoRef: scan.photo_path || null,
      idDocument: { originalname: scan.id_document_name, mimetype: scan.id_document_type, size: Number(scan.id_document_size) },
    });
    return {
      module: 'members', recordId: memberNumber, databaseId: Number(id), label: `Member ${memberNumber} registered`,
      memberId: Number(id), email: (recipient) => welcomeMemberEmail({ memberName: recipient.full_name, memberNumber, membershipDate: values.membershipDate, fromPaperForm: true }),
    };
  }

  if (documentType === 'Loan Form') {
    const member = (await client.query(memberApplicationSelect, [target.memberId])).rows[0];
    if (!member) throw badRequest('The member must be active to apply for a loan.');
    const { lines, inKindCents, cashCents } = loanAmounts(data);
    const loanMode = loanModeOf(data.loanMode);
    const crops = [data.cropsPlanted, data.cropSeason].filter(Boolean).join(', ');
    const application = await prepareApplication(client, {
      loanType: 'agricultural', loanMode, term: data.term || DEFAULT_LOAN_TERM,
      amount: ((cashCents + inKindCents) / 100).toFixed(2),
      purpose: `Agricultural loan${crops ? ` for ${crops}` : ''} (${loanMode}) from scanned loan form${data.formNo ? ` no. ${data.formNo}` : ''}.`,
      farmArea: data.farmArea || undefined, borrowerPhone: data.contactNo, borrowerEmail: data.email, borrowerAddress: data.address,
      borrowerAge: data.age, borrowerGender: data.sex, borrowerCivilStatus: data.civilStatus, borrowerOccupation: data.occupation,
      yearsFarming: data.yearsFarming || undefined, farmLocation: data.farmLocation, cropsPlanted: data.cropsPlanted, cropSeason: data.cropSeason,
      irrigationType: irrigationOf(data.irrigationType), irrigationOther: data.irrigationOther,
      inKindItems: loanMode === 'cash' ? [] : lines.map((line) => ({ item: line.label, description: line.description, quantity: line.quantity, unit: line.unit, unitPrice: line.unitPrice })),
      coMakerName: data.coMakerName, coMakerAddress: data.coMakerAddress, coMakerContact: data.coMakerContact, coMakerRelationship: data.coMakerRelationship,
      collateralType: collateralOf(data.collateralType), collateralDetails: data.collateralDetails,
    }, member);
    const checks = scan.verification?.checks || [];
    const idDocument = (slot) => (scan[ID_SLOTS[slot].path] ? {
      path: scan[ID_SLOTS[slot].path], fileName: scan[ID_SLOTS[slot].name], mimeType: scan[ID_SLOTS[slot].type], size: Number(scan[ID_SLOTS[slot].size]),
      source: scan[ID_SLOTS[slot].source], reading: scan[ID_SLOTS[slot].check] || {}, checks: checks.filter((check) => ID_CHECK_IDS[slot].includes(check.id)), scanId: Number(scan.id),
    } : null);
    const idDocuments = { borrower: idDocument('holder'), coMaker: idDocument('coMaker') };
    const request = await insertLoanRequest(client, req, { member, application, income: '0', submittedBy: 'admin', idDocuments });
    return {
      module: 'loans', recordId: String(request.id), label: `Loan application #${request.id} submitted for approval`,
      memberId: Number(member.id), email: (recipient) => loanApplicationReceivedEmail({ memberName: recipient.full_name, requestId: request.id, amount: request.amount, loanType: request.loanType, term: request.term, fromPaperForm: true }),
    };
  }

  if (documentType === 'Savings Form') {
    const amountCents = parseMoneyInput(data.amount);
    if (amountCents === null) throw badRequest('Deposit amount must be greater than zero with at most two decimals.');
    const result = await insertSavingsDeposit(client, req, {
      memberId: target.memberId, amountCents, date: data.date, paymentMethod: savingsMethodOf(data.paymentMethod),
      reference: data.referenceNumber || null, notes: [data.notes, `Recorded from scanned savings form #${scan.id}.`].filter(Boolean).join(' ').slice(0, 1000),
    });
    return {
      module: 'savings', recordId: String(result.record.id), label: `Savings deposit #${result.record.id} recorded`,
      memberId: target.memberId, email: (recipient) => savingsDepositEmail({ memberName: recipient.full_name, amount: result.record.amount, date: data.date, reference: data.referenceNumber, total: result.total, fromPaperForm: true }),
    };
  }

  if (documentType === 'Machinery Form') {
    const request = await insertRentalRequest(client, req, {
      machineryId: target.machineryId, memberId: target.memberId, purpose: data.purpose,
      notes: [data.notes, `From scanned machinery form #${scan.id}.`].filter(Boolean).join(' ').slice(0, 1000), startDate: data.startDate, endDate: data.endDate,
    });
    return {
      module: 'machinery', recordId: String(request.id), label: `Rental request #${request.id} submitted for approval`,
      memberId: target.memberId, email: (recipient) => rentalRequestReceivedEmail({ memberName: recipient.full_name, machineryName: request.machineryName, startDate: request.startDate, endDate: request.endDate, rentalFee: request.rentalFee, fromPaperForm: true }),
    };
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
