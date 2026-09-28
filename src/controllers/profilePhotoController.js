import { query, withTransaction } from '../config/db.js';
import { createAuditLog } from '../utils/audit.js';
import { currentUserId, getRequestMeta, notFound } from '../utils/http.js';
import { assertValidUpload, BUCKETS, removeFile, sendStoredFile, uploadFile } from '../services/storage.js';
import { IMAGE_TYPES } from '../middleware/upload.js';

// Profile pictures. Every endpoint here works only on the signed-in user's own
// picture: there is deliberately no way to fetch another account's picture,
// so an administrator's picture can never be seen from the members' side.
// (Administrators see members' pictures through the admin-only member
// document endpoint.)

const MIME_BY_EXTENSION = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
export const photoMimeType = (reference) => MIME_BY_EXTENSION[String(reference || '').split('.').pop()?.toLowerCase()] || 'application/octet-stream';

// GET /api/auth/profile-photo — own uploaded picture only. A member's 2x2
// registration photo is not used here (the top bar shows their initial until
// they upload one); administrators still see it on the member record.
export async function getProfilePhoto(req, res) {
  const row = (await query('SELECT profile_photo FROM users WHERE id = $1', [currentUserId(req)])).rows[0];
  const reference = row?.profile_photo;
  if (!reference) throw notFound('No profile picture.');
  const sent = await sendStoredFile(res, { reference, mimeType: photoMimeType(reference), fileName: 'profile-picture' });
  if (!sent) throw notFound('No profile picture.');
  return undefined;
}

// POST /api/auth/profile-photo (multipart field "photo")
export async function uploadProfilePhoto(req, res) {
  const file = req.file;
  assertValidUpload(file, IMAGE_TYPES, 'profile picture');
  const userId = currentUserId(req);
  const reference = await uploadFile({ bucket: BUCKETS.memberPhotos, folder: `avatars/${userId}`, file });
  let previous;
  try {
    previous = await withTransaction(async (client) => {
      const before = (await client.query('SELECT profile_photo FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
      await client.query('UPDATE users SET profile_photo = $1, updated_at = NOW() WHERE id = $2', [reference, userId]);
      await createAuditLog({ client, user: req.user, action: 'PROFILE_PHOTO_UPDATED', module: 'Accounts', entityType: 'user', entityId: String(userId), description: 'Changed own profile picture', ...getRequestMeta(req) });
      return before?.profile_photo || null;
    });
  } catch (error) {
    await removeFile(reference);
    throw error;
  }
  if (previous) await removeFile(previous);
  return res.status(200).json({ success: true, message: 'Profile picture updated.' });
}

// DELETE /api/auth/profile-photo
export async function deleteProfilePhoto(req, res) {
  const userId = currentUserId(req);
  const previous = await withTransaction(async (client) => {
    const before = (await client.query('SELECT profile_photo FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
    if (!before?.profile_photo) return null;
    await client.query('UPDATE users SET profile_photo = NULL, updated_at = NOW() WHERE id = $1', [userId]);
    await createAuditLog({ client, user: req.user, action: 'PROFILE_PHOTO_REMOVED', module: 'Accounts', entityType: 'user', entityId: String(userId), description: 'Removed own profile picture', ...getRequestMeta(req) });
    return before.profile_photo;
  });
  if (previous) await removeFile(previous);
  return res.status(200).json({ success: true, message: 'Profile picture removed.' });
}
