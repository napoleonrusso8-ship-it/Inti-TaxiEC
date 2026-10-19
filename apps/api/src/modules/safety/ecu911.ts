import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import type { Redis } from 'ioredis';

export interface EmergencyReport {
  incidentId: string;
  type: 'sos' | 'accident' | 'other';
  duress: boolean;
  location: { lat: number; lng: number } | null;
  /** Manifiesto completo del viaje (quién iba en el vehículo, conductor, placa, ruta). */
  manifest: Record<string, unknown>;
  manifestSignature: { chainHash: string; signature: string; keyId: string };
}

export type Ecu911Status = 'simulated' | 'awaiting_operator' | 'sent' | 'failed';

/**
 * Adaptador hacia el Servicio Integrado de Seguridad ECU 911. Es un módulo independiente porque la integración
 * real requiere un convenio formal. Solo se usa ante una emergencia (SOS o accidente): nunca hay intercambio rutinario.
 */
export interface Ecu911Port {
  readonly mode: 'mock' | 'signed_link' | 'agreement';
  reportEmergency(r: EmergencyReport): Promise<{ status: Ecu911Status; ref?: string }>;
  updateLocation(ref: string, location: { lat: number; lng: number }): Promise<void>;
  close(ref: string, outcome: string): Promise<void>;
}

/**
 * Simulado (desarrollo, simulador y pruebas): registra lo que "recibiría" el ECU 911 en Redis.
 * NUNCA contacta al 911 real. Prohibido en producción.
 */
export class MockEcu911Adapter implements Ecu911Port {
  readonly mode = 'mock' as const;
  constructor(private readonly redis: Redis) {}
  async #log(entry: Record<string, unknown>) {
    await this.redis.multi().lpush('ecu911:mock', JSON.stringify({ ...entry, at: new Date().toISOString() })).ltrim('ecu911:mock', 0, 199).exec();
  }
  async reportEmergency(r: EmergencyReport) {
    const ref = `SIM-${r.incidentId.slice(0, 8).toUpperCase()}`;
    const people = (r.manifest.passengers as unknown[] | undefined)?.length ?? 0;
    await this.#log({ kind: 'report', ref, type: r.type, duress: r.duress, location: r.location, plate: (r.manifest.vehicle as { plate?: string } | null)?.plate, people, signed: !!r.manifestSignature.signature });
    return { status: 'simulated' as const, ref };
  }
  async updateLocation(ref: string, location: { lat: number; lng: number }) {
    await this.#log({ kind: 'location', ref, location });
  }
  async close(ref: string, outcome: string) {
    await this.#log({ kind: 'close', ref, outcome });
  }
}

/**
 * Sin convenio: la app ya llamó al 911 desde el teléfono. El centro de monitoreo interno genera un enlace
 * seguro, temporal y firmado con el manifiesto (doble aprobación) y lo entrega a las autoridades.
 */
export class SignedLinkEcu911Adapter implements Ecu911Port {
  readonly mode = 'signed_link' as const;
  async reportEmergency() {
    return { status: 'awaiting_operator' as const };
  }
  async updateLocation() {}
  async close() {}
}

/**
 * Con convenio: envío por canal cifrado y autenticado mutuamente (mTLS) al endpoint que defina el ECU 911.
 * ⚠️ El formato del mensaje se debe acordar con el ECU 911; este adaptador implementa el transporte seguro.
 */
export class AgreementEcu911Adapter implements Ecu911Port {
  readonly mode = 'agreement' as const;
  readonly #tls: { cert: Buffer; key: Buffer; ca?: Buffer };

  constructor(private readonly endpoint: string, files: { cert: string; key: string; ca?: string }) {
    this.#tls = { cert: readFileSync(files.cert), key: readFileSync(files.key), ca: files.ca ? readFileSync(files.ca) : undefined };
  }

  #post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const url = new URL(path, this.endpoint);
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        { method: 'POST', ...this.#tls, minVersion: 'TLSv1.3', rejectUnauthorized: true, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 5000 },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : {} }));
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(payload);
    });
  }

  async reportEmergency(r: EmergencyReport) {
    try {
      const res = await this.#post('/incidentes', r);
      return res.status >= 200 && res.status < 300 ? { status: 'sent' as const, ref: String(res.json.referencia ?? r.incidentId) } : { status: 'failed' as const };
    } catch {
      return { status: 'failed' as const };
    }
  }

  async updateLocation(ref: string, location: { lat: number; lng: number }) {
    await this.#post(`/incidentes/${encodeURIComponent(ref)}/ubicacion`, location).catch(() => {});
  }

  async close(ref: string, outcome: string) {
    await this.#post(`/incidentes/${encodeURIComponent(ref)}/cierre`, { outcome }).catch(() => {});
  }
}
