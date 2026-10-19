import { createHash } from 'node:crypto';
import { deflateSync as zDeflate } from 'node:zlib';

/** Archivos de prueba mínimos y válidos (o deliberadamente maliciosos) para las subidas. */
function crc32(buf: Buffer) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** PNG válido de 1×1 px. */
export function tinyPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zDeflate(Buffer.from([0, 0xe3, 0x9b, 0x1b]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function tinyPdf(withJavascript = false): Buffer {
  const js = withJavascript ? '/OpenAction << /S /JavaScript /JS (app.alert(1)) >>' : '';
  return Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog ${js} >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
}

/** Archivo de prueba antivirus estándar (no es malware real). */
export function eicarAsPng(): Buffer {
  return Buffer.concat([tinyPng(), Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')]);
}

export const sha256Hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

