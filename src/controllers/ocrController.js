import crypto from 'node:crypto';
import { query, withTransaction } from '../config/db.js';
import { createAuditLog } from '../utils/audit.js';
import { AppError, badRequest, cleanString, conflict, currentUserId, getRequestMeta, notFound, parseId, parsePagination, paginationMeta } from '../utils/http.js';
import { assertValidUpload, BUCKETS, downloadFile, removeFile, safeOriginalName, sendStoredFile, uploadFile } from '../services/storage.js';
import { IMAGE_TYPES, DOCUMENT_TYPES as UPLOAD_TYPES } from '../middleware/upload.js';
import {
  buildAnalysisPrompt, buildIdPrompt, buildPhotoPrompt, DOCUMENT_TYPES, FORM_DEFINITIONS, ID_SLOTS, idRequirement, idRequirements, isPostable, normalizeAuthenticity,
  normalizeDocumentType, normalizeExtractedData, normalizeIdReading, normalizePhotoReading, photoExpected, postDocument, publicFormDefinitions, publicIdRequirements,
  ID_READING_INSTRUCTION, REQUIRED_ID_SIGNATURES, requiresIdDocument, UNRECOGNIZED, verifyDocument,
} from '../services/documentRouting.js';
import { photoMimeType } from './profilePhotoController.js';
import { aiFailureReason, askAi } from '../services/aiClient.js';
import { emailMember } from '../services/memberEmails.js';
import { todayDateOnly } from '../utils/dates.js';

const SUPPORTED_TYPES = new Set(DOCUMENT_TYPES);
// Minimum AI reading confidence before a fully verified form is posted
// without an admin. Set OCR_AUTO_POST=false to always require an admin.
const AUTO_POST_MIN_CONFIDENCE = 85;
const autoPostEnabled = () => String(process.env.OCR_AUTO_POST ?? 'true').toLowerCase() !== 'false';

const clean = (value) => cleanString(value, 200000);

// A valid ID kept on the scan (slot: holder = applicant or borrower, coMaker).
function mapIdDocument(row, slot) {
  const columns = ID_SLOTS[slot];
  if (!row[columns.path]) return null;
  return { fileName: row[columns.name], mimeType: row[columns.type], size: Number(row[columns.size]), source: row[columns.source], reading: row[columns.check] || {} };
}

function mapScan(row) {
  return {
    id: Number(row.id), fileName: row.original_file_name, documentType: row.detected_document_type,
    confidence: row.confidence === null ? null : Number(row.confidence), ocrText: row.ocr_text,
    extractedData: row.extracted_data || {}, reviewStatus: row.review_status,
    processingStatus: row.processing_status, processingError: row.processing_error || null,
    captureSource: row.capture_source || 'upload', authenticity: row.authenticity || {}, verification: row.verification || {},
    postable: isPostable(row.detected_document_type), targetModule: FORM_DEFINITIONS[row.detected_document_type]?.moduleLabel || null,
    requiresIdDocument: requiresIdDocument(row.detected_document_type), photoExpected: photoExpected(row.detected_document_type),
    photo: row.photo_path ? { reading: row.photo_check || {} } : null,
    // The IDs the form needs, and those submitted. idDocument is the holder's, kept for older pages.
    idRequirements: publicIdRequirements(row.detected_document_type),
    idDocuments: Object.fromEntries(Object.keys(ID_SLOTS).map((slot) => [slot, mapIdDocument(row, slot)])),
    idDocument: mapIdDocument(row, 'holder'),
    posted: row.posted_at ? { module: row.posted_module, recordId: row.posted_record_id, at: row.posted_at, automatically: row.posted_automatically } : null,
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

function parseModelResponse(json) {
  const confidence = normalizeConfidence(json.confidence ?? json.confidenceScore ?? json.confidence_percent);
  const documentType = confidence >= 70 ? normalizeDocumentType(json.documentType) : UNRECOGNIZED;
  return {
    documentType,
    confidence,
    ocrText: clean(json.ocrText),
    extractedData: normalizeExtractedData(documentType, json.extractedData),
    authenticity: normalizeAuthenticity(json.authenticity),
  };
}

const analyzeWithAi = async (file, captureSource) => parseModelResponse(await askAi(file, buildAnalysisPrompt(captureSource),
  'Read this document including its text, labels, keywords, important fields, and layout. Classify it, extract the fields for its type, and assess whether it is genuine.'));

const readPhotoWithAi = async (file) => normalizePhotoReading(await askAi(file, buildPhotoPrompt(),
  'Check this 2x2 ID picture: is it one person with a clear, recognizable face?'));

const readIdWithAi = async (file, source, documentType, slot) => normalizeIdReading(await askAi(file, buildIdPrompt(source, documentType, slot), ID_READING_INSTRUCTION));

// Upload/capture -> validate -> store privately -> AI OCR, classification and
// authenticity check -> save scan -> verify against the database -> post to the
// form's module when every check passes. A failed AI run is still recorded
// (processing_status = 'failed') so the upload is auditable, and the same file
// can be re-processed later.
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
  try {
    analysis = await analyzeWithAi(file, captureSource);
  } catch (error) {
    console.error('OCR analysis error:', error instanceof Error ? error.message : error);
    processingStatus = 'failed';
    processingError = error instanceof Error ? error.message.slice(0, 500) : 'AI analysis failed.';
    analysis = { documentType: UNRECOGNIZED, confidence: null, ocrText: '', extractedData: {}, authenticity: normalizeAuthenticity(null) };
  }

  const storedRef = existing?.stored_file_path?.includes('://')
    ? existing.stored_file_path
    : await uploadFile({ bucket: BUCKETS.ocrUploads, folder: `scans/${new Date().toISOString().slice(0, 7)}`, file });

  let scan;
  try {
    scan = await withTransaction(async (client) => {
      const values = [safeOriginalName(file.originalname), storedRef, file.mimetype, file.size, fileHash, analysis.documentType, analysis.confidence, analysis.ocrText,
        JSON.stringify(analysis.extractedData), processingStatus, processingError, captureSource, JSON.stringify(analysis.authenticity)];
      const result = existing
        ? await client.query(
          `UPDATE document_scans SET original_file_name = $1, stored_file_path = $2, mime_type = $3, file_size = $4, detected_document_type = $6,
                  confidence = $7, ocr_text = $8, extracted_data = $9, processing_status = $10, processing_error = $11, capture_source = $12,
                  authenticity = $13, verification = '{}'::jsonb, review_status = 'needs_review', updated_at = NOW()
           WHERE file_sha256 = $5 RETURNING *`, values)
        : await client.query(
          `INSERT INTO document_scans (original_file_name, stored_file_path, mime_type, file_size, file_sha256, detected_document_type, confidence, ocr_text,
                                       extracted_data, processing_status, processing_error, capture_source, authenticity)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`, values);
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
    return res.status(existing ? 200 : 201).json({ success: false, data: mapScan(scan), message: `The document was saved but could not be read: ${processingError}` });
  }

  const verified = await verifyAndAutoPost(req, scan, 'Document processed.');
  return res.status(existing ? 200 : 201).json({ success: true, data: mapScan(verified.scan), message: verified.message });
}

async function saveVerification(id, verification) {
  return (await query('UPDATE document_scans SET verification = $1, updated_at = NOW() WHERE id = $2 RETURNING *', [JSON.stringify(verification), id])).rows[0];
}

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

// Verifies a scan against the records and posts it when every check passes
// with high confidence. Verification and posting are separate steps: if they
// fail the scan is still saved and can be reviewed and posted by an admin.
async function verifyAndAutoPost(req, scan, message) {
  const confidence = scan.confidence === null ? null : Number(scan.confidence);
  let current = scan;
  try {
    const verification = await verifyDocument(req, current, {
      documentType: current.detected_document_type, extractedData: current.extracted_data || {}, authenticity: current.authenticity || {}, confidence,
    });
    current = await saveVerification(current.id, verification);
    if (autoPostEnabled() && isPostable(current.detected_document_type) && verification.status === 'passed' && (confidence ?? 0) >= AUTO_POST_MIN_CONFIDENCE) {
      const posted = await postScan(req, current.id, { automatic: true });
      return { scan: posted.scan, message: `Verified and saved automatically: ${posted.result.label}.` };
    }
    const missing = missingRequirements(current);
    if (missing.length) return { scan: current, message: `${current.detected_document_type.replace(/ Form$/, ' form')} read. Now submit ${listed(missing)}.` };
    if (isPostable(current.detected_document_type)) {
      return { scan: current, message: verification.status === 'failed' ? 'Verification found problems. Review the document before it can be posted.' : 'Document verified with warnings. Review and confirm before posting.' };
    }
    return { scan: current, message };
  } catch (error) {
    console.error('OCR verification error:', error instanceof Error ? error.message : error);
    return { scan: current, message: 'Document read, but automatic verification could not finish. Review and verify it manually.' };
  }
}

// Posts a scan to its module inside one transaction with the scan update, so a
// form is never recorded twice and never marked posted without its record.
async function postScan(req, id, { automatic }) {
  const posted = await withTransaction(async (client) => {
    const scan = (await client.query('SELECT * FROM document_scans WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!scan) throw notFound('Document scan not found.');
    if (scan.posted_at) throw conflict(`This document was already posted (${scan.posted_module} ${scan.posted_record_id}).`);
    const result = await postDocument(client, req, scan, scan.detected_document_type, scan.extracted_data || {}, scan.verification?.target || {});
    const updated = (await client.query(
      `UPDATE document_scans SET review_status = 'posted', posted_module = $1, posted_record_id = $2, posted_at = NOW(), posted_by = $3,
              posted_automatically = $4, reviewed_by = COALESCE($5, reviewed_by), updated_at = NOW()
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
      description: `${automatic ? 'AI posted' : 'Posted'} ${scan.detected_document_type} ${scan.original_file_name}: ${result.label}`,
      newValues: { document_type: scan.detected_document_type, module: result.module, record_id: result.recordId, automatic },
      ...getRequestMeta(req),
    });
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
      `UPDATE document_scans SET detected_document_type = $1, extracted_data = $2, review_status = $3, reviewed_by = $4, updated_at = NOW()
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
  const verification = await verifyDocument(req, scan, {
    documentType, extractedData, authenticity: scan.authenticity || {}, confidence: scan.confidence === null ? null : Number(scan.confidence),
  });
  return saveVerification(id, verification);
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
  const verification = await verifyDocument(req, scan, {
    documentType: scan.detected_document_type, extractedData: scan.extracted_data || {}, authenticity: scan.authenticity || {},
    confidence: scan.confidence === null ? null : Number(scan.confidence),
  });
  return res.status(200).json({ success: true, data: mapScan(await saveVerification(id, verification)) });
}

// POST /api/ocr/:id/retry — runs the AI again on the stored file of a scan
// whose reading failed (e.g. the AI service was busy), then verifies it and
// posts it when every check passes, exactly like a new upload.
export async function retryDocument(req, res) {
  const id = parseId(req.params.id, 'document ID');
  const row = (await query('SELECT * FROM document_scans WHERE id = $1', [id])).rows[0];
  if (!row) throw notFound('Document scan not found.');
  if (row.processing_status !== 'failed') throw conflict('This document was already read. Use Check again to re-verify it.');
  const buffer = await downloadFile(row.stored_file_path);
  if (!buffer) throw notFound('The stored file is no longer available. Upload the document again.');

  let analysis;
  try {
    analysis = await analyzeWithAi({ buffer, mimetype: row.mime_type, originalname: row.original_file_name, size: Number(row.file_size) }, row.capture_source);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'AI analysis failed.';
    await query('UPDATE document_scans SET processing_error = $1, updated_at = NOW() WHERE id = $2', [message, id]);
    throw new AppError(503, message);
  }

  const scan = (await query(
    `UPDATE document_scans SET detected_document_type = $1, confidence = $2, ocr_text = $3, extracted_data = $4, authenticity = $5,
            processing_status = 'completed', processing_error = NULL, verification = '{}'::jsonb, review_status = 'needs_review', updated_at = NOW()
     WHERE id = $6 RETURNING *`,
    [analysis.documentType, analysis.confidence, analysis.ocrText, JSON.stringify(analysis.extractedData), JSON.stringify(analysis.authenticity), id]
  )).rows[0];
  await createAuditLog({ user: req.user, action: 'OCR_RETRIED', module: 'OCR', entityType: 'document_scan', entityId: String(id), description: `Re-read ${row.original_file_name}`, newValues: { document_type: analysis.documentType }, ...getRequestMeta(req) });

  const verified = await verifyAndAutoPost(req, scan, 'Document read.');
  return res.status(200).json({ success: true, data: mapScan(verified.scan), message: verified.message });
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
    success: true, data: publicFormDefinitions(), autoPost: autoPostEnabled(), autoPostMinConfidence: AUTO_POST_MIN_CONFIDENCE, requiredIdSignatures: REQUIRED_ID_SIGNATURES,
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
                  COUNT(*) FILTER (WHERE posted_automatically)::int AS "autoPosted"
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
