import { describe, expect, it } from 'vitest';
import { isValidCedula, normalizePassport, normalizePersonName, validRuc } from './identity-docs.js';

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

describe('validRuc', () => {
  it.each(['0990000000001', '1790012345001', '2400000000001', '3012345678001', ' 0912345678001 '])('acepta %s', (r) => expect(validRuc(r)).toBe(true));
  it.each([
    ['0990000000002', 'no termina en 001'],
    ['099000000001', '12 dígitos'],
    ['09900000000011', '14 dígitos'],
    ['2500000000001', 'provincia 25'],
    ['0000000000001', 'provincia 00'],
    ['3100000000001', 'provincia 31'],
    ['09900000A0001', 'con letras'],
    ['0990000000-001', 'con guion'],
    ['', 'vacío'],
  ])('rechaza %s (%s)', (r) => expect(validRuc(r)).toBe(false));
});
