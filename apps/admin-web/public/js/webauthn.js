// Conversión entre las opciones/respuestas JSON de WebAuthn (base64url) y la API del navegador.
import { base64url } from '/lib/auth-client/index.js';

const fromB64u = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const toB64u = (buf) => (buf ? base64url(new Uint8Array(buf)) : undefined);

export function toPublicKeyRequest(o) {
  return {
    challenge: fromB64u(o.challenge),
    rpId: o.rpId,
    timeout: o.timeout,
    userVerification: 'required',
    allowCredentials: (o.allowCredentials ?? []).map((c) => ({ type: 'public-key', id: fromB64u(c.id), transports: c.transports })),
  };
}

export function credentialToJSON(cred) {
  if (!cred) throw new Error('Inicio de sesión cancelado');
  const r = cred.response;
  return {
    id: cred.id,
    rawId: toB64u(cred.rawId),
    type: cred.type,
    response: { clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData), signature: toB64u(r.signature), userHandle: toB64u(r.userHandle) },
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
  };
}
