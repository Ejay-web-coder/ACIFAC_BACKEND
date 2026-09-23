import crypto from 'node:crypto';
import { query, withTransaction } from '../config/db.js';
import { createAuditLog } from '../utils/audit.js';
import { badRequest, cleanString, conflict, getRequestMeta, notFound, parseId, parsePagination, paginationMeta } from '../utils/http.js';
import { assertValidUpload, BUCKETS, removeFile, safeOriginalName, sendStoredFile, uploadFile } from '../services/storage.js';
import { DOCUMENT_TYPES } from '../middleware/upload.js';

const UNRECOGNIZED = 'Document Type Not Recognized';
const SUPPORTED_TYPES = new Set(['Loan Application', 'Loan Form', 'Payment Receipt', 'ID Document', 'Cooperative Form', UNRECOGNIZED]);

const clean = (value) => cleanString(value, 200000);

function mapScan(row) {
  return {
    id: Number(row.id), fileName: row.original_file_name, documentType: row.detected_document_type,
    confidence: row.confidence === null ? null : Number(row.confidence), ocrText: row.ocr_text,
    extractedData: row.extracted_data || {}, reviewStatus: row.review_status,
    processingStatus: row.processing_status, processingError: row.processing_error || null,
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
  const documentType = SUPPORTED_TYPES.has(json.documentType) ? json.documentType : UNRECOGNIZED;
  const confidence = normalizeConfidence(json.confidence ?? json.confidenceScore ?? json.confidence_percent);
  return {
    documentType: confidence >= 70 ? documentType : UNRECOGNIZED,
    confidence,
    ocrText: clean(json.ocrText),
    extractedData: json.extractedData && typeof json.extractedData === 'object' ? json.extractedData : {},
  };
}

async function analyzeWithAi(file) {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) return analyzeWithGemini(file, geminiKey);

  const endpoint = process.env.OCR_AI_URL || 'https://api.openai.com/v1/chat/completions';
  const apiKey = process.env.OCR_AI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('The OCR/AI service is not configured. Set GEMINI_API_KEY or OCR_AI_API_KEY on the server.');

  const base64 = file.buffer.toString('base64');
  const dataUrl = `data:${file.mimetype};base64,${base64}`;
  const content = [{ type: 'text', text: 'Analyze this cooperative document and return JSON only.' }];
  if (file.mimetype.startsWith('image/')) content.push({ type: 'image_url', image_url: { url: dataUrl, detail: 'high' } });
  else content.push({ type: 'text', text: `The uploaded file is a PDF named ${file.originalname}. Use the available document input capability to inspect it.` });

  const response = await fetch(endpoint, {
    signal: AbortSignal.timeout(60000),
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.OCR_AI_MODEL || 'gpt-4o-mini', temperature: 0, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: 'Return JSON with documentType, confidence (0-100), ocrText, and extractedData. Types: Loan Application, Loan Form, Payment Receipt, ID Document, Cooperative Form, Document Type Not Recognized. Never guess; use Document Type Not Recognized below 70 confidence.' }, { role: 'user', content }],
    }),
  });
  if (!response.ok) throw new Error(`AI service returned ${response.status}.`);
  return parseModelResponse(await response.json());
}

async function analyzeWithGemini(file, apiKey) {
  const base64 = file.buffer.toString('base64');
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL || 'gemini-2.5-flash'}:generateContent`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(60000),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        systemInstruction: { parts: [{ text: 'Analyze cooperative documents. Return JSON only with exactly these fields: documentType (string), confidence (number from 0 to 100, required), ocrText (string), and extractedData (object). Types: Loan Application, Loan Form, Payment Receipt, ID Document, Cooperative Form, Document Type Not Recognized. Never guess; use Document Type Not Recognized below 70 confidence.' }] },
        contents: [{ parts: [
          { text: 'Read this document including its text, labels, keywords, important fields, and layout. Classify it and extract only relevant structured fields.' },
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

// Upload -> validate -> store privately -> AI OCR/classification -> save scan.
// A failed AI run is still recorded (processing_status = 'failed') so the
// upload is auditable, and the same file can be re-processed later.
export async function analyzeDocument(req, res) {
  const file = req.file;
  assertValidUpload(file, DOCUMENT_TYPES, 'document');
  const fileHash = crypto.createHash('sha256').update(file.buffer).digest('hex');

  const existing = (await query('SELECT id, processing_status, stored_file_path FROM document_scans WHERE file_sha256 = $1', [fileHash])).rows[0];
  if (existing && existing.processing_status !== 'failed') throw conflict('This document has already been uploaded.');

  let analysis;
  let processingStatus = 'completed';
  let processingError = null;
  try {
    analysis = await analyzeWithAi(file);
  } catch (error) {
    console.error('OCR analysis error:', error instanceof Error ? error.message : error);
    processingStatus = 'failed';
    processingError = error instanceof Error ? error.message.slice(0, 500) : 'AI analysis failed.';
    analysis = { documentType: UNRECOGNIZED, confidence: null, ocrText: '', extractedData: {} };
  }

  const storedRef = existing?.stored_file_path?.includes('://')
    ? existing.stored_file_path
    : await uploadFile({ bucket: BUCKETS.ocrUploads, folder: `scans/${new Date().toISOString().slice(0, 7)}`, file });

  try {
    const scan = await withTransaction(async (client) => {
      const values = [safeOriginalName(file.originalname), storedRef, file.mimetype, file.size, fileHash, analysis.documentType, analysis.confidence, analysis.ocrText, JSON.stringify(analysis.extractedData), processingStatus, processingError];
      const result = existing
        ? await client.query(
          `UPDATE document_scans SET original_file_name = $1, stored_file_path = $2, mime_type = $3, file_size = $4, detected_document_type = $6,
                  confidence = $7, ocr_text = $8, extracted_data = $9, processing_status = $10, processing_error = $11, review_status = 'needs_review', updated_at = NOW()
           WHERE file_sha256 = $5 RETURNING *`, values)
        : await client.query(
          `INSERT INTO document_scans (original_file_name, stored_file_path, mime_type, file_size, file_sha256, detected_document_type, confidence, ocr_text, extracted_data, processing_status, processing_error)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`, values);
      await createAuditLog({
        client,
        user: req.user,
        action: processingStatus === 'failed' ? 'OCR_FAILED' : 'DOCUMENT_UPLOADED',
        module: 'OCR',
        entityType: 'document_scan',
        entityId: String(result.rows[0].id),
        description: `${existing ? 'Re-processed' : 'Uploaded and processed'} ${file.originalname}`,
        newValues: { file_name: safeOriginalName(file.originalname), document_type: analysis.documentType, processing_status: processingStatus },
        ...getRequestMeta(req),
        status: processingStatus === 'failed' ? 'FAILED' : 'SUCCESS',
      });
      return result.rows[0];
    });
    return res.status(existing ? 200 : 201).json({
      success: processingStatus !== 'failed',
      data: mapScan(scan),
      message: processingStatus === 'failed' ? `The document was saved but could not be read: ${processingError}` : 'Document processed.',
    });
  } catch (error) {
    if (!existing) await removeFile(storedRef);
    throw error;
  }
}

const EXTRACTED_VALUE_MAX = 2000;

function validateExtractedData(extractedData) {
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
  for (const [key, value] of Object.entries(cleaned)) {
    if (/amount/i.test(key) && value && !/^[₱PHP\s]*[\d,]+(\.\d{1,2})?$/i.test(value)) throw badRequest(`"${key}" must be a valid amount.`);
    if (/date/i.test(key) && value && Number.isNaN(Date.parse(value))) throw badRequest(`"${key}" must be a valid date.`);
  }
  return cleaned;
}

export async function reviewDocument(req, res) {
  const id = parseId(req.params.id, 'document ID');
  const documentType = clean(req.body?.documentType);
  if (!SUPPORTED_TYPES.has(documentType)) throw badRequest('A valid document type is required.');
  const extractedData = validateExtractedData(req.body?.extractedData);
  const reviewStatus = req.body?.reviewStatus === 'rejected' ? 'rejected' : 'reviewed';

  const scan = await withTransaction(async (client) => {
    const before = (await client.query('SELECT * FROM document_scans WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) throw notFound('Document scan not found.');
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
  return res.status(200).json({ success: true, data: mapScan(scan), message: 'Document review saved.' });
}

export async function listDocuments(req, res) {
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 100 });
  const [result, count, stats] = await Promise.all([
    query('SELECT * FROM document_scans ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2', [limit, offset]),
    query('SELECT COUNT(*)::int AS total FROM document_scans'),
    query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE review_status = 'reviewed')::int AS reviewed,
                  COUNT(*) FILTER (WHERE review_status = 'needs_review')::int AS "needsReview",
                  COUNT(*) FILTER (WHERE processing_status = 'failed')::int AS failed
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
