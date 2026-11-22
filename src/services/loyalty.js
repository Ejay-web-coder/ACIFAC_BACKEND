import { query } from '../config/db.js';
import { SQL_TODAY } from '../config/env.js';
import { emailNotifiedUsers } from './memberEmails.js';
import { loyaltyMilestoneEmail } from './emailTemplates.js';
import { LOYALTY_MILESTONE_YEARS, loyaltyAwardName } from './membershipRules.js';

// Members are congratulated (notification, phone and email) when they complete
// 5, 10, 15, ... years of membership. It runs from the hourly timer and the
// daily cron; a milestone reached in the last 7 days still counts, so a day
// the job did not run is caught up, and each milestone is told once.
const CATCH_UP_DAYS = 7;

export async function refreshLoyaltyMilestones() {
  try {
    const told = (await query(
      `WITH reached AS (
         SELECT m.id, m.membership_date, TRIM(CONCAT_WS(' ', m.first_name, m.middle_name, m.last_name, m.suffix)) AS member_name,
                EXTRACT(YEAR FROM age(${SQL_TODAY}::timestamp, m.membership_date::timestamp))::int AS years
         FROM members m WHERE m.status = 'active' AND m.membership_date <= ${SQL_TODAY}
       ), due AS (
         SELECT *, (membership_date + make_interval(years => years))::date AS reached_on FROM reached
         WHERE years > 0 AND years % $1::int = 0
           AND (membership_date + make_interval(years => years))::date > ${SQL_TODAY} - $2::int
       ), sent AS (
         INSERT INTO notifications (user_id, type, title, message, severity, link, entity_type, entity_id, dedupe_key)
         SELECT u.id, 'loyalty_milestone', format('%s years as a member', due.years),
                format('Congratulations! On %s you completed %s years as a member of ACIFAC. Thank you for your loyalty. Members in good standing (regular attendance and loan payments on time) receive a loyalty award at the General Assembly.',
                       to_char(due.reached_on, 'FMMonth DD, YYYY'), due.years),
                'success', '/member-profile', 'member', due.id::text, 'loyalty-milestone-' || due.years
         FROM due JOIN users u ON u.member_id = due.id AND u.account_status = 'ACTIVE'
         ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
         RETURNING user_id, entity_id
       )
       SELECT sent.user_id, due.member_name, due.years FROM sent JOIN due ON due.id::text = sent.entity_id`,
      [LOYALTY_MILESTONE_YEARS, CATCH_UP_DAYS]
    )).rows;
    if (told.length) {
      await emailNotifiedUsers(told, (row) => loyaltyMilestoneEmail({ memberName: row.member_name, years: row.years, award: loyaltyAwardName(row.years) }));
    }
    return told.length;
  } catch (error) {
    console.error('Loyalty milestones failed:', error instanceof Error ? error.message : error);
    return 0;
  }
}
