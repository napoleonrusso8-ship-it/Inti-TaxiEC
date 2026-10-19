/** Enmascara un número de documento conservando los 2 primeros y 2 últimos caracteres: 09******23 */
export function maskDocument(value: string): string {
  const v = value.replace(/\s+/g, '');
  if (v.length <= 4) return '*'.repeat(v.length);
  return v.slice(0, 2) + '*'.repeat(v.length - 4) + v.slice(-2);
}

/** +593991234567 → +5939******67 */
export function maskPhone(e164: string): string {
  if (e164.length <= 7) return '*'.repeat(e164.length);
  return e164.slice(0, 5) + '*'.repeat(e164.length - 7) + e164.slice(-2);
}

/** juan.perez@correo.com → j*********@correo.com */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  return local[0] + '*'.repeat(Math.max(local.length - 1, 1)) + email.slice(at);
}
