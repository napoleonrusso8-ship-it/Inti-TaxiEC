import { constantTimeEqual, randomToken } from '@intitaxi/crypto';
import type { Redis } from 'ioredis';
import { createHmac } from 'node:crypto';

export type KycDecisionStatus = 'approved' | 'declined' | 'resubmission_requested' | 'expired' | 'abandoned' | 'pending';

/** Decisión normalizada del proveedor. Nunca incluye imágenes. */
export interface KycDecision {
  status: KycDecisionStatus;
  reason?: string;
  riskScore?: number;
  document?: { type?: string; country?: string; number?: string };
  person?: { givenNames?: string; familyNames?: string };
}

export interface KycProvider {
  readonly name: string;
  /** `vendorData` es un identificador seudónimo (id de la verificación), nunca datos personales. */
  createSession(input: { vendorData: string; kind: 'full' | 'driver_reverify'; referenceSessionRef?: string }): Promise<{ sessionRef: string; url: string; sdkToken?: string }>;
  getDecision(sessionRef: string): Promise<KycDecision>;
  /** Pide al proveedor eliminar imágenes y vídeo de la sesión. */
  deleteSessionData(sessionRef: string): Promise<void>;
  /** Verifica la firma del webhook y devuelve la referencia de sesión, o null si no es válido. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): string | null;
}

const hmacHex = (secret: string | Buffer, data: string | Buffer) => createHmac('sha256', secret).update(data).digest('hex');

function sessionRefFrom(body: unknown): string | null {
  const b = body as { id?: unknown; verification?: { id?: unknown }; sessionRef?: unknown };
  const ref = b?.verification?.id ?? b?.id ?? b?.sessionRef;
  return typeof ref === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(ref) ? ref : null;
}

/**
 * Veriff (Station API). Se consulta la decisión por API en lugar de confiar en el contenido del webhook.
 * ⚠️ Validar los nombres de campos contra la documentación vigente de Veriff durante la integración real.
 */
export class VeriffProvider implements KycProvider {
  readonly name = 'veriff';
  constructor(
    private readonly cfg: { baseUrl: string; apiKey: string; sharedSecret: string },
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async #req(method: string, path: string, opts: { body?: unknown; signWith?: string } = {}) {
    const headers: Record<string, string> = { 'X-AUTH-CLIENT': this.cfg.apiKey, 'Content-Type': 'application/json' };
    const payload = opts.body ? JSON.stringify(opts.body) : undefined;
    headers['X-HMAC-SIGNATURE'] = hmacHex(this.cfg.sharedSecret, opts.signWith ?? payload ?? '');
    const res = await this.fetchFn(new URL(path, this.cfg.baseUrl), { method, headers, body: payload, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Veriff respondió ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  async createSession(input: { vendorData: string; kind: 'full' | 'driver_reverify' }) {
    const r = (await this.#req('POST', '/v1/sessions', {
      body: { verification: { vendorData: input.vendorData, timestamp: new Date().toISOString() } },
    })) as { verification: { id: string; url: string; sessionToken?: string } };
    return { sessionRef: r.verification.id, url: r.verification.url, sdkToken: r.verification.sessionToken };
  }

  async getDecision(sessionRef: string): Promise<KycDecision> {
    const r = (await this.#req('GET', `/v1/sessions/${encodeURIComponent(sessionRef)}/decision`, { signWith: sessionRef })) as {
      verification?: {
        status?: string;
        reason?: string;
        riskScore?: { score?: number };
        person?: { firstName?: string; lastName?: string; idNumber?: string };
        document?: { number?: string; type?: string; country?: string };
      } | null;
    };
    const v = r.verification;
    if (!v) return { status: 'pending' };
    const known: KycDecisionStatus[] = ['approved', 'declined', 'resubmission_requested', 'expired', 'abandoned'];
    return {
      status: known.includes(v.status as KycDecisionStatus) ? (v.status as KycDecisionStatus) : 'pending',
      reason: v.reason ?? undefined,
      riskScore: v.riskScore?.score,
      document: { type: v.document?.type, country: v.document?.country, number: v.document?.number ?? v.person?.idNumber },
      person: { givenNames: v.person?.firstName, familyNames: v.person?.lastName },
    };
  }

  async deleteSessionData(sessionRef: string) {
    await this.#req('DELETE', `/v1/sessions/${encodeURIComponent(sessionRef)}`, { signWith: sessionRef });
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>) {
    const sig = headers['x-hmac-signature'];
    if (headers['x-auth-client'] !== this.cfg.apiKey || !sig || !/^[0-9a-f]{64}$/i.test(sig)) return null;
    if (!constantTimeEqual(Buffer.from(sig.toLowerCase()), Buffer.from(hmacHex(this.cfg.sharedSecret, rawBody)))) return null;
    try {
      return sessionRefFrom(JSON.parse(rawBody.toString('utf8')));
    } catch {
      return null;
    }
  }
}

/**
 * Proveedor simulado (desarrollo y simulador). Las decisiones las fija /v1/dev/kyc/... y llegan
 * por el MISMO camino que en producción: webhook firmado con HMAC → consulta de la decisión.
 */
export class MockKycProvider implements KycProvider {
  readonly name = 'mock';
  constructor(
    private readonly redis: Redis,
    private readonly webhookSecret: Buffer,
  ) {}

  async createSession(input: { vendorData: string; kind: string }) {
    const sessionRef = `mock-${randomToken(12).replace(/[^A-Za-z0-9]/g, 'x')}`;
    await this.redis.set(`mockkyc:${sessionRef}`, JSON.stringify({ status: 'pending', kind: input.kind }), 'EX', 7 * 86400);
    return { sessionRef, url: `https://kyc.simulado.invalid/${sessionRef}`, sdkToken: randomToken(16) };
  }

  async setDecision(sessionRef: string, decision: KycDecision) {
    const exists = await this.redis.exists(`mockkyc:${sessionRef}`);
    if (!exists) return false;
    await this.redis.set(`mockkyc:${sessionRef}`, JSON.stringify(decision), 'EX', 7 * 86400);
    return true;
  }

  async getDecision(sessionRef: string): Promise<KycDecision> {
    const raw = await this.redis.get(`mockkyc:${sessionRef}`);
    return raw ? (JSON.parse(raw) as KycDecision) : { status: 'expired' };
  }

  async deleteSessionData(sessionRef: string) {
    await this.redis.del(`mockkyc:${sessionRef}`);
  }

  signWebhook(rawBody: string) {
    return hmacHex(this.webhookSecret, rawBody);
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>) {
    const sig = headers['x-hmac-signature'];
    if (!sig || !/^[0-9a-f]{64}$/i.test(sig)) return null;
    if (!constantTimeEqual(Buffer.from(sig.toLowerCase()), Buffer.from(hmacHex(this.webhookSecret, rawBody)))) return null;
    try {
      return sessionRefFrom(JSON.parse(rawBody.toString('utf8')));
    } catch {
      return null;
    }
  }
}
