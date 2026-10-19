/**
 * Normaliza y valida un correo de forma conservadora (sin intentar cubrir todo RFC 5322:
 * la validación real es el enlace de verificación).
 */
export function normalizeEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  if (email.length > 254) return null;
  const m = /^([a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64})@([a-z0-9-]+(\.[a-z0-9-]+)+)$/.exec(email);
  if (!m) return null;
  const [, local, domain] = m;
  if (local!.startsWith('.') || local!.endsWith('.') || local!.includes('..')) return null;
  if (domain!.split('.').some((l) => l.startsWith('-') || l.endsWith('-') || l.length > 63)) return null;
  return email;
}
