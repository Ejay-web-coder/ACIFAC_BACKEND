import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { query } from '../config/db.js';
import { createAuditLog } from '../utils/audit.js';

const UNRECOGNIZED = 'Document Type Not Recognized';
const SUPPORTED_TYPES = new Set(['Loan Application', 'Loan Form', 'Payment Receipt', 'ID Document', 'Cooperative Form', UNRECOGNIZED]);

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

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
  if (!apiKey) return { documentType: UNRECOGNIZED, confidence: null, ocrText: '', extractedData: {} };

  const base64 = (await fs.readFile(file.path)).toString('base64');
  const dataUrl = `data:${file.mimetype};base64,${base64}`;
  const content = [{ type: 'text', text: 'Analyze this cooperative document and return JSON only.' }];
  if (file.mimetype.startsWith('image/')) content.push({ type: 'image_url', image_url: { url: dataUrl, detail: 'high' } });
  else content.push({ type: 'text', text: `The uploaded file is a PDF named ${file.originalname}. Use the available document input capability to inspect it.` });

  const response = await fetch(endpoint, {
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
  const base64 = (await fs.readFile(file.path)).toString('base64');
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL || 'gemini-2.5-flash'}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

export async function analyzeDocument(req, res) {
  if (!req.file) return res.status(400).json({ success: false, message: 'Please upload a document.' });
  const fileBuffer = await fs.readFile(req.file.path);
  const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  try {
    const duplicate = await query('SELECT id FROM document_scans WHERE file_sha256 = $1', [fileHash]);
    if (duplicate.rows[0]) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(409).json({ success: false, message: 'This document has already been uploaded.' });
    }

    let analysis;
    let processingStatus = 'completed';
    let processingError = null;
    try { analysis = await analyzeWithAi(req.file); } catch (error) {
      console.error('OCR analysis error:', error);
      processingStatus = 'failed';
      processingError = error instanceof Error ? error.message : 'AI analysis failed.';
      analysis = { documentType: UNRECOGNIZED, confidence: null, ocrText: '', extractedData: {} };
    }
    const result = await query(
      `INSERT INTO document_scans (original_file_name, stored_file_path, mime_type, file_size, file_sha256, detected_document_type, confidence, ocr_text, extracted_data, processing_status, processing_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [req.file.originalname, req.file.path, req.file.mimetype, req.file.size, fileHash, analysis.documentType, analysis.confidence, analysis.ocrText, JSON.stringify(analysis.extractedData), processingStatus, processingError]
    );
    await createAuditLog({
      user: req.user,
      action: processingStatus === 'failed' ? 'OCR_FAILED' : 'DOCUMENT_UPLOADED',
      module: 'OCR',
      entityType: 'document_scan',
      entityId: String(result.rows[0].id),
      description: `Uploaded and processed ${req.file.originalname}`,
      oldValues: {},
      newValues: { file_name: req.file.originalname, document_type: analysis.documentType, processing_status: processingStatus },
      ...getRequestMeta(req),
      status: processingStatus === 'failed' ? 'FAILED' : 'SUCCESS',
    });
    return res.status(201).json({ success: true, data: mapScan(result.rows[0]) });
  } catch (error) {
    await fs.unlink(req.file.path).catch(() => {});
    console.error('Document analysis error:', error);
    return res.status(500).json({ success: false, message: 'Unable to process this document.' });
  }
}

export async function reviewDocument(req, res) {
  const documentType = clean(req.body?.documentType);
  const extractedData = req.body?.extractedData;
  if (!SUPPORTED_TYPES.has(documentType) || !extractedData || typeof extractedData !== 'object') {
    return res.status(400).json({ success: false, message: 'A valid document type and extracted information are required.' });
  }
  const before = await query(`SELECT * FROM document_scans WHERE id = $1`, [req.params.id]);
  const result = await query(
    `UPDATE document_scans SET detected_document_type = $1, extracted_data = $2, review_status = $3, reviewed_by = $4, updated_at = NOW()
     WHERE id = $5 RETURNING *`,
    [documentType, JSON.stringify(extractedData), req.body.reviewStatus === 'rejected' ? 'rejected' : 'reviewed', req.user.user_id || req.user.id, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Document scan not found.' });
  await createAuditLog({
    user: req.user,
    action: 'OCR_DATA_UPDATED',
    module: 'OCR',
    entityType: 'document_scan',
    entityId: String(result.rows[0].id),
    description: `Updated OCR-extracted data for ${result.rows[0].original_file_name}`,
    oldValues: before.rows[0] ? { document_type: before.rows[0].detected_document_type, extracted_data: before.rows[0].extracted_data } : {},
    newValues: { document_type: documentType, extracted_data: extractedData },
    ...getRequestMeta(req),
    status: 'SUCCESS',
  });
  return res.status(200).json({ success: true, data: mapScan(result.rows[0]), message: 'Document review saved.' });
}

export async function listDocuments(req, res) {
  try {
    const result = await query('SELECT * FROM document_scans ORDER BY created_at DESC, id DESC LIMIT 100');
    return res.status(200).json({ success: true, data: result.rows.map(mapScan) });
  } catch (error) {
    console.error('List OCR documents error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load document scans.' });
  }
}