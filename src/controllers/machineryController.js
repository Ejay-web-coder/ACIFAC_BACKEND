import { getPool, query } from '../config/db.js';

const requestSelect = `
  SELECT r.id, r.machinery_id AS "machineryId", m.name AS "machineryName",
         r.member_id AS "memberDatabaseId", r.member_name AS "memberName",
         COALESCE(mb.member_number, r.member_id::text) AS "memberId", r.purpose,
         r.start_date AS "startDate", r.end_date AS "endDate", r.duration,
         r.rental_fee AS "rentalFee", r.notes, r.status, r.submitted_at AS "submittedAt"
  FROM rental_requests r
  JOIN machinery m ON m.id = r.machinery_id
  JOIN members mb ON mb.id = r.member_id`;

const operationSelect = `
  SELECT o.id, o.machinery_id AS "machineryId", o.machinery_name AS "machineryName",
         o.member_name AS "memberName", COALESCE(m.member_number, o.member_id::text) AS "memberId",
         o.purpose, o.start_date AS "startDate", o.end_date AS "endDate", o.duration,
         o.rental_fee AS "rentalFee", o.status
  FROM machinery_operations o JOIN members m ON m.id = o.member_id`;

export async function listMachineryData(req, res) {
  try {
    const [machinery, requests, operations] = await Promise.all([
      query('SELECT id, name, type, status, acquisition_date AS "acquisitionDate", last_maintenance AS "lastMaintenance", next_maintenance AS "nextMaintenance", daily_fee AS "dailyFee" FROM machinery ORDER BY id'),
      query(`${requestSelect} ORDER BY r.submitted_at DESC`),
      query(`${operationSelect} ORDER BY o.start_date DESC, o.id DESC`),
    ]);
    return res.json({ machinery: machinery.rows, requests: requests.rows, operations: operations.rows });
  } catch (error) {
    console.error('List machinery data error:', error);
    return res.status(500).json({ message: 'Unable to load machinery operations.' });
  }
}

export async function createRentalRequest(req, res) {
  try {
    const { machineryId, purpose, startDate, endDate, notes = '', memberDatabaseId } = req.body || {};
    if (!machineryId || !purpose?.trim() || !startDate || !endDate || endDate < startDate) {
      return res.status(400).json({ message: 'Machinery, dates, and purpose are required.' });
    }
    const requestedMemberId = req.user.role === 'ADMIN' ? Number(memberDatabaseId) : Number(req.user.member_id);
    if (!Number.isInteger(requestedMemberId) || requestedMemberId <= 0) return res.status(403).json({ message: 'A valid member selection is required.' });

    const machineResult = await query('SELECT id, name, daily_fee, status FROM machinery WHERE id = $1', [machineryId]);
    const machine = machineResult.rows[0];
    if (!machine || machine.status !== 'available') return res.status(409).json({ message: 'That machinery is not currently available.' });

    const memberResult = await query(`SELECT id, COALESCE(member_number, id::text) AS member_number, TRIM(CONCAT_WS(' ', first_name, middle_name, last_name, suffix)) AS full_name FROM members WHERE id = $1 AND status = 'active'`, [requestedMemberId]);
    const member = memberResult.rows[0];
    if (!member) return res.status(403).json({ message: 'Active member record not found.' });

    const duration = Math.max(1, Math.ceil((new Date(`${endDate}T00:00:00`) - new Date(`${startDate}T00:00:00`)) / 86400000));
    const rentalFee = Number(machine.daily_fee) * duration;
    const result = await query(
      `INSERT INTO rental_requests (machinery_id, member_id, member_name, purpose, start_date, end_date, duration, rental_fee, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [machine.id, member.id, member.full_name, purpose.trim(), startDate, endDate, duration, rentalFee, notes.trim()]
    );
    const request = await query(`${requestSelect} WHERE r.id = $1`, [result.rows[0].id]);
    return res.status(201).json({ request: request.rows[0] });
  } catch (error) {
    console.error('Create rental request error:', error);
    return res.status(500).json({ message: 'Unable to submit rental request.' });
  }
}

export async function reviewRentalRequest(req, res) {
  const client = await getPool().connect();
  try {
    const { status } = req.body || {};
    if (!['approved', 'declined'].includes(status)) return res.status(400).json({ message: 'Invalid request status.' });
    await client.query('BEGIN');
    const result = await client.query('SELECT r.*, m.name AS machinery_name FROM rental_requests r JOIN machinery m ON m.id = r.machinery_id WHERE r.id = $1 FOR UPDATE', [req.params.id]);
    const request = result.rows[0];
    if (!request) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Rental request not found.' }); }
    if (request.status !== 'pending') { await client.query('ROLLBACK'); return res.status(409).json({ message: 'Rental request was already reviewed.' }); }
    await client.query('UPDATE rental_requests SET status = $1, reviewed_at = NOW(), reviewed_by = $2 WHERE id = $3', [status, req.user.user_id, request.id]);
    if (status === 'approved') {
      await client.query(`INSERT INTO machinery_operations (rental_request_id, machinery_id, machinery_name, member_id, member_name, purpose, start_date, end_date, duration, rental_fee) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [request.id, request.machinery_id, request.machinery_name, request.member_id, request.member_name, request.purpose, request.start_date, request.end_date, request.duration, request.rental_fee]);
    }
    await client.query('COMMIT');
    return res.json({ message: `Rental request ${status}.` });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Review rental request error:', error);
    return res.status(500).json({ message: 'Unable to review rental request.' });
  } finally { client.release(); }
}