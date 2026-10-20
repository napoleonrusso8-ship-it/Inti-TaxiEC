import { isValidCedula } from '@intitaxi/domain';
import type { Person } from '@intitaxi/mobile-core';

export interface PersonDraft {
  givenNames: string;
  familyNames: string;
  idType: 'cedula' | 'passport';
  idNumber: string;
  email: string;
  phone: string;
  isMinor: boolean;
}

export const emptyPerson = (): PersonDraft => ({ givenNames: '', familyNames: '', idType: 'cedula', idNumber: '', email: '', phone: '', isMinor: false });

/** Validación local (el servidor vuelve a validar todo): cédula ecuatoriana módulo 10 y correo. */
export function personProblem(p: PersonDraft, opts: { needsPhone?: boolean } = {}): string | null {
  if (p.givenNames.trim().length < 2 || p.familyNames.trim().length < 2) return 'Escribe nombres y apellidos';
  if (p.idType === 'cedula' && !isValidCedula(p.idNumber.trim())) return 'La cédula no es válida';
  if (p.idType === 'passport' && p.idNumber.trim().length < 5) return 'El pasaporte no es válido';
  if (!p.isMinor && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email.trim())) return 'El correo no es válido';
  if (opts.needsPhone && !/^09\d{8}$/.test(p.phone.trim())) return 'El celular debe tener 10 dígitos (09…)';
  return null;
}

export function toPerson(p: PersonDraft): Person {
  return {
    givenNames: p.givenNames.trim(),
    familyNames: p.familyNames.trim(),
    idType: p.idType,
    idNumber: p.idNumber.trim(),
    email: p.isMinor ? undefined : p.email.trim(),
    phone: p.phone.trim() || undefined,
    isMinor: p.isMinor,
  };
}
