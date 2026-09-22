import fs from 'node:fs/promises';
import { getPool, query } from '../config/db.js';
import { createAuditLog, summarizeAuditChanges } from '../utils/audit.js';

const STATUSES = ['active', 'inactive', 'suspended', 'archived'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[+0-9()\s.-]{7,30}$/;

const memberSelect = `
  SELECT m.id, m.member_number, m.first_name, m.middle_name, m.last_name, m.suffix,
         m.email, m.phone, m.address, m.barangay, m.municipality, m.province,
         m.date_of_birth, m.gender, m.civil_status, m.education, m.id_type, m.id_number,
         m.rsbsa_no, m.livelihood, m.farm_area_ha, m.corn_area_ha, m.palay_area_ha,
         m.yearly_income, m.spouse_name, m.spouse_age, m.spouse_contact, m.children,
         m.emergency_contact, m.id_document_name, m.id_document_type, m.id_document_size,
          m.membership_date, m.share_capital, m.status, m.archived_at, m.archived_by,
          archived_user.username AS archived_by_username, m.profile_photo, m.created_at, m.updated_at,
         TRIM(CONCAT_WS(' ', m.first_name, m.middle_name, m.last_name, m.suffix)) AS full_name
        FROM members m
        LEFT JOIN users archived_user ON archived_user.id = m.archived_by`;

function getRequestMeta(req) {
  return {
    ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
    userAgent: req.headers['user-agent'] || null,
  };
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : null;
}

function numericOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  return Number(value);
}

function isValidDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function validateMemberInput(body, { partial = false } = {}) {
  const errors = [];
  const firstName = clean(body.first_name);
  const lastName = clean(body.last_name);
  const email = clean(body.email);
  const phone = clean(body.phone);
  const address = clean(body.address);
  const shareCapital = body.share_capital;
  const membershipDate = clean(body.membership_date);
  const status = clean(body.status) || 'active';

  if (!partial || body.first_name !== undefined) {
    if (!firstName) errors.push('First name is required.');
  }
  if (!partial || body.last_name !== undefined) {
    if (!lastName) errors.push('Last name is required.');
  }
  if (!partial || body.membership_date !== undefined) {
    if (!isValidDate(membershipDate)) errors.push('A valid membership date is required.');
  }
  if (!partial || body.share_capital !== undefined) {
    if (shareCapital === undefined || shareCapital === '' || !/^\d+(\.\d{1,2})?$/.test(String(shareCapital)) || Number(shareCapital) < 0) {
      errors.push('Share capital must be a non-negative amount with up to two decimals.');
    } else if (Number(shareCapital) > 20000) {
      errors.push('Share capital cannot exceed the ₱20,000 maximum limit.');
    }
  }
  if (!email) errors.push('Email is required.');
  if (email && !EMAIL_PATTERN.test(email)) errors.push('Email format is invalid.');
  if (!phone) errors.push('Phone number is required.');
  if (phone && !PHONE_PATTERN.test(phone)) errors.push('Phone number format is invalid.');
  if (!address) errors.push('Address is required.');
  if (!STATUSES.includes(status)) errors.push('Status must be active, inactive, or suspended.');
  if (body.date_of_birth && !isValidDate(body.date_of_birth)) errors.push('Date of birth is invalid.');
  for (const field of ['farm_area_ha', 'corn_area_ha', 'palay_area_ha', 'yearly_income']) {
    const amount = numericOrNull(body[field]);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) errors.push(`${field} must be a non-negative number.`);
  }
  if (body.spouse_age !== undefined && body.spouse_age !== '' && (!Number.isInteger(Number(body.spouse_age)) || Number(body.spouse_age) < 0)) errors.push('Spouse age must be a non-negative whole number.');

  return { errors, values: { firstName, lastName, email, phone, address, membershipDate, status } };
}

function mapMember(row) {
  return {
    ...row,
    id: Number(row.id),
    share_capital: Number(row.share_capital || 0),
    farm_area_ha: row.farm_area_ha === null ? null : Number(row.farm_area_ha),
    corn_area_ha: row.corn_area_ha === null ? null : Number(row.corn_area_ha),
    palay_area_ha: row.palay_area_ha === null ? null : Number(row.palay_area_ha),
    yearly_income: row.yearly_income === null ? null : Number(row.yearly_income),
  };
}

const shareContributionSelect = `
  SELECT sc.id, sc.member_id AS "memberId", sc.amount, sc.contribution_date AS "contributionDate",
         sc.payment_method AS "paymentMethod", sc.reference_number AS "referenceNumber", sc.notes,
         sc.created_at AS "createdAt", sc.updated_at AS "updatedAt", sc.recorded_by AS "recordedBy",
         u.username AS "recordedByName"
  FROM share_contributions sc
  LEFT JOIN users u ON u.id = sc.recorded_by`;

async function getShareDetails(memberId) {
  const result = await query(
    `${shareContributionSelect} WHERE sc.member_id = $1 ORDER BY sc.contribution_date DESC, sc.id DESC`,
    [memberId]
  );
  const contributions = result.rows.map((row) => ({ ...row, amount: Number(row.amount) }));
  const total = contributions.reduce((sum, contribution) => sum + contribution.amount, 0);
  return { contributions, total: Number(total.toFixed(2)), maximum: 20000, remaining: Number(Math.max(0, 20000 - total).toFixed(2)) };
}

export async function listMembers(req, res) {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const search = clean(req.query.search) || '';
    const offset = (page - 1) * limit;
    const searchPattern = `%${search}%`;
    const conditions = [`m.status = 'active'`];
    if (search) conditions.push(`CONCAT_WS(' ', m.first_name, m.middle_name, m.last_name, m.suffix, m.member_number, m.email, m.phone) ILIKE $1`);
    const where = `WHERE ${conditions.join(' AND ')}`;
    const params = search ? [searchPattern, limit, offset] : [limit, offset];
    const result = await query(
      `${memberSelect} ${where} ORDER BY m.membership_date DESC NULLS LAST, m.id DESC LIMIT $${search ? 2 : 1} OFFSET $${search ? 3 : 2}`,
      params
    );
    const countResult = await query(`SELECT COUNT(*)::int AS total FROM members m ${where}`, search ? [searchPattern] : []);
    const total = countResult.rows[0].total;

    return res.status(200).json({
      success: true,
      data: result.rows.map(mapMember),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('List members error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load members.' });
  }
}

export async function listArchivedMembers(req, res) {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const search = clean(req.query.search) || '';
    const offset = (page - 1) * limit;
    const searchPattern = `%${search}%`;
    const where = search
      ? `WHERE m.status = 'archived' AND CONCAT_WS(' ', m.first_name, m.middle_name, m.last_name, m.suffix, m.member_number, m.email, m.phone) ILIKE $1`
      : `WHERE m.status = 'archived'`;
    const params = search ? [searchPattern, limit, offset] : [limit, offset];
    const result = await query(
      `${memberSelect} ${where} ORDER BY m.archived_at DESC NULLS LAST, m.id DESC LIMIT $${search ? 2 : 1} OFFSET $${search ? 3 : 2}`,
      params
    );
    const countResult = await query(`SELECT COUNT(*)::int AS total FROM members m ${where}`, search ? [searchPattern] : []);
    const total = countResult.rows[0].total;
    return res.status(200).json({
      success: true,
      data: result.rows.map(mapMember),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('List archived members error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load archived members.' });
  }
}

export async function getMemberStatistics(req, res) {
  try {
    const result = await query(
            `SELECT COUNT(*) FILTER (WHERE status = 'active')::int AS "totalMembers",
              COALESCE(SUM(share_capital) FILTER (WHERE status = 'active'), 0)::numeric AS "totalShareCapital",
              COUNT(*) FILTER (WHERE membership_date >= DATE_TRUNC('month', CURRENT_DATE)
              AND membership_date < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
              AND status = 'active')::int AS "newThisMonth",
              COUNT(*) FILTER (WHERE status = 'archived')::int AS "archivedMembers"
       FROM members`
    );
    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Member statistics error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load member statistics.' });
  }
}

export async function listSavingsRecords(req, res) {
  try {
    const result = await query(`
      SELECT
        sc.id,
        sc.member_id AS "memberId",
        TRIM(CONCAT_WS(' ', m.first_name, m.middle_name, m.last_name, m.suffix)) AS "memberName",
        m.member_number AS "memberNumber",
        sc.amount,
        TO_CHAR(sc.contribution_date, 'YYYY-MM-DD') AS "date",
        sc.payment_method AS "paymentMethod",
        sc.reference_number AS "reference",
        sc.notes,
        'Completed' AS status
      FROM share_contributions sc
      INNER JOIN members m ON m.id = sc.member_id
      WHERE m.status <> 'archived'
      ORDER BY sc.contribution_date DESC, sc.id DESC
    `);

    const records = result.rows.map((row) => ({
      id: Number(row.id),
      memberId: Number(row.memberId),
      memberName: row.memberName || 'Unknown Member',
      memberNumber: row.memberNumber || '—',
      date: row.date || new Date().toISOString().slice(0, 10),
      amount: Number(row.amount || 0),
      type: row.paymentMethod === 'Deposit' ? 'Deposit' : 'Savings Contribution',
      paymentMethod: row.paymentMethod || 'Savings Contribution',
      reference: row.reference || `SAV-${row.date || new Date().toISOString().slice(0, 10).replaceAll('-', '')}`,
      notes: row.notes || '',
      status: row.status || 'Completed',
    }));

    return res.status(200).json({ success: true, data: records });
  } catch (error) {
    console.error('List savings records error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load savings records.' });
  }
}

export async function getMember(req, res) {
  try {
    const result = await query(`${memberSelect} WHERE m.id = $1`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Member not found.' });
    const member = mapMember(result.rows[0]);
    member.shareDetails = await getShareDetails(req.params.id);
    return res.status(200).json({ success: true, data: member });
  } catch (error) {
    console.error('Get member error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load member.' });
  }
}

export async function getMyMemberData(req, res) {
  try {
    const memberId = Number(req.user?.member_id);
    if (!Number.isInteger(memberId) || memberId <= 0) {
      return res.status(404).json({ success: false, message: 'No member record is linked to this account.' });
    }

    const memberResult = await query(`${memberSelect} WHERE m.id = $1 AND m.status <> 'archived'`, [memberId]);
    if (!memberResult.rows[0]) {
      return res.status(404).json({ success: false, message: 'Linked member record not found.' });
    }

    const [loansResult, shareDetails, paymentsResult, requestsResult] = await Promise.all([
      query(
        `SELECT id, loan_number, loan_type, amount, balance, interest_rate, term, status,
                date_approved, due_date, next_payment_date, monthly_payment
         FROM loans
         WHERE member_id = $1
         ORDER BY created_at DESC, id DESC`,
        [memberId]
      ),
      getShareDetails(memberId),
      query(
        `SELECT lp.id, lp.loan_id, lp.amount, lp.payment_date, lp.principal_paid,
                lp.interest_paid, lp.remaining_balance
         FROM loan_payments lp
         JOIN loans l ON l.id = lp.loan_id
         WHERE l.member_id = $1
         ORDER BY lp.payment_date DESC, lp.id DESC`,
        [memberId]
      ),
      query(
        `SELECT id, loan_type, amount, term, purpose, monthly_income, status, submitted_at, reviewed_at
         FROM loan_requests
         WHERE member_id = $1
         ORDER BY submitted_at DESC, id DESC`,
        [memberId]
      ),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        member: { ...mapMember(memberResult.rows[0]), shareDetails },
        loans: loansResult.rows,
        payments: paymentsResult.rows,
        loanRequests: requestsResult.rows,
        shareDetails,
      },
    });
  } catch (error) {
    console.error('Get current member data error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load your member data.' });
  }
}

export async function addShareContribution(req, res) {
  const client = await getPool().connect();
  try {
    const memberId = Number(req.params.id);
    const amount = Number(req.body?.amount);
    const contributionDate = clean(req.body?.contributionDate);
    const paymentMethod = clean(req.body?.paymentMethod) || null;
    const referenceNumber = clean(req.body?.referenceNumber) || null;
    const notes = clean(req.body?.notes) || '';
    if (!Number.isInteger(memberId) || memberId <= 0 || !Number.isFinite(amount) || amount <= 0 || !isValidDate(contributionDate)) {
      return res.status(400).json({ success: false, message: 'A valid contribution amount and date are required.' });
    }

    await client.query('BEGIN');
    const member = await client.query('SELECT id, share_capital FROM members WHERE id = $1 FOR UPDATE', [memberId]);
    if (!member.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Member not found.' });
    }
    const currentTotal = Number(member.rows[0].share_capital || 0);
    const remaining = Number((20000 - currentTotal).toFixed(2));
    if (amount > remaining) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: `Share contribution exceeds the ₱20,000 maximum limit. Maximum remaining contribution: ₱${Math.max(0, remaining).toLocaleString('en-PH', { minimumFractionDigits: 2 })}.` });
    }
    const insert = await client.query(
      `INSERT INTO share_contributions (member_id, amount, contribution_date, payment_method, reference_number, notes, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, member_id AS "memberId", amount, contribution_date AS date,
                 payment_method AS "paymentMethod", reference_number AS reference, notes`,
      [memberId, amount, contributionDate, paymentMethod, referenceNumber, notes, req.user.user_id || req.user.id]
    );
    await client.query('UPDATE members SET share_capital = share_capital + $1, updated_at = NOW() WHERE id = $2', [amount, memberId]);
    await client.query('COMMIT');

    await createAuditLog({
      user: req.user,
      action: 'SHARE_CONTRIBUTION_CREATED',
      module: 'Shares',
      entityType: 'share_contribution',
      entityId: String(insert.rows[0].id),
      description: 'Recorded share contribution',
      oldValues: { member_id: memberId, amount: 0, contribution_date: null },
      newValues: { member_id: memberId, amount, contribution_date: contributionDate, payment_method: paymentMethod, reference_number: referenceNumber },
      ...getRequestMeta(req),
      status: 'SUCCESS',
    });
    const shareDetails = await getShareDetails(memberId);
    return res.status(201).json({
      success: true,
      data: shareDetails,
      contribution: { ...insert.rows[0], amount: Number(insert.rows[0].amount) },
      message: 'Share contribution recorded.',
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Add share contribution error:', error);
    return res.status(500).json({ success: false, message: 'Unable to record share contribution.' });
  } finally { client.release(); }
}

export async function createMember(req, res) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const body = req.body || {};
    const idDocument = req.files?.idDocument?.[0] || null;
    const profilePhoto = req.files?.profilePhoto?.[0] || null;
    const { errors, values } = validateMemberInput(body);
    if (!idDocument) errors.push('Please upload an ID document.');
    if (errors.length) {
      if (idDocument?.path) await fs.unlink(idDocument.path).catch(() => {});
      if (profilePhoto?.path) await fs.unlink(profilePhoto.path).catch(() => {});
      return res.status(400).json({ success: false, message: errors[0], errors });
    }

    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['acifac-member-number']);
    const year = new Date().getFullYear();
    const numberResult = await client.query(
      `SELECT COALESCE(MAX(NULLIF(SPLIT_PART(member_number, '-', 3), '')::int), 0) + 1 AS next_number
       FROM members WHERE member_number LIKE $1`,
      [`ACIFAC-${year}-%`]
    );
    const memberNumber = `ACIFAC-${year}-${String(numberResult.rows[0].next_number).padStart(3, '0')}`;
    const insert = await client.query(
      `INSERT INTO members (member_number, first_name, middle_name, last_name, suffix, email, phone, address,
                            barangay, municipality, province, date_of_birth, gender, civil_status, education,
                            id_type, id_number, rsbsa_no, livelihood, farm_area_ha, corn_area_ha, palay_area_ha,
                            yearly_income, spouse_name, spouse_age, spouse_contact, children, emergency_contact,
                            id_document_path, id_document_name, id_document_type, id_document_size, membership_date,
                            share_capital, status, profile_photo, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
               $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, NOW())
       RETURNING id`,
      [memberNumber, values.firstName, clean(body.middle_name), values.lastName, clean(body.suffix), values.email,
        values.phone, clean(body.address), clean(body.barangay), clean(body.municipality), clean(body.province),
        clean(body.date_of_birth), clean(body.gender), clean(body.civil_status), clean(body.education), clean(body.id_type),
        clean(body.id_number), clean(body.rsbsa_no), clean(body.livelihood), numericOrNull(body.farm_area_ha),
        numericOrNull(body.corn_area_ha), numericOrNull(body.palay_area_ha), numericOrNull(body.yearly_income),
        clean(body.spouse_name), numericOrNull(body.spouse_age), clean(body.spouse_contact), clean(body.children),
        clean(body.emergency_contact), idDocument.path, idDocument.originalname, idDocument.mimetype, idDocument.size,
        values.membershipDate, body.share_capital, values.status, profilePhoto?.path || clean(body.profile_photo)]
    );
    if (Number(body.share_capital) > 0) {
      await client.query(
        `INSERT INTO share_contributions (member_id, amount, contribution_date, payment_method, reference_number, notes, recorded_by)
         VALUES ($1, $2, $3, 'Initial', $4, 'Initial share capital recorded with member registration.', $5)`,
        [insert.rows[0].id, Number(body.share_capital), values.membershipDate, `INITIAL-${memberNumber}`, req.user.user_id || req.user.id]
      );
    }
    await client.query('COMMIT');
    await createAuditLog({
      user: req.user,
      action: 'MEMBER_CREATED',
      module: 'Members',
      entityType: 'member',
      entityId: String(insert.rows[0].id),
      description: `Created member ${memberNumber}`,
      oldValues: {},
      newValues: { member_number: memberNumber, email: values.email, phone: values.phone },
      ...getRequestMeta(req),
      status: 'SUCCESS',
    });
    const created = await query(`${memberSelect} WHERE m.id = $1`, [insert.rows[0].id]);
    return res.status(201).json({ success: true, data: mapMember(created.rows[0]), message: 'Member created successfully.' });
  } catch (error) {
    await client.query('ROLLBACK');
    const idDocument = req.files?.idDocument?.[0];
    const profilePhoto = req.files?.profilePhoto?.[0];
    if (idDocument?.path) await fs.unlink(idDocument.path).catch(() => {});
    if (profilePhoto?.path) await fs.unlink(profilePhoto.path).catch(() => {});
    console.error('Create member error:', error);
    if (error.code === '23505') return res.status(409).json({ success: false, message: 'A member with this information already exists.' });
    return res.status(500).json({ success: false, message: 'Unable to create member.' });
  } finally {
    client.release();
  }
}

export async function updateMember(req, res) {
  try {
    const body = req.body || {};
    const { errors, values } = validateMemberInput(body);
    if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });
    const before = await query(`${memberSelect} WHERE m.id = $1`, [req.params.id]);
    if (!before.rows[0]) return res.status(404).json({ success: false, message: 'Member not found.' });
    const result = await query(
      `UPDATE members SET first_name = $1, middle_name = $2, last_name = $3, suffix = $4, email = $5, phone = $6,
                          address = $7, barangay = $8, municipality = $9, province = $10, date_of_birth = $11,
                          gender = $12, civil_status = $13, education = $14, id_type = $15, id_number = $16,
                          rsbsa_no = $17, livelihood = $18, farm_area_ha = $19, corn_area_ha = $20,
                          palay_area_ha = $21, yearly_income = $22, spouse_name = $23, spouse_age = $24,
                          spouse_contact = $25, children = $26, emergency_contact = $27, membership_date = $28,
                          share_capital = COALESCE((SELECT SUM(amount) FROM share_contributions WHERE member_id = $30), 0),
                          status = $29, updated_at = NOW()
       WHERE id = $30 RETURNING id`,
      [values.firstName, clean(body.middle_name), values.lastName, clean(body.suffix), values.email, values.phone,
        clean(body.address), clean(body.barangay), clean(body.municipality), clean(body.province), clean(body.date_of_birth),
        clean(body.gender), clean(body.civil_status), clean(body.education), clean(body.id_type), clean(body.id_number),
        clean(body.rsbsa_no), clean(body.livelihood), numericOrNull(body.farm_area_ha), numericOrNull(body.corn_area_ha),
        numericOrNull(body.palay_area_ha), numericOrNull(body.yearly_income), clean(body.spouse_name), numericOrNull(body.spouse_age),
        clean(body.spouse_contact), clean(body.children), clean(body.emergency_contact), values.membershipDate,
        values.status, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Member not found.' });
    const after = await query(`${memberSelect} WHERE m.id = $1`, [req.params.id]);
    const changes = summarizeAuditChanges(before.rows[0], after.rows[0]);
    await createAuditLog({
      user: req.user,
      action: 'MEMBER_UPDATED',
      module: 'Members',
      entityType: 'member',
      entityId: String(req.params.id),
      description: 'Updated member details',
      oldValues: before.rows[0],
      newValues: after.rows[0],
      ...getRequestMeta(req),
      status: 'SUCCESS',
    });
    const updated = await query(`${memberSelect} WHERE m.id = $1`, [req.params.id]);
    return res.status(200).json({ success: true, data: mapMember(updated.rows[0]), message: 'Member updated successfully.' });
  } catch (error) {
    console.error('Update member error:', error);
    if (error.code === '23505') return res.status(409).json({ success: false, message: 'A member with this email already exists.' });
    return res.status(500).json({ success: false, message: 'Unable to update member.' });
  }
}

export async function deactivateMember(req, res) {
  try {
    const result = await query(
      `UPDATE members SET status = 'inactive', updated_at = NOW() WHERE id = $1 AND status <> 'inactive' RETURNING id, member_number`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Member not found or already inactive.' });
    await createAuditLog({ userId: req.user.user_id || req.user.id, action: 'MEMBER_DEACTIVATED', ...getRequestMeta(req), details: { member_id: result.rows[0].id, member_number: result.rows[0].member_number } });
    return res.status(200).json({ success: true, message: 'Member deactivated successfully.' });
  } catch (error) {
    console.error('Deactivate member error:', error);
    return res.status(500).json({ success: false, message: 'Unable to deactivate member.' });
  }
}

export async function archiveMember(req, res) {
  try {
    const before = await query(`SELECT id, member_number, status FROM members WHERE id = $1`, [req.params.id]);
    const result = await query(
      `UPDATE members
       SET status = 'archived', archived_at = NOW(), archived_by = $1, updated_at = NOW()
       WHERE id = $2 AND status <> 'archived'
       RETURNING id, member_number, status, archived_at, archived_by`,
      [req.user.user_id || req.user.id, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Member not found or already archived.' });
    const member = result.rows[0];
    await createAuditLog({
      user: req.user,
      action: 'MEMBER_ARCHIVED',
      module: 'Members',
      entityType: 'member',
      entityId: String(member.id),
      description: `Archived member ${member.member_number}`,
      oldValues: before.rows[0] || {},
      newValues: { ...member, previous_status: before.rows[0]?.status || null },
      ...getRequestMeta(req),
      status: 'SUCCESS',
    });
    return res.status(200).json({ success: true, message: 'Member archived successfully.', data: member });
  } catch (error) {
    console.error('Archive member error:', error);
    return res.status(500).json({ success: false, message: 'Unable to archive member.' });
  }
}

export async function restoreMember(req, res) {
  try {
    const before = await query(`SELECT id, member_number, status FROM members WHERE id = $1`, [req.params.id]);
    const result = await query(
      `UPDATE members
       SET status = 'active', archived_at = NULL, archived_by = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'archived'
       RETURNING id, member_number, status`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Member not found or is not archived.' });
    const member = result.rows[0];
    await createAuditLog({
      user: req.user,
      action: 'MEMBER_RESTORED',
      module: 'Members',
      entityType: 'member',
      entityId: String(member.id),
      description: `Restored member ${member.member_number}`,
      oldValues: before.rows[0] || {},
      newValues: { ...member, previous_status: before.rows[0]?.status || null },
      ...getRequestMeta(req),
      status: 'SUCCESS',
    });
    return res.status(200).json({ success: true, message: 'Member restored successfully.', data: member });
  } catch (error) {
    console.error('Restore member error:', error);
    return res.status(500).json({ success: false, message: 'Unable to restore member.' });
  }
}
