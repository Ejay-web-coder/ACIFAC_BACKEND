import { query, withTransaction } from '../config/db.js';
import { SQL_TODAY, TIME_ZONE } from '../config/env.js';
import { createAuditLog } from '../utils/audit.js';
import { formatDateOnly, isValidDateOnly, todayDateOnly } from '../utils/dates.js';
import { badRequest, cleanString, conflict, currentUserId, getRequestMeta, notFound, paginationMeta, parseId, parsePagination } from '../utils/http.js';
import {
  ACTIVITY_CATEGORIES, ACTIVITY_STATUSES, ATTENDANCE_STATUSES, ATTENDED_STATUSES, attendanceRate, parseAttendanceRecords, summarizeParticipation,
  validateActivityInput,
} from '../services/attendance.js';

// Member attendance monitoring: activities, the attendance recorded at each,
// finalization, the dashboard, reports and each member's participation.
// Everything here is admin-only except getMyAttendance, which only ever reads
// the signed-in member's own records.

const MODULE = 'Attendance';
const MEMBER_NAME = `TRIM(CONCAT_WS(' ', m.first_name, m.middle_name, m.last_name, m.suffix))`;
const ATTENDED = `r.attendance_status IN ('present', 'late')`;
// Completed activities with final attendance: the only ones counted in attendance rates.
const COUNTED = `a.status = 'completed' AND a.attendance_finalized_at IS NOT NULL`;
// Members who could attend an activity held on `date`: their membership began
// on or before it and was not terminated before it.
const eligibleOn = (date) => `(m.membership_date <= ${date} AND (m.status <> 'archived' OR (m.archived_at AT TIME ZONE '${TIME_ZONE}')::date > ${date}))`;

const activitySelect = `
  SELECT a.id, a.title, a.category, a.activity_date AS "activityDate",
         TO_CHAR(a.start_time, 'HH24:MI') AS "startTime", TO_CHAR(a.end_time, 'HH24:MI') AS "endTime",
         a.venue, a.description, a.organizer, a.status,
         a.attendance_finalized_at AS "finalizedAt", fu.username AS "finalizedBy",
         a.cancelled_at AS "cancelledAt", a.cancellation_reason AS "cancellationReason",
         cu.username AS "createdBy", a.created_at AS "createdAt", a.updated_at AS "updatedAt",
         COALESCE(c.recorded, 0)::int AS recorded, COALESCE(c.present, 0)::int AS present, COALESCE(c.late, 0)::int AS late,
         COALESCE(c.absent, 0)::int AS absent, COALESCE(c.excused, 0)::int AS excused
  FROM activities a
  LEFT JOIN users fu ON fu.id = a.attendance_finalized_by
  LEFT JOIN users cu ON cu.id = a.created_by
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS recorded,
           COUNT(*) FILTER (WHERE r.attendance_status = 'present') AS present,
           COUNT(*) FILTER (WHERE r.attendance_status = 'late') AS late,
           COUNT(*) FILTER (WHERE r.attendance_status = 'absent') AS absent,
           COUNT(*) FILTER (WHERE r.attendance_status = 'excused') AS excused
    FROM activity_attendance r WHERE r.activity_id = a.id
  ) c ON TRUE`;
const activityOrder = 'a.activity_date DESC, a.start_time DESC, a.id DESC';

// The activity as the pages show it: with its category name, how many attended,
// and its attendance rate once the attendance is final.
function presentActivity(row) {
  const attended = row.present + row.late;
  const final = Boolean(row.finalizedAt);
  return {
    ...row,
    categoryLabel: ACTIVITY_CATEGORIES[row.category] || row.category,
    attended,
    final,
    rate: final && row.status === 'completed' ? attendanceRate(attended, row.recorded) : null,
  };
}

async function loadActivity(id) {
  const row = (await query(`${activitySelect} WHERE a.id = $1`, [id])).rows[0];
  if (!row) throw notFound('Activity not found.');
  return presentActivity(row);
}

async function lockActivity(client, id) {
  const row = (await client.query('SELECT * FROM activities WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!row) throw notFound('Activity not found.');
  return row;
}

// Collects SQL conditions; `$?` in a condition is replaced by its parameter.
function conditionBuilder(params = [], conditions = []) {
  const add = (sql, value) => { params.push(value); conditions.push(sql.replaceAll('$?', `$${params.length}`)); };
  return { params, conditions, add };
}

const whereClause = (conditions) => (conditions.length ? `WHERE ${conditions.join(' AND ')}` : '');

// Category and activity-date filters shared by every list and report.
function addPeriodFilters(source, builder) {
  const category = cleanString(source.category, 30);
  if (category) {
    if (!ACTIVITY_CATEGORIES[category]) throw badRequest('Unknown activity category.');
    builder.add('a.category = $?', category);
  }
  const from = cleanString(source.from, 10);
  const to = cleanString(source.to, 10);
  if (from && !isValidDateOnly(from)) throw badRequest('The "from" date is not valid.');
  if (to && !isValidDateOnly(to)) throw badRequest('The "to" date is not valid.');
  if (from && to && from > to) throw badRequest('The "from" date must not be after the "to" date.');
  if (from) builder.add('a.activity_date >= $?::date', from);
  if (to) builder.add('a.activity_date <= $?::date', to);
}

// Member filters of the history and the participation report: one member by
// ID, or a search on the member ID or name.
function addMemberFilters(source, builder) {
  if (source.memberId !== undefined && source.memberId !== '') builder.add('m.id = $?', parseId(source.memberId, 'member ID'));
  const search = cleanString(source.member, 100);
  if (search) {
    builder.add(`(m.member_number ILIKE $? OR ${MEMBER_NAME} ILIKE $? OR TRIM(CONCAT_WS(' ', m.first_name, m.last_name)) ILIKE $?)`, `%${search}%`);
  }
}

function readAttendanceStatus(value) {
  const status = cleanString(value, 10);
  if (status && !ATTENDANCE_STATUSES.includes(status)) throw badRequest('Unknown attendance status.');
  return status;
}

// GET /api/attendance/dashboard?from=&to=&category=
export async function getAttendanceDashboard(req, res) {
  const builder = conditionBuilder();
  addPeriodFilters(req.query, builder);
  const { params, conditions } = builder;
  const where = whereClause(conditions);
  const upcomingWhere = whereClause([...conditions, `a.status = 'scheduled'`, `a.activity_date >= ${SQL_TODAY}`]);
  const [stats, upcoming] = await Promise.all([
    query(
      `WITH a AS (SELECT a.* FROM activities a ${where}),
            r AS (SELECT r.*, a.status AS activity_status, a.attendance_finalized_at FROM activity_attendance r JOIN a ON a.id = r.activity_id WHERE a.status <> 'cancelled'),
            rates AS (SELECT 100.0 * COUNT(*) FILTER (WHERE ${ATTENDED}) / COUNT(*) AS rate
                        FROM r WHERE r.activity_status = 'completed' AND r.attendance_finalized_at IS NOT NULL GROUP BY r.activity_id)
       SELECT (SELECT COUNT(*) FROM a)::int AS "totalActivities",
              (SELECT COUNT(*) FROM a WHERE status = 'scheduled')::int AS scheduled,
              (SELECT COUNT(*) FROM a WHERE status = 'completed')::int AS completed,
              (SELECT COUNT(*) FROM a WHERE status = 'cancelled')::int AS cancelled,
              (SELECT COUNT(*) FROM a WHERE status = 'scheduled' AND activity_date >= ${SQL_TODAY})::int AS upcoming,
              (SELECT COUNT(*) FROM a WHERE status <> 'cancelled' AND attendance_finalized_at IS NULL AND activity_date < ${SQL_TODAY})::int AS "needsFinalizing",
              (SELECT COUNT(*) FROM r)::int AS "attendanceEntries",
              (SELECT COUNT(DISTINCT member_id) FROM r WHERE ${ATTENDED})::int AS "membersParticipated",
              (SELECT COUNT(*) FROM rates)::int AS "ratedActivities",
              (SELECT ROUND(AVG(rate), 1) FROM rates) AS "averageRate"`,
      params
    ),
    query(`${activitySelect} ${upcomingWhere} ORDER BY a.activity_date, a.start_time, a.id LIMIT 5`, params),
  ]);
  const summary = stats.rows[0];
  return res.json({
    success: true,
    data: {
      summary: { ...summary, averageRate: summary.averageRate === null ? null : Number(summary.averageRate) },
      upcoming: upcoming.rows.map(presentActivity),
      today: todayDateOnly(),
    },
  });
}

// GET /api/attendance/activities?search=&category=&status=&from=&to=&page=&limit=
// status may also be needs_finalizing: past activities whose attendance is not final.
export async function listActivities(req, res) {
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 10, maxLimit: 100 });
  const builder = conditionBuilder();
  addPeriodFilters(req.query, builder);
  const status = cleanString(req.query.status, 20);
  if (status === 'needs_finalizing') builder.conditions.push(`a.status <> 'cancelled' AND a.attendance_finalized_at IS NULL AND a.activity_date < ${SQL_TODAY}`);
  else if (status) {
    if (!ACTIVITY_STATUSES.includes(status)) throw badRequest('Unknown activity status.');
    builder.add('a.status = $?', status);
  }
  const search = cleanString(req.query.search, 100);
  if (search) builder.add('(a.title ILIKE $? OR a.venue ILIKE $? OR a.organizer ILIKE $?)', `%${search}%`);
  const { params, conditions } = builder;
  const where = whereClause(conditions);
  const [rows, count] = await Promise.all([
    query(`${activitySelect} ${where} ORDER BY ${activityOrder} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]),
    query(`SELECT COUNT(*)::int AS total FROM activities a ${where}`, params),
  ]);
  return res.json({ success: true, data: rows.rows.map(presentActivity), pagination: paginationMeta(page, limit, count.rows[0].total), today: todayDateOnly() });
}

// GET /api/attendance/activities/:id: the activity, its counts, and what the
// office may still do with it.
export async function getActivity(req, res) {
  const id = parseId(req.params.id, 'activity ID');
  const activity = await loadActivity(id);
  const counts = (await query(
    `SELECT COUNT(*) FILTER (WHERE ${eligibleOn('$2::date')} OR r.id IS NOT NULL)::int AS listed,
            COUNT(*) FILTER (WHERE r.id IS NULL AND ${eligibleOn('$2::date')})::int AS unmarked,
            COUNT(*) FILTER (WHERE r.id IS NULL AND m.status = 'active' AND ${eligibleOn('$2::date')})::int AS "toMarkAbsent"
       FROM members m
       LEFT JOIN activity_attendance r ON r.member_id = m.id AND r.activity_id = $1`,
    [id, activity.activityDate]
  )).rows[0];
  const today = todayDateOnly();
  const recordable = activity.status !== 'cancelled' && activity.activityDate <= today;
  return res.json({
    success: true,
    data: { ...activity, members: counts.listed, unmarked: counts.unmarked, toMarkAbsent: counts.toMarkAbsent, recordable, canFinalize: recordable && !activity.final, today },
  });
}

const activityAuditValues = (row) => ({
  title: row.title, category: row.category, activity_date: row.activity_date, start_time: String(row.start_time).slice(0, 5), end_time: String(row.end_time).slice(0, 5),
  venue: row.venue, description: row.description, organizer: row.organizer, status: row.status, cancellation_reason: row.cancellation_reason ?? null,
});

// POST /api/attendance/activities
export async function createActivity(req, res) {
  const { errors, values } = validateActivityInput(req.body, { today: todayDateOnly() });
  if (errors.length) throw badRequest(errors[0], errors);
  const userId = currentUserId(req);
  const id = await withTransaction(async (client) => {
    const row = (await client.query(
      `INSERT INTO activities (title, category, activity_date, start_time, end_time, venue, description, organizer, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING *`,
      [values.title, values.category, values.activityDate, values.startTime, values.endTime, values.venue, values.description, values.organizer, values.status, userId]
    )).rows[0];
    await createAuditLog({
      client, user: req.user, action: 'ACTIVITY_CREATED', module: MODULE, entityType: 'activity', entityId: String(row.id),
      description: `Created the ${ACTIVITY_CATEGORIES[row.category].toLowerCase()} activity "${row.title}" on ${formatDateOnly(row.activity_date)}`,
      newValues: activityAuditValues(row), ...getRequestMeta(req),
    });
    return row.id;
  });
  return res.status(201).json({ success: true, message: 'Activity created.', data: await loadActivity(id) });
}

// PUT /api/attendance/activities/:id: edits the activity. Setting the status to
// cancelled needs a reason; activities with final attendance keep their date
// and stay completed.
export async function updateActivity(req, res) {
  const id = parseId(req.params.id, 'activity ID');
  const userId = currentUserId(req);
  await withTransaction(async (client) => {
    const existing = await lockActivity(client, id);
    const hasRecords = (await client.query('SELECT EXISTS (SELECT 1 FROM activity_attendance WHERE activity_id = $1) AS has', [id])).rows[0].has;
    const { errors, values } = validateActivityInput(req.body, { today: todayDateOnly(), existing, hasRecords });
    if (errors.length) throw badRequest(errors[0], errors);
    const cancelling = values.status === 'cancelled' && existing.status !== 'cancelled';
    const restoring = values.status !== 'cancelled' && existing.status === 'cancelled';
    const updated = (await client.query(
      `UPDATE activities
          SET title = $2, category = $3, activity_date = $4, start_time = $5, end_time = $6, venue = $7, description = $8, organizer = $9, status = $10::varchar,
              cancelled_at = CASE WHEN $10::varchar = 'cancelled' THEN COALESCE(cancelled_at, NOW()) END,
              cancelled_by = CASE WHEN $10::varchar = 'cancelled' THEN CASE WHEN cancelled_at IS NULL THEN $11 ELSE cancelled_by END END,
              cancellation_reason = CASE WHEN $10::varchar = 'cancelled' THEN COALESCE(NULLIF($12, ''), cancellation_reason) END,
              updated_by = $11, updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, values.title, values.category, values.activityDate, values.startTime, values.endTime, values.venue, values.description, values.organizer, values.status, userId, values.cancellationReason]
    )).rows[0];
    const action = cancelling ? 'ACTIVITY_CANCELLED' : restoring ? 'ACTIVITY_RESTORED' : 'ACTIVITY_UPDATED';
    const verb = cancelling ? 'Cancelled' : restoring ? 'Restored' : 'Updated';
    await createAuditLog({
      client, user: req.user, action, module: MODULE, entityType: 'activity', entityId: String(id),
      description: `${verb} the activity "${updated.title}" on ${formatDateOnly(updated.activity_date)}`,
      oldValues: activityAuditValues(existing), newValues: activityAuditValues(updated), ...getRequestMeta(req),
    });
  });
  return res.json({ success: true, message: 'Activity updated.', data: await loadActivity(id) });
}

// PATCH /api/attendance/activities/:id/cancel { reason }
export async function cancelActivity(req, res) {
  const id = parseId(req.params.id, 'activity ID');
  const reason = cleanString(req.body?.reason, 500);
  if (reason.length < 3) throw badRequest('Give the reason the activity is cancelled.');
  const userId = currentUserId(req);
  await withTransaction(async (client) => {
    const existing = await lockActivity(client, id);
    if (existing.status === 'cancelled') throw conflict('This activity is already cancelled.');
    if (existing.attendance_finalized_at) throw conflict('Attendance for this activity is final: it took place and cannot be cancelled.');
    const updated = (await client.query(
      `UPDATE activities SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $2, cancellation_reason = $3, updated_by = $2, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [id, userId, reason]
    )).rows[0];
    await createAuditLog({
      client, user: req.user, action: 'ACTIVITY_CANCELLED', module: MODULE, entityType: 'activity', entityId: String(id),
      description: `Cancelled the activity "${updated.title}" on ${formatDateOnly(updated.activity_date)}`,
      oldValues: activityAuditValues(existing), newValues: activityAuditValues(updated), ...getRequestMeta(req),
    });
  });
  return res.json({ success: true, message: 'Activity cancelled.', data: await loadActivity(id) });
}

// GET /api/attendance/activities/:id/members?search=&filter=all|unmarked|present|late|absent|excused&page=&limit=
// The members who could attend (members on the activity date), and anyone
// already recorded, each with their attendance record if there is one.
export async function listActivityMembers(req, res) {
  const id = parseId(req.params.id, 'activity ID');
  const activity = (await query('SELECT activity_date FROM activities WHERE id = $1', [id])).rows[0];
  if (!activity) throw notFound('Activity not found.');
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });
  const builder = conditionBuilder([id, activity.activity_date], [`(${eligibleOn('$2::date')} OR r.id IS NOT NULL)`]);
  const search = cleanString(req.query.search, 100);
  if (search) {
    builder.add(`(m.member_number ILIKE $? OR ${MEMBER_NAME} ILIKE $? OR TRIM(CONCAT_WS(' ', m.first_name, m.last_name)) ILIKE $? OR TRIM(CONCAT_WS(' ', m.last_name, m.first_name)) ILIKE $?)`, `%${search}%`);
  }
  const filter = cleanString(req.query.filter, 20) || 'all';
  if (filter === 'unmarked') builder.conditions.push('r.id IS NULL');
  else if (ATTENDANCE_STATUSES.includes(filter)) builder.add('r.attendance_status = $?', filter);
  else if (filter !== 'all') throw badRequest('Unknown attendance filter.');
  const { params, conditions } = builder;
  const from = `FROM members m LEFT JOIN activity_attendance r ON r.member_id = m.id AND r.activity_id = $1`;
  const where = whereClause(conditions);
  const [rows, count] = await Promise.all([
    query(
      `SELECT m.id AS "memberId", m.member_number AS "memberNumber", ${MEMBER_NAME} AS name, m.status AS "memberStatus",
              r.id AS "recordId", r.attendance_status AS status, TO_CHAR(r.check_in_time, 'HH24:MI') AS "checkInTime",
              COALESCE(r.remarks, '') AS remarks, r.source, r.updated_at AS "updatedAt", ru.username AS "recordedBy"
         ${from}
         LEFT JOIN users ru ON ru.id = COALESCE(r.updated_by, r.recorded_by)
         ${where}
        ORDER BY LOWER(m.last_name), LOWER(m.first_name), m.id
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    query(`SELECT COUNT(*)::int AS total ${from} ${where}`, params),
  ]);
  return res.json({ success: true, data: rows.rows, pagination: paginationMeta(page, limit, count.rows[0].total) });
}

const sameRecord = (a, b) => a.status === b.status && (a.checkInTime || null) === (b.checkInTime || null) && (a.remarks || '') === (b.remarks || '');

// PUT /api/attendance/activities/:id/attendance { records: [{ memberId, status, checkInTime?, remarks? }], reason? }
// Adds a record for each member not recorded yet and updates the others that
// changed. One save runs at a time per activity (the activity row is locked),
// and the unique (activity, member) constraint is the last guard against a
// second record. Every change to an existing record is audited with its old
// and new values; once attendance is final a correction needs a reason.
export async function saveAttendance(req, res) {
  const id = parseId(req.params.id, 'activity ID');
  const { errors, records } = parseAttendanceRecords(req.body?.records);
  if (errors.length) throw badRequest(errors[0], errors);
  const reason = cleanString(req.body?.reason, 500);
  const userId = currentUserId(req);
  const meta = getRequestMeta(req);

  const result = await withTransaction(async (client) => {
    const activity = await lockActivity(client, id);
    if (activity.status === 'cancelled') throw conflict('This activity is cancelled, so attendance cannot be recorded.');
    if (activity.activity_date > todayDateOnly()) throw badRequest('Attendance can be recorded from the day of the activity.');
    const final = Boolean(activity.attendance_finalized_at);
    if (final && reason.length < 3) throw badRequest('Attendance for this activity is final. Give the reason for the correction.');

    const members = (await client.query(
      `SELECT m.id, m.member_number, ${MEMBER_NAME} AS name, ${eligibleOn('$2::date')} AS eligible,
              r.id AS record_id, r.attendance_status, TO_CHAR(r.check_in_time, 'HH24:MI') AS check_in_time, r.remarks
         FROM members m
         LEFT JOIN activity_attendance r ON r.member_id = m.id AND r.activity_id = $1
        WHERE m.id = ANY($3::int[])`,
      [id, activity.activity_date, records.map((record) => record.memberId)]
    )).rows;
    const byId = new Map(members.map((member) => [Number(member.id), member]));
    if (records.some((record) => !byId.has(record.memberId))) throw badRequest('Some of the members were not found.');
    const notEligible = records.find((record) => !byId.get(record.memberId).record_id && !byId.get(record.memberId).eligible);
    if (notEligible) throw badRequest(`${byId.get(notEligible.memberId).name} was not a member on the activity date.`);

    const added = [];
    const changed = [];
    for (const record of records) {
      const member = byId.get(record.memberId);
      if (!member.record_id) { added.push(record); continue; }
      const before = { status: member.attendance_status, checkInTime: member.check_in_time, remarks: member.remarks };
      if (!sameRecord(before, record)) changed.push({ record, member, before });
    }
    const column = (list, key) => list.map((item) => item[key]);
    if (added.length) {
      await client.query(
        `INSERT INTO activity_attendance (activity_id, member_id, attendance_status, check_in_time, remarks, recorded_by, updated_by)
         SELECT $1, x.member_id, x.status, x.check_in::time, x.remarks, $2, $2
           FROM unnest($3::int[], $4::text[], $5::text[], $6::text[]) AS x(member_id, status, check_in, remarks)`,
        [id, userId, column(added, 'memberId'), column(added, 'status'), column(added, 'checkInTime'), column(added, 'remarks')]
      );
      await createAuditLog({
        client, user: req.user, action: 'ATTENDANCE_RECORDED', module: MODULE, entityType: 'activity', entityId: String(id),
        description: `Recorded the attendance of ${added.length} ${added.length === 1 ? 'member' : 'members'} for "${activity.title}"`,
        details: { activity_id: id, members: added.length, statuses: Object.fromEntries(ATTENDANCE_STATUSES.map((status) => [status, added.filter((item) => item.status === status).length])) },
        ...meta,
      });
    }
    if (changed.length) {
      const updates = changed.map(({ record, member }) => ({ ...record, recordId: member.record_id }));
      await client.query(
        `UPDATE activity_attendance r
            SET attendance_status = x.status, check_in_time = x.check_in::time, remarks = x.remarks, source = 'office', updated_by = $1, updated_at = NOW()
           FROM unnest($2::int[], $3::text[], $4::text[], $5::text[]) AS x(id, status, check_in, remarks)
          WHERE r.id = x.id`,
        [userId, column(updates, 'recordId'), column(updates, 'status'), column(updates, 'checkInTime'), column(updates, 'remarks')]
      );
      for (const { record, member, before } of changed) {
        await createAuditLog({
          client, user: req.user, action: final ? 'ATTENDANCE_CORRECTED' : 'ATTENDANCE_UPDATED', module: MODULE,
          entityType: 'activity_attendance', entityId: String(member.record_id),
          description: `${final ? 'Corrected' : 'Changed'} the attendance of ${member.name} (${member.member_number}) for "${activity.title}": ${before.status} to ${record.status}`,
          oldValues: { attendance_status: before.status, check_in_time: before.checkInTime, remarks: before.remarks },
          newValues: { attendance_status: record.status, check_in_time: record.checkInTime, remarks: record.remarks },
          details: { activity_id: id, member_id: Number(member.id), member_number: member.member_number, member_name: member.name, reason: final ? reason : null },
          ...meta,
        });
      }
    }
    return { added: added.length, updated: changed.length, unchanged: records.length - added.length - changed.length };
  });

  const parts = [result.added && `${result.added} added`, result.updated && `${result.updated} ${result.updated === 1 ? 'change' : 'changes'} saved`].filter(Boolean);
  return res.json({
    success: true,
    message: parts.length ? `Attendance saved: ${parts.join(', ')}.` : 'Nothing changed: the attendance was already saved.',
    data: { ...result, activity: await loadActivity(id) },
  });
}

// POST /api/attendance/activities/:id/finalize: every active member who could
// attend and was not marked is recorded absent, and the activity becomes
// completed with final attendance, so it now counts in attendance rates.
// Until then nobody is counted absent.
export async function finalizeAttendance(req, res) {
  const id = parseId(req.params.id, 'activity ID');
  const userId = currentUserId(req);
  const result = await withTransaction(async (client) => {
    const activity = await lockActivity(client, id);
    if (activity.status === 'cancelled') throw conflict('This activity is cancelled, so its attendance cannot be finalized.');
    if (activity.attendance_finalized_at) throw conflict('Attendance for this activity is already final.');
    if (activity.activity_date > todayDateOnly()) throw badRequest('Attendance can be finalized from the day of the activity.');
    const absent = await client.query(
      `INSERT INTO activity_attendance (activity_id, member_id, attendance_status, source, recorded_by, updated_by)
       SELECT $1, m.id, 'absent', 'finalization', $3, $3
         FROM members m
        WHERE m.status = 'active' AND ${eligibleOn('$2::date')}
          AND NOT EXISTS (SELECT 1 FROM activity_attendance r WHERE r.activity_id = $1 AND r.member_id = m.id)`,
      [id, activity.activity_date, userId]
    );
    await client.query(
      `UPDATE activities SET status = 'completed', attendance_finalized_at = NOW(), attendance_finalized_by = $2, updated_by = $2, updated_at = NOW() WHERE id = $1`,
      [id, userId]
    );
    await createAuditLog({
      client, user: req.user, action: 'ATTENDANCE_FINALIZED', module: MODULE, entityType: 'activity', entityId: String(id),
      description: `Finalized the attendance for "${activity.title}" on ${formatDateOnly(activity.activity_date)}: ${absent.rowCount} unmarked ${absent.rowCount === 1 ? 'member' : 'members'} recorded absent`,
      oldValues: { status: activity.status }, newValues: { status: 'completed' },
      details: { activity_id: id, marked_absent: absent.rowCount }, ...getRequestMeta(req),
    });
    return { markedAbsent: absent.rowCount };
  });
  return res.json({
    success: true,
    message: `Attendance finalized. ${result.markedAbsent} unmarked ${result.markedAbsent === 1 ? 'member was' : 'members were'} recorded absent.`,
    data: { ...result, activity: await loadActivity(id) },
  });
}

const HISTORY_LABELS = {
  ACTIVITY_CREATED: 'Activity created', ACTIVITY_UPDATED: 'Activity details changed', ACTIVITY_CANCELLED: 'Activity cancelled',
  ACTIVITY_RESTORED: 'Activity restored', ATTENDANCE_RECORDED: 'Attendance recorded', ATTENDANCE_UPDATED: 'Attendance changed',
  ATTENDANCE_CORRECTED: 'Attendance corrected', ATTENDANCE_FINALIZED: 'Attendance finalized',
};

// GET /api/attendance/activities/:id/history: what was done to the activity and
// its attendance records, newest first, from the audit log.
export async function getActivityHistory(req, res) {
  const id = parseId(req.params.id, 'activity ID');
  await loadActivity(id);
  const rows = (await query(
    `SELECT al.id, al.action, al.created_at AS at, al.user_name_snapshot AS "by", al.description,
            al.old_values AS "oldValues", al.new_values AS "newValues", al.details
       FROM audit_logs al
      WHERE (al.entity_type = 'activity' AND al.entity_id = $1)
         OR (al.entity_type = 'activity_attendance' AND al.entity_id IN (SELECT id::text FROM activity_attendance WHERE activity_id = $2))
      ORDER BY al.created_at DESC, al.id DESC
      LIMIT 200`,
    [String(id), id]
  )).rows;
  return res.json({
    success: true,
    data: rows.map((row) => ({
      id: row.id, action: row.action, label: HISTORY_LABELS[row.action] || row.action, at: row.at, by: row.by, description: row.description,
      reason: row.details?.reason || row.newValues?.cancellation_reason || null,
      from: row.oldValues?.attendance_status ?? null, to: row.newValues?.attendance_status ?? null,
    })),
  });
}

// GET /api/attendance/records?memberId=&member=&category=&status=&from=&to=&page=&limit=&all=1
// Attendance history: every record of activities that were not cancelled.
// all=1 returns up to 10,000 rows for the CSV export.
export async function listAttendanceRecords(req, res) {
  const all = req.query.all === '1';
  const { page, limit, offset } = all ? { page: 1, limit: 10000, offset: 0 } : parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });
  const builder = conditionBuilder([], [`a.status <> 'cancelled'`]);
  addPeriodFilters(req.query, builder);
  addMemberFilters(req.query, builder);
  const status = readAttendanceStatus(req.query.status);
  if (status) builder.add('r.attendance_status = $?', status);
  const { params, conditions } = builder;
  const from = 'FROM activity_attendance r JOIN activities a ON a.id = r.activity_id JOIN members m ON m.id = r.member_id';
  const where = whereClause(conditions);
  const [rows, totals] = await Promise.all([
    query(
      `SELECT r.id, a.id AS "activityId", a.title, a.category, a.activity_date AS "activityDate", TO_CHAR(a.start_time, 'HH24:MI') AS "startTime",
              a.venue, a.status AS "activityStatus", (${COUNTED}) AS final,
              m.id AS "memberId", m.member_number AS "memberNumber", ${MEMBER_NAME} AS "memberName",
              r.attendance_status AS status, TO_CHAR(r.check_in_time, 'HH24:MI') AS "checkInTime", r.remarks, r.source,
              r.updated_at AS "updatedAt", ru.username AS "recordedBy"
         ${from}
         LEFT JOIN users ru ON ru.id = COALESCE(r.updated_by, r.recorded_by)
         ${where}
        ORDER BY ${activityOrder}, LOWER(m.last_name), LOWER(m.first_name), m.id
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    query(`SELECT r.attendance_status AS status, COUNT(*)::int AS count ${from} ${where} GROUP BY r.attendance_status`, params),
  ]);
  const counts = Object.fromEntries(ATTENDANCE_STATUSES.map((key) => [key, 0]));
  for (const row of totals.rows) counts[row.status] = row.count;
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return res.json({
    success: true,
    data: rows.rows.map((row) => ({ ...row, categoryLabel: ACTIVITY_CATEGORIES[row.category] })),
    summary: { ...counts, total },
    pagination: paginationMeta(page, limit, total),
  });
}

// GET /api/attendance/reports/participation?memberId=&member=&category=&from=&to=&status=&sort=name|rate&page=&limit=&all=1
// Each member's participation in the completed activities with final
// attendance: eligible activities, each status, attended and the rate.
// status keeps the members with at least one record of that status.
export async function getParticipationReport(req, res) {
  const all = req.query.all === '1';
  const { page, limit, offset } = all ? { page: 1, limit: 10000, offset: 0 } : parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });
  const builder = conditionBuilder([], [COUNTED]);
  addPeriodFilters(req.query, builder);
  const periodConditions = [...builder.conditions];
  const periodParams = [...builder.params];
  addMemberFilters(req.query, builder);
  const status = readAttendanceStatus(req.query.status);
  const having = status ? (builder.params.push(status), `HAVING COUNT(*) FILTER (WHERE r.attendance_status = $${builder.params.length}) > 0`) : '';
  const sort = cleanString(req.query.sort, 10) || 'name';
  if (!['name', 'rate'].includes(sort)) throw badRequest('Sort by name or rate.');
  const order = sort === 'rate'
    ? 'attended::numeric / NULLIF(eligible, 0) ASC NULLS FIRST, LOWER(last_name), LOWER(first_name), "memberId"'
    : 'LOWER(last_name), LOWER(first_name), "memberId"';
  const { params, conditions } = builder;
  const grouped = `
    SELECT m.id AS "memberId", m.member_number AS "memberNumber", ${MEMBER_NAME} AS name, m.status AS "memberStatus", m.last_name, m.first_name,
           COUNT(*)::int AS eligible,
           COUNT(*) FILTER (WHERE ${ATTENDED})::int AS attended,
           COUNT(*) FILTER (WHERE r.attendance_status = 'present')::int AS present,
           COUNT(*) FILTER (WHERE r.attendance_status = 'late')::int AS late,
           COUNT(*) FILTER (WHERE r.attendance_status = 'absent')::int AS absent,
           COUNT(*) FILTER (WHERE r.attendance_status = 'excused')::int AS excused,
           MAX(a.activity_date) FILTER (WHERE ${ATTENDED}) AS "lastAttended"
      FROM activity_attendance r JOIN activities a ON a.id = r.activity_id JOIN members m ON m.id = r.member_id
      ${whereClause(conditions)}
     GROUP BY m.id
     ${having}`;
  const [rows, totals, activities] = await Promise.all([
    query(`SELECT * FROM (${grouped}) g ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]),
    query(
      `SELECT COUNT(*)::int AS members, COALESCE(SUM(eligible), 0)::int AS eligible, COALESCE(SUM(attended), 0)::int AS attended,
              COALESCE(SUM(present), 0)::int AS present, COALESCE(SUM(late), 0)::int AS late,
              COALESCE(SUM(absent), 0)::int AS absent, COALESCE(SUM(excused), 0)::int AS excused
         FROM (${grouped}) g`,
      params
    ),
    query(`SELECT COUNT(*)::int AS total FROM activities a ${whereClause(periodConditions)}`, periodParams),
  ]);
  const summary = totals.rows[0];
  return res.json({
    success: true,
    data: rows.rows.map(({ last_name: _last, first_name: _first, ...row }) => ({ ...row, rate: attendanceRate(row.attended, row.eligible) })),
    summary: { ...summary, rate: attendanceRate(summary.attended, summary.eligible), activities: activities.rows[0].total },
    pagination: paginationMeta(page, limit, summary.members),
  });
}

// A member's participation: totals, the breakdown per category, their most
// recent activity attended, their records (activities not cancelled) and the
// upcoming activities. Records of activities whose attendance is not final
// are listed but not counted yet.
async function participationProfile(memberId) {
  const [member, counts, history, upcoming] = await Promise.all([
    query(`SELECT m.id, m.member_number AS "memberNumber", ${MEMBER_NAME} AS name, m.status, m.membership_date AS "membershipDate" FROM members m WHERE m.id = $1`, [memberId]),
    query(
      `SELECT a.category, r.attendance_status AS status, COUNT(*)::int AS count
         FROM activity_attendance r JOIN activities a ON a.id = r.activity_id
        WHERE r.member_id = $1 AND ${COUNTED}
        GROUP BY a.category, r.attendance_status`,
      [memberId]
    ),
    query(
      `SELECT r.id, a.id AS "activityId", a.title, a.category, a.activity_date AS "activityDate",
              TO_CHAR(a.start_time, 'HH24:MI') AS "startTime", TO_CHAR(a.end_time, 'HH24:MI') AS "endTime", a.venue,
              r.attendance_status AS status, TO_CHAR(r.check_in_time, 'HH24:MI') AS "checkInTime", r.remarks, (${COUNTED}) AS final
         FROM activity_attendance r JOIN activities a ON a.id = r.activity_id
        WHERE r.member_id = $1 AND a.status <> 'cancelled'
        ORDER BY ${activityOrder}
        LIMIT 500`,
      [memberId]
    ),
    query(`${activitySelect} WHERE a.status = 'scheduled' AND a.activity_date >= ${SQL_TODAY} ORDER BY a.activity_date, a.start_time, a.id LIMIT 5`),
  ]);
  if (!member.rows[0]) throw notFound('Member not found.');
  const records = history.rows.map((row) => ({ ...row, categoryLabel: ACTIVITY_CATEGORIES[row.category] }));
  const mostRecent = records.find((row) => ATTENDED_STATUSES.includes(row.status)) || null;
  return {
    member: member.rows[0],
    ...summarizeParticipation(counts.rows),
    pending: records.filter((row) => !row.final).length,
    mostRecent,
    history: records,
    // Members see when and where; the attendance numbers are for the office.
    upcoming: upcoming.rows.map((row) => {
      const { id, title, category, activityDate, startTime, endTime, venue, organizer, description } = presentActivity(row);
      return { id, title, category, categoryLabel: ACTIVITY_CATEGORIES[category], activityDate, startTime, endTime, venue, organizer, description };
    }),
  };
}

// GET /api/attendance/members/:memberId (admin)
export async function getMemberParticipation(req, res) {
  return res.json({ success: true, data: await participationProfile(parseId(req.params.memberId, 'member ID')) });
}

// GET /api/members/me/attendance: the signed-in member's own records only.
// The member ID comes from the session, never from the request.
export async function getMyAttendance(req, res) {
  const memberId = Number(req.user?.member_id);
  if (!Number.isInteger(memberId) || memberId <= 0) throw notFound('No member record is linked to this account.');
  return res.json({ success: true, data: await participationProfile(memberId) });
}
