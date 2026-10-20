import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSession, offerFor, onlineDriver, waitFor } from '../src/flows.js';
import { Stack } from '../src/stack.js';

const s = new Stack();
let reviewer: Awaited<ReturnType<typeof adminSession>>['web'];
beforeAll(async () => {
  await s.start(['auth', 'api'], { api: { SURGE_ENABLED: 'true', SURGE_MAX: '1.5' } });
  reviewer = (await adminSession(s, 'driver_reviewer')).web;
}, 120_000);
afterAll(() => s.stop());

const ZONE = { lat: -2.215, lng: -79.905 };
const DEST = { lat: -2.1939, lng: -79.8803 };
const balance = async (account: string) => Number((await s.pool.query('SELECT coalesce(sum(credit_cents - debit_cents), 0) AS b FROM payments.ledger_entries WHERE account = $1', [account])).rows[0].b);
const quote = (d: Awaited<ReturnType<typeof s.loggedIn>>['d']) => d.call('api', 'POST', '/v1/trips/quotes', { origin: ZONE, destination: DEST });
let n = 0;
const request = async (d: Awaited<ReturnType<typeof s.loggedIn>>['d']) =>
  d.call('api', 'POST', '/v1/trips', { quoteId: (await quote(d)).body.quoteId, paymentMethod: 'cash' }, { headers: { 'Idempotency-Key': `surge-${Date.now()}-${++n}-xxxxxxxx` } });

describe('Tarifa dinámica', () => {
  it('sin demanda no hay recargo y el precio se muestra con su desglose', async () => {
    const p = await s.loggedIn();
    const q = await quote(p.d);
    expect(q.body.breakdown).toMatchObject({ multiplier: 1, surgeCents: 0, reason: 'normal', priceLocked: true });
    expect(q.body.fareCents).toBe(q.body.breakdown.baseCents);
  });

  it('con muchos pedidos y sin conductores sube hasta el tope; el recargo va completo al conductor', async () => {
    // Demanda: 6 pedidos sin conductor en la zona.
    for (let i = 0; i < 6; i++) expect((await request((await s.loggedIn()).d)).status).toBe(201);
    const p = await s.loggedIn();
    const q = await quote(p.d);
    expect(q.body.breakdown.multiplier).toBe(1.5);
    expect(q.body.breakdown.reason).toBe('no_drivers_nearby');
    expect(q.body.fareCents).toBe(q.body.breakdown.baseCents + q.body.breakdown.surgeCents);

    // Llega un conductor y toma el viaje: el precio cotizado se respeta.
    await s.redis.del('drivers:available');
    const drv = await onlineDriver(s, ZONE, 4, reviewer);
    const t = await p.d.call('api', 'POST', '/v1/trips', { quoteId: q.body.quoteId, paymentMethod: 'cash' }, { headers: { 'Idempotency-Key': `surge-final-${Date.now()}-xxxxxxxx` } });
    expect(t.status).toBe(201);
    await drv.d.call('api', 'POST', `/v1/driver/offers/${await offerFor(drv.d, t.body.id, 15000)}/accept`);
    await drv.d.call('api', 'POST', `/v1/driver/trips/${t.body.id}/arrived`);
    const pin = (await p.d.call('api', 'GET', `/v1/trips/${t.body.id}/pin`)).body.pin;
    await drv.d.call('api', 'POST', `/v1/driver/trips/${t.body.id}/start`, { pin });
    await drv.d.call('api', 'POST', '/v1/driver/location', { location: { lat: ZONE.lat + 0.0001, lng: ZONE.lng } });
    await drv.d.call('api', 'POST', `/v1/driver/trips/${t.body.id}/complete`);
    const pay = await waitFor(() => s.pool.query('SELECT amount_cents FROM payments.payments WHERE trip_id = $1', [t.body.id]), (r) => r.rowCount === 1);
    expect(pay.rows[0].amount_cents).toBe(q.body.fareCents);
    // Efectivo: el conductor cobró todo; la plataforma solo descuenta el 9 % de la BASE.
    expect(await balance(`driver_payable:${drv.userId}`)).toBe(-Math.round(q.body.breakdown.baseCents * 0.09));
    const view = await p.d.call('api', 'GET', `/v1/trips/${t.body.id}`);
    expect(view.body.fare).toMatchObject({ baseCents: q.body.breakdown.baseCents, surgeCents: q.body.breakdown.surgeCents });
  });
});
