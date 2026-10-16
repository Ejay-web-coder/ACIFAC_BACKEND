import { TIME_ZONE } from '../../src/config/env.js';
import { addDays } from './support.js';

// Activities and attendance. Past activities are marked (present, late,
// excused) and then finalized as on the Attendance page: every eligible active
// member left unmarked is recorded absent. The last activity is still to come.
const ACTIVITIES = [
  { title: 'General Assembly Meeting', category: 'meeting', day: -95, start: '08:00', end: '12:00', venue: 'ACIFAC Multi-Purpose Hall, Barahan', organizer: 'Board of Directors', description: 'Annual general assembly: financial report, election of officers and approval of the patronage refund.' },
  { title: 'Training on Organic Fertilizer Production', category: 'education_training', day: -45, start: '09:00', end: '15:00', venue: 'Barahan Barangay Hall', organizer: 'Municipal Agriculture Office', description: 'Hands-on vermicomposting and fermented plant juice preparation.' },
  { title: 'Irrigation Canal Clean-up', category: 'community_development', day: -20, start: '06:30', end: '11:00', venue: 'Main canal, Purok 3', organizer: 'Irrigators Committee', description: 'Clearing the main canal before the wet season planting.' },
  { title: 'Pre-Harvest Planning Meeting', category: 'meeting', day: 10, start: '08:00', end: '11:00', venue: 'ACIFAC Multi-Purpose Hall, Barahan', organizer: 'Board of Directors', description: 'Harvester schedule and the palay buying price for the coming harvest.' },
];
// What the office marks for a member, by turn; '' leaves them for finalization (absent).
const MARKS = ['present', 'present', 'late', 'present', '', 'present', 'excused', 'present', 'present', ''];
const EXCUSES = ['Sick', 'Out of town', 'Family emergency'];
const minutesAfter = (clock, minutes) => {
  const total = Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5)) + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

export default async function seedAttendance(ctx) {
  const { client, today } = ctx;
  const adminId = ctx.admin.id;
  for (const [activityIndex, activity] of ACTIVITIES.entries()) {
    const date = addDays(today, activity.day);
    // Real members would see it among their coming activities.
    if (ctx.alongside && date > today) {
      ctx.skipped(`activity on ${date}: real members are in this database`);
      continue;
    }
    const id = (await client.query(
      `INSERT INTO activities (title, category, activity_date, start_time, end_time, venue, description, organizer, status, created_by, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'scheduled', $9, $9, (($3::date - 14) + TIME '09:00') AT TIME ZONE '${TIME_ZONE}', NOW())
       RETURNING id`,
      [activity.title, activity.category, date, activity.start, activity.end, activity.venue, activity.description, activity.organizer, adminId]
    )).rows[0].id;
    ctx.count('activities');
    if (date > today) continue;

    const eligible = ctx.members.filter((member) => member.membershipDate <= date);
    const marks = eligible.map((member, memberIndex) => {
      const mark = MARKS[(memberIndex + activityIndex * 3) % MARKS.length];
      const checkIn = mark === 'present' ? minutesAfter(activity.start, -10 + (memberIndex % 8)) : mark === 'late' ? minutesAfter(activity.start, 35) : null;
      return { member, mark, checkIn, remarks: mark === 'excused' ? EXCUSES[memberIndex % EXCUSES.length] : '' };
    }).filter((row) => row.mark);
    await client.query(
      `INSERT INTO activity_attendance (activity_id, member_id, attendance_status, check_in_time, remarks, source, recorded_by, updated_by)
       SELECT $1, r.member_id, r.mark, r.check_in, r.remarks, 'office', $2, $2
       FROM unnest($3::int[], $4::text[], $5::time[], $6::text[]) AS r(member_id, mark, check_in, remarks)`,
      [id, adminId, marks.map((row) => row.member.id), marks.map((row) => row.mark), marks.map((row) => row.checkIn), marks.map((row) => row.remarks)]
    );
    ctx.count('attendance records', marks.length);
    // Finalize: the sample members not marked were absent. Only sample members:
    // members of the database who are not part of the sample get no record.
    const absent = await client.query(
      `INSERT INTO activity_attendance (activity_id, member_id, attendance_status, source, recorded_by, updated_by)
       SELECT $1, m.id, 'absent', 'finalization', $3, $3 FROM members m
        WHERE m.status = 'active' AND m.membership_date <= $2::date AND m.id = ANY($4::int[])
          AND NOT EXISTS (SELECT 1 FROM activity_attendance r WHERE r.activity_id = $1 AND r.member_id = m.id)`,
      [id, date, adminId, ctx.members.map((member) => member.id)]
    );
    ctx.count('attendance records', absent.rowCount);
    await client.query(
      `UPDATE activities SET status = 'completed', attendance_finalized_at = ($2::date + $3::time) AT TIME ZONE '${TIME_ZONE}', attendance_finalized_by = $4, updated_by = $4
       WHERE id = $1`,
      [id, date, activity.end, adminId]
    );
  }
}
