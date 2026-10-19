import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, migrate, type Pool } from '@intitaxi/db';
import { SimDevice, type Integrity } from '@intitaxi/testkit';
import { Redis } from 'ioredis';

const root = fileURLToPath(new URL('../../', import.meta.url));
export type ServiceName = 'auth' | 'api' | 'sos' | 'realtime';

const ENTRY: Record<ServiceName, string> = {
  auth: 'apps/auth/dist/main.js',
  api: 'apps/api/dist/main.js',
  sos: 'apps/api/dist/main-sos.js',
  realtime: 'apps/realtime/dist/main.js',
};
const PORT: Record<ServiceName, number> = { auth: 39101, api: 39102, sos: 39103, realtime: 39104 };

function requiredEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Las pruebas e2e requieren ${name} (BD/Redis de pruebas, nunca de producción)`);
  return v;
}

export interface DevboxMessage {
  channel: 'sms' | 'email';
  to: string;
  subject?: string;
  text: string;
}

export class Stack {
  readonly urls: Record<string, string> = {};
  readonly procs: ChildProcess[] = [];
  readonly logs: string[] = [];
  pool!: Pool;
  redis!: Redis;
  #phoneSeq = 0;
  readonly #phoneBase = randomBytes(4).readUInt32BE() % 80_000_000;

  async start(services: ServiceName[], extraEnv: Partial<Record<ServiceName, Record<string, string>>> = {}) {
    const dbUrl = requiredEnv('E2E_DATABASE_URL');
    const redisUrl = requiredEnv('E2E_REDIS_URL');
    this.pool = createPool({ connectionString: dbUrl, applicationName: 'e2e', ssl: false });
    const { rows } = await this.pool.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname NOT IN ('public', 'information_schema')`,
    );
    for (const r of rows) await this.pool.query(`DROP SCHEMA "${r.nspname}" CASCADE`);
    await this.pool.query('DROP TABLE IF EXISTS public.schema_migrations');
    await migrate(this.pool, `${root}db/migrations`);
    this.redis = new Redis(redisUrl);
    await this.redis.flushdb();

    for (const s of services) this.urls[s] = `http://localhost:${PORT[s]}`;
    const key = () => randomBytes(32).toString('base64');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const manifestKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const internalSecret = key();
    const common = {
      INTERNAL_SIGNING_SECRET: internalSecret,
      INTERNAL_AUTH_URL: this.urls.auth ?? 'http://localhost:39101',
      NODE_ENV: 'development',
      DATABASE_URL: dbUrl,
      REDIS_URL: redisUrl,
      KEY_PROVIDER: 'local',
      SMS_PROVIDER: 'devbox',
      EMAIL_PROVIDER: 'devbox',
      ATTESTATION_MODE: 'dev',
      AUTH_ISSUER: this.urls.auth ?? 'http://localhost:39101',
      AUTH_JWKS_URL: `${this.urls.auth ?? 'http://localhost:39101'}/jwks`,
      DEV_TOOLS: 'true',
    };
    const perService: Record<ServiceName, Record<string, string>> = {
      auth: {
        LOCAL_MASTER_KEY: key(),
        BLIND_INDEX_KEY: key(),
        OTP_PEPPER: key(),
        JWT_SIGNING_KEY_PEM: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        JWT_SIGNING_KID: 'e2e-1',
        WEBAUTHN_RP_ID: 'localhost',
        WEBAUTHN_ORIGINS: 'http://localhost:39101',
      },
      api: { LOCAL_MASTER_KEY: key(), BLIND_INDEX_KEY: key(), WEBHOOK_SECRET_KYC: key(), KYC_PROVIDER: 'mock', PAYMENT_GATEWAY: 'mock', WEBHOOK_SECRET_PAYMENTS: key(), PAYOUT_MIN_CENTS: '100', MANIFEST_SIGNING_KEY_PEM: manifestKey, SAFETY_PIN_PEPPER: key(), ECU911_AUTO_ESCALATE_SECONDS: '5', TRACKING_BASE_URL: 'http://localhost:39104', MATCHING_SWEEP_MS: '250', MATCHING_OFFER_TTL_SECONDS: '5', REVERIFY_PROBABILITY: '0' },
      sos: { LOCAL_MASTER_KEY: key(), BLIND_INDEX_KEY: key() },
      realtime: { LOCAL_MASTER_KEY: key(), BLIND_INDEX_KEY: key() },
    };
    // api y sos comparten claves de cifrado (mismo dominio de datos).
    perService.sos = { ...perService.api };
    for (const s of services) {
      const env = { ...process.env, ...common, ...perService[s], ...(extraEnv[s] ?? {}), PORT: String(PORT[s]), PUBLIC_BASE_URL: this.urls[s]! };
      const p = spawn('node', [`${root}${ENTRY[s]}`], { env, cwd: root });
      p.stdout.on('data', (b) => this.logs.push(`[${s}] ${b}`));
      p.stderr.on('data', (b) => this.logs.push(`[${s}] ${b}`));
      this.procs.push(p);
    }
    await Promise.all(services.map((s) => this.#waitHealthy(s)));
    return this;
  }

  async #waitHealthy(s: ServiceName) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${this.urls[s]}/healthz`);
        if (r.ok) return;
      } catch {
        /* aún arrancando */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`${s} no arrancó:\n${this.logs.join('').slice(-3000)}`);
  }

  async stop() {
    this.procs.forEach((p) => p.kill('SIGTERM'));
    await this.redis?.quit();
    await this.pool?.end();
  }

  device(role: 'passenger' | 'driver' = 'passenger', integrity: Integrity = 'ok') {
    return SimDevice.create({
      services: this.urls,
      appId: role === 'driver' ? 'ec.intitaxi.driver' : 'ec.intitaxi.passenger',
      clientId: role === 'driver' ? 'intitaxi-driver' : 'intitaxi-passenger',
      integrity,
    });
  }

  newPhone() {
    this.#phoneSeq += 1;
    const n = `9${10_000_000 + ((this.#phoneBase + this.#phoneSeq) % 89_999_999)}`;
    return { local: `0${n}`, e164: `+593${n}` };
  }

  async inbox(): Promise<DevboxMessage[]> {
    return (await this.redis.lrange('devbox:messages', 0, 199)).map((m) => JSON.parse(m));
  }

  async lastCode(to: string, channel: 'sms' | 'email' = 'sms') {
    const m = (await this.inbox()).find((x) => x.to === to && x.channel === channel);
    return /(\d{6})/.exec(m?.text ?? '')?.[1] ?? '';
  }

  /** Dispositivo con sesión iniciada por OTP. */
  async loggedIn(role: 'passenger' | 'driver' = 'passenger', integrity: Integrity = 'ok') {
    const d = await this.device(role, integrity);
    const phone = this.newPhone();
    const r = await d.requestOtp(phone.local);
    if (r.status !== 202) throw new Error(`OTP ${r.status} ${JSON.stringify(r.body)}`);
    const v = await d.verifyOtp(r.body.challengeId, await this.lastCode(phone.e164));
    if (v.status !== 200) throw new Error(`verify ${v.status} ${JSON.stringify(v.body)}`);
    const me = await d.call('auth', 'GET', '/v1/me');
    return { d, phone, userId: me.body.id as string };
  }
}
