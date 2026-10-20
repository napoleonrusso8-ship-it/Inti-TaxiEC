import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startedTrip } from '../src/flows.js';
import { Stack } from '../src/stack.js';

const s = new Stack();
beforeAll(async () => {
  await s.start(['auth', 'api', 'realtime']);
}, 120_000);
afterAll(() => s.stop());

const box = (type: string, body: Buffer) => {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
};
const mp4 = (seconds: number) => {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(seconds * 1000, 16);
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isommp42', 'latin1')), box('moov', box('mvhd', mvhd)), box('mdat', Buffer.alloc(256))]);
};
const photoWithGps = () =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46]),
    Buffer.from([0xff, 0xe1, 0x00, 0x14]), Buffer.from('Exif\0GPS-2.19,-79.88', 'latin1'),
    Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0xaa, 0xbb, 0xff, 0xd9]),
  ]);

type Dev = Awaited<ReturnType<typeof s.loggedIn>>['d'];
async function send(d: Dev, tripId: string, kind: string, contentType: string, data: Buffer) {
  const u = await d.call('api', 'POST', `/v1/trips/${tripId}/chat/media`, { kind, contentType, size: data.length });
  if (u.status !== 201) return u;
  await d.upload(u.body.upload, data, contentType);
  return d.call('api', 'POST', `/v1/trips/${tripId}/chat/media/${u.body.mediaId}/complete`);
}

describe('Chat multimedia', () => {
  it('foto sin GPS, nota de voz y video de hasta 20 s; el otro participante los recibe', async () => {
    const { drv, p, tripId } = await startedTrip(s);
    const photo = await send(p.d, tripId, 'photo', 'image/jpeg', photoWithGps());
    expect(photo.status).toBe(200);
    expect(photo.body).toMatchObject({ type: 'chat', from: 'passenger', kind: 'photo' });
    expect((await send(drv.d, tripId, 'voice', 'audio/mp4', mp4(40))).body).toMatchObject({ from: 'driver', kind: 'voice', durationMs: 40_000 });
    expect((await send(p.d, tripId, 'video', 'video/mp4', mp4(18))).body).toMatchObject({ kind: 'video', durationMs: 18_000 });

    const history = await drv.d.call('api', 'GET', `/v1/trips/${tripId}/chat`);
    expect(history.body.map((m: { kind: string }) => m.kind)).toEqual(['photo', 'voice', 'video']);
    const link = await drv.d.call('api', 'GET', `/v1/trips/${tripId}/chat/media/${photo.body.mediaId}`);
    expect(link.body.expiresIn).toBe(60);
    const bytes = Buffer.from(await (await fetch(link.body.url)).arrayBuffer());
    expect(bytes.toString('latin1')).not.toContain('GPS');
    expect(bytes.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  });

  it('rechaza videos de más de 20 s, archivos disfrazados y a quien no es del viaje', async () => {
    const { p, tripId } = await startedTrip(s);
    const long = await send(p.d, tripId, 'video', 'video/mp4', mp4(25));
    expect(long.status).toBe(422);
    expect(long.body.title).toBe('media_too_long');
    expect((await send(p.d, tripId, 'photo', 'image/jpeg', mp4(5))).body.title).toBe('media_type_mismatch');
    const stranger = await s.loggedIn();
    expect((await send(stranger.d, tripId, 'photo', 'image/jpeg', photoWithGps())).status).toBe(404);
    expect((await stranger.d.call('api', 'GET', `/v1/trips/${tripId}/chat`)).status).toBe(404);
  });

  it('se borra a los 30 días salvo que esté retenido como prueba', async () => {
    const { p, tripId } = await startedTrip(s);
    const a = await send(p.d, tripId, 'photo', 'image/jpeg', photoWithGps());
    const b = await send(p.d, tripId, 'photo', 'image/jpeg', photoWithGps());
    await s.pool.query(`UPDATE trips.chat_media SET expires_at = now() - interval '1 day' WHERE trip_id = $1`, [tripId]);
    await s.pool.query(`UPDATE trips.chat_media SET legal_hold = true WHERE id = $1`, [b.body.mediaId]);
    await fetch(`${s.urls.api}/v1/dev/retention/run`, { method: 'POST' });
    expect((await p.d.call('api', 'GET', `/v1/trips/${tripId}/chat/media/${a.body.mediaId}`)).status).toBe(404);
    expect((await p.d.call('api', 'GET', `/v1/trips/${tripId}/chat/media/${b.body.mediaId}`)).status).toBe(200);
  });

  it('el chat se cierra al terminar el viaje (el historial sigue visible)', async () => {
    const { drv, p, tripId } = await startedTrip(s);
    await drv.d.call('api', 'POST', `/v1/driver/trips/${tripId}/complete`);
    expect((await send(p.d, tripId, 'photo', 'image/jpeg', photoWithGps())).body.title).toBe('chat_closed');
    expect((await p.d.call('api', 'GET', `/v1/trips/${tripId}/chat`)).status).toBe(200);
  });
});
