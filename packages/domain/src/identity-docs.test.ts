import { describe, expect, it } from 'vitest';
import { isValidCedula, normalizePassport, normalizePersonName } from './identity-docs.js';

/** Calcula el dígito verificador para generar cédulas válidas de prueba. */
function withCheckDigit(nine: string) {
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let p = Number(nine[i]) * (i % 2 === 0 ? 2 : 1);
    if (p > 9) p -= 9;
    sum += p;
  }
  return nine + ((10 - (sum % 10)) % 10);
}

describe('isValidCedula', () => {
  it.each(['0912345675', '1710034065', withCheckDigit('093456789'), withCheckDigit('300000001')])('acepta %s', (c) => expect(isValidCedula(c)).toBe(true));
  it.each([
    ['dígito verificador incorrecto', '0912345678'],
    ['provincia 25', withCheckDigit('251234567')],
    ['provincia 00', withCheckDigit('001234567')],
    ['tercer dígito 6 (sociedad pública)', withCheckDigit('096234567')],
    ['9 dígitos', '091234567'],
    ['letras', '09123456A5'],
  ])('rechaza: %s', (_, c) => expect(isValidCedula(c)).toBe(false));
});

describe('normalizePassport / normalizePersonName', () => {
  it('normaliza pasaportes', () => expect(normalizePassport('ab 12345-6')).toBe('AB123456'));
  it('rechaza pasaportes inválidos', () => expect(normalizePassport('<script>')).toBeNull());
  it('acepta nombres con tildes, ñ y apóstrofo', () => expect(normalizePersonName("  María José  Ñañez O'Neil ")).toBe("María José Ñañez O'Neil"));
  it('rechaza nombres con símbolos o números', () => {
    expect(normalizePersonName('Ana<script>')).toBeNull();
    expect(normalizePersonName('Ana 2')).toBeNull();
  });
});
