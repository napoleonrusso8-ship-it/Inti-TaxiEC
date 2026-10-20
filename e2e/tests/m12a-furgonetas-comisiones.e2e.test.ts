import { fareAt, type FareRule } from '@intitaxi/domain';
import { validCedula } from '@intitaxi/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSession, approvedDriver, completedTrip, freshIdentity, submittedDriver, waitFor } from '../src/flows.js';
import { Stack } from '../src/stack.js';

const s = new Stack();
type Admin = Awaited<ReturnType<typeof adminSession>>;
let reviewer: Admin;
let managerA: Admin;
let managerB: Admin;
let superAdmin: Admin;
let r1: { id: string; stops: { id: string; lat: number; lng: number }[] };

const balance = async (account: string) => Number((await s.pool.query('SELECT coalesce(sum(credit_cents - debit_cents), 0) AS b FROM payments.ledger_entries WHERE account = $1', [account])).rows[0].b);
const VAN: FareRule[] = [
  { id: 'd', name: 'Diurna', startLocal: '06:30', endLocal: '21:00', amountCents: 280, validFrom: '2000-01-01', validTo: null, priority: 0 },
  { id: 'n', name: 'Nocturna', startLocal: '21:00', endLocal: '06:30', amountCents: 380, validFrom: '2000-01-01', validTo: null, priority: 0 },
];

beforeAll(async () => {
  await s.start(['auth', 'api']);
  [reviewer, managerA, managerB, superAdmin] = (await Promise.all(['driver_reviewer', 'route_manager', 'route_manager', 'super_admin'].map((r) => adminSession(s, r)))) as [Admin, Admin, Admin, Admin];
  // Publica la Ruta 1 sembrada (con tarifas de taxi y furgoneta) siguiendo el flujo real del panel.
  const id = (await s.pool.query(`SELECT id FROM fixed_routes.routes WHERE code = 'R1'`)).rows[0].id;
  await managerA.web.call('api', 'POST', `/v1/admin/routes/${id}/validate`);
  await managerA.web.call('api', 'POST', `/v1/admin/routes/${id}/publish-request`);
  const ok = await managerB.web.call('api', 'POST', `/v1/admin/routes/${id}/publish-decision`, { approve: true });
  if (ok.status !== 200) throw new Error(`publish ${ok.status} ${JSON.stringify(ok.body)}`);
  const d = await managerA.web.call('api', 'GET', `/v1/admin/routes/${id}`);
  r1 = { id, stops: d.body.directions.find((x: { direction: string }) => x.direction === 'outbound').stops };
}, 120_000);
afterAll(() => s.stop());

describe('Registro de furgonetas', () => {
  it('asientos según el tipo: taxi 1–4, furgoneta 5–15', async () => {
    const drv = await verifiedDriverApplicant();
    const add = (seats: number, vehicleType: string) => drv.d.call('api', 'POST', '/v1/driver/vehicles', { plate: `GZ${String.fromCharCode(65 + Math.floor(Math.random() * 26))}-${1000 + Math.floor(Math.random() * 8999)}`, make: 'Hyundai', model: 'H1', year: 2022, color: 'Blanco', seats, vehicleType });
    expect((await add(6, 'taxi')).body.title).toBe('invalid_seats');
    expect((await add(3, 'van')).body.title).toBe('invalid_seats');
    expect((await add(12, 'van')).status).toBe(201);
  });

  it('el revisor debe confirmar los asientos de la matrícula; si no coinciden, no se aprueba', async () => {
    const drv = await submittedDriver(s, 10, 'van');
    const detail = await reviewer.web.call('api', 'GET', `/v1/admin/drivers/${drv.userId}`);
    const reg = detail.body.documents.find((d: { type: string }) => d.type === 'registration');
    const path = `/v1/admin/drivers/${drv.userId}/documents/${reg.id}/review`;
    expect((await reviewer.web.call('api', 'POST', path, { decision: 'approved' })).body.title).toBe('seats_confirmation_required');
    expect((await reviewer.web.call('api', 'POST', path, { decision: 'approved', confirmedSeats: 8 })).body.title).toBe('seats_mismatch');
    expect((await reviewer.web.call('api', 'POST', path, { decision: 'approved', confirmedSeats: 10 })).status).toBe(200);
    const v = await s.pool.query('SELECT seats_verified_by FROM drivers.vehicles WHERE driver_id = $1', [drv.userId]);
    expect(v.rows[0].seats_verified_by).toBe(reviewer.userId);
  });
});

describe('Furgonetas en Taxi Ruta', () => {
  it('se listan junto a los taxis con su tarifa por persona ($2.80 / $3.80); se fija al subir; comisión $2.50 por recorrido', async () => {
    const drv = await approvedDriver(s, reviewer.web, 10, 'van');
    await freshIdentity(s, drv.d, drv.doc);
    await managerA.web.call('api', 'POST', `/v1/admin/routes/${r1.id}/drivers`, { driverId: drv.userId });
    await drv.d.call('api', 'POST', '/v1/driver/online', { vehicleId: drv.vehicleId, location: { lat: r1.stops[0]!.lat, lng: r1.stops[0]!.lng } });
    const inst = await drv.d.call('api', 'POST', `/v1/driver/routes/${r1.id}/instances`, { direction: 'outbound', vehicleId: drv.vehicleId });
    expect(inst.body).toMatchObject({ vehicleType: 'van', seatsTotal: 10 });

    const p = await s.loggedIn();
    const list = await p.d.call('api', 'GET', '/v1/routes');
    const route = list.body.find((r: { id: string }) => r.id === r1.id);
    const expected = fareAt(VAN, new Date())!;
    expect(route.currentFares.van).toMatchObject({ amountCents: expected.amountCents, perPerson: true });
    const vehicles = await p.d.call('api', 'GET', `/v1/routes/${r1.id}/vehicles?direction=outbound&stopId=${r1.stops[1]!.id}`);
    const mine = vehicles.body.find((v: { instanceId: string }) => v.instanceId === inst.body.instanceId);
    expect(mine).toMatchObject({ vehicleType: 'van', vehicleLabel: 'Furgoneta', seatsAvailable: 10, currentUnitFareCents: expected.amountCents });

    const q = await p.d.call('api', 'POST', `/v1/routes/${r1.id}/quotes`, { direction: 'outbound', boardingStopId: r1.stops[1]!.id, alightingStopId: r1.stops[5]!.id, seats: 1, vehicleType: 'van' });
    expect(q.body.unitFareCents).toBe(expected.amountCents);
    const b = await p.d.call('api', 'POST', `/v1/routes/${r1.id}/bookings`, { instanceId: inst.body.instanceId, direction: 'outbound', boardingStopId: r1.stops[1]!.id, alightingStopId: r1.stops[5]!.id, seats: 1, paymentMethod: 'cash' });
    expect(b.status).toBe(201);
    expect(b.body.vehicleLabel).toBe('Furgoneta');
    const pin = (await p.d.call('api', 'GET', `/v1/trips/${b.body.tripId}/pin`)).body.pin;
    const board = await drv.d.call('api', 'POST', `/v1/driver/route-instances/${inst.body.instanceId}/board`, { bookingId: b.body.bookingId, pin });
    expect(board.body.fare).toMatchObject({ ruleName: expected.name, unitCents: expected.amountCents });
    await drv.d.call('api', 'POST', `/v1/driver/route-instances/${inst.body.instanceId}/alight`, { bookingId: b.body.bookingId });

    // El pasajero pagó la tarifa completa al conductor (sin comisión por pasajero)…
    const pay = await waitFor(() => s.pool.query('SELECT amount_cents FROM payments.payments WHERE trip_id = $1', [b.body.tripId]), (r) => r.rowCount === 1);
    expect(pay.rows[0].amount_cents).toBe(expected.amountCents);
    expect(await balance(`driver_payable:${drv.userId}`)).toBe(0);
    // …y al terminar el recorrido la plataforma cobra el fijo de furgoneta.
    const fin = await drv.d.call('api', 'POST', `/v1/driver/route-instances/${inst.body.instanceId}/finish`);
    expect(fin.body.platformFeeCents).toBe(250);
    expect(await balance(`driver_payable:${drv.userId}`)).toBe(-250);
    expect((await drv.d.call('api', 'POST', `/v1/driver/route-instances/${inst.body.instanceId}/finish`)).status).toBe(409);
    expect(await balance(`driver_payable:${drv.userId}`)).toBe(-250);
  });

  it('un recorrido en taxi cobra $0.90 y uno sin pasajeros no cobra nada', async () => {
    const drv = await approvedDriver(s, reviewer.web);
    await freshIdentity(s, drv.d, drv.doc);
    await managerA.web.call('api', 'POST', `/v1/admin/routes/${r1.id}/drivers`, { driverId: drv.userId });
    await drv.d.call('api', 'POST', '/v1/driver/online', { vehicleId: drv.vehicleId, location: { lat: r1.stops[0]!.lat, lng: r1.stops[0]!.lng } });
    const empty = await drv.d.call('api', 'POST', `/v1/driver/routes/${r1.id}/instances`, { direction: 'outbound', vehicleId: drv.vehicleId });
    expect((await drv.d.call('api', 'POST', `/v1/driver/route-instances/${empty.body.instanceId}/finish`)).body.platformFeeCents).toBe(0);
    const inst = await drv.d.call('api', 'POST', `/v1/driver/routes/${r1.id}/instances`, { direction: 'outbound', vehicleId: drv.vehicleId });
    const p = await s.loggedIn();
    const b = await p.d.call('api', 'POST', `/v1/routes/${r1.id}/bookings`, { instanceId: inst.body.instanceId, direction: 'outbound', boardingStopId: r1.stops[1]!.id, alightingStopId: r1.stops[3]!.id, seats: 1, paymentMethod: 'cash' });
    const pin = (await p.d.call('api', 'GET', `/v1/trips/${b.body.tripId}/pin`)).body.pin;
    await drv.d.call('api', 'POST', `/v1/driver/route-instances/${inst.body.instanceId}/board`, { bookingId: b.body.bookingId, pin });
    await drv.d.call('api', 'POST', `/v1/driver/route-instances/${inst.body.instanceId}/alight`, { bookingId: b.body.bookingId });
    expect((await drv.d.call('api', 'POST', `/v1/driver/route-instances/${inst.body.instanceId}/finish`)).body.platformFeeCents).toBe(90);
  });

  it('las furgonetas no reciben viajes bajo demanda', async () => {
    await s.redis.del('drivers:available');
    const van = await approvedDriver(s, reviewer.web, 10, 'van');
    await freshIdentity(s, van.d, van.doc);
    await van.d.call('api', 'POST', '/v1/driver/online', { vehicleId: van.vehicleId, location: { lat: -2.1547, lng: -79.8929 } });
    const p = await s.loggedIn();
    const q = await p.d.call('api', 'POST', '/v1/trips/quotes', { origin: { lat: -2.1547, lng: -79.8929 }, destination: { lat: -2.1939, lng: -79.8803 } });
    const t = await p.d.call('api', 'POST', '/v1/trips', { quoteId: q.body.quoteId, paymentMethod: 'cash' }, { headers: { 'Idempotency-Key': `van-${Date.now()}-xxxxxxxxxx` } });
    await new Promise((r) => setTimeout(r, 1500));
    expect((await van.d.call('api', 'GET', '/v1/driver/offers')).body.some((o: { tripId: string }) => o.tripId === t.body.id)).toBe(false);
  });
});

describe('Comisiones', () => {
  it('viaje bajo demanda: 9 % de la tarifa base', async () => {
    const { drv, trip } = await completedTrip(s, { at: { lat: -2.12, lng: -79.94 }, reviewer: reviewer.web });
    const pay = await waitFor(() => s.pool.query('SELECT amount_cents FROM payments.payments WHERE trip_id = $1', [trip.body.id]), (r) => r.rowCount === 1);
    expect(await balance(`driver_payable:${drv.userId}`)).toBe(-Math.round(pay.rows[0].amount_cents * 0.09));
  });

  it('solo super_admin las cambia, con límites y auditoría', async () => {
    expect((await managerA.web.call('api', 'PUT', '/v1/admin/commissions', { on_demand_bps: 100 })).status).toBe(403);
    expect((await superAdmin.web.call('api', 'PUT', '/v1/admin/commissions', { on_demand_bps: 9000 })).status).toBe(400);
    const r = await superAdmin.web.call('api', 'PUT', '/v1/admin/commissions', { route_fee_van_cents: 260 });
    expect(r.body).toMatchObject({ on_demand_bps: 900, route_fee_taxi_cents: 90, route_fee_van_cents: 260 });
    await superAdmin.web.call('api', 'PUT', '/v1/admin/commissions', { route_fee_van_cents: 250 });
    const audit = await s.pool.query(`SELECT metadata FROM audit.audit_log WHERE action = 'commission.update' ORDER BY seq`);
    expect(audit.rows.map((x) => x.metadata.route_fee_van_cents)).toEqual([260, 250]);
  });
});

/** Conductor con KYC y solicitud iniciada (sin vehículo). */
async function verifiedDriverApplicant() {
  const { verifiedUser } = await import('../src/flows.js');
  const u = await verifiedUser(s, 'driver', validCedula());
  await u.d.call('api', 'POST', '/v1/driver/application', { licenseNumber: `L${u.doc}`, licenseCategory: 'C', licenseExpiresOn: '2029-12-31' });
  return u;
}
