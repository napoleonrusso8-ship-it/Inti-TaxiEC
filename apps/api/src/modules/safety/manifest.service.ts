import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { sha256, type FieldCipher } from '@intitaxi/crypto';
import { withTransaction, type Pool } from '@intitaxi/db';
import { createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import type { AppConfig } from '../../config.js';
import { CONFIG, FIELD_CIPHER, PG_POOL } from '../../tokens.js';

export type ManifestReason = 'start' | 'end' | 'incident' | 'authority_request';
const aad = (id: string) => `safety.trip_manifests.payload:${id}`;

/**
 * Manifiesto del viaje: quién viajaba (solicitante, pasajeros, acompañantes), conductor con su verificación
 * biométrica más reciente, vehículo/placa, horas y ruta GPS. Cada versión es inmutable, va cifrada, encadenada
 * por hash con la anterior y firmada (ES256): cualquier alteración es detectable.
 */
@Injectable()
export class ManifestService implements OnModuleInit {
  readonly #log = new Logger('Manifest');
  #key!: KeyObject;
  #pub!: KeyObject;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
  ) {}

  onModuleInit() {
    this.#key = createPrivateKey(this.config.MANIFEST_SIGNING_KEY_PEM.replace(/\\n/g, '\n'));
    this.#pub = createPublicKey(this.#key);
  }

  publicKeyPem() {
    return this.#pub.export({ format: 'pem', type: 'spki' }).toString();
  }

  async #dec(b: Buffer | null, aadStr: string) {
    return b ? this.cipher.decrypt(b, aadStr) : null;
  }

  /** Arma el contenido completo a partir de la base de datos (datos en claro solo en memoria). */
  async build(tripId: string): Promise<Record<string, unknown>> {
    const t = (await this.pool.query('SELECT * FROM trips.trips WHERE id = $1', [tripId])).rows[0];
    if (!t) throw new Error('viaje inexistente');
    const parties = (await this.pool.query(
      `SELECT tp.role, tp.responsible_person_id, p.* FROM trips.trip_parties tp JOIN people.persons p ON p.id = tp.person_id WHERE tp.trip_id = $1 ORDER BY tp.created_at`,
      [tripId],
    )).rows;
    const pa = (id: string, f: string) => `people.persons.${f}:${id}`;
    const passengers = await Promise.all(
      parties.map(async (p) => ({
        personId: p.id, role: p.role, hasAccount: !!p.user_id, isMinor: p.is_minor, responsiblePersonId: p.responsible_person_id,
        givenNames: await this.#dec(p.given_names_enc, pa(p.id, 'given_names')), familyNames: await this.#dec(p.family_names_enc, pa(p.id, 'family_names')),
        idType: p.id_doc_type, idNumber: await this.#dec(p.id_doc_number_enc, pa(p.id, 'id_doc_number')), idCountry: p.id_doc_country,
        anonymized: !!p.anonymized_at,
      })),
    );
    let driver = null;
    let vehicle = null;
    if (t.driver_id) {
      const k = (await this.pool.query(
        `SELECT id, kind, provider, provider_session_ref, decided_at, doc_number_enc, given_names_enc, family_names_enc FROM kyc.verifications
         WHERE user_id = $1 AND status = 'approved' ORDER BY decided_at DESC`,
        [t.driver_id],
      )).rows;
      const full = k.find((v) => v.kind === 'full');
      const latest = k[0];
      const ka = (id: string, f: string) => `kyc.verifications.${f}:${id}`;
      const prof = (await this.pool.query('SELECT license_number_masked, license_category FROM drivers.profiles WHERE user_id = $1', [t.driver_id])).rows[0];
      driver = {
        userId: t.driver_id,
        givenNames: full ? await this.#dec(full.given_names_enc, ka(full.id, 'given_names')) : null,
        familyNames: full ? await this.#dec(full.family_names_enc, ka(full.id, 'family_names')) : null,
        idNumber: full ? await this.#dec(full.doc_number_enc, ka(full.id, 'doc_number')) : null,
        license: prof ? { number: prof.license_number_masked, category: prof.license_category } : null,
        latestBiometricVerification: latest ? { verificationId: latest.id, kind: latest.kind, provider: latest.provider, providerRef: latest.provider_session_ref, decidedAt: latest.decided_at } : null,
      };
      if (t.vehicle_id) vehicle = (await this.pool.query('SELECT plate, make, model, year, color FROM drivers.vehicles WHERE id = $1', [t.vehicle_id])).rows[0] ?? null;
    }
    const route = (await this.pool.query(`SELECT lat::float8 AS lat, lng::float8 AS lng, at, source FROM trips.trip_locations WHERE trip_id = $1 ORDER BY at`, [tripId])).rows;
    return {
      schema: 'intitaxi.manifest/v1',
      trip: { id: t.id, type: t.type, status: t.status, partySize: t.party_size, isForThirdParty: t.is_for_third_party },
      requester: { userId: t.requester_user_id },
      passengers,
      driver,
      vehicle,
      times: { requestedAt: t.requested_at, acceptedAt: t.accepted_at, startedAt: t.started_at, endedAt: t.ended_at },
      origin: { lat: Number(t.origin_lat), lng: Number(t.origin_lng) },
      destination: { lat: Number(t.dest_lat), lng: Number(t.dest_lng) },
      route,
      timezone: 'America/Guayaquil',
    };
  }

  /** Crea una nueva versión (append-only) encadenada y firmada. */
  async snapshot(tripId: string, reason: ManifestReason) {
    const payload = await this.build(tripId);
    return withTransaction(this.pool, async (c) => {
      // Serializa las versiones de un mismo viaje.
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`manifest:${tripId}`]);
      const prev = (await c.query<{ version: number; chain_hash: Buffer }>('SELECT version, chain_hash FROM safety.trip_manifests WHERE trip_id = $1 ORDER BY version DESC LIMIT 1', [tripId])).rows[0];
      const version = (prev?.version ?? 0) + 1;
      const id = randomUUID();
      const json = JSON.stringify({ ...payload, manifest: { id, version, reason, generatedAt: new Date().toISOString() } });
      const payloadHash = sha256(json);
      const prevHash = prev?.chain_hash ?? Buffer.alloc(32);
      const chain = sha256(Buffer.concat([prevHash, payloadHash, Buffer.from(`${tripId}:${version}`)]));
      const signature = sign('sha256', chain, this.#key);
      await c.query(
        `INSERT INTO safety.trip_manifests (id, trip_id, version, reason, payload_enc, payload_sha256, prev_hash, chain_hash, signature, key_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, tripId, version, reason, await this.cipher.encrypt(json, aad(id)), payloadHash, prevHash, chain, signature, this.config.MANIFEST_SIGNING_KID],
      );
      return { id, version, chainHash: chain.toString('base64url'), signature: signature.toString('base64url'), keyId: this.config.MANIFEST_SIGNING_KID, payload: JSON.parse(json) as Record<string, unknown> };
    });
  }

  /** Última versión descifrada + verificación de toda la cadena (hash y firma). */
  async latest(tripId: string) {
    const rows = (await this.pool.query('SELECT * FROM safety.trip_manifests WHERE trip_id = $1 ORDER BY version', [tripId])).rows;
    if (!rows.length) return null;
    let prev = Buffer.alloc(32);
    let intact = true;
    let lastGood: { row: (typeof rows)[number]; json: string } | null = null;
    for (const r of rows) {
      let json: string | null = null;
      try {
        json = await this.cipher.decrypt(r.payload_enc, aad(r.id));
      } catch {
        json = null; // texto cifrado movido o alterado: falla la autenticación AES-GCM
      }
      const ok =
        json !== null &&
        r.prev_hash.equals(prev) &&
        sha256(json).equals(r.payload_sha256) &&
        sha256(Buffer.concat([r.prev_hash, r.payload_sha256, Buffer.from(`${tripId}:${r.version}`)])).equals(r.chain_hash) &&
        verify('sha256', r.chain_hash, this.#pub, r.signature);
      intact &&= ok;
      if (ok && json) lastGood = { row: r, json };
      prev = r.chain_hash;
    }
    if (!lastGood) return { payload: null, version: null, reason: null, chainHash: null, signature: null, keyId: null, integrity: 'TAMPERED', versions: rows.length };
    const last = lastGood.row;
    return {
      payload: JSON.parse(lastGood.json) as Record<string, unknown>,
      version: last.version,
      reason: last.reason,
      chainHash: last.chain_hash.toString('base64url'),
      signature: last.signature.toString('base64url'),
      keyId: last.key_id,
      integrity: intact ? 'verified' : 'TAMPERED',
      versions: rows.length,
    };
  }
}

/** En el servicio api: versiones al iniciar y al terminar el viaje. */
@Injectable()
export class ManifestLifecycle implements OnModuleInit {
  readonly #log = new Logger('Manifest');
  constructor(
    @Inject(ManifestService) private readonly manifests: ManifestService,
    @Inject('TRIP_EVENTS_OPTIONAL') private readonly events: { onStatus(fn: (e: { tripId: string; from: string | null; to: string }) => void): void } | null,
  ) {}
  onModuleInit() {
    this.events?.onStatus(async (e) => {
      try {
        if (e.to === 'in_progress') await this.manifests.snapshot(e.tripId, 'start');
        if (e.to === 'completed' || (e.to === 'cancelled' && e.from === 'in_progress')) await this.manifests.snapshot(e.tripId, 'end');
      } catch (err) {
        this.#log.error(`no se pudo generar el manifiesto de ${e.tripId}: ${(err as Error).message}`);
      }
    });
  }
}
