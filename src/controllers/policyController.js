import { query, withTransaction } from '../config/db.js';
import { createAuditLog } from '../utils/audit.js';
import { badRequest, cleanString, currentUserId, getRequestMeta, notFound, parseId } from '../utils/http.js';

// The About page's Policy tab: the cooperative's policies as text, a title, an
// optional introduction and numbered rules. Everyone signed in reads them; administrators add, change
// and remove them.

const MAX_ITEMS = 100;
const MAX_ITEM_LENGTH = 2000;
const MAX_INTRO_LENGTH = 5000;

const COLUMNS = `p.id, p.title, p.intro, p.items, p.sort_order AS "sortOrder", p.updated_at AS "updatedAt"`;
const toPolicy = (row, admin) => {
  const policy = { ...row };
  if (!admin) delete policy.updatedBy;
  return policy;
};
const isAdmin = (req) => req.user?.role === 'ADMIN';

// A rule keeps its line breaks (a rule can have sub-lines); blank rules are dropped.
function parsePolicy(body) {
  const title = cleanString(body?.title, 200);
  if (!title) throw badRequest('Enter the title of the policy.');
  // Paragraphs and line breaks are kept.
  const intro = String(body?.intro ?? '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (intro.length > MAX_INTRO_LENGTH) throw badRequest(`The introduction can be at most ${MAX_INTRO_LENGTH} characters.`);
  if (!Array.isArray(body?.items)) throw badRequest('Send the rules of the policy.');
  const items = body.items
    .map((item) => String(item ?? '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean).join('\n'))
    .filter(Boolean);
  if (!items.length) throw badRequest('Enter at least one rule.');
  if (items.length > MAX_ITEMS) throw badRequest(`A policy can have at most ${MAX_ITEMS} rules.`);
  const long = items.findIndex((item) => item.length > MAX_ITEM_LENGTH);
  if (long >= 0) throw badRequest(`Rule ${long + 1} can be at most ${MAX_ITEM_LENGTH} characters.`);
  return { title, intro, items };
}

async function readPolicy(db, id) {
  return (await db.query(
    `SELECT ${COLUMNS}, NULLIF(TRIM(COALESCE(u.full_name, u.username)), '') AS "updatedBy"
     FROM policies p LEFT JOIN users u ON u.id = p.updated_by WHERE p.id = $1`,
    [id]
  )).rows[0];
}

// GET /api/policies
export async function listPolicies(req, res) {
  const rows = (await query(
    `SELECT ${COLUMNS}, NULLIF(TRIM(COALESCE(u.full_name, u.username)), '') AS "updatedBy"
     FROM policies p LEFT JOIN users u ON u.id = p.updated_by ORDER BY p.sort_order, p.id`
  )).rows;
  return res.json({ success: true, data: rows.map((row) => toPolicy(row, isAdmin(req))) });
}

// POST /api/policies { title, items }
export async function createPolicy(req, res) {
  const policy = parsePolicy(req.body);
  const created = await withTransaction(async (client) => {
    const userId = currentUserId(req);
    const { id } = (await client.query(
      `INSERT INTO policies (title, intro, items, sort_order, created_by, updated_by)
       VALUES ($1, $2, $3::jsonb, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM policies), $4, $4) RETURNING id`,
      [policy.title, policy.intro, JSON.stringify(policy.items), userId]
    )).rows[0];
    await createAuditLog({
      client, user: req.user, action: 'POLICY_CREATED', module: 'Organization', entityType: 'policy', entityId: String(id),
      description: `Added the policy ${policy.title} (${policy.items.length} ${policy.items.length === 1 ? 'rule' : 'rules'})`,
      newValues: policy, ...getRequestMeta(req),
    });
    return readPolicy(client, id);
  });
  return res.status(201).json({ success: true, message: 'Policy added.', data: created });
}

// PUT /api/policies/:id { title, items }
export async function updatePolicy(req, res) {
  const id = parseId(req.params.id, 'policy');
  const policy = parsePolicy(req.body);
  const updated = await withTransaction(async (client) => {
    const before = (await client.query('SELECT title, intro, items FROM policies WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) throw notFound('Policy not found. It may have been removed.');
    if (before.title === policy.title && before.intro === policy.intro && JSON.stringify(before.items) === JSON.stringify(policy.items)) return readPolicy(client, id);
    await client.query('UPDATE policies SET title = $2, intro = $3, items = $4::jsonb, updated_by = $5, updated_at = NOW() WHERE id = $1', [id, policy.title, policy.intro, JSON.stringify(policy.items), currentUserId(req)]);
    await createAuditLog({
      client, user: req.user, action: 'POLICY_UPDATED', module: 'Organization', entityType: 'policy', entityId: String(id),
      description: `Updated the policy ${policy.title}`, oldValues: before, newValues: policy, ...getRequestMeta(req),
    });
    return readPolicy(client, id);
  });
  return res.json({ success: true, message: 'Policy saved.', data: updated });
}

// DELETE /api/policies/:id
export async function deletePolicy(req, res) {
  const id = parseId(req.params.id, 'policy');
  await withTransaction(async (client) => {
    const removed = (await client.query('DELETE FROM policies WHERE id = $1 RETURNING title, intro, items', [id])).rows[0];
    if (!removed) throw notFound('Policy not found. It may have been removed.');
    await createAuditLog({
      client, user: req.user, action: 'POLICY_DELETED', module: 'Organization', entityType: 'policy', entityId: String(id),
      description: `Removed the policy ${removed.title}`, oldValues: removed, ...getRequestMeta(req),
    });
  });
  return res.json({ success: true, message: 'Policy removed.' });
}
