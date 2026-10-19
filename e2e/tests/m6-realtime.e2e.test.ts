import { SimSocket, validCedula } from '@intitaxi/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSession, grantConsent, MALECON, offerFor, onlineDriver, requestTrip, waitFor } from '../src/flows.js';
import { Stack } from '../src/stack.js';

const s = new Stack();
let reviewer: Awaited<ReturnType<typeof adminSession>>['web'];
beforeAll(async () => {
  await s.start(['auth', 'api', 'realtime']);
  reviewer = (await adminSession(s, 'driver_reviewer')).web;
});
afterAll(() => s.stop());

const zone = (i: number) => ({ lat: -2.05 - i * 0.03, lng: -79.98 });
const wsUrl = () => s.urls.realtime!.replace(/^http/, 'ws') + '/v1/ws';

async function acceptedTrip(i: number, extra: Record<string, unknown> = {}) {
  const at = zone(i);
  const drv = await onlineDriver(s, at, 4, reviewer);
  const p = await s.loggedIn();
  const t = await requestTrip(p.d, extra, at, MALECON);
  await drv.d.call('api', 'POST', `/v1/driver/offers/${await offerFor(drv.d, t.body.id)}/accept`);
  return { drv, p, tripId: t.body.id as string, at };
}

describe('Seguimiento en tiempo real', () => {
  it('el pasajero recibe estado, datos del conductor y ubicación en vivo', async () => {
    const { drv, p, tripId, at } = await acceptedTrip(1);
    const ws = await p.d.openSocket();
    expect(await ws.waitFor((m) => m.type === 'ready')).toBeTruthy();
    ws.send({ type: 'subscribe', channel: `trip:${tripId}` });
    const sub = await ws.waitFor((m) => m.type === 'subscribed');
    expect(sub.snapshot).toMatchObject({ status: 'accepted', driver: { vehicle: { plate: drv.plate } } });
    await drv.d.call('api', 'POST', '/v1/driver/location', { location: { lat: at.lat + 0.0001, lng: at.lng } });
    const loc = await ws.waitFor((m) => m.type === 'location');
    expect(loc).toMatchObject({ channel: `trip:${tripId}`, lat: at.lat + 0.0001 });
    await drv.d.call('api', 'POST', `/v1/driver/trips/${tripId}/arrived`);
    expect(await ws.waitFor((m) => m.type === 'status' && m.status === 'arrived')).toBeTruthy();
    // La ruta queda guardada para el manifiesto
    const { rows } = await s.pool.query('SELECT count(*)::int AS n FROM trips.trip_locations WHERE trip_id = $1', [tripId]);
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
    ws.close();
  });

  it('un usuario ajeno no puede suscribirse al viaje', async () => {
    const { tripId } = await acceptedTrip(2);
    const stranger = await s.loggedIn();
    const ws = await stranger.d.openSocket();
    ws.send({ type: 'subscribe', channel: `trip:${tripId}` });
    expect(await ws.waitFor((m) => m.type === 'error')).toMatchObject({ code: 'forbidden' });
    ws.close();
  });

  it('rechaza conexiones sin DPoP o con token robado; los navegadores se autentican por mensaje', async () => {
    const { p } = await acceptedTrip(3);
    const noAuth = await SimSocket.connect(wsUrl());
    await waitFor(async () => noAuth.closed, (c) => !!c, 7000);
    expect(noAuth.closed?.code).toBe(4001);
    // Token robado usado desde otra clave
    const thief = await s.device();
    thief.accessToken = p.d.accessToken;
    const stolen = await thief.openSocket();
    await waitFor(async () => stolen.closed, (c) => !!c, 3000);
    expect(stolen.closed?.code).toBe(4001);
    // Autenticación por mensaje
    const browser = await SimSocket.connect(wsUrl());
    browser.send(await p.d.socketAuthMessage());
    expect(await browser.waitFor((m) => m.type === 'ready')).toBeTruthy();
    browser.close();
  });

  it('chat: entre pasajero y conductor, oculta teléfonos y correos', async () => {
    const { drv, p, tripId } = await acceptedTrip(4);
    const a = await p.d.openSocket();
    const b = await drv.d.openSocket();
    for (const ws of [a, b]) ws.send({ type: 'subscribe', channel: `trip:${tripId}` });
    await b.waitFor((m) => m.type === 'subscribed');
    await a.waitFor((m) => m.type === 'subscribed');
    a.send({ type: 'chat', tripId, text: 'Estoy en la puerta 3, llámame al 0991234567 o ana@correo.ec' });
    const got = await b.waitFor((m) => m.type === 'chat');
    expect(got).toMatchObject({ from: 'passenger', text: 'Estoy en la puerta 3, llámame al [número oculto] o [correo oculto]' });
    b.send({ type: 'chat', tripId, text: 'Voy llegando' });
    expect(await a.waitFor((m) => m.type === 'chat' && m.from === 'driver')).toBeTruthy();
    a.close();
    b.close();
  });
});

describe('Enlaces de seguimiento', () => {
  it('el tercero sin app ve la página y la ubicación, pero no el chat', async () => {
    const third = { givenNames: 'Carmen', familyNames: 'Vera', idType: 'cedula', idNumber: validCedula(), email: `c${Date.now()}@correo.test`, phone: '0981112233' };
    const { drv, p, tripId, at } = await acceptedTrip(5, { forThirdParty: third });
    const sms = await waitFor(() => s.inbox(), (m) => m.some((x) => x.to === '+593981112233'));
    const link = /(http\S+\/t\/[A-Za-z0-9_-]{43})/.exec(sms.find((x) => x.to === '+593981112233')!.text)![1]!;
    const page = await fetch(link);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    const token = link.split('/').pop()!;
    const pub = await SimSocket.connect(`${wsUrl()}?share=${token}`);
    const sub = await pub.waitFor((m) => m.type === 'subscribed');
    expect(sub.channel).toBe(`trip:${tripId}`);
    const firstLoc = await drv.d.call('api', 'POST', '/v1/driver/location', { location: { lat: at.lat + 0.0002, lng: at.lng } });
    expect(firstLoc.body.accepted).toBe(true);
    expect(await pub.waitFor((m) => m.type === 'location')).toBeTruthy();
    const ws = await p.d.openSocket();
    ws.send({ type: 'subscribe', channel: `trip:${tripId}` });
    await ws.waitFor((m) => m.type === 'subscribed');
    ws.send({ type: 'chat', tripId, text: 'privado' });
    await new Promise((r) => setTimeout(r, 500));
    expect(pub.messages.some((m) => m.type === 'chat')).toBe(false);
    // Desde el enlace no se puede chatear ni suscribirse a otros viajes
    pub.send({ type: 'subscribe', channel: `trip:${tripId}` });
    expect(await pub.waitFor((m) => m.type === 'error')).toMatchObject({ code: 'forbidden' });
    expect((await fetch(link.replace(/.{4}$/, 'AAAA'))).status).toBe(404);
    pub.close();
    ws.close();
  });

  it('compartir con contactos de confianza exige consentimiento y caduca al terminar el viaje', async () => {
    const { drv, p, tripId } = await acceptedTrip(6);
    expect((await p.d.call('api', 'POST', `/v1/trips/${tripId}/share-links`)).body.title).toBe('consent_required');
    await grantConsent(p.d, 'trip_sharing');
    const link = await p.d.call('api', 'POST', `/v1/trips/${tripId}/share-links`);
    expect(link.status).toBe(201);
    const token = link.body.url.split('/').pop();
    await drv.d.call('api', 'POST', `/v1/trips/${tripId}/cancel`, {});
    const key = `rt:share:${(await import('node:crypto')).createHash('sha256').update(token).digest('base64url')}`;
    const ttl = await waitFor(() => s.redis.ttl(key), (t) => t <= 15 * 60);
    expect(ttl).toBeLessThanOrEqual(15 * 60);
  });

  it('la ruta GPS se seudonimiza a los 30 días', async () => {
    const { drv, tripId, at } = await acceptedTrip(7);
    await drv.d.call('api', 'POST', '/v1/driver/location', { location: { lat: at.lat + 0.0001234, lng: at.lng } });
    await drv.d.call('api', 'POST', `/v1/trips/${tripId}/cancel`, {});
    await s.pool.query(`UPDATE trips.trips SET ended_at = now() - interval '31 days' WHERE id = $1`, [tripId]);
    await fetch(`${s.urls.api}/v1/dev/retention/run`, { method: 'POST' });
    const { rows } = await s.pool.query('SELECT lat, generalized FROM trips.trip_locations WHERE trip_id = $1', [tripId]);
    expect(rows.every((r) => r.generalized && Number(r.lat) === Math.round(Number(r.lat) * 1000) / 1000)).toBe(true);
  });
});
