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
// The audience: All (every account), Members Only, Admins Only or Vendors Only.
// "All Members", the older name of All, is still accepted.
const AUDIENCES = ['All', 'Members Only', 'Admins Only', 'Vendors Only'];
const AUDIENCE_ROLE = { 'Members Only': 'MEMBER', 'Admins Only': 'ADMIN', 'Vendors Only': 'VENDOR' };
const readAudience = (value) => (value === 'All Members' ? 'All' : AUDIENCES.includes(value) ? value : null);
// The audiences a role sees: an administrator sees every announcement.
export const audiencesFor = (role) => (role === 'ADMIN' ? AUDIENCES : ['All', ...Object.keys(AUDIENCE_ROLE).filter((audience) => AUDIENCE_ROLE[audience] === role)]);

export async function listAnnouncements(req, res) {
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 });
  const audiences = audiencesFor(req.user.role);
  const [rows, count] = await Promise.all([
    query(
      `SELECT a.id, a.title, a.message, a.audience, a.created_at AS "postedAt", COALESCE(u.full_name, u.username) AS "postedBy"
       FROM announcements a LEFT JOIN users u ON u.id = a.created_by
       WHERE a.archived_at IS NULL AND a.audience = ANY($3::text[])
       ORDER BY a.created_at DESC, a.id DESC LIMIT $1 OFFSET $2`,
      [limit, offset, audiences]
    ),
    query(`SELECT COUNT(*)::int AS total FROM announcements a WHERE a.archived_at IS NULL AND a.audience = ANY($1::text[])`, [audiences]),
  ]);
  return res.json({ success: true, data: rows.rows, pagination: paginationMeta(page, limit, count.rows[0].total) });
}

export async function createAnnouncement(req, res) {
  const title = cleanString(req.body?.title, 200);
  const message = cleanString(req.body?.message, 5000);
  const audience = req.body?.audience === undefined || req.body?.audience === '' ? 'All' : readAudience(req.body.audience);
  if (!audience) throw badRequest('Choose who the announcement is for: All, Members Only, Admins Only or Vendors Only.');
  if (!title || !message) throw badRequest('Please complete the announcement title and message.');

  const announcement = await withTransaction(async (client) => {
    const inserted = (await client.query(
      `INSERT INTO announcements (title, message, audience, created_by) VALUES ($1, $2, $3, $4)
       RETURNING id, title, message, audience, created_at AS "postedAt"`,
      [title, message, audience, currentUserId(req)]
    )).rows[0];
    const recipients = await client.query(
      `SELECT id FROM users WHERE account_status = 'ACTIVE' AND id <> $1 AND ($2::text IS NULL OR role = $2)`,
      [currentUserId(req), AUDIENCE_ROLE[audience] ?? null]
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

// PATCH /api/announcements/:id/done: the announcement has served its purpose
// (the meeting took place). It leaves the list and is no longer given to new
// accounts; it stays on record, and the notifications already sent stay in
// people's history.
export async function markAnnouncementDone(req, res) {
  const id = parseId(req.params.id, 'announcement ID');
  const result = await withTransaction(async (client) => {
    const row = (await client.query(`UPDATE announcements SET archived_at = NOW() WHERE id = $1 AND archived_at IS NULL RETURNING id, title`, [id])).rows[0];
    if (!row) throw notFound('Announcement not found.');
    await createAuditLog({ client, user: req.user, action: 'ANNOUNCEMENT_DONE', module: 'Announcements', entityType: 'announcement', entityId: String(id), description: `Marked announcement "${row.title}" as done`, ...getRequestMeta(req) });
    return row;
  });
  return res.json({ success: true, data: result, message: 'Announcement marked as done.' });
}

// DELETE /api/announcements/:id: posted by mistake. The announcement and the
// notifications it sent are removed for everyone; the audit log keeps its text.
export async function deleteAnnouncement(req, res) {
  const id = parseId(req.params.id, 'announcement ID');
  const result = await withTransaction(async (client) => {
    const row = (await client.query('DELETE FROM announcements WHERE id = $1 RETURNING id, title, message, audience', [id])).rows[0];
    if (!row) throw notFound('Announcement not found.');
    const removed = await client.query(`DELETE FROM notifications WHERE type = 'announcement' AND entity_type = 'announcement' AND entity_id = $1`, [String(id)]);
    await createAuditLog({ client, user: req.user, action: 'ANNOUNCEMENT_DELETED', module: 'Announcements', entityType: 'announcement', entityId: String(id), description: `Deleted announcement "${row.title}"`, oldValues: { title: row.title, message: row.message, audience: row.audience }, newValues: { notifications_removed: removed.rowCount }, ...getRequestMeta(req) });
    return { id: row.id, title: row.title, notificationsRemoved: removed.rowCount };
  });
  return res.json({ success: true, data: result, message: 'Announcement deleted.' });
}

// ----- Cooperative policy and legal documents (About page) ----------------
// Administrators upload and remove them and choose which ones members see.

const LEGAL_CATEGORIES = ['Policy', 'Registration', 'Governance', 'Compliance', 'Financial', 'Other'];
const isAdmin = (req) => req.user?.role === 'ADMIN';
// Two lists on the About page: Legal Documents ('legal') and Others ('others').
const DOCUMENT_SECTIONS = ['legal', 'others'];
const sectionOf = (value) => (DOCUMENT_SECTIONS.includes(value) ? value : 'legal');
const LEGAL_COLUMNS = `d.id, d.name, d.category, d.section, d.original_file_name AS "fileName", d.mime_type AS "mimeType", d.file_size AS "fileSize",
            d.shown_to_members AS "shownToMembers", d.created_at AS "uploadedAt"`;
const toLegalDocument = (row, admin) => {
  const document = { ...row, fileSize: Number(row.fileSize) };
  if (!admin) delete document.uploadedBy;
  return document;
};

export async function listLegalDocuments(req, res) {
  const admin = isAdmin(req);
  // ?section=others lists the Others tab (by title); the default is Legal Documents.
  const section = sectionOf(req.query.section);
  const rows = await query(
    `SELECT ${LEGAL_COLUMNS}, u.username AS "uploadedBy"
     FROM legal_documents d LEFT JOIN users u ON u.id = d.uploaded_by
     WHERE d.deleted_at IS NULL AND d.section = $1 ${admin ? '' : 'AND d.shown_to_members'}
     ORDER BY ${section === 'others' ? 'lower(d.name), d.id' : 'd.created_at DESC'} LIMIT 500`,
    [section]
  );
  return res.json({ success: true, data: rows.rows.map((row) => toLegalDocument(row, admin)) });
}

export async function uploadLegalDocument(req, res) {
  const file = req.file;
  assertValidUpload(file, DOCUMENT_TYPES, 'document');
  const category = LEGAL_CATEGORIES.includes(req.body?.category) ? req.body.category : 'Other';
  const name = cleanString(req.body?.name, 255) || safeOriginalName(file.originalname).replace(/\.[^.]+$/, '');
  const shownToMembers = req.body?.shownToMembers === 'true' || req.body?.shownToMembers === true;
  const section = sectionOf(req.body?.section);
  const reference = await uploadFile({ bucket: BUCKETS.legalDocuments, folder: 'legal', file });
  try {
    const document = await withTransaction(async (client) => {
      const row = (await client.query(
        `INSERT INTO legal_documents (name, category, original_file_name, stored_file_path, mime_type, file_size, uploaded_by, shown_to_members, section)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, name, category, section, original_file_name AS "fileName", mime_type AS "mimeType", file_size AS "fileSize",
           shown_to_members AS "shownToMembers", created_at AS "uploadedAt"`,
        [name, category, safeOriginalName(file.originalname), reference, file.mimetype, file.size, currentUserId(req), shownToMembers, section]
      )).rows[0];
      await createAuditLog({ client, user: req.user, action: 'LEGAL_DOCUMENT_UPLOADED', module: 'Settings', entityType: 'legal_document', entityId: String(row.id), description: `Uploaded legal document ${name}${shownToMembers ? ' (shown to members)' : ''}`, newValues: { name, category, shownToMembers }, ...getRequestMeta(req) });
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
  // Members open only the documents shown to them.
  const row = (await query(
    `SELECT stored_file_path, mime_type, original_file_name FROM legal_documents WHERE id = $1 AND deleted_at IS NULL ${isAdmin(req) ? '' : 'AND shown_to_members'}`,
    [id]
  )).rows[0];
  if (!row) throw notFound('Document not found.');
  const sent = await sendStoredFile(res, { reference: row.stored_file_path, mimeType: row.mime_type, fileName: row.original_file_name });
  if (!sent) throw notFound('The stored file is no longer available.');
  return undefined;
}

// PATCH /api/legal-documents/:id { name?, category?, shownToMembers? }
export async function updateLegalDocument(req, res) {
  const id = parseId(req.params.id, 'document ID');
  const body = req.body ?? {};
  const name = body.name === undefined ? undefined : cleanString(body.name, 255);
  if (name !== undefined && !name) throw badRequest('Enter the name of the document.');
  if (body.category !== undefined && !LEGAL_CATEGORIES.includes(body.category)) throw badRequest('Choose a category from the list.');
  if (body.shownToMembers !== undefined && typeof body.shownToMembers !== 'boolean') throw badRequest('shownToMembers must be true or false.');
  const document = await withTransaction(async (client) => {
    const before = (await client.query('SELECT * FROM legal_documents WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
    if (!before) throw notFound('Document not found.');
    const next = { name: name ?? before.name, category: body.category ?? before.category, shownToMembers: body.shownToMembers ?? before.shown_to_members };
    const row = (await client.query(
      `UPDATE legal_documents d SET name = $2, category = $3, shown_to_members = $4 WHERE d.id = $1
       RETURNING ${LEGAL_COLUMNS}, (SELECT username FROM users WHERE id = d.uploaded_by) AS "uploadedBy"`,
      [id, next.name, next.category, next.shownToMembers]
    )).rows[0];
    const sharing = next.shownToMembers === before.shown_to_members ? '' : next.shownToMembers ? ' (now shown to members)' : ' (now hidden from members)';
    await createAuditLog({
      client, user: req.user, action: 'LEGAL_DOCUMENT_UPDATED', module: 'Settings', entityType: 'legal_document', entityId: String(id),
      description: `Updated legal document ${next.name}${sharing}`,
      oldValues: { name: before.name, category: before.category, shownToMembers: before.shown_to_members }, newValues: next, ...getRequestMeta(req),
    });
    return row;
  });
  return res.json({ success: true, data: toLegalDocument(document, true) });
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
