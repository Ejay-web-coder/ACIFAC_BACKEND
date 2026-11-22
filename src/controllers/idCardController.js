import { query, withTransaction } from '../config/db.js';
import { createAuditLog } from '../utils/audit.js';
import { isValidDateOnly } from '../utils/dates.js';
import { badRequest, cleanString, conflict, getRequestMeta, notFound, parseId } from '../utils/http.js';
import { idCardQrText, parseIdCardCode } from '../services/idCards.js';
import { notifyMember } from '../services/notificationService.js';

// Member ID cards. The office prints a member's card (one card, or several
// per page) and reissues it when it is lost; a member shows their own card's
// QR on their phone; a scanned card finds its member. The QR holds only the
// member's random code (see services/idCards.js).

const MEMBER_NAME = `TRIM(CONCAT_WS(' ', m.first_name, m.middle_name, m.last_name, m.suffix))`;
const cardSelect = `
  SELECT m.id, m.member_number, ${MEMBER_NAME} AS name, m.first_name, m.middle_name, m.last_name, m.suffix,
         m.membership_date, m.status, m.id_token, m.id_issued_at, (m.profile_photo IS NOT NULL) AS has_photo
  FROM members m`;
const TERMINATED = 'This membership was terminated, so there is no member ID card for it.';
// The batch print lists at most this many members at once.
const MAX_CARDS = 1000;

/** What a card shows. photo: where the 2x2 photo is downloaded (with the session), null without one. */
function presentCard(row, photoPath) {
  return {
    memberId: Number(row.id),
    name: row.name,
    firstName: row.first_name || '',
    middleName: row.middle_name || '',
    lastName: row.last_name || '',
    suffix: row.suffix || '',
    memberNumber: row.member_number || '',
    memberSince: row.membership_date,
    status: row.status,
    token: row.id_token,
    qr: idCardQrText(row.id_token),
    issuedAt: row.id_issued_at,
    photo: row.has_photo ? photoPath : null,
  };
}
const officePhotoPath = (id) => `/api/members/${id}/documents/photo`;

// GET /api/members/:id/id-card (office)
export async function getMemberIdCard(req, res) {
  const id = parseId(req.params.id, 'member ID');
  const row = (await query(`${cardSelect} WHERE m.id = $1`, [id])).rows[0];
  if (!row) throw notFound('Member not found.');
  if (row.status === 'archived') throw conflict(TERMINATED);
  return res.json({ success: true, data: presentCard(row, officePhotoPath(id)) });
}

// GET /api/members/me/id-card: the signed-in member's own card only.
export async function getMyIdCard(req, res) {
  const memberId = Number(req.user?.member_id);
  if (!Number.isInteger(memberId) || memberId <= 0) throw notFound('No member record is linked to this account.');
  const row = (await query(`${cardSelect} WHERE m.id = $1`, [memberId])).rows[0];
  if (!row) throw notFound('No member record is linked to this account.');
  if (row.status === 'archived') throw conflict(TERMINATED);
  return res.json({ success: true, data: presentCard(row, '/api/members/me/documents/photo') });
}

// GET /api/members/id-cards?search=&joinedFrom=&joinedTo=&status=active|all
// The cards of several members for the batch print, by name: active members,
// or (status=all) every member whose membership was not terminated.
export async function listMemberIdCards(req, res) {
  const params = [];
  const conditions = [];
  const status = cleanString(req.query.status, 10) || 'active';
  if (status === 'active') conditions.push(`m.status = 'active'`);
  else if (status === 'all') conditions.push(`m.status <> 'archived'`);
  else throw badRequest('Show active members or all members.');
  const search = cleanString(req.query.search, 100);
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(m.member_number ILIKE $${params.length} OR ${MEMBER_NAME} ILIKE $${params.length} OR TRIM(CONCAT_WS(' ', m.first_name, m.last_name)) ILIKE $${params.length})`);
  }
  for (const [key, operator] of [['joinedFrom', '>='], ['joinedTo', '<=']]) {
    const value = cleanString(req.query[key], 10);
    if (!value) continue;
    if (!isValidDateOnly(value)) throw badRequest('The membership dates must be valid dates (YYYY-MM-DD).');
    params.push(value);
    conditions.push(`m.membership_date ${operator} $${params.length}::date`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const [rows, count] = await Promise.all([
    query(`${cardSelect} ${where} ORDER BY LOWER(m.last_name), LOWER(m.first_name), m.id LIMIT ${MAX_CARDS}`, params),
    query(`SELECT COUNT(*)::int AS total FROM members m ${where}`, params),
  ]);
  return res.json({
    success: true,
    data: rows.rows.map((row) => presentCard(row, officePhotoPath(row.id))),
    total: count.rows[0].total,
    limit: MAX_CARDS,
  });
}

// GET /api/members/by-qr/:code: the member a scanned ID card belongs to.
export async function findMemberByQr(req, res) {
  const code = parseIdCardCode(req.params.code);
  if (!code) throw badRequest('This QR code is not an ACIFAC member ID.');
  const row = (await query(`${cardSelect} WHERE m.id_token = $1`, [code])).rows[0];
  if (!row) throw notFound('No member has this ID card. It may be an old card that was replaced.');
  return res.json({
    success: true,
    data: {
      id: Number(row.id), memberNumber: row.member_number || '', name: row.name, status: row.status,
      membershipDate: row.membership_date, hasPhoto: row.has_photo,
    },
  });
}

// POST /api/members/:id/id-card/reissue { reason? }: a new code for the
// member's card (lost or damaged), so the old card stops working. The code
// itself is never written to the audit log.
export async function reissueMemberIdCard(req, res) {
  const id = parseId(req.params.id, 'member ID');
  const reason = cleanString(req.body?.reason, 300);
  const card = await withTransaction(async (client) => {
    const before = (await client.query(`${cardSelect} WHERE m.id = $1 FOR UPDATE`, [id])).rows[0];
    if (!before) throw notFound('Member not found.');
    if (before.status === 'archived') throw conflict(TERMINATED);
    const after = (await client.query(
      `UPDATE members m SET id_token = DEFAULT, id_issued_at = NOW() WHERE m.id = $1
       RETURNING m.id, m.member_number, ${MEMBER_NAME} AS name, m.first_name, m.middle_name, m.last_name, m.suffix,
                 m.membership_date, m.status, m.id_token, m.id_issued_at, (m.profile_photo IS NOT NULL) AS has_photo`,
      [id]
    )).rows[0];
    const who = `${before.name}${before.member_number ? ` (${before.member_number})` : ''}`;
    // As text: the audit log keeps plain values only.
    const issued = (value) => new Date(value).toISOString();
    await createAuditLog({
      client, user: req.user, action: 'MEMBER_ID_CARD_REISSUED', module: 'Members', entityType: 'member', entityId: String(id),
      description: `Reissued the member ID card of ${who}${reason ? `: ${reason}` : ''}. The old card no longer works.`,
      oldValues: { id_issued_at: issued(before.id_issued_at) }, newValues: { id_issued_at: issued(after.id_issued_at) },
      details: { member_id: id, member_number: before.member_number, member_name: before.name, reason: reason || null },
      ...getRequestMeta(req),
    });
    await notifyMember(client, id, {
      type: 'member_id_reissued',
      title: 'Your member ID card was replaced',
      message: 'The office issued you a new member ID card, so your old card no longer works. Get the new card at the office, or show the QR code under My Profile, My ID.',
      severity: 'warning', link: '/member-profile', entityType: 'member', entityId: id,
      dedupeKey: `member-id-reissued-${id}-${issued(after.id_issued_at)}`,
    });
    return presentCard(after, officePhotoPath(id));
  });
  return res.json({ success: true, message: `A new ID card was issued to ${card.name}. The old card no longer works: print the new one.`, data: card });
}
