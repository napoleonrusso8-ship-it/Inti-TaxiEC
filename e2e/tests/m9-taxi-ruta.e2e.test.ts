import { fareAt, type FareRule } from '@intitaxi/domain';
import { validCedula } from '@intitaxi/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSession, approvedDriver, freshIdentity, waitFor } from '../src/flows.js';
import { Stack } from '../src/stack.js';

const s = new Stack();
type Admin = Awaited<ReturnType<typeof adminSession>>;
let managerA: Admin;
let managerB: Admin;
let reviewer: Admin;

// Ruta de prueba sobre la Av. Francisco de Orellana (no toca la Ruta 1 sembrada en borrador).
const STOPS = [
  { name: 'Parada A', lat: -2.1400, lng: -79.9000 },
  { name: 'Parada B', lat: -2.1500, lng: -79.8950 },
  { name: 'Parada C', lat: -2.1600, lng: -79.8900 },
  { name: 'Parada D', lat: -2.1700, lng: -79.8850 },
];
const DAY_NIGHT = [
  { name: 'Diurna', startLocal: '06:30', endLocal: '21:00', amountCents: 300 },
  { name: 'Nocturna', startLocal: '21:00', endLocal: '06:30', amountCents: 400 },
];
const adult = (n: string) => ({ givenNames: n, familyNames: 'Cedeño Paz', idType: 'cedula', idNumber: validCedula(), email: `${n.toLowerCase()}${Math.random().toString(36).slice(2, 7)}@correo.test`, isMinor: false });
const asRules = (list: typeof DAY_NIGHT): FareRule[] => list.map((r, i) => ({ id: String(i), ...r, validFrom: '2000-01-01', validTo: null, priority: 0 }));

let routeId: string;
let codeN = 100;
let stopIds: string[];

async function publishedRoute() {
  const code = `R${++codeN}`;
  const c = await managerA.web.call('api', 'POST', '/v1/admin/routes', { code, name: `Prueba ${code}`, corridor: 'Av. Francisco de Orellana' });
  if (c.status !== 201) throw new Error(`create ${c.status} ${JSON.stringify(c.body)}`);
  const id = c.body.id as string;
  const out = await managerA.web.call('api', 'PUT', `/v1/admin/routes/${id}/directions/outbound/stops`, { stops: STOPS });
  const ids = out.body.directions.find((d: { direction: string }) => d.direction === 'outbound').stops.map((x: { id: string }) => x.id);
  await managerA.web.call('api', 'PUT', `/v1/admin/routes/${id}/directions/inbound/stops`, { stops: [...STOPS].reverse().map((x, i) => ({ ...x, stopId: ids[STOPS.length - 1 - i] })) });
  await managerA.web.call('api', 'PUT', `/v1/admin/routes/${id}/fares`, { rules: DAY_NIGHT });
  await managerA.web.call('api', 'POST', `/v1/admin/routes/${id}/validate`);
  await managerA.web.call('api', 'POST', `/v1/admin/routes/${id}/publish-request`);
  const ok = await managerB.web.call('api', 'POST', `/v1/admin/routes/${id}/publish-decision`, { approve: true });
  if (ok.status !== 200) throw new Error(`publish ${ok.status} ${JSON.stringify(ok.body)}`);
  return { id, stopIds: ids as string[] };
}

/** Conductor habilitado en la ruta, conectado en la primera parada y con un recorrido de ida en servicio. */
async function routeDriver(at: { lat: number; lng: number } = STOPS[0]!, route = routeId, seats = 4) {
  const drv = await approvedDriver(s, reviewer.web, seats);
  await freshIdentity(s, drv.d, drv.doc);
  await managerA.web.call('api', 'POST', `/v1/admin/routes/${route}/drivers`, { driverId: drv.userId });
  await drv.d.call('api', 'POST', '/v1/driver/online', { vehicleId: drv.vehicleId, location: at });
  const inst = await drv.d.call('api', 'POST', `/v1/driver/routes/${route}/instances`, { direction: 'outbound', vehicleId: drv.vehicleId });
  if (inst.status !== 201) throw new Error(`instance ${inst.status} ${JSON.stringify(inst.body)}`);
  return { ...drv, instanceId: inst.body.instanceId as string };
}

const book = (d: Awaited<ReturnType<typeof s.loggedIn>>['d'], instanceId: string, extra: Record<string, unknown> = {}, route = routeId) =>
  d.call('api', 'POST', `/v1/routes/${route}/bookings`, { instanceId, direction: 'outbound', boardingStopId: stopIds[1], alightingStopId: stopIds[3], seats: 1, paymentMethod: 'cash', ...extra });

beforeAll(async () => {
  await s.start(['auth', 'api', 'sos']);
  [managerA, managerB, reviewer] = await Promise.all([adminSession(s, 'route_manager'), adminSession(s, 'route_manager'), adminSession(s, 'driver_reviewer')]);
  ({ id: routeId, stopIds } = await publishedRoute());
}, 120_000);
afterAll(() => s.stop());

describe('Gestión de rutas (panel)', () => {
  it('Ruta 1 está sembrada en borrador con el orden de la especificación y sus dos tarifas', async () => {
    const r = await s.pool.query(`SELECT id, status FROM fixed_routes.routes WHERE code = 'R1'`);
    expect(r.rows[0].status).toBe('draft');
    const d = await managerA.web.call('api', 'GET', `/v1/admin/routes/${r.rows[0].id}`);
    const out = d.body.directions.find((x: { direction: string }) => x.direction === 'outbound');
    expect(out.stops.map((x: { name: string }) => x.name)).toEqual(['Villa Bonita', 'San Marino', 'Mall del Sol', 'City Mall', 'Riocentro Norte', 'Mall del Río', 'Parque Centenario', '9 de Octubre', 'Vélez', 'Chile y Colón', 'Bahía – Castillo']);
    expect(out.stops.every((x: { locationVerified: boolean }) => !x.locationVerified)).toBe(true);
    expect(d.body.fares).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Diurna', from: '06:30', to: '21:00', amountCents: 300 }), expect.objectContaining({ name: 'Nocturna', from: '21:00', to: '06:30', amountCents: 400 })]));
    // Un borrador no es visible para pasajeros
    const p = await s.loggedIn();
    expect((await p.d.call('api', 'GET', `/v1/routes/${r.rows[0].id}`)).status).toBe(404);
  });

  it('tarifas con huecos se rechazan; publicar exige validación y una segunda persona', async () => {
    const c = await managerA.web.call('api', 'POST', '/v1/admin/routes', { code: `R${++codeN}`, name: 'Cuatro ojos' });
    const id = c.body.id;
    const gap = await managerA.web.call('api', 'PUT', `/v1/admin/routes/${id}/fares`, { rules: [{ name: 'Diurna', startLocal: '06:30', endLocal: '21:00', amountCents: 300 }] });
    expect(gap.status).toBe(400);
    expect(gap.body.detail).toContain('21:00–23:59');
    expect((await managerA.web.call('api', 'POST', `/v1/admin/routes/${id}/publish-request`)).status).toBe(409);
    await managerA.web.call('api', 'PUT', `/v1/admin/routes/${id}/directions/outbound/stops`, { stops: STOPS });
    await managerA.web.call('api', 'PUT', `/v1/admin/routes/${id}/directions/inbound/stops`, { stops: [...STOPS].reverse() });
    await managerA.web.call('api', 'PUT', `/v1/admin/routes/${id}/fares`, { rules: DAY_NIGHT });
    const v = await managerA.web.call('api', 'POST', `/v1/admin/routes/${id}/validate`);
    expect(v.body.ok).toBe(true);
    expect(v.body.directions.outbound.stopOrder.informative).toBe(true);
    expect(v.body.directions.outbound.warnings.join(' ')).toContain('sin confirmar');
    expect((await managerA.web.call('api', 'POST', `/v1/admin/routes/${id}/publish-request`)).status).toBe(200);
    const self = await managerA.web.call('api', 'POST', `/v1/admin/routes/${id}/publish-decision`, { approve: true });
    expect(self.status).toBe(403);
    expect(self.body.title).toBe('four_eyes');
    // Ruta pendiente de aprobación: no se edita
    expect((await managerB.web.call('api', 'PUT', `/v1/admin/routes/${id}/fares`, { rules: DAY_NIGHT })).status).toBe(409);
    expect((await managerB.web.call('api', 'POST', `/v1/admin/routes/${id}/publish-decision`, { approve: true })).body.status).toBe('active');
    const audit = await s.pool.query(`SELECT actor_user_id FROM audit.audit_log WHERE resource_id = $1 AND action IN ('route.publish_request', 'route.publish') ORDER BY seq`, [id]);
    expect(audit.rows.map((r) => r.actor_user_id)).toEqual([managerA.userId, managerB.userId]);
  });

  it('solo route_manager (o super_admin) gestiona rutas; un pasajero tampoco', async () => {
    expect((await reviewer.web.call('api', 'GET', '/v1/admin/routes')).status).toBe(403);
    const p = await s.loggedIn();
    expect((await p.d.call('api', 'GET', '/v1/admin/routes')).status).toBe(403);
  });
});

describe('Taxi Ruta: reserva, abordaje y cobro por persona', () => {
  it('lista la ruta activa con la tarifa vigente por persona y nota de hora de Guayaquil', async () => {
    const p = await s.loggedIn();
    const list = await p.d.call('api', 'GET', '/v1/routes');
    const r = list.body.find((x: { id: string }) => x.id === routeId);
    expect(r.currentFare).toMatchObject({ perPerson: true, amountCents: fareAt(asRules(DAY_NIGHT), new Date())!.amountCents });
    const d = await p.d.call('api', 'GET', `/v1/routes/${routeId}`);
    expect(d.body.timezone).toBe('America/Guayaquil');
    expect(d.body.directions).toHaveLength(2);
  });

  it('conductor no habilitado no puede iniciar recorrido', async () => {
    const drv = await approvedDriver(s, reviewer.web);
    await freshIdentity(s, drv.d, drv.doc);
    await drv.d.call('api', 'POST', '/v1/driver/online', { vehicleId: drv.vehicleId, location: STOPS[0] });
    const r = await drv.d.call('api', 'POST', `/v1/driver/routes/${routeId}/instances`, { direction: 'outbound', vehicleId: drv.vehicleId });
    expect(r.status).toBe(403);
    expect(r.body.title).toBe('not_enabled');
  });

  it('vehículos con asientos libres y ETA; parada de bajada antes de la de subida se rechaza', async () => {
    const drv = await routeDriver();
    const p = await s.loggedIn();
    const v = await p.d.call('api', 'GET', `/v1/routes/${routeId}/vehicles?direction=outbound&stopId=${stopIds[1]}`);
    const mine = v.body.find((x: { instanceId: string }) => x.instanceId === drv.instanceId);
    expect(mine.seatsAvailable).toBe(4);
    expect(mine.etaSeconds).toBeGreaterThan(0);
    expect(mine.vehicle.plate).toBe(drv.plate);
    const bad = await p.d.call('api', 'POST', `/v1/routes/${routeId}/quotes`, { direction: 'outbound', boardingStopId: stopIds[3], alightingStopId: stopIds[1], seats: 1 });
    expect(bad.body.title).toBe('invalid_stop_order');
    const q = await p.d.call('api', 'POST', `/v1/routes/${routeId}/quotes`, { direction: 'outbound', boardingStopId: stopIds[1], alightingStopId: stopIds[3], seats: 2 });
    expect(q.body).toMatchObject({ estimated: true, totalCents: q.body.unitFareCents * 2 });
    // El conductor está en servicio de ruta: no recibe viajes bajo demanda
    expect((await drv.d.call('api', 'GET', '/v1/driver/trips/current')).body).toEqual({ routeInstanceId: drv.instanceId });
  });

  it('cada asiento es una persona registrada; los asientos no se sobrevenden en paralelo', async () => {
    const drv = await routeDriver();
    const p1 = await s.loggedIn();
    const mismatch = await book(p1.d, drv.instanceId, { seats: 2 });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.title).toBe('party_mismatch');
    const [p2, p3] = await Promise.all([s.loggedIn(), s.loggedIn()]);
    const three = (n: string) => ({ seats: 3, companions: [adult(`${n}a`), adult(`${n}b`)] });
    const results = await Promise.all([book(p2.d, drv.instanceId, three('Ana')), book(p3.d, drv.instanceId, three('Leo'))]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.title).toBe('not_enough_seats');
    const parties = await s.pool.query(`SELECT count(*)::int AS n FROM trips.trip_parties WHERE trip_id = $1 AND role <> 'requester'`, [results.find((r) => r.status === 201)!.body.tripId]);
    expect(parties.rows[0].n).toBe(3);
    const inst = await drv.d.call('api', 'GET', '/v1/driver/route-instances/current');
    expect(inst.body.seatsTaken).toBe(3);
  });

  it('PIN al subir; la tarifa se FIJA al abordar con la hora de Guayaquil; recibo por persona; manifiesto', async () => {
    const drv = await routeDriver();
    const p = await s.loggedIn();
    const b = await book(p.d, drv.instanceId, { seats: 2, companions: [adult('Rita')] });
    expect(b.status).toBe(201);
    expect(b.body.fare).toMatchObject({ final: false });
    const pin = (await p.d.call('api', 'GET', `/v1/trips/${b.body.tripId}/pin`)).body.pin;
    const wrong = await drv.d.call('api', 'POST', `/v1/driver/route-instances/${drv.instanceId}/board`, { bookingId: b.body.bookingId, pin: pin === '0000' ? '1111' : '0000' });
    expect(wrong.body.title).toBe('invalid_pin');
    const before = new Date();
    const board = await drv.d.call('api', 'POST', `/v1/driver/route-instances/${drv.instanceId}/board`, { bookingId: b.body.bookingId, pin });
    expect(board.status).toBe(200);
    const expected = fareAt(asRules(DAY_NIGHT), before)!;
    expect(board.body.fare).toMatchObject({ ruleName: expected.name, unitCents: expected.amountCents, totalCents: expected.amountCents * 2 });
    const view = await p.d.call('api', 'GET', `/v1/routes/bookings/${b.body.bookingId}`);
    expect(view.body.fare).toMatchObject({ final: true, ruleName: expected.name });
    await waitFor(() => s.pool.query(`SELECT 1 FROM safety.trip_manifests WHERE trip_id = $1 AND reason = 'start'`, [b.body.tripId]), (r) => r.rowCount === 1);
    // Con pasajeros a bordo no se termina el recorrido
    expect((await drv.d.call('api', 'POST', `/v1/driver/route-instances/${drv.instanceId}/finish`)).body.title).toBe('passengers_on_board');
    await drv.d.call('api', 'POST', '/v1/driver/location', { location: STOPS[2] });
    expect((await drv.d.call('api', 'POST', `/v1/driver/route-instances/${drv.instanceId}/alight`, { bookingId: b.body.bookingId })).status).toBe(200);
    const receipt = await waitFor(() => p.d.call('api', 'GET', `/v1/trips/${b.body.tripId}/receipt`), (r) => r.status === 200);
    expect(receipt.body.route).toMatchObject({ fareRule: expected.name, unitFareCents: expected.amountCents, seats: 2, boardingStop: 'Parada B', alightingStop: 'Parada D', fareFixedAt: 'boarding' });
    expect(receipt.body.amount.totalCents).toBe(expected.amountCents * 2);
    expect(receipt.body.payment.method).toBe('cash');
    const fin = await drv.d.call('api', 'POST', `/v1/driver/route-instances/${drv.instanceId}/finish`);
    expect(fin.body.status).toBe('finished');
  });

  it('la tarifa NO es la de la reserva: si cambia antes de subir, se cobra la vigente al abordar', async () => {
    const drv = await routeDriver();
    const p = await s.loggedIn();
    const b = await book(p.d, drv.instanceId);
    const estimated = b.body.fare.estimatedUnitCents;
    // Cambio de tarifa (pausa → editar → publicar con cuatro ojos)
    await managerA.web.call('api', 'POST', `/v1/admin/routes/${routeId}/pause`, { reason: 'Ajuste tarifario de prueba' });
    expect((await p.d.call('api', 'GET', `/v1/routes/${routeId}`)).status).toBe(404);
    await managerA.web.call('api', 'PUT', `/v1/admin/routes/${routeId}/fares`, { rules: [{ name: 'Única', startLocal: '00:00', endLocal: '23:59', amountCents: 500 }, { name: 'Cierre', startLocal: '23:59', endLocal: '00:00', amountCents: 500 }] });
    await managerA.web.call('api', 'POST', `/v1/admin/routes/${routeId}/publish-request`);
    expect((await managerB.web.call('api', 'POST', `/v1/admin/routes/${routeId}/publish-decision`, { approve: true })).body.status).toBe('active');
    const pin = (await p.d.call('api', 'GET', `/v1/trips/${b.body.tripId}/pin`)).body.pin;
    const board = await drv.d.call('api', 'POST', `/v1/driver/route-instances/${drv.instanceId}/board`, { bookingId: b.body.bookingId, pin });
    expect(estimated).not.toBe(500);
    expect(board.body.fare.unitCents).toBe(500);
    // Restablece las franjas diurna/nocturna para el resto de pruebas
    await managerA.web.call('api', 'POST', `/v1/admin/routes/${routeId}/pause`, { reason: 'Restablecer' });
    await managerA.web.call('api', 'PUT', `/v1/admin/routes/${routeId}/fares`, { rules: DAY_NIGHT });
    await managerA.web.call('api', 'POST', `/v1/admin/routes/${routeId}/publish-request`);
    await managerB.web.call('api', 'POST', `/v1/admin/routes/${routeId}/publish-decision`, { approve: true });
  });

  it('cancelar libera los asientos; una reserva ajena no se ve', async () => {
    const drv = await routeDriver();
    const p = await s.loggedIn();
    const b = await book(p.d, drv.instanceId);
    const other = await s.loggedIn();
    expect((await other.d.call('api', 'GET', `/v1/routes/bookings/${b.body.bookingId}`)).status).toBe(404);
    expect((await other.d.call('api', 'POST', `/v1/routes/bookings/${b.body.bookingId}/cancel`)).status).toBe(404);
    expect((await p.d.call('api', 'POST', `/v1/routes/bookings/${b.body.bookingId}/cancel`)).body.status).toBe('cancelled');
    expect((await drv.d.call('api', 'GET', '/v1/driver/route-instances/current')).body.seatsTaken).toBe(0);
  });

  it('un vehículo que ya pasó la parada no acepta la reserva', async () => {
    const drv = await routeDriver(STOPS[2]);
    const p = await s.loggedIn();
    const r = await book(p.d, drv.instanceId);
    expect(r.status).toBe(409);
    expect(r.body.title).toBe('stop_passed');
  });

  it('el SOS funciona igual en Taxi Ruta (manifiesto del pasajero)', async () => {
    const drv = await routeDriver();
    const p = await s.loggedIn();
    const b = await book(p.d, drv.instanceId);
    const pin = (await p.d.call('api', 'GET', `/v1/trips/${b.body.tripId}/pin`)).body.pin;
    await drv.d.call('api', 'POST', `/v1/driver/route-instances/${drv.instanceId}/board`, { bookingId: b.body.bookingId, pin });
    const sos = await p.d.call('sos', 'POST', '/v1/sos', { tripId: b.body.tripId, location: STOPS[2] });
    expect(sos.status).toBe(201);
    expect(sos.body.call).toBe('tel:911');
  });
});
