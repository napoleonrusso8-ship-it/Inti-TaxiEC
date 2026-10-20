import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSession, completedTrip, freshIdentity, requestTrip, startedTrip } from '../src/flows.js';
import { Stack } from '../src/stack.js';

const s = new Stack();
type Admin = Awaited<ReturnType<typeof adminSession>>;
let agentA: Admin;
let agentB: Admin;
let support: Admin;
let reviewer: Admin;
beforeAll(async () => {
  await s.start(['auth', 'api', 'realtime']);
  [agentA, agentB, support, reviewer] = (await Promise.all(['trust_safety', 'trust_safety', 'support', 'driver_reviewer'].map((r) => adminSession(s, r)))) as [Admin, Admin, Admin, Admin];
}, 120_000);
afterAll(() => s.stop());

const photo = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0xff, 0xd9]);
const zone = (i: number) => ({ lat: -2.12 - i * 0.02, lng: -79.93 });

async function sendPhoto(d: Awaited<ReturnType<typeof s.loggedIn>>['d'], tripId: string) {
  const u = await d.call('api', 'POST', `/v1/trips/${tripId}/chat/media`, { kind: 'photo', contentType: 'image/jpeg', size: photo().length });
  await d.upload(u.body.upload, photo(), 'image/jpeg');
  return (await d.call('api', 'POST', `/v1/trips/${tripId}/chat/media/${u.body.mediaId}/complete`)).body.mediaId as string;
}

describe('Reportes de malos tratos', () => {
  it('el pasajero reporta al conductor con pruebas del chat; el agente ve el expediente con motivo auditado', async () => {
    const { drv, p, tripId } = await startedTrip(s);
    const mediaId = await sendPhoto(p.d, tripId);
    await drv.d.call('api', 'POST', `/v1/driver/trips/${tripId}/complete`);
    const body = { category: 'discrimination', description: 'El conductor me insultó por mi forma de vestir durante todo el viaje.', evidenceMediaIds: [mediaId] };
    const stranger = await s.loggedIn();
    expect((await stranger.d.call('api', 'POST', `/v1/trips/${tripId}/reports`, body)).status).toBe(404);
    const r = await p.d.call('api', 'POST', `/v1/trips/${tripId}/reports`, body);
    expect(r.status).toBe(201);
    expect((await p.d.call('api', 'POST', `/v1/trips/${tripId}/reports`, body)).body.title).toBe('report_exists');
    // Las pruebas quedan retenidas aunque pase el plazo de 30 días.
    expect((await s.pool.query('SELECT legal_hold FROM trips.chat_media WHERE id = $1', [mediaId])).rows[0].legal_hold).toBe(true);

    expect((await support.web.call('api', 'GET', '/v1/admin/reports')).status).toBe(403);
    const list = await agentA.web.call('api', 'GET', '/v1/admin/reports?status=open');
    expect(list.body.find((x: { id: string }) => x.id === r.body.id)).toMatchObject({ priority: 'high', evidenceCount: 1, reportedRole: 'driver' });
    const detail = await agentA.web.call('api', 'GET', `/v1/admin/reports/${r.body.id}?reason=${encodeURIComponent('Revisión del caso')}`);
    expect(detail.body.description).toBe(body.description);
    expect(detail.body.chat.some((m: { kind?: string }) => m.kind === 'photo')).toBe(true);
    expect(detail.body.evidence[0]).toMatchObject({ mediaId, selectedByReporter: true });
    expect(detail.body.reported.vehicle.plate).toBe(drv.plate);
    const audit = await s.pool.query(`SELECT purpose FROM audit.audit_log WHERE action = 'report.view' AND resource_id = $1`, [r.body.id]);
    expect(audit.rows[0].purpose).toBe('trust_investigation');
  });

  it('debido proceso: no se sanciona sin contactar al reportado; la suspensión desconecta al conductor y se puede revocar', async () => {
    const { drv, p, trip } = await completedTrip(s, { at: zone(1), reviewer: reviewer.web });
    const r = await p.d.call('api', 'POST', `/v1/trips/${trip.body.id}/reports`, { category: 'mistreatment', description: 'Me gritó y me obligó a bajarme antes del destino.' });
    await agentA.web.call('api', 'POST', `/v1/admin/reports/${r.body.id}/assign`);
    const early = await agentA.web.call('api', 'POST', `/v1/admin/reports/${r.body.id}/decision`, { decision: 'suspension', days: 7, resolution: 'Mal trato comprobado con testigos' });
    expect(early.body.title).toBe('contact_required');
    await agentA.web.call('api', 'POST', `/v1/admin/reports/${r.body.id}/actions`, { action: 'contact_reported', note: 'Llamada al conductor: reconoce el incidente' });
    await drv.d.call('api', 'POST', '/v1/driver/online', { vehicleId: drv.vehicleId, location: zone(1) });
    const d = await agentA.web.call('api', 'POST', `/v1/admin/reports/${r.body.id}/decision`, { decision: 'suspension', days: 7, resolution: 'Mal trato comprobado: suspensión de 7 días' });
    expect(d.body).toMatchObject({ status: 'resolved', sanction: { status: 'active' } });
    expect(await s.redis.zscore('drivers:available', drv.userId)).toBeNull();
    const again = await drv.d.call('api', 'POST', '/v1/driver/online', { vehicleId: drv.vehicleId, location: zone(1) });
    expect(again.status).toBe(403);
    expect(again.body.detail).toContain('suspendida');
    expect((await s.inbox()).some((m) => m.text.includes('suspendida temporalmente'))).toBe(true);
    // Apelación aceptada: vuelve a trabajar.
    await agentB.web.call('api', 'POST', `/v1/admin/sanctions/${d.body.sanction.id}/revoke`, { reason: 'Apelación aceptada: nueva evidencia' });
    await freshIdentity(s, drv.d, drv.doc);
    expect((await drv.d.call('api', 'POST', '/v1/driver/online', { vehicleId: drv.vehicleId, location: zone(1) })).status).toBe(200);
  });

  it('el conductor reporta al pasajero: un pasajero suspendido no puede pedir viajes', async () => {
    const { drv, p, trip } = await completedTrip(s, { at: zone(2), reviewer: reviewer.web });
    const r = await drv.d.call('api', 'POST', `/v1/trips/${trip.body.id}/reports`, { category: 'threats', description: 'El pasajero me amenazó con un arma blanca al pedirle el pago.' });
    expect(r.status).toBe(201);
    await agentA.web.call('api', 'POST', `/v1/admin/reports/${r.body.id}/actions`, { action: 'contact_reported', note: 'Llamada al pasajero: no responde; se envió correo' });
    await agentA.web.call('api', 'POST', `/v1/admin/reports/${r.body.id}/decision`, { decision: 'suspension', days: 30, resolution: 'Amenaza comprobada con video del chat' });
    const t = await requestTrip(p.d, {}, zone(2));
    expect(t.status).toBe(403);
    expect(t.body.title).toBe('account_suspended');
  });

  it('la expulsión exige la aprobación de otra persona', async () => {
    const { drv, p, trip } = await completedTrip(s, { at: zone(3), reviewer: reviewer.web });
    const r = await p.d.call('api', 'POST', `/v1/trips/${trip.body.id}/reports`, { category: 'harassment', description: 'Acoso con mensajes y comentarios inapropiados durante el viaje.' });
    await agentA.web.call('api', 'POST', `/v1/admin/reports/${r.body.id}/actions`, { action: 'contact_reported', note: 'Contacto con el conductor por llamada' });
    const d = await agentA.web.call('api', 'POST', `/v1/admin/reports/${r.body.id}/decision`, { decision: 'ban', resolution: 'Acoso grave comprobado: se propone expulsión' });
    expect(d.body.sanction.status).toBe('pending_approval');
    expect((await agentA.web.call('api', 'POST', `/v1/admin/sanctions/${d.body.sanction.id}/approve`)).body.title).toBe('four_eyes');
    // Pendiente de aprobación todavía no bloquea.
    expect((await drv.d.call('api', 'POST', '/v1/driver/online', { vehicleId: drv.vehicleId, location: zone(3) })).status).toBe(200);
    expect((await agentB.web.call('api', 'POST', `/v1/admin/sanctions/${d.body.sanction.id}/approve`)).body.status).toBe('active');
    expect(await s.redis.zscore('drivers:available', drv.userId)).toBeNull();
    expect((await drv.d.call('api', 'POST', '/v1/driver/online', { vehicleId: drv.vehicleId, location: zone(3) })).body.detail).toContain('dada de baja');
  });
});
