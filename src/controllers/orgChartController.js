import { query, withTransaction } from '../config/db.js';
import { createAuditLog } from '../utils/audit.js';
import { badRequest, cleanString, currentUserId, getRequestMeta, notFound, parseId } from '../utils/http.js';
import { assertValidUpload, BUCKETS, removeFile, sendStoredFile, uploadFile } from '../services/storage.js';
import { IMAGE_TYPES } from '../middleware/upload.js';
import { photoMimeType } from './profilePhotoController.js';

// The organizational chart: each box (group) holds entries, a role, the name
// of whoever holds it and an optional 2x2 picture. The positions of the printed
// chart are always there (they can be renamed, not removed); the office can add
// more to any box. Everyone signed in can read it; administrators change it.

export const ORG_CHART_GROUPS = ['audit', 'election', 'bod', 'officers', 'ethics', 'education', 'gad', 'mediation', 'manager', 'staff'];
const MAX_ENTRIES = 200;

async function readChart(db = { query }) {
  const rows = (await db.query(
    `SELECT e.id, e.group_key AS "group", e.role, e.holder_name AS name, (e.photo IS NOT NULL) AS "hasPhoto",
            (e.position_key IS NULL) AS custom, e.updated_at AS "updatedAt", NULLIF(TRIM(COALESCE(u.full_name, u.username)), '') AS "updatedBy"
     FROM org_chart_entries e LEFT JOIN users u ON u.id = e.updated_by
     ORDER BY e.group_key, e.sort_order, e.id`
  )).rows;
  const touched = rows.filter((row) => row.name || row.hasPhoto || row.custom);
  const latest = touched.reduce((last, row) => (!last || row.updatedAt > last.updatedAt ? row : last), null);
  return {
    // updatedAt per entry lets the pages reload a picture when it changes.
    entries: rows.map(({ updatedBy: _by, ...row }) => row),
    updatedAt: latest?.updatedAt ?? null,
    updatedBy: latest?.updatedBy ?? null,
  };
}

// GET /api/org-chart
export async function getOrgChart(req, res) {
  return res.json({ success: true, ...(await readChart()) });
}

// PUT /api/org-chart { entries: [{ id?, group, role, name }] }
// The whole chart as it should be: entries with an id are updated, entries
// without one are added, and added entries left out are removed (with their
// picture). The printed chart's positions cannot be removed.
export async function updateOrgChart(req, res) {
  const raw = req.body?.entries;
  if (!Array.isArray(raw)) throw badRequest('Send the entries of the chart.');
  if (raw.length > MAX_ENTRIES) throw badRequest(`The chart can have at most ${MAX_ENTRIES} positions.`);
  const entries = raw.map((item, index) => {
    const id = item?.id === undefined || item?.id === null || item?.id === '' ? null : Number(item.id);
    if (id !== null && (!Number.isInteger(id) || id <= 0)) throw badRequest(`Position ${index + 1} is not valid.`);
    const group = cleanString(item?.group, 30);
    if (!ORG_CHART_GROUPS.includes(group)) throw badRequest(`Position ${index + 1}: unknown box of the chart.`);
    const role = cleanString(item?.role, 120);
    if (!role) throw badRequest(`Position ${index + 1}: enter the position (for example Director).`);
    return { id, group, role, name: cleanString(String(item?.name ?? ''), 200), order: index + 1 };
  });

  const removedPhotos = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['acifac-org-chart']);
    const before = (await client.query('SELECT * FROM org_chart_entries FOR UPDATE')).rows;
    const byId = new Map(before.map((row) => [Number(row.id), row]));
    for (const entry of entries) {
      if (entry.id !== null && !byId.has(entry.id)) throw notFound('A position on the chart was removed meanwhile. Open the chart again.');
      // A printed position stays in its own box.
      if (entry.id !== null && byId.get(entry.id).position_key && byId.get(entry.id).group_key !== entry.group) throw badRequest(`${entry.role} cannot move to another box.`);
    }
    const kept = new Set(entries.filter((entry) => entry.id !== null).map((entry) => entry.id));
    const removed = before.filter((row) => !kept.has(Number(row.id)));
    const fixed = removed.find((row) => row.position_key);
    if (fixed) throw badRequest(`${fixed.role} is a position of the chart and cannot be removed; leave its name blank instead.`);

    const userId = currentUserId(req);
    const changes = [];
    for (const entry of entries) {
      const old = entry.id !== null ? byId.get(entry.id) : null;
      if (!old) {
        await client.query('INSERT INTO org_chart_entries (group_key, role, holder_name, sort_order, updated_by) VALUES ($1, $2, $3, $4, $5)', [entry.group, entry.role, entry.name, entry.order, userId]);
        changes.push(`added ${entry.role}${entry.name ? ` (${entry.name})` : ''}`);
      } else if (old.role !== entry.role || old.holder_name !== entry.name || old.sort_order !== entry.order || old.group_key !== entry.group) {
        await client.query('UPDATE org_chart_entries SET group_key = $2, role = $3, holder_name = $4, sort_order = $5, updated_by = $6, updated_at = NOW() WHERE id = $1', [entry.id, entry.group, entry.role, entry.name, entry.order, userId]);
        if (old.role !== entry.role || old.holder_name !== entry.name) changes.push(`${old.role}${old.holder_name ? ` (${old.holder_name})` : ''} -> ${entry.role}${entry.name ? ` (${entry.name})` : ''}`);
      }
    }
    if (removed.length) {
      await client.query('DELETE FROM org_chart_entries WHERE id = ANY($1::int[])', [removed.map((row) => row.id)]);
      for (const row of removed) changes.push(`removed ${row.role}${row.holder_name ? ` (${row.holder_name})` : ''}`);
    }
    if (changes.length) {
      await createAuditLog({
        client, user: req.user, action: 'ORG_CHART_UPDATED', module: 'Organization', entityType: 'org_chart', entityId: null,
        description: `Updated the organizational chart (${changes.length} ${changes.length === 1 ? 'change' : 'changes'})`,
        details: { changes: changes.slice(0, 100) }, ...getRequestMeta(req),
      });
    }
    return removed.map((row) => row.photo).filter(Boolean);
  });
  for (const reference of removedPhotos) await removeFile(reference);
  return res.json({ success: true, message: 'Chart saved.', ...(await readChart()) });
}

async function lockEntry(client, id) {
  const row = (await client.query('SELECT * FROM org_chart_entries WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!row) throw notFound('Position not found on the chart.');
  return row;
}

// GET /api/org-chart/:id/photo  The position's 2x2 picture.
export async function getOrgChartPhoto(req, res) {
  const id = parseId(req.params.id, 'position');
  const reference = (await query('SELECT photo FROM org_chart_entries WHERE id = $1', [id])).rows[0]?.photo;
  if (!reference) throw notFound('No picture.');
  const sent = await sendStoredFile(res, { reference, mimeType: photoMimeType(reference), fileName: 'org-chart-picture' });
  if (!sent) throw notFound('No picture.');
  return undefined;
}

// POST /api/org-chart/:id/photo (multipart field "photo")  Sets or replaces the picture.
export async function uploadOrgChartPhoto(req, res) {
  const id = parseId(req.params.id, 'position');
  assertValidUpload(req.file, IMAGE_TYPES, '2x2 picture');
  const reference = await uploadFile({ bucket: BUCKETS.memberPhotos, folder: `org-chart/${id}`, file: req.file });
  let previous;
  try {
    previous = await withTransaction(async (client) => {
      const row = await lockEntry(client, id);
      await client.query('UPDATE org_chart_entries SET photo = $2, updated_by = $3, updated_at = NOW() WHERE id = $1', [id, reference, currentUserId(req)]);
      await createAuditLog({ client, user: req.user, action: 'ORG_CHART_PHOTO_UPDATED', module: 'Organization', entityType: 'org_chart', entityId: String(id), description: `Changed the picture of ${row.role}${row.holder_name ? ` (${row.holder_name})` : ''} on the organizational chart`, ...getRequestMeta(req) });
      return row.photo;
    });
  } catch (error) {
    await removeFile(reference);
    throw error;
  }
  if (previous) await removeFile(previous);
  return res.json({ success: true, message: 'Picture saved.', ...(await readChart()) });
}

// DELETE /api/org-chart/:id/photo
export async function deleteOrgChartPhoto(req, res) {
  const id = parseId(req.params.id, 'position');
  const previous = await withTransaction(async (client) => {
    const row = await lockEntry(client, id);
    if (!row.photo) return null;
    await client.query('UPDATE org_chart_entries SET photo = NULL, updated_by = $2, updated_at = NOW() WHERE id = $1', [id, currentUserId(req)]);
    await createAuditLog({ client, user: req.user, action: 'ORG_CHART_PHOTO_REMOVED', module: 'Organization', entityType: 'org_chart', entityId: String(id), description: `Removed the picture of ${row.role}${row.holder_name ? ` (${row.holder_name})` : ''} from the organizational chart`, ...getRequestMeta(req) });
    return row.photo;
  });
  if (previous) await removeFile(previous);
  return res.json({ success: true, message: 'Picture removed.', ...(await readChart()) });
}
