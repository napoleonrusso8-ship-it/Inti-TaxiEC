import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSession, idemKey, MALECON, MALL_DEL_SOL, onlineDriver, requestTrip, waitFor } from '../src/flows.js';
import { Stack } from '../src/stack.js';

const s = new Stack();
let reviewer: Awaited<ReturnType<typeof adminSession>>['web'];
beforeAll(async () => {
  await s.start(['auth', 'api']);
  reviewer = (await adminSession(s, 'driver_reviewer')).web;
});
afterAll(() => s.stop());

/** Cada prueba usa una zona distinta para que los conductores de otras pruebas no interfieran. */
const zone = (i: number) => ({ lat: -2.1 - i * 0.02, lng: -79.9 });

describe('Cotización', () => {
  it('cotiza con precio cerrado y rechaza fuera del área de servicio', async () => {
    const { d } = await s.loggedIn();
    const q = await d.call('api', 'POST', '/v1/trips/quotes', { origin: MALL_DEL_SOL, destination: MALECON });
    expect(q.status).toBe(200);
    expect(q.body.fareCents).toBeGreaterThanOrEqual(200);
    expect(q.body.fareCents % 5).toBe(0);
    const quito = await d.call('api', 'POST', '/v1/trips/quotes', { origin: { lat: -0.18, lng: -78.47 }, destination: MALECON });
    expect(quito.status).toBe(422);
  });

  it('el cliente no puede fijar el precio ni reutilizar la cotización de otro', async () => {
    const a = await s.loggedIn();
    const b = await s.loggedIn();
    const q = await a.d.call('api', 'POST', '/v1/trips/quotes', { origin: MALL_DEL_SOL, destination: MALECON });
    const stolen = await b.d.call('api', 'POST', '/v1/trips', { quoteId: q.body.quoteId, paymentMethod: 'cash', fareCents: 1 }, { headers: { 'Idempotency-Key': idemKey() } });
    expect(stolen.body.title).toBe('quote_expired');
  });
});

describe('Conexión del conductor', () => {
  it('un conductor no aprobado no puede conectarse', async () => {
    const u = await s.loggedIn('driver');
    const r = await u.d.call('api', 'POST', '/v1/driver/online', { vehicleId: '00000000-0000-4000-8000-000000000000', location: MALL_DEL_SOL });
    expect(r.status).toBe(404);
  });

  it('descarta ubicaciones con GPS falso o saltos imposibles', async () => {
    const drv = await onlineDriver(s, zone(1), 4, reviewer);
    const mock = await drv.d.call('api', 'POST', '/v1/driver/location', { location: zone(1), mock: true });
    expect(mock.body).toEqual({ accepted: false, flags: ['mock_location_reported'] });
    await drv.d.call('api', 'POST', '/v1/driver/location', { location: zone(1) });
    const jump = await drv.d.call('api', 'POST', '/v1/driver/location', { location: { lat: -1.95, lng: -79.9 } });
    expect(jump.body.flags).toContain('impossible_jump');
  });
});

describe('Ciclo completo del viaje', () => {
  it('solicitud → oferta → aceptación → llegada → PIN → finalización → calificación', async () => {
    const at = zone(2);
    const drv = await onlineDriver(s, at, 4, reviewer);
    const p = await s.loggedIn();
    const t = await requestTrip(p.d, {}, at, MALECON);
    expect(t.status).toBe(201);
    expect(t.body.status).toBe('matching');
    const offers = await waitFor(() => drv.d.call('api', 'GET', '/v1/driver/offers'), (r) => r.body.length > 0);
    expect(offers.body[0]).toMatchObject({ tripId: t.body.id, fareCents: t.body.fare.quotedCents });
    expect((await drv.d.call('api', 'POST', `/v1/driver/offers/${offers.body[0].offerId}/accept`)).body.status).toBe('accepted');

    const view = await p.d.call('api', 'GET', `/v1/trips/${t.body.id}`);
    expect(view.body.driver).toMatchObject({ firstName: 'Juan', identityVerified: true, vehicle: { plate: drv.plate } });
    expect(view.body.origin.label).toBe('Mall del Sol');

    // El conductor no puede iniciar con PIN incorrecto
    const pin = (await p.d.call('api', 'GET', `/v1/trips/${t.body.id}/pin`)).body.pin;
    expect((await drv.d.call('api', 'POST', `/v1/driver/trips/${t.body.id}/start`, { pin: pin === '0000' ? '1111' : '0000' })).status).toBe(400);
    await drv.d.call('api', 'POST', `/v1/driver/trips/${t.body.id}/arrived`);
    expect(pin).toMatch(/^\d{4}$/);
    expect((await drv.d.call('api', 'POST', `/v1/driver/trips/${t.body.id}/start`, { pin })).body.status).toBe('in_progress');
    // Un viaje en curso no se cancela
    expect((await p.d.call('api', 'POST', `/v1/trips/${t.body.id}/cancel`, {})).status).toBe(409);
    expect((await drv.d.call('api', 'POST', `/v1/driver/trips/${t.body.id}/complete`)).body.status).toBe('completed');
    expect((await p.d.call('api', 'GET', `/v1/trips/${t.body.id}`)).body.fare.finalCents).toBe(t.body.fare.quotedCents);
    expect((await p.d.call('api', 'POST', `/v1/trips/${t.body.id}/rating`, { stars: 5, comment: 'Excelente' })).status).toBe(201);
    expect((await p.d.call('api', 'POST', `/v1/trips/${t.body.id}/rating`, { stars: 1 })).status).toBe(409);
    expect((await drv.d.call('api', 'POST', `/v1/trips/${t.body.id}/rating`, { stars: 4 })).status).toBe(201);
    const { rows } = await s.pool.query('SELECT event FROM trips.trip_events WHERE trip_id = $1 ORDER BY id', [t.body.id]);
    expect(rows.map((r) => r.event)).toEqual(['requested', 'offer_sent', 'accepted', 'pin_failed', 'arrived', 'in_progress', 'completed']);
  });

  it('el PIN se bloquea tras 3 intentos fallidos', async () => {
    const at = zone(3);
    const drv = await onlineDriver(s, at, 4, reviewer);
    const p = await s.loggedIn();
    const t = await requestTrip(p.d, {}, at, MALECON);
    const o = await waitFor(() => drv.d.call('api', 'GET', '/v1/driver/offers'), (r) => r.body.length > 0);
    await drv.d.call('api', 'POST', `/v1/driver/offers/${o.body[0].offerId}/accept`);
    await drv.d.call('api', 'POST', `/v1/driver/trips/${t.body.id}/arrived`);
    const real = (await p.d.call('api', 'GET', `/v1/trips/${t.body.id}/pin`)).body.pin;
    const wrong = real === '1111' ? '2222' : '1111';
    for (let i = 0; i < 3; i++) await drv.d.call('api', 'POST', `/v1/driver/trips/${t.body.id}/start`, { pin: wrong });
    expect((await drv.d.call('api', 'POST', `/v1/driver/trips/${t.body.id}/start`, { pin: real })).status).toBe(423);
  });

  it('si el conductor no responde, la oferta vence y pasa al siguiente', async () => {
    const at = zone(4);
    const lazy = await onlineDriver(s, at, 4, reviewer);
    const p = await s.loggedIn();
    const t = await requestTrip(p.d, {}, at, MALECON);
    await waitFor(() => lazy.d.call('api', 'GET', '/v1/driver/offers'), (r) => r.body.length > 0);
    const next = await onlineDriver(s, { lat: at.lat + 0.005, lng: at.lng }, 4, reviewer);
    const o = await waitFor(() => next.d.call('api', 'GET', '/v1/driver/offers'), (r) => r.body.length > 0, 12000);
    expect(o.body[0].tripId).toBe(t.body.id);
  });

  it('idempotencia: repetir la solicitud con la misma clave no crea otro viaje', async () => {
    const { d } = await s.loggedIn();
    const q = await d.call('api', 'POST', '/v1/trips/quotes', { origin: zone(5), destination: MALECON });
    const key = idemKey();
    const a = await d.call('api', 'POST', '/v1/trips', { quoteId: q.body.quoteId, paymentMethod: 'cash' }, { headers: { 'Idempotency-Key': key } });
    const b = await d.call('api', 'POST', '/v1/trips', { quoteId: q.body.quoteId, paymentMethod: 'cash' }, { headers: { 'Idempotency-Key': key } });
    expect(b.body.id).toBe(a.body.id);
    expect((await d.call('api', 'POST', '/v1/trips', { quoteId: 'x', paymentMethod: 'cash' })).body.title).toBe('idempotency_key_required');
    // Un segundo viaje activo no se permite
    const q2 = await d.call('api', 'POST', '/v1/trips/quotes', { origin: zone(5), destination: MALECON });
    expect((await d.call('api', 'POST', '/v1/trips', { quoteId: q2.body.quoteId, paymentMethod: 'cash' }, { headers: { 'Idempotency-Key': idemKey() } })).body.title).toBe('active_trip_exists');
  });
});

describe('Autorización y privacidad', () => {
  it('nadie ajeno ve el viaje, el PIN ni acepta ofertas de otro conductor (IDOR)', async () => {
    const at = zone(6);
    const drv = await onlineDriver(s, at, 4, reviewer);
    const p = await s.loggedIn();
    const stranger = await s.loggedIn();
    const t = await requestTrip(p.d, {}, at, MALECON);
    expect((await stranger.d.call('api', 'GET', `/v1/trips/${t.body.id}`)).status).toBe(404);
    expect((await stranger.d.call('api', 'GET', `/v1/trips/${t.body.id}/pin`)).status).toBe(404);
    const o = await waitFor(() => drv.d.call('api', 'GET', '/v1/driver/offers'), (r) => r.body.length > 0);
    const other = await onlineDriver(s, { lat: at.lat - 0.01, lng: at.lng }, 4, reviewer);
    expect((await other.d.call('api', 'POST', `/v1/driver/offers/${o.body[0].offerId}/accept`)).status).toBe(404);
    // El conductor asignado no puede ver el PIN
    await drv.d.call('api', 'POST', `/v1/driver/offers/${o.body[0].offerId}/accept`);
    expect((await drv.d.call('api', 'GET', `/v1/trips/${t.body.id}/pin`)).status).toBe(404);
  });

  it('las direcciones se guardan cifradas', async () => {
    const { d } = await s.loggedIn();
    const t = await requestTrip(d, {}, zone(7), MALECON);
    const { rows } = await s.pool.query('SELECT * FROM trips.trips WHERE id = $1', [t.body.id]);
    expect(JSON.stringify(rows[0])).not.toContain('Mall del Sol');
  });

  it('pasajero con teléfono rooteado: solo efectivo', async () => {
    const u = await s.device('passenger', 'basic');
    const phone = s.newPhone();
    const r = await u.requestOtp(phone.local);
    await u.verifyOtp(r.body.challengeId, await s.lastCode(phone.e164));
    const q = await u.call('api', 'POST', '/v1/trips/quotes', { origin: zone(8), destination: MALECON });
    const card = await u.call('api', 'POST', '/v1/trips', { quoteId: q.body.quoteId, paymentMethod: 'card' }, { headers: { 'Idempotency-Key': idemKey() } });
    expect(card.body.title).toBe('payment_method_not_allowed');
  });

  it('llamada enmascarada: número proxy solo durante el viaje y sin exponer teléfonos', async () => {
    const at = zone(9);
    const drv = await onlineDriver(s, at, 4, reviewer);
    const p = await s.loggedIn();
    const t = await requestTrip(p.d, {}, at, MALECON);
    expect((await p.d.call('api', 'POST', `/v1/trips/${t.body.id}/contact-session`)).status).toBe(409);
    const o = await waitFor(() => drv.d.call('api', 'GET', '/v1/driver/offers'), (r) => r.body.length > 0);
    await drv.d.call('api', 'POST', `/v1/driver/offers/${o.body[0].offerId}/accept`);
    const c = await p.d.call('api', 'POST', `/v1/trips/${t.body.id}/contact-session`);
    expect(c.status).toBe(201);
    expect(c.body.proxyNumber).toMatch(/^\+5934\d{7}$/);
    expect(JSON.stringify(c.body)).not.toContain(p.phone.e164);
    // El endpoint interno de auth rechaza llamadas sin firma
    const direct = await fetch(`${s.urls.auth}/internal/v1/contact-sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(direct.status).toBe(401);
  });
});
