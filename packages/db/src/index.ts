import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export interface PoolOptions {
  connectionString: string;
  /** En producción se exige TLS verificado contra la CA de RDS. */
  ssl?: { ca?: string; rejectUnauthorized: true } | false;
  max?: number;
  applicationName: string;
}

export function createPool(opts: PoolOptions): Pool {
  return new pg.Pool({
    connectionString: opts.connectionString,
    ssl: opts.ssl === false ? undefined : opts.ssl,
    max: opts.max ?? 10,
    application_name: opts.applicationName,
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 30_000,
  });
}

/** Ejecuta `fn` dentro de una transacción; revierte ante cualquier error. */
export async function withTransaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Aplica las migraciones SQL del directorio en orden lexicográfico.
 * - Cada archivo se aplica en su propia transacción.
 * - Se guarda su SHA-256: si un archivo ya aplicado cambia, se aborta (las migraciones son inmutables).
 * - Un advisory lock evita que dos instancias migren a la vez.
 */
export async function migrate(pool: Pool, dir: string, log: (m: string) => void = () => {}): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map<string, string>(
      (await client.query('SELECT name, sha256 FROM public.schema_migrations')).rows.map((r) => [r.name, r.sha256]),
    );
    const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      const sql = await readFile(join(dir, file), 'utf8');
      const sum = createHash('sha256').update(sql).digest('hex');
      const prev = done.get(file);
      if (prev) {
        if (prev !== sum) throw new Error(`La migración ${file} cambió después de aplicarse`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migrations(name, sha256) VALUES ($1, $2)', [file, sum]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Falló la migración ${file}: ${(e as Error).message}`);
      }
      applied.push(file);
      log(`aplicada ${file}`);
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}
