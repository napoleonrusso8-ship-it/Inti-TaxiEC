import { Inject, Injectable } from '@nestjs/common';
import { withTransaction, type Pool, type PoolClient } from '@intitaxi/db';
import { analyzeStopOrder, decodePolyline, localParts, pathFromStops, validateFareCoverage, type LatLng } from '@intitaxi/domain';
import { AppError, AuditService, type AppRequest } from '@intitaxi/nest-common';
import { randomUUID } from 'node:crypto';
import { MAPS, PG_POOL } from '../../tokens.js';
import type { MapsPort } from '../../infra/maps.js';
import { FixedRoutesService } from './fixed-routes.service.js';

export interface StopInput {
  stopId?: string;
  name: string;
  reference?: string;
  lat: number;
  lng: number;
  locationVerified?: boolean;
}

export interface FareInput {
  name: string;
  startLocal: string;
  endLocal: string;
  amountCents: number;
  validFrom?: string;
  validTo?: string;
  priority?: number;
}

const EDITABLE = ['draft', 'paused'];

/**
 * Gestión de rutas desde el panel (rol route_manager). Rutas, paradas, horarios y tarifas se configuran
 * sin cambiar código. Principio de cuatro ojos: quien pide publicar no puede aprobar la publicación.
 * Una ruta activa no se edita: se pausa, se edita y se vuelve a publicar (las reservas ya hechas conservan
 * su tarifa y paradas).
 */
@Injectable()
export class RoutesAdminService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MAPS) private readonly maps: MapsPort,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FixedRoutesService) private readonly routes: FixedRoutesService,
  ) {}

  async list() {
    const { rows } = await this.pool.query(
      `SELECT r.id, r.code, r.name, r.status, r.corridor, r.publish_requested_by AS "publishRequestedBy", r.published_at AS "publishedAt",
         (SELECT count(*)::int FROM fixed_routes.driver_enablements e WHERE e.route_id = r.id AND e.revoked_at IS NULL) AS "enabledDrivers",
         (SELECT count(*)::int FROM fixed_routes.instances i JOIN fixed_routes.directions d ON d.id = i.direction_id WHERE d.route_id = r.id AND i.status = 'in_service') AS "vehiclesInService"
       FROM fixed_routes.routes r ORDER BY r.code`,
    );
    return rows;
  }

  detail(routeId: string) {
    return this.routes.detail(routeId, true);
  }

  async create(adminId: string, input: { code: string; name: string; corridor?: string }, req: AppRequest) {
    const id = randomUUID();
    await withTransaction(this.pool, async (c) => {
      await c.query(`INSERT INTO fixed_routes.routes (id, code, name, corridor, status, created_by) VALUES ($1, $2, $3, $4, 'draft', $5)`, [id, input.code, input.name, input.corridor ?? null, adminId]).catch(dup('Ya existe una ruta con ese código'));
      for (const [direction, label] of [['outbound', 'Ida'], ['inbound', 'Vuelta']]) {
        await c.query(`INSERT INTO fixed_routes.directions (id, route_id, direction, label) VALUES ($1, $2, $3, $4)`, [randomUUID(), id, direction, label]);
      }
      await this.audit.record({ action: 'route.create', resourceType: 'route', resourceId: id, metadata: { code: input.code } }, req, c);
    });
    return { id, status: 'draft' };
  }

  async #editable(c: PoolClient, routeId: string) {
    const r = (await c.query(`SELECT status FROM fixed_routes.routes WHERE id = $1 FOR UPDATE`, [routeId])).rows[0];
    if (!r) throw new AppError(404, 'not_found', 'Ruta no encontrada');
    if (!EDITABLE.includes(r.status)) throw new AppError(409, 'route_not_editable', 'Pausa la ruta antes de editarla (o espera la decisión de la publicación pendiente)');
    // Toda edición invalida una solicitud de publicación previa y la validación.
    await c.query(`UPDATE fixed_routes.routes SET status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'draft' END, publish_requested_by = NULL WHERE id = $1`, [routeId]);
  }

  /** Reemplaza las paradas de un sentido (el orden del arreglo es el recorrido). Reutiliza paradas por stopId. */
  async setStops(routeId: string, direction: string, input: { label?: string; stops: StopInput[] }, req: AppRequest) {
    await withTransaction(this.pool, async (c) => {
      await this.#editable(c, routeId);
      const dir = (await c.query(`SELECT id FROM fixed_routes.directions WHERE route_id = $1 AND direction = $2`, [routeId, direction])).rows[0];
      if (!dir) throw new AppError(404, 'not_found', 'Sentido no encontrado');
      await c.query(`DELETE FROM fixed_routes.direction_stops WHERE direction_id = $1`, [dir.id]);
      for (const [seq, s] of input.stops.entries()) {
        let stopId = s.stopId;
        if (stopId) {
          const u = await c.query(`UPDATE fixed_routes.stops SET name = $2, reference = $3, lat = $4, lng = $5, location_verified = $6 WHERE id = $1`, [stopId, s.name, s.reference ?? null, s.lat, s.lng, s.locationVerified ?? false]);
          if (!u.rowCount) throw new AppError(400, 'invalid_stop', `Parada desconocida: ${s.name}`);
        } else {
          stopId = randomUUID();
          await c.query(`INSERT INTO fixed_routes.stops (id, name, reference, lat, lng, location_verified) VALUES ($1, $2, $3, $4, $5, $6)`, [stopId, s.name, s.reference ?? null, s.lat, s.lng, s.locationVerified ?? false]);
        }
        await c.query(`INSERT INTO fixed_routes.direction_stops (direction_id, stop_id, seq) VALUES ($1, $2, $3)`, [dir.id, stopId, seq]).catch(dup('Una parada no puede repetirse en el mismo sentido'));
      }
      await c.query(`UPDATE fixed_routes.directions SET label = COALESCE($2, label), path = NULL, validated_at = NULL, validation_report = NULL WHERE id = $1`, [dir.id, input.label ?? null]);
      await this.audit.record({ action: 'route.stops_set', resourceType: 'route', resourceId: routeId, metadata: { direction, count: input.stops.length } }, req, c);
    });
    return this.detail(routeId);
  }

  /** Reemplaza las franjas tarifarias. Las anteriores se retiran (no se borran: los recibos las citan). */
  async setFares(routeId: string, rules: FareInput[], req: AppRequest) {
    const preview = rules.map((r, i) => ({ id: String(i), name: r.name, startLocal: r.startLocal, endLocal: r.endLocal, amountCents: r.amountCents, validFrom: r.validFrom ?? '2000-01-01', validTo: r.validTo ?? null, priority: r.priority ?? 0 }));
    const coverage = validateFareCoverage(preview, localParts(new Date()).date);
    if (!coverage.ok) throw new AppError(400, 'fare_coverage', `Las franjas deben cubrir las 24 h sin solaparse. Huecos: ${coverage.gaps.join(', ') || '—'}; solapes: ${coverage.overlaps.join(', ') || '—'}`);
    await withTransaction(this.pool, async (c) => {
      await this.#editable(c, routeId);
      await c.query(`UPDATE fixed_routes.fare_rules SET retired_at = now() WHERE route_id = $1 AND retired_at IS NULL`, [routeId]);
      for (const r of preview) {
        await c.query(
          `INSERT INTO fixed_routes.fare_rules (id, route_id, name, start_local, end_local, amount_cents, valid_from, valid_to, priority) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [randomUUID(), routeId, r.name, r.startLocal, r.endLocal, r.amountCents, r.validFrom, r.validTo, r.priority],
        );
      }
      await this.audit.record({ action: 'route.fares_set', resourceType: 'route', resourceId: routeId, metadata: { rules: preview.map((r) => `${r.name} ${r.startLocal}-${r.endLocal} ${r.amountCents}`).join('; ') } }, req, c);
    });
    return { fares: await this.routes.rules(routeId), coverage };
  }

  async setSchedules(routeId: string, schedules: { days: number[]; start: string; end: string; headwayMinutes: number }[], req: AppRequest) {
    await withTransaction(this.pool, async (c) => {
      await this.#editable(c, routeId);
      await c.query(`DELETE FROM fixed_routes.schedules WHERE route_id = $1`, [routeId]);
      for (const s of schedules) {
        await c.query(`INSERT INTO fixed_routes.schedules (id, route_id, days_of_week, service_start_local, service_end_local, headway_minutes) VALUES ($1, $2, $3, $4, $5, $6)`, [randomUUID(), routeId, s.days, s.start, s.end, s.headwayMinutes]);
      }
      await this.audit.record({ action: 'route.schedules_set', resourceType: 'route', resourceId: routeId }, req, c);
    });
    return this.detail(routeId);
  }

  /**
   * Validación con la API de mapas:
   *  1. Ruta directa primera → última parada (sin paradas intermedias) y proyección de cada parada sobre ella:
   *     si la distancia recorrida no crece con el orden, se avisa y se sugiere un orden. Es INFORMATIVO:
   *     el operador conoce el recorrido real (p. ej. la Ruta 1, cuyo orden confirmó el propietario).
   *  2. Ruta pasando por las paradas en el orden dado: es la polilínea que se guarda y se muestra.
   *  3. Cobertura de tarifas (24 h sin huecos ni solapes).
   */
  async validate(routeId: string, req: AppRequest) {
    const dirs = (await this.pool.query(`SELECT id, direction FROM fixed_routes.directions WHERE route_id = $1 ORDER BY direction DESC`, [routeId])).rows;
    if (!dirs.length) throw new AppError(404, 'not_found', 'Ruta no encontrada');
    const report: Record<string, unknown> = {};
    let ok = true;
    for (const d of dirs) {
      const stops = await this.routes.stops(d.id);
      if (stops.length < 2) {
        report[d.direction] = { ok: false, error: 'Se necesitan al menos 2 paradas' };
        ok = false;
        continue;
      }
      const pts: LatLng[] = stops.map((s) => ({ lat: s.lat, lng: s.lng }));
      const direct = await this.maps.route(pts[0]!, pts.at(-1)!);
      const directPath = direct.polyline ? decodePolyline(direct.polyline) : pathFromStops([pts[0]!, pts.at(-1)!]);
      const order = analyzeStopOrder(directPath, stops.map((s) => ({ stopId: s.id, name: s.name, seq: s.seq, lat: s.lat, lng: s.lng })), direct.polyline ? 300 : 5_000);
      const through = await this.maps.route(pts[0]!, pts.at(-1)!, pts.slice(1, -1));
      const path = through.polyline ? decodePolyline(through.polyline) : pathFromStops(pts);
      const unverified = stops.filter((s) => !s.locationVerified).map((s) => s.name);
      const dirReport = {
        ok: true,
        provider: direct.polyline ? 'maps' : 'estimator',
        distanceM: through.distanceM,
        durationS: through.durationS,
        stopOrder: { ...order, informative: true },
        unverifiedLocations: unverified,
        warnings: [
          ...(order.outOfOrder.length ? [`Orden distinto al de la ruta directa en: ${order.outOfOrder.join(', ')} (revisar si el recorrido real lo justifica)`] : []),
          ...(unverified.length ? [`Coordenadas sin confirmar en terreno: ${unverified.join(', ')}`] : []),
        ],
      };
      await this.pool.query(`UPDATE fixed_routes.directions SET path = $2, validated_at = now(), validation_report = $3 WHERE id = $1`, [d.id, JSON.stringify(path), dirReport]);
      report[d.direction] = dirReport;
    }
    const coverage = validateFareCoverage(await this.routes.rules(routeId), localParts(new Date()).date);
    if (!coverage.ok) ok = false;
    await this.audit.record({ action: 'route.validate', resourceType: 'route', resourceId: routeId, metadata: { ok } }, req);
    return { ok, fares: coverage, directions: report };
  }

  async requestPublish(adminId: string, routeId: string, req: AppRequest) {
    await withTransaction(this.pool, async (c) => {
      const r = (await c.query(`SELECT status FROM fixed_routes.routes WHERE id = $1 FOR UPDATE`, [routeId])).rows[0];
      if (!r) throw new AppError(404, 'not_found', 'Ruta no encontrada');
      if (!EDITABLE.includes(r.status)) throw new AppError(409, 'invalid_state', 'La ruta no está en borrador ni pausada');
      const dirs = (await c.query(`SELECT validated_at, validation_report FROM fixed_routes.directions WHERE route_id = $1`, [routeId])).rows;
      if (dirs.length < 2 || dirs.some((d) => !d.validated_at || !d.validation_report?.ok)) throw new AppError(409, 'not_validated', 'Valida ambos sentidos de la ruta antes de solicitar la publicación');
      if (!validateFareCoverage(await this.routes.rules(routeId, c), localParts(new Date()).date).ok) throw new AppError(409, 'fare_coverage', 'Las tarifas no cubren las 24 h');
      await c.query(`UPDATE fixed_routes.routes SET status = 'pending_approval', publish_requested_by = $2 WHERE id = $1`, [routeId, adminId]);
      await this.audit.record({ action: 'route.publish_request', resourceType: 'route', resourceId: routeId }, req, c);
    });
    return { id: routeId, status: 'pending_approval' };
  }

  async approvePublish(adminId: string, routeId: string, approve: boolean, req: AppRequest) {
    await withTransaction(this.pool, async (c) => {
      const r = (await c.query(`SELECT status, publish_requested_by FROM fixed_routes.routes WHERE id = $1 FOR UPDATE`, [routeId])).rows[0];
      if (!r) throw new AppError(404, 'not_found', 'Ruta no encontrada');
      if (r.status !== 'pending_approval') throw new AppError(409, 'invalid_state', 'No hay publicación pendiente');
      if (r.publish_requested_by === adminId) throw new AppError(403, 'four_eyes', 'Otra persona debe aprobar la publicación que solicitaste');
      if (approve) await c.query(`UPDATE fixed_routes.routes SET status = 'active', published_by = $2, published_at = now() WHERE id = $1`, [routeId, adminId]);
      else await c.query(`UPDATE fixed_routes.routes SET status = 'draft', publish_requested_by = NULL WHERE id = $1`, [routeId]);
      await this.audit.record({ action: approve ? 'route.publish' : 'route.publish_reject', resourceType: 'route', resourceId: routeId }, req, c);
    });
    return { id: routeId, status: approve ? 'active' : 'draft' };
  }

  /** Pausa: no se aceptan reservas nuevas ni recorridos nuevos; los que están en curso terminan normalmente. */
  async pause(routeId: string, reason: string, req: AppRequest) {
    const u = await this.pool.query(`UPDATE fixed_routes.routes SET status = 'paused', publish_requested_by = NULL, published_by = NULL WHERE id = $1 AND status = 'active'`, [routeId]);
    if (!u.rowCount) throw new AppError(409, 'invalid_state', 'Solo se pausa una ruta activa');
    await this.audit.record({ action: 'route.pause', resourceType: 'route', resourceId: routeId, metadata: { reason } }, req);
    return { id: routeId, status: 'paused' };
  }

  async enablements(routeId: string) {
    const { rows } = await this.pool.query(
      `SELECT e.driver_id AS "driverId", e.enabled_at AS "enabledAt", p.status AS "driverStatus"
       FROM fixed_routes.driver_enablements e LEFT JOIN drivers.profiles p ON p.user_id = e.driver_id
       WHERE e.route_id = $1 AND e.revoked_at IS NULL ORDER BY e.enabled_at`,
      [routeId],
    );
    return rows;
  }

  async enable(adminId: string, routeId: string, driverId: string, req: AppRequest) {
    const d = await this.pool.query(`SELECT 1 FROM drivers.profiles WHERE user_id = $1 AND status = 'approved'`, [driverId]);
    if (!d.rowCount) throw new AppError(409, 'driver_not_approved', 'Solo se habilitan conductores aprobados');
    await this.pool
      .query(`INSERT INTO fixed_routes.driver_enablements (driver_id, route_id, enabled_by) VALUES ($1, $2, $3)`, [driverId, routeId, adminId])
      .catch((e: { code?: string }) => {
        if (e.code === '23505') return;
        if (e.code === '23503') throw new AppError(404, 'not_found', 'Ruta no encontrada');
        throw e;
      });
    await this.audit.record({ action: 'route.driver_enable', resourceType: 'route', resourceId: routeId, metadata: { driverId } }, req);
    return { routeId, driverId, enabled: true };
  }

  async disable(adminId: string, routeId: string, driverId: string, req: AppRequest) {
    const u = await this.pool.query(`UPDATE fixed_routes.driver_enablements SET revoked_at = now(), revoked_by = $3 WHERE driver_id = $1 AND route_id = $2 AND revoked_at IS NULL`, [driverId, routeId, adminId]);
    if (!u.rowCount) throw new AppError(404, 'not_found', 'El conductor no está habilitado en esta ruta');
    await this.audit.record({ action: 'route.driver_disable', resourceType: 'route', resourceId: routeId, metadata: { driverId } }, req);
    return { routeId, driverId, enabled: false };
  }
}

const dup = (msg: string) => (e: { code?: string }) => {
  throw e.code === '23505' ? new AppError(409, 'conflict', msg) : e;
};
