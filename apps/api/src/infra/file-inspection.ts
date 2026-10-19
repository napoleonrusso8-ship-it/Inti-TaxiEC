/**
 * Inspección de archivos subidos por usuarios (documentos de conductores).
 * El tipo declarado debe coincidir con los "magic bytes"; los PDF con contenido activo se rechazan.
 */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
};

export const ALLOWED_CONTENT_TYPES = Object.keys(MAGIC);
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export type InspectionResult = { ok: true } | { ok: false; reason: 'type_mismatch' | 'active_content' | 'malware' | 'empty' };

/** Firma de prueba EICAR: permite comprobar el flujo antimalware sin malware real. */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export function inspectFile(contentType: string, data: Buffer): InspectionResult {
  if (data.length === 0) return { ok: false, reason: 'empty' };
  const check = MAGIC[contentType];
  if (!check || !check(data)) return { ok: false, reason: 'type_mismatch' };
  const text = data.toString('latin1');
  if (text.includes(EICAR)) return { ok: false, reason: 'malware' };
  if (contentType === 'application/pdf' && /\/(JavaScript|JS|Launch|EmbeddedFile|OpenAction|AA)\b/.test(text)) return { ok: false, reason: 'active_content' };
  return { ok: true };
}
