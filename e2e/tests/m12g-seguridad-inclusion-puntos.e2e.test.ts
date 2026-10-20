import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSession, completedTrip, grantConsent, MALL_DEL_SOL, offerFor, onlineDriver, requestTrip, startedTrip, waitFor } from '../src/flows.js';
import { Stack } from '../src/stack.js';

const s = new Stack();
type Admin = Awaited<ReturnType<typeof adminSession>>;
let reviewer: Admin;
beforeAll(async () => {
  await s.start(['auth', 'api', 'sos'], { api: { DEVIATION_THRESHOLD_M: '300', DEVIATION_MIN_TRIP_SECONDS: '0', SAFETY_CHECK_RESPONSE_SECONDS: '10', SAFETY_SWEEP_MS: '500' } });
  reviewer = await adminSession(s, 'driver_reviewer');
}, 120_000);
afterAll(() => s.stop());

const zone = (i: number) => ({ lat: -2.10 - i * 0.02, lng: -79.97 });
const wallet = async (userId: string) => Number((await s.pool.query('SELECT coalesce(sum(credit_cents - debit_cents), 0) AS b FROM payments.ledger_entries WHERE account = $1', [`wallet:${userId}`])).rows[0].b);

describe('Nombre de preferencia', () => {
  it('el conductor ve el nombre que eligió la persona; la auditoría no guarda el nombre', async () => {
    await s.redis.del('drivers:available');
    const drv = await onlineDriver(s, zone(1), 4, reviewer.web);
    const p = await s.loggedIn();
    expect((await p.d.call('api', 'PUT', '/v1/me/preferences', { chosenName: 'Valentina' })).body.chosenName).toBe('Valentina');
    const t = await requestTrip(p.d, {}, zone(1));
    await drv.d.call('api', 'POST', `/v1/driver/offers/${await offerFor(drv.d, t.body.id)}/accept`);
    const view = await drv.d.call('api', 'GET', `/v1/trips/${t.body.id}`);
    expect(view.body.passenger).toMatchObject({ firstName: 'Valentina', usesChosenName: true });
    const audit = await s.pool.query(`SELECT metadata::text AS m FROM audit.audit_log WHERE action = 'passenger.preferences'`);
    expect(audit.rows.every((r) => !r.m.includes('Valentina'))).toBe(true);
    await p.d.call('api', 'POST', `/v1/trips/${t.body.id}/cancel`, {});
  });
});

describe('Modo Ellxs y Conductor Aliado', () => {
  it('Modo Ellxs: exige consentimiento; solo conductorxs Ellxs aprobadxs por una persona del equipo reciben el viaje', async () => {
    await s.redis.del('drivers:available');
    const man = await onlineDriver(s, zone(2), 4, reviewer.web);
    const p = await s.loggedIn();
    expect((await requestTrip(p.d, { ellxsOnly: true }, zone(2))).body.title).toBe('ellxs_not_enabled');
    // Dato sensible (LOPDP art. 26): sin el consentimiento 'ellxs' no se guarda la autodeclaración.
    const noConsent = await p.d.call('api', 'PUT', '/v1/me/preferences', { ellxsMember: true });
    expect(noConsent.status).toBe(409);
    expect(noConsent.body.title).toBe('consent_required');
    const text = await p.d.call('api', 'GET', '/v1/consents/texts/ellxs', undefined, { auth: false });
    expect(text.body.body).toContain('mujer o que formas parte de la comunidad LGBTI');
    expect((await grantConsent(p.d, 'ellxs')).status).toBe(201);
    expect((await p.d.call('api', 'PUT', '/v1/me/preferences', { ellxsMember: true })).body.ellxsMember).toBe(true);
    const t = await requestTrip(p.d, { ellxsOnly: true }, zone(2));
    expect(t.status).toBe(201);
    expect(t.body.ellxsOnly).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await man.d.call('api', 'GET', '/v1/driver/offers')).body.some((o: { tripId: string }) => o.tripId === t.body.id)).toBe(false);
    const ellxs = await onlineDriver(s, zone(2), 4, reviewer.web);
    expect((await ellxs.d.call('api', 'POST', '/v1/driver/ellxs/request')).body).toEqual({ status: 'pending_review' });
    expect((await reviewer.web.call('api', 'GET', '/v1/admin/drivers/ellxs/pending')).body.some((x: { driverId: string }) => x.driverId === ellxs.userId)).toBe(true);
    expect((await reviewer.web.call('api', 'POST', `/v1/admin/drivers/${ellxs.userId}/ellxs`, { approve: true })).body).toEqual({ driverId: ellxs.userId, ellxs: true });
    const offers = await waitFor(() => ellxs.d.call('api', 'GET', '/v1/driver/offers'), (r) => r.body.some((o: { tripId: string }) => o.tripId === t.body.id), 10000);
    expect(offers.body.find((o: { tripId: string }) => o.tripId === t.body.id).ellxsOnly).toBe(true);
    await ellxs.d.call('api', 'POST', `/v1/driver/offers/${await offerFor(ellxs.d, t.body.id, 10000)}/accept`);
    const view = await p.d.call('api', 'GET', `/v1/trips/${t.body.id}`);
    expect(view.body.driver.badges).toEqual({ ally: false, ellxs: true });
    // La conductorx no ve la autodeclaración de la persona (solo que el viaje es Ellxs).
    const dview = await ellxs.d.call('api', 'GET', `/v1/trips/${t.body.id}`);
    expect(JSON.stringify(dview.body.passenger)).not.toMatch(/ellxs/i);
    await p.d.call('api', 'POST', `/v1/trips/${t.body.id}/cancel`, {});
    // Las rutas antiguas ya no existen.
    expect((await ellxs.d.call('api', 'POST', '/v1/driver/women-rides/request')).status).toBe(404);
  });

  it('Modo Ellxs: desactivarlo borra la autodeclaración y revoca el consentimiento; revocar el consentimiento también la borra', async () => {
    const p = await s.loggedIn();
    await grantConsent(p.d, 'ellxs');
    await p.d.call('api', 'PUT', '/v1/me/preferences', { ellxsMember: true });
    expect((await p.d.call('api', 'PUT', '/v1/me/preferences', { ellxsMember: false })).body.ellxsMember).toBe(false);
    const consents = await p.d.call('api', 'GET', '/v1/consents');
    expect(consents.body.find((c: { purpose: string }) => c.purpose === 'ellxs')).toMatchObject({ granted: false });
    expect((await p.d.call('api', 'PUT', '/v1/me/preferences', { ellxsMember: true })).body.title).toBe('consent_required');
    await grantConsent(p.d, 'ellxs');
    await p.d.call('api', 'PUT', '/v1/me/preferences', { ellxsMember: true });
    expect((await p.d.call('api', 'DELETE', '/v1/consents/ellxs')).status).toBe(204);
    expect((await p.d.call('api', 'GET', '/v1/me/preferences')).body.ellxsMember).toBe(false);
    // La auditoría no guarda el valor de la autodeclaración.
    const audit = await s.pool.query(`SELECT metadata::text AS m FROM audit.audit_log WHERE action = 'passenger.preferences' AND resource_id = $1`, [p.userId]);
    expect(audit.rows.every((r) => !/true|false/.test(r.m))).toBe(true);
  });

  it('Conductor Aliado: curso con preguntas; el filtro solo ofrece el viaje a aliados', async () => {
    await s.redis.del('drivers:available');
    const drv = await onlineDriver(s, zone(3), 4, reviewer.web);
    const course = await drv.d.call('api', 'GET', '/v1/driver/ally/course');
    expect(course.body.questions[0].answer).toBeUndefined();
    expect((await drv.d.call('api', 'POST', '/v1/driver/ally/certify', { answers: { q1: 0, q2: 2, q3: 0 } })).body.title).toBe('course_failed');
    const p = await s.loggedIn();
    const t = await requestTrip(p.d, { allyOnly: true, prefs: { quiet: true } }, zone(3));
    await new Promise((r) => setTimeout(r, 1200));
    expect((await drv.d.call('api', 'GET', '/v1/driver/offers')).body.some((o: { tripId: string }) => o.tripId === t.body.id)).toBe(false);
    expect((await drv.d.call('api', 'POST', '/v1/driver/ally/certify', { answers: { q1: 1, q2: 2, q3: 0 } })).body.ally).toBe(true);
    const offers = await waitFor(() => drv.d.call('api', 'GET', '/v1/driver/offers'), (r) => r.body.some((o: { tripId: string }) => o.tripId === t.body.id), 10000);
    expect(offers.body.find((o: { tripId: string }) => o.tripId === t.body.id)).toMatchObject({ allyOnly: true, prefs: { quiet: true } });
    await p.d.call('api', 'POST', `/v1/trips/${t.body.id}/cancel`, {});
  });

  it('mascota: solo vehículos que la aceptan', async () => {
    await s.redis.del('drivers:available');
    const drv = await onlineDriver(s, zone(4), 4, reviewer.web);
    const p = await s.loggedIn();
    const t = await requestTrip(p.d, { prefs: { pet: true } }, zone(4));
    await new Promise((r) => setTimeout(r, 1200));
    expect((await drv.d.call('api', 'GET', '/v1/driver/offers')).body.some((o: { tripId: string }) => o.tripId === t.body.id)).toBe(false);
    await drv.d.call('api', 'PUT', `/v1/driver/vehicles/${drv.vehicleId}/features`, { features: ['pet_friendly', 'ac'] });
    expect(await offerFor(drv.d, t.body.id, 10000)).toBeTruthy();
    await p.d.call('api', 'POST', `/v1/trips/${t.body.id}/cancel`, {});
  });
});

describe('Inti Puntos', () => {
  it('1 punto por dólar; bono al conductor por 5 estrellas; canje desde 500 con tope mensual', async () => {
    const { p, drv, trip } = await completedTrip(s, { at: zone(5), reviewer: reviewer.web });
    const fare = await waitFor(() => s.pool.query('SELECT final_fare_cents FROM trips.trips WHERE id = $1', [trip.body.id]), (r) => !!r.rows[0]);
    const pts = await waitFor(() => p.d.call('api', 'GET', '/v1/loyalty'), (r) => r.body.points > 0);
    expect(pts.body.points).toBe(Math.floor(fare.rows[0].final_fare_cents / 100));
    await p.d.call('api', 'POST', `/v1/trips/${trip.body.id}/rating`, { stars: 5 });
    expect((await waitFor(() => drv.d.call('api', 'GET', '/v1/loyalty'), (r) => r.body.points > 0)).body.points).toBe(10);

    await s.pool.query(`INSERT INTO loyalty.entries (user_id, role, points, kind, ref_id) VALUES ($1, 'passenger', 2600, 'trip', 'carga-prueba')`, [p.userId]);
    expect((await p.d.call('api', 'POST', '/v1/loyalty/redeem', { points: 300 })).body.title).toBe('invalid_points');
    const before = await wallet(p.userId);
    expect((await p.d.call('api', 'POST', '/v1/loyalty/redeem', { points: 1500 })).body).toMatchObject({ redeemedPoints: 1500, creditedCents: 1500 });
    expect(await wallet(p.userId)).toBe(before + 1500);
    expect((await p.d.call('api', 'POST', '/v1/loyalty/redeem', { points: 600 })).body.title).toBe('monthly_limit');
  });
});

describe('Alerta de desvío', () => {
  async function driveAway(drv: { d: Awaited<ReturnType<typeof s.loggedIn>>['d'] }) {
    // Se aleja del destino (Malecón, al sur) hacia el norte en pasos de ~90 m.
    for (let i = 1; i <= 6; i++) await drv.d.call('api', 'POST', '/v1/driver/location', { location: { lat: MALL_DEL_SOL.lat + i * 0.0008, lng: MALL_DEL_SOL.lng } });
  }

  it('pregunta SOLO al pasajero si está bien; si responde que sí, no pasa nada más', async () => {
    const { drv, p, tripId } = await startedTrip(s);
    await p.d.call('api', 'PUT', '/v1/me/preferences', { deviationAlerts: 'always' });
    await s.redis.del(`safety:trip:${tripId}`);
    await driveAway(drv);
    const check = await waitFor(() => p.d.call('api', 'GET', `/v1/trips/${tripId}/safety-checks/pending`), (r) => !!r.body?.id);
    expect(check.body.kind).toBe('deviation');
    expect((await drv.d.call('api', 'GET', `/v1/trips/${tripId}/safety-checks/pending`)).body).toBeNull();
    expect((await p.d.call('api', 'POST', `/v1/trips/${tripId}/safety-checks/${check.body.id}`, { ok: true })).body.status).toBe('ok');
  });

  it('sin respuesta a tiempo se abre un incidente SOS automáticamente', async () => {
    const { drv, p, tripId } = await startedTrip(s);
    await p.d.call('api', 'PUT', '/v1/me/preferences', { deviationAlerts: 'always' });
    await s.redis.del(`safety:trip:${tripId}`);
    await driveAway(drv);
    await waitFor(() => p.d.call('api', 'GET', `/v1/trips/${tripId}/safety-checks/pending`), (r) => !!r.body?.id);
    const inc = await waitFor(() => s.pool.query(`SELECT opened_by_role FROM safety.incidents WHERE trip_id = $1`, [tripId]), (r) => r.rowCount === 1, 20000);
    expect(inc.rows[0].opened_by_role).toBe('system');
    expect((await s.pool.query('SELECT incident_hold FROM trips.trips WHERE id = $1', [tripId])).rows[0].incident_hold).toBe(true);
  }, 30000);
});
