import pg from 'pg';
import bcrypt from 'bcryptjs';

const { Pool } = pg;
const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'acifac',
  user: 'postgres',
  password: 'admin',
});

const username = 'admin';
const email = 'admin@acifac.org';
const password = 'StrongAdminPass1!';

try {
  const hash = await bcrypt.hash(password, 12);

  await pool.query(
    `INSERT INTO members (member_number, first_name, last_name, email, phone)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (member_number) DO NOTHING;`,
    ['ADMIN-001', 'System', 'Administrator', email, '+639000000000']
  );

  await pool.query(
    `INSERT INTO users (member_id, username, email, password_hash, role, account_status, must_change_password, password_changed_at, created_at, updated_at)
     VALUES (
       (SELECT id FROM members WHERE member_number = $1),
       $2,
       $3,
       $4,
       $5,
       $6,
       $7,
       NOW(),
       NOW(),
       NOW()
     )
     ON CONFLICT (username) DO NOTHING;`,
    ['ADMIN-001', username, email, hash, 'ADMIN', 'ACTIVE', false]
  );

  const result = await pool.query(
    `SELECT u.username, u.role, u.account_status, m.email
     FROM users u
     JOIN members m ON m.id = u.member_id
     WHERE u.username = $1;`,
    [username]
  );

  if (result.rows.length === 0) {
    throw new Error('Admin user was not created');
  }

  console.log('Admin user created successfully.');
  console.log(JSON.stringify(result.rows[0], null, 2));
} catch (error) {
  console.error('Error creating admin user:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
