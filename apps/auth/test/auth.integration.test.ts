import { codeChallengeS256, createCodeVerifier } from '@intitaxi/auth-client';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BASE, CLIENT_ID, flushRedis, ORIGIN, startHarness, TestDevice, type Harness } from './harness.js';
import { SoftwareAuthenticator } from '@intitaxi/testkit';

let h: Harness;
let phoneSeq = 0;
/** Número de celular único por prueba: { local: '09…', e164: '+5939…' }. */
function newPhone() {
  phoneSeq += 1;
  const n = `9${String(10_000_000 + phoneSeq).padStart(8, '0')}`;
  return { local: `0${n}`, e164: `+593${n}` };
}

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await flushRedis();
});

describe('Atestación de la app', () => {
  it('rechaza dispositivos que fallan la atestación', async () => {
    const d = await TestDevice.create(h, false);
    const res = await d.attest((nonce) => `dev-fail:${nonce}`);
    expect(res.status).toBe(403);
    expect(res.body.title).toBe('attestation_failed');
  });

  it('no acepta un nonce emitido para otra clave DPoP', async () => {
    const a = await TestDevice.create(h, false);
    const b = await TestDevice.create(h, false);
    const n = await h.http.post('/v1/attestation/nonce').set('DPoP', await a.proof('POST', '/v1/attestation/nonce')).expect(200);
    const res = await h.http
      .post('/v1/attestation/verify')
      .set('DPoP', await b.proof('POST', '/v1/attestation/verify'))
      .send({ platform: 'android', appId: 'ec.intitaxi.passenger', nonce: n.body.nonce, token: `dev-ok:${n.body.nonce}` });
    expect(res.status).toBe(400);
  });

  it('exige ticket de atestación para pedir OTP', async () => {
    const d = await TestDevice.create(h);
    d.ticket = '';
    expect((await d.requestOtp(newPhone().local)).status).toBe(401);
  });

  it('no acepta el ticket de otro dispositivo (ligado a la clave DPoP)', async () => {
    const a = await TestDevice.create(h);
    const b = await TestDevice.create(h);
    b.ticket = a.ticket;
    expect((await b.requestOtp(newPhone().local)).status).toBe(401);
  });
});

describe('Política de integridad del dispositivo', () => {
  it('permite pasajeros con Android rooteado marcando el riesgo, pero bloquea conductores', async () => {
    const passenger = await TestDevice.create(h, false);
    expect((await passenger.attest((n) => `dev-basic:${n}`)).status).toBe(200);
    const driver = await TestDevice.create(h, false);
    driver.appId = 'ec.intitaxi.driver';
    expect((await driver.attest((n) => `dev-basic:${n}`)).status).toBe(403);
    const { rows } = await h.pool.query('SELECT attestation_flags FROM identity.devices WHERE id = $1', [passenger.deviceId]);
    expect(rows[0].attestation_flags).toContain('device_integrity_basic_only');
  });
});

describe('Registro e inicio de sesión con OTP', () => {
  it('emite tokens de acceso de 10 minutos', async () => {
    const d = await TestDevice.create(h);
    const p = newPhone();
    const r = await d.requestOtp(p.local);
    const { res, verifier } = await d.verifyOtp(r.body.challengeId, d.lastOtp(p.e164));
    const t = await d.exchange(res.body.code, verifier);
    expect(t.body.expires_in).toBe(600);
    const payload = JSON.parse(Buffer.from(t.body.access_token.split('.')[1], 'base64url').toString());
    expect(payload.exp - payload.iat).toBe(600);
  });

  it('registra, emite tokens DPoP y devuelve el perfil enmascarado', async () => {
    const p = newPhone();
    const d = await TestDevice.create(h);
    const r = await d.login(p.local, p.e164);
    expect(r.isNewUser).toBe(true);
    const me = await d.authed('get', '/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.phone).toBe(`${p.e164.slice(0, 5)}******${p.e164.slice(-2)}`);
    expect(JSON.stringify(me.body)).not.toContain(p.e164);
    expect(me.headers['cache-control']).toBe('no-store');

    const again = await TestDevice.create(h);
    expect((await again.login(p.local, p.e164)).isNewUser).toBe(false);
  });

  it('responde igual para números registrados y no registrados (anti-enumeración)', async () => {
    const known = newPhone();
    const d = await TestDevice.create(h);
    await d.login(known.local, known.e164);
    const a = await d.requestOtp(known.local);
    const b = await d.requestOtp(newPhone().local);
    expect(a.status).toBe(b.status);
    expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort());
  });

  it('rechaza números no móviles ecuatorianos', async () => {
    const d = await TestDevice.create(h);
    expect((await d.requestOtp('042123456')).status).toBe(400);
  });

  it('invalida el reto tras 5 intentos fallidos, aunque luego se envíe el código correcto', async () => {
    const p = newPhone();
    const d = await TestDevice.create(h);
    const r = await d.requestOtp(p.local);
    const good = d.lastOtp(p.e164);
    const bad = good === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) expect((await d.verifyOtp(r.body.challengeId, bad)).res.status).toBe(400);
    // 5.º fallo → bloqueo progresivo (15 min) del número
    expect((await d.verifyOtp(r.body.challengeId, bad)).res.status).toBe(400);
    const after = await d.verifyOtp(r.body.challengeId, good);
    expect(after.res.status).toBe(400);
    const blocked = await d.requestOtp(p.local);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(800);
  });

  it('limita el envío de OTP por número (3 cada 15 min)', async () => {
    const p = newPhone();
    const d = await TestDevice.create(h);
    for (let i = 0; i < 3; i++) expect((await d.requestOtp(p.local)).status).toBe(202);
    expect((await d.requestOtp(p.local)).status).toBe(429);
  });

  it('no permite verificar el OTP desde otro dispositivo', async () => {
    const p = newPhone();
    const a = await TestDevice.create(h);
    const b = await TestDevice.create(h);
    const r = await a.requestOtp(p.local);
    expect((await b.verifyOtp(r.body.challengeId, a.lastOtp(p.e164))).res.status).toBe(400);
  });
});

describe('Código de autorización y PKCE', () => {
  async function codeFor(d: TestDevice) {
    const p = newPhone();
    const r = await d.requestOtp(p.local);
    return d.verifyOtp(r.body.challengeId, d.lastOtp(p.e164));
  }

  it('el código es de un solo uso', async () => {
    const d = await TestDevice.create(h);
    const { res, verifier } = await codeFor(d);
    expect((await d.exchange(res.body.code, verifier)).status).toBe(200);
    const again = await d.exchange(res.body.code, verifier);
    expect(again.status).toBe(400);
    expect(again.body).toEqual({ error: 'invalid_grant' });
  });

  it('rechaza un code_verifier incorrecto', async () => {
    const d = await TestDevice.create(h);
    const { res } = await codeFor(d);
    expect((await d.exchange(res.body.code, createCodeVerifier())).body.error).toBe('invalid_grant');
  });

  it('rechaza el canje desde otra clave DPoP (código interceptado)', async () => {
    const d = await TestDevice.create(h);
    const attacker = await TestDevice.create(h);
    const { res, verifier } = await codeFor(d);
    expect((await attacker.exchange(res.body.code, verifier)).body.error).toBe('invalid_grant');
  });

  it('rechaza client_id desconocidos y grant types no soportados', async () => {
    const d = await TestDevice.create(h);
    const { res, verifier } = await codeFor(d);
    expect((await d.token({ grant_type: 'authorization_code', code: res.body.code, code_verifier: verifier, client_id: 'evil' })).status).toBe(401);
    expect((await d.token({ grant_type: 'password', username: 'a', password: 'b' })).body.error).toBe('unsupported_grant_type');
  });
});

describe('Tokens de acceso ligados a DPoP', () => {
  it('rechaza el token sin prueba DPoP, con esquema Bearer o usado desde otra clave', async () => {
    const d = await TestDevice.create(h);
    const p = newPhone();
    await d.login(p.local, p.e164);
    expect((await h.http.get('/v1/me').set('Authorization', `DPoP ${d.accessToken}`)).status).toBe(401);
    expect((await h.http.get('/v1/me').set('Authorization', `Bearer ${d.accessToken}`).set('DPoP', await d.proof('GET', '/v1/me', d.accessToken))).status).toBe(401);
    const thief = await TestDevice.create(h);
    const stolen = await h.http.get('/v1/me').set('Authorization', `DPoP ${d.accessToken}`).set('DPoP', await thief.proof('GET', '/v1/me', d.accessToken));
    expect(stolen.status).toBe(401);
    expect(stolen.headers['www-authenticate']).toContain('DPoP');
  });

  it('rechaza la repetición de una prueba DPoP', async () => {
    const d = await TestDevice.create(h);
    const p = newPhone();
    await d.login(p.local, p.e164);
    const proof = await d.proof('GET', '/v1/me', d.accessToken);
    expect((await h.http.get('/v1/me').set('Authorization', `DPoP ${d.accessToken}`).set('DPoP', proof)).status).toBe(200);
    expect((await h.http.get('/v1/me').set('Authorization', `DPoP ${d.accessToken}`).set('DPoP', proof)).status).toBe(401);
  });

  it('publica JWKS sin material privado', async () => {
    const res = await h.http.get('/jwks').expect(200);
    expect(res.body.keys[0]).toMatchObject({ kty: 'EC', alg: 'ES256', kid: 'test-1' });
    expect(res.body.keys[0].d).toBeUndefined();
  });
});

describe('Rotación de refresh tokens', () => {
  it('rota, y ante reutilización revoca toda la sesión', async () => {
    const d = await TestDevice.create(h);
    const p = newPhone();
    await d.login(p.local, p.e164);
    const first = d.refreshToken;
    expect((await d.refresh()).status).toBe(200);
    expect(d.refreshToken).not.toBe(first);
    const current = { at: d.accessToken, rt: d.refreshToken };

    // Un atacante reutiliza el refresh token ya rotado
    const reuse = await d.token({ grant_type: 'refresh_token', refresh_token: first, client_id: CLIENT_ID });
    expect(reuse.body.error).toBe('invalid_grant');
    // Toda la familia queda revocada: ni el token de acceso vigente ni el refresh vigente sirven
    expect((await d.authed('get', '/v1/me', undefined, current.at)).status).toBe(401);
    expect((await d.token({ grant_type: 'refresh_token', refresh_token: current.rt, client_id: CLIENT_ID })).body.error).toBe('invalid_grant');
    const { rows } = await h.pool.query(`SELECT revoke_reason FROM identity.sessions WHERE revoked_at IS NOT NULL ORDER BY revoked_at DESC LIMIT 1`);
    expect(rows[0].revoke_reason).toBe('refresh_token_reuse');
  });

  it('revoca la sesión si el refresh token se presenta con otra clave DPoP', async () => {
    const d = await TestDevice.create(h);
    const p = newPhone();
    await d.login(p.local, p.e164);
    const thief = await TestDevice.create(h);
    thief.refreshToken = d.refreshToken;
    expect((await thief.refresh()).body.error).toBe('invalid_grant');
    expect((await d.refresh()).body.error).toBe('invalid_grant');
  });

  it('no renueva tokens de cuentas suspendidas', async () => {
    const d = await TestDevice.create(h);
    const p = newPhone();
    await d.login(p.local, p.e164);
    const me = await d.authed('get', '/v1/me');
    await h.pool.query(`UPDATE identity.users SET status = 'suspended' WHERE id = $1`, [me.body.id]);
    expect((await d.refresh()).body.error).toBe('invalid_grant');
  });

  it('las renovaciones concurrentes con el mismo token solo producen una rotación válida', async () => {
    const d = await TestDevice.create(h);
    const p = newPhone();
    await d.login(p.local, p.e164);
    const rt = d.refreshToken;
    const results = await Promise.all([0, 1, 2].map(async () => d.token({ grant_type: 'refresh_token', refresh_token: rt, client_id: CLIENT_ID })));
    expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
  });
});

describe('Token exchange (RFC 8693): app única pasajero → socio', () => {
  const EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
  const AT_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
  const exchangeTo = (d: TestDevice, subject: string, clientId = 'intitaxi-driver') =>
    d.token({ grant_type: EXCHANGE, subject_token: subject, subject_token_type: AT_TYPE, client_id: clientId });
  const claims = (at: string) => JSON.parse(Buffer.from(at.split('.')[1]!, 'base64url').toString());

  async function passenger() {
    const d = await TestDevice.create(h);
    d.appId = 'ec.intitaxi.app';
    await d.attest();
    const p = newPhone();
    await d.login(p.local, p.e164);
    return d;
  }

  it('crea una sesión nueva del cliente socio en el mismo dispositivo, sin elevar acr/amr/auth_time', async () => {
    const d = await passenger();
    const before = claims(d.accessToken);
    const r = await exchangeTo(d, d.accessToken);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ token_type: 'DPoP', expires_in: 600 });
    expect(r.body.refresh_token).toBeTruthy();
    const after = claims(r.body.access_token);
    expect(after).toMatchObject({ sub: before.sub, did: before.did, client_id: 'intitaxi-driver', acr: before.acr, amr: before.amr, auth_time: before.auth_time, cnf: before.cnf });
    expect(after.sid).not.toBe(before.sid);
    // El nuevo token funciona con la misma clave DPoP y la sesión rota su refresh token como cualquier otra.
    expect((await d.authed('get', '/v1/me', undefined, r.body.access_token)).status).toBe(200);
    const rot = await d.token({ grant_type: 'refresh_token', refresh_token: r.body.refresh_token, client_id: 'intitaxi-driver' });
    expect(rot.status).toBe(200);
    const { rows } = await h.pool.query(`SELECT client_id, expires_at - created_at AS ttl FROM identity.sessions WHERE id = $1`, [after.sid]);
    expect(rows[0].client_id).toBe('intitaxi-driver');
    expect(rows[0].ttl.days).toBe(30);
    const audit = await h.pool.query(`SELECT metadata FROM audit.audit_log WHERE action = 'session.client_switch' AND outcome = 'success' AND resource_id = $1`, [after.sid]);
    expect(audit.rows[0].metadata).toMatchObject({ from: 'intitaxi-passenger', to: 'intitaxi-driver' });
  });

  it('rechaza el canje con otra clave DPoP (token robado)', async () => {
    const d = await passenger();
    const thief = await TestDevice.create(h);
    expect((await exchangeTo(thief, d.accessToken)).body.error).toBe('invalid_grant');
  });

  it('rechaza sesiones revocadas, usuarios suspendidos y tokens que no emitió este servidor', async () => {
    const d = await passenger();
    const at = d.accessToken;
    expect((await d.authed('post', '/v1/auth/logout')).status).toBeLessThan(300);
    expect((await exchangeTo(d, at)).body.error).toBe('invalid_grant');
    const e = await passenger();
    const me = await e.authed('get', '/v1/me');
    await h.pool.query(`UPDATE identity.users SET status = 'suspended' WHERE id = $1`, [me.body.id]);
    expect((await exchangeTo(e, e.accessToken)).body.error).toBe('invalid_grant');
    const forged = await e.signJws({ sub: me.body.id, sid: 'x', cnf: { jkt: 'x' } });
    expect((await exchangeTo(e, forged)).body.error).toBe('invalid_grant');
  });

  it('solo entre clientes móviles distintos', async () => {
    const d = await passenger();
    expect((await exchangeTo(d, d.accessToken, 'intitaxi-passenger')).body.error).toBe('invalid_target');
    expect((await exchangeTo(d, d.accessToken, 'intitaxi-admin')).body.error).toBe('invalid_target');
    expect((await exchangeTo(d, d.accessToken, 'evil')).status).toBe(401);
    expect((await d.token({ grant_type: EXCHANGE, subject_token: d.accessToken, subject_token_type: 'urn:ietf:params:oauth:token-type:refresh_token', client_id: 'intitaxi-driver' })).body.error).toBe('invalid_request');
  });

  it('cambiar otra vez al mismo cliente cierra la sesión anterior de ese cliente en el dispositivo', async () => {
    const d = await passenger();
    const first = await exchangeTo(d, d.accessToken);
    const second = await exchangeTo(d, d.accessToken);
    expect(second.status).toBe(200);
    expect((await d.authed('get', '/v1/me', undefined, first.body.access_token)).status).toBe(401);
    expect((await d.authed('get', '/v1/me', undefined, second.body.access_token)).status).toBe(200);
  });

  it('limita los cambios de cliente por usuario', async () => {
    const d = await passenger();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await exchangeTo(d, d.accessToken)).status);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('se anuncia en los metadatos del servidor', async () => {
    const m = await h.http.get('/.well-known/oauth-authorization-server').expect(200);
    expect(m.body.grant_types_supported).toContain(EXCHANGE);
  });
});

describe('Sesiones y autorización a nivel de objeto', () => {
  it('un usuario no puede cerrar la sesión de otro (IDOR) y recibe 404', async () => {
    const alice = await TestDevice.create(h);
    const bob = await TestDevice.create(h);
    const pa = newPhone();
    const pb = newPhone();
    await alice.login(pa.local, pa.e164);
    await bob.login(pb.local, pb.e164);
    const aliceSession = (await alice.authed('get', '/v1/auth/sessions')).body[0].id;
    const res = await bob.authed('delete', `/v1/auth/sessions/${aliceSession}`);
    expect(res.status).toBe(404);
    expect((await alice.authed('get', '/v1/me')).status).toBe(200);
    const bobList = await bob.authed('get', '/v1/auth/sessions');
    expect(bobList.body.map((s: { id: string }) => s.id)).not.toContain(aliceSession);
  });

  it('logout invalida de inmediato el token de acceso', async () => {
    const d = await TestDevice.create(h);
    const p = newPhone();
    await d.login(p.local, p.e164);
    expect((await d.authed('post', '/v1/auth/logout')).status).toBe(204);
    expect((await d.authed('get', '/v1/me')).status).toBe(401);
    expect((await d.refresh()).body.error).toBe('invalid_grant');
  });
});

describe('Correo y protección contra SIM swapping', () => {
  async function verifiedUser() {
    const p = newPhone();
    const email = `u${phoneSeq}@correo.test`;
    const d = await TestDevice.create(h);
    await d.login(p.local, p.e164);
    expect((await d.authed('post', '/v1/me/email', { email })).status).toBe(202);
    const token = /#token=([A-Za-z0-9_-]+)/.exec(h.email.lastTo(email)!.text)![1]!;
    expect((await h.http.post('/v1/auth/email/verify').send({ token })).status).toBe(204);
    expect((await h.http.post('/v1/auth/email/verify').send({ token })).status).toBe(400);
    return { d, p, email };
  }

  it('verifica el correo con un enlace de un solo uso', async () => {
    const { d } = await verifiedUser();
    expect((await d.authed('get', '/v1/me')).body.emailVerified).toBe(true);
  });

  it('no revela si un correo ya pertenece a otra cuenta y avisa al dueño', async () => {
    const { email } = await verifiedUser();
    const other = await TestDevice.create(h);
    const p = newPhone();
    await other.login(p.local, p.e164);
    const before = h.email.sent.length;
    expect((await other.authed('post', '/v1/me/email', { email })).status).toBe(202);
    expect(h.email.sent.slice(before)[0]!.subject).toContain('Intento de uso');
  });

  it('un login solo con SMS en un dispositivo nuevo bloquea operaciones sensibles 72 h y avisa por correo', async () => {
    const { p, email } = await verifiedUser();
    const newPhoneDevice = await TestDevice.create(h);
    await newPhoneDevice.login(p.local, p.e164);
    const me = await newPhoneDevice.authed('get', '/v1/me');
    const hours = (new Date(me.body.sensitiveOpsLockedUntil).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(71);
    expect(h.email.lastTo(email)!.subject).toBe('Nuevo inicio de sesión en Inti Taxi');
  });
});

describe('Inicio de sesión biométrico con clave del dispositivo', () => {
  it('registra la clave y permite iniciar sesión firmando un reto', async () => {
    const d = await TestDevice.create(h);
    const p = newPhone();
    await d.login(p.local, p.e164);
    const bio = await generateKeyPair('ES256');
    const reg = await d.authed('post', '/v1/auth/device-keys', { publicJwk: await exportJWK(bio.publicKey) });
    expect(reg.status).toBe(201);

    const chal = await d.pre('/v1/auth/device-keys/challenge', {});
    const verifier = createCodeVerifier();
    const assertion = await d.signJws({ challenge: chal.body.challenge }, bio.privateKey as CryptoKey);
    const res = await d.pre('/v1/auth/device-keys/assert', {
      challengeId: chal.body.challengeId,
      credentialId: reg.body.credentialId,
      assertion,
      codeChallenge: await codeChallengeS256(verifier),
      codeChallengeMethod: 'S256',
    });
    expect(res.status).toBe(200);
    expect((await d.exchange(res.body.code, verifier)).status).toBe(200);
    expect((await d.authed('get', '/v1/me')).body.session.amr).toEqual(['hwk']);
  });

  it('rechaza firmas con otra clave y retos reutilizados', async () => {
    const d = await TestDevice.create(h);
    const p = newPhone();
    await d.login(p.local, p.e164);
    const bio = await generateKeyPair('ES256');
    const reg = await d.authed('post', '/v1/auth/device-keys', { publicJwk: await exportJWK(bio.publicKey) });
    const chal = await d.pre('/v1/auth/device-keys/challenge', {});
    const other = await generateKeyPair('ES256');
    const body = async (key: CryptoKey) => ({
      challengeId: chal.body.challengeId,
      credentialId: reg.body.credentialId,
      assertion: await d.signJws({ challenge: chal.body.challenge }, key),
      codeChallenge: await codeChallengeS256(createCodeVerifier()),
      codeChallengeMethod: 'S256',
    });
    expect((await d.pre('/v1/auth/device-keys/assert', await body(other.privateKey as CryptoKey))).status).toBe(400);
    // el reto ya se consumió en el intento anterior
    expect((await d.pre('/v1/auth/device-keys/assert', await body(bio.privateKey as CryptoKey))).status).toBe(400);
  });

  it('la clave solo funciona en el dispositivo donde se registró', async () => {
    const d = await TestDevice.create(h);
    const p = newPhone();
    await d.login(p.local, p.e164);
    const bio = await generateKeyPair('ES256');
    const reg = await d.authed('post', '/v1/auth/device-keys', { publicJwk: await exportJWK(bio.publicKey) });
    const other = await TestDevice.create(h);
    const chal = await other.pre('/v1/auth/device-keys/challenge', {});
    const res = await other.pre('/v1/auth/device-keys/assert', {
      challengeId: chal.body.challengeId,
      credentialId: reg.body.credentialId,
      assertion: await other.signJws({ challenge: chal.body.challenge }, bio.privateKey as CryptoKey),
      codeChallenge: await codeChallengeS256(createCodeVerifier()),
      codeChallengeMethod: 'S256',
    });
    expect(res.status).toBe(400);
  });
});

describe('Passkeys, step-up (MFA) y cambio de número', () => {
  async function userWithPasskey() {
    const p = newPhone();
    const d = await TestDevice.create(h);
    await d.login(p.local, p.e164);
    const auth = new SoftwareAuthenticator('intitaxi.test', ORIGIN);
    const opts = await d.authed('post', '/v1/auth/passkeys/registration/options');
    expect(opts.status).toBe(200);
    expect(opts.body.authenticatorSelection.userVerification).toBe('required');
    const reg = await d.authed('post', '/v1/auth/passkeys/registration/verify', auth.register(opts.body));
    expect(reg.status).toBe(201);
    return { d, p, auth };
  }

  it('inicia sesión con passkey (acr = MFA)', async () => {
    const { p, auth } = await userWithPasskey();
    const d2 = await TestDevice.create(h);
    const o = await d2.pre('/v1/auth/passkeys/authentication/options', {});
    const verifier = createCodeVerifier();
    const res = await d2.pre('/v1/auth/passkeys/authentication/verify', {
      flowId: o.body.flowId,
      response: auth.assert(o.body.options),
      codeChallenge: await codeChallengeS256(verifier),
      codeChallengeMethod: 'S256',
    });
    expect(res.status).toBe(200);
    await d2.exchange(res.body.code, verifier);
    const me = await d2.authed('get', '/v1/me');
    expect(me.body.session.acr).toBe('urn:intitaxi:acr:phr');
    expect(me.body.phone.endsWith(p.e164.slice(-2))).toBe(true);
  });

  it('rechaza aserciones sin verificación de usuario o con contador que retrocede', async () => {
    const { d, auth } = await userWithPasskey();
    const o1 = await d.authed('post', '/v1/auth/step-up/passkey/options');
    expect((await d.authed('post', '/v1/auth/step-up/passkey/verify', auth.assert(o1.body, { userVerified: false }))).status).toBe(400);
    const o2 = await d.authed('post', '/v1/auth/step-up/passkey/verify'.replace('verify', 'options'));
    expect((await d.authed('post', '/v1/auth/step-up/passkey/verify', auth.assert(o2.body, { counter: 5 }))).status).toBe(200);
    const o3 = await d.authed('post', '/v1/auth/step-up/passkey/options');
    expect((await d.authed('post', '/v1/auth/step-up/passkey/verify', auth.assert(o3.body, { counter: 3 }))).status).toBe(400);
  });

  it('el cambio de número exige step-up, bloquea operaciones sensibles, avisa al número anterior y cierra otras sesiones', async () => {
    const { d, p, auth } = await userWithPasskey();
    const other = await TestDevice.create(h);
    await other.login(p.local, p.e164);

    const target = newPhone();
    const denied = await d.authed('post', '/v1/auth/phone/change', { phone: target.local });
    expect(denied.status).toBe(401);
    expect(denied.body.title).toBe('insufficient_user_authentication');

    const o = await d.authed('post', '/v1/auth/step-up/passkey/options');
    const up = await d.authed('post', '/v1/auth/step-up/passkey/verify', auth.assert(o.body));
    expect(up.status).toBe(200);
    d.accessToken = up.body.access_token;

    const ch = await d.authed('post', '/v1/auth/phone/change', { phone: target.local });
    expect(ch.status).toBe(202);
    const ok = await d.authed('post', '/v1/auth/phone/change/confirm', { challengeId: ch.body.challengeId, code: d.lastOtp(target.e164) });
    expect(ok.status).toBe(200);
    expect(ok.body.otherSessionsRevoked).toBeGreaterThanOrEqual(1);
    expect(h.sms.lastTo(p.e164)!.text).toContain('fue cambiado');
    expect((await other.authed('get', '/v1/me')).status).toBe(401);
    expect((await d.authed('get', '/v1/me')).body.sensitiveOpsLockedUntil).not.toBeNull();
  });

  it('no permite registrar la primera passkey durante el bloqueo por login en dispositivo nuevo (anti SIM swap)', async () => {
    const p = newPhone();
    const original = await TestDevice.create(h);
    await original.login(p.local, p.e164);
    const attacker = await TestDevice.create(h);
    await attacker.login(p.local, p.e164);
    const res = await attacker.authed('post', '/v1/auth/passkeys/registration/options');
    expect(res.status).toBe(403);
    expect(res.body.title).toBe('sensitive_ops_locked');
  });

  it('un step-up con passkey levanta el bloqueo anti SIM swap', async () => {
    const { p, auth } = await userWithPasskey();
    const newDevice = await TestDevice.create(h);
    await newDevice.login(p.local, p.e164);
    expect((await newDevice.authed('get', '/v1/me')).body.sensitiveOpsLockedUntil).not.toBeNull();
    const o = await newDevice.authed('post', '/v1/auth/step-up/passkey/options');
    const up = await newDevice.authed('post', '/v1/auth/step-up/passkey/verify', auth.assert(o.body));
    expect(up.status).toBe(200);
    newDevice.accessToken = up.body.access_token;
    const me = await newDevice.authed('get', '/v1/me');
    expect(me.body.sensitiveOpsLockedUntil).toBeNull();
    expect(me.body.session.acr).toBe('urn:intitaxi:acr:phr');
  });

  it('añadir una segunda passkey exige MFA reciente', async () => {
    const { d } = await userWithPasskey();
    expect((await d.authed('post', '/v1/auth/passkeys/registration/options')).status).toBe(401);
  });
});

describe('Step-up con correo + clave del dispositivo (usuarios sin passkey)', () => {
  async function setup() {
    const p = newPhone();
    const email = `s${phoneSeq}@correo.test`;
    const d = await TestDevice.create(h);
    await d.login(p.local, p.e164);
    await d.authed('post', '/v1/me/email', { email });
    const token = /#token=([A-Za-z0-9_-]+)/.exec(h.email.lastTo(email)!.text)![1]!;
    await h.http.post('/v1/auth/email/verify').send({ token }).expect(204);
    const bio = await generateKeyPair('ES256');
    expect((await d.authed('post', '/v1/auth/device-keys', { publicJwk: await exportJWK(bio.publicKey) })).status).toBe(201);
    return { d, p, email, bio };
  }
  const codeOf = (email: string) => /es (\d{6})/.exec(h.email.lastTo(email)!.text)![1]!;

  it('eleva la sesión a acr=mfa con código de correo + firma del dispositivo', async () => {
    const { d, email, bio } = await setup();
    const o = await d.authed('post', '/v1/auth/step-up/email/options');
    expect(o.status).toBe(200);
    const res = await d.authed('post', '/v1/auth/step-up/email/verify', {
      code: codeOf(email),
      assertion: await d.signJws({ challenge: o.body.challenge }, bio.privateKey as CryptoKey),
    });
    expect(res.status).toBe(200);
    d.accessToken = res.body.access_token;
    expect((await d.authed('get', '/v1/me')).body.session).toEqual({ acr: 'urn:intitaxi:acr:mfa', amr: ['email', 'hwk'] });
  });

  it('falla con código correcto pero firma de otra clave, y el reto no se puede reintentar', async () => {
    const { d, email } = await setup();
    const o = await d.authed('post', '/v1/auth/step-up/email/options');
    const other = await generateKeyPair('ES256');
    const body = { code: codeOf(email), assertion: await d.signJws({ challenge: o.body.challenge }, other.privateKey as CryptoKey) };
    expect((await d.authed('post', '/v1/auth/step-up/email/verify', body)).status).toBe(400);
    expect((await d.authed('post', '/v1/auth/step-up/email/verify', body)).status).toBe(400);
  });

  it('no está disponible durante el bloqueo anti SIM swap', async () => {
    const { p } = await setup();
    const attacker = await TestDevice.create(h);
    await attacker.login(p.local, p.e164);
    const bio = await generateKeyPair('ES256');
    expect((await attacker.authed('post', '/v1/auth/device-keys', { publicJwk: await exportJWK(bio.publicKey) })).status).toBe(201);
    const res = await attacker.authed('post', '/v1/auth/step-up/email/options');
    expect(res.status).toBe(403);
  });
});

describe('Auditoría inmutable', () => {
  it('registra eventos con la cadena de hash íntegra y bloquea modificaciones', async () => {
    const d = await TestDevice.create(h);
    const p = newPhone();
    await d.login(p.local, p.e164);
    const { rows } = await h.pool.query('SELECT audit.verify_chain() AS broken, count(*) FROM audit.audit_log GROUP BY 1');
    expect(rows[0].broken).toBeNull();
    expect(Number(rows[0].count)).toBeGreaterThan(3);
    await expect(h.pool.query(`UPDATE audit.audit_log SET action = 'x'`)).rejects.toThrow(/solo inserción/);
    await expect(h.pool.query(`DELETE FROM audit.audit_log`)).rejects.toThrow(/solo inserción/);
    await expect(h.pool.query(`TRUNCATE audit.audit_log`)).rejects.toThrow(/solo inserción/);
  });

  it('no guarda teléfonos en claro en ninguna tabla', async () => {
    const d = await TestDevice.create(h);
    const p = newPhone();
    await d.login(p.local, p.e164);
    const dump = await h.pool.query(
      `SELECT (SELECT string_agg(t::text, '|') FROM identity.users t) || (SELECT string_agg(t::text, '|') FROM identity.otp_challenges t) || (SELECT string_agg(t::text, '|') FROM audit.audit_log t) AS all`,
    );
    expect(dump.rows[0].all).not.toContain(p.e164.slice(1));
  });
});

describe('Cabeceras de seguridad y errores', () => {
  it('aplica cabeceras de seguridad y no expone detalles internos', async () => {
    const res = await h.http.get('/no-existe');
    expect(res.status).toBe(404);
    expect(res.headers['strict-transport-security']).toContain('max-age=63072000');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('rechaza cuerpos demasiado grandes', async () => {
    const d = await TestDevice.create(h);
    const res = await d.pre('/v1/auth/otp/request', { phone: 'x'.repeat(40_000) });
    expect(res.status).toBe(413);
  });

  it('usa la URL pública configurada para DPoP aunque se manipule la cabecera Host', async () => {
    const d = await TestDevice.create(h);
    const p = newPhone();
    await d.login(p.local, p.e164);
    const res = await h.http
      .get('/v1/me')
      .set('Host', 'evil.example')
      .set('Authorization', `DPoP ${d.accessToken}`)
      .set('DPoP', await new SignJWT({ htm: 'GET', htu: 'https://evil.example/v1/me', jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1000) })
        .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: d.signer.publicJwk as never })
        .sign((await generateKeyPair('ES256')).privateKey));
    expect(res.status).toBe(401);
    expect(BASE).toContain('auth.intitaxi.test');
  });
});
