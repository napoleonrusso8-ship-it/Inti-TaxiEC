import { createHash, randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK, type CryptoKey } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenVerifier, ACR_MFA, ACR_PHR, assertRecentMfa, AuthError, verifyDpopProof, type DpopReplayStore } from './index.js';

class MemReplay implements DpopReplayStore {
  seen = new Set<string>();
  async markUsed(jti: string) {
    if (this.seen.has(jti)) return false;
    this.seen.add(jti);
    return true;
  }
}

const URL_ME = 'https://auth.intitaxi.test/v1/me';
let dpopKey: { privateKey: CryptoKey; publicKey: CryptoKey };
let dpopJwk: JWK;

async function proof(opts: { htm?: string; htu?: string; ath?: string; iat?: number; jti?: string; jwk?: JWK; typ?: string } = {}) {
  return new SignJWT({ htm: opts.htm ?? 'GET', htu: opts.htu ?? URL_ME, jti: opts.jti ?? randomUUID(), ...(opts.ath ? { ath: opts.ath } : {}) })
    .setProtectedHeader({ alg: 'ES256', typ: opts.typ ?? 'dpop+jwt', jwk: opts.jwk ?? dpopJwk })
    .setIssuedAt(opts.iat)
    .sign(dpopKey.privateKey);
}

beforeAll(async () => {
  dpopKey = await generateKeyPair('ES256', { extractable: true });
  dpopJwk = await exportJWK(dpopKey.publicKey);
});

describe('verifyDpopProof', () => {
  it('acepta una prueba válida y devuelve el thumbprint', async () => {
    const r = await verifyDpopProof({ proof: await proof(), method: 'GET', url: URL_ME, replayStore: new MemReplay() });
    expect(r.jkt).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('ignora la query string al comparar htu', async () => {
    await expect(
      verifyDpopProof({ proof: await proof(), method: 'GET', url: `${URL_ME}?a=1`, replayStore: new MemReplay() }),
    ).resolves.toBeTruthy();
  });

  it.each([
    ['método distinto', { htm: 'POST' }],
    ['URL distinta', { htu: 'https://evil.test/v1/me' }],
    ['typ incorrecto', { typ: 'JWT' }],
    ['iat antiguo', { iat: Math.floor(Date.now() / 1000) - 600 }],
    ['jti corto', { jti: 'abc' }],
  ])('rechaza: %s', async (_, o) => {
    await expect(
      verifyDpopProof({ proof: await proof(o), method: 'GET', url: URL_ME, replayStore: new MemReplay() }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('rechaza la repetición de la misma prueba', async () => {
    const store = new MemReplay();
    const p = await proof();
    await verifyDpopProof({ proof: p, method: 'GET', url: URL_ME, replayStore: store });
    await expect(verifyDpopProof({ proof: p, method: 'GET', url: URL_ME, replayStore: store })).rejects.toThrow('repetida');
  });

  it('rechaza una prueba con clave privada embebida', async () => {
    const priv = await exportJWK(dpopKey.privateKey);
    await expect(
      verifyDpopProof({ proof: await proof({ jwk: priv }), method: 'GET', url: URL_ME, replayStore: new MemReplay() }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('rechaza una prueba firmada con otra clave distinta a la embebida', async () => {
    const other = await generateKeyPair('ES256', { extractable: true });
    await expect(
      verifyDpopProof({
        proof: await proof({ jwk: await exportJWK(other.publicKey) }),
        method: 'GET',
        url: URL_ME,
        replayStore: new MemReplay(),
      }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe('AccessTokenVerifier', () => {
  let issuerKey: { privateKey: CryptoKey; publicKey: CryptoKey };
  let verifier: AccessTokenVerifier;
  const revoked = new Set<string>();

  beforeAll(async () => {
    issuerKey = await generateKeyPair('ES256', { extractable: true });
    const pub = { ...(await exportJWK(issuerKey.publicKey)), kid: 'k1', alg: 'ES256' };
    verifier = new AccessTokenVerifier({
      issuer: 'https://auth.intitaxi.test',
      audience: 'intitaxi-api',
      keys: createLocalJWKSet({ keys: [pub] }),
      replayStore: new MemReplay(),
      revocation: { isSessionRevoked: async (sid) => revoked.has(sid) },
    });
  });

  async function accessToken(claims: Record<string, unknown> = {}, jkt?: string) {
    const { calculateJwkThumbprint } = await import('jose');
    return new SignJWT({ sid: 'sess-1', did: 'dev-1', cnf: { jkt: jkt ?? (await calculateJwkThumbprint(dpopJwk)) }, ...claims })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'k1' })
      .setIssuer('https://auth.intitaxi.test')
      .setAudience('intitaxi-api')
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(issuerKey.privateKey);
  }
  const ath = (t: string) => createHash('sha256').update(t).digest('base64url');

  it('acepta token + prueba DPoP con ath', async () => {
    const at = await accessToken();
    const ctx = await verifier.verify({ authorization: `DPoP ${at}`, dpop: await proof({ ath: ath(at) }), method: 'GET', url: URL_ME });
    expect(ctx).toMatchObject({ userId: 'user-1', sessionId: 'sess-1', deviceId: 'dev-1' });
  });

  it('rechaza el esquema Bearer (token robado sin la clave)', async () => {
    const at = await accessToken();
    await expect(verifier.verify({ authorization: `Bearer ${at}`, dpop: await proof({ ath: ath(at) }), method: 'GET', url: URL_ME })).rejects.toThrow();
  });

  it('rechaza si la prueba se firmó con otra clave (token robado)', async () => {
    const at = await accessToken({}, 'otro-thumbprint');
    await expect(verifier.verify({ authorization: `DPoP ${at}`, dpop: await proof({ ath: ath(at) }), method: 'GET', url: URL_ME })).rejects.toThrow('no corresponde');
  });

  it('rechaza si falta ath', async () => {
    const at = await accessToken();
    await expect(verifier.verify({ authorization: `DPoP ${at}`, dpop: await proof(), method: 'GET', url: URL_ME })).rejects.toThrow();
  });

  it('rechaza sesiones revocadas', async () => {
    revoked.add('sess-2');
    const at = await accessToken({ sid: 'sess-2' });
    await expect(verifier.verify({ authorization: `DPoP ${at}`, dpop: await proof({ ath: ath(at) }), method: 'GET', url: URL_ME })).rejects.toThrow('revocada');
  });

  it('rechaza tokens con alg none o firmados por otro emisor', async () => {
    const forged = await generateKeyPair('ES256');
    const at = await new SignJWT({ sid: 's', cnf: { jkt: 'x' } })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'k1' })
      .setIssuer('https://auth.intitaxi.test').setAudience('intitaxi-api').setSubject('u').setIssuedAt().setExpirationTime('5m')
      .sign(forged.privateKey);
    await expect(verifier.verify({ authorization: `DPoP ${at}`, dpop: await proof({ ath: ath(at) }), method: 'GET', url: URL_ME })).rejects.toThrow();
    const none = `${Buffer.from('{"alg":"none","typ":"at+jwt"}').toString('base64url')}.${Buffer.from('{"sub":"u"}').toString('base64url')}.x`;
    await expect(verifier.verify({ authorization: `DPoP ${none}`, dpop: await proof(), method: 'GET', url: URL_ME })).rejects.toThrow();
  });
});

describe('assertRecentMfa', () => {
  const base = { userId: 'u', sessionId: 's', deviceId: 'd', amr: [], roles: [], jkt: 'j', clientId: 'c' };
  it('acepta MFA reciente', () => expect(() => assertRecentMfa({ ...base, acr: ACR_MFA, authTime: 1000 }, { nowSeconds: 1200 })).not.toThrow());
  it('acepta passkey como MFA', () => expect(() => assertRecentMfa({ ...base, acr: ACR_PHR, authTime: 1000 }, { nowSeconds: 1200 })).not.toThrow());
  it('rechaza MFA antiguo', () => expect(() => assertRecentMfa({ ...base, acr: ACR_MFA, authTime: 1000 }, { nowSeconds: 1400 })).toThrow());
  it('rechaza sin MFA', () => expect(() => assertRecentMfa({ ...base, acr: 'urn:intitaxi:acr:basic', authTime: 1000 }, { nowSeconds: 1000 })).toThrow());
  it('exige passkey cuando se pide resistencia al phishing', () => {
    expect(() => assertRecentMfa({ ...base, acr: ACR_MFA, authTime: 1000 }, { nowSeconds: 1000, phishingResistant: true })).toThrow();
    expect(() => assertRecentMfa({ ...base, acr: ACR_PHR, authTime: 1000 }, { nowSeconds: 1000, phishingResistant: true })).not.toThrow();
  });
});
