import { formatDateOnly } from '../../src/utils/dates.js';
import { paymentHours } from '../../src/services/officeHours.js';
import { addDays, stampSql } from './support.js';

// Announcements on the members' dashboard (and one for administrators only).
export default async function seedAnnouncements(ctx) {
  const { client, today } = ctx;
  // Real members would read them as the cooperative's own.
  if (ctx.alongside) {
    ctx.skipped('announcements: real members are in this database');
    return;
  }
  const meeting = addDays(today, 10);
  const announcements = [
    [30, 'All Members', 'Loan payment hours', `Loan payments are received at the office ${paymentHours().label}. Bring your loan number, and keep your official receipt.`],
    [12, 'All Members', 'Harvester bookings are open', 'Members can now book the harvester for the coming harvest at the office or through the Machinery page. Members are served first.'],
    [2, 'All Members', 'Pre-Harvest Planning Meeting', `All members are invited to the pre-harvest planning meeting on ${formatDateOnly(meeting)}, 8:00 AM, at the ACIFAC Multi-Purpose Hall. We will set the harvester schedule and the palay buying price.`],
    [5, 'Admins Only', 'Board meeting notes', 'Review the overdue loans list before the next board meeting and prepare the restructuring requests.'],
  ];
  for (const [daysAgo, audience, title, message] of announcements) {
    await client.query(
      `INSERT INTO announcements (title, message, audience, created_by, created_at) VALUES ($1, $2, $3, $4, ${stampSql('$5', '08:00')})`,
      [title, message, audience, ctx.admin.id, addDays(today, -daysAgo)]
    );
    ctx.count('announcements');
  }
}
