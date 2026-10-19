import type { AuthContext } from '@intitaxi/auth-verifier';
import type { Request } from 'express';

export interface AttestedDevice {
  deviceId: string;
  platform: 'android' | 'ios';
  jkt: string;
}

/** Petición enriquecida por los middlewares y guards. */
export type AppRequest = Request & {
  requestId: string;
  auth?: AuthContext;
  dpop?: { jkt: string };
  device?: AttestedDevice;
};

/** URL pública canónica del recurso pedido (para DPoP `htu`). Se construye con la configuración, nunca con la cabecera Host. */
export function publicUrl(baseUrl: string, req: Request): string {
  return new URL(req.originalUrl, baseUrl).toString();
}
