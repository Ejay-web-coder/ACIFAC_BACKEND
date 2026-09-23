import { query, withTransaction } from '../config/db.js';
import { createAuditLog } from '../utils/audit.js';
import { badRequest, cleanString, currentUserId, getRequestMeta, notFound, paginationMeta, parseId, parsePagination } from '../utils/http.js';
import { createNotifications } from '../services/notificationService.js';
import { assertValidUpload, BUCKETS, removeFile, safeOriginalName, sendStoredFile, uploadFile } from '../services/storage.js';
import { DOCUMENT_TYPES } from '../middleware/upload.js';

// ----- Notifications (always scoped to the signed-in user) -----------------

export async function listNotifications(req, res) {
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 });
  const userId = currentUserId(req);
  const unreadOnly = req.query.unread === 'true';
  const [rows, counts] = await Promise.all([
    query(
      `SELECT id, type, title, message, severity, link, entity_type AS "entityType", entity_id AS "entityId", read_at AS "readAt", created_at AS "createdAt"
       FROM notifications WHERE user_id = $1 ${unreadOnly ? 'AND read_at IS NULL' : ''}
       ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    ),
    query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE read_at IS NULL)::int AS unread FROM notifications WHERE user_id = $1`, [userId]),
  ]);
  const total = unreadOnly ? counts.rows[0].unread : counts.rows[0].total;
  return res.json({ success: true, data: rows.rows, unreadCount: counts.rows[0].unread, pagination: paginationMeta(page, limit, total) });
}

export async function markNotificationRead(req, res) {
  const id = parseId(req.params.id, 'notification ID');
  const result = await query(`UPDATE notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 AND user_id = $2 RETURNING id`, [id, currentUserId(req)]);
  if (!result.rows[0]) throw notFound('Notification not found.');
  return res.json({ success: true });
}

export async function markAllNotificationsRead(req, res) {
  const result = await query(`UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`, [currentUserId(req)]);
  return res.json({ success: true, updated: result.rowCount });
}

// ----- Announcements ------------------------------------------------------

export async function listAnnouncements(req, res) {
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 });
  const audienceFilter = req.user.role === 'ADMIN' ? '' : `AND a.audience = 'All Members'`;
  const [rows, count] = await Promise.all([
    query(
      `SELECT a.id, a.title, a.message, a.audience, a.created_at AS "postedAt", COALESCE(u.full_name, u.username) AS "postedBy"
       FROM announcements a LEFT JOIN users u ON u.id = a.created_by
       WHERE a.archived_at IS NULL ${audienceFilter}
       ORDER BY a.created_at DESC, a.id DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    ),
    query(`SELECT COUNT(*)::int AS total FROM announcements a WHERE a.archived_at IS NULL ${audienceFilter}`),
  ]);
  return res.json({ success: true, data: rows.rows, pagination: paginationMeta(page, limit, count.rows[0].total) });
}

export async function createAnnouncement(req, res) {
  const title = cleanString(req.body?.title, 200);
  const message = cleanString(req.body?.message, 5000);
  const audience = req.body?.audience === 'Admins Only' ? 'Admins Only' : 'All Members';
  if (!title || !message) throw badRequest('Please complete the announcement title and message.');

  const announcement = await withTransaction(async (client) => {
    const inserted = (await client.query(
      `INSERT INTO announcements (title, message, audience, created_by) VALUES ($1, $2, $3, $4)
       RETURNING id, title, message, audience, created_at AS "postedAt"`,
      [title, message, audience, currentUserId(req)]
    )).rows[0];
    const recipients = await client.query(
      audience === 'All Members'
        ? `SELECT id FROM users WHERE account_status = 'ACTIVE' AND id <> $1`
        : `SELECT id FROM users WHERE account_status = 'ACTIVE' AND role = 'ADMIN' AND id <> $1`,
      [currentUserId(req)]
    );
    await createNotifications(client, recipients.rows.map((row) => row.id), {
      type: 'announcement',
      title: `Announcement: ${title}`,
      message: message.length > 240 ? `${message.slice(0, 237)}...` : message,
      link: null,
      entityType: 'announcement',
      entityId: inserted.id,
      dedupeKey: `announcement-${inserted.id}`,
    });
    await createAuditLog({ client, user: req.user, action: 'ANNOUNCEMENT_CREATED', module: 'Announcements', entityType: 'announcement', entityId: String(inserted.id), description: `Posted announcement "${title}"`, newValues: { title, audience }, ...getRequestMeta(req) });
    return inserted;
  });
  return res.status(201).json({ success: true, data: announcement, message: 'Announcement posted.' });
}

export async function archiveAnnouncement(req, res) {
  const id = parseId(req.params.id, 'announcement ID');
  const result = await withTransaction(async (client) => {
    const row = (await client.query(`UPDATE announcements SET archived_at = NOW() WHERE id = $1 AND archived_at IS NULL RETURNING id, title`, [id])).rows[0];
    if (!row) throw notFound('Announcement not found.');
    await createAuditLog({ client, user: req.user, action: 'ANNOUNCEMENT_REMOVED', module: 'Announcements', entityType: 'announcement', entityId: String(id), description: `Removed announcement "${row.title}"`, ...getRequestMeta(req) });
    return row;
  });
  return res.json({ success: true, data: result });
}

// ----- Cooperative legal documents (admin) ---------------------------------

const LEGAL_CATEGORIES = ['Registration', 'Governance', 'Compliance', 'Financial', 'Other'];

export async function listLegalDocuments(req, res) {
  const rows = await query(
    `SELECT d.id, d.name, d.category, d.original_file_name AS "fileName", d.mime_type AS "mimeType", d.file_size AS "fileSize",
            d.created_at AS "uploadedAt", u.username AS "uploadedBy"
     FROM legal_documents d LEFT JOIN users u ON u.id = d.uploaded_by
     WHERE d.deleted_at IS NULL ORDER BY d.created_at DESC LIMIT 200`
  );
  return res.json({ success: true, data: rows.rows.map((row) => ({ ...row, fileSize: Number(row.fileSize) })) });
}

export async function uploadLegalDocument(req, res) {
  const file = req.file;
  assertValidUpload(file, DOCUMENT_TYPES, 'document');
  const category = LEGAL_CATEGORIES.includes(req.body?.category) ? req.body.category : 'Other';
  const name = cleanString(req.body?.name, 255) || safeOriginalName(file.originalname).replace(/\.[^.]+$/, '');
  const reference = await uploadFile({ bucket: BUCKETS.legalDocuments, folder: 'legal', file });
  try {
    const document = await withTransaction(async (client) => {
      const row = (await client.query(
        `INSERT INTO legal_documents (name, category, original_file_name, stored_file_path, mime_type, file_size, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, category, original_file_name AS "fileName", mime_type AS "mimeType", file_size AS "fileSize", created_at AS "uploadedAt"`,
        [name, category, safeOriginalName(file.originalname), reference, file.mimetype, file.size, currentUserId(req)]
      )).rows[0];
      await createAuditLog({ client, user: req.user, action: 'LEGAL_DOCUMENT_UPLOADED', module: 'Settings', entityType: 'legal_document', entityId: String(row.id), description: `Uploaded legal document ${name}`, newValues: { name, category }, ...getRequestMeta(req) });
      return row;
    });
    return res.status(201).json({ success: true, data: { ...document, fileSize: Number(document.fileSize) } });
  } catch (error) {
    await removeFile(reference);
    throw error;
  }
}

export async function downloadLegalDocument(req, res) {
  const id = parseId(req.params.id, 'document ID');
  const row = (await query(`SELECT stored_file_path, mime_type, original_file_name FROM legal_documents WHERE id = $1 AND deleted_at IS NULL`, [id])).rows[0];
  if (!row) throw notFound('Document not found.');
  const sent = await sendStoredFile(res, { reference: row.stored_file_path, mimeType: row.mime_type, fileName: row.original_file_name });
  if (!sent) throw notFound('The stored file is no longer available.');
  return undefined;
}

export async function deleteLegalDocument(req, res) {
  const id = parseId(req.params.id, 'document ID');
  const row = await withTransaction(async (client) => {
    const updated = (await client.query(`UPDATE legal_documents SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id, name, stored_file_path`, [id])).rows[0];
    if (!updated) throw notFound('Document not found.');
    await createAuditLog({ client, user: req.user, action: 'LEGAL_DOCUMENT_DELETED', module: 'Settings', entityType: 'legal_document', entityId: String(id), description: `Deleted legal document ${updated.name}`, ...getRequestMeta(req) });
    return updated;
  });
  await removeFile(row.stored_file_path);
  return res.json({ success: true });
}
