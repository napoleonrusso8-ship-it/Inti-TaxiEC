import { constantTimeEqual, randomToken } from '@intitaxi/crypto';
import type { Redis } from 'ioredis';
import { createHmac } from 'node:crypto';

export interface SavedCard {
  status: 'active' | 'pending_3ds';
  gatewayRef: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  /** Identificador estable de la tarjeta física (para detectar la misma tarjeta en varias cuentas). */
  fingerprint?: string;
  threeDsUrl?: string;
  threeDsRef?: string;
}

export interface ChargeResult {
  status: 'approved' | 'declined';
  gatewayRef?: string;
  declineReason?: string;
}

export interface GatewayEvent {
  type: 'three_ds_completed' | 'charge_updated' | 'refund_completed';
  ref: string;
  status: string;
}

/**
 * Pasarela de pagos certificada PCI DSS. Los datos de tarjeta se capturan en el SDK/campos alojados
 * de la pasarela: el backend solo recibe un token de un solo uso y lo convierte en una tarjeta guardada.
 * La autenticación 3-D Secure se hace al registrar la tarjeta; los cobros posteriores son iniciados
 * por el comercio (MIT) sobre la tarjeta ya autenticada.
 */
export interface PaymentGateway {
  readonly name: string;
  saveCard(input: { cardToken: string; userRef: string }): Promise<SavedCard>;
  charge(input: { gatewayRef: string; amountCents: number; idempotencyKey: string; description: string }): Promise<ChargeResult>;
  refund(input: { chargeRef: string; amountCents: number; idempotencyKey: string }): Promise<{ status: 'refunded' | 'failed' }>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): GatewayEvent | null;
}

const hmacHex = (secret: string | Buffer, data: string | Buffer) => createHmac('sha256', secret).update(data).digest('hex');

function verifySig(secret: string | Buffer, rawBody: Buffer, sig: string | undefined): boolean {
  return !!sig && /^[0-9a-f]{64}$/i.test(sig) && constantTimeEqual(Buffer.from(sig.toLowerCase()), Buffer.from(hmacHex(secret, rawBody)));
}

/**
 * Kushki (adquirente local en Ecuador, PCI DSS nivel 1).
 * ⚠️ ESQUELETO: rutas y campos deben validarse contra la documentación vigente de Kushki en su entorno UAT
 * antes de producción (no se pudo probar contra la pasarela real desde este entorno).
 */
export class KushkiGateway implements PaymentGateway {
  readonly name = 'kushki';
  constructor(
    private readonly cfg: { baseUrl: string; privateMerchantId: string; webhookSecret: string },
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async #req(method: string, path: string, body: unknown, idempotencyKey?: string) {
    const res = await this.fetchFn(new URL(path, this.cfg.baseUrl), {
      method,
      headers: { 'Content-Type': 'application/json', 'Private-Merchant-Id': this.cfg.privateMerchantId, ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    return { ok: res.ok, status: res.status, json };
  }

  async saveCard({ cardToken, userRef }: { cardToken: string; userRef: string }): Promise<SavedCard> {
    const r = await this.#req('POST', '/subscriptions/v1/card', { token: cardToken, planName: 'intitaxi-on-demand', periodicity: 'custom', currency: 'USD', metadata: { userRef } });
    if (!r.ok || !r.json.subscriptionId) throw new Error(`Kushki no guardó la tarjeta (${r.status})`);
    return {
      status: 'active',
      gatewayRef: r.json.subscriptionId,
      brand: String(r.json.cardBrand ?? r.json.binInfo?.brand ?? 'card'),
      last4: String(r.json.lastFourDigits ?? r.json.maskedCreditCard ?? '0000').slice(-4),
      expMonth: Number(r.json.expiryMonth ?? 12),
      expYear: Number(r.json.expiryYear ?? 2099),
    };
  }

  async charge({ gatewayRef, amountCents, idempotencyKey, description }: { gatewayRef: string; amountCents: number; idempotencyKey: string; description: string }): Promise<ChargeResult> {
    const amount = { subtotalIva: 0, subtotalIva0: amountCents / 100, iva: 0, currency: 'USD' };
    const r = await this.#req('POST', `/subscriptions/v1/card/${encodeURIComponent(gatewayRef)}`, { amount, metadata: { description } }, idempotencyKey);
    return r.ok && r.json.ticketNumber ? { status: 'approved', gatewayRef: r.json.ticketNumber } : { status: 'declined', declineReason: String(r.json.code ?? r.status) };
  }

  async refund({ chargeRef, amountCents, idempotencyKey }: { chargeRef: string; amountCents: number; idempotencyKey: string }) {
    const r = await this.#req('POST', `/v1/refund/${encodeURIComponent(chargeRef)}`, { amount: { subtotalIva0: amountCents / 100, currency: 'USD' } }, idempotencyKey);
    return { status: r.ok ? ('refunded' as const) : ('failed' as const) };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): GatewayEvent | null {
    if (!verifySig(this.cfg.webhookSecret, rawBody, headers['x-kushki-signature'])) return null;
    try {
      const b = JSON.parse(rawBody.toString('utf8')) as { type?: string; ticketNumber?: string; status?: string };
      return b.ticketNumber ? { type: 'charge_updated', ref: b.ticketNumber, status: String(b.status) } : null;
    } catch {
      return null;
    }
  }
}

/**
 * Pasarela simulada (desarrollo, simulador y pruebas). Tokens de prueba:
 *  tok_ok_*        tarjeta válida
 *  tok_3ds_*       requiere 3-D Secure (se completa con /v1/dev/payments/3ds/{ref}/complete)
 *  tok_decline_*   se guarda bien, pero los cobros se rechazan
 *  tok_card_<fp>_* misma tarjeta física (huella <fp>) para probar tarjetas compartidas
 */
export class MockGateway implements PaymentGateway {
  readonly name = 'mock';
  constructor(
    private readonly redis: Redis,
    private readonly secret: Buffer,
    private readonly baseUrl: string,
  ) {}

  async saveCard({ cardToken }: { cardToken: string }): Promise<SavedCard> {
    if (!/^tok_[a-z0-9_]{3,60}$/i.test(cardToken)) throw new Error('token inválido');
    const gatewayRef = `card_${randomToken(12).replace(/[^A-Za-z0-9]/g, 'x')}`;
    const decline = cardToken.startsWith('tok_decline');
    const fp = /^tok_card_([a-z0-9]+)_/i.exec(cardToken)?.[1] ?? randomToken(8);
    await this.redis.set(`mockpay:card:${gatewayRef}`, decline ? 'decline' : 'ok', 'EX', 30 * 86400);
    const card: SavedCard = { status: 'active', gatewayRef, brand: 'VISA', last4: decline ? '0002' : '4242', expMonth: 12, expYear: 2030, fingerprint: fp };
    if (cardToken.startsWith('tok_3ds')) {
      const threeDsRef = `3ds_${randomToken(10).replace(/[^A-Za-z0-9]/g, 'x')}`;
      return { ...card, status: 'pending_3ds', threeDsRef, threeDsUrl: `${this.baseUrl}/v1/dev/payments/3ds/${threeDsRef}` };
    }
    return card;
  }

  async charge({ gatewayRef }: { gatewayRef: string }): Promise<ChargeResult> {
    const state = await this.redis.get(`mockpay:card:${gatewayRef}`);
    if (state !== 'ok') return { status: 'declined', declineReason: state === 'decline' ? 'insufficient_funds' : 'card_not_found' };
    return { status: 'approved', gatewayRef: `ch_${randomToken(10).replace(/[^A-Za-z0-9]/g, 'x')}` };
  }

  async refund() {
    return { status: 'refunded' as const };
  }

  sign(raw: string) {
    return hmacHex(this.secret, raw);
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): GatewayEvent | null {
    if (!verifySig(this.secret, rawBody, headers['x-signature'])) return null;
    try {
      const b = JSON.parse(rawBody.toString('utf8')) as GatewayEvent;
      return typeof b.ref === 'string' && typeof b.type === 'string' ? b : null;
    } catch {
      return null;
    }
  }
}
