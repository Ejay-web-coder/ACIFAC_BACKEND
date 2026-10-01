import crypto from 'node:crypto';
import { query } from '../config/db.js';
import { AppError, badRequest, cleanString, currentUserId, parseId } from '../utils/http.js';
import { assertValidUpload, BUCKETS, removeFile, safeOriginalName, uploadFile } from '../services/storage.js';
import { DOCUMENT_TYPES as UPLOAD_TYPES } from '../middleware/upload.js';
import { aiFailureReason, askAi } from '../services/aiClient.js';
import { buildIdPrompt, checkLoanIds, ID_CHECK_IDS, ID_READING_INSTRUCTION, normalizeIdReading } from '../services/documentRouting.js';
import { createLoan, createMemberLoanRequest, memberApplicationSelect } from './loanController.js';
import { todayDateOnly } from '../utils/dates.js';

// Loan applications typed into the app (admin New Loan, member Apply Loan)
// need the borrower's and the co-maker's valid IDs, each a back-to-back copy
// (front and back of the ID on one page) with three specimen signatures, like a
// scanned loan form. AI reads each ID when it is picked in the form; the form
// shows the reading and how it compares with the borrower and co-maker; the
// application is saved only when both IDs pass those checks.
//
// The borrower is the "holder" of a loan form's IDs (documentRouting ID_SLOTS).
const HOLDERS = {
  borrower: { slot: 'holder', person: 'borrower', field: 'borrowerId' },
  coMaker: { slot: 'coMaker', person: 'co-maker', field: 'coMakerId' },
};
// How long a reading can be used to submit the application.
const READING_HOURS = 24;

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

// POST /api/loans/id-reading (multipart: idDocument, holder = borrower | coMaker, source = upload | camera)
// AI reads the ID; the reading is kept so the submitted file is not read again.
export async function readLoanId(req, res) {
  const holderKey = req.body?.holder;
  const holder = HOLDERS[holderKey];
  if (!holder) throw badRequest('Say whose ID this is: the borrower\'s or the co-maker\'s.');
  const file = req.file;
  assertValidUpload(file, UPLOAD_TYPES, 'ID');
  const source = req.body?.source === 'camera' ? 'camera' : 'upload';
  if (source === 'camera' && !file.mimetype.startsWith('image/')) throw badRequest('A camera capture must be a picture.');

  // An unreadable ID can still be submitted; its check then asks for a person to look at it.
  let reading;
  try {
    reading = normalizeIdReading(await askAi(file, buildIdPrompt(source, 'Loan Form', holder.slot), ID_READING_INSTRUCTION));
  } catch (error) {
    console.error('Loan ID reading error:', error instanceof Error ? error.message : error);
    reading = { ...normalizeIdReading(null), error: aiFailureReason(error) };
  }

  await query('DELETE FROM loan_id_readings WHERE created_at < NOW() - make_interval(hours => $1)', [READING_HOURS]);
  const row = (await query(
    'INSERT INTO loan_id_readings (holder, source, file_sha256, reading, read_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [holderKey, source, sha256(file.buffer), JSON.stringify(reading), currentUserId(req)]
  )).rows[0];
  return res.status(201).json({
    success: true, readingId: Number(row.id), reading,
    message: reading.error ? `AI could not read the ID (${reading.error}). Try again, or submit it for a person to check.` : `The ${holder.person}'s ID was read.`,
  });
}

// The readings the signed-in user got for the IDs named in the request.
async function readingsFor(req, readingIds) {
  const rows = {};
  for (const [key, holder] of Object.entries(HOLDERS)) {
    const raw = readingIds[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const row = (await query(
      `SELECT source, file_sha256, reading FROM loan_id_readings
       WHERE id = $1 AND holder = $2 AND read_by = $3 AND created_at > NOW() - make_interval(hours => $4)`,
      [parseId(raw, `${holder.person} ID reading`), key, currentUserId(req), READING_HOURS]
    )).rows[0];
    if (!row) throw badRequest(`The ${holder.person}'s ID has to be read again: pick it again in the form.`);
    rows[key] = row;
  }
  return rows;
}

// The application details the IDs are compared with, as on the loan form.
const formDetails = (member, { borrowerAddress, borrowerAge, coMakerName, coMakerAddress }) => ({
  memberName: member.full_name, address: borrowerAddress || member.address || '', age: borrowerAge === null || borrowerAge === undefined ? '' : String(borrowerAge),
  coMakerName: coMakerName || '', coMakerAddress: coMakerAddress || '',
});

const asSubmitted = (row) => (row ? { reading: row.reading || {}, source: row.source } : null);

// POST /api/loans/id-checks { memberId (admin), borrowerIdReading, coMakerIdReading, borrowerAddress, borrowerAge, coMakerName, coMakerAddress }
// How the IDs read so far compare with the borrower and co-maker on the form.
export async function previewLoanIdChecks(req, res) {
  const memberId = req.user.role === 'ADMIN' ? parseId(req.body?.memberId, 'member') : Number(req.user.member_id);
  const member = (await query(memberApplicationSelect, [memberId])).rows[0];
  if (!member) throw badRequest('Select an active member.');
  const rows = await readingsFor(req, { borrower: req.body?.borrowerIdReading, coMaker: req.body?.coMakerIdReading });
  const details = formDetails(member, {
    borrowerAddress: cleanString(req.body?.borrowerAddress, 2000), borrowerAge: cleanString(String(req.body?.borrowerAge ?? ''), 3),
    coMakerName: cleanString(req.body?.coMakerName, 200), coMakerAddress: cleanString(req.body?.coMakerAddress, 2000),
  });
  const checks = checkLoanIds({ holder: asSubmitted(rows.borrower), coMaker: asSubmitted(rows.coMaker) }, details, member);
  return res.json({ success: true, checks });
}

// Wraps a loan handler so the application must come with both IDs.
// Multipart: "application" (the form as JSON), borrowerId and coMakerId (the
// ID files AI read), borrowerIdReading and coMakerIdReading (their readings),
// acknowledgeIdWarnings. An admin releasing the loan at once must confirm any
// ID warning; a member's application keeps the warnings for the approver.
function withApplicationIds(handler, { releasesLoan }) {
  return async (req, res, next) => {
    if (typeof req.body?.application === 'string') {
      let application;
      try {
        application = JSON.parse(req.body.application);
      } catch {
        throw badRequest('The application could not be read.');
      }
      if (!application || typeof application !== 'object' || Array.isArray(application)) throw badRequest('The application could not be read.');
      req.body = { ...application, borrowerIdReading: req.body.borrowerIdReading, coMakerIdReading: req.body.coMakerIdReading, acknowledgeIdWarnings: req.body.acknowledgeIdWarnings };
    }
    const acknowledged = req.body?.acknowledgeIdWarnings === true || req.body?.acknowledgeIdWarnings === 'true';
    const rows = await readingsFor(req, { borrower: req.body?.borrowerIdReading, coMaker: req.body?.coMakerIdReading });
    const files = {};
    for (const [key, holder] of Object.entries(HOLDERS)) {
      const file = req.files?.[holder.field]?.[0];
      if (!file) continue;
      assertValidUpload(file, UPLOAD_TYPES, `${holder.person}'s ID`);
      if (!rows[key]) throw badRequest(`AI has not read the ${holder.person}'s ID yet: pick it again in the form.`);
      if (sha256(file.buffer) !== rows[key].file_sha256) throw badRequest(`The ${holder.person}'s ID file is not the one AI read: pick it again in the form.`);
      files[key] = file;
    }

    const stored = {};
    try {
      for (const [key, file] of Object.entries(files)) {
        stored[key] = await uploadFile({ bucket: BUCKETS.memberDocuments, folder: `loans/${todayDateOnly().slice(0, 7)}`, file });
      }
      const takeIds = async (member, application) => {
        if (!application.coMaker.name) throw badRequest('Fill in the co-maker\'s name, address, contact number and relationship: the co-maker\'s valid ID is required.');
        const submitted = { holder: files.borrower ? asSubmitted(rows.borrower) : null, coMaker: files.coMaker ? asSubmitted(rows.coMaker) : null };
        const checks = checkLoanIds(submitted, formDetails(member, { ...application, coMakerName: application.coMaker.name, coMakerAddress: application.coMaker.address }), member);
        const failed = checks.filter((check) => check.status === 'fail').map((check) => check.message);
        if (failed.length) throw new AppError(422, failed[0], failed);
        const warnings = checks.filter((check) => check.status === 'warn').map((check) => check.message);
        if (releasesLoan && warnings.length && !acknowledged) {
          throw new AppError(422, `Confirm that you compared the flagged ID details with the borrower and co-maker: ${warnings[0]}`, warnings);
        }
        return Object.fromEntries(Object.entries(HOLDERS).map(([key, holder]) => [key, {
          path: stored[key], fileName: safeOriginalName(files[key].originalname), mimeType: files[key].mimetype, size: files[key].size,
          source: rows[key].source, reading: rows[key].reading, checks: checks.filter((check) => ID_CHECK_IDS[holder.slot].includes(check.id)),
        }]));
      };
      return await handler(req, res, next, { takeIds });
    } catch (error) {
      await Promise.all(Object.values(stored).map((reference) => removeFile(reference)));
      throw error;
    }
  };
}

export const createLoanWithIds = withApplicationIds(createLoan, { releasesLoan: true });
export const createMemberLoanRequestWithIds = withApplicationIds(createMemberLoanRequest, { releasesLoan: false });
