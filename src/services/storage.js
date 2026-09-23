import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { isProduction } from '../config/env.js';
import { badRequest } from '../utils/http.js';

// Private file storage. Production uses Supabase Storage (private buckets,
// accessed only by this backend with the service-role key). Local development
// without Supabase credentials falls back to a folder on disk.
// Stored references look like "supabase://bucket/object" or "local://bucket/object".

export const BUCKETS = {
  memberDocuments: 'member-documents',
  memberPhotos: 'member-photos',
  ocrUploads: 'ocr-uploads',
  legalDocuments: 'legal-documents',
};

const LOCAL_ROOT = path.resolve(process.env.MEMBER_DOCUMENT_DIR || 'private/member-documents');
const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

export const storageDriver = supabase ? 'supabase' : 'local';

if (!supabase && isProduction) {
  console.warn('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set: uploads are stored on local disk, which is not persistent on most hosts.');
}

const SIGNATURES = {
  'image/jpeg': (buffer) => buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  'image/png': (buffer) => buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (buffer) => buffer.length > 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP',
  'application/pdf': (buffer) => buffer.length > 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-',
};
const EXTENSIONS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };

// Checks the declared type is allowed AND matches the file's real content.
export function assertValidUpload(file, allowedTypes, label = 'file') {
  if (!file?.buffer?.length) throw badRequest(`Please upload a ${label}.`);
  if (!allowedTypes.includes(file.mimetype) || !SIGNATURES[file.mimetype]?.(file.buffer)) {
    throw badRequest(`The ${label} must be a valid ${allowedTypes.map((type) => EXTENSIONS[type].slice(1).toUpperCase()).join(', ')} file.`);
  }
}

export function safeOriginalName(name) {
  return String(name || 'document').replace(/[^\w.\- ]+/g, '_').slice(-150) || 'document';
}

export async function uploadFile({ bucket, folder, file }) {
  const objectPath = `${folder}/${crypto.randomUUID()}${EXTENSIONS[file.mimetype] || ''}`;
  if (supabase) {
    const { error } = await supabase.storage.from(bucket).upload(objectPath, file.buffer, { contentType: file.mimetype, upsert: false });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
    return `supabase://${bucket}/${objectPath}`;
  }
  const target = path.join(LOCAL_ROOT, bucket, objectPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, file.buffer, { mode: 0o600 });
  return `local://${bucket}/${objectPath}`;
}

function parseReference(reference) {
  const match = /^(supabase|local):\/\/([^/]+)\/(.+)$/.exec(String(reference || ''));
  if (!match || match[3].includes('..')) return null;
  return { driver: match[1], bucket: match[2], objectPath: match[3] };
}

export async function downloadFile(reference) {
  const parsed = parseReference(reference);
  if (!parsed) {
    // Legacy rows stored an absolute path from the old local-disk uploads.
    if (reference && path.isAbsolute(reference) && path.resolve(reference).startsWith(LOCAL_ROOT)) return fs.readFile(reference);
    return null;
  }
  if (parsed.driver === 'supabase') {
    if (!supabase) throw new Error('Supabase Storage is not configured.');
    const { data, error } = await supabase.storage.from(parsed.bucket).download(parsed.objectPath);
    if (error) throw new Error(`Storage download failed: ${error.message}`);
    return Buffer.from(await data.arrayBuffer());
  }
  return fs.readFile(path.join(LOCAL_ROOT, parsed.bucket, parsed.objectPath));
}

export async function createSignedUrl(reference, expiresInSeconds = 60) {
  const parsed = parseReference(reference);
  if (!parsed || parsed.driver !== 'supabase' || !supabase) return null;
  const { data, error } = await supabase.storage.from(parsed.bucket).createSignedUrl(parsed.objectPath, expiresInSeconds);
  if (error) throw new Error(`Unable to sign storage URL: ${error.message}`);
  return data.signedUrl;
}

export async function removeFile(reference) {
  const parsed = parseReference(reference);
  if (!parsed) return;
  try {
    if (parsed.driver === 'supabase' && supabase) await supabase.storage.from(parsed.bucket).remove([parsed.objectPath]);
    else if (parsed.driver === 'local') await fs.unlink(path.join(LOCAL_ROOT, parsed.bucket, parsed.objectPath));
  } catch (error) {
    console.error('Storage cleanup failed:', error.message);
  }
}

export async function sendStoredFile(res, { reference, mimeType, fileName }) {
  const buffer = await downloadFile(reference);
  if (!buffer) return false;
  res.setHeader('Content-Type', mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${safeOriginalName(fileName)}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(buffer);
  return true;
}
