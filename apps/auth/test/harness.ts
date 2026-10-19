import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { codeChallengeS256, createCodeVerifier, createDpopProof, type DpopSigner } from '@intitaxi/auth-client';
import { createPool, migrate } from '@intitaxi/db';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import request from 'supertest';
import { createApp } from '../src/bootstrap.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import type { CapturingSender } from '@intitaxi/nest-common';
import { EMAIL_SENDER, PG_POOL, SMS_SENDER } from '../src/tokens.js';
import type { Pool } from '@intitaxi/db';

export const BASE = 'https://auth.intitaxi.test';
export const ORIGIN = 'https://intitaxi.test';
export const CLIENT_ID = 'intitaxi-passenger';

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Las pruebas de integración requieren ${name} (BD/Redis de pruebas, nunca de producción)`);
  return v;
}

export function testConfig(): AppConfig {
  const key = () => randomBytes(32).toString('base64');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return loadConfig({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: BASE,
    DATABASE_URL: requiredEnv('DATABASE_URL'),
    REDIS_URL: requiredEnv('REDIS_URL'),
    KEY_PROVIDER: 'local',
    LOCAL_MASTER_KEY: key(),
    BLIND_INDEX_KEY: key(),
    OTP_PEPPER: key(),
    INTERNAL_SIGNING_SECRET: key(),
    JWT_SIGNING_KEY_PEM: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    JWT_SIGNING_KID: 'test-1',
    ATTESTATION_MODE: 'dev',
    SMS_PROVIDER: 'capture',
    EMAIL_PROVIDER: 'capture',
    WEBAUTHN_RP_ID: 'intitaxi.test',
    WEBAUTHN_ORIGINS: ORIGIN,
  });
}

export interface Harness {
  app: INestApplication;
  http: ReturnType<typeof request>;
  pool: Pool;
  sms: CapturingSender;
  email: CapturingSender;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const config = testConfig();
  const admin = createPool({ connectionString: config.DATABASE_URL, applicationName: 'test-setup', ssl: false });
  // BD de pruebas desechable: se borran todos los esquemas de la aplicación y se migra desde cero.
  const { rows } = await admin.query<{ nspname: string }>(`SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname NOT IN ('public', 'information_schema')`);
  for (const r of rows) await admin.query(`DROP SCHEMA "${r.nspname}" CASCADE`);
  await admin.query('DROP TABLE IF EXISTS public.schema_migrations');
  await migrate(admin, fileURLToPath(new URL('../../../db/migrations', import.meta.url)));
  await admin.end();
  const redis = new Redis(config.REDIS_URL);
  await redis.flushdb();
  await redis.quit();

  const app = await createApp(config);
  await app.init();
  return {
    app,
    http: request(app.getHttpServer()),
    pool: app.get(PG_POOL),
    sms: app.get(SMS_SENDER),
    email: app.get(EMAIL_SENDER),
    close: () => app.close(),
  };
}

export async function flushRedis() {
  const r = new Redis(testConfig().REDIS_URL);
  await r.flushdb();
  await r.quit();
}

/** Simula una instalación de la app: clave DPoP propia, atestación y helpers de petición. */
export class TestDevice {
  signer!: DpopSigner;
  ticket = '';
  deviceId = '';
  accessToken = '';
  refreshToken = '';
  #priv!: CryptoKey;

  constructor(private readonly h: Harness) {}

  static async create(h: Harness, attest = true): Promise<TestDevice> {
    const d = new TestDevice(h);
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    d.#priv = privateKey as CryptoKey;
    d.signer = {
      publicJwk: (await exportJWK(publicKey)) as DpopSigner['publicJwk'],
      signJws: (header, payload) => new SignJWT(payload).setProtectedHeader(header as never).sign(privateKey),
    };
    if (attest) await d.attest();
    return d;
  }

  proof(method: string, path: string, accessToken?: string) {
    return createDpopProof(this.signer, { method, url: BASE + path, accessToken });
  }

  appId = 'ec.intitaxi.passenger';

  async attest(token?: (nonce: string) => string) {
    const n = await this.h.http.post('/v1/attestation/nonce').set('DPoP', await this.proof('POST', '/v1/attestation/nonce')).expect(200);
    const res = await this.h.http
      .post('/v1/attestation/verify')
      .set('DPoP', await this.proof('POST', '/v1/attestation/verify'))
      .send({ platform: 'android', appId: this.appId, nonce: n.body.nonce, token: token ? token(n.body.nonce) : `dev-ok:${n.body.nonce}` });
    if (res.status === 200) {
      this.ticket = res.body.ticket;
      this.deviceId = res.body.deviceId;
    }
    return res;
  }

  /** POST previo al login: DPoP + ticket de atestación. */
  async pre(path: string, body: unknown) {
    return this.h.http.post(path).set('DPoP', await this.proof('POST', path)).set('X-Attestation-Ticket', this.ticket).send(body as object);
  }

  async authed(method: 'get' | 'post' | 'delete', path: string, body?: unknown, accessToken = this.accessToken) {
    const r = this.h.http[method](path)
      .set('Authorization', `DPoP ${accessToken}`)
      .set('DPoP', await this.proof(method.toUpperCase(), path, accessToken))
      .set('X-Attestation-Ticket', this.ticket);
    return body === undefined ? r : r.send(body as object);
  }

  async token(form: Record<string, string>) {
    return this.h.http.post('/oauth/token').set('DPoP', await this.proof('POST', '/oauth/token')).type('form').send(form);
  }

  async exchange(code: string, verifier: string) {
    const res = await this.token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: CLIENT_ID });
    if (res.status === 200) {
      this.accessToken = res.body.access_token;
      this.refreshToken = res.body.refresh_token;
    }
    return res;
  }

  async refresh() {
    const res = await this.token({ grant_type: 'refresh_token', refresh_token: this.refreshToken, client_id: CLIENT_ID });
    if (res.status === 200) {
      this.accessToken = res.body.access_token;
      this.refreshToken = res.body.refresh_token;
    }
    return res;
  }

  async requestOtp(phone: string) {
    return this.pre('/v1/auth/otp/request', { phone });
  }

  lastOtp(e164: string): string {
    const m = this.h.sms.lastTo(e164);
    return /es (\d{6})/.exec(m?.text ?? '')?.[1] ?? '';
  }

  async verifyOtp(challengeId: string, code: string, verifier = createCodeVerifier()) {
    const res = await this.pre('/v1/auth/otp/verify', { challengeId, code, codeChallenge: await codeChallengeS256(verifier), codeChallengeMethod: 'S256' });
    return { res, verifier };
  }

  /** Inicio de sesión completo con OTP. */
  async login(phone = '0991234567', e164 = '+593991234567') {
    const r = await this.requestOtp(phone);
    if (r.status !== 202) throw new Error(`otp request ${r.status} ${JSON.stringify(r.body)}`);
    const { res, verifier } = await this.verifyOtp(r.body.challengeId, this.lastOtp(e164));
    if (res.status !== 200) throw new Error(`otp verify ${res.status} ${JSON.stringify(res.body)}`);
    const t = await this.exchange(res.body.code, verifier);
    if (t.status !== 200) throw new Error(`token ${t.status} ${JSON.stringify(t.body)}`);
    return res.body as { code: string; isNewUser: boolean };
  }

  async signJws(payload: object, key: CryptoKey = this.#priv) {
    return new SignJWT(payload as never).setProtectedHeader({ alg: 'ES256' }).sign(key);
  }
}
