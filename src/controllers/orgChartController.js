import { query, withTransaction } from '../config/db.js';
import { createAuditLog } from '../utils/audit.js';
import { badRequest, cleanString, currentUserId, getRequestMeta } from '../utils/http.js';

// The organizational chart: the name of whoever holds each position. Everyone
// signed in can read it; administrators change it.

const THREE = ['chair', 'vice', 'secretary'];
const group = (prefix, roles) => roles.map((role) => `${prefix}.${role}`);
export const ORG_CHART_POSITIONS = [
  ...group('audit', THREE),
  ...group('election', THREE),
  ...group('bod', ['chair', 'vice', 'director1', 'director2', 'director3']),
  'officer.secretary', 'officer.treasurer',
  ...group('ethics', THREE),
  ...group('education', THREE),
  ...group('gad', THREE),
  ...group('mediation', THREE),
  ...group('staff', ['manager', 'accountant', 'bookkeeper', 'collector', 'cashier']),
];
const KNOWN = new Set(ORG_CHART_POSITIONS);

async function readChart() {
  const rows = (await query(
    `SELECT p.position_key AS key, p.holder_name AS name, p.updated_at AS "updatedAt", NULLIF(TRIM(COALESCE(u.full_name, u.username)), '') AS "updatedBy"
     FROM org_chart_positions p LEFT JOIN users u ON u.id = p.updated_by`
  )).rows.filter((row) => KNOWN.has(row.key));
  const latest = rows.reduce((last, row) => (!last || row.updatedAt > last.updatedAt ? row : last), null);
  return {
    positions: Object.fromEntries(rows.filter((row) => row.name).map((row) => [row.key, row.name])),
    updatedAt: latest?.updatedAt ?? null,
    updatedBy: latest?.updatedBy ?? null,
  };
}

// GET /api/org-chart
export async function getOrgChart(req, res) {
  return res.json({ success: true, ...(await readChart()) });
}

// PUT /api/org-chart { positions: { "bod.chair": "Juan Dela Cruz", ... } }
// Every position given is saved; a blank name leaves it vacant.
export async function updateOrgChart(req, res) {
  const raw = req.body?.positions;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('Send the names of the positions.');
  const entries = Object.entries(raw);
  if (entries.some(([key]) => !KNOWN.has(key))) throw badRequest('Unknown position on the chart.');
  const names = entries.map(([key, value]) => [key, cleanString(String(value ?? ''), 200)]);
  await withTransaction(async (client) => {
    const before = Object.fromEntries((await client.query('SELECT position_key, holder_name FROM org_chart_positions')).rows.map((row) => [row.position_key, row.holder_name]));
    const changed = names.filter(([key, name]) => (before[key] ?? '') !== name);
    if (!changed.length) return;
    await client.query(
      `INSERT INTO org_chart_positions (position_key, holder_name, updated_by, updated_at)
       SELECT x.key, x.name, $3, NOW() FROM unnest($1::text[], $2::text[]) AS x(key, name)
       ON CONFLICT (position_key) DO UPDATE SET holder_name = EXCLUDED.holder_name, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [changed.map(([key]) => key), changed.map(([, name]) => name), currentUserId(req)]
    );
    await createAuditLog({
      client, user: req.user, action: 'ORG_CHART_UPDATED', module: 'Organization', entityType: 'org_chart', entityId: null,
      description: `Updated the organizational chart (${changed.length} ${changed.length === 1 ? 'position' : 'positions'})`,
      oldValues: Object.fromEntries(changed.map(([key]) => [key, before[key] ?? ''])), newValues: Object.fromEntries(changed),
      ...getRequestMeta(req),
    });
  });
  return res.json({ success: true, message: 'Chart saved.', ...(await readChart()) });
}
