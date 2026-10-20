/**
 * Cédula ecuatoriana de persona natural: 10 dígitos, provincia 01–24 (o 30: ecuatorianos en el exterior),
 * tercer dígito < 6 y dígito verificador por módulo 10 con coeficientes 2,1,2,1,2,1,2,1,2.
 */
export function isValidCedula(input: string): boolean {
  const c = input.trim();
  if (!/^\d{10}$/.test(c)) return false;
  const province = Number(c.slice(0, 2));
  if (!((province >= 1 && province <= 24) || province === 30)) return false;
  if (Number(c[2]) >= 6) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let p = Number(c[i]) * (i % 2 === 0 ? 2 : 1);
    if (p > 9) p -= 9;
    sum += p;
  }
  return (10 - (sum % 10)) % 10 === Number(c[9]);
}

/** Pasaporte: 5–15 caracteres alfanuméricos (los formatos varían por país; se valida forma, no existencia). */
export function normalizePassport(input: string): string | null {
  const p = input.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z0-9]{5,15}$/.test(p) ? p : null;
}

/** Nombres: letras (incluidas tildes y ñ), espacios, apóstrofo y guion; 1–60 caracteres. */
export function normalizePersonName(input: string): string | null {
  const n = input.trim().replace(/\s+/g, ' ');
  return /^[\p{L}][\p{L} '’-]{0,59}$/u.test(n) ? n : null;
}

/**
 * RUC de Ecuador (forma): 13 dígitos, provincia 01–24 (o 30) en los dos primeros y establecimiento "001" al final.
 * No comprueba el dígito verificador ni que el contribuyente exista o esté activo en el SRI: eso lo verifica
 * una persona del equipo con el certificado del RUC (documento `company_ruc`).
 */
export function validRuc(input: string): boolean {
  const r = input.trim();
  if (!/^\d{13}$/.test(r) || !r.endsWith('001')) return false;
  const province = Number(r.slice(0, 2));
  return (province >= 1 && province <= 24) || province === 30;
}
