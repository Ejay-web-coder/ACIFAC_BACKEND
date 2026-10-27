import crypto from 'node:crypto';
import { query, withTransaction } from '../config/db.js';
import { createAuditLog } from '../utils/audit.js';
import { AppError, badRequest, cleanString, conflict, currentUserId, getRequestMeta, notFound, parseId, parsePagination, paginationMeta } from '../utils/http.js';
import { assertValidUpload, BUCKETS, downloadFile, removeFile, safeOriginalName, sendStoredFile, uploadFile } from '../services/storage.js';
import { IMAGE_TYPES, DOCUMENT_TYPES as UPLOAD_TYPES } from '../middleware/upload.js';
import {
  buildAnalysisPrompt, buildCrossCheckPrompt, buildIdPrompt, buildPhotoPrompt, CROSS_CHECK_INSTRUCTION, DOCUMENT_TYPES, FORM_DEFINITIONS, ID_SLOTS, idRequirement, idRequirements,
  isPostable, normalizeAuthenticity, normalizeDocumentType, normalizeExtractedData, normalizeIdReading, normalizePhotoReading, photoExpected, postDocument, publicFormDefinitions,
  publicIdRequirements, ID_READING_INSTRUCTION, REQUIRED_ID_SIGNATURES, requiresIdDocument, UNDO_WINDOW_HOURS, undoDeadline, undoPostedRecord, UNRECOGNIZED, verifyDocument,
} from '../services/documentRouting.js';
import { photoMimeType } from './profilePhotoController.js';
import { aiFailureReason, askAi } from '../services/aiClient.js';
import { emailMember } from '../services/memberEmails.js';
import { notifyAdmins } from '../services/notificationService.js';
import { todayDateOnly } from '../utils/dates.js';

const SUPPORTED_TYPES = new Set(DOCUMENT_TYPES);
// A fully verified form (every check passed) is posted without an admin.
// Set OCR_AUTO_POST=false to always require an admin.
const autoPostEnabled = () => String(process.env.OCR_AUTO_POST ?? 'true').toLowerCase() !== 'false';

// When a reading the AI could not do is tried again by itself, after the
// 1st, 2nd... failure. After the last one the admins are told and the scan
// waits for Retry.
const RETRY_DELAYS_SECONDS = [15, 60, 5 * 60, 15 * 60, 60 * 60, 3 * 60 * 60];
// How long a background retry holds a scan so two runs never read it at once.
const RETRY_LEASE = '3 minutes';

const clean = (value) => cleanString(value, 200000);

// A valid ID kept on the scan (slot: holder = applicant or borrower, coMaker).
function mapIdDocument(row, slot) {
  const columns = ID_SLOTS[slot];
  if (!row[columns.path]) return null;
  return { fileName: row[columns.name], mimeType: row[columns.type], size: Number(row[columns.size]), source: row[columns.source], reading: row[columns.check] || {} };
}

function mapScan(row) {
  const undoUntil = undoDeadline(row);
  return {
    id: Number(row.id), fileName: row.original_file_name, documentType: row.detected_document_type,
    // The share of verification checks passed, worked out by the system; aiConfidence is what the AI reported.
    confidence: row.confidence === null ? null : Number(row.confidence),
    aiConfidence: row.ai_confidence === null || row.ai_confidence === undefined ? null : Number(row.ai_confidence), ocrText: row.ocr_text,
    extractedData: row.extracted_data || {}, reviewStatus: row.review_status,
    processingStatus: row.processing_status, processingError: row.processing_error || null,
    // The automatic retries of a reading the AI could not do (nextAt = null: not queued).
    retry: { count: Number(row.retry_count || 0), max: RETRY_DELAYS_SECONDS.length, nextAt: row.next_retry_at || null },
    crossCheck: row.cross_check?.error ? { error: row.cross_check.error } : row.cross_check?.first ? { done: true } : null,
    captureSource: row.capture_source || 'upload', authenticity: row.authenticity || {}, verification: row.verification || {},
    postable: isPostable(row.detected_document_type), targetModule: FORM_DEFINITIONS[row.detected_document_type]?.moduleLabel || null,
    requiresIdDocument: requiresIdDocument(row.detected_document_type), photoExpected: photoExpected(row.detected_document_type),
    photo: row.photo_path ? { reading: row.photo_check || {} } : null,
    // The IDs the form needs, and those submitted. idDocument is the holder's, kept for older pages.
    idRequirements: publicIdRequirements(row.detected_document_type),
    idDocuments: Object.fromEntries(Object.keys(ID_SLOTS).map((slot) => [slot, mapIdDocument(row, slot)])),
    idDocument: mapIdDocument(row, 'holder'),
    posted: row.posted_at ? {
      module: row.posted_module, recordId: row.posted_record_id, at: row.posted_at, automatically: row.posted_automatically,
      undoUntil: undoUntil && undoUntil > new Date() ? undoUntil.toISOString() : null,
    } : null,
    undone: row.undone_at ? { at: row.undone_at, recordId: row.undone_record_id } : null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function normalizeConfidence(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(100, value));
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'high') return 90;
    if (normalized === 'medium' || normalized === 'moderate') return 60;
    if (normalized === 'low') return 30;
    const parsed = Number.parseFloat(normalized.replace('%', ''));
    if (Number.isFinite(parsed)) return Math.max(0, Math.min(100, parsed));
  }
  return null;
}

// secondType: the type the second reading found. The AI's own confidence is
// used only to accept the document type: at least 70, or both readings agree.
function parseModelResponse(json, secondType) {
  const confidence = normalizeConfidence(json.confidence ?? json.confidenceScore ?? json.confidence_percent);
  const readType = normalizeDocumentType(json.documentType);
  const documentType = (confidence ?? 0) >= 70 || (secondType && secondType === readType && readType !== UNRECOGNIZED) ? readType : UNRECOGNIZED;
  return {
    documentType,
    confidence,
    ocrText: clean(json.ocrText),
    extractedData: normalizeExtractedData(documentType, json.extractedData),
    authenticity: normalizeAuthenticity(json.authenticity),
  };
}

const readOnce = (file, captureSource) => askAi(file, buildAnalysisPrompt(captureSource),
  'Read this document including its text, labels, keywords, important fields, and layout. Classify it, extract the fields for its type, and assess whether it is genuine.');
const readAgain = (file) => askAi(file, buildCrossCheckPrompt(), CROSS_CHECK_INSTRUCTION);

// The second reading, kept for verification: both readings of the form's fields.
function crossCheckOf(analysis, secondJson) {
  return {
    firstType: analysis.documentType, documentType: normalizeDocumentType(secondJson?.documentType),
    first: analysis.extractedData, second: normalizeExtractedData(analysis.documentType, secondJson?.extractedData), at: new Date().toISOString(),
  };
}
const withoutStop = (text) => text.replace(/\.$/, '');
const crossCheckError = (error) => ({ error: aiFailureReason(error), at: new Date().toISOString() });

// The form is read twice at the same time, with different instructions, so it
// takes no longer than one reading. The first reading must succeed; if only
// the second fails, the scan goes on and the second reading is tried again later.
async function analyzeWithAi(file, captureSource) {
  const [first, second] = await Promise.allSettled([readOnce(file, captureSource), readAgain(file)]);
  if (first.status === 'rejected') throw first.reason;
  const secondJson = second.status === 'fulfilled' ? second.value : null;
  const analysis = parseModelResponse(first.value, secondJson ? normalizeDocumentType(secondJson.documentType) : null);
  const crossCheck = !isPostable(analysis.documentType) ? {} : secondJson ? crossCheckOf(analysis, secondJson) : crossCheckError(second.reason);
  return { ...analysis, crossCheck };
}

const readPhotoWithAi = async (file) => normalizePhotoReading(await askAi(file, buildPhotoPrompt(),
  'Check this 2x2 ID picture: is it one person with a clear, recognizable face?'));

const readIdWithAi = async (file, source, documentType, slot) => normalizeIdReading(await askAi(file, buildIdPrompt(source, documentType, slot), ID_READING_INSTRUCTION));

// After a failed reading: the next automatic try (null when the AI refused
// the file itself, or after the last try).
function nextRetry(error, failures) {
  if (error?.retryable === false || failures > RETRY_DELAYS_SECONDS.length) return null;
  return new Date(Date.now() + RETRY_DELAYS_SECONDS[failures - 1] * 1000);
}

const inWords = (seconds) => (seconds < 60 ? `${seconds} seconds` : seconds < 3600 ? `${Math.round(seconds / 60)} minute${seconds < 120 ? '' : 's'}` : `${Math.round(seconds / 3600)} hour${seconds < 7200 ? '' : 's'}`);
const retryNote = (scan) => (scan.next_retry_at
  ? ` It will be read again automatically in about ${inWords(Math.max(1, Math.round((new Date(scan.next_retry_at) - Date.now()) / 1000)))}.`
  : ' Press Retry to read it again.');

// Upload/capture -> validate -> store privately -> two AI readings (OCR,
// classification, authenticity) -> save scan -> verify against the database
// -> post to the form's module when every check passes. A failed AI run is
// still recorded (processing_status = 'failed') and queued: the same file is
// read again automatically, or with Retry.
export async function analyzeDocument(req, res) {
  const file = req.file;
  assertValidUpload(file, UPLOAD_TYPES, 'document');
  const captureSource = req.body?.source === 'camera' ? 'camera' : 'upload';
  const fileHash = crypto.createHash('sha256').update(file.buffer).digest('hex');

  const existing = (await query('SELECT id, processing_status, stored_file_path FROM document_scans WHERE file_sha256 = $1', [fileHash])).rows[0];
  if (existing && existing.processing_status !== 'failed') throw conflict('This document has already been uploaded.');

  let analysis;
  let processingStatus = 'completed';
  let processingError = null;
  let retryAt = null;
  try {
    analysis = await analyzeWithAi(file, captureSource);
  } catch (error) {
    console.error('OCR analysis error:', error instanceof Error ? error.message : error);
    processingStatus = 'failed';
    processingError = error instanceof Error ? error.message.slice(0, 500) : 'AI analysis failed.';
    retryAt = nextRetry(error, 1);
    analysis = { documentType: UNRECOGNIZED, confidence: null, ocrText: '', extractedData: {}, authenticity: normalizeAuthenticity(null), crossCheck: {} };
  }
  // A second reading that failed is tried again later, like a failed first one.
  if (!retryAt && analysis.crossCheck?.error) retryAt = nextRetry(null, 1);

  const storedRef = existing?.stored_file_path?.includes('://')
    ? existing.stored_file_path
    : await uploadFile({ bucket: BUCKETS.ocrUploads, folder: `scans/${new Date().toISOString().slice(0, 7)}`, file });

  let scan;
  try {
    scan = await withTransaction(async (client) => {
      const values = [safeOriginalName(file.originalname), storedRef, file.mimetype, file.size, fileHash, analysis.documentType, analysis.confidence, analysis.ocrText,
        JSON.stringify(analysis.extractedData), processingStatus, processingError, captureSource, JSON.stringify(analysis.authenticity),
        currentUserId(req), retryAt ? 1 : 0, retryAt, JSON.stringify(analysis.crossCheck || {})];
      const result = existing
        ? await client.query(
          `UPDATE document_scans SET original_file_name = $1, stored_file_path = $2, mime_type = $3, file_size = $4, detected_document_type = $6,
                  ai_confidence = $7, confidence = NULL, ocr_text = $8, extracted_data = $9, processing_status = $10, processing_error = $11, capture_source = $12,
                  authenticity = $13, uploaded_by = $14, retry_count = $15, next_retry_at = $16, cross_check = $17,
                  verification = '{}'::jsonb, review_status = 'needs_review', updated_at = NOW()
           WHERE file_sha256 = $5 RETURNING *`, values)
        : await client.query(
          `INSERT INTO document_scans (original_file_name, stored_file_path, mime_type, file_size, file_sha256, detected_document_type, ai_confidence, ocr_text,
                                       extracted_data, processing_status, processing_error, capture_source, authenticity, uploaded_by, retry_count, next_retry_at, cross_check)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`, values);
      await createAuditLog({
        client,
        user: req.user,
        action: processingStatus === 'failed' ? 'OCR_FAILED' : 'DOCUMENT_UPLOADED',
        module: 'OCR',
        entityType: 'document_scan',
        entityId: String(result.rows[0].id),
        description: `${existing ? 'Re-processed' : captureSource === 'camera' ? 'Scanned and processed' : 'Uploaded and processed'} ${file.originalname}`,
        newValues: { file_name: safeOriginalName(file.originalname), document_type: analysis.documentType, processing_status: processingStatus, capture_source: captureSource },
        ...getRequestMeta(req),
        status: processingStatus === 'failed' ? 'FAILED' : 'SUCCESS',
      });
      return result.rows[0];
    });
  } catch (error) {
    if (!existing) await removeFile(storedRef);
    throw error;
  }

  if (processingStatus === 'failed') {
    return res.status(existing ? 200 : 201).json({
      success: false, data: mapScan(scan), message: `The document was saved but could not be read yet: ${withoutStop(aiFailureReason(new Error(processingError)))}.${retryNote(scan)}`,
    });
  }

  const verified = await verifyAndAutoPost(req, scan, 'Document processed.');
  return res.status(existing ? 200 : 201).json({ success: true, data: mapScan(verified.scan), message: verified.message });
}

// Keeps the verification and its score: the system's confidence in the scan.
async function saveVerification(id, verification) {
  return (await query('UPDATE document_scans SET verification = $1, confidence = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
    [JSON.stringify(verification), verification.score ?? null, id])).rows[0];
}

const verifyScan = (req, scan, documentType = scan.detected_document_type, extractedData = scan.extracted_data || {}) => verifyDocument(req, scan, {
  documentType, extractedData, authenticity: scan.authenticity || {},
});

// What a scanned form still needs from the admin: the valid IDs (the
// membership applicant's, or the loan borrower's and co-maker's), and a 2x2
// picture when the one on a membership form could not be recognised.
function missingRequirements(scan) {
  const missing = idRequirements(scan.detected_document_type).filter((requirement) => !scan[ID_SLOTS[requirement.slot].path])
    .map((requirement) => `the ${requirement.person}'s valid ID with ${REQUIRED_ID_SIGNATURES} specimen signatures${requirement.cardCapture ? ' (or the ID captured with the live camera)' : ''}`);
  if (photoExpected(scan.detected_document_type) && !scan.photo_path && scan.authenticity?.photoRecognized !== true) missing.push('a 2x2 picture, because the one on the form cannot be recognized');
  return missing;
}

const listed = (items) => (items.length > 2 ? `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}` : items.join(' and '));

// The person a scanned form is about, for the admins' notifications.
function formPerson(scan) {
  const data = scan.extracted_data || {};
  return [data.firstName, data.middleName, data.lastName, data.suffix].filter(Boolean).join(' ') || data.memberName || data.preparedBy || data.encoderName || '';
}

// Verifies a scan against the records and posts it when every check passed.
// Verification and posting are separate steps: if they fail the scan is
// still saved and can be reviewed and posted by an admin. A scan whose
// automatic save was undone is never saved again automatically.
// background: no admin is watching (an automatic retry), so the admins are
// told when the scan needs them.
async function verifyAndAutoPost(req, scan, message, { background = false } = {}) {
  let current = scan;
  try {
    const verification = await verifyScan(req, current);
    current = await saveVerification(current.id, verification);
    if (autoPostEnabled() && isPostable(current.detected_document_type) && verification.status === 'passed' && !current.undone_at) {
      const posted = await postScan(req, current.id, { automatic: true });
      return { scan: posted.scan, message: `Every check passed; saved automatically: ${posted.result.label}.` };
    }
    if (background && isPostable(current.detected_document_type)) {
      const flagged = verification.checks.filter((check) => check.status !== 'pass').map((check) => check.label);
      await notifyAdmins(null, {
        type: 'ocr_needs_review', title: `Scan needs review: ${current.detected_document_type}${formPerson(current) ? ` of ${formPerson(current)}` : ''}`.slice(0, 200),
        message: `Scan #${current.id} was read after the AI was busy. ${flagged.length ? `Check: ${flagged.join(', ')}.` : ''}`.trim(),
        severity: 'warning', link: `/ocr?scan=${current.id}`, entityType: 'document_scan', entityId: current.id, dedupeKey: `ocr-review-${current.id}`,
      }).catch(() => undefined);
    }
    const missing = missingRequirements(current);
    if (missing.length) return { scan: current, message: `${current.detected_document_type.replace(/ Form$/, ' form')} read. Now submit ${listed(missing)}.` };
    if (isPostable(current.detected_document_type)) {
      return { scan: current, message: verification.status === 'failed' ? 'Verification found problems. The flagged fields are highlighted for review.' : 'Some checks need a look. The flagged fields are highlighted; confirm them before saving.' };
    }
    return { scan: current, message };
  } catch (error) {
    console.error('OCR verification error:', error instanceof Error ? error.message : error);
    return { scan: current, message: 'Document read, but automatic verification could not finish. Review and verify it manually.' };
  }
}

// "New member auto-registered: Juan Dela Cruz" and the like.
function autoPostTitle(scan, result) {
  const person = formPerson(scan);
  const titles = {
    members: `New member auto-registered: ${person || result.recordId}`,
    loans: `Loan application auto-filed${person ? `: ${person}` : ''} (awaiting approval)`,
    machinery: `Rental request auto-filed${person ? `: ${person}` : ''} (awaiting approval)`,
    savings: `Savings deposit auto-recorded${person ? `: ${person}` : ''}`,
  };
  return (titles[result.module] || `Form saved automatically: ${result.label}`).slice(0, 200);
}

// Posts a scan to its module inside one transaction with the scan update, so a
// form is never recorded twice and never marked posted without its record.
// An automatic save is logged and announced to the admins, with the time
// left to undo it.
async function postScan(req, id, { automatic }) {
  const posted = await withTransaction(async (client) => {
    const scan = (await client.query('SELECT * FROM document_scans WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!scan) throw notFound('Document scan not found.');
    if (scan.posted_at) throw conflict(`This document was already posted (${scan.posted_module} ${scan.posted_record_id}).`);
    const result = await postDocument(client, req, scan, scan.detected_document_type, scan.extracted_data || {}, scan.verification?.target || {});
    const updated = (await client.query(
      `UPDATE document_scans SET review_status = 'posted', posted_module = $1, posted_record_id = $2, posted_at = NOW(), posted_by = $3,
              posted_automatically = $4, reviewed_by = COALESCE($5, reviewed_by), next_retry_at = NULL, updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [result.module, result.recordId, currentUserId(req), automatic, automatic ? null : currentUserId(req), id]
    )).rows[0];
    await createAuditLog({
      client,
      user: req.user,
      action: 'OCR_DOCUMENT_POSTED',
      module: 'OCR',
      entityType: 'document_scan',
      entityId: String(id),
      description: `${automatic ? 'AI posted (every check passed)' : 'Posted'} ${scan.detected_document_type} ${scan.original_file_name}: ${result.label}`,
      newValues: { document_type: scan.detected_document_type, module: result.module, record_id: result.recordId, automatic, checks_passed: scan.confidence === null ? null : Number(scan.confidence) },
      ...getRequestMeta(req),
    });
    if (automatic) {
      const undoUntil = undoDeadline(updated);
      await notifyAdmins(client, {
        type: 'ocr_auto_posted', title: autoPostTitle(updated, result), severity: 'success',
        message: `${result.label} from scan #${id}; every check passed.${undoUntil ? ` It can be undone in the OCR Scanner for ${UNDO_WINDOW_HOURS} hours.` : ''}`,
        link: `/ocr?scan=${id}`, entityType: 'document_scan', entityId: id, dedupeKey: `ocr-posted-${id}`,
      });
    }
    return { scan: updated, result };
  });
  // The member hears about the record the scanner created (after commit).
  if (posted.result.memberId && posted.result.email) void emailMember(posted.result.memberId, posted.result.email);
  return posted;
}

const EXTRACTED_VALUE_MAX = 2000;

function validateExtractedData(documentType, extractedData) {
  if (!extractedData || typeof extractedData !== 'object' || Array.isArray(extractedData)) throw badRequest('Extracted information must be a set of named fields.');
  const entries = Object.entries(extractedData);
  if (entries.length > 60) throw badRequest('Too many extracted fields.');
  const cleaned = {};
  for (const [key, value] of entries) {
    const name = cleanString(key, 100);
    if (!name) continue;
    if (value !== null && typeof value === 'object') throw badRequest(`Field "${name}" must be plain text.`);
    cleaned[name] = cleanString(String(value ?? ''), EXTRACTED_VALUE_MAX);
  }
  // Cooperative forms keep invalid values so verification can point at them;
  // reference documents are checked here.
  if (isPostable(documentType)) return normalizeExtractedData(documentType, cleaned);
  for (const [key, value] of Object.entries(cleaned)) {
    if (/amount/i.test(key) && value && !/^[₱PHP\s]*[\d,]+(\.\d{1,2})?$/i.test(value)) throw badRequest(`"${key}" must be a valid amount.`);
    if (/date/i.test(key) && value && Number.isNaN(Date.parse(value))) throw badRequest(`"${key}" must be a valid date.`);
  }
  return cleaned;
}

function readReviewInput(body) {
  const documentType = clean(body?.documentType);
  if (!SUPPORTED_TYPES.has(documentType)) throw badRequest('A valid document type is required.');
  return { documentType, extractedData: validateExtractedData(documentType, body?.extractedData) };
}

// Saves the admin's corrections and re-runs verification on the corrected data.
async function saveCorrections(req, id, { documentType, extractedData, reviewStatus }) {
  const scan = await withTransaction(async (client) => {
    const before = (await client.query('SELECT * FROM document_scans WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) throw notFound('Document scan not found.');
    if (before.posted_at) throw conflict('This document was already posted and can no longer be changed.');
    const result = await client.query(
      `UPDATE document_scans SET detected_document_type = $1, extracted_data = $2, review_status = $3::varchar, reviewed_by = $4,
              next_retry_at = CASE WHEN $3::varchar = 'rejected' THEN NULL ELSE next_retry_at END, updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [documentType, JSON.stringify(extractedData), reviewStatus, req.user.user_id, id]
    );
    await createAuditLog({
      client,
      user: req.user,
      action: 'OCR_DATA_UPDATED',
      module: 'OCR',
      entityType: 'document_scan',
      entityId: String(id),
      description: `Reviewed OCR data for ${before.original_file_name}`,
      oldValues: { document_type: before.detected_document_type, extracted_data: before.extracted_data, review_status: before.review_status },
      newValues: { document_type: documentType, extracted_data: extractedData, review_status: reviewStatus },
      ...getRequestMeta(req),
    });
    return result.rows[0];
  });
  if (reviewStatus === 'rejected') return scan;
  return saveVerification(id, await verifyScan(req, scan, documentType, extractedData));
}

export async function reviewDocument(req, res) {
  const id = parseId(req.params.id, 'document ID');
  const input = readReviewInput(req.body);
  const reviewStatus = req.body?.reviewStatus === 'rejected' ? 'rejected' : 'reviewed';
  const scan = await saveCorrections(req, id, { ...input, reviewStatus });
  return res.status(200).json({ success: true, data: mapScan(scan), message: reviewStatus === 'rejected' ? 'Document rejected.' : 'Document review saved.' });
}

// POST /api/ocr/:id/post { documentType, extractedData, acknowledgeWarnings }
// Saves the corrections, verifies again, and posts only when nothing failed.
// Warnings must be acknowledged by the admin who compared the paper form.
export async function postReviewedDocument(req, res) {
  const id = parseId(req.params.id, 'document ID');
  const input = readReviewInput(req.body);
  if (!isPostable(input.documentType)) throw badRequest(`${input.documentType} documents are kept for reference and are not posted to a module.`);
  const scan = await saveCorrections(req, id, { ...input, reviewStatus: 'reviewed' });
  const { verification } = scan;
  if (verification.status === 'failed') {
    const failed = verification.checks.filter((check) => check.status === 'fail').map((check) => check.message);
    throw new AppError(422, `This document cannot be posted: ${failed[0]}`, failed);
  }
  if (verification.status === 'warning' && req.body?.acknowledgeWarnings !== true) {
    throw new AppError(422, 'Confirm that you compared the flagged items with the original paper form before posting.');
  }
  const posted = await postScan(req, id, { automatic: false });
  return res.status(200).json({ success: true, data: mapScan(posted.scan), message: `${posted.result.label}.` });
}

// POST /api/ocr/:id/verify — re-runs verification (e.g. after the member was
// registered or stock changed) without changing the extracted data.
export async function reverifyDocument(req, res) {
  const id = parseId(req.params.id, 'document ID');
  const scan = (await query('SELECT * FROM document_scans WHERE id = $1', [id])).rows[0];
  if (!scan) throw notFound('Document scan not found.');
  if (scan.posted_at) return res.status(200).json({ success: true, data: mapScan(scan) });
  return res.status(200).json({ success: true, data: mapScan(await saveVerification(id, await verifyScan(req, scan))) });
}

const storedFileOf = async (row) => {
  const buffer = await downloadFile(row.stored_file_path);
  return buffer ? { buffer, mimetype: row.mime_type, originalname: row.original_file_name, size: Number(row.file_size) } : null;
};

// Records a failed try: the next automatic one, or the admins are told that
// the AI gave up on the scan.
async function recordFailedTry(row, error, { field = 'processing_error' } = {}) {
  const failures = Number(row.retry_count || 0) + 1;
  const retryAt = nextRetry(error, failures);
  const message = error instanceof Error ? error.message.slice(0, 500) : 'AI analysis failed.';
  const updated = field === 'processing_error'
    ? (await query('UPDATE document_scans SET processing_error = $1, retry_count = $2, next_retry_at = $3, updated_at = NOW() WHERE id = $4 RETURNING *', [message, failures, retryAt, row.id])).rows[0]
    : (await query('UPDATE document_scans SET cross_check = $1, retry_count = $2, next_retry_at = $3, updated_at = NOW() WHERE id = $4 RETURNING *', [JSON.stringify(crossCheckError(error)), failures, retryAt, row.id])).rows[0];
  if (!retryAt && row.next_retry_at) {
    await notifyAdmins(null, {
      type: 'ocr_failed', title: `AI could not read scan #${row.id}`, severity: 'warning', link: `/ocr?scan=${row.id}`,
      message: `${row.original_file_name} was tried ${failures} times: ${withoutStop(aiFailureReason(error))}. Open it and press Retry, or upload a clearer copy.`,
      entityType: 'document_scan', entityId: row.id, dedupeKey: `ocr-failed-${row.id}-${failures}`,
    }).catch(() => undefined);
  }
  return updated;
}

// Reads the stored file of a scan whose reading failed, then verifies it and
// posts it when every check passed, exactly like a new upload. Returns
// { scan, message } or throws the AI error after recording the failed try.
async function rereadScan(req, row, { background = false } = {}) {
  const file = await storedFileOf(row);
  if (!file) {
    await query('UPDATE document_scans SET next_retry_at = NULL WHERE id = $1', [row.id]);
    throw notFound('The stored file is no longer available. Upload the document again.');
  }
  let analysis;
  try {
    analysis = await analyzeWithAi(file, row.capture_source);
  } catch (error) {
    const updated = await recordFailedTry(row, error);
    error.scan = updated;
    throw error;
  }
  const crossRetry = analysis.crossCheck?.error ? nextRetry(null, 1) : null;
  const scan = (await query(
    `UPDATE document_scans SET detected_document_type = $1, ai_confidence = $2, ocr_text = $3, extracted_data = $4, authenticity = $5, cross_check = $6,
            processing_status = 'completed', processing_error = NULL, retry_count = $7, next_retry_at = $8,
            verification = '{}'::jsonb, review_status = 'needs_review', updated_at = NOW()
     WHERE id = $9 RETURNING *`,
    [analysis.documentType, analysis.confidence, analysis.ocrText, JSON.stringify(analysis.extractedData), JSON.stringify(analysis.authenticity),
      JSON.stringify(analysis.crossCheck || {}), crossRetry ? 1 : 0, crossRetry, row.id]
  )).rows[0];
  await createAuditLog({
    user: req.user, action: 'OCR_RETRIED', module: 'OCR', entityType: 'document_scan', entityId: String(row.id),
    description: `${background ? 'Automatically re-read' : 'Re-read'} ${row.original_file_name}`, newValues: { document_type: analysis.documentType, attempt: Number(row.retry_count || 0) + 1 }, ...getRequestMeta(req),
  });
  return verifyAndAutoPost(req, scan, 'Document read.', { background });
}

// Runs only the second reading again, for a scan read once while the AI was
// busy, then verifies it again (and posts it when every check passed).
async function rereadCrossCheck(req, row, { background = false } = {}) {
  const file = await storedFileOf(row);
  if (!file) {
    await query('UPDATE document_scans SET next_retry_at = NULL WHERE id = $1', [row.id]);
    return { scan: row, message: 'The stored file is no longer available.' };
  }
  let secondJson;
  try {
    secondJson = await readAgain(file);
  } catch (error) {
    return { scan: await recordFailedTry(row, error, { field: 'cross_check' }), message: 'The second reading is still not possible.' };
  }
  const crossCheck = crossCheckOf({ documentType: row.detected_document_type, extractedData: row.cross_check?.first || row.extracted_data || {} }, secondJson);
  const scan = (await query('UPDATE document_scans SET cross_check = $1, retry_count = 0, next_retry_at = NULL, updated_at = NOW() WHERE id = $2 RETURNING *',
    [JSON.stringify(crossCheck), row.id])).rows[0];
  return verifyAndAutoPost(req, scan, 'Second reading done.', { background });
}

// POST /api/ocr/:id/retry — runs the AI again on the stored file of a scan
// whose reading failed (e.g. the AI service was busy), without waiting for
// the next automatic try.
export async function retryDocument(req, res) {
  const id = parseId(req.params.id, 'document ID');
  const row = (await query('SELECT * FROM document_scans WHERE id = $1', [id])).rows[0];
  if (!row) throw notFound('Document scan not found.');
  if (row.processing_status !== 'failed') throw conflict('This document was already read. Use Check again to re-verify it.');
  try {
    const verified = await rereadScan(req, row);
    return res.status(200).json({ success: true, data: mapScan(verified.scan), message: verified.message });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, `${withoutStop(aiFailureReason(error))}.${error.scan ? retryNote(error.scan) : ''}`);
  }
}

// The admin a background retry acts for: the one who uploaded the scan.
async function backgroundRequest(userId) {
  const user = userId ? (await query('SELECT id, id AS user_id, username, role, email FROM users WHERE id = $1', [userId])).rows[0] : null;
  return { user: user || null, ip: null, headers: { 'user-agent': 'ACIFAC OCR automatic retry' }, get: () => undefined };
}

// The retry queue: reads again the scans whose next try is due, one or a few
// at a time. Each scan is held for a few minutes while it is read, so the
// server timer, the cron job and an open OCR Scanner page never read the same
// scan twice. Returns the scans processed.
export async function retryDueScans({ limit = 1 } = {}) {
  const claimed = (await query(
    `UPDATE document_scans SET next_retry_at = NOW() + INTERVAL '${RETRY_LEASE}'
     WHERE id IN (SELECT id FROM document_scans
                  WHERE next_retry_at <= NOW() AND posted_at IS NULL AND review_status <> 'rejected'
                  ORDER BY next_retry_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING *`, [limit]
  )).rows;
  const processed = [];
  for (const row of claimed) {
    // The row as it was before it was held: its retry count and when it was due.
    const due = { ...row, next_retry_at: new Date() };
    try {
      const req = await backgroundRequest(row.uploaded_by);
      const result = row.processing_status === 'failed' ? await rereadScan(req, due, { background: true }) : await rereadCrossCheck(req, due, { background: true });
      processed.push(result.scan);
    } catch (error) {
      console.warn(`OCR automatic retry of scan #${row.id}:`, error instanceof Error ? error.message : error);
      if (error?.scan) processed.push(error.scan);
    }
  }
  return processed;
}

// POST /api/ocr/retry-due — called by the open OCR Scanner page every few
// seconds while scans are queued (serverless hosting has no timers), so a
// busy AI never leaves a scan waiting for someone to press Retry.
export async function retryDue(req, res) {
  const processed = await retryDueScans({ limit: 1 });
  const queued = (await query('SELECT COUNT(*)::int AS count, MIN(next_retry_at) AS next FROM document_scans WHERE next_retry_at IS NOT NULL')).rows[0];
  return res.status(200).json({ success: true, data: processed.map(mapScan), queued: queued.count, nextAt: queued.next });
}

// POST /api/ocr/reject-flagged — rejects, in one go, every scan that is
// flagged: not saved, not already rejected, and either failed verification or
// could not be read. Scans still queued for another automatic reading are
// left alone. Nothing is deleted; the scans stay in the records as Rejected.
export async function rejectFlagged(req, res) {
  const rejected = await withTransaction(async (client) => {
    const rows = (await client.query(
      `UPDATE document_scans SET review_status = 'rejected', reviewed_by = $1, next_retry_at = NULL, updated_at = NOW()
       WHERE posted_at IS NULL AND review_status <> 'rejected' AND next_retry_at IS NULL
         AND (processing_status = 'failed' OR verification->>'status' = 'failed')
       RETURNING *`,
      [currentUserId(req)]
    )).rows;
    if (rows.length) {
      await createAuditLog({
        client, user: req.user, action: 'OCR_FLAGGED_REJECTED', module: 'OCR', entityType: 'document_scan',
        description: `Rejected ${rows.length} flagged ${rows.length === 1 ? 'scan' : 'scans'}`, newValues: { scan_ids: rows.map((row) => Number(row.id)) }, ...getRequestMeta(req),
      });
    }
    return rows;
  });
  return res.status(200).json({
    success: true, data: rejected.map(mapScan),
    message: rejected.length ? `${rejected.length} flagged ${rejected.length === 1 ? 'scan was' : 'scans were'} rejected. They will not be saved to any module.` : 'There are no flagged scans.',
  });
}

// DELETE /api/ocr/:id — deletes a scan that is not needed (a wrong or test
// upload, a rejected form) with its stored file, IDs and 2x2 picture. A scan
// saved to records cannot be deleted: the member or loan it created uses its
// files. The deletion is kept in the audit log.
export async function deleteScan(req, res) {
  const id = parseId(req.params.id, 'document ID');
  const deleted = await withTransaction(async (client) => {
    const row = (await client.query('SELECT * FROM document_scans WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!row) throw notFound('Document scan not found.');
    if (row.posted_at) throw conflict(`This scan was saved to records (${row.posted_module} ${row.posted_record_id}) and cannot be deleted.`);
    await client.query('DELETE FROM document_scans WHERE id = $1', [id]);
    await createAuditLog({
      client, user: req.user, action: 'OCR_SCAN_DELETED', module: 'OCR', entityType: 'document_scan', entityId: String(id),
      description: `Deleted scan #${id} ${row.original_file_name} (${row.detected_document_type}, ${row.review_status})`,
      oldValues: { file_name: row.original_file_name, document_type: row.detected_document_type, review_status: row.review_status, extracted_data: row.extracted_data },
      ...getRequestMeta(req),
    });
    return row;
  });
  // The files go after the commit, so a failed delete never loses them.
  for (const reference of [deleted.stored_file_path, deleted.photo_path, ...Object.values(ID_SLOTS).map((columns) => deleted[columns.path])]) {
    if (reference) await removeFile(reference);
  }
  return res.status(200).json({ success: true, message: `Scan ${deleted.original_file_name} deleted.` });
}

// POST /api/ocr/:id/undo — takes back a form the scanner saved by itself,
// within UNDO_WINDOW_HOURS: the new member, or the loan application or rental
// request still waiting for approval, is removed and the scan goes back to
// review, where it is only saved again by an admin.
export async function undoAutoPost(req, res) {
  const id = parseId(req.params.id, 'document ID');
  const scan = await withTransaction(async (client) => {
    const before = (await client.query('SELECT * FROM document_scans WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) throw notFound('Document scan not found.');
    if (!before.posted_at) throw conflict('This document has not been saved to a module.');
    if (!before.posted_automatically) throw conflict('Only forms saved automatically can be undone here. Correct this record in its module.');
    const deadline = undoDeadline(before);
    if (!deadline) throw conflict(`${before.posted_module} records are corrected in their own module.`);
    if (deadline < new Date()) throw conflict(`The ${UNDO_WINDOW_HOURS}-hour undo period has passed. Correct the record in its module.`);
    const label = await undoPostedRecord(client, before);
    const updated = (await client.query(
      `UPDATE document_scans SET review_status = 'needs_review', posted_module = NULL, posted_record_id = NULL, posted_at = NULL, posted_by = NULL,
              posted_automatically = FALSE, undone_at = NOW(), undone_by = $1, undone_record_id = $2, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [currentUserId(req), before.posted_record_id, id]
    )).rows[0];
    await createAuditLog({
      client, user: req.user, action: 'OCR_AUTO_POST_UNDONE', module: 'OCR', entityType: 'document_scan', entityId: String(id),
      description: `Undid the automatic save of ${before.detected_document_type} ${before.original_file_name}: ${label}`,
      oldValues: { module: before.posted_module, record_id: before.posted_record_id, posted_at: before.posted_at }, ...getRequestMeta(req),
    });
    return { updated, label };
  });
  const verified = await saveVerification(id, await verifyScan(req, scan.updated)).catch(() => scan.updated);
  return res.status(200).json({ success: true, data: mapScan(verified), message: `${scan.label}. The scan is back in review; it is saved again only when you save it.` });
}

// slot: the ID being submitted (holder or coMaker); photo: the 2x2 picture.
function assertTakesRequirements(scan, { slot, photo = false }) {
  if (!scan) throw notFound('Document scan not found.');
  if (scan.posted_at) throw conflict('This document was already saved; its IDs and picture can no longer be changed.');
  if (scan.review_status === 'rejected') throw conflict('This document was rejected.');
  if (photo && !photoExpected(scan.detected_document_type)) throw badRequest('Only a scanned membership form takes a 2x2 picture.');
  if (slot && !idRequirement(scan.detected_document_type, slot)) {
    throw badRequest(slot === 'coMaker' ? 'Only a scanned loan form takes the co-maker\'s ID.' : 'Only a scanned membership or loan form takes a valid ID.');
  }
}

// POST /api/ocr/:id/id-document and /api/ocr/:id/co-maker-id
// (multipart: idDocument, source = upload | camera)
// A scanned membership form is saved only with the applicant's valid ID: an
// uploaded back-to-back copy with three specimen signatures, or the ID card
// captured with the live camera. A scanned loan form is saved only with the
// borrower's ID (id-document) and the co-maker's ID (co-maker-id), each a
// back-to-back copy with their three specimen signatures, uploaded or taken
// with the camera. AI reads the ID, the form is verified again with it, and
// saved automatically when every check passes.
function attachIdTo(slot) {
  const columns = ID_SLOTS[slot];
  return async (req, res) => {
    const id = parseId(req.params.id, 'document ID');
    const file = req.file;
    assertValidUpload(file, UPLOAD_TYPES, 'ID');
    const source = req.body?.source === 'camera' ? 'camera' : 'upload';
    if (source === 'camera' && !file.mimetype.startsWith('image/')) throw badRequest('A camera capture must be a picture.');
    const row = (await query('SELECT * FROM document_scans WHERE id = $1', [id])).rows[0];
    assertTakesRequirements(row, { slot });
    const documentType = row.detected_document_type;
    const { person, cardCapture } = idRequirement(documentType, slot);

    // An unreadable ID is still kept; verification then asks the admin to check it.
    let reading;
    try {
      reading = await readIdWithAi(file, source, documentType, slot);
    } catch (error) {
      console.error('OCR ID reading error:', error instanceof Error ? error.message : error);
      reading = { ...normalizeIdReading(null), error: aiFailureReason(error) };
    }

    const folder = FORM_DEFINITIONS[documentType].module === 'loans' ? 'loans' : 'members';
    const storedRef = await uploadFile({ bucket: BUCKETS.memberDocuments, folder: `${folder}/${todayDateOnly().slice(0, 7)}`, file });
    let previousRef = null;
    let scan;
    try {
      scan = await withTransaction(async (client) => {
        const before = (await client.query('SELECT * FROM document_scans WHERE id = $1 FOR UPDATE', [id])).rows[0];
        assertTakesRequirements(before, { slot });
        previousRef = before[columns.path];
        // A membership form's ID type and number are taken from the ID when the form left them blank.
        const extractedData = { ...(before.extracted_data || {}) };
        const formKeys = FORM_DEFINITIONS[documentType].fields.map((field) => field.key);
        if (slot === 'holder' && formKeys.includes('idType') && !String(extractedData.idType || '').trim() && reading.idType) extractedData.idType = reading.idType;
        if (slot === 'holder' && formKeys.includes('idNumber') && !String(extractedData.idNumber || '').trim() && reading.idNumber) extractedData.idNumber = reading.idNumber;
        const updated = (await client.query(
          `UPDATE document_scans SET ${columns.path} = $1, ${columns.name} = $2, ${columns.type} = $3, ${columns.size} = $4, ${columns.source} = $5,
                  ${columns.check} = $6, extracted_data = $7, updated_at = NOW()
           WHERE id = $8 RETURNING *`,
          [storedRef, safeOriginalName(file.originalname), file.mimetype, file.size, source, JSON.stringify(reading), JSON.stringify(extractedData), id]
        )).rows[0];
        const how = cardCapture && source === 'camera' ? 'live camera' : source === 'camera' ? 'back-to-back copy taken with the camera' : 'back-to-back copy';
        await createAuditLog({
          client,
          user: req.user,
          action: 'OCR_ID_ATTACHED',
          module: 'OCR',
          entityType: 'document_scan',
          entityId: String(id),
          description: `${previousRef ? 'Replaced' : 'Submitted'} the ${person}'s ID (${how}) for ${before.original_file_name}`,
          newValues: { holder: person, file_name: safeOriginalName(file.originalname), source, id_type: reading.idType, signature_count: reading.signatureCount },
          ...getRequestMeta(req),
        });
        return updated;
      });
    } catch (error) {
      await removeFile(storedRef);
      throw error;
    }
    if (previousRef) await removeFile(previousRef);

    const verified = await verifyAndAutoPost(req, scan, 'ID submitted.');
    return res.status(200).json({
      success: true, data: mapScan(verified.scan),
      message: reading.error ? `The ID was saved, but AI could not read it (${reading.error}). Check it yourself or submit it again.` : verified.message,
    });
  };
}

export const attachIdDocument = attachIdTo('holder');
export const attachCoMakerId = attachIdTo('coMaker');

// POST /api/ocr/:id/photo (multipart: photo)
// The applicant's 2x2 picture, asked for when AI cannot recognise the one in
// the form's photo box. AI checks it shows one clear face; it becomes the
// member's photo when the form is saved.
export async function attachPhoto(req, res) {
  const id = parseId(req.params.id, 'document ID');
  const file = req.file;
  assertValidUpload(file, IMAGE_TYPES, '2x2 picture');
  assertTakesRequirements((await query('SELECT * FROM document_scans WHERE id = $1', [id])).rows[0], { photo: true });

  let reading;
  try {
    reading = await readPhotoWithAi(file);
  } catch (error) {
    console.error('OCR photo check error:', error instanceof Error ? error.message : error);
    reading = { ...normalizePhotoReading(null), error: aiFailureReason(error) };
  }

  const storedRef = await uploadFile({ bucket: BUCKETS.memberPhotos, folder: `members/${todayDateOnly().slice(0, 7)}`, file });
  let previousRef = null;
  let scan;
  try {
    scan = await withTransaction(async (client) => {
      const before = (await client.query('SELECT * FROM document_scans WHERE id = $1 FOR UPDATE', [id])).rows[0];
      assertTakesRequirements(before, { photo: true });
      previousRef = before.photo_path;
      const updated = (await client.query(
        'UPDATE document_scans SET photo_path = $1, photo_check = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
        [storedRef, JSON.stringify(reading), id]
      )).rows[0];
      await createAuditLog({
        client,
        user: req.user,
        action: 'OCR_PHOTO_ATTACHED',
        module: 'OCR',
        entityType: 'document_scan',
        entityId: String(id),
        description: `${previousRef ? 'Replaced' : 'Uploaded'} the applicant's 2x2 picture for ${before.original_file_name}`,
        newValues: { file_name: safeOriginalName(file.originalname), face_visible: reading.faceVisible },
        ...getRequestMeta(req),
      });
      return updated;
    });
  } catch (error) {
    await removeFile(storedRef);
    throw error;
  }
  if (previousRef) await removeFile(previousRef);

  const verified = await verifyAndAutoPost(req, scan, '2x2 picture uploaded.');
  return res.status(200).json({
    success: true, data: mapScan(verified.scan),
    message: reading.error ? `The picture was saved, but AI could not check it (${reading.error}). Check it yourself or upload it again.` : verified.message,
  });
}

export async function downloadPhoto(req, res) {
  const id = parseId(req.params.id, 'document ID');
  const row = (await query('SELECT photo_path FROM document_scans WHERE id = $1', [id])).rows[0];
  if (!row?.photo_path) throw notFound('No 2x2 picture was uploaded with this document.');
  const sent = await sendStoredFile(res, { reference: row.photo_path, mimeType: photoMimeType(row.photo_path), fileName: '2x2-picture' });
  if (!sent) throw notFound('The stored file is no longer available.');
  return undefined;
}

function downloadIdFrom(slot) {
  const columns = ID_SLOTS[slot];
  return async (req, res) => {
    const id = parseId(req.params.id, 'document ID');
    const row = (await query(`SELECT ${columns.path} AS path, ${columns.type} AS type, ${columns.name} AS name FROM document_scans WHERE id = $1`, [id])).rows[0];
    if (!row?.path) throw notFound(slot === 'coMaker' ? 'No co-maker ID was submitted with this document.' : 'No ID was submitted with this document.');
    const sent = await sendStoredFile(res, { reference: row.path, mimeType: row.type, fileName: row.name });
    if (!sent) throw notFound('The stored file is no longer available.');
    return undefined;
  };
}

export const downloadIdDocument = downloadIdFrom('holder');
export const downloadCoMakerId = downloadIdFrom('coMaker');

export function listFormDefinitions(req, res) {
  return res.status(200).json({
    success: true, data: publicFormDefinitions(), autoPost: autoPostEnabled(), requiredIdSignatures: REQUIRED_ID_SIGNATURES, undoWindowHours: UNDO_WINDOW_HOURS,
  });
}

export async function listDocuments(req, res) {
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 100 });
  const [result, count, stats] = await Promise.all([
    query('SELECT * FROM document_scans ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2', [limit, offset]),
    query('SELECT COUNT(*)::int AS total FROM document_scans'),
    query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE review_status = 'reviewed')::int AS reviewed,
                  COUNT(*) FILTER (WHERE review_status = 'needs_review')::int AS "needsReview",
                  COUNT(*) FILTER (WHERE processing_status = 'failed')::int AS failed,
                  COUNT(*) FILTER (WHERE posted_at IS NOT NULL)::int AS posted,
                  COUNT(*) FILTER (WHERE posted_automatically)::int AS "autoPosted",
                  COUNT(*) FILTER (WHERE next_retry_at IS NOT NULL)::int AS queued
           FROM document_scans`),
  ]);
  return res.status(200).json({ success: true, data: result.rows.map(mapScan), pagination: paginationMeta(page, limit, count.rows[0].total), summary: stats.rows[0] });
}

export async function downloadDocument(req, res) {
  const id = parseId(req.params.id, 'document ID');
  const row = (await query('SELECT stored_file_path, mime_type, original_file_name FROM document_scans WHERE id = $1', [id])).rows[0];
  if (!row) throw notFound('Document scan not found.');
  const sent = await sendStoredFile(res, { reference: row.stored_file_path, mimeType: row.mime_type, fileName: row.original_file_name });
  if (!sent) throw notFound('The stored file is no longer available.');
  return undefined;
}
