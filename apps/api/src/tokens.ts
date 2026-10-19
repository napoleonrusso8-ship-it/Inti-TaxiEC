export { BLIND_INDEX, EMAIL_SENDER, FIELD_CIPHER, PG_POOL, PUBLIC_BASE_URL, REDIS, SMS_SENDER } from '@intitaxi/nest-common';
export const CONFIG = Symbol('CONFIG');
export const KYC_PROVIDER = Symbol('KYC_PROVIDER');
/** Cifrador para leer contactos del esquema identity (contexto KMS del servicio auth, solo lectura). */
export const IDENTITY_CIPHER = Symbol('IDENTITY_CIPHER');
export const STORAGE = Symbol('STORAGE');
export const MAPS = Symbol('MAPS');
