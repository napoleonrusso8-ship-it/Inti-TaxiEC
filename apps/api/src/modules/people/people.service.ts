import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { maskDocument, randomToken, sha256, type BlindIndex, type FieldCipher } from '@intitaxi/crypto';
import { withTransaction, type Pool, type PoolClient } from '@intitaxi/db';
import { AppError, AuditService, parseInput, RateLimiter, tooManyRequests, type AppRequest } from '@intitaxi/nest-common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import { BLIND_INDEX, CONFIG, FIELD_CIPHER, PG_POOL, STORAGE } from '../../tokens.js';
import type { StoragePort } from '../../infra/storage.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { TripEvents, type TripStatusEvent } from '../trips/trip-events.js';
import { tripAad, TripsService, type TripRow } from '../trips/trips.service.js';
import { RealtimeBridge } from '../trips/realtime-bridge.service.js';
import { TripTrackingService } from '../trips/trip-tracking.service.js';
import { normalizePerson, PartyInput, PersonInput, type NormalizedPerson } from './person-input.js';

const Alias = z.string().max(40).regex(/^[^<>]*$/).optional();
const pAad = (id: string, f: string) => `people.persons.${f}:${id}`;
const sAad = (id: string, f: string) => `people.saved_companions.${f}:${id}`;

interface PersonRow {
  id: string;
  user_id: string | null;
  given_names_enc: Buffer | null;
  family_names_enc: Buffer | null;
  id_doc_type: string;
  id_doc_masked: string | null;
  id_doc_country: string | null;
  email_enc: Buffer | null;
  phone_enc: Buffer | null;
  is_minor: boolean;
  guardian_person_id: string | null;
  anonymized_at: Date | null;
}

interface PendingNotice {
  personId: string;
  email: string | null;
  phone: string | null;
  role: string;
}

/**
 * Acompañantes, viajes para terceros y derechos de los titulares (LOPDP).
 * Todo dato de una persona registrada va cifrado por campo; la cédula se guarda además como índice ciego
 * y enmascarada. Cada lectura queda en la auditoría con su finalidad.
 */
@Injectable()
export class PeopleService implements OnModuleInit, OnModuleDestroy {
  readonly #log = new Logger('People');
  readonly #pending = new Map<string, PendingNotice[]>();
  #timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(BLIND_INDEX) private readonly bidx: BlindIndex,
    @Inject(TripsService) private readonly trips: TripsService,
    @Inject(TripEvents) private readonly events: TripEvents,
    @Inject(NotificationsService) private readonly notify: NotificationsService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RealtimeBridge) private readonly bridge: RealtimeBridge,
    @Inject(TripTrackingService) private readonly tracking: TripTrackingService,
    @Inject(STORAGE) private readonly storage: StoragePort,
  ) {}

  onModuleInit() {
    this.trips.hooks.push({ beforeCreate: (c, trip, input, req) => this.#registerParty(c, trip, input, req) });
    this.trips.participantResolvers.push(async (userId, trip) => {
      const r = await this.pool.query(
        `SELECT 1 FROM trips.trip_parties tp JOIN people.persons p ON p.id = tp.person_id WHERE tp.trip_id = $1 AND p.user_id = $2`,
        [trip.id, userId],
      );
      return r.rowCount ? 'passenger' : null;
    });
    this.events.onStatus((e) => this.#onStatus(e));
    this.#timer = setInterval(() => void this.purgeExpired().catch((e) => this.#log.error(e.message)), 3600_000);
    this.#timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.#timer);
  }

  // ---------- Registro del grupo al pedir el viaje ----------

  async #createPerson(c: PoolClient, p: NormalizedPerson, createdBy: string, opts: { userId?: string; guardianId?: string | null } = {}) {
    const id = randomUUID();
    const enc = (v: string | null | undefined, f: string) => (v ? this.cipher.encrypt(v, pAad(id, f)) : Promise.resolve(null));
    await c.query(
      `INSERT INTO people.persons (id, user_id, given_names_enc, family_names_enc, id_doc_type, id_doc_number_enc, id_doc_hmac, id_doc_masked, id_doc_country,
         email_enc, email_hmac, phone_enc, is_minor, guardian_person_id, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        id, opts.userId ?? null, await enc(p.givenNames, 'given_names'), await enc(p.familyNames, 'family_names'), p.idType,
        await enc(p.idNumber, 'id_doc_number'), p.idNumber ? this.bidx.compute('id_document', p.idNumber.toUpperCase()) : null,
        p.idNumber ? maskDocument(p.idNumber) : null, p.idCountry, await enc(p.email, 'email'),
        p.email ? this.bidx.compute('email', p.email) : null, await enc(p.phone ?? null, 'phone'), p.isMinor, opts.guardianId ?? null, createdBy,
      ],
    );
    return id;
  }

  /** Nombre verificado del solicitante (si pasó KYC), para el manifiesto. */
  async #requesterAsPerson(c: PoolClient, userId: string): Promise<NormalizedPerson> {
    const k = await c.query<{ id: string; given_names_enc: Buffer | null; family_names_enc: Buffer | null }>(
      `SELECT id, given_names_enc, family_names_enc FROM kyc.verifications WHERE user_id = $1 AND kind = 'full' AND status = 'approved' ORDER BY decided_at DESC LIMIT 1`,
      [userId],
    );
    const v = k.rows[0];
    const dec = async (b: Buffer | null, f: string) => (v && b ? this.cipher.decrypt(b, `kyc.verifications.${f}:${v.id}`) : '');
    return { givenNames: await dec(v?.given_names_enc ?? null, 'given_names'), familyNames: await dec(v?.family_names_enc ?? null, 'family_names'), idType: 'none', idNumber: null, idCountry: null, email: null, isMinor: false };
  }

  async #registerParty(c: PoolClient, trip: { id: string; requesterUserId: string; deviceId: string }, rawInput: Record<string, unknown>, req: AppRequest) {
    const input = parseInput(PartyInput, { companions: rawInput.companions, savedCompanionIds: rawInput.savedCompanionIds, forThirdParty: rawInput.forThirdParty });
    const companions = input.companions.map((p, i) => normalizePerson(p, `acompañante ${i + 1}`));
    for (const sid of input.savedCompanionIds) companions.push(await this.#fromSaved(c, trip.requesterUserId, sid));
    const third = input.forThirdParty ? normalizePerson(input.forThirdParty, 'pasajero') : null;

    const total = 1 + companions.length;
    if (total > 8) throw new AppError(400, 'party_too_large', 'Máximo 8 personas por viaje');
    const docs = [third, ...companions].filter((p) => p?.idNumber).map((p) => p!.idNumber);
    if (new Set(docs).size !== docs.length) throw new AppError(400, 'duplicate_person', 'Hay personas repetidas en el grupo');

    // Solicitante (siempre queda registrado) y pasajero principal.
    const requesterPerson = await this.#createPerson(c, await this.#requesterAsPerson(c, trip.requesterUserId), trip.requesterUserId, { userId: trip.requesterUserId });
    await c.query(`INSERT INTO trips.trip_parties (trip_id, person_id, role) VALUES ($1, $2, 'requester')`, [trip.id, requesterPerson]);
    const notices: PendingNotice[] = [];
    let primary = requesterPerson;
    if (third) {
      primary = await this.#createPerson(c, third, trip.requesterUserId);
      notices.push({ personId: primary, email: third.email, phone: third.phone ?? null, role: 'primary_passenger' });
    }
    await c.query(`INSERT INTO trips.trip_parties (trip_id, person_id, role) VALUES ($1, $2, 'primary_passenger')`, [trip.id, primary]);

    // Adultos primero (para poder enlazar a los menores con su responsable).
    const ids: (string | null)[] = companions.map(() => null);
    for (const [i, p] of companions.entries()) {
      if (p.isMinor) continue;
      ids[i] = await this.#createPerson(c, p, trip.requesterUserId);
      await c.query(`INSERT INTO trips.trip_parties (trip_id, person_id, role) VALUES ($1, $2, 'companion')`, [trip.id, ids[i]]);
      notices.push({ personId: ids[i]!, email: p.email, phone: null, role: 'companion' });
    }
    for (const [i, p] of companions.entries()) {
      if (!p.isMinor) continue;
      let guardian: string | null = null;
      if (p.guardian === 'requester') guardian = third ? null : requesterPerson;
      else if (p.guardian === 'primary') guardian = primary;
      else if (typeof p.guardian === 'number') guardian = ids[p.guardian] ?? null;
      if (!guardian) throw new AppError(400, 'invalid_guardian', `El acompañante ${i + 1} es menor y su responsable debe ser un adulto que viaja`);
      ids[i] = await this.#createPerson(c, p, trip.requesterUserId, { guardianId: guardian });
      await c.query(`INSERT INTO trips.trip_parties (trip_id, person_id, role, responsible_person_id) VALUES ($1, $2, 'companion', $3)`, [trip.id, ids[i], guardian]);
      if (p.email) notices.push({ personId: ids[i]!, email: p.email, phone: null, role: 'companion' });
    }
    this.#pending.set(trip.id, notices);
    await this.audit.record({ action: 'trip.party_register', resourceType: 'trip', resourceId: trip.id, metadata: { people: total, thirdParty: !!third } }, req, c);
    return { partySize: total, isForThirdParty: !!third };
  }

  async #fromSaved(c: PoolClient, ownerId: string, savedId: string): Promise<NormalizedPerson> {
    const { rows } = await c.query(`SELECT * FROM people.saved_companions WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`, [savedId, ownerId]);
    const s = rows[0];
    if (!s) throw new AppError(404, 'not_found', 'Contacto frecuente no encontrado');
    if (!['granted', 'guardian_declared'].includes(s.consent_status)) throw new AppError(409, 'consent_pending', 'Ese contacto aún no confirmó su consentimiento');
    const dec = (b: Buffer | null, f: string) => (b ? this.cipher.decrypt(b, sAad(s.id, f)) : Promise.resolve(null));
    return {
      givenNames: (await dec(s.given_names_enc, 'given_names'))!, familyNames: (await dec(s.family_names_enc, 'family_names'))!,
      idType: s.id_doc_type, idNumber: await dec(s.id_doc_number_enc, 'id_doc_number'), idCountry: s.id_doc_country,
      email: await dec(s.email_enc, 'email'), isMinor: s.is_minor, guardian: s.is_minor ? 'requester' : undefined,
    };
  }

  // ---------- Avisos y notificaciones ----------

  async #subjectLink(c: Pool | PoolClient, purpose: 'notice' | 'companion_consent', ref: { personId?: string; savedId?: string; tripId?: string }, days: number) {
    const token = randomToken(32);
    await c.query(
      `INSERT INTO people.subject_links (token_hash, purpose, person_id, saved_companion_id, trip_id, expires_at) VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))`,
      [sha256(token), purpose, ref.personId ?? null, ref.savedId ?? null, ref.tripId ?? null, days],
    );
    return `${this.config.SUBJECT_PORTAL_URL}/p/${token}`;
  }

  async #onStatus(e: TripStatusEvent) {
    // Viaje bajo demanda (null → matching) o reserva de Taxi Ruta (null → accepted).
    if (e.from === null) await this.#sendNotices(e.tripId);
    if (e.to === 'accepted') await this.#notifyThirdPartyAccepted(e.tripId);
    if (['completed', 'cancelled', 'no_drivers'].includes(e.to)) {
      // Los enlaces de seguimiento caducan 15 min después de terminar el viaje.
      await this.pool.query(`UPDATE trips.share_links SET expires_at = LEAST(expires_at, now() + interval '15 minutes') WHERE trip_id = $1`, [e.tripId]);
      await this.pool.query(`UPDATE trips.trips SET retention_until = now() + make_interval(days => $2) WHERE id = $1`, [e.tripId, this.config.MANIFEST_RETENTION_DAYS]);
      const t = await this.trips.load(e.tripId);
      if (e.to === 'completed' && t?.is_for_third_party) {
        await this.notify.notifyUser(t.requester_user_id, 'third_party_arrived', {
          sms: 'Inti Taxi: la persona para quien pediste el taxi llegó a su destino.',
          email: { subject: 'Llegó a su destino', text: 'La persona para quien pediste el taxi llegó a su destino. Gracias por usar Inti Taxi.' },
        });
      }
    }
  }

  /** Aviso LOPDP a cada persona registrada: finalidad, plazo y enlace para consultar, confirmar o pedir la eliminación. */
  async #sendNotices(tripId: string) {
    const notices = this.#pending.get(tripId) ?? [];
    this.#pending.delete(tripId);
    for (const n of notices) {
      const link = await this.#subjectLink(this.pool, 'notice', { personId: n.personId, tripId }, 30);
      const text =
        `Alguien te registró como ${n.role === 'primary_passenger' ? 'pasajero' : 'acompañante'} en un viaje de Inti Taxi. ` +
        `Usamos tus nombres, identificación y contacto SOLO para la seguridad del viaje y la atención de emergencias, ` +
        `y los borramos a los ${this.config.MANIFEST_RETENTION_DAYS} días salvo que ocurra un incidente. ` +
        `Consulta, confirma o pide la eliminación de tus datos aquí: ${link}`;
      await this.notify.notifyContact({ email: n.email }, { email: { subject: 'Aviso de privacidad — Inti Taxi', text } });
      await this.pool.query('UPDATE trips.trip_parties SET notified_at = now() WHERE trip_id = $1 AND person_id = $2', [tripId, n.personId]);
    }
  }

  /** El tercero (sin app) recibe conductor, placa, PIN y enlace de seguimiento en vivo. */
  async #notifyThirdPartyAccepted(tripId: string) {
    const t = await this.trips.load(tripId);
    if (!t?.is_for_third_party || !t.driver_id) return;
    const { rows } = await this.pool.query<PersonRow>(
      `SELECT p.* FROM trips.trip_parties tp JOIN people.persons p ON p.id = tp.person_id WHERE tp.trip_id = $1 AND tp.role = 'primary_passenger'`,
      [tripId],
    );
    const p = rows[0];
    if (!p) return;
    const card = await this.trips.driverCard(t.driver_id, t.vehicle_id);
    const pin = await this.cipher.decrypt(t.pin_enc, tripAad.pin(t.id));
    const link = await this.createShareLink(tripId, 'third_party', p.id, null);
    const phone = p.phone_enc ? await this.cipher.decrypt(p.phone_enc, pAad(p.id, 'phone')) : null;
    const email = p.email_enc ? await this.cipher.decrypt(p.email_enc, pAad(p.id, 'email')) : null;
    const v = card.vehicle;
    const text = `Inti Taxi: tu taxi va en camino. Conductor: ${card.firstName}. Vehículo: ${v?.make} ${v?.model} ${v?.color}, placa ${v?.plate}. Tu PIN para subir: ${pin} (dáselo solo al conductor). Síguelo en vivo: ${link}`;
    await this.notify.notifyContact({ phone, email }, { sms: text, email: { subject: 'Tu taxi va en camino', text } });
    await this.audit.record({ action: 'trip.third_party_notified', resourceType: 'trip', resourceId: tripId, actorRole: 'system' });
  }

  async createShareLink(tripId: string, audience: 'third_party' | 'companion' | 'trusted_contact' | 'requester', personId: string | null, createdBy: string | null) {
    const token = randomToken(32);
    const hash = sha256(token);
    await this.pool.query(
      `INSERT INTO trips.share_links (id, trip_id, audience, person_id, token_hash, expires_at, created_by) VALUES ($1, $2, $3, $4, $5, now() + interval '6 hours', $6)`,
      [randomUUID(), tripId, audience, personId, hash, createdBy],
    );
    await this.bridge.registerShareLink(hash, tripId, 6 * 3600);
    return `${this.config.TRACKING_BASE_URL}/t/${token}`;
  }

  /** Compartir el viaje en vivo con un contacto de confianza (requiere el consentimiento "trip_sharing"). */
  async shareWithContact(userId: string, tripId: string, req: AppRequest) {
    const t = await this.trips.load(tripId);
    const role = t ? await this.trips.participantRole(userId, t) : null;
    if (!t || !role || role === 'driver') throw new AppError(404, 'not_found', 'Recurso no encontrado');
    if (!['matching', 'accepted', 'arrived', 'in_progress'].includes(t.status)) throw new AppError(409, 'trip_not_active', 'Solo se comparte un viaje activo');
    const consent = await this.pool.query(`SELECT action FROM kyc.current_consents WHERE user_id = $1 AND purpose = 'trip_sharing'`, [userId]);
    if (consent.rows[0]?.action !== 'grant') throw new AppError(403, 'consent_required', 'Acepta primero el consentimiento para compartir viajes');
    const active = await this.pool.query(`SELECT count(*)::int AS n FROM trips.share_links WHERE trip_id = $1 AND created_by = $2 AND expires_at > now() AND revoked_at IS NULL`, [tripId, userId]);
    if (active.rows[0].n >= 5) throw new AppError(429, 'too_many_links', 'Máximo 5 enlaces activos por viaje');
    const url = await this.createShareLink(tripId, 'trusted_contact', null, userId);
    await this.audit.record({ action: 'trip.share_link', resourceType: 'trip', resourceId: tripId }, req);
    return { url, expiresIn: 6 * 3600, note: 'Caduca 15 minutos después de terminar el viaje' };
  }

  async revokeShareLinks(userId: string, tripId: string, req: AppRequest) {
    const r = await this.pool.query<{ token_hash: Buffer }>(`UPDATE trips.share_links SET revoked_at = now() WHERE trip_id = $1 AND created_by = $2 AND revoked_at IS NULL RETURNING token_hash`, [tripId, userId]);
    for (const l of r.rows) await this.bridge.registerShareLink(l.token_hash, tripId, 1);
    await this.audit.record({ action: 'trip.share_links_revoked', resourceType: 'trip', resourceId: tripId, metadata: { count: r.rowCount } }, req);
    return { revoked: r.rowCount };
  }

  // ---------- Lectura (con auditoría) ----------

  async #decryptPerson(p: PersonRow) {
    const dec = (b: Buffer | null, f: string) => (b && !p.anonymized_at ? this.cipher.decrypt(b, pAad(p.id, f)) : Promise.resolve(null));
    return { givenNames: await dec(p.given_names_enc, 'given_names'), familyNames: await dec(p.family_names_enc, 'family_names') };
  }

  /** Grupo del viaje para sus participantes: nombres y documento ENMASCARADO; cada acceso se audita con su finalidad. */
  async parties(userId: string, tripId: string, req: AppRequest) {
    const t = await this.trips.load(tripId);
    const role = t ? await this.trips.participantRole(userId, t) : null;
    if (!t || !role) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    const { rows } = await this.pool.query<PersonRow & { role: string; responsible_person_id: string | null }>(
      `SELECT p.*, tp.role, tp.responsible_person_id FROM trips.trip_parties tp JOIN people.persons p ON p.id = tp.person_id WHERE tp.trip_id = $1 ORDER BY tp.created_at`,
      [tripId],
    );
    await this.audit.record({ action: 'trip.parties_read', resourceType: 'trip', resourceId: tripId, purpose: 'trip_safety', metadata: { viewerRole: role } }, req);
    const out = [];
    for (const r of rows) {
      // El conductor solo necesita saber cuántos suben y el nombre del pasajero principal.
      if (role === 'driver' && r.role !== 'primary_passenger') continue;
      const names = await this.#decryptPerson(r);
      out.push({
        personId: r.id, role: r.role, givenNames: names.givenNames, familyNames: role === 'driver' ? null : names.familyNames,
        document: role === 'driver' ? null : r.id_doc_masked, isMinor: r.is_minor, responsiblePersonId: r.responsible_person_id,
      });
    }
    return { partySize: t.party_size, people: out };
  }

  // ---------- Contactos frecuentes ----------

  async saveCompanion(ownerId: string, raw: unknown, req: AppRequest) {
    const rl = await this.limiter.hit(`saved-companion:${ownerId}`, 10, 86400);
    if (!rl.allowed) throw tooManyRequests(rl.retryAfterSeconds);
    const input = parseInput(PersonInput.extend({ alias: Alias }), raw);
    const p = normalizePerson({ ...input, guardian: input.isMinor ? 'requester' : undefined }, 'contacto');
    const id = randomUUID();
    const enc = (v: string | null, f: string) => (v ? this.cipher.encrypt(v, sAad(id, f)) : Promise.resolve(null));
    // Adultos: consienten ellos mismos por enlace. Menores: el adulto que los registra declara la representación (revisión legal).
    const status = p.isMinor ? 'guardian_declared' : 'pending';
    await this.pool.query(
      `INSERT INTO people.saved_companions (id, owner_user_id, alias, given_names_enc, family_names_enc, id_doc_type, id_doc_number_enc, id_doc_masked, id_doc_country, email_enc, is_minor, consent_status, consent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $12 = 'guardian_declared' THEN now() END)`,
      [id, ownerId, input.alias ?? null, await enc(p.givenNames, 'given_names'), await enc(p.familyNames, 'family_names'), p.idType, await enc(p.idNumber, 'id_doc_number'), p.idNumber ? maskDocument(p.idNumber) : null, p.idCountry, await enc(p.email, 'email'), p.isMinor, status],
    );
    if (!p.isMinor) {
      const link = await this.#subjectLink(this.pool, 'companion_consent', { savedId: id }, 14);
      await this.notify.notifyContact({ email: p.email }, {
        email: {
          subject: '¿Autorizas que guarden tus datos? — Inti Taxi',
          text: `Una persona quiere guardarte como acompañante frecuente en Inti Taxi (nombres, identificación y correo) para registrarte más rápido en sus viajes, con la única finalidad de la seguridad del viaje. Si estás de acuerdo, confírmalo aquí: ${link}. Si no haces nada, no se usarán.`,
        },
      });
    }
    await this.audit.record({ action: 'companion.save', resourceType: 'saved_companion', resourceId: id, metadata: { status } }, req);
    return { id, consentStatus: status };
  }

  async listCompanions(ownerId: string) {
    const { rows } = await this.pool.query(
      `SELECT id, alias, given_names_enc, id_doc_masked, is_minor, consent_status FROM people.saved_companions WHERE owner_user_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
      [ownerId],
    );
    return Promise.all(rows.map(async (r) => ({ id: r.id, alias: r.alias, givenNames: await this.cipher.decrypt(r.given_names_enc, sAad(r.id, 'given_names')), document: r.id_doc_masked, isMinor: r.is_minor, consentStatus: r.consent_status })));
  }

  async deleteCompanion(ownerId: string, id: string, req: AppRequest) {
    const r = await this.pool.query(
      `UPDATE people.saved_companions SET deleted_at = now(), given_names_enc = '\\x00', family_names_enc = '\\x00', id_doc_number_enc = NULL, email_enc = NULL WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`,
      [id, ownerId],
    );
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    await this.audit.record({ action: 'companion.delete', resourceType: 'saved_companion', resourceId: id }, req);
  }

  // ---------- Portal del titular (sin cuenta, enlace firmado) ----------

  async #link(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const { rows } = await this.pool.query(`SELECT * FROM people.subject_links WHERE token_hash = $1 AND expires_at > now()`, [sha256(token)]);
    return rows[0] ?? null;
  }

  async subjectView(token: string, req: AppRequest) {
    const l = await this.#link(token);
    if (!l) throw new AppError(404, 'not_found', 'Enlace inválido o vencido');
    await this.audit.record({ action: 'subject.view', resourceType: l.person_id ? 'person' : 'saved_companion', resourceId: l.person_id ?? l.saved_companion_id, actorRole: 'data_subject', purpose: 'data_subject_rights' }, req);
    if (l.purpose === 'companion_consent') {
      const { rows } = await this.pool.query(`SELECT given_names_enc, id_doc_masked, consent_status FROM people.saved_companions WHERE id = $1 AND deleted_at IS NULL`, [l.saved_companion_id]);
      if (!rows[0]) throw new AppError(404, 'not_found', 'Enlace inválido o vencido');
      return { purpose: 'companion_consent', givenNames: await this.cipher.decrypt(rows[0].given_names_enc, sAad(l.saved_companion_id, 'given_names')), document: rows[0].id_doc_masked, consentStatus: rows[0].consent_status };
    }
    const { rows } = await this.pool.query<PersonRow>('SELECT * FROM people.persons WHERE id = $1', [l.person_id]);
    const p = rows[0]!;
    const names = await this.#decryptPerson(p);
    const trip = await this.trips.load(l.trip_id);
    return {
      purpose: 'notice',
      finalidad: 'Seguridad del viaje y atención de emergencias',
      conservacion: `${this.config.MANIFEST_RETENTION_DAYS} días desde el fin del viaje, salvo incidente o requerimiento legal`,
      datos: { ...names, document: p.id_doc_masked, anonymized: !!p.anonymized_at },
      viaje: trip ? { fecha: trip.requested_at, estado: trip.status } : null,
      confirmado: !!l.confirmed_at,
    };
  }

  async subjectConfirm(token: string, req: AppRequest) {
    const l = await this.#link(token);
    if (!l) throw new AppError(404, 'not_found', 'Enlace inválido o vencido');
    await this.pool.query('UPDATE people.subject_links SET confirmed_at = now() WHERE token_hash = $1', [sha256(token)]);
    if (l.purpose === 'companion_consent') {
      await this.pool.query(`UPDATE people.saved_companions SET consent_status = 'granted', consent_at = now(), consent_text_version = 1 WHERE id = $1 AND consent_status = 'pending'`, [l.saved_companion_id]);
    }
    await this.audit.record({ action: `subject.confirm_${l.purpose}`, resourceType: 'person', resourceId: l.person_id ?? l.saved_companion_id, actorRole: 'data_subject' }, req);
    return { confirmed: true };
  }

  /**
   * Solicitud de eliminación. Si el viaje terminó y no hay incidente, se anonimiza de inmediato.
   * Si está en curso o con incidente/requerimiento legal, queda diferida (base legal: interés vital / obligación legal).
   */
  async subjectDelete(token: string, req: AppRequest) {
    const l = await this.#link(token);
    if (!l) throw new AppError(404, 'not_found', 'Enlace inválido o vencido');
    if (l.purpose === 'companion_consent') {
      await this.pool.query(`UPDATE people.saved_companions SET consent_status = 'revoked', deleted_at = now(), given_names_enc = '\\x00', family_names_enc = '\\x00', id_doc_number_enc = NULL, email_enc = NULL WHERE id = $1`, [l.saved_companion_id]);
      await this.audit.record({ action: 'subject.delete', resourceType: 'saved_companion', resourceId: l.saved_companion_id, actorRole: 'data_subject' }, req);
      return { status: 'completed' };
    }
    const trip = (await this.trips.load(l.trip_id)) as TripRow | null;
    const deferred = !trip || ['matching', 'accepted', 'arrived', 'in_progress'].includes(trip.status) || trip.incident_hold;
    await withTransaction(this.pool, async (c) => {
      await c.query(
        `INSERT INTO people.data_subject_requests (id, person_id, type, status, due_at, resolved_at, notes) VALUES ($1, $2, 'delete', $3, now() + interval '15 days', $4, $5)`,
        [randomUUID(), l.person_id, deferred ? 'deferred_legal_hold' : 'completed', deferred ? null : new Date(), deferred ? 'Viaje activo o con incidente: se conservará hasta su cierre' : null],
      );
      if (!deferred) await this.#anonymize(c, [l.person_id]);
      await this.audit.record({ action: 'subject.delete', resourceType: 'person', resourceId: l.person_id, actorRole: 'data_subject', metadata: { deferred } }, req, c);
    });
    return { status: deferred ? 'deferred_legal_hold' : 'completed' };
  }

  async #anonymize(c: Pool | PoolClient, personIds: string[]) {
    if (!personIds.length) return 0;
    const r = await c.query(
      `UPDATE people.persons SET given_names_enc = NULL, family_names_enc = NULL, id_doc_number_enc = NULL, id_doc_hmac = NULL, id_doc_masked = NULL,
         email_enc = NULL, email_hmac = NULL, phone_enc = NULL, anonymized_at = now()
       WHERE id = ANY($1) AND anonymized_at IS NULL`,
      [personIds],
    );
    return r.rowCount ?? 0;
  }

  /** Retención: anonimiza a las personas de viajes vencidos (180 días) salvo incidente / retención legal. */
  async purgeExpired(): Promise<number> {
    const { rows } = await this.pool.query<{ person_id: string }>(
      `SELECT tp.person_id FROM trips.trip_parties tp JOIN trips.trips t ON t.id = tp.trip_id
       WHERE t.retention_until < now() AND NOT t.incident_hold
       UNION
       SELECT r.person_id FROM people.data_subject_requests r JOIN trips.trip_parties tp ON tp.person_id = r.person_id JOIN trips.trips t ON t.id = tp.trip_id
       WHERE r.status = 'deferred_legal_hold' AND t.status IN ('completed', 'cancelled', 'no_drivers') AND NOT t.incident_hold`,
    );
    await this.tracking.generalizeOld();
    const n = await this.#anonymize(this.pool, rows.map((r) => r.person_id));
    await this.pool.query(`UPDATE people.data_subject_requests SET status = 'completed', resolved_at = now() WHERE status = 'deferred_legal_hold' AND person_id = ANY($1)`, [rows.map((r) => r.person_id)]);
    await this.pool.query(`UPDATE trips.trips SET origin_label_enc = NULL, dest_label_enc = NULL WHERE retention_until < now() AND NOT incident_hold AND (origin_label_enc IS NOT NULL OR dest_label_enc IS NOT NULL)`);
    // Manifiestos vencidos (sin incidente): borrado solo posible dentro de esta transacción de retención.
    await withTransaction(this.pool, async (c) => {
      await c.query(`SET LOCAL intitaxi.retention_purge = 'on'`);
      await c.query(`DELETE FROM safety.trip_manifests m USING trips.trips t WHERE t.id = m.trip_id AND t.retention_until < now() AND NOT t.incident_hold`);
    });
    // Audio de SOS cancelados o cerrados sin retención legal: 90 días.
    const audio = await this.pool.query<{ id: string; storage_key: string }>(
      `SELECT a.id, a.storage_key FROM safety.audio_chunks a JOIN safety.incidents i ON i.id = a.incident_id
       WHERE a.created_at < now() - make_interval(days => $1) AND i.status IN ('cancelled_by_user', 'closed') AND (i.legal_hold_until IS NULL OR i.legal_hold_until < now())`,
      [this.config.AUDIO_RETENTION_DAYS],
    );
    for (const a of audio.rows) {
      await this.storage.delete(a.storage_key);
      await this.pool.query('DELETE FROM safety.audio_chunks WHERE id = $1', [a.id]);
    }
    if (n || audio.rowCount) await this.audit.record({ action: 'retention.anonymize', resourceType: 'person', actorRole: 'system', metadata: { count: n, audioDeleted: audio.rowCount } });
    return n;
  }
}
