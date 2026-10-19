import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { ApiClient, ApiError, hardwareSigner, passengerApi, RealtimeClient, type HardwareKey, type RealtimeMessage, type SocketLike } from '@intitaxi/mobile-core';
import { validCedula } from '@intitaxi/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { offerFor, onlineDriver, waitFor } from '../src/flows.js';
import { Stack } from '../src/stack.js';

/**
 * Ejecuta el MISMO código de cliente que usa la app Android (@intitaxi/mobile-core) contra los servicios
 * reales. Solo se sustituye el Keystore por una clave en memoria y Play Integrity por la atestación de desarrollo.
 */
const s = new Stack();
beforeAll(async () => {
  await s.start(['auth', 'api', 'sos', 'realtime']);
}, 120_000);
afterAll(() => s.stop());

/** Keystore simulado: misma interfaz que el módulo nativo (firma P-256 en formato JWS r‖s). */
function softwareKeystore(): HardwareKey {
  const keys = new Map<string, { priv: KeyObject; jwk: any }>();
  return {
    async ensureKey(alias) {
      if (!keys.has(alias)) {
        const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        keys.set(alias, { priv: privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), hardware: 'software' } });
      }
      return keys.get(alias)!.jwk;
    },
    async sign(alias, dataB64u) {
      return sign('sha256', Buffer.from(dataB64u, 'base64url'), { key: keys.get(alias)!.priv, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    },
  };
}

function memoryStore() {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v), delete: async (k: string) => void m.delete(k) };
}

async function phoneApp(store = memoryStore(), keystore = softwareKeystore()) {
  const config = { services: { auth: s.urls.auth!, api: s.urls.api!, sos: s.urls.sos!, realtime: s.urls.realtime! }, appId: 'ec.intitaxi.passenger', clientId: 'intitaxi-passenger' as const };
  const client = new ApiClient(config, await hardwareSigner(keystore), store, async (nonce) => `dev-ok:${nonce}`);
  return { client, api: passengerApi(client), store, keystore };
}

async function login() {
  const app = await phoneApp();
  const phone = s.newPhone();
  const ch = await app.client.requestOtp(phone.local);
  await app.client.verifyOtp(ch.challengeId, await s.lastCode(phone.e164));
  return { ...app, phone };
}

describe('Cliente móvil: sesión', () => {
  it('atestación + OTP + PKCE + DPoP; la sesión se restaura al reabrir la app con la misma clave', async () => {
    const app = await login();
    expect(app.client.loggedIn).toBe(true);
    const me = await app.api.me();
    expect(me.phone).toMatch(/\*/);
    expect(app.client.deviceId).toBeTruthy();
    // Reabrir la app: mismo almacenamiento seguro y misma clave del Keystore.
    const reopened = await phoneApp(app.store, app.keystore);
    expect(await reopened.client.restore()).toBe(true);
    expect((await reopened.api.me()).id).toBe(me.id);
  });

  it('un refresh token copiado a otro teléfono no sirve (está ligado a la clave del Keystore original)', async () => {
    const app = await login();
    const stolen = await phoneApp(app.store, softwareKeystore());
    expect(await stolen.client.restore()).toBe(false);
  });

  it('si el ticket de atestación deja de ser válido, el cliente vuelve a atestiguar solo', async () => {
    const app = await login();
    for (const k of await s.redis.keys('att:ticket:*')) await s.redis.del(k);
    expect((await app.api.me()).id).toBeTruthy();
    await expect(app.api.history()).resolves.toBeInstanceOf(Array);
  });

  it('los errores del servidor llegan con su código estable y mensaje en español', async () => {
    const app = await phoneApp();
    const err = await app.client.requestOtp('123').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(typeof err.message).toBe('string');
  });
});

describe('Cliente móvil: viaje completo con tiempo real', () => {
  it('cotiza, pide con un acompañante, recibe los cambios por WebSocket, PIN, SOS y recibo', async () => {
    await s.redis.del('drivers:available');
    const drv = await onlineDriver(s);
    const app = await login();
    const q = await app.api.quote({ lat: -2.1547, lng: -79.8929 }, { lat: -2.1939, lng: -79.8803 }, 'Mall del Sol', 'Malecón 2000');
    expect(q.fareCents).toBeGreaterThan(0);
    const companion = { givenNames: 'Lucía', familyNames: 'Mora Paz', idType: 'cedula' as const, idNumber: validCedula(), email: `l${Date.now()}@correo.test` };
    const trip = await app.api.requestTrip({ quoteId: q.quoteId, paymentMethod: 'cash', companions: [companion] });
    expect(trip).toMatchObject({ status: 'matching', partySize: 2 });

    const messages: RealtimeMessage[] = [];
    const rt = new RealtimeClient(app.client, (url) => new WebSocket(url) as unknown as SocketLike);
    rt.on((m) => messages.push(m));
    rt.connect();
    rt.subscribe(`trip:${trip.id}`);
    await waitFor(async () => messages, (m) => m.some((x) => x.type === 'subscribed'));

    await drv.d.call('api', 'POST', `/v1/driver/offers/${await offerFor(drv.d, trip.id)}/accept`);
    await waitFor(async () => messages, (m) => m.some((x) => x.type === 'status' && x.status === 'accepted'));
    expect((await app.api.trip(trip.id)).driver?.vehicle?.plate).toBe(drv.plate);

    await drv.d.call('api', 'POST', `/v1/driver/trips/${trip.id}/arrived`);
    const { pin } = await app.api.pin(trip.id);
    expect((await drv.d.call('api', 'POST', `/v1/driver/trips/${trip.id}/start`, { pin })).status).toBe(200);
    await waitFor(async () => messages, (m) => m.some((x) => x.type === 'status' && x.status === 'in_progress'));

    // SOS desde la app (servicio sos separado); cancelar sin PIN configurado falla de forma controlada.
    const sos = await app.api.sos(trip.id, { lat: -2.16, lng: -79.89 });
    expect(sos.call).toBe('tel:911');
    await expect(app.api.sosCancel(sos.incidentId, '0000')).rejects.toBeInstanceOf(ApiError);

    await drv.d.call('api', 'POST', '/v1/driver/location', { location: { lat: -2.1548, lng: -79.8929 } });
    await drv.d.call('api', 'POST', `/v1/driver/trips/${trip.id}/complete`);
    await waitFor(async () => messages, (m) => m.some((x) => x.type === 'status' && x.status === 'completed'));
    rt.close();

    const receipt = await waitFor(() => app.api.receipt(trip.id).catch(() => null), (r) => !!r);
    expect(receipt!.payment.method).toBe('cash');
    await app.api.rate(trip.id, 5);
    expect((await app.api.history()).find((t) => t.id === trip.id)?.status).toBe('completed');
  });

  it('Taxi Ruta: la Ruta 1 en borrador no aparece para pasajeros', async () => {
    const app = await login();
    const routes = await app.api.routes();
    expect(routes.find((r) => r.code === 'R1')).toBeUndefined();
  });

  it('cerrar sesión revoca el refresh token', async () => {
    const app = await login();
    await app.client.logout();
    const again = await phoneApp(app.store, app.keystore);
    expect(await again.client.restore()).toBe(false);
  });
});
