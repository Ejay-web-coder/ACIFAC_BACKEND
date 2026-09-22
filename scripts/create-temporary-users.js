import pg from 'pg';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'acifac',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'admin',
});

const users = [
  {
    memberNumber: 'ADMIN-TEMP',
    firstName: 'Temp',
    lastName: 'Admin',
    email: 'tempadmin@acifac.org',
    phone: '+639111111111',
    username: 'tempadmin',
    password: 'TempAdmin123!',
    role: 'ADMIN',
    accountStatus: 'ACTIVE',
  },
  {
    memberNumber: 'MEMBER-TEMP',
    firstName: 'Temp',
    lastName: 'Member',
    email: 'tempmember@acifac.org',
    phone: '+639222222222',
    username: 'tempmember',
    password: 'TempMember123!',
    role: 'MEMBER',
    accountStatus: 'ACTIVE',
  },
];

try {
  for (const user of users) {
    const hash = await bcrypt.hash(user.password, 12);

    await pool.query(
      `INSERT INTO members (member_number, first_name, last_name, email, phone)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (member_number) DO NOTHING;`,
      [user.memberNumber, user.firstName, user.lastName, user.email, user.phone]
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
         FALSE,
         NOW(),
         NOW(),
         NOW()
       )
       ON CONFLICT (username) DO UPDATE SET
         member_id = EXCLUDED.member_id,
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         role = EXCLUDED.role,
         account_status = EXCLUDED.account_status,
         must_change_password = EXCLUDED.must_change_password,
         password_changed_at = EXCLUDED.password_changed_at,
         updated_at = NOW();`,
      [user.memberNumber, user.username, user.email, hash, user.role, user.accountStatus]
    );

    console.log(`Created account: ${user.username} / ${user.password}`);
  }
} catch (error) {
  console.error('Error creating temporary accounts:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
