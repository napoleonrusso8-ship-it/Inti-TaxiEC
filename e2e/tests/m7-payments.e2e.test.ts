import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSession, completedTrip, idemKey, MALECON, requestTrip, waitFor } from '../src/flows.js';
import { Stack } from '../src/stack.js';

const s = new Stack();
let reviewer: Awaited<ReturnType<typeof adminSession>>['web'];
let support: Awaited<ReturnType<typeof adminSession>>['web'];
let analyst: Awaited<ReturnType<typeof adminSession>>['web'];
beforeAll(async () => {
  await s.start(['auth', 'api']);
  reviewer = (await adminSession(s, 'driver_reviewer')).web;
  support = (await adminSession(s, 'support')).web;
  analyst = (await adminSession(s, 'fraud_analyst')).web;
});
afterAll(() => s.stop());

const zone = (i: number) => ({ lat: -2.3 + i * 0.03, lng: -79.78 });
const balance = async (account: string) => Number((await s.pool.query('SELECT coalesce(sum(credit_cents - debit_cents), 0) AS b FROM payments.ledger_entries WHERE account = $1', [account])).rows[0].b);
const paymentOf = async (tripId: string) => (await waitFor(() => s.pool.query('SELECT * FROM payments.payments WHERE trip_id = $1', [tripId]), (r) => r.rows.length > 0)).rows[0];

describe('Tarjetas', () => {
  it('cobro con tarjeta tokenizada, recibo y reparto en el libro mayor', async () => {
    const p = await s.loggedIn();
    const card = await p.d.call('api', 'POST', '/v1/payment-methods', { cardToken: 'tok_ok_visa' });
    expect(card.body).toMatchObject({ status: 'active', last4: '4242' });
    const { drv, trip } = await completedTrip(s, { at: zone(1), passenger: p, payment: { paymentMethod: 'card', paymentMethodId: card.body.id }, reviewer });
    const pay = await paymentOf(trip.body.id);
    expect(pay.status).toBe('approved');
    const receipt = await p.d.call('api', 'GET', `/v1/trips/${trip.body.id}/receipt`);
    expect(receipt.body).toMatchObject({ payment: { card: 'VISA •••• 4242', status: 'approved' }, timezone: 'America/Guayaquil', driver: { plate: drv.plate } });
    const fare = pay.amount_cents;
    expect(await balance(`driver_payable:${drv.userId}`)).toBe(fare - Math.round(fare * 0.09));
    // Ninguna columna guarda números de tarjeta
    const { rows } = await s.pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'payments'`);
    expect(rows.some((r) => /pan|cvv|card_number/i.test(r.column_name))).toBe(false);
    // Otro usuario no ve el recibo
    expect((await (await s.loggedIn()).d.call('api', 'GET', `/v1/trips/${trip.body.id}/receipt`)).status).toBe(404);
  });

  it('3-D Secure: la tarjeta no se usa hasta completar la autenticación', async () => {
    const p = await s.loggedIn();
    const card = await p.d.call('api', 'POST', '/v1/payment-methods', { cardToken: 'tok_3ds_visa' });
    expect(card.body.status).toBe('pending_3ds');
    const early = await requestTrip(p.d, { paymentMethod: 'card', paymentMethodId: card.body.id }, zone(2), MALECON);
    expect(early.body.title).toBe('invalid_payment_method');
    const ref = card.body.threeDsUrl.split('/').pop();
    await fetch(`${s.urls.api}/v1/dev/payments/3ds/${ref}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect((await p.d.call('api', 'GET', '/v1/payment-methods')).body[0].status).toBe('active');
  });

  it('cobro rechazado: deuda que bloquea nuevos viajes hasta pagar con otra tarjeta', async () => {
    const p = await s.loggedIn();
    const bad = await p.d.call('api', 'POST', '/v1/payment-methods', { cardToken: 'tok_decline_x' });
    const { drv, trip } = await completedTrip(s, { at: zone(3), passenger: p, payment: { paymentMethod: 'card', paymentMethodId: bad.body.id }, reviewer });
    const pay = await paymentOf(trip.body.id);
    expect(pay.status).toBe('declined');
    // El conductor cobra igual
    expect(await balance(`driver_payable:${drv.userId}`)).toBeGreaterThan(0);
    expect((await requestTrip(p.d, {}, zone(3), MALECON)).body.title).toBe('payment_debt');
    const good = await p.d.call('api', 'POST', '/v1/payment-methods', { cardToken: 'tok_ok_mc' });
    expect((await p.d.call('api', 'POST', `/v1/payments/${pay.id}/retry`, { paymentMethodId: good.body.id })).body.status).toBe('approved');
    expect((await requestTrip(p.d, {}, zone(3), MALECON)).status).toBe(201);
  });

  it('un teléfono rooteado no puede registrar tarjetas', async () => {
    const d = await s.device('passenger', 'basic');
    const phone = s.newPhone();
    const r = await d.requestOtp(phone.local);
    await d.verifyOtp(r.body.challengeId, await s.lastCode(phone.e164));
    expect((await d.call('api', 'POST', '/v1/payment-methods', { cardToken: 'tok_ok_x' })).body.title).toBe('payment_method_not_allowed');
  });

  it('antifraude: la misma tarjeta en 3 cuentas genera una señal', async () => {
    let last;
    for (let i = 0; i < 3; i++) {
      last = await s.loggedIn();
      await last.d.call('api', 'POST', '/v1/payment-methods', { cardToken: 'tok_card_samefp1_x' });
    }
    const signals = await analyst.call('api', 'GET', '/v1/admin/fraud/signals');
    expect(signals.body.some((x: { signal: string; subject_id: string }) => x.signal === 'card_shared' && x.subject_id === last!.userId)).toBe(true);
  });
});

describe('Efectivo y billetera', () => {
  it('efectivo: la comisión se descuenta de lo que se le debe al conductor', async () => {
    const { drv, trip } = await completedTrip(s, { at: zone(4), reviewer });
    const pay = await paymentOf(trip.body.id);
    expect(pay.status).toBe('cash_collected');
    expect(await balance(`driver_payable:${drv.userId}`)).toBe(-Math.round(pay.amount_cents * 0.09));
  });

  it('billetera sin recargas: solo créditos de soporte; se usa para pagar', async () => {
    const p = await s.loggedIn();
    expect((await p.d.call('api', 'POST', '/v1/wallet/top-ups', { amountCents: 1000 })).status).toBe(404);
    expect((await requestTrip(p.d, { paymentMethod: 'wallet' }, zone(5), MALECON)).body.title).toBe('insufficient_wallet');
    expect((await support.call('api', 'POST', `/v1/admin/wallets/${p.userId}/credit`, { amountCents: 2000, reason: 'Compensación por demora' })).status).toBe(200);
    const w = await p.d.call('api', 'GET', '/v1/wallet');
    expect(w.body).toMatchObject({ balanceCents: 2000, topUpsEnabled: false });
    const { trip } = await completedTrip(s, { at: zone(5), passenger: p, payment: { paymentMethod: 'wallet' }, reviewer });
    const pay = await paymentOf(trip.body.id);
    expect((await p.d.call('api', 'GET', '/v1/wallet')).body.balanceCents).toBe(2000 - pay.amount_cents);
  });

  it('reembolsos: no se puede devolver más de lo cobrado, ni siquiera con peticiones simultáneas', async () => {
    const p = await s.loggedIn();
    const card = await p.d.call('api', 'POST', '/v1/payment-methods', { cardToken: 'tok_ok_refund' });
    const { trip } = await completedTrip(s, { at: zone(6), passenger: p, payment: { paymentMethod: 'card', paymentMethodId: card.body.id }, reviewer });
    const pay = await paymentOf(trip.body.id);
    const half = Math.ceil(pay.amount_cents * 0.6);
    const [a, b] = await Promise.all([
      support.call('api', 'POST', `/v1/admin/payments/${pay.id}/refund`, { amountCents: half, to: 'original', reason: 'Cobro duplicado' }),
      support.call('api', 'POST', `/v1/admin/payments/${pay.id}/refund`, { amountCents: half, to: 'wallet', reason: 'Cobro duplicado' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });
});

describe('Libro mayor', () => {
  it('es inmutable y cada asiento cuadra', async () => {
    await expect(s.pool.query(`UPDATE payments.ledger_entries SET credit_cents = 1`)).rejects.toThrow(/solo inserción/);
    const c = await s.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO payments.ledger_entries (tx_id, account, debit_cents, kind) VALUES (gen_random_uuid(), 'platform_revenue', 100, 'hack')`);
      await expect(c.query('COMMIT')).rejects.toThrow(/descuadrado/);
    } finally {
      c.release();
    }
    const { rows } = await s.pool.query('SELECT tx_id FROM payments.ledger_entries GROUP BY tx_id HAVING sum(debit_cents) <> sum(credit_cents)');
    expect(rows).toEqual([]);
  });

  it('rechaza webhooks falsificados', async () => {
    const r = await fetch(`${s.urls.api}/v1/webhooks/payments/mock`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': 'b'.repeat(64) }, body: '{"type":"three_ds_completed","ref":"x","status":"authenticated"}' });
    expect(r.status).toBe(401);
  });
});

describe('Retiros del conductor', () => {
  async function driverWithEarnings(i: number) {
    const p = await s.loggedIn();
    const card = await p.d.call('api', 'POST', '/v1/payment-methods', { cardToken: 'tok_ok_payout' });
    const { drv } = await completedTrip(s, { at: zone(i), passenger: p, payment: { paymentMethod: 'card', paymentMethodId: card.body.id }, reviewer });
    await waitFor(() => balance(`driver_payable:${drv.userId}`), (b) => b > 0);
    expect((await drv.d.registerPasskey('localhost', s.urls.auth!)).status).toBe(201);
    return drv;
  }
  const account = (cedula: string) => ({ bankCode: 'PICHINCHA', accountType: 'savings', accountNumber: '2201234567', holderName: 'Juan Carlos Mora', holderCedula: cedula });

  it('exige passkey reciente y que la cuenta sea del propio conductor; espera de seguridad', async () => {
    const drv = await driverWithEarnings(7);
    expect((await drv.d.call('api', 'POST', '/v1/driver/payout-accounts', account(drv.doc))).body.title).toBe('insufficient_user_authentication');
    await drv.d.stepUpPasskey();
    expect((await drv.d.call('api', 'POST', '/v1/driver/payout-accounts', account('1710034065'))).body.title).toBe('holder_mismatch');
    expect((await drv.d.call('api', 'POST', '/v1/driver/payout-accounts', account(drv.doc))).status).toBe(201);
    const early = await drv.d.call('api', 'POST', '/v1/driver/payouts', { amountCents: 500 }, { headers: { 'Idempotency-Key': idemKey() } });
    expect(early.body.title).toBe('payout_account_cooldown');
  });

  it('retira solo el saldo disponible, sin doble gasto, y finanzas lo marca como pagado', async () => {
    const drv = await driverWithEarnings(8);
    await drv.d.stepUpPasskey();
    await drv.d.call('api', 'POST', '/v1/driver/payout-accounts', account(drv.doc));
    await s.pool.query(`UPDATE payments.payout_accounts SET usable_from = now() WHERE driver_id = $1`, [drv.userId]);
    const available = await balance(`driver_payable:${drv.userId}`);
    expect((await drv.d.call('api', 'POST', '/v1/driver/payouts', { amountCents: available + 100 }, { headers: { 'Idempotency-Key': idemKey() } })).body.title).toBe('insufficient_balance');
    expect(available).toBeGreaterThanOrEqual(100);
    const results = await Promise.all([0, 1].map(() => drv.d.call('api', 'POST', '/v1/driver/payouts', { amountCents: available }, { headers: { 'Idempotency-Key': idemKey() } })));
    const ok = results.filter((r) => r.status === 201);
    expect(ok.length).toBe(1);
    expect(await balance(`driver_payable:${drv.userId}`)).toBe(0);
    const dec = await analyst.call('api', 'POST', `/v1/admin/payouts/${ok[0]!.body.id}/decision`, { decision: 'paid', reason: 'Transferencia SPI 123' });
    expect(dec.body.status).toBe('paid');
    expect(await balance('bank_clearing')).toBeGreaterThanOrEqual(available);
  });

  it('bloqueo anti SIM swap: si alguien entra con SMS en otro teléfono, nadie retira hasta confirmar con passkey', async () => {
    const drv = await driverWithEarnings(9);
    await drv.d.stepUpPasskey();
    await drv.d.call('api', 'POST', '/v1/driver/payout-accounts', account(drv.doc));
    await s.pool.query(`UPDATE payments.payout_accounts SET usable_from = now() WHERE driver_id = $1`, [drv.userId]);
    // Un atacante con la SIM clonada entra por SMS: no tiene passkey, así que no puede hacer step-up.
    const thief = await s.device('driver');
    const r = await thief.requestOtp(drv.phone.local);
    await thief.verifyOtp(r.body!.challengeId, await s.lastCode(drv.phone.e164));
    expect((await thief.call('api', 'POST', '/v1/driver/payouts', { amountCents: 100 }, { headers: { 'Idempotency-Key': idemKey() } })).body.title).toBe('insufficient_user_authentication');
    // El conductor legítimo (MFA aún vigente) recibe el bloqueo en su siguiente token…
    await drv.d.refresh();
    const locked = await drv.d.call('api', 'POST', '/v1/driver/payouts', { amountCents: 100 }, { headers: { 'Idempotency-Key': idemKey() } });
    expect(locked.body.title).toBe('sensitive_ops_locked');
    // …y lo levanta confirmando con su passkey.
    await drv.d.stepUpPasskey();
    expect((await drv.d.call('api', 'POST', '/v1/driver/payouts', { amountCents: 100 }, { headers: { 'Idempotency-Key': idemKey() } })).status).toBe(201);
  });
});
