/**
 * Procesamiento de archivos del chat (sin dependencias nativas):
 *  - comprobar el tipo real por "magic bytes";
 *  - leer la duración de audio/video MP4 (caja mvhd) para imponer los límites (video 20 s, voz 60 s);
 *  - quitar metadatos de fotos (EXIF con GPS, modelo del teléfono…) antes de entregarlas.
 */

export type MediaKind = 'voice' | 'photo' | 'video';

export const MEDIA_RULES: Record<MediaKind, { contentTypes: string[]; maxBytes: number; maxDurationMs?: number }> = {
  voice: { contentTypes: ['audio/mp4'], maxBytes: 2 * 1024 * 1024, maxDurationMs: 60_000 },
  photo: { contentTypes: ['image/jpeg', 'image/png'], maxBytes: 5 * 1024 * 1024 },
  video: { contentTypes: ['video/mp4'], maxBytes: 15 * 1024 * 1024, maxDurationMs: 20_000 },
};

const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (b: Buffer) => b.length > 8 && b.subarray(0, 8).equals(PNG_SIG);
const isMp4 = (b: Buffer) => b.length > 12 && b.subarray(4, 8).toString('latin1') === 'ftyp';

export function matchesType(contentType: string, b: Buffer): boolean {
  if (contentType === 'image/jpeg') return isJpeg(b);
  if (contentType === 'image/png') return isPng(b);
  if (contentType === 'video/mp4' || contentType === 'audio/mp4') return isMp4(b);
  return false;
}

/** Recorre cajas ISO-BMFF: devuelve [inicio del contenido, fin] de la primera caja con ese tipo. */
function findBox(b: Buffer, type: string, start = 0, end = b.length): [number, number] | null {
  let off = start;
  while (off + 8 <= end) {
    let size = b.readUInt32BE(off);
    const t = b.subarray(off + 4, off + 8).toString('latin1');
    let header = 8;
    if (size === 1) {
      if (off + 16 > end) return null;
      size = Number(b.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) size = end - off;
    if (size < header || off + size > end) return null;
    if (t === type) return [off + header, off + size];
    off += size;
  }
  return null;
}

/** Duración en milisegundos de un MP4/M4A (caja moov/mvhd); null si el archivo está malformado. */
export function mp4DurationMs(b: Buffer): number | null {
  const moov = findBox(b, 'moov');
  if (!moov) return null;
  const mvhd = findBox(b, 'mvhd', moov[0], moov[1]);
  if (!mvhd) return null;
  const [o] = mvhd;
  const version = b[o];
  let timescale: number;
  let duration: number;
  if (version === 1) {
    if (o + 32 > mvhd[1]) return null;
    timescale = b.readUInt32BE(o + 20);
    duration = Number(b.readBigUInt64BE(o + 24));
  } else {
    if (o + 20 > mvhd[1]) return null;
    timescale = b.readUInt32BE(o + 12);
    duration = b.readUInt32BE(o + 16);
  }
  if (!timescale) return null;
  return Math.round((duration / timescale) * 1000);
}

/** JPEG sin segmentos APPn de metadatos (EXIF/XMP: GPS, modelo del teléfono) ni comentarios. */
export function stripJpegMetadata(b: Buffer): Buffer {
  const out: Buffer[] = [b.subarray(0, 2)];
  let off = 2;
  while (off + 4 <= b.length && b[off] === 0xff) {
    const marker = b[off + 1]!;
    // SOS (inicio de los datos de imagen): el resto se copia tal cual.
    if (marker === 0xda) break;
    const len = b.readUInt16BE(off + 2);
    const seg = b.subarray(off, off + 2 + len);
    // APP1..APP15 (EXIF, XMP, IPTC…) y COM se descartan; APP0 (JFIF) y los de la imagen se conservan.
    const drop = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!drop) out.push(seg);
    off += 2 + len;
  }
  out.push(b.subarray(off));
  return Buffer.concat(out);
}

/** PNG sin fragmentos de texto ni EXIF (tEXt, zTXt, iTXt, eXIf, tIME). */
export function stripPngMetadata(b: Buffer): Buffer {
  const out: Buffer[] = [b.subarray(0, 8)];
  let off = 8;
  while (off + 12 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = b.subarray(off + 4, off + 8).toString('latin1');
    const chunk = b.subarray(off, off + 12 + len);
    if (!['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'].includes(type)) out.push(chunk);
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}

export type MediaCheck = { ok: true; data: Buffer; durationMs: number | null } | { ok: false; reason: 'type_mismatch' | 'too_large' | 'too_long' | 'malformed' | 'malware' };

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** Valida y sanea un archivo del chat. Devuelve los bytes que se guardarán y entregarán. */
export function processMedia(kind: MediaKind, contentType: string, data: Buffer): MediaCheck {
  const rule = MEDIA_RULES[kind];
  if (!rule.contentTypes.includes(contentType) || !matchesType(contentType, data)) return { ok: false, reason: 'type_mismatch' };
  if (data.length > rule.maxBytes) return { ok: false, reason: 'too_large' };
  if (data.toString('latin1').includes(EICAR)) return { ok: false, reason: 'malware' };
  if (kind === 'photo') return { ok: true, data: contentType === 'image/jpeg' ? stripJpegMetadata(data) : stripPngMetadata(data), durationMs: null };
  const durationMs = mp4DurationMs(data);
  if (durationMs === null) return { ok: false, reason: 'malformed' };
  // Margen de 500 ms por redondeos del codificador.
  if (durationMs > rule.maxDurationMs! + 500) return { ok: false, reason: 'too_long' };
  return { ok: true, data, durationMs };
}
