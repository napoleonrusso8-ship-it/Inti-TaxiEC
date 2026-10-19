import { describe, expect, it } from 'vitest';
import { redactPii } from './pii-filter.js';

describe('redactPii', () => {
  it('oculta teléfonos, correos y enlaces', () => {
    expect(redactPii('llámame al 099 123 4567 o +593991234567')).toBe('llámame al [número oculto] o [número oculto]');
    expect(redactPii('mi correo es ana.p@gmail.com')).toBe('mi correo es [correo oculto]');
    expect(redactPii('paga aquí https://evil.example/x')).toBe('paga aquí [enlace oculto]');
  });
  it('deja pasar mensajes normales', () => expect(redactPii('Estoy en la puerta 3, camiseta azul')).toBe('Estoy en la puerta 3, camiseta azul'));
});
