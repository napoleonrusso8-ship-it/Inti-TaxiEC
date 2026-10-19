// Tokens de inyección de dependencias compartidos por todos los servicios.
export const PG_POOL = Symbol('PG_POOL');
export const REDIS = Symbol('REDIS');
export const FIELD_CIPHER = Symbol('FIELD_CIPHER');
export const BLIND_INDEX = Symbol('BLIND_INDEX');
export const SMS_SENDER = Symbol('SMS_SENDER');
export const EMAIL_SENDER = Symbol('EMAIL_SENDER');
export const PUBLIC_BASE_URL = Symbol('PUBLIC_BASE_URL');
export const INFRA_CONFIG = Symbol('INFRA_CONFIG');
