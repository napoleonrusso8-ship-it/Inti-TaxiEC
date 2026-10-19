import { Inject, Injectable, Logger } from '@nestjs/common';
import { maskDocument, sha256, type BlindIndex, type FieldCipher } from '@intitaxi/crypto';
import { withTransaction, type Pool, type PoolClient } from '@intitaxi/db';
import { AppError, AuditService, RateLimiter, tooManyRequests, type AppRequest } from '@intitaxi/nest-common';
import { randomInt, randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config.js';
import { BLIND_INDEX, CONFIG, FIELD_CIPHER, KYC_PROVIDER, PG_POOL } from '../../tokens.js';
import type { KycDecision, KycProvider } from './providers.js';
import { reverificationReason } from './reverification-policy.js';

export type VerificationKind = 'full' | 'driver_reverify';

const aad = {
  docNumber: (id: string) => `kyc.verifications.doc_number:${id}`,
  given: (id: string) => `kyc.verifications.given_names:${id}`,
  family: (id: string) => `kyc.verifications.family_names:${id}`,
};

/** Normaliza el número de documento para el índice ciego (sin espacios ni guiones, mayúsculas). */
export const normalizeDocNumber = (n: string) => n.replace(/[\s.-]/g, '').toUpperCase();

@Injectable()
export class KycService {
  readonly #log = new Logger('KYC');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(KYC_PROVIDER) private readonly provider: KycProvider,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(BLIND_INDEX) private readonly bidx: BlindIndex,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async hasActiveConsent(userId: string, purpose: string, c: Pool | PoolClient = this.pool): Promise<boolean> {
    const { rows } = await c.query(`SELECT action FROM kyc.current_consents WHERE user_id = $1 AND purpose = $2`, [userId, purpose]);
    return rows[0]?.action === 'grant';
  }

  async createSession(userId: string, kind: VerificationKind, deviceId: string, req: AppRequest) {
    if (!(await this.hasActiveConsent(userId, 'biometric_kyc'))) {
      throw new AppError(403, 'consent_required', 'Debes aceptar el consentimiento de verificación biométrica');
    }
    const rl = await this.limiter.hit(`kyc-session:${userId}`, 5, 86400);
    if (!rl.allowed) throw tooManyRequests(rl.retryAfterSeconds);
    let reference: string | undefined;
    if (kind === 'full') {
      const current = await this.latest(userId, 'full', ['approved']);
      if (current) throw new AppError(409, 'already_verified', 'Tu identidad ya está verificada');
    } else {
      const base = await this.latest(userId, 'full', ['approved']);
      if (!base) throw new AppError(409, 'not_verified', 'Primero completa la verificación de identidad');
      reference = base.provider_session_ref;
    }
    const id = randomUUID();
    await this.pool.query(`INSERT INTO kyc.verifications (id, user_id, kind, provider, status, device_id) VALUES ($1, $2, $3, $4, 'created', $5)`, [
      id, userId, kind, this.provider.name, deviceId,
    ]);
    const session = await this.provider.createSession({ vendorData: id, kind, referenceSessionRef: reference });
    await this.pool.query('UPDATE kyc.verifications SET provider_session_ref = $2 WHERE id = $1', [id, session.sessionRef]);
    await this.audit.record({ action: 'kyc.session_create', resourceType: 'kyc_verification', resourceId: id, metadata: { kind } }, req);
    return { verificationId: id, sessionUrl: session.url, sdkToken: session.sdkToken };
  }

  async latest(userId: string, kind: VerificationKind, statuses?: string[]) {
    const { rows } = await this.pool.query<{ id: string; status: string; provider_session_ref: string; decided_at: Date | null; created_at: Date; doc_type: string | null; doc_country: string | null; doc_number_masked: string | null; reason: string | null }>(
      `SELECT id, status, provider_session_ref, decided_at, created_at, doc_type, doc_country, doc_number_masked, reason
       FROM kyc.verifications WHERE user_id = $1 AND kind = $2 AND ($3::text[] IS NULL OR status = ANY($3)) ORDER BY created_at DESC LIMIT 1`,
      [userId, kind, statuses ?? null],
    );
    return rows[0] ?? null;
  }

  /** Webhook del proveedor: firma → idempotencia → se CONSULTA la decisión (no se confía en el cuerpo). */
  async handleWebhook(rawBody: Buffer | undefined, headers: Record<string, string | undefined>, req: AppRequest): Promise<'ok' | 'duplicate'> {
    const sessionRef = rawBody ? this.provider.verifyWebhook(rawBody, headers) : null;
    if (!sessionRef) {
      await this.audit.recordSafe({ action: 'kyc.webhook', resourceType: 'kyc_webhook', outcome: 'denied', actorRole: 'provider' }, req);
      throw new AppError(401, 'invalid_signature', 'Firma inválida');
    }
    const eventHash = sha256(rawBody!);
    const seen = await this.pool.query('SELECT 1 FROM kyc.provider_events WHERE event_hash = $1', [eventHash]);
    if (seen.rowCount) return 'duplicate';
    const decision = await this.provider.getDecision(sessionRef);
    // applyDecision es idempotente (solo decide verificaciones en estado "created"); el evento se registra
    // DESPUÉS de aplicarlo para que un fallo intermedio permita el reintento del proveedor.
    await this.applyDecision(sessionRef, decision, req);
    await this.pool.query('INSERT INTO kyc.provider_events (event_hash, provider, session_ref) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
      eventHash, this.provider.name, sessionRef,
    ]);
    return 'ok';
  }

  async applyDecision(sessionRef: string, d: KycDecision, req?: AppRequest): Promise<void> {
    if (d.status === 'pending') return;
    try {
      await this.#apply(sessionRef, d, req);
    } catch (e) {
      // Carrera: otra cuenta aprobó el mismo documento a la vez (índice único) → revisión manual.
      if ((e as { code?: string }).code !== '23505') throw e;
      await this.pool.query(`UPDATE kyc.verifications SET status = 'duplicate_review', decided_at = now() WHERE provider_session_ref = $1 AND status = 'created'`, [sessionRef]);
      await this.audit.record({ action: 'kyc.decision', resourceType: 'kyc_verification', resourceId: sessionRef, actorRole: 'provider', outcome: 'denied', metadata: { status: 'duplicate_review' } }, req);
    }
  }

  async #apply(sessionRef: string, d: KycDecision, req?: AppRequest) {
    await withTransaction(this.pool, async (c) => {
      const { rows } = await c.query<{ id: string; user_id: string; kind: VerificationKind; status: string; created_at: Date }>(
        'SELECT id, user_id, kind, status, created_at FROM kyc.verifications WHERE provider_session_ref = $1 FOR UPDATE',
        [sessionRef],
      );
      const v = rows[0];
      if (!v || v.status !== 'created') return; // desconocida o ya decidida: no se reabre
      const deleteAfter = `now() + make_interval(days => ${Number(this.config.KYC_PROVIDER_RETENTION_DAYS)})`;
      let status: string = d.status;
      let docHmac: Buffer | null = null;

      if (d.status === 'approved' && d.document?.number) {
        const doc = normalizeDocNumber(d.document.number);
        docHmac = this.bidx.compute('id_document', doc);
        if (v.kind === 'full') {
          const dup = await c.query('SELECT user_id FROM kyc.verifications WHERE doc_number_hmac = $1 AND status = $2 AND kind = $3 AND user_id <> $4', [docHmac, 'approved', 'full', v.user_id]);
          if (dup.rowCount) status = 'duplicate_review';
          else await c.query(`UPDATE kyc.verifications SET status = 'superseded' WHERE user_id = $1 AND kind = 'full' AND status = 'approved'`, [v.user_id]);
        } else {
          // La re-verificación debe corresponder a la misma persona de la verificación completa.
          const base = await c.query('SELECT doc_number_hmac FROM kyc.verifications WHERE user_id = $1 AND kind = $2 AND status = $3', [v.user_id, 'full', 'approved']);
          if (!base.rows[0] || !docHmac.equals(base.rows[0].doc_number_hmac)) status = 'declined';
        }
        await c.query(
          `UPDATE kyc.verifications SET status = $2, reason = $3, risk_score = $4, doc_type = $5, doc_country = $6,
             doc_number_enc = $7, doc_number_hmac = $8, doc_number_masked = $9, given_names_enc = $10, family_names_enc = $11,
             decided_at = now(), provider_delete_after = ${deleteAfter}
           WHERE id = $1`,
          [
            v.id, status, status === 'declined' && v.kind === 'driver_reverify' ? 'person_mismatch' : d.reason ?? null, d.riskScore ?? null,
            d.document.type ?? null, d.document.country ?? null,
            await this.cipher.encrypt(doc, aad.docNumber(v.id)), docHmac, maskDocument(doc),
            d.person?.givenNames ? await this.cipher.encrypt(d.person.givenNames, aad.given(v.id)) : null,
            d.person?.familyNames ? await this.cipher.encrypt(d.person.familyNames, aad.family(v.id)) : null,
          ],
        );
      } else if (d.status === 'approved' && v.kind === 'full') {
        // Sin número de documento no se puede aprobar (no habría control de duplicados).
        status = 'declined';
        await c.query(`UPDATE kyc.verifications SET status = 'declined', reason = 'missing_document_number', decided_at = now(), provider_delete_after = ${deleteAfter} WHERE id = $1`, [v.id]);
      } else {
        await c.query(`UPDATE kyc.verifications SET status = $2, reason = $3, risk_score = $4, decided_at = now(), provider_delete_after = ${deleteAfter} WHERE id = $1`, [
          v.id, status, d.reason ?? null, d.riskScore ?? null,
        ]);
      }

      if (v.kind === 'driver_reverify' && status === 'approved') {
        await c.query('UPDATE kyc.reverification_requests SET satisfied_at = now(), verification_id = $2 WHERE user_id = $1 AND satisfied_at IS NULL AND created_at <= $3', [
          v.user_id, v.id, new Date(),
        ]);
      }
      await this.audit.record(
        { action: 'kyc.decision', resourceType: 'kyc_verification', resourceId: v.id, actorRole: 'provider', outcome: status === 'approved' ? 'success' : 'denied', metadata: { status, kind: v.kind } },
        req,
        c,
      );
      if (status === 'duplicate_review') this.#log.warn(`documento duplicado en verificación ${v.id}: requiere revisión manual`);
    });
  }

  /** Estado visible para el usuario: nunca incluye biometría ni el documento completo. */
  async status(userId: string) {
    const full = await this.latest(userId, 'full');
    const consent = await this.hasActiveConsent(userId, 'biometric_kyc');
    return {
      consentGiven: consent,
      verification: full ? { id: full.id, status: full.status, decidedAt: full.decided_at, documentType: full.doc_type, documentCountry: full.doc_country, documentNumber: full.doc_number_masked, reason: full.reason } : null,
    };
  }

  isApproved(userId: string) {
    return this.latest(userId, 'full', ['approved']).then((v) => !!v);
  }

  // ---------- Re-verificación de conductores ----------

  /** Decide si el conductor debe hacerse una selfie antes de conectarse; si sí, registra la exigencia. */
  async checkReverification(userId: string, deviceId: string, riskFlags: string[], req: AppRequest) {
    if (!(await this.hasActiveConsent(userId, 'biometric_kyc'))) throw new AppError(403, 'consent_required', 'Debes aceptar el consentimiento de verificación biométrica');
    if (!(await this.isApproved(userId))) throw new AppError(409, 'not_verified', 'Primero completa la verificación de identidad');
    const open = await this.pool.query<{ reason: string }>('SELECT reason FROM kyc.reverification_requests WHERE user_id = $1 AND satisfied_at IS NULL LIMIT 1', [userId]);
    if (open.rows[0]) return { required: true, reason: open.rows[0].reason };

    const last = await this.pool.query<{ decided_at: Date; device_id: string }>(
      `SELECT decided_at, device_id FROM kyc.verifications WHERE user_id = $1 AND kind = 'driver_reverify' AND status = 'approved' ORDER BY decided_at DESC LIMIT 1`,
      [userId],
    );
    const today = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM kyc.reverification_requests WHERE user_id = $1 AND reason = 'random_check' AND created_at >= (date_trunc('day', now() AT TIME ZONE 'America/Guayaquil') AT TIME ZONE 'America/Guayaquil')`,
      [userId],
    );
    const reason = reverificationReason({
      now: new Date(),
      lastApprovedAt: last.rows[0]?.decided_at ?? null,
      lastDeviceId: last.rows[0]?.device_id ?? null,
      currentDeviceId: deviceId,
      riskFlags,
      randomChecksToday: Number(today.rows[0]?.n ?? 0),
      random: randomInt(0, 1_000_000) / 1_000_000,
      probability: this.config.REVERIFY_PROBABILITY,
    });
    if (!reason) return { required: false };
    await this.pool.query('INSERT INTO kyc.reverification_requests (id, user_id, reason, device_id) VALUES ($1, $2, $3, $4)', [randomUUID(), userId, reason, deviceId]);
    await this.audit.record({ action: 'kyc.reverification_required', resourceType: 'user', resourceId: userId, metadata: { reason } }, req);
    return { required: true, reason };
  }

  /** Puerta para conectarse: lanza si hay una re-verificación pendiente o falta el consentimiento. */
  async assertDriverIdentityFresh(userId: string) {
    if (!(await this.hasActiveConsent(userId, 'biometric_kyc'))) throw new AppError(403, 'consent_required', 'Falta el consentimiento biométrico');
    if (!(await this.isApproved(userId))) throw new AppError(403, 'not_verified', 'Identidad no verificada');
    const open = await this.pool.query('SELECT 1 FROM kyc.reverification_requests WHERE user_id = $1 AND satisfied_at IS NULL', [userId]);
    if (open.rowCount) throw new AppError(403, 'reverification_required', 'Debes verificar tu identidad con una selfie antes de conectarte');
  }

  // ---------- Consentimiento y retención ----------

  /** Al revocar el consentimiento biométrico: el resultado deja de usarse y se pide al proveedor borrar todo ya. */
  async onBiometricConsentRevoked(userId: string, c: PoolClient) {
    await c.query(`UPDATE kyc.verifications SET status = 'revoked' WHERE user_id = $1 AND status IN ('approved', 'created', 'duplicate_review')`, [userId]);
    await c.query(`UPDATE kyc.verifications SET provider_delete_after = now() WHERE user_id = $1 AND provider_data_deleted_at IS NULL AND provider_session_ref IS NOT NULL`, [userId]);
  }

  /** Tarea periódica: pide al proveedor borrar imágenes y vídeo vencidos. Devuelve cuántas sesiones se borraron. */
  async purgeProviderData(limit = 100): Promise<number> {
    const { rows } = await this.pool.query<{ id: string; provider_session_ref: string }>(
      `SELECT id, provider_session_ref FROM kyc.verifications
       WHERE provider_delete_after <= now() AND provider_data_deleted_at IS NULL AND provider_session_ref IS NOT NULL AND provider = $1 LIMIT $2`,
      [this.provider.name, limit],
    );
    let n = 0;
    for (const r of rows) {
      try {
        await this.provider.deleteSessionData(r.provider_session_ref);
        await this.pool.query('UPDATE kyc.verifications SET provider_data_deleted_at = now() WHERE id = $1', [r.id]);
        await this.audit.record({ action: 'kyc.provider_data_deleted', resourceType: 'kyc_verification', resourceId: r.id, actorRole: 'system' });
        n++;
      } catch (e) {
        this.#log.error(`no se pudo borrar la sesión ${r.id} en el proveedor: ${(e as Error).message}`);
      }
    }
    return n;
  }
}
