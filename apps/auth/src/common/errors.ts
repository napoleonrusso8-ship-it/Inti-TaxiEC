import type { ZodType } from 'zod';

/** Error de aplicación con estado HTTP y código estable. `detail` debe ser apto para el cliente (sin datos internos). */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(detail ?? code);
  }
}

/** Error con formato OAuth (RFC 6749 §5.2) para el endpoint de tokens. */
export class OAuthError extends Error {
  constructor(
    readonly error: 'invalid_request' | 'invalid_grant' | 'invalid_client' | 'unsupported_grant_type' | 'invalid_dpop_proof',
    readonly status = 400,
  ) {
    super(error);
  }
}

export function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    const fields = [...new Set(r.error.issues.map((i) => i.path.join('.') || '(cuerpo)'))].join(', ');
    throw new AppError(400, 'invalid_request', `Campos inválidos: ${fields}`);
  }
  return r.data;
}

export const tooManyRequests = (retryAfter: number) =>
  new AppError(429, 'rate_limited', 'Demasiados intentos. Intenta más tarde.', { 'Retry-After': String(retryAfter) });
