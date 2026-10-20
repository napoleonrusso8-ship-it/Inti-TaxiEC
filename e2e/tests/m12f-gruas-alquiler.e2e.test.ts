import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSession, approvedDriver, freshIdentity, requestTrip, verifiedUser } from '../src/flows.js';
import { Stack } from '../src/stack.js';

const s = new Stack();
let reviewer: Awaited<ReturnType<typeof adminSession>>['web'];
beforeAll(async () => {
  await s.start(['auth', 'api']);
  reviewer = (await adminSession(s, 'driver_reviewer')).web;
}, 120_000);
afterAll(() => s.stop());

const PICKUP = { lat: -2.1547, lng: -79.8929 };
const TALLER = { lat: -2.17, lng: -79.9 };
const balance = async (account: string) => Number((await s.pool.query('SELECT coalesce(sum(credit_cents - debit_cents), 0) AS b FROM payments.ledger_entries WHERE account = $1', [account])).rows[0].b);

async function towProvider() {
  const drv = await approvedDriver(s, reviewer, 2, 'tow');
  await freshIdentity(s, drv.d, drv.doc);
  const on = await drv.d.call('api', 'POST', '/v1/driver/online', { vehicleId: drv.vehicleId, location: { lat: PICKUP.lat + 0.01, lng: PICKUP.lng } });
  if (on.status !== 200) throw new Error(`online ${on.status} ${JSON.stringify(on.body)}`);
  return drv;
}
const towBody = (offerCents: number) => ({ kind: 'tow', pickup: PICKUP, destination: TALLER, pickupLabel: 'Av. Juan Tanca Marenco', destinationLabel: 'Taller Mecánico Norte', vehicleCategory: 'auto', problem: 'no_enciende', offerCents });

describe('Grúa: el usuario oferta y el primero que acepta gana', () => {
  it('precio sugerido, oferta con piso/techo, aceptación atómica, avance y comisión del 9 %', async () => {
    const [g1, g2] = [await towProvider(), await towProvider()];
    const p = await s.loggedIn();
    const sug = await p.d.call('api', 'POST', '/v1/assist/suggest', { kind: 'tow', pickup: PICKUP, destination: TALLER, vehicleCategory: 'auto' });
    expect(sug.body.minCents).toBeGreaterThan(0);
    expect((await p.d.call('api', 'POST', '/v1/assist/requests', towBody(Math.floor(sug.body.minCents * 0.3)))).body.title).toBe('offer_out_of_range');
    const offer = sug.body.minCents;
    const r = await p.d.call('api', 'POST', '/v1/assist/requests', towBody(offer));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'open', offerCents: offer });
    expect((await p.d.call('api', 'POST', '/v1/assist/requests', towBody(offer))).body.title).toBe('active_request_exists');
    // Subir la oferta (nunca bajarla).
    expect((await p.d.call('api', 'POST', `/v1/assist/requests/${r.body.id}/raise`, { offerCents: offer - 100 })).body.title).toBe('offer_must_increase');
    expect((await p.d.call('api', 'POST', `/v1/assist/requests/${r.body.id}/raise`, { offerCents: offer + 500 })).body.offerCents).toBe(offer + 500);

    // Los proveedores ven la zona aproximada, no la dirección exacta ni datos del cliente.
    const seen = await g1.d.call('api', 'GET', '/v1/provider/assist/requests?kind=tow');
    const item = seen.body.find((x: { id: string }) => x.id === r.body.id);
    expect(item).toMatchObject({ offerCents: offer + 500, vehicleCategory: 'auto', problem: 'no_enciende' });
    expect(item.pickupArea).toEqual({ lat: -2.155, lng: -79.893 });
    expect(JSON.stringify(item)).not.toContain('Tanca');

    const [a, b] = await Promise.all([g1, g2].map((g) => g.d.call('api', 'POST', `/v1/provider/assist/requests/${r.body.id}/accept`, { vehicleId: g.vehicleId })));
    expect([a!.status, b!.status].sort()).toEqual([200, 409]);
    const winner = a!.status === 200 ? g1 : g2;
    const view = await p.d.call('api', 'GET', `/v1/assist/requests/${r.body.id}`);
    expect(view.body).toMatchObject({ status: 'accepted', provider: { vehicle: { plate: winner.plate }, identityVerified: true } });
    expect((await s.inbox()).some((m) => m.text.includes('tu grúa va en camino'))).toBe(true);

    for (const step of ['arrived', 'in_progress', 'completed']) {
      expect((await winner.d.call('api', 'POST', `/v1/provider/assist/requests/${r.body.id}/${step}`)).body.status).toBe(step);
    }
    expect(await balance(`driver_payable:${winner.userId}`)).toBe(-Math.round((offer + 500) * 0.09));
    expect((await p.d.call('api', 'POST', `/v1/assist/requests/${r.body.id}/rating`, { stars: 5 })).body.rating).toBe(5);
  });

  it('las grúas no reciben viajes de taxi', async () => {
    await s.redis.del('drivers:available');
    const g = await towProvider();
    const p = await s.loggedIn();
    const t = await requestTrip(p.d, {}, { lat: PICKUP.lat + 0.01, lng: PICKUP.lng });
    await new Promise((r) => setTimeout(r, 1500));
    expect((await g.d.call('api', 'GET', '/v1/driver/offers')).body.some((o: { tripId: string }) => o.tripId === t.body.id)).toBe(false);
  });
});

describe('Alquiler de vehículos', () => {
  it('exige identidad verificada; solo lo ven proveedores con esa categoría', async () => {
    const plain = await s.loggedIn();
    const body = { kind: 'rental', pickup: PICKUP, pickupLabel: 'Hotel Oro Verde', vehicleCategory: 'suv', startDate: '2030-01-10', days: 3, offerCents: 15_000 };
    expect((await plain.d.call('api', 'POST', '/v1/assist/requests', body)).body.title).toBe('kyc_required');
    const u = await verifiedUser(s);
    const r = await u.d.call('api', 'POST', '/v1/assist/requests', body);
    expect(r.status).toBe(201);
    const autoOwner = await approvedDriver(s, reviewer, 5, 'rental', 'auto');
    expect((await autoOwner.d.call('api', 'GET', '/v1/provider/assist/requests?kind=rental')).body.some((x: { id: string }) => x.id === r.body.id)).toBe(false);
    expect((await autoOwner.d.call('api', 'POST', `/v1/provider/assist/requests/${r.body.id}/accept`, { vehicleId: autoOwner.vehicleId })).body.title).toBe('invalid_vehicle');
    const suvOwner = await approvedDriver(s, reviewer, 5, 'rental', 'suv');
    expect((await suvOwner.d.call('api', 'GET', '/v1/provider/assist/requests?kind=rental')).body.find((x: { id: string }) => x.id === r.body.id)).toMatchObject({ days: 3, vehicleCategory: 'suv' });
    const acc = await suvOwner.d.call('api', 'POST', `/v1/provider/assist/requests/${r.body.id}/accept`, { vehicleId: suvOwner.vehicleId });
    expect(acc.body).toMatchObject({ status: 'accepted', pickup: { label: 'Hotel Oro Verde' } });
    // Un vehículo de alquiler no se "conecta" para viajes.
    expect((await suvOwner.d.call('api', 'POST', '/v1/driver/online', { vehicleId: suvOwner.vehicleId, location: PICKUP })).body.title).toBe('not_drivable_service');
  });
});
