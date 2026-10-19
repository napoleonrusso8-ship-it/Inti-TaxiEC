/**
 * Arranque del primer super_admin (procedimiento de "break-glass").
 *   node dist/cli/grant-admin.js <user-uuid> <rol> "<motivo>"
 * Debe ejecutarlo operaciones con acceso a la BD de producción bajo doble control; queda en el log de auditoría.
 */
import { createPool } from '@intitaxi/db';
import { randomUUID } from 'node:crypto';

const [userId, role, reason] = process.argv.slice(2);
if (!userId || !role || !reason) {
  console.error('Uso: grant-admin <user-uuid> <rol> "<motivo>"');
  process.exit(2);
}
const pool = createPool({ connectionString: process.env.DATABASE_URL!, applicationName: 'grant-admin', ssl: false });
try {
  await pool.query('BEGIN');
  await pool.query('INSERT INTO admin.role_assignments (id, user_id, role) VALUES ($1, $2, $3)', [randomUUID(), userId, role]);
  await pool.query(
    `INSERT INTO audit.audit_log (actor_role, action, resource_type, resource_id, outcome, justification, metadata, prev_hash, hash)
     VALUES ('operations_cli', 'admin.role_grant', 'user', $1, 'success', $2, $3, '\\x00', '\\x00')`,
    [userId, reason, JSON.stringify({ role, os_user: process.env.USER ?? 'desconocido' })],
  );
  await pool.query('COMMIT');
  console.log(`Rol ${role} concedido a ${userId}`);
} catch (e) {
  await pool.query('ROLLBACK');
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
