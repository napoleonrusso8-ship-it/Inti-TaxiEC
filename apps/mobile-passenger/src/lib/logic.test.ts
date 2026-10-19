import { describe, expect, it } from 'vitest';
import { emptyPerson, personProblem, toPerson } from './people';
import { MiniSearchParams, MiniURL } from './url-polyfill';

const valid = { ...emptyPerson(), givenNames: 'Ana', familyNames: 'Paz Mora', idNumber: '1710034065', email: 'ana@correo.ec' };

describe('validación local de personas', () => {
  it('acepta una cédula válida y rechaza una inválida', () => {
    expect(personProblem(valid)).toBeNull();
    expect(personProblem({ ...valid, idNumber: '1710034066' })).toMatch(/cédula/);
  });
  it('el menor no necesita correo; el pasajero de un tercero sí necesita celular', () => {
    expect(personProblem({ ...valid, email: '', isMinor: true })).toBeNull();
    expect(personProblem({ ...valid, email: '' })).toMatch(/correo/);
    expect(personProblem(valid, { needsPhone: true })).toMatch(/celular/);
    expect(personProblem({ ...valid, phone: '0991234567' }, { needsPhone: true })).toBeNull();
  });
  it('no envía el correo de un menor', () => {
    expect(toPerson({ ...valid, isMinor: true }).email).toBeUndefined();
  });
});

describe('URL mínimo (Hermes)', () => {
  it('produce el htu de DPoP igual que el URL estándar', () => {
    for (const u of ['http://localhost:3001/v1/auth/otp/request', 'https://api.intitaxi.ec/v1/trips/abc?x=1#y', 'ws://10.0.2.2:3004/v1/ws']) {
      const a = new MiniURL(u);
      const b = new URL(u);
      expect(`${a.protocol}//${a.host}${a.pathname}`).toBe(`${b.protocol}//${b.host}${b.pathname}`);
      expect(a.origin).toBe(b.origin);
    }
    expect(() => new MiniURL('/relativa')).toThrow();
  });
  it('codifica formularios como URLSearchParams', () => {
    const form = { grant_type: 'refresh_token', refresh_token: 'a b+c/é', client_id: 'intitaxi-passenger' };
    expect(new MiniSearchParams(form).toString()).toBe(new URLSearchParams(form).toString());
  });
});
