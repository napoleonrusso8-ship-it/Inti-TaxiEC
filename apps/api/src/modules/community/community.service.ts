import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { FieldCipher } from '@intitaxi/crypto';
import { withTransaction, type Pool } from '@intitaxi/db';
import { AppError, AuditService, type AppRequest } from '@intitaxi/nest-common';
import { FIELD_CIPHER, PG_POOL } from '../../tokens.js';
import { KycService } from '../kyc/kyc.service.js';
import { postLedger } from '../payments/ledger.js';
import { TripEvents } from '../trips/trip-events.js';

const chosenAad = (userId: string) => `people.passenger_profiles.chosen_name:${userId}`;

/** Curso corto de "Conductor Aliado" (inclusión LGBTI+ y trato respetuoso). Respuestas en el servidor. */
export const ALLY_COURSE = {
  version: 1,
  lessons: [
    'Usa siempre el nombre que muestra la app: si la persona definió un nombre de preferencia, es su nombre.',
    'No hagas preguntas ni comentarios sobre la identidad, la orientación, el cuerpo o la ropa de nadie.',
    'Si alguien del vehículo discrimina o acosa a tu pasajero, detén la situación y reporta desde la app.',
    'La discriminación por identidad u orientación está prohibida por la Constitución del Ecuador (art. 11) y por las normas de Inti Taxi.',
  ],
  questions: [
    { id: 'q1', text: 'La app muestra un nombre distinto al de la cédula. ¿Cómo llamas a la persona?', options: ['Por el nombre de la cédula', 'Por el nombre que muestra la app', 'Le pregunto por qué lo cambió'], answer: 1 },
    { id: 'q2', text: 'Un pasajero comenta sobre la orientación de otra persona del vehículo. ¿Qué haces?', options: ['Nada', 'Le sigo la conversación', 'Pido respeto y, si continúa, reporto desde la app'], answer: 2 },
    { id: 'q3', text: '¿Está permitido negar un viaje por la apariencia o identidad de una persona?', options: ['No, nunca', 'Sí, si me incomoda'], answer: 0 },
  ],
};

/** Inti Puntos: 1 punto por dólar pagado; 100 puntos = $1 en la billetera (desde 500, máx. 2000 al mes). */
const POINTS_PER_DOLLAR = 1;
const REDEEM_UNIT = 100;
const REDEEM_MIN = 500;
const REDEEM_MONTHLY_MAX = 2000;
const DRIVER_FIVE_STAR_BONUS = 10;

@Injectable()
export class CommunityService implements OnModuleInit {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(TripEvents) private readonly events: TripEvents,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(KycService) private readonly kyc: KycService,
  ) {}

  onModuleInit() {
    // Puntos al completar un viaje (pasajero que pagó) — idempotente por viaje.
    this.events.onStatus(async (e) => {
      if (e.to === 'completed') await this.earnForTrip(e.tripId);
    });
    this.events.on('trip.rated', (e: { tripId: string; rateeId: string; raterRole: 'requester' | 'driver'; stars: number }) => {
      void this.onRated(e.tripId, e.rateeId, e.raterRole, e.stars).catch(() => {});
    });
  }

  // ---------- Preferencias del pasajero ----------

  async preferences(userId: string) {
    const r = (await this.pool.query(`SELECT * FROM people.passenger_profiles WHERE user_id = $1`, [userId])).rows[0];
    return {
      chosenName: r?.chosen_name_enc ? await this.cipher.decrypt(r.chosen_name_enc, chosenAad(userId)) : null,
      ellxsMember: r?.ellxs_member ?? false,
      deviationAlerts: r?.deviation_alerts ?? 'night',
      defaultPrefs: r?.default_prefs ?? {},
    };
  }

  /**
   * Modo Ellxs (`ellxsMember`) es un dato sensible (LOPDP art. 26): activarlo exige el consentimiento explícito y
   * vigente 'ellxs'. Desactivarlo borra la autodeclaración y revoca ese consentimiento (retiro tan fácil como el alta).
   */
  async setPreferences(userId: string, input: { chosenName?: string | null; ellxsMember?: boolean; deviationAlerts?: 'night' | 'always' | 'off'; defaultPrefs?: Record<string, boolean> }, req: AppRequest) {
    if (input.ellxsMember === true && !(await this.kyc.hasActiveConsent(userId, 'ellxs'))) {
      throw new AppError(409, 'consent_required', 'Para activar Modo Ellxs acepta primero el consentimiento (finalidad "ellxs")');
    }
    const cur = await this.preferences(userId);
    const next = { ...cur, ...input };
    await withTransaction(this.pool, async (c) => {
      await c.query(
        `INSERT INTO people.passenger_profiles (user_id, chosen_name_enc, ellxs_member, deviation_alerts, default_prefs, updated_at) VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (user_id) DO UPDATE SET chosen_name_enc = $2, ellxs_member = $3, deviation_alerts = $4, default_prefs = $5, updated_at = now()`,
        [userId, next.chosenName ? await this.cipher.encrypt(next.chosenName, chosenAad(userId)) : null, next.ellxsMember, next.deviationAlerts, next.defaultPrefs],
      );
      if (input.ellxsMember === false && (await this.kyc.hasActiveConsent(userId, 'ellxs', c))) {
        await c.query(`INSERT INTO kyc.consents (id, user_id, purpose, action) VALUES ($1, $2, 'ellxs', 'revoke')`, [randomUUID(), userId]);
        await this.audit.record({ action: 'consent.revoke', resourceType: 'consent', resourceId: 'ellxs' }, req, c);
      }
      // Auditoría sin el contenido (el nombre y la autodeclaración son datos personales).
      await this.audit.record({ action: 'passenger.preferences', resourceType: 'user', resourceId: userId, metadata: { fields: Object.keys(input).join(',') } }, req, c);
    });
    return this.preferences(userId);
  }

  // ---------- Conductorxs: Modo Ellxs, Aliado y equipamiento ----------

  /** La persona que conduce pide ser Conductorx Ellxs (mujer o LGBTI); una persona del equipo lo verifica. */
  async requestEllxs(driverId: string, req: AppRequest) {
    const u = await this.pool.query(`UPDATE drivers.profiles SET ellxs_requested_at = now() WHERE user_id = $1 AND ellxs_approved_at IS NULL`, [driverId]);
    if (!u.rowCount) throw new AppError(409, 'invalid_state', 'Ya tienes Modo Ellxs habilitado o aún no tienes perfil de socio');
    await this.audit.record({ action: 'driver.ellxs_request', resourceType: 'driver', resourceId: driverId }, req);
    return { status: 'pending_review' };
  }

  /** Una persona del equipo confirma (por videollamada o en la revisión de documentos) y habilita a la conductorx. */
  async approveEllxs(adminId: string, driverId: string, approve: boolean, req: AppRequest) {
    if (adminId === driverId) throw new AppError(403, 'forbidden', 'No puedes revisar tu propia solicitud');
    const u = approve
      ? await this.pool.query(`UPDATE drivers.profiles SET ellxs_approved_by = $2, ellxs_approved_at = now() WHERE user_id = $1 AND ellxs_requested_at IS NOT NULL`, [driverId, adminId])
      : await this.pool.query(`UPDATE drivers.profiles SET ellxs_requested_at = NULL, ellxs_approved_by = NULL, ellxs_approved_at = NULL WHERE user_id = $1`, [driverId]);
    if (!u.rowCount) throw new AppError(404, 'not_found', 'No hay una solicitud de Modo Ellxs de esa persona');
    await this.audit.record({ action: approve ? 'driver.ellxs_approve' : 'driver.ellxs_revoke', resourceType: 'driver', resourceId: driverId, actorUserId: adminId }, req);
    return { driverId, ellxs: approve };
  }

  async pendingEllxs() {
    const { rows } = await this.pool.query(`SELECT user_id AS "driverId", ellxs_requested_at AS "requestedAt" FROM drivers.profiles WHERE ellxs_requested_at IS NOT NULL AND ellxs_approved_at IS NULL ORDER BY ellxs_requested_at LIMIT 100`);
    return rows;
  }

  allyCourse() {
    return { version: ALLY_COURSE.version, lessons: ALLY_COURSE.lessons, questions: ALLY_COURSE.questions.map(({ answer: _a, ...q }) => q) };
  }

  async certifyAlly(driverId: string, answers: Record<string, number>, req: AppRequest) {
    const wrong = ALLY_COURSE.questions.filter((q) => answers[q.id] !== q.answer).length;
    if (wrong) {
      await this.audit.record({ action: 'driver.ally_attempt', resourceType: 'driver', resourceId: driverId, outcome: 'denied', metadata: { wrong } }, req);
      throw new AppError(422, 'course_failed', `Tienes ${wrong} respuesta(s) incorrecta(s). Revisa las lecciones e inténtalo de nuevo.`);
    }
    const u = await this.pool.query(`UPDATE drivers.profiles SET ally_certified_at = now() WHERE user_id = $1`, [driverId]);
    if (!u.rowCount) throw new AppError(404, 'not_found', 'Perfil de conductor no encontrado');
    await this.audit.record({ action: 'driver.ally_certified', resourceType: 'driver', resourceId: driverId }, req);
    return { ally: true };
  }

  async setVehicleFeatures(driverId: string, vehicleId: string, features: string[], req: AppRequest) {
    const u = await this.pool.query(`UPDATE drivers.vehicles SET features = $3 WHERE id = $1 AND driver_id = $2`, [vehicleId, driverId, [...new Set(features)]]);
    if (!u.rowCount) throw new AppError(404, 'not_found', 'Vehículo no encontrado');
    await this.audit.record({ action: 'driver.vehicle_features', resourceType: 'vehicle', resourceId: vehicleId, metadata: { features: features.join(',') } }, req);
    return { vehicleId, features };
  }

  // ---------- Inti Puntos ----------

  async balance(userId: string, role: 'passenger' | 'driver') {
    const { rows } = await this.pool.query<{ p: string }>(`SELECT coalesce(sum(points), 0) AS p FROM loyalty.entries WHERE user_id = $1 AND role = $2`, [userId, role]);
    return Number(rows[0]!.p);
  }

  async loyalty(userId: string, role: 'passenger' | 'driver') {
    const { rows } = await this.pool.query(`SELECT points, kind, created_at AS at FROM loyalty.entries WHERE user_id = $1 AND role = $2 ORDER BY id DESC LIMIT 50`, [userId, role]);
    return { points: await this.balance(userId, role), valueCents: Math.floor((await this.balance(userId, role)) / REDEEM_UNIT) * 100, rules: { perDollar: POINTS_PER_DOLLAR, redeemUnit: REDEEM_UNIT, redeemMin: REDEEM_MIN, monthlyMax: REDEEM_MONTHLY_MAX }, history: rows };
  }

  async #earn(userId: string, role: 'passenger' | 'driver', kind: string, refId: string, points: number) {
    if (points <= 0) return;
    await this.pool.query(`INSERT INTO loyalty.entries (user_id, role, points, kind, ref_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [userId, role, points, kind, refId]);
  }

  async earnForTrip(tripId: string) {
    const t = (await this.pool.query(`SELECT requester_user_id, type, final_fare_cents FROM trips.trips WHERE id = $1 AND status = 'completed'`, [tripId])).rows[0];
    if (!t?.final_fare_cents) return;
    await this.#earn(t.requester_user_id, 'passenger', t.type === 'fixed_route' ? 'route' : 'trip', tripId, Math.floor((t.final_fare_cents / 100) * POINTS_PER_DOLLAR));
  }

  /** Bono al conductor por cada calificación de 5 estrellas. */
  async onRated(tripId: string, rateeId: string, raterRole: 'requester' | 'driver', stars: number) {
    if (raterRole === 'requester' && stars === 5) await this.#earn(rateeId, 'driver', 'rating_bonus', tripId, DRIVER_FIVE_STAR_BONUS);
  }

  /**
   * Canje: pasajero → billetera; conductor → saldo a cobrar. Lo paga la plataforma (gasto promocional),
   * con mínimo y tope mensual para que el costo sea predecible.
   */
  async redeem(userId: string, role: 'passenger' | 'driver', points: number, req: AppRequest) {
    if (points < REDEEM_MIN || points % REDEEM_UNIT) throw new AppError(400, 'invalid_points', `Canjea desde ${REDEEM_MIN} puntos, en múltiplos de ${REDEEM_UNIT}`);
    return withTransaction(this.pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`loyalty:${userId}:${role}`]);
      const bal = Number((await c.query(`SELECT coalesce(sum(points), 0) AS p FROM loyalty.entries WHERE user_id = $1 AND role = $2`, [userId, role])).rows[0].p);
      if (bal < points) throw new AppError(409, 'insufficient_points', 'No tienes puntos suficientes');
      const month = Number((await c.query(`SELECT coalesce(-sum(points), 0) AS p FROM loyalty.entries WHERE user_id = $1 AND role = $2 AND kind = 'redeem' AND created_at > date_trunc('month', now())`, [userId, role])).rows[0].p);
      if (month + points > REDEEM_MONTHLY_MAX) throw new AppError(409, 'monthly_limit', `Puedes canjear hasta ${REDEEM_MONTHLY_MAX} puntos por mes`);
      const ref = `${Date.now()}:${points}`;
      await c.query(`INSERT INTO loyalty.entries (user_id, role, points, kind, ref_id) VALUES ($1, $2, $3, 'redeem', $4)`, [userId, role, -points, ref]);
      const cents = (points / REDEEM_UNIT) * 100;
      const account = role === 'passenger' ? `wallet:${userId}` : `driver_payable:${userId}`;
      await postLedger(c, 'loyalty_redeem', { type: 'user', id: userId }, [{ account: 'promo_expense', debit: cents }, { account, credit: cents }]);
      await this.audit.record({ action: 'loyalty.redeem', resourceType: 'user', resourceId: userId, metadata: { points, cents, role } }, req, c);
      return { redeemedPoints: points, creditedCents: cents, balance: bal - points };
    });
  }
}
