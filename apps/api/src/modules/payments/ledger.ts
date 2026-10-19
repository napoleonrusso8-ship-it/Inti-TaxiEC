import type { PoolClient } from '@intitaxi/db';
import { randomUUID } from 'node:crypto';

export interface Posting {
  account: string;
  debit?: number;
  credit?: number;
}

/**
 * Libro mayor de doble entrada. Cada asiento cuadra (lo garantiza también un trigger diferido en Postgres)
 * y nunca se modifica: las correcciones son asientos inversos.
 */
export async function postLedger(c: PoolClient, kind: string, ref: { type: string; id: string }, postings: Posting[]): Promise<string> {
  const lines = postings.filter((p) => (p.debit ?? 0) > 0 || (p.credit ?? 0) > 0);
  const d = lines.reduce((a, p) => a + (p.debit ?? 0), 0);
  const cr = lines.reduce((a, p) => a + (p.credit ?? 0), 0);
  if (d !== cr) throw new Error(`asiento descuadrado: ${d} ≠ ${cr}`);
  const txId = randomUUID();
  for (const p of lines) {
    await c.query(
      'INSERT INTO payments.ledger_entries (tx_id, account, debit_cents, credit_cents, kind, ref_type, ref_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [txId, p.account, p.debit ?? 0, p.credit ?? 0, kind, ref.type, ref.id],
    );
  }
  return txId;
}

/** Saldo de una cuenta de pasivo (créditos − débitos): lo que la plataforma debe al titular. */
export async function liabilityBalance(c: { query: PoolClient['query'] }, account: string): Promise<number> {
  const { rows } = await c.query<{ b: string }>('SELECT coalesce(sum(credit_cents - debit_cents), 0) AS b FROM payments.ledger_entries WHERE account = $1', [account]);
  return Number(rows[0]!.b);
}

/** Reparto de una tarifa entre comisión de la plataforma y conductor (en centavos, sin pérdidas por redondeo). */
export function split(fareCents: number, commissionBps: number) {
  const commission = Math.round((fareCents * commissionBps) / 10_000);
  return { commission, driver: fareCents - commission };
}
