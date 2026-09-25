import crypto from 'node:crypto';
import { query, withTransaction } from '../config/db.js';
import { createAuditLog } from '../utils/audit.js';
import { AppError, badRequest, cleanString, conflict, currentUserId, getRequestMeta, notFound, parseId, parsePagination, paginationMeta } from '../utils/http.js';
import { assertValidUpload, BUCKETS, removeFile, safeOriginalName, sendStoredFile, uploadFile } from '../services/storage.js';
import { DOCUMENT_TYPES as UPLOAD_TYPES } from '../middleware/upload.js';
import {
  buildAnalysisPrompt, DOCUMENT_TYPES, FORM_DEFINITIONS, isPostable, normalizeAuthenticity, normalizeDocumentType, normalizeExtractedData,
  postDocument, publicFormDefinitions, UNRECOGNIZED, verifyDocument,
} from '../services/documentRouting.js';

const SUPPORTED_TYPES = new Set(DOCUMENT_TYPES);
// Minimum AI reading confidence before a fully verified form is posted
// without an admin. Set OCR_AUTO_POST=false to always require an admin.
const AUTO_POST_MIN_CONFIDENCE = 85;
const autoPostEnabled = () => String(process.env.OCR_AUTO_POST ?? 'true').toLowerCase() !== 'false';

const clean = (value) => cleanString(value, 200000);

function mapScan(row) {
  return {
    id: Number(row.id), fileName: row.original_file_name, documentType: row.detected_document_type,
    confidence: row.confidence === null ? null : Number(row.confidence), ocrText: row.ocr_text,
    extractedData: row.extracted_data || {}, reviewStatus: row.review_status,
    processingStatus: row.processing_status, processingError: row.processing_error || null,
    captureSource: row.capture_source || 'upload', authenticity: row.authenticity || {}, verification: row.verification || {},
    postable: isPostable(row.detected_document_type), targetModule: FORM_DEFINITIONS[row.detected_document_type]?.moduleLabel || null,
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

function parseModelResponse(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map((part) => part.text || '').join('') : content;
  if (!text) throw new Error('AI returned no analysis.');
  const json = JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim());
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

async function analyzeWithAi(file, captureSource) {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) return analyzeWithGemini(file, geminiKey, captureSource);

  const endpoint = process.env.OCR_AI_URL || 'https://api.openai.com/v1/chat/completions';
  const apiKey = process.env.OCR_AI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('The OCR/AI service is not configured. Set GEMINI_API_KEY or OCR_AI_API_KEY on the server.');

  const base64 = file.buffer.toString('base64');
  const dataUrl = `data:${file.mimetype};base64,${base64}`;
  const content = [{ type: 'text', text: 'Analyze this cooperative document and return JSON only.' }];
  if (file.mimetype.startsWith('image/')) content.push({ type: 'image_url', image_url: { url: dataUrl, detail: 'high' } });
  else content.push({ type: 'text', text: `The uploaded file is a PDF named ${file.originalname}. Use the available document input capability to inspect it.` });

  const response = await fetch(endpoint, {
    signal: AbortSignal.timeout(45000),
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.OCR_AI_MODEL || 'gpt-4o-mini', temperature: 0, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: buildAnalysisPrompt(captureSource) }, { role: 'user', content }],
    }),
  });
  if (!response.ok) throw new Error(`AI service returned ${response.status}.`);
  return parseModelResponse(await response.json());
}

async function analyzeWithGemini(file, apiKey, captureSource) {
  const base64 = file.buffer.toString('base64');
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL || 'gemini-2.5-flash'}:generateContent`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(45000),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        systemInstruction: { parts: [{ text: buildAnalysisPrompt(captureSource) }] },
        contents: [{ parts: [
          { text: 'Read this document including its text, labels, keywords, important fields, and layout. Classify it, extract the fields for its type, and assess whether it is genuine.' },
          { inlineData: { mimeType: file.mimetype, data: base64 } },
        ] }],
      }),
    }
  );
  if (!response.ok) throw new Error(`Gemini service returned ${response.status}.`);
  const payload = await response.json();
  const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('');
  return parseModelResponse({ choices: [{ message: { content: text } }] });
}

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

  // Verification and posting are separate steps: if they fail the scan is
  // still saved and can be reviewed and posted by an admin.
  let message = 'Document processed.';
  try {
    const verification = await verifyDocument(req, scan, {
      documentType: scan.detected_document_type, extractedData: scan.extracted_data || {}, authenticity: scan.authenticity || {}, confidence: analysis.confidence,
    });
    scan = await saveVerification(scan.id, verification);
    if (autoPostEnabled() && isPostable(scan.detected_document_type) && verification.status === 'passed' && (analysis.confidence ?? 0) >= AUTO_POST_MIN_CONFIDENCE) {
      const posted = await postScan(req, scan.id, { automatic: true });
      scan = posted.scan;
      message = `Verified and saved automatically: ${posted.result.label}.`;
    } else if (isPostable(scan.detected_document_type)) {
      message = verification.status === 'failed' ? 'Verification found problems. Review the document before it can be posted.' : 'Document verified with warnings. Review and confirm before posting.';
    }
  } catch (error) {
    console.error('OCR verification error:', error instanceof Error ? error.message : error);
    message = 'Document read, but automatic verification could not finish. Review and verify it manually.';
  }
  return res.status(existing ? 200 : 201).json({ success: true, data: mapScan(scan), message });
}

async function saveVerification(id, verification) {
  return (await query('UPDATE document_scans SET verification = $1, updated_at = NOW() WHERE id = $2 RETURNING *', [JSON.stringify(verification), id])).rows[0];
}

// Posts a scan to its module inside one transaction with the scan update, so a
// form is never recorded twice and never marked posted without its record.
async function postScan(req, id, { automatic }) {
  return withTransaction(async (client) => {
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

export function listFormDefinitions(req, res) {
  return res.status(200).json({ success: true, data: publicFormDefinitions(), autoPost: autoPostEnabled(), autoPostMinConfidence: AUTO_POST_MIN_CONFIDENCE });
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
