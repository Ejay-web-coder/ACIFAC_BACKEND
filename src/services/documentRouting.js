import { query, withTransaction } from '../config/db.js';
import { LOAN_POLICY } from './loanService.js';
import { isValidDateOnly, todayDateOnly } from '../utils/dates.js';
import { badRequest, conflict, toHttpError } from '../utils/http.js';
import { parseMoneyInput } from '../utils/money.js';
import { insertMemberRecord, nextMemberNumber, parseShareCapital, SAVINGS_METHODS, insertSavingsDeposit, validateMemberInput } from '../controllers/memberController.js';
import { insertLoanRequest, memberApplicationSelect, prepareApplication } from '../controllers/loanController.js';
import { insertRentalRequest } from '../controllers/machineryController.js';
import { insertInventoryItems, insertKadiwaSale } from '../controllers/kadiwaController.js';
import { goodsForForm, parseExpenseLines, parseGoodsLines } from './kadiwaGoods.js';
import { readInventoryForm, readSalesForm } from './kadiwaFormReading.js';
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
// Every loan is for the policy's 6 months, due in full by the due date.
const DEFAULT_LOAN_TERM = String(LOAN_POLICY.loanTerm);
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

// The line tables of the printed Kadiwa forms (Kadiwa Store > Blank form):
// row n of table `id` is the fields <id><n><Column>, e.g. line3CostPrice.
// Only lines with something written are read, numbered 1, 2, 3... in order.
const table = (id, label, rows, columns) => ({ id, label, rows, columns: columns.map(([key, columnLabel, kind = 'text']) => ({ key, label: columnLabel, kind })) });
const KADIWA_INVENTORY_LINES = table('line', 'Products', 60, [
  ['Product', 'Product'], ['Size', 'Size (e.g. 150 g)'], ['Quantity', 'Quantity', 'number'], ['Unit', 'Counted In'],
  ['SellingPrice', 'Selling Price', 'money'], ['CostPrice', 'Cost Price', 'money'], ['Total', 'Total (Qty x Cost)', 'money'],
]);
const KADIWA_GOODS_LINES = table('good', 'A. Goods Sold', 60, [['Name', 'Goods Sold'], ['Unit', 'Unit'], ['Price', 'Price', 'money'], ['Quantity', 'Quantity', 'number'], ['Amount', 'Total Amount', 'money']]);
const KADIWA_STORE_LINES = table('store', 'B. Store Items Sold', 60, [['Code', 'Code'], ['Product', 'Product'], ['Quantity', 'Quantity Sold', 'number'], ['Amount', 'Amount', 'money']]);
const KADIWA_EXPENSE_LINES = table('expense', 'C. Expenses', 10, [['Description', 'What It Was For'], ['Amount', 'Amount', 'money']]);
const tableFields = (lines) => Array.from({ length: lines.rows }, (_, index) => lines.columns.map((column) => f(`${lines.id}${index + 1}${column.key}`, `${lines.label} ${index + 1} - ${column.label}`, { kind: column.kind, tableCell: true }))).flat();
// The filled-in rows of a table, as { line, <Column>: value }.
const tableRows = (data, lines) => Array.from({ length: lines.rows }, (_, index) => ({
  line: index + 1, ...Object.fromEntries(lines.columns.map((column) => [column.key, String(data[`${lines.id}${index + 1}${column.key}`] || '').trim()])),
})).filter((row) => lines.columns.some((column) => row[column.key]));
const tableKeysText = (lines) => `${lines.columns.map((column) => `${lines.id}<n>${column.key}`).join(', ')} for each filled-in line of "${lines.label}" (n = 1, 2, 3... in order, at most ${lines.rows})`;

export const FORM_DEFINITIONS = {
  'Membership Form': {
    module: 'members', moduleLabel: 'Membership Management', formName: 'membership form', signatureExpected: true, photoExpected: true,
    // The applicant's ID: a back-to-back copy with the specimen signatures, or
    // the ID card itself captured with the live camera (cardCapture).
    idDocuments: [{ slot: 'holder', person: 'applicant', cardCapture: true, checkId: 'idDocument', matchId: 'idMatch' }],
    description: 'ACIFAC associate membership form (one page): name, birthday, age, civil status, gender, CP no., educational attainment, ID type and number, RSBSA no., farm area, permanent address, family members (spouse, mother\'s maiden name, children), sources of income, membership acceptance / separation, the applicant signature, and the "For Cooperative" certification section.',
    notes: 'The printed blank form from Add Member has the form code ACIFAC-MEM at the top right, the same sections numbered I to VI, and an Email line. Ignore the MEMBERSHIP NO. box at the top: the system gives the membership number. Older forms have no email; use "" for email unless one is written on it. phone is the CP #. address is only the house, street, sitio or purok written with the permanent address; barangay, municipality and province have their own keys. Mother\'s maiden name goes in motherLastName, motherFirstName and motherMiddleName. Children rows: child1Name/child1Age to child3Name/child3Age. Income rows: income1Source/income1Amount and income2Source/income2Amount (annual income). From the ACCEPTANCE row: membershipDate (its date), bodResolution and membershipType; from the SEPARATION row only separationDate. From FOR COOPERATIVE: membershipFee and dateReceived; the OR no. and certified-by name of the pre-membership education seminar (seminarOrNo, seminarCertifiedBy), the payment of membership fee (membershipFeeOrNo, feeCertifiedBy) and the initial paid-up capital (paidUpCapitalOrNo, capitalCertifiedBy); and shareCapital only when an initial paid-up capital amount is written.',
    fields: [
      f('lastName', 'Last Name', { required: true }), f('firstName', 'First Name', { required: true }), f('middleName', 'Middle Name'), f('suffix', 'Suffix (Jr., Sr., III)'),
      f('dateOfBirth', 'Birthday', { kind: 'date', required: true }), f('age', 'Age', { kind: 'integer' }), f('civilStatus', 'Civil Status'), f('gender', 'Gender'),
      f('phone', 'CP No.', { kind: 'phone', required: true }), f('email', 'Email (not on the paper form)', { required: true, typedIn: true }),
      f('education', 'Highest Educational Attainment'), f('idType', 'ID Type'), f('idNumber', 'ID No.'),
      f('rsbsaNo', 'RSBSA No.', { kind: 'rsbsa' }), f('farmAreaHa', 'Farm Area (ha)', { kind: 'number' }),
      f('address', 'Permanent Address (house, street, sitio or purok)'),
      f('barangay', 'Barangay', { required: true }), f('municipality', 'Municipality', { required: true }), f('province', 'Province', { required: true }),
      f('spouseName', 'Spouse Name'), f('spouseAge', 'Spouse Age', { kind: 'integer' }), f('spouseContact', 'Spouse Contact No.', { kind: 'phone' }),
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
    notes: 'The printed blank form from New Loan has the form code ACIFAC-LOAN at the top right and sections numbered I to VI; its loan term is printed (6 months, due at end of term), so use "" for term. For the in-kind table use the keys <row>Description, <row>Quantity, <row>Unit, <row>UnitPrice and <row>Total for the rows fertilizer, pesticides, herbicides, insecticides, seeds and plantChemicals (Plant Chemicals for Spray); leave a row empty when it is not filled. loanMode is the ticked box: cash, in-kind or combination. sex is Male or Female. irrigationType is rainfed, irrigated or other. collateralType is the ticked box: Land Title / Property, Harvest, or Savings Deposit / Share Capital. Ignore the office-use approval section (APPROVED / DISAPPROVED / FOR EVALUATION and approved amounts).',
    fields: [
      f('formNo', 'Form No.'), f('applicationDate', 'Date of Application', { kind: 'date' }),
      f('memberName', 'Borrower Name', { required: true }), f('memberNumber', 'Member No.'),
      f('occupation', 'Occupation'), f('yearsFarming', 'Years of Farming', { kind: 'number' }),
      f('age', 'Age', { kind: 'integer' }), f('civilStatus', 'Civil Status'), f('sex', 'Sex'),
      f('address', 'Address'), f('contactNo', 'Contact No.', { kind: 'phone' }), f('email', 'Email'),
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
      f('coMakerName', 'Co-Maker Name', { required: true }), f('coMakerAddress', 'Co-Maker Address'), f('coMakerContact', 'Co-Maker Contact No.', { kind: 'phone' }),
      f('coMakerRelationship', 'Relationship to Borrower'),
      f('collateralType', 'Collateral Offered'), f('collateralDetails', 'Description / Details of Collateral'),
      f('term', `Loan Term (months) - always ${LOAN_POLICY.loanTerm}, due at end of term`, { kind: 'integer' }),
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
  'Add Inventory Form': {
    module: 'kadiwa', moduleLabel: 'Kadiwa Store inventory', signatureExpected: true,
    description: 'ACIFAC Kadiwa Store "ADD INVENTORY FORM" (form code KADIWA-INV printed at the top right): date, low stock at, a ticked category, and numbered lines of product, size, quantity, counted in, selling price, cost price and total, with the TOTAL and the prepared-by signature.',
    notes: 'category is the ticked box: Groceries, Vegetables, Meat or Other. Size as written, e.g. "150 g" or "1.5 L". Unit is what the quantity is counted in (pc, pack, bottle, can, sachet, box or kg). Quantity is the number only. grandTotal is the TOTAL at the bottom of the table. A form may have several pages: number the lines on from page to page.',
    tables: [KADIWA_INVENTORY_LINES],
    fields: [
      f('date', 'Date', { kind: 'date' }), f('preparedBy', 'Prepared By'), f('category', 'Category (Groceries, Vegetables, Meat or Other)'),
      f('lowStockAt', 'Low Stock At', { kind: 'number' }), f('grandTotal', 'TOTAL written on the form', { kind: 'money' }),
      ...tableFields(KADIWA_INVENTORY_LINES),
    ],
  },
  'Kadiwa Daily Sales Form': {
    module: 'kadiwa', moduleLabel: 'Kadiwa Store sales', signatureExpected: true,
    description: 'ACIFAC "DAILY SALES FORM" of the Kadiwa ng Pangulo store (form code KADIWA-SALES printed at the top right): date, prepared by / seller, A. GOODS SOLD (goods printed with unit and price, plus blank lines for other goods), B. STORE ITEMS SOLD (products printed with a code such as INV-0012), C. EXPENSES, and the TOTALS box.',
    notes: 'For goods and store items, only include the lines with a quantity or amount written; a dash or 0 means nothing was sold. Copy the printed name, unit and price of each good (or the price written over it). For store items copy the printed code into store<n>Code. totalGoodsSold, totalExpenses and netIncome are from the TOTALS box. The form usually has two pages.',
    tables: [KADIWA_GOODS_LINES, KADIWA_STORE_LINES, KADIWA_EXPENSE_LINES],
    fields: [
      f('saleDate', 'Date of the Sales', { kind: 'date', required: true }), f('preparedBy', 'Prepared By / Seller'),
      f('totalGoodsSold', 'TOTAL GOODS SOLD written on the form', { kind: 'money' }), f('totalExpenses', 'TOTAL EXPENSES written on the form', { kind: 'money' }),
      f('netIncome', 'NET INCOME written on the form', { kind: 'money' }),
      ...tableFields(KADIWA_GOODS_LINES), ...tableFields(KADIWA_STORE_LINES), ...tableFields(KADIWA_EXPENSE_LINES),
    ],
  },
  // Scans read before the Kadiwa forms were itemized; no longer offered to the AI.
  'Kadiwa Sales Form': {
    module: 'kadiwa', moduleLabel: 'Kadiwa Store sales', signatureExpected: false, legacy: true,
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
    legacy: Boolean(definition.legacy),
    tables: (definition.tables || []).map(({ id, label, rows, columns }) => ({ id, label, rows, columns })),
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
  const keys = (definition) => [
    ...definition.fields.filter((field) => !field.tableCell).map((field) => `${field.key}${field.required ? ' (required)' : ''}`),
    ...(definition.tables || []).map(tableKeysText),
  ].join(', ');
  const forms = Object.entries(FORM_DEFINITIONS).filter(([, definition]) => !definition.legacy).map(([type, definition]) => (
    `- "${type}": ${definition.description} extractedData keys: ${keys(definition)}.${definition.notes ? ` ${definition.notes}` : ''}`
  )).join('\n');
  return `You read paper forms of ACIFAC, an agricultural cooperative in the Philippines. Return JSON only with exactly these fields:
documentType (string), confidence (number 0-100, required), ocrText (string, all readable text), extractedData (object of strings), authenticity (object).

documentType must be one of:
${forms}
- "Payment Receipt", "ID Document", "Cooperative Form": reference documents; extractedData may use any short field names.
- "${UNRECOGNIZED}": anything else, or when confidence is below 70.

A form may span several pages (one PDF or image per page); read every page. Pages may be photographed sideways or upside down; read them in any orientation.
Extraction rules: use exactly the listed keys for these forms. Copy values as written; never invent, complete or guess a value — use "" when a field is blank, missing or illegible. Dates as YYYY-MM-DD. Money and numbers as plain digits with optional 2 decimals (no currency sign, no commas).

authenticity must be: { "score": number 0-100 (how likely this is a genuine, unaltered, actually filled-in cooperative form), "verdict": "genuine" | "suspicious" | "fake", "physicalDocument": boolean (true if this is a photo or scan of real paper; false for a photo of a screen, a screenshot, or a digitally generated/edited image), "filledIn": boolean (false if the form is blank or only a template/sample), "signaturePresent": boolean, "photoRecognized": boolean or null (Membership Form only: true when a 2x2 ID picture is attached in the photo box at the top right and the person's face is clearly recognizable; false when the box is empty or the face cannot be made out; null for other forms), "issues": [short strings] }.
Look for: altered, overwritten or erased values; mismatched fonts or ink inside a field; pasted or digitally edited areas; totals that do not add up; SAMPLE/SPECIMEN/VOID marks; screen moiré or pixels; missing signatures; a form that is not an ACIFAC/cooperative form. Report every problem found in issues.${captureSource === 'camera' ? '\nThis document was photographed with a phone camera at the office, so normal perspective, shadows and paper texture are expected and are not signs of tampering.' : ''}`;
}

// The second, independent reading of a form, asked at the same time as the
// first with different wording and only the fields (no text dump, no
// authenticity), so it is quick. Values both readings agree on are trusted;
// those they disagree on are flagged for the admin (see checkReadingAgreement).
export function buildCrossCheckPrompt() {
  const forms = Object.entries(FORM_DEFINITIONS).filter(([, definition]) => !definition.legacy).map(([type, definition]) => (
    `- "${type}": ${[...definition.fields.filter((field) => !field.tableCell && !field.typedIn).map((field) => field.key), ...(definition.tables || []).map(tableKeysText)].join(', ')}`
  )).join('\n');
  return `You are a careful data-entry clerk for ACIFAC, an agricultural cooperative in the Philippines. Transcribe the handwritten and printed entries of this paper form. Return JSON only: { "documentType": string, "extractedData": object of strings }.
documentType is one of the form names below, or "${UNRECOGNIZED}". Use exactly the keys listed for the form:
${forms}
Copy each entry exactly as written, letter by letter and digit by digit. Use "" for a blank, missing or illegible entry; never guess or complete a value. Dates as YYYY-MM-DD. Money and numbers as digits with optional 2 decimals (no currency sign, no commas). A form may have several pages, photographed in any orientation.`;
}

export const CROSS_CHECK_INSTRUCTION = 'Transcribe every entry of this form into the listed keys.';

export const ID_READING_INSTRUCTION ='Read this identification document: its type, number, name, birthday and address, which sides are shown, and the specimen signatures written around it.';

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

// A Philippine mobile number as 09XXXXXXXXX (from +63 9XX..., 63 9XX..., 9XX...).
export const PH_MOBILE = /^09\d{9}$/;
export function normalizePhone(value) {
  const text = String(value ?? '').trim();
  const digits = text.replace(/\D/g, '');
  if (!/^[+\d\s().-]+$/.test(text)) return text;
  if (/^639\d{9}$/.test(digits)) return `0${digits.slice(2)}`;
  if (/^9\d{9}$/.test(digits)) return `0${digits}`;
  return PH_MOBILE.test(digits) ? digits : text;
}

// RSBSA reference numbers: region-province-municipality-barangay-sequence,
// e.g. 17-51-08-012-000123 (the sequence has 5 or 6 digits).
export const RSBSA_PATTERN = /^\d{2}-\d{2}-\d{2}-\d{3}-\d{5,6}$/;
function normalizeRsbsa(value) {
  const text = String(value ?? '').trim();
  const digits = text.replace(/\D/g, '');
  if (!/^[\d\s.-]+$/.test(text) || (digits.length !== 14 && digits.length !== 15)) return text;
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 9)}-${digits.slice(9)}`;
}

function normalizeValue(field, value) {
  const text = value === null || value === undefined ? '' : String(value).trim().slice(0, 2000);
  if (!text) return '';
  if (field.kind === 'money') return normalizeMoney(text);
  if (field.kind === 'date') return normalizeDate(text);
  if (field.kind === 'phone') return normalizePhone(text);
  if (field.kind === 'rsbsa') return normalizeRsbsa(text);
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
  // Empty cells of a line table are left out: a form has room for far more lines than are written.
  return Object.fromEntries(definition.fields.map((field) => {
    const value = byCompactKey.get(compact(field.key)) ?? (field.tableCell ? undefined : byCompactKey.get(compact(field.label.replace(/\(.*\)/, ''))));
    return [field.key, normalizeValue(field, value)];
  }).filter(([key, value]) => value || !definition.fields.find((field) => field.key === key)?.tableCell));
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

function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length];
}

// 1 for the same text, falling with each letter added, dropped or changed.
export function textSimilarity(a, b) {
  const [left, right] = [String(a), String(b)];
  if (left === right) return 1;
  if (!left || !right) return 0;
  if (left.length > 300 || right.length > 300) return 0;
  return 1 - editDistance(left, right) / Math.max(left.length, right.length);
}

// A name matches when it is at least this similar (0.9 = 90%).
export const NAME_MATCH_MIN = 0.9;
const percent = (score) => `${Math.round(score * 100)}%`;

// How alike two names are, 0 to 1: each word of the shorter name is paired
// with its closest word in the other, so a missing middle name or a letter
// misread by the AI ("Dela Crus") still scores high, and word order is ignored.
export function nameSimilarity(a, b) {
  const left = [...new Set(nameTokens(a))];
  const right = [...new Set(nameTokens(b))];
  if (!left.length || !right.length) return 0;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.reduce((sum, token) => sum + Math.max(...longer.map((other) => textSimilarity(token, other))), 0) / shorter.length;
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
  if (similarity < NAME_MATCH_MIN) return { member, check: ['warn', `The name on the form ("${name}") only partly matches ${member.full_name} (${member.member_number}): ${percent(similarity)} alike, ${percent(NAME_MATCH_MIN)} needed.`] };
  return { member, check: ['pass', `${member.full_name} (${member.member_number}) found and the name matches${similarity < 1 ? ` (${percent(similarity)} alike)` : ''}.`] };
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
  'Add Inventory Form': ['date', 'line1Product', 'line1Quantity', 'line1CostPrice', 'line2Product', 'line2Quantity', 'grandTotal'],
  'Kadiwa Daily Sales Form': ['saleDate', 'preparedBy', 'good1Name', 'good1Amount', 'good2Name', 'good2Amount', 'store1Code', 'store1Quantity', 'totalGoodsSold'],
};

const moneyCents = (value) => (value ? parseMoneyInput(value, { allowZero: true }) : 0);

// One verification check; fields: the form keys it is about, highlighted in the scanner.
const makeCheck = (id, label, status, message, fields) => ({ id, label, status, message, ...(fields?.length ? { fields: [...new Set(fields)] } : {}) });

function checkFields(definition, data, add) {
  const missing = definition.fields.filter((field) => field.required && !String(data[field.key] || '').trim());
  const names = (fields) => fields.map((field) => field.label.replace(/\s*\(.*\)$/, '')).join(', ');
  const onForm = missing.filter((field) => !field.typedIn);
  const typedIn = missing.filter((field) => field.typedIn);
  if (missing.length) {
    add('required', 'Required information', 'fail', [onForm.length && `Missing on the form: ${names(onForm)}.`, typedIn.length && `Type in the ${names(typedIn)}; it is not on the paper form.`].filter(Boolean).join(' '), missing.map((field) => field.key));
  } else add('required', 'Required information', 'pass', 'All required fields were read from the form.');

  // Invalid values fail; a doubtful one (an optional contact number that is
  // not a mobile number, an RSBSA No. not in the usual pattern) is a warning.
  const invalid = [];
  const doubtful = [];
  const today = todayDateOnly();
  for (const field of definition.fields) {
    const value = String(data[field.key] || '').trim();
    if (!value) continue;
    const problem = (list, message) => list.push([field.key, `${field.label.replace(/\s*\(.*\)$/, '')} ${message}`]);
    if (field.kind === 'date' && !isValidDateOnly(value)) problem(invalid, 'is not a valid date');
    else if (field.kind === 'date' && !['startDate', 'endDate'].includes(field.key) && value > today) problem(invalid, 'is in the future');
    else if (field.kind === 'money' && parseMoneyInput(value, { allowZero: true }) === null) problem(invalid, 'is not a valid amount');
    else if (field.kind === 'number' && !/^\d+(\.\d{1,2})?$/.test(value)) problem(invalid, 'is not a valid number');
    else if (field.kind === 'integer' && !/^\d+$/.test(value)) problem(invalid, 'must be a whole number');
    else if (field.kind === 'phone' && !PH_MOBILE.test(value)) problem(field.required ? invalid : doubtful, `"${value}" is not a Philippine mobile number (09XXXXXXXXX)`);
    else if (field.kind === 'rsbsa' && !RSBSA_PATTERN.test(value)) problem(doubtful, `"${value}" does not follow the RSBSA pattern (e.g. 17-51-08-012-000123)`);
  }
  const listed = (list) => `${list.map(([, message]) => message).join('; ')}.`;
  if (invalid.length) add('format', 'Values are valid', 'fail', listed([...invalid, ...doubtful]), [...invalid, ...doubtful].map(([key]) => key));
  else if (doubtful.length) add('format', 'Values are valid', 'warn', listed(doubtful), doubtful.map(([key]) => key));
  else add('format', 'Values are valid', 'pass', 'Dates, amounts, numbers and mobile numbers are readable and valid.');
}

// Both AI readings of the form (see buildCrossCheckPrompt), field by field.
// Numbers must be equal; text may differ only slightly (90% alike, e.g. one
// letter in a long name), ignoring case, spaces and punctuation.
function sameReading(field, a, b) {
  if (!a || !b) return a === b;
  if (['money', 'number', 'integer'].includes(field.kind)) {
    const [x, y] = [Number(a.replace(/,/g, '')), Number(b.replace(/,/g, ''))];
    if (Number.isFinite(x) && Number.isFinite(y)) return Math.abs(x - y) < 0.005;
  }
  if (compact(a) === compact(b)) return true;
  return field.kind === 'text' && textSimilarity(compact(a), compact(b)) >= NAME_MATCH_MIN;
}

export function compareReadings(documentType, first, second) {
  const definition = FORM_DEFINITIONS[documentType];
  if (!definition) return { compared: 0, differing: [] };
  let compared = 0;
  const differing = [];
  for (const field of definition.fields) {
    if (field.typedIn) continue;
    const [a, b] = [String(first?.[field.key] ?? '').trim(), String(second?.[field.key] ?? '').trim()];
    if (!a && !b) continue;
    compared += 1;
    if (!sameReading(field, a, b)) differing.push(field.key);
  }
  return { compared, differing };
}

// The two readings must agree. A value the admin has since corrected counts
// as checked; the others that differ are flagged until the admin looks.
function checkReadingAgreement(definition, documentType, crossCheck, data, add) {
  if (!crossCheck || (!crossCheck.error && !crossCheck.first)) return;
  const label = 'Two AI readings agree';
  if (crossCheck.error) {
    add('agreement', label, 'warn', `The form could not be read a second time to double-check the values (${crossCheck.error}). It is tried again automatically; meanwhile compare the values with the paper form.`);
    return;
  }
  if (crossCheck.firstType !== documentType) {
    add('agreement', label, 'pass', 'The form type was set by an admin, so the values are checked by the admin instead of a second reading.');
    return;
  }
  if (crossCheck.documentType && crossCheck.documentType !== documentType) {
    add('agreement', label, 'warn', `The second reading took this for a ${crossCheck.documentType}. Check that it is a ${documentType}.`);
    return;
  }
  const { compared, differing } = compareReadings(documentType, crossCheck.first, crossCheck.second);
  const fieldOf = (key) => definition.fields.find((field) => field.key === key);
  const flagged = differing.filter((key) => sameReading(fieldOf(key), String(data[key] ?? '').trim(), String(crossCheck.first[key] ?? '').trim()));
  if (flagged.length) {
    const shown = flagged.slice(0, 8).map((key) => `${fieldOf(key).label.replace(/\s*\(.*\)$/, '')} ("${crossCheck.first[key] || 'blank'}" or "${crossCheck.second[key] || 'blank'}")`);
    add('agreement', label, 'warn', `The two readings differ on ${flagged.length} ${flagged.length === 1 ? 'value' : 'values'}: ${shown.join('; ')}${flagged.length > 8 ? '; ...' : ''}. Check ${flagged.length === 1 ? 'it' : 'them'} on the paper form.`, flagged);
  } else {
    add('agreement', label, 'pass', `Two independent readings agree on all ${compared} values${differing.length ? ` (${differing.length} corrected by an admin)` : ''}.`);
  }
}

// The AI's own confidence score is not a check: it says little about whether
// the values are right. The second reading (checkReadingAgreement) and the
// rule checks below decide instead.
function checkAuthenticity(definition, authenticity, add) {
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
}

// Whole years between a YYYY-MM-DD birthday and today.
function ageOn(dateOfBirth, today = todayDateOnly()) {
  const [birthYear, birthMonth, birthDay] = dateOfBirth.split('-').map(Number);
  const [year, month, day] = today.split('-').map(Number);
  return year - birthYear - (month < birthMonth || (month === birthMonth && day < birthDay) ? 1 : 0);
}

export const MIN_MEMBER_AGE = 18;

// A place name to compare: "Sta. Cruz" = "Santa Cruz" = "STA CRUZ", "Brgy. Barahan" = "Barahan".
export function placeKey(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(brgy|bgy|barangay|municipality of|city of|town of)\b\.?/g, ' ')
    .replace(/\bsta\b\.?/g, 'santa').replace(/\bsto\b\.?/g, 'santo').replace(/\bpob\b\.?/g, 'poblacion')
    .replace(/[^a-z0-9]/g, '');
}

// The cooperative's service area: OCR_SERVICE_AREA when set, as
// "Municipality: Barangay, Barangay; Municipality" (a municipality without
// barangays takes any barangay), otherwise the municipalities and barangays
// where members already live. Map of municipality key -> { name, barangays: Map key -> name }.
async function serviceArea(db) {
  const area = new Map();
  const place = (municipality, barangay) => {
    const key = placeKey(municipality);
    if (!key) return;
    if (!area.has(key)) area.set(key, { name: String(municipality).trim(), barangays: new Map() });
    if (placeKey(barangay)) area.get(key).barangays.set(placeKey(barangay), String(barangay).trim());
  };
  const configured = String(process.env.OCR_SERVICE_AREA || '').trim();
  if (configured) {
    for (const part of configured.split(';')) {
      const [municipality, barangays = ''] = part.split(':');
      place(municipality, '');
      for (const barangay of barangays.split(',')) place(municipality, barangay);
    }
    return { area, configured: true };
  }
  const rows = (await db.query(
    `SELECT municipality, barangay FROM members WHERE status <> 'archived' AND COALESCE(TRIM(municipality), '') <> '' GROUP BY municipality, barangay`
  )).rows;
  for (const row of rows) place(row.municipality, row.barangay || '');
  return { area, configured: false };
}

// The closest known name to a misspelt one, when it is close enough to suggest.
function closestPlace(value, names) {
  const key = placeKey(value);
  return [...names.entries()].map(([other, name]) => ({ name, score: textSimilarity(key, other) })).sort((a, b) => b.score - a.score).find(({ score }) => score >= 0.75)?.name || null;
}

async function checkServiceArea(db, data, add) {
  const municipality = String(data.municipality || '').trim();
  const barangay = String(data.barangay || '').trim();
  if (!municipality || !barangay) return;
  const { area, configured } = await serviceArea(db);
  if (!area.size) return;
  const label = 'Within the service area';
  const town = area.get(placeKey(municipality));
  if (!town) {
    const near = closestPlace(municipality, new Map([...area.entries()].map(([key, value]) => [key, value.name])));
    add('area', label, 'warn', `${municipality} is not ${configured ? 'in the service area' : 'a municipality where members live'}${near ? `; did the form say ${near}?` : ''}. Check the address on the paper form.`, ['municipality']);
    return;
  }
  if (town.barangays.size && !town.barangays.has(placeKey(barangay))) {
    const near = closestPlace(barangay, town.barangays);
    add('area', label, 'warn', `Barangay ${barangay} is not ${configured ? `in the service area of ${town.name}` : `a barangay of ${town.name} where members live`}${near ? `; did the form say ${near}?` : ''}. Check the address on the paper form.`, ['barangay']);
    return;
  }
  add('area', label, 'pass', `Barangay ${barangay}, ${town.name} is in the cooperative's service area.`);
}

// Who a submitted ID must belong to, from the form (and, for a borrower, the
// member record): names to compare, and details that should agree with the ID.
// holderReading: AI's reading of the borrower's ID, which the co-maker's must not be.
function expectedIdHolder(documentType, requirement, data, member, holderReading) {
  if (documentType === 'Membership Form') {
    const name = [data.firstName, data.middleName, data.lastName, data.suffix].filter(Boolean).join(' ');
    return { names: [['the applicant on the form', name]], dateOfBirth: [data.dateOfBirth, 'the form'], formIdNumber: data.idNumber, fields: ['firstName', 'lastName', 'dateOfBirth', 'idNumber'] };
  }
  const borrowerNames = [data.memberName, member?.full_name].filter(Boolean);
  if (requirement.slot === 'coMaker') {
    return {
      names: [['the co-maker on the form', data.coMakerName]], address: data.coMakerAddress, fields: ['coMakerName', 'coMakerAddress'],
      notBorrower: { names: borrowerNames, idNumber: holderReading?.idNumber || '' },
    };
  }
  const names = [['the borrower on the form', data.memberName]];
  if (member && compact(member.full_name) !== compact(data.memberName || '')) names.push([`the member on record (${member.member_number})`, member.full_name]);
  return { names, dateOfBirth: [member?.date_of_birth || '', 'the member record'], age: data.age, address: data.address || member?.address, recordIdNumber: member?.id_number, fields: ['memberName', 'age', 'address'] };
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
  const add = (id, label, status, message, fields) => checks.push(makeCheck(id, label, status, message, fields));
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
  const add = (id, label, status, message, fields) => checks.push(makeCheck(id, label, status, message, fields));
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
    else if (similarity < NAME_MATCH_MIN) mismatches.push(['warn', `The name on the ID ("${reading.name}") only partly matches ${who} (${name}): ${percent(similarity)} alike, ${percent(NAME_MATCH_MIN)} needed`]);
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
    add(requirement.matchId, label, mismatches.some(([status]) => status === 'fail') ? 'fail' : 'warn', `${mismatches.map(([, message]) => message).join('. ')}.`, expected.fields);
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
  add('term', 'Loan term', 'pass', `Every loan is for ${DEFAULT_LOAN_TERM} months, repaid in one payment of the whole amount by the due date.`);
}

// The printed Kadiwa forms, as Add Inventory and New Sale would save them.
const inventoryProducts = async (db) => (await db.query(
  `SELECT id, name, size_value AS "sizeValue", size_unit AS "sizeUnit", price, stock, cost_price AS "costPrice"
     FROM kadiwa_inventory WHERE deleted_at IS NULL ORDER BY LOWER(name), size_value NULLS FIRST, id`
)).rows.map((product) => ({ ...product, label: product.sizeValue === null || !product.sizeUnit ? product.name : `${product.name} ${Number(product.sizeValue)} ${product.sizeUnit}` }));

async function readKadiwaInventory(db, data) {
  const rows = tableRows(data, KADIWA_INVENTORY_LINES).map((row) => ({
    line: row.line, product: row.Product, sizeValue: row.Size, quantity: row.Quantity, unit: row.Unit, sellingPrice: row.SellingPrice, costPrice: row.CostPrice, total: row.Total,
  }));
  return readInventoryForm({ rows, grandTotal: data.grandTotal, category: data.category, lowStockAt: data.lowStockAt }, await inventoryProducts(db));
}

async function readKadiwaSales(db, data) {
  const raw = {
    saleDate: data.saleDate,
    goods: tableRows(data, KADIWA_GOODS_LINES).map((row) => ({ name: row.Name, unit: row.Unit, price: row.Price, quantity: row.Quantity, amount: row.Amount })),
    storeItems: tableRows(data, KADIWA_STORE_LINES).map((row) => ({ inventoryId: row.Code, product: row.Product, quantity: row.Quantity, amount: row.Amount })),
    expenses: tableRows(data, KADIWA_EXPENSE_LINES).map((row) => ({ description: row.Description, amount: row.Amount })),
    totals: { goodsSold: data.totalGoodsSold, expenses: data.totalExpenses, netIncome: data.netIncome },
  };
  return readSalesForm(raw, await goodsForForm(db), await inventoryProducts(db));
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
    // The same birthday and a name at least 90% alike (a misread letter, a
    // missing middle name) is probably the same person registered before.
    const applicantName = [data.firstName, data.middleName, data.lastName, data.suffix].filter(Boolean).join(' ');
    const lookalike = !duplicate && isValidDateOnly(data.dateOfBirth)
      ? (await db.query(`${memberLookupSelect} WHERE date_of_birth = $1::date AND status <> 'archived'`, [data.dateOfBirth])).rows
        .map((member) => ({ member, score: nameSimilarity(applicantName, member.full_name) })).sort((a, b) => b.score - a.score)
        .find(({ score }) => score >= NAME_MATCH_MIN)
      : null;
    if (duplicate) add('records', 'Not already registered', 'fail', `This applicant appears to be already registered as ${duplicate.member_number}.`, ['firstName', 'lastName', 'dateOfBirth', 'rsbsaNo', 'email']);
    else if (lookalike) add('records', 'Not already registered', 'warn', `${lookalike.member.full_name} (${lookalike.member.member_number}) has the same birthday and a name ${percent(lookalike.score)} alike. Check that this is not the same person.`, ['firstName', 'middleName', 'lastName', 'dateOfBirth']);
    else add('records', 'Not already registered', 'pass', 'No existing member has the same email, RSBSA number, ID number, or a similar name with the same birth date.');

    const idNumber = compact(data.idNumber || '');
    if (idNumber.length >= 5) {
      const holder = (await db.query(`SELECT member_number FROM members WHERE regexp_replace(LOWER(COALESCE(id_number, '')), '[^a-z0-9]', '', 'g') = $1 LIMIT 1`, [idNumber])).rows[0];
      if (holder) add('idRegistered', 'ID not used by another member', 'fail', `ID No. ${data.idNumber} is already registered to member ${holder.member_number}.`, ['idNumber']);
    }
    if (isValidDateOnly(data.dateOfBirth)) {
      const years = ageOn(data.dateOfBirth);
      if (years < MIN_MEMBER_AGE) add('adult', `Applicant is ${MIN_MEMBER_AGE} or older`, 'fail', `The birthday ${data.dateOfBirth} makes the applicant ${years}; members must be at least ${MIN_MEMBER_AGE}.`, ['dateOfBirth']);
      else if (years > 110) add('adult', `Applicant is ${MIN_MEMBER_AGE} or older`, 'fail', `The birthday ${data.dateOfBirth} makes the applicant ${years}; check the year.`, ['dateOfBirth']);
      else add('adult', `Applicant is ${MIN_MEMBER_AGE} or older`, 'pass', `The applicant is ${years}.`);
    }
    const age = String(data.age || '').trim();
    if (isValidDateOnly(data.dateOfBirth) && /^\d+$/.test(age) && Math.abs(ageOn(data.dateOfBirth) - Number(age)) > 1) {
      add('age', 'Age matches the birthday', 'warn', `The form says age ${age}, but the birthday ${data.dateOfBirth} makes the applicant ${ageOn(data.dateOfBirth)}.`, ['age', 'dateOfBirth']);
    }
    await checkServiceArea(db, data, add);
    if (!String(data.membershipDate || '').trim()) add('acceptance', 'Acceptance date', 'pass', `The form has no acceptance date yet; today (${todayDateOnly()}) will be the membership date.`);
    // The system gives the membership number; shown so it can be written on the paper form.
    return { memberNumber: await nextMemberNumber(db) };
  }

  if (documentType === 'Add Inventory Form') {
    const reading = await readKadiwaInventory(db, data);
    if (!reading.rows.length) add('lines', 'Products on the form', 'fail', 'No product lines were read from the form.');
    else add('lines', 'Products on the form', 'pass', `${reading.rows.length} ${reading.rows.length === 1 ? 'product' : 'products'} read.`);
    if (reading.rows.some((row) => !row.unit)) add('units', 'Counted in', 'warn', 'What some quantities are counted in was not read; pc will be used. Check the Counted In column.');
    const warnings = reading.warnings.filter((warning) => !warning.startsWith('No product lines'));
    if (warnings.length) add('totals', 'Lines and totals', 'warn', warnings.join(' '));
    else if (reading.rows.length) add('totals', 'Lines and totals', 'pass', 'Every line total is quantity x cost price, and the lines add up to the TOTAL.');
    return {};
  }

  if (documentType === 'Kadiwa Daily Sales Form') {
    const reading = await readKadiwaSales(db, data);
    if (!reading.goods.length && !reading.items.length) add('lines', 'Goods sold', 'fail', 'No goods or store items sold were read from the form.');
    else add('lines', 'Goods sold', 'pass', `${reading.goods.length} ${reading.goods.length === 1 ? 'good' : 'goods'} and ${reading.items.length} store ${reading.items.length === 1 ? 'item' : 'items'} read.`);
    if (reading.unmatched.length) add('storeItems', 'Store items in the inventory', 'fail', `Not in the inventory: ${reading.unmatched.join(', ')}. Correct the code from the paper form, or add the product with Add Inventory first.`);
    if (!reading.expenses.length) add('expenses', 'Expenses', 'warn', 'No expenses were written on the form; the sale will be saved with no expenses (0).');
    const warnings = reading.warnings.filter((warning) => !/^(No goods or store items|Store item ")|could not be read; enter it\.$/.test(warning));
    if (warnings.length) add('totals', 'Lines and totals', 'warn', warnings.join(' '));
    else if (reading.goods.length || reading.items.length) add('totals', 'Lines and totals', 'pass', 'Every line and the TOTALS box add up.');
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

  if (documentType === 'Loan Form') checkLoanAmounts(data, add);

  const requireActive = documentType !== 'Savings Form';
  const { member, check } = await findMember(db, data, { requireActive });
  add('member', 'Member on record', check[0], check[1], check[0] === 'pass' ? [] : ['memberNumber', 'memberName']);
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

// The system's confidence in a scan: the share of its checks that passed (0-100).
export const checksScore = (checks) => (checks.length ? Math.round((100 * checks.filter((check) => check.status === 'pass').length) / checks.length) : null);

// Returns { status: passed|warning|failed, canPost, checks[], score, target, checkedAt }.
// A form is saved automatically only when every check passed.
export async function verifyDocument(req, scan, { documentType, extractedData, authenticity }) {
  const definition = FORM_DEFINITIONS[documentType];
  const checks = [];
  const add = (id, label, status, message, fields) => checks.push(makeCheck(id, label, status, message, fields));
  if (!definition) {
    add('type', 'Document type', documentType === UNRECOGNIZED ? 'fail' : 'warn', documentType === UNRECOGNIZED
      ? 'The document type was not recognised. Choose the correct form type.'
      : `${documentType} documents are kept for reference and are not posted to a module.`);
    return { status: documentType === UNRECOGNIZED ? 'failed' : 'warning', canPost: false, checks, score: null, target: {}, checkedAt: new Date().toISOString() };
  }

  checkAuthenticity(definition, authenticity, add);
  checkFields(definition, extractedData, add);
  checkReadingAgreement(definition, documentType, scan.cross_check, extractedData, add);
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
  return { status, canPost: status !== 'failed', checks, score: checksScore(checks), target, checkedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Posting.

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

  if (documentType === 'Add Inventory Form') {
    const reading = await readKadiwaInventory(client, data);
    if (!reading.rows.length) throw badRequest('No product lines were read from the form.');
    const category = ['Groceries', 'Vegetables', 'Meat', 'Other'].find((option) => option.toLowerCase() === String(data.category || '').trim().toLowerCase()) || 'Groceries';
    const created = await insertInventoryItems(client, req, reading.rows.map((row) => ({
      name: row.name, category, sizeValue: row.sizeValue, sizeUnit: row.sizeUnit, unit: row.unit || 'pc', stock: row.stock,
      price: row.price, costPrice: row.costPrice, reorderLevel: reading.lowStockAt || '5',
    })), { source: `from scanned Add Inventory form #${scan.id}` });
    const ids = created.map((item) => item.id).sort();
    return { module: 'kadiwa', recordId: ids.length === 1 ? ids[0] : `${ids[0]} to ${ids[ids.length - 1]}`, label: `${ids.length} ${ids.length === 1 ? 'product' : 'products'} added to the Kadiwa Store inventory` };
  }

  if (documentType === 'Kadiwa Daily Sales Form') {
    if (!isValidDateOnly(data.saleDate) || data.saleDate > todayDateOnly()) throw badRequest('Enter the date of the sales from the form (not a future date).');
    const reading = await readKadiwaSales(client, data);
    if (reading.unmatched.length) throw badRequest(`Not in the inventory: ${reading.unmatched.join(', ')}.`);
    if (!reading.goods.length && !reading.items.length) throw badRequest('No goods or store items sold were read from the form.');
    const goods = parseGoodsLines(reading.goods.map(({ name, unit, category, price, quantity, amount }) => ({ name, unit, category, price, quantity, amount })));
    const expenseLines = parseExpenseLines(reading.expenses.length ? reading.expenses : [{ description: 'None', amount: '0' }]);
    const encoderName = String(data.preparedBy || req.user?.full_name || req.user?.username || 'Administrator').trim().slice(0, 200);
    const saleId = await insertKadiwaSale(client, req, {
      encoderName, saleDate: data.saleDate, manual: { Groceries: 0, Vegetables: 0, Meat: 0 },
      expensesCents: expenseLines.reduce((sum, line) => sum + line.cents, 0), items: reading.items.map(({ inventoryId, quantity }) => ({ inventoryId, quantity })), goods, expenseLines,
    });
    return { module: 'kadiwa', recordId: saleId, label: `Kadiwa sale ${saleId} recorded` };
  }

  if (documentType === 'Kadiwa Sales Form') {
    const manual = { Groceries: moneyCents(data.groceriesPrice), Vegetables: moneyCents(data.vegetablesPrice), Meat: moneyCents(data.meatPrice) };
    const expensesCents = moneyCents(data.totalExpenses);
    if ([...Object.values(manual), expensesCents].some((value) => value === null)) throw badRequest('Sales amounts must be non-negative with at most two decimals.');
    const saleId = await insertKadiwaSale(client, req, { encoderName: String(data.encoderName || '').slice(0, 200), saleDate: isValidDateOnly(data.saleDate) && data.saleDate <= todayDateOnly() ? data.saleDate : null, manual, expensesCents, items: [] });
    return { module: 'kadiwa', recordId: saleId, label: `Kadiwa sale ${saleId} recorded` };
  }

  throw badRequest(`${documentType} documents are not posted to a module.`);
}

export async function postDocument(client, req, scan, documentType, data, target) {
  return saveToModule(client, req, scan, documentType, data, target);
}

// ---------------------------------------------------------------------------
// Undo of a form saved automatically.
//
// For UNDO_WINDOW_HOURS an admin can take back what the scanner saved by
// itself: a new member (while nothing else has been recorded for them), or a
// loan application or rental request still waiting for approval. Savings
// deposits and Kadiwa records are corrected in their own module.

export const UNDO_WINDOW_HOURS = 48;
const UNDOABLE_MODULES = new Set(['members', 'loans', 'machinery']);

// When the automatic save of this scan can no longer be undone, or null when it cannot be undone at all.
export function undoDeadline(scan) {
  if (!scan.posted_at || !scan.posted_automatically || !UNDOABLE_MODULES.has(scan.posted_module)) return null;
  return new Date(new Date(scan.posted_at).getTime() + UNDO_WINDOW_HOURS * 3600000);
}

// Removes the record a scan created, in the caller's transaction. Returns a label.
export async function undoPostedRecord(client, scan) {
  if (scan.posted_module === 'members') {
    const member = (await client.query('SELECT id, member_number FROM members WHERE member_number = $1 FOR UPDATE', [scan.posted_record_id])).rows[0];
    if (!member) throw conflict(`Member ${scan.posted_record_id} no longer exists.`);
    const initialShare = `INITIAL-${member.member_number}`;
    // Every table that points at members, so a member with loans, savings,
    // rentals, attendance, a login account or later share capital is kept.
    const references = (await client.query(
      `SELECT con.conrelid::regclass::text AS table_name, quote_ident(a.attname) AS column_name
       FROM pg_constraint con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
       WHERE con.contype = 'f' AND con.confrelid = 'members'::regclass AND array_length(con.conkey, 1) = 1`
    )).rows;
    const used = [];
    for (const { table_name: table, column_name: column } of references) {
      const initial = table === 'share_contributions' ? ' AND reference_number IS DISTINCT FROM $2' : '';
      const { count } = (await client.query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE ${column} = $1${initial}`, initial ? [member.id, initialShare] : [member.id])).rows[0];
      if (count) used.push(table.replace(/^public\./, '').replaceAll('_', ' '));
    }
    if (used.length) throw conflict(`Member ${member.member_number} already has other records (${used.join(', ')}), so the registration cannot be undone. Archive the member instead.`);
    await client.query('DELETE FROM share_contributions WHERE member_id = $1 AND reference_number = $2', [member.id, initialShare]);
    await client.query('DELETE FROM members WHERE id = $1', [member.id]);
    return `Member ${member.member_number} removed`;
  }
  if (scan.posted_module === 'loans' || scan.posted_module === 'machinery') {
    const [table, what] = scan.posted_module === 'loans' ? ['loan_requests', 'Loan application'] : ['rental_requests', 'Rental request'];
    const request = (await client.query(`SELECT id, status FROM ${table} WHERE id = $1 FOR UPDATE`, [Number(scan.posted_record_id)])).rows[0];
    if (!request) throw conflict(`${what} #${scan.posted_record_id} no longer exists.`);
    if (request.status !== 'pending') throw conflict(`${what} #${request.id} was already ${request.status}, so it cannot be undone here.`);
    await client.query(`DELETE FROM ${table} WHERE id = $1`, [request.id]);
    return `${what} #${request.id} withdrawn`;
  }
  throw badRequest('Records of this module are corrected in the module itself.');
}
