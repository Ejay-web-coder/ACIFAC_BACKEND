import { query, withTransaction } from '../config/db.js';
import { createAuditLog } from '../utils/audit.js';
import { badRequest, currentUserId, getRequestMeta } from '../utils/http.js';

// The About page's Mission & Vision: the cooperative's mission, vision and
// core values as the office writes them. Everyone signed in can read it;
// administrators change it.

const FIELDS = { mission: 'Mission', vision: 'Vision', coreValues: 'Core values' };
const MAX_LENGTH = 5000;

async function readAbout(db = { query }) {
  const row = (await db.query(
    `SELECT a.mission, a.vision, a.core_values AS "coreValues", a.updated_at AS "updatedAt",
            NULLIF(TRIM(COALESCE(u.full_name, u.username)), '') AS "updatedBy"
     FROM about_content a LEFT JOIN users u ON u.id = a.updated_by WHERE a.id = 1`
  )).rows[0];
  return row ?? { mission: '', vision: '', coreValues: '', updatedAt: null, updatedBy: null };
}

// Line breaks are kept (the text is shown as paragraphs); trailing spaces are not.
const cleanText = (value) => String(value ?? '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd()).join('\n').trim();

// GET /api/about
export async function getAbout(req, res) {
  const about = await readAbout();
  // Who last changed it is for the office.
  if (req.user?.role !== 'ADMIN') about.updatedBy = null;
  return res.json({ success: true, ...about });
}

// PUT /api/about { mission, vision, coreValues }
export async function updateAbout(req, res) {
  const next = {};
  for (const [field, label] of Object.entries(FIELDS)) {
    const text = cleanText(req.body?.[field]);
    if (text.length > MAX_LENGTH) throw badRequest(`${label} can be at most ${MAX_LENGTH} characters.`);
    next[field] = text;
  }
  await withTransaction(async (client) => {
    const before = await readAbout(client);
    const changed = Object.keys(FIELDS).filter((field) => before[field] !== next[field]);
    if (!changed.length) return;
    await client.query(
      `INSERT INTO about_content (id, mission, vision, core_values, updated_by, updated_at) VALUES (1, $1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO UPDATE SET mission = EXCLUDED.mission, vision = EXCLUDED.vision, core_values = EXCLUDED.core_values,
         updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [next.mission, next.vision, next.coreValues, currentUserId(req)]
    );
    await createAuditLog({
      client, user: req.user, action: 'ABOUT_UPDATED', module: 'Organization', entityType: 'about', entityId: null,
      description: `Updated the ${changed.map((field) => FIELDS[field].toLowerCase()).join(', ')} on the About page`,
      oldValues: Object.fromEntries(changed.map((field) => [field, before[field]])),
      newValues: Object.fromEntries(changed.map((field) => [field, next[field]])),
      ...getRequestMeta(req),
    });
  });
  return res.json({ success: true, message: 'Mission & Vision saved.', ...(await readAbout()) });
}
