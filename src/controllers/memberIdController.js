import crypto from 'node:crypto';
import { query } from '../config/db.js';
import { AppError, badRequest, cleanString, currentUserId, parseId } from '../utils/http.js';
import { assertValidUpload } from '../services/storage.js';
import { DOCUMENT_TYPES } from '../middleware/upload.js';
import { aiFailureReason, askAi } from '../services/aiClient.js';
import { buildIdPrompt, checkMemberId, ID_READING_INSTRUCTION, MEMBER_APPLICANT_ID, normalizeIdReading } from '../services/documentRouting.js';

// Add Member and Edit Member need the applicant's valid ID: a back-to-back
// copy (front and back of the ID on one page) with three specimen signatures,
// like a loan co-maker's. AI reads the ID when it is picked in the form; the
// form shows the reading and how it compares with the applicant; the member is
// saved only when the ID passes those checks.

// How long a reading can be used to save the member.
const READING_HOURS = 24;

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

// POST /api/members/id-reading (multipart: idDocument, source = upload | camera)
// AI reads the ID; the reading is kept so the submitted file is not read again.
export async function readMemberId(req, res) {
  const file = req.file;
  assertValidUpload(file, DOCUMENT_TYPES, 'ID');
  const source = req.body?.source === 'camera' ? 'camera' : 'upload';
  if (source === 'camera' && !file.mimetype.startsWith('image/')) throw badRequest('A camera capture must be a picture.');

  // An unreadable ID can still be submitted; its check then asks for a person to look at it.
  let reading;
  try {
    reading = normalizeIdReading(await askAi(file, buildIdPrompt(source, 'Membership Form', 'holder', MEMBER_APPLICANT_ID), ID_READING_INSTRUCTION));
  } catch (error) {
    console.error('Member ID reading error:', error instanceof Error ? error.message : error);
    reading = { ...normalizeIdReading(null), error: aiFailureReason(error) };
  }

  await query('DELETE FROM member_id_readings WHERE created_at < NOW() - make_interval(hours => $1)', [READING_HOURS]);
  const row = (await query(
    'INSERT INTO member_id_readings (source, file_sha256, reading, read_by) VALUES ($1, $2, $3, $4) RETURNING id',
    [source, sha256(file.buffer), JSON.stringify(reading), currentUserId(req)]
  )).rows[0];
  return res.status(201).json({
    success: true, readingId: Number(row.id), reading,
    message: reading.error ? `AI could not read the ID (${reading.error}). Try again, or submit it for a person to check.` : 'The applicant\'s ID was read.',
  });
}

// The reading the signed-in admin got for the ID, or null when none is named.
async function readingFor(req, raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const row = (await query(
    `SELECT source, file_sha256, reading FROM member_id_readings
     WHERE id = $1 AND read_by = $2 AND created_at > NOW() - make_interval(hours => $3)`,
    [parseId(raw, 'ID reading'), currentUserId(req), READING_HOURS]
  )).rows[0];
  if (!row) throw badRequest('The applicant\'s ID has to be read again: pick it again in the form.');
  return row;
}

const asSubmitted = (row) => ({ reading: row.reading || {}, source: row.source });

// POST /api/members/id-checks { idReading, firstName, middleName, lastName, suffix, dateOfBirth, idNumber }
// How the ID read so far compares with the applicant on the form.
export async function previewMemberIdChecks(req, res) {
  const body = req.body || {};
  const row = await readingFor(req, body.idReading);
  if (!row) throw badRequest('Pick the applicant\'s ID first.');
  const checks = checkMemberId(asSubmitted(row), {
    firstName: cleanString(body.firstName, 100), middleName: cleanString(body.middleName, 100), lastName: cleanString(body.lastName, 100),
    suffix: cleanString(body.suffix, 20), dateOfBirth: cleanString(body.dateOfBirth, 10), idNumber: cleanString(body.idNumber, 100),
  });
  return res.json({ success: true, checks });
}

// The applicant's ID submitted to save a member (multipart idDocument): it
// must be the file AI read (id_document_reading) and pass the checks against
// the applicant (details: firstName, middleName, lastName, suffix, dateOfBirth,
// idNumber). Warnings must be confirmed (acknowledge_id_warnings).
export async function checkSubmittedMemberId(req, file, details) {
  const row = await readingFor(req, req.body?.id_document_reading);
  if (!row) throw badRequest('AI has not read the applicant\'s ID yet: pick it again in the form.');
  if (sha256(file.buffer) !== row.file_sha256) throw badRequest('The applicant\'s ID file is not the one AI read: pick it again in the form.');
  const checks = checkMemberId(asSubmitted(row), details);
  const failed = checks.filter((check) => check.status === 'fail').map((check) => check.message);
  if (failed.length) throw new AppError(422, failed[0], failed);
  const warnings = checks.filter((check) => check.status === 'warn').map((check) => check.message);
  const acknowledged = req.body?.acknowledge_id_warnings === true || req.body?.acknowledge_id_warnings === 'true';
  if (warnings.length && !acknowledged) throw new AppError(422, `Confirm that you compared the flagged ID details with the applicant: ${warnings[0]}`, warnings);
  return { source: row.source, reading: row.reading || {}, checks };
}
