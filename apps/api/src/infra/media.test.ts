import { describe, expect, it } from 'vitest';
import { mp4DurationMs, processMedia, stripJpegMetadata, stripPngMetadata } from './media.js';

const box = (type: string, body: Buffer) => {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
};
/** MP4 mínimo: ftyp + moov/mvhd (versión 0) con timescale y duración dados. */
function mp4(timescale: number, duration: number, version = 0) {
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isommp42', 'latin1'));
  let mvhd: Buffer;
  if (version === 0) {
    mvhd = Buffer.alloc(100);
    mvhd.writeUInt32BE(timescale, 12);
    mvhd.writeUInt32BE(duration, 16);
  } else {
    mvhd = Buffer.alloc(112);
    mvhd[0] = 1;
    mvhd.writeUInt32BE(timescale, 20);
    mvhd.writeBigUInt64BE(BigInt(duration), 24);
  }
  return Buffer.concat([ftyp, box('moov', box('mvhd', mvhd)), box('mdat', Buffer.alloc(64))]);
}

const jpegWithExif = () =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46]), // APP0 JFIF (se conserva)
    Buffer.from([0xff, 0xe1, 0x00, 0x0a]), Buffer.from('Exif\0GPS', 'latin1'), // APP1 EXIF con "GPS"
    Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0xaa, 0xbb, 0xff, 0xd9]),
  ]);

describe('duración MP4', () => {
  it('lee mvhd v0 y v1', () => {
    expect(mp4DurationMs(mp4(1000, 19_500))).toBe(19_500);
    expect(mp4DurationMs(mp4(44_100, 44_100 * 30, 1))).toBe(30_000);
    expect(mp4DurationMs(Buffer.from('basura'))).toBeNull();
  });
});

describe('processMedia', () => {
  it('video de hasta 20 s; más largo se rechaza', () => {
    expect(processMedia('video', 'video/mp4', mp4(600, 600 * 20))).toMatchObject({ ok: true, durationMs: 20_000 });
    expect(processMedia('video', 'video/mp4', mp4(600, 600 * 25))).toEqual({ ok: false, reason: 'too_long' });
  });
  it('nota de voz de hasta 60 s', () => {
    expect(processMedia('voice', 'audio/mp4', mp4(1000, 45_000))).toMatchObject({ ok: true, durationMs: 45_000 });
    expect(processMedia('voice', 'audio/mp4', mp4(1000, 90_000))).toMatchObject({ ok: false, reason: 'too_long' });
  });
  it('el tipo declarado debe coincidir con el contenido', () => {
    expect(processMedia('photo', 'image/jpeg', mp4(1, 1))).toEqual({ ok: false, reason: 'type_mismatch' });
    expect(processMedia('video', 'image/jpeg', jpegWithExif())).toEqual({ ok: false, reason: 'type_mismatch' });
    expect(processMedia('video', 'video/mp4', Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.alloc(8)]))).toEqual({ ok: false, reason: 'malformed' });
  });
  it('quita EXIF (GPS) de las fotos y conserva la imagen', () => {
    const r = processMedia('photo', 'image/jpeg', jpegWithExif());
    expect(r.ok).toBe(true);
    const out = (r as { data: Buffer }).data;
    expect(out.toString('latin1')).not.toContain('GPS');
    expect(out.toString('latin1')).toContain('JFIF');
    expect(out.subarray(-4)).toEqual(Buffer.from([0xaa, 0xbb, 0xff, 0xd9]));
    expect(stripJpegMetadata(out)).toEqual(out);
  });
  it('quita texto/EXIF de PNG', () => {
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
    };
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', Buffer.alloc(13)), chunk('tEXt', Buffer.from('Location\0Guayaquil')), chunk('IDAT', Buffer.alloc(5)), chunk('IEND', Buffer.alloc(0))]);
    const out = stripPngMetadata(png);
    expect(out.toString('latin1')).not.toContain('Guayaquil');
    expect(out.toString('latin1')).toContain('IDAT');
  });
  it('detecta la firma de prueba antimalware y el tamaño máximo', () => {
    const eicar = Buffer.concat([jpegWithExif(), Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')]);
    expect(processMedia('photo', 'image/jpeg', eicar)).toEqual({ ok: false, reason: 'malware' });
    expect(processMedia('photo', 'image/jpeg', Buffer.concat([jpegWithExif(), Buffer.alloc(6 * 1024 * 1024)]))).toEqual({ ok: false, reason: 'too_large' });
  });
});
