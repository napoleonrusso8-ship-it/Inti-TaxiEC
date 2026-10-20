import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSession, approvedDriver, completedTrip, freshIdentity, offerFor, onlineDriver, requestTrip, waitFor } from '../src/flows.js';
import { Stack } from '../src/stack.js';

const s = new Stack();
type Admin = Awaited<ReturnType<typeof adminSession>>;
let reviewer: Admin;
beforeAll(async () => {
  await s.start(['auth', 'api']);
  reviewer = await adminSession(s, 'driver_reviewer');
}, 120_000);
afterAll(() => s.stop());

const balance = async (account: string) => Number((await s.pool.query('SELECT coalesce(sum(credit_cents - debit_cents), 0) AS b FROM payments.ledger_entries WHERE account = $1', [account])).rows[0].b);
const zone = (i: number) => ({ lat: -2.11 - i * 0.02, lng: -79.96 });

describe('Reputación', () => {
  it('el pasajero califica con etiquetas; el perfil del conductor muestra viajes y solo las etiquetas positivas', async () => {
    const drv = await onlineDriver(s, zone(1), 4, reviewer.web);
    for (const [stars, tags] of [[5, ['amable', 'puntual']], [4, ['amable', 'llego_tarde']]] as const) {
      const { p, trip } = await completedTrip(s, { at: zone(1), driver: drv });
      expect((await p.d.call('api', 'POST', `/v1/trips/${trip.body.id}/rating`, { stars, tags })).status).toBe(201);
    }
    const p = await s.loggedIn();
    const t = await requestTrip(p.d, {}, zone(1));
    await drv.d.call('api', 'POST', `/v1/driver/offers/${await offerFor(drv.d, t.body.id)}/accept`);
    const view = await p.d.call('api', 'GET', `/v1/trips/${t.body.id}`);
    expect(view.body.driver).toMatchObject({ tripsCount: 2, rating: 4.5, ratingsCount: 2 });
    expect(view.body.driver.tags).toEqual([{ tag: 'amable', label: 'Amable', count: 2 }, { tag: 'puntual', label: 'Puntual', count: 1 }]);
    expect(view.body.reassignments).toEqual({ used: 0, max: 5 });
    // La persona calificada sí ve sus etiquetas de mejora (agregadas, sin saber quién).
    const fb = await drv.d.call('api', 'GET', '/v1/trips/me/feedback');
    expect(fb.body.find((x: { tag: string }) => x.tag === 'llego_tarde')).toMatchObject({ count: 1, positive: false });
    await p.d.call('api', 'POST', `/v1/trips/${t.body.id}/cancel`, {});
  });

  it('el conductor ve la calificación del pasajero en la oferta y en el viaje, y lo califica al terminar', async () => {
    const drv = await onlineDriver(s, zone(2), 4, reviewer.web);
    const { p, trip } = await completedTrip(s, { at: zone(2), driver: drv });
    expect((await drv.d.call('api', 'POST', `/v1/trips/${trip.body.id}/rating`, { stars: 5, tags: ['amable'] })).status).toBe(201);
    expect((await drv.d.call('api', 'POST', `/v1/trips/${trip.body.id}/rating`, { stars: 5 })).body.title).toBe('already_rated');
    // Etiqueta de otro rol: no permitida.
    const { p: p2, trip: t2 } = await completedTrip(s, { at: zone(2), driver: drv });
    expect((await drv.d.call('api', 'POST', `/v1/trips/${t2.body.id}/rating`, { stars: 4, tags: ['auto_limpio'] })).body.title).toBe('invalid_tag');
    void p2;

    const t = await requestTrip(p.d, {}, zone(2));
    const offers = await waitFor(() => drv.d.call('api', 'GET', '/v1/driver/offers'), (r) => r.body.some((o: { tripId: string }) => o.tripId === t.body.id));
    expect(offers.body.find((o: { tripId: string }) => o.tripId === t.body.id)).toMatchObject({ passengerRating: 5, passengerTrips: 1 });
    await drv.d.call('api', 'POST', `/v1/driver/offers/${await offerFor(drv.d, t.body.id)}/accept`);
    const view = await drv.d.call('api', 'GET', `/v1/trips/${t.body.id}`);
    expect(view.body.passenger).toMatchObject({ rating: 5, tripsCount: 1, tags: [{ tag: 'amable', label: 'Amable', count: 1 }] });
    await p.d.call('api', 'POST', `/v1/trips/${t.body.id}/cancel`, {});
  });
});

describe('Pedir otra unidad', () => {
  it('vuelve a buscar sin el conductor anterior; si ya había llegado, se le compensa', async () => {
    await s.redis.del('drivers:available');
    const a = await onlineDriver(s, zone(3), 4, reviewer.web);
    const p = await s.loggedIn();
    const t = await requestTrip(p.d, {}, zone(3));
    await a.d.call('api', 'POST', `/v1/driver/offers/${await offerFor(a.d, t.body.id)}/accept`);
    await a.d.call('api', 'POST', `/v1/driver/trips/${t.body.id}/arrived`);
    const b = await onlineDriver(s, zone(3), 4, reviewer.web);
    const r = await p.d.call('api', 'POST', `/v1/trips/${t.body.id}/reassign`, { reason: 'No me convence' });
    expect(r.body).toMatchObject({ status: 'matching', remainingReassignments: 4 });
    expect(await balance(`driver_payable:${a.userId}`)).toBe(100);
    // El conductor anterior quedó libre y no vuelve a recibir este viaje; el nuevo sí.
    expect((await a.d.call('api', 'GET', '/v1/driver/trips/current')).body).toBeNull();
    await b.d.call('api', 'POST', `/v1/driver/offers/${await offerFor(b.d, t.body.id, 10000)}/accept`);
    expect((await a.d.call('api', 'GET', '/v1/driver/offers')).body.some((o: { tripId: string }) => o.tripId === t.body.id)).toBe(false);
    const view = await p.d.call('api', 'GET', `/v1/trips/${t.body.id}`);
    expect(view.body).toMatchObject({ status: 'accepted', reassignments: { used: 1, max: 5 } });
    expect(view.body.driver.vehicle.plate).toBe(b.plate);
    // Antes de que llegue: sin compensación.
    await p.d.call('api', 'POST', `/v1/trips/${t.body.id}/reassign`, {});
    expect(await balance(`driver_payable:${b.userId}`)).toBe(0);
  });

  it('el sexto intento cierra la carrera; nadie más que el pasajero puede pedirlo', async () => {
    await s.redis.del('drivers:available');
    const a = await onlineDriver(s, zone(4), 4, reviewer.web);
    const p = await s.loggedIn();
    const t = await requestTrip(p.d, {}, zone(4));
    await a.d.call('api', 'POST', `/v1/driver/offers/${await offerFor(a.d, t.body.id)}/accept`);
    expect((await a.d.call('api', 'POST', `/v1/trips/${t.body.id}/reassign`, {})).status).toBe(404);
    await s.pool.query('UPDATE trips.trips SET reassign_count = 5 WHERE id = $1', [t.body.id]);
    const r = await p.d.call('api', 'POST', `/v1/trips/${t.body.id}/reassign`, {});
    expect(r.status).toBe(409);
    expect(r.body.title).toBe('max_reassignments');
    expect((await p.d.call('api', 'GET', `/v1/trips/${t.body.id}`)).body.status).toBe('cancelled');
    expect((await a.d.call('api', 'GET', '/v1/driver/trips/current')).body).toBeNull();
  });
});

describe('Taxi Ruta: cambiar de unidad', () => {
  it('mueve los asientos a otro vehículo (máx. 5) y muestra el perfil del nuevo conductor', async () => {
    const [managerA, managerB] = (await Promise.all([adminSession(s, 'route_manager'), adminSession(s, 'route_manager')])) as [Admin, Admin];
    const id = (await s.pool.query(`SELECT id FROM fixed_routes.routes WHERE code = 'R1'`)).rows[0].id;
    await managerA.web.call('api', 'POST', `/v1/admin/routes/${id}/validate`);
    await managerA.web.call('api', 'POST', `/v1/admin/routes/${id}/publish-request`);
    await managerB.web.call('api', 'POST', `/v1/admin/routes/${id}/publish-decision`, { approve: true });
    const stops = (await managerA.web.call('api', 'GET', `/v1/admin/routes/${id}`)).body.directions.find((d: { direction: string }) => d.direction === 'outbound').stops;
    const startUnit = async () => {
      const drv = await approvedDriver(s, reviewer.web);
      await freshIdentity(s, drv.d, drv.doc);
      await managerA.web.call('api', 'POST', `/v1/admin/routes/${id}/drivers`, { driverId: drv.userId });
      await drv.d.call('api', 'POST', '/v1/driver/online', { vehicleId: drv.vehicleId, location: { lat: stops[0].lat, lng: stops[0].lng } });
      const inst = await drv.d.call('api', 'POST', `/v1/driver/routes/${id}/instances`, { direction: 'outbound', vehicleId: drv.vehicleId });
      return { ...drv, instanceId: inst.body.instanceId as string };
    };
    const [u1, u2] = [await startUnit(), await startUnit()];
    const p = await s.loggedIn();
    const b = await p.d.call('api', 'POST', `/v1/routes/${id}/bookings`, { instanceId: u1.instanceId, direction: 'outbound', boardingStopId: stops[1].id, alightingStopId: stops[4].id, seats: 1, paymentMethod: 'cash' });
    expect(b.body.driver).toMatchObject({ identityVerified: true, tripsCount: 0 });
    const sw = await p.d.call('api', 'POST', `/v1/routes/bookings/${b.body.bookingId}/switch`, { instanceId: u2.instanceId });
    expect(sw.body).toMatchObject({ remainingSwitches: 4, vehicle: { plate: u2.plate }, switches: { used: 1, max: 5 } });
    // La reserva expone la ruta y la unidad actual para que la app ofrezca las otras unidades del mismo sentido.
    expect(sw.body.route).toMatchObject({ id, direction: 'outbound', instanceId: u2.instanceId, boardingStopId: stops[1].id });
    expect((await u1.d.call('api', 'GET', '/v1/driver/route-instances/current')).body.seatsTaken).toBe(0);
    expect((await u2.d.call('api', 'GET', '/v1/driver/route-instances/current')).body.seatsTaken).toBe(1);
    await s.pool.query('UPDATE fixed_routes.bookings SET switch_count = 5 WHERE id = $1', [b.body.bookingId]);
    const last = await p.d.call('api', 'POST', `/v1/routes/bookings/${b.body.bookingId}/switch`, { instanceId: u1.instanceId });
    expect(last.body.title).toBe('max_reassignments');
    expect((await p.d.call('api', 'GET', `/v1/routes/bookings/${b.body.bookingId}`)).body.status).toBe('cancelled');
    expect((await u2.d.call('api', 'GET', '/v1/driver/route-instances/current')).body.seatsTaken).toBe(0);
  });
});
