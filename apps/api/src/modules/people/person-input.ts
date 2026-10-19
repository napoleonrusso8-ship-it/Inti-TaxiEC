import { isValidCedula, normalizeEmail, normalizePassport, normalizePersonName } from '@intitaxi/domain';
import { AppError } from '@intitaxi/nest-common';
import { z } from 'zod';

export const MAX_PARTY = 8;

export const PersonInput = z.object({
  givenNames: z.string().max(60),
  familyNames: z.string().max(60),
  idType: z.enum(['cedula', 'passport', 'none']),
  idNumber: z.string().max(20).optional(),
  idCountry: z.string().length(2).optional(),
  email: z.string().max(254).optional(),
  isMinor: z.boolean().default(false),
  /** Adulto responsable de un menor: "requester", "primary" o el índice de otro acompañante adulto. */
  guardian: z.union([z.literal('requester'), z.literal('primary'), z.number().int().min(0).max(MAX_PARTY)]).optional(),
});
export type PersonInput = z.infer<typeof PersonInput>;

export const ThirdPartyInput = PersonInput.extend({
  idType: z.enum(['cedula', 'passport']),
  phone: z.string().regex(/^\+?[0-9 ()-]{8,20}$/),
  email: z.string().max(254),
  isMinor: z.literal(false).default(false),
});

export const PartyInput = z.object({
  companions: z.array(PersonInput).max(MAX_PARTY - 1).default([]),
  savedCompanionIds: z.array(z.string().uuid()).max(MAX_PARTY - 1).default([]),
  forThirdParty: ThirdPartyInput.optional(),
});

export interface NormalizedPerson {
  givenNames: string;
  familyNames: string;
  idType: 'cedula' | 'passport' | 'none';
  idNumber: string | null;
  idCountry: string | null;
  email: string | null;
  phone?: string | null;
  isMinor: boolean;
  guardian?: PersonInput['guardian'];
}

/** Validación estricta de una persona registrada (cédula por módulo 10, correo, nombres). */
export function normalizePerson(p: PersonInput & { phone?: string }, where: string): NormalizedPerson {
  const bad = (msg: string) => new AppError(400, 'invalid_person', `${where}: ${msg}`);
  const givenNames = normalizePersonName(p.givenNames);
  const familyNames = normalizePersonName(p.familyNames);
  if (!givenNames || !familyNames) throw bad('nombres o apellidos inválidos');
  let idNumber: string | null = null;
  if (p.idType === 'cedula') {
    if (!p.idNumber || !isValidCedula(p.idNumber)) throw bad('cédula inválida (dígito verificador)');
    idNumber = p.idNumber;
  } else if (p.idType === 'passport') {
    idNumber = p.idNumber ? normalizePassport(p.idNumber) : null;
    if (!idNumber || !p.idCountry) throw bad('pasaporte y país requeridos');
  } else if (!p.isMinor) {
    throw bad('los adultos deben registrar cédula o pasaporte');
  }
  let email: string | null = null;
  if (p.email) {
    email = normalizeEmail(p.email);
    if (!email) throw bad('correo inválido');
  } else if (!p.isMinor) {
    throw bad('el correo es obligatorio para adultos');
  }
  if (p.isMinor && p.guardian === undefined) throw bad('un menor debe tener un adulto responsable');
  let phone: string | null = null;
  if (p.phone) {
    const digits = p.phone.replace(/[^\d+]/g, '');
    phone = digits.startsWith('+') ? digits : digits.startsWith('0') ? `+593${digits.slice(1)}` : `+${digits}`;
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw bad('teléfono inválido');
  }
  return { givenNames, familyNames, idType: p.idType, idNumber, idCountry: p.idType === 'cedula' ? 'EC' : p.idCountry?.toUpperCase() ?? null, email, phone, isMinor: p.isMinor, guardian: p.guardian };
}
