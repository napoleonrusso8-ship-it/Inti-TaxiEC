import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { verifyDpopProof } from '@intitaxi/auth-verifier';
import { base64url, codeChallengeS256, createDpopProof, TokenManager, type DpopSigner, type Fetch, type SecureStore } from './index.js';

async function makeSigner(): Promise<DpopSigner> {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const publicJwk = await exportJWK(publicKey);
  return {
    publicJwk: publicJwk as DpopSigner['publicJwk'],
    signJws: (header, payload) => new SignJWT(payload).setProtectedHeader(header as never).sign(privateKey),
  };
}

class MemStore implements SecureStore {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
}

describe('PKCE y codificación', () => {
  it('base64url coincide con Buffer', () => {
    for (const len of [0, 1, 2, 3, 31, 32]) {
      const b = crypto.getRandomValues(new Uint8Array(len));
      expect(base64url(b)).toBe(Buffer.from(b).toString('base64url'));
    }
  });
  it('vector de prueba S256 del RFC 7636', async () => {
    expect(await codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('createDpopProof', () => {
  it('genera pruebas que el verificador del servidor acepta', async () => {
    const signer = await makeSigner();
    const url = 'https://auth.intitaxi.test/v1/me?x=1';
    const proof = await createDpopProof(signer, { method: 'get', url, accessToken: 'abc' });
    const seen = new Set<string>();
    const r = await verifyDpopProof({
      proof, method: 'GET', url, accessToken: 'abc',
      replayStore: { markUsed: async (j) => !seen.has(j) && !!seen.add(j) },
    });
    expect(r.jkt).toBeTruthy();
  });
});

describe('TokenManager', () => {
  const cfg = { tokenEndpoint: 'https://auth.intitaxi.test/oauth/token', clientId: 'passenger-app' };

  function okResponse(n: number) {
    return { status: 200, json: async () => ({ access_token: `at${n}`, refresh_token: `rt${n}`, token_type: 'DPoP', expires_in: 300 }) };
  }

  it('agrupa renovaciones concurrentes en una sola petición', async () => {
    const store = new MemStore();
    await store.set('intitaxi.refresh_token', 'rt0');
    let n = 0;
    const fetchFn = vi.fn<Fetch>(async () => okResponse(++n));
    const tm = new TokenManager(cfg, await makeSigner(), store, fetchFn);
    const tokens = await Promise.all([tm.getAccessToken(), tm.getAccessToken(), tm.getAccessToken()]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(new Set(tokens)).toEqual(new Set(['at1']));
    expect(await store.get('intitaxi.refresh_token')).toBe('rt1');
  });

  it('envía DPoP en la petición al endpoint de tokens', async () => {
    const store = new MemStore();
    const fetchFn = vi.fn<Fetch>(async () => okResponse(1));
    const tm = new TokenManager(cfg, await makeSigner(), store, fetchFn);
    await tm.exchangeCode('code', 'verifier');
    const init = fetchFn.mock.calls[0]![1];
    expect(init.headers.DPoP).toMatch(/^ey/);
    expect(init.body).toContain('grant_type=authorization_code');
  });

  it('cierra la sesión local si el servidor responde invalid_grant (p. ej. reutilización detectada)', async () => {
    const store = new MemStore();
    await store.set('intitaxi.refresh_token', 'rt0');
    const ended = vi.fn();
    const fetchFn = vi.fn<Fetch>(async () => ({ status: 400, json: async () => ({ error: 'invalid_grant' }) }));
    const tm = new TokenManager(cfg, await makeSigner(), store, fetchFn, ended);
    await expect(tm.getAccessToken()).rejects.toThrow();
    expect(ended).toHaveBeenCalledWith('invalid_grant');
    expect(await store.get('intitaxi.refresh_token')).toBeNull();
  });

  it('reutiliza el token de acceso vigente sin llamar al servidor', async () => {
    const store = new MemStore();
    const fetchFn = vi.fn<Fetch>(async () => okResponse(1));
    const tm = new TokenManager(cfg, await makeSigner(), store, fetchFn);
    await tm.exchangeCode('c', 'v');
    await tm.getAccessToken();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('exchangeToken: pide el token exchange para su propio cliente y guarda el refresh token en su clave', async () => {
    const store = new MemStore();
    await store.set('intitaxi.refresh_token', 'rt-pasajero');
    const fetchFn = vi.fn<Fetch>(async () => okResponse(7));
    const tm = new TokenManager({ ...cfg, clientId: 'intitaxi-driver', refreshTokenKey: 'intitaxi.refresh_token.driver' }, await makeSigner(), store, fetchFn);
    await tm.exchangeToken('at-pasajero');
    const init = fetchFn.mock.calls[0]![1];
    const form = new URLSearchParams(init.body);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'at-pasajero',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      client_id: 'intitaxi-driver',
    });
    expect(init.headers.DPoP).toMatch(/^ey/);
    expect(await tm.getAccessToken()).toBe('at7');
    expect(await store.get('intitaxi.refresh_token.driver')).toBe('rt7');
    expect(await store.get('intitaxi.refresh_token')).toBe('rt-pasajero');
  });
});
