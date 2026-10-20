import { Inject, Injectable } from '@nestjs/common';
import { maskDocument, type BlindIndex, type FieldCipher } from '@intitaxi/crypto';
import { withTransaction, type Pool } from '@intitaxi/db';
import { AppError, AuditService, RateLimiter, tooManyRequests, type AppRequest } from '@intitaxi/nest-common';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config.js';
import { inspectFile, MAX_DOCUMENT_BYTES } from '../../infra/file-inspection.js';
import { sha256Of, type StoragePort } from '../../infra/storage.js';
import { BLIND_INDEX, CONFIG, FIELD_CIPHER, PG_POOL, STORAGE } from '../../tokens.js';
import { KycService } from '../kyc/kyc.service.js';
import { eligibilityIssues, normalizePlate, todayInGuayaquil, type DocState } from './eligibility.js';

export interface DocumentRow {
  id: string;
  driver_id: string;
  vehicle_id: string | null;
  type: string;
  storage_key: string;
  content_type: string;
  size_bytes: number;
  sha256: Buffer;
  upload_status: string;
  scan_status: string;
  review_status: 'pending' | 'approved' | 'rejected';
  expires_on: string | null;
  rejection_reason: string | null;
  created_at: Date;
}

const licenseAad = (userId: string) => `drivers.profiles.license_number:${userId}`;

@Injectable()
export class DriversService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(BLIND_INDEX) private readonly bidx: BlindIndex,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(KycService) private readonly kyc: KycService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async apply(userId: string, input: { licenseNumber: string; licenseCategory: string; licenseExpiresOn: string }, req: AppRequest) {
    if (!(await this.kyc.isApproved(userId))) throw new AppError(409, 'kyc_required', 'Primero verifica tu identidad');
    if (input.licenseExpiresOn < todayInGuayaquil()) throw new AppError(400, 'license_expired', 'La licencia está vencida');
    const license = input.licenseNumber.replace(/[\s-]/g, '').toUpperCase();
    const hmac = this.bidx.compute('driver_license', license);
    try {
      await this.pool.query(
        `INSERT INTO drivers.profiles (user_id, license_number_enc, license_number_hmac, license_number_masked, license_category, license_expires_on)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id) DO UPDATE SET license_number_enc = EXCLUDED.license_number_enc, license_number_hmac = EXCLUDED.license_number_hmac,
           license_number_masked = EXCLUDED.license_number_masked, license_category = EXCLUDED.license_category,
           license_expires_on = EXCLUDED.license_expires_on, status = 'applicant', updated_at = now()
         WHERE drivers.profiles.status IN ('applicant', 'rejected')`,
        [userId, await this.cipher.encrypt(license, licenseAad(userId)), hmac, maskDocument(license), input.licenseCategory, input.licenseExpiresOn],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AppError(409, 'license_in_use', 'Esa licencia ya está registrada en otra cuenta');
      throw e;
    }
    await this.audit.record({ action: 'driver.apply', resourceType: 'driver', resourceId: userId }, req);
    return this.view(userId);
  }

  async #profile(userId: string) {
    const { rows } = await this.pool.query<{ user_id: string; status: string; license_number_masked: string; license_category: string; license_expires_on: string; decision_reason: string | null; risk_flags: string[] }>(
      `SELECT user_id, status, license_number_masked, license_category, to_char(license_expires_on, 'YYYY-MM-DD') AS license_expires_on, decision_reason, risk_flags
       FROM drivers.profiles WHERE user_id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  async requireProfile(userId: string) {
    const p = await this.#profile(userId);
    if (!p) throw new AppError(404, 'not_a_driver', 'Primero envía tu solicitud de conductor');
    return p;
  }

  async addVehicle(userId: string, v: { plate: string; make: string; model: string; year: number; color: string; seats: number; vehicleType: 'taxi' | 'van' }, req: AppRequest) {
    const profile = await this.requireProfile(userId);
    if (profile.status === 'suspended') throw new AppError(403, 'suspended', 'Cuenta suspendida');
    const plate = normalizePlate(v.plate);
    if (!plate) throw new AppError(400, 'invalid_plate', 'Placa inválida (formato AAA-1234)');
    const minYear = new Date().getFullYear() - this.config.VEHICLE_MAX_AGE_YEARS;
    if (v.year < minYear) throw new AppError(400, 'vehicle_too_old', `El vehículo debe ser del año ${minYear} o posterior`);
    // Taxi: hasta 4 pasajeros. Furgoneta: de 5 a 15. El revisor confirma los asientos contra la matrícula.
    const [min, max] = v.vehicleType === 'van' ? [5, 15] : [1, 4];
    if (v.seats < min || v.seats > max) throw new AppError(400, 'invalid_seats', `Un${v.vehicleType === 'van' ? 'a furgoneta' : ' taxi'} debe tener entre ${min} y ${max} asientos para pasajeros`);
    const id = randomUUID();
    try {
      await this.pool.query(
        'INSERT INTO drivers.vehicles (id, driver_id, plate, make, model, year, color, seats_passenger, vehicle_type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [id, userId, plate, v.make, v.model, v.year, v.color, v.seats, v.vehicleType],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AppError(409, 'plate_in_use', 'Esa placa ya está registrada');
      throw e;
    }
    await this.audit.record({ action: 'driver.vehicle_add', resourceType: 'vehicle', resourceId: id, metadata: { plate, vehicleType: v.vehicleType, seats: v.seats } }, req);
    return { id, plate };
  }

  async createUpload(userId: string, d: { type: string; vehicleId?: string; contentType: string; size: number; sha256: string; expiresOn?: string }, req: AppRequest) {
    const profile = await this.requireProfile(userId);
    if (profile.status === 'suspended') throw new AppError(403, 'suspended', 'Cuenta suspendida');
    const rl = await this.limiter.hit(`doc-upload:${userId}`, 30, 86400);
    if (!rl.allowed) throw tooManyRequests(rl.retryAfterSeconds);
    const needsVehicle = d.type === 'registration' || d.type === 'insurance';
    if (needsVehicle !== !!d.vehicleId) throw new AppError(400, 'invalid_request', needsVehicle ? 'Indica el vehículo' : 'Este documento no es de un vehículo');
    if (d.vehicleId) {
      // Autorización a nivel de objeto: el vehículo debe ser del propio conductor.
      const own = await this.pool.query('SELECT 1 FROM drivers.vehicles WHERE id = $1 AND driver_id = $2', [d.vehicleId, userId]);
      if (!own.rowCount) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    }
    const id = randomUUID();
    const key = `drivers/${userId}/${id}`;
    await this.pool.query(
      `INSERT INTO drivers.documents (id, driver_id, vehicle_id, type, storage_key, content_type, size_bytes, sha256, expires_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, userId, d.vehicleId ?? null, d.type, key, d.contentType, d.size, Buffer.from(d.sha256, 'hex'), d.expiresOn ?? null],
    );
    const upload = await this.storage.createUpload(key, d.contentType, d.size);
    await this.audit.record({ action: 'driver.document_upload_url', resourceType: 'driver_document', resourceId: id, metadata: { type: d.type } }, req);
    return { documentId: id, upload };
  }

  /** Tras subir: tamaño y hash exactos, tipo real (magic bytes), contenido activo y antimalware. */
  async completeUpload(userId: string, documentId: string, req: AppRequest) {
    const { rows } = await this.pool.query<DocumentRow>('SELECT * FROM drivers.documents WHERE id = $1 AND driver_id = $2', [documentId, userId]);
    const doc = rows[0];
    if (!doc) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    if (doc.upload_status !== 'pending') throw new AppError(409, 'already_processed', 'El documento ya fue procesado');
    const head = await this.storage.head(doc.storage_key);
    if (!head) throw new AppError(409, 'not_uploaded', 'El archivo aún no se ha subido');
    let reason: string | null = null;
    let scan: 'clean' | 'infected' | 'invalid' | 'pending' = 'pending';
    if (head.size !== doc.size_bytes || head.size > MAX_DOCUMENT_BYTES) reason = 'size_mismatch';
    else {
      const data = await this.storage.read(doc.storage_key, MAX_DOCUMENT_BYTES);
      if (!sha256Of(data).equals(doc.sha256)) reason = 'hash_mismatch';
      else {
        const insp = inspectFile(doc.content_type, data);
        if (!insp.ok) {
          reason = insp.reason;
          scan = insp.reason === 'malware' ? 'infected' : 'invalid';
        } else scan = await this.storage.scanStatus(doc.storage_key);
      }
    }
    await withTransaction(this.pool, async (c) => {
      if (reason) {
        await c.query(`UPDATE drivers.documents SET upload_status = 'rejected', scan_status = $2, rejection_reason = $3 WHERE id = $1`, [doc.id, scan === 'pending' ? 'invalid' : scan, reason]);
      } else {
        // El nuevo documento reemplaza al anterior del mismo tipo (y vehículo).
        await c.query(
          `UPDATE drivers.documents SET superseded_at = now() WHERE driver_id = $1 AND type = $2 AND vehicle_id IS NOT DISTINCT FROM $3 AND id <> $4 AND superseded_at IS NULL`,
          [userId, doc.type, doc.vehicle_id, doc.id],
        );
        await c.query(`UPDATE drivers.documents SET upload_status = 'uploaded', scan_status = $2 WHERE id = $1`, [doc.id, scan]);
      }
      await this.audit.record({ action: 'driver.document_complete', resourceType: 'driver_document', resourceId: doc.id, outcome: reason ? 'denied' : 'success', metadata: { reason } }, req, c);
    });
    if (reason) {
      await this.storage.delete(doc.storage_key); // nunca se conserva un archivo rechazado
      throw new AppError(422, 'document_rejected', `Documento rechazado: ${reason}`);
    }
    return { documentId: doc.id, status: 'uploaded', scanStatus: scan };
  }

  async submit(userId: string, req: AppRequest) {
    const view = await this.view(userId);
    if (!['applicant', 'rejected'].includes(view.status)) throw new AppError(409, 'invalid_state', 'La solicitud ya fue enviada');
    const pendingReview = await this.eligibility(userId, { forApproval: true, ignoreReview: true });
    if (pendingReview.length) throw new AppError(409, 'incomplete', `Faltan requisitos: ${pendingReview.join(', ')}`);
    await this.pool.query(`UPDATE drivers.profiles SET status = 'under_review', submitted_at = now(), updated_at = now() WHERE user_id = $1`, [userId]);
    await this.audit.record({ action: 'driver.submit', resourceType: 'driver', resourceId: userId }, req);
    return { status: 'under_review' };
  }

  async documents(userId: string): Promise<DocumentRow[]> {
    const { rows } = await this.pool.query<DocumentRow>(
      `SELECT *, to_char(expires_on, 'YYYY-MM-DD') AS expires_on FROM drivers.documents WHERE driver_id = $1 AND superseded_at IS NULL ORDER BY created_at`,
      [userId],
    );
    return rows;
  }

  async vehicles(userId: string) {
    const { rows } = await this.pool.query<{ id: string; plate: string; make: string; model: string; year: number; color: string; seats_passenger: number; vehicle_type: string; seats_verified: boolean; status: string }>(
      'SELECT id, plate, make, model, year, color, seats_passenger, vehicle_type, seats_verified_at IS NOT NULL AS seats_verified, status FROM drivers.vehicles WHERE driver_id = $1 ORDER BY created_at',
      [userId],
    );
    return rows;
  }

  /** Motivos por los que no puede operar (o no puede aprobarse, con forApproval). */
  async eligibility(userId: string, opts: { forApproval?: boolean; ignoreReview?: boolean } = {}) {
    const p = await this.requireProfile(userId);
    const docs: DocState[] = (await this.documents(userId))
      .filter((d) => d.upload_status === 'uploaded')
      .map((d) => ({
        type: d.type,
        vehicleId: d.vehicle_id,
        reviewStatus: opts.ignoreReview ? 'approved' : d.review_status,
        scanStatus: d.scan_status,
        uploadStatus: d.upload_status,
        expiresOn: d.expires_on,
      }));
    return eligibilityIssues(
      { today: todayInGuayaquil(), kycApproved: await this.kyc.isApproved(userId), profileStatus: p.status, licenseExpiresOn: p.license_expires_on, vehicles: await this.vehicles(userId), docs },
      { forApproval: opts.forApproval },
    );
  }

  async view(userId: string) {
    const p = await this.requireProfile(userId);
    return {
      status: p.status,
      license: { number: p.license_number_masked, category: p.license_category, expiresOn: p.license_expires_on },
      decisionReason: p.decision_reason,
      vehicles: await this.vehicles(userId),
      documents: (await this.documents(userId)).map((d) => ({
        id: d.id, type: d.type, vehicleId: d.vehicle_id, uploadStatus: d.upload_status, scanStatus: d.scan_status, reviewStatus: d.review_status, expiresOn: d.expires_on, rejectionReason: d.rejection_reason,
      })),
      issues: p.status === 'approved' ? await this.eligibility(userId) : undefined,
    };
  }

  // ---------- Revisión (administración) ----------

  async queue(status: string) {
    const { rows } = await this.pool.query(
      `SELECT user_id AS "driverId", status, license_category AS "licenseCategory", submitted_at AS "submittedAt" FROM drivers.profiles WHERE status = $1 ORDER BY submitted_at NULLS LAST LIMIT 100`,
      [status],
    );
    return rows;
  }

  async documentViewUrl(adminId: string, driverId: string, documentId: string, reason: string, req: AppRequest) {
    const { rows } = await this.pool.query<DocumentRow>(`SELECT * FROM drivers.documents WHERE id = $1 AND driver_id = $2 AND upload_status = 'uploaded'`, [documentId, driverId]);
    if (!rows[0]) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    await this.audit.record({ action: 'driver.document_view', resourceType: 'driver_document', resourceId: documentId, actorUserId: adminId, actorRole: 'driver_reviewer', purpose: 'driver_review', metadata: { reason } }, req);
    return { url: await this.storage.createDownloadUrl(rows[0].storage_key, 60), expiresIn: 60 };
  }

  async reviewDocument(adminId: string, driverId: string, documentId: string, decision: 'approved' | 'rejected', reason: string | undefined, req: AppRequest, confirmedSeats?: number) {
    if (adminId === driverId) throw new AppError(403, 'forbidden', 'No puedes revisar tu propia solicitud');
    // Matrícula: al aprobarla, el revisor confirma los asientos que figuran en el documento.
    const doc = (await this.pool.query<{ type: string; vehicle_id: string | null; seats: number | null }>(
      `SELECT d.type, d.vehicle_id, v.seats_passenger AS seats FROM drivers.documents d LEFT JOIN drivers.vehicles v ON v.id = d.vehicle_id WHERE d.id = $1 AND d.driver_id = $2`,
      [documentId, driverId],
    )).rows[0];
    if (doc?.type === 'registration' && decision === 'approved') {
      if (confirmedSeats === undefined) throw new AppError(400, 'seats_confirmation_required', 'Confirma cuántos asientos para pasajeros indica la matrícula');
      if (confirmedSeats !== doc.seats) throw new AppError(409, 'seats_mismatch', `La matrícula indica ${confirmedSeats} asientos y el conductor declaró ${doc.seats}: rechaza el documento o pide que corrija el vehículo`);
    }
    const r = await this.pool.query(
      `UPDATE drivers.documents SET review_status = $3, reviewed_by = $4, reviewed_at = now(), rejection_reason = $5
       WHERE id = $1 AND driver_id = $2 AND upload_status = 'uploaded' AND scan_status = 'clean' AND superseded_at IS NULL`,
      [documentId, driverId, decision, adminId, decision === 'rejected' ? reason ?? 'sin motivo' : null],
    );
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Documento no disponible para revisión');
    if (doc?.type === 'registration' && decision === 'approved') {
      await this.pool.query('UPDATE drivers.vehicles SET seats_verified_by = $2, seats_verified_at = now() WHERE id = $1', [doc.vehicle_id, adminId]);
    }
    await this.audit.record({ action: 'driver.document_review', resourceType: 'driver_document', resourceId: documentId, actorUserId: adminId, actorRole: 'driver_reviewer', metadata: { decision, ...(confirmedSeats ? { confirmedSeats } : {}) } }, req);
    return { documentId, reviewStatus: decision };
  }

  async decide(adminId: string, driverId: string, decision: 'approve' | 'reject' | 'suspend', reason: string, req: AppRequest) {
    if (adminId === driverId) throw new AppError(403, 'forbidden', 'No puedes decidir sobre tu propia cuenta');
    const p = await this.requireProfile(driverId);
    const allowed: Record<string, string[]> = { approve: ['under_review', 'suspended'], reject: ['under_review'], suspend: ['approved'] };
    if (!allowed[decision]!.includes(p.status)) throw new AppError(409, 'invalid_state', `No se puede ${decision} desde ${p.status}`);
    if (decision === 'approve') {
      const issues = await this.eligibility(driverId, { forApproval: true });
      if (issues.length) throw new AppError(409, 'not_eligible', `No cumple requisitos: ${issues.join(', ')}`);
    }
    const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'suspended';
    await withTransaction(this.pool, async (c) => {
      await c.query('UPDATE drivers.profiles SET status = $2, decided_by = $3, decided_at = now(), decision_reason = $4, updated_at = now() WHERE user_id = $1', [driverId, status, adminId, reason]);
      if (decision === 'approve') {
        await c.query(
          `UPDATE drivers.vehicles v SET status = 'approved' WHERE driver_id = $1 AND status = 'pending' AND
             v.seats_verified_at IS NOT NULL AND
             (SELECT count(*) FROM drivers.documents d WHERE d.vehicle_id = v.id AND d.review_status = 'approved' AND d.superseded_at IS NULL) >= 2`,
          [driverId],
        );
      }
      await this.audit.record({ action: `driver.${decision}`, resourceType: 'driver', resourceId: driverId, actorUserId: adminId, actorRole: 'driver_reviewer', metadata: { reason } }, req, c);
    });
    return { driverId, status };
  }
}
