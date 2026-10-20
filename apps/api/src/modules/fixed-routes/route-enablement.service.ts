import { Inject, Injectable } from '@nestjs/common';
import type { FieldCipher } from '@intitaxi/crypto';
import { withTransaction, type Pool } from '@intitaxi/db';
import { AppError, AuditService, RateLimiter, tooManyRequests, type AppRequest } from '@intitaxi/nest-common';
import { randomUUID } from 'node:crypto';
import { FIELD_CIPHER, PG_POOL } from '../../tokens.js';
import { ALLOWED_VEHICLE_TYPES, type PartnerKind } from '../drivers/eligibility.js';
import { FixedRoutesService } from './fixed-routes.service.js';
import { RoutesAdminService } from './routes-admin.service.js';

/** Tipos de socio que pueden pedir trabajar en Taxi Ruta desde la app. */
export const ROUTE_PARTNER_KINDS: readonly PartnerKind[] = ['route_taxi_owner', 'van_owner', 'taxi_driver'];

/**
 * Solicitudes de habilitación en Taxi Ruta: el dueño de taxi amarillo o de furgoneta la pide desde la app con un
 * vehículo aprobado; una persona con rol route_manager decide. Aprobar crea la misma habilitación que el panel.
 */
@Injectable()
export class RouteEnablementService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(FixedRoutesService) private readonly routes: FixedRoutesService,
    @Inject(RoutesAdminService) private readonly admin: RoutesAdminService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Rutas activas con el estado del socio en cada una: habilitado o la última solicitud. */
  async catalog(driverId: string) {
    const { rows } = await this.pool.query<{ id: string; code: string; name: string; enabled: boolean; request_id: string | null; request_status: string | null; request_reason: string | null }>(
      `SELECT r.id, r.code, r.name,
         EXISTS (SELECT 1 FROM fixed_routes.driver_enablements e WHERE e.route_id = r.id AND e.driver_id = $1 AND e.revoked_at IS NULL) AS enabled,
         q.id AS request_id, q.status AS request_status, q.reason AS request_reason
       FROM fixed_routes.routes r
       LEFT JOIN LATERAL (SELECT id, status, reason FROM fixed_routes.enablement_requests x WHERE x.route_id = r.id AND x.driver_id = $1 ORDER BY x.created_at DESC LIMIT 1) q ON true
       WHERE r.status = 'active' ORDER BY r.code`,
      [driverId],
    );
    return Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        serviceHours: (await this.routes.serviceHoursView(r.id)).serviceHours,
        enabled: r.enabled,
        request: r.request_id ? { id: r.request_id, status: r.request_status, reason: r.request_reason } : null,
      })),
    );
  }

  async request(driverId: string, routeId: string, vehicleId: string, req: AppRequest) {
    const rl = await this.limiter.hit(`route-enable-req:${driverId}`, 10, 86400);
    if (!rl.allowed) throw tooManyRequests(rl.retryAfterSeconds);
    const p = (await this.pool.query<{ status: string; partner_kind: PartnerKind }>(`SELECT status, partner_kind FROM drivers.profiles WHERE user_id = $1`, [driverId])).rows[0];
    if (!p) throw new AppError(404, 'not_a_driver', 'Primero envía tu solicitud de socio');
    if (!ROUTE_PARTNER_KINDS.includes(p.partner_kind)) throw new AppError(403, 'partner_kind_not_allowed', 'Taxi Ruta es para dueños de taxi amarillo y de furgoneta');
    if (p.status !== 'approved') throw new AppError(409, 'driver_not_approved', 'Tu cuenta de socio aún no está aprobada');
    const route = (await this.pool.query(`SELECT status FROM fixed_routes.routes WHERE id = $1`, [routeId])).rows[0];
    if (!route || route.status !== 'active') throw new AppError(404, 'not_found', 'Ruta no encontrada');
    // Autorización por objeto: el vehículo debe ser del propio socio, estar aprobado y ser de un tipo que su perfil permite.
    const v = (await this.pool.query<{ status: string; vehicle_type: string }>(`SELECT status, vehicle_type FROM drivers.vehicles WHERE id = $1 AND driver_id = $2`, [vehicleId, driverId])).rows[0];
    if (!v) throw new AppError(404, 'not_found', 'Vehículo no encontrado');
    if (!['taxi', 'van'].includes(v.vehicle_type) || !ALLOWED_VEHICLE_TYPES[p.partner_kind].includes(v.vehicle_type as 'taxi' | 'van')) {
      throw new AppError(409, 'invalid_vehicle', 'Taxi Ruta es solo para taxis y furgonetas');
    }
    if (v.status !== 'approved') throw new AppError(409, 'vehicle_not_approved', 'El vehículo aún no está aprobado');
    const en = await this.pool.query(`SELECT 1 FROM fixed_routes.driver_enablements WHERE driver_id = $1 AND route_id = $2 AND revoked_at IS NULL`, [driverId, routeId]);
    if (en.rowCount) throw new AppError(409, 'already_enabled', 'Ya estás habilitado en esta ruta');
    const id = randomUUID();
    await this.pool
      .query(`INSERT INTO fixed_routes.enablement_requests (id, driver_id, route_id, vehicle_id) VALUES ($1, $2, $3, $4)`, [id, driverId, routeId, vehicleId])
      .catch((e: { code?: string }) => {
        throw e.code === '23505' ? new AppError(409, 'request_pending', 'Ya tienes una solicitud pendiente para esta ruta') : e;
      });
    await this.audit.record({ action: 'route.enablement_request', resourceType: 'route', resourceId: routeId, metadata: { requestId: id, vehicleId } }, req);
    return { id, routeId, vehicleId, status: 'pending' };
  }

  // ---------- Panel (route_manager) ----------

  async list(status: 'pending' | 'approved' | 'rejected') {
    const { rows } = await this.pool.query(
      `SELECT q.id, q.status, q.reason, q.created_at AS "createdAt", q.decided_at AS "decidedAt",
         q.route_id AS "routeId", r.code AS "routeCode", q.driver_id AS "driverId", p.partner_kind AS "partnerKind",
         q.vehicle_id AS "vehicleId", v.plate, v.vehicle_type AS "vehicleType", v.seats_passenger AS seats
       FROM fixed_routes.enablement_requests q
       JOIN fixed_routes.routes r ON r.id = q.route_id
       JOIN drivers.profiles p ON p.user_id = q.driver_id
       JOIN drivers.vehicles v ON v.id = q.vehicle_id
       WHERE q.status = $1 ORDER BY q.created_at LIMIT 100`,
      [status],
    );
    return Promise.all(rows.map(async ({ driverId, ...r }) => ({ ...r, driverId, driverFirstName: await this.#firstName(driverId) })));
  }

  /** Nombre de pila verificado (KYC); el panel no necesita el nombre completo para decidir. */
  async #firstName(userId: string): Promise<string | null> {
    const k = (await this.pool.query<{ id: string; given_names_enc: Buffer | null }>(
      `SELECT id, given_names_enc FROM kyc.verifications WHERE user_id = $1 AND kind = 'full' AND status = 'approved' ORDER BY decided_at DESC LIMIT 1`,
      [userId],
    )).rows[0];
    if (!k?.given_names_enc) return null;
    return (await this.cipher.decrypt(k.given_names_enc, `kyc.verifications.given_names:${k.id}`)).split(' ')[0] ?? null;
  }

  async decide(adminId: string, requestId: string, approve: boolean, reason: string | undefined, req: AppRequest) {
    return withTransaction(this.pool, async (c) => {
      const q = (await c.query<{ driver_id: string; route_id: string; vehicle_id: string; status: string }>(
        `SELECT driver_id, route_id, vehicle_id, status FROM fixed_routes.enablement_requests WHERE id = $1 FOR UPDATE`,
        [requestId],
      )).rows[0];
      if (!q) throw new AppError(404, 'not_found', 'Solicitud no encontrada');
      if (q.status !== 'pending') throw new AppError(409, 'invalid_state', 'La solicitud ya fue decidida');
      if (q.driver_id === adminId) throw new AppError(403, 'forbidden', 'No puedes decidir tu propia solicitud');
      if (approve) {
        // El vehículo pudo dejar de estar aprobado desde que se pidió.
        const v = await c.query(`SELECT 1 FROM drivers.vehicles WHERE id = $1 AND driver_id = $2 AND status = 'approved'`, [q.vehicle_id, q.driver_id]);
        if (!v.rowCount) throw new AppError(409, 'vehicle_not_approved', 'El vehículo de la solicitud ya no está aprobado');
        await this.admin.enable(adminId, q.route_id, q.driver_id, req, c);
      }
      const status = approve ? 'approved' : 'rejected';
      await c.query(`UPDATE fixed_routes.enablement_requests SET status = $2, reason = $3, decided_by = $4, decided_at = now() WHERE id = $1`, [requestId, status, reason ?? null, adminId]);
      await this.audit.record(
        { action: 'route.enablement_decision', resourceType: 'route', resourceId: q.route_id, actorUserId: adminId, actorRole: 'route_manager', metadata: { requestId, driverId: q.driver_id, approve } },
        req,
        c,
      );
      return { id: requestId, status, routeId: q.route_id, driverId: q.driver_id };
    });
  }
}
