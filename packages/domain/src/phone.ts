/**
 * Normaliza un número móvil ecuatoriano a E.164 (+5939XXXXXXXX).
 * Acepta "0991234567", "991234567", "593991234567", "+593 99 123 4567".
 * Solo se aceptan móviles (prefijo 9) porque el número se usa para OTP por SMS.
 * Devuelve null si el número no es válido.
 */
export function normalizeEcMobile(input: string): string | null {
  const digits = input.replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(digits)) return null;
  let national: string;
  if (digits.startsWith('+593')) national = digits.slice(4);
  else if (digits.startsWith('593') && digits.length === 12) national = digits.slice(3);
  else if (digits.startsWith('0')) national = digits.slice(1);
  else national = digits;
  if (!/^9\d{8}$/.test(national)) return null;
  return `+593${national}`;
}
