/**
 * Simulador de Inti Taxi (solo desarrollo).
 * Mantiene "dispositivos" simulados (cada uno con su clave DPoP, ticket de atestación, passkey y
 * clave biométrica por software) y ejecuta acciones contra los servicios reales.
 * Lee la bandeja de SMS/correos de desarrollo (Redis "devbox") y el log de auditoría.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { Redis } from 'ioredis';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SimDevice, type HttpResult, type Integrity } from '@intitaxi/testkit';
import { runAction, type SimEntry } from './actions.js';

if (process.env.NODE_ENV === 'production') {
  console.error('El simulador no puede ejecutarse en producción.');
  process.exit(1);
}

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`Falta la variable ${k}`);
  return v;
};

export const services: Record<string, string> = {
  auth: env('SIM_AUTH_URL', 'http://localhost:3001'),
  api: env('SIM_API_URL', 'http://localhost:3002'),
  sos: env('SIM_SOS_URL', 'http://localhost:3003'),
  realtime: env('SIM_REALTIME_URL', 'http://localhost:3004'),
};
export const webauthn = { rpId: env('WEBAUTHN_RP_ID', 'localhost'), origin: env('SIM_WEBAUTHN_ORIGIN', 'http://localhost:3001') };

const redis = new Redis(env('REDIS_URL'));
const db = new pg.Pool({ connectionString: env('DATABASE_URL'), max: 2, application_name: 'simulator' });

const devices = new Map<string, SimEntry>();
const timeline: { id: string; at: string; device: string; action: string; status: number; body: unknown }[] = [];

function record(device: string, action: string, r: HttpResult) {
  timeline.unshift({ id: randomUUID(), at: new Date().toISOString(), device, action, status: r.status, body: r.body });
  timeline.length = Math.min(timeline.length, 300);
}

const ROLES: Record<string, { appId: string; clientId: string }> = {
  passenger: { appId: 'ec.intitaxi.passenger', clientId: 'intitaxi-passenger' },
  driver: { appId: 'ec.intitaxi.driver', clientId: 'intitaxi-driver' },
};

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch(next);

app.get(
  '/sim/state',
  wrap(async (_req, res) => {
    res.json({
      services,
      devices: [...devices.values()].map((e) => ({
        id: e.id,
        label: e.label,
        role: e.role,
        phone: e.phone,
        userId: e.userId,
        integrity: e.integrity,
        loggedIn: !!e.device.accessToken,
        hasPasskey: !!e.device.passkey,
        hasDeviceKey: !!e.device.bioKey,
        deviceId: e.device.deviceId,
        tokenClaims: e.device.accessToken ? JSON.parse(Buffer.from(e.device.accessToken.split('.')[1]!, 'base64url').toString()) : null,
        data: e.data,
      })),
      timeline: timeline.slice(0, 100),
    });
  }),
);

app.get(
  '/sim/health',
  wrap(async (_req, res) => {
    const out: Record<string, string> = {};
    await Promise.all(
      Object.entries(services).map(async ([k, url]) => {
        try {
          const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1500) });
          out[k] = r.ok ? 'ok' : `error ${r.status}`;
        } catch {
          out[k] = 'apagado';
        }
      }),
    );
    res.json(out);
  }),
);

app.post(
  '/sim/devices',
  wrap(async (req, res) => {
    const { label, role = 'passenger', integrity = 'ok', fromDevice, adminRole } = req.body as { label?: string; role?: string; integrity?: Integrity; fromDevice?: string; adminRole?: string };
    if (role === 'admin') {
      // Panel admin = navegador: sin atestación; inicia sesión con la passkey de un usuario existente.
      const source = [...devices.values()].find((d) => d.id === fromDevice) ?? [...devices.values()].find((d) => d.device.passkey);
      if (!source?.device.passkey || !source.userId) return res.json({ error: 'Primero crea una passkey en un dispositivo con sesión iniciada' });
      await fetch(`${services.api}/v1/dev/admin/grant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: source.userId, role: adminRole || 'super_admin' }) });
      const web = await SimDevice.createWeb({ services });
      const login = await web.loginAdmin(source.device.passkey);
      const id = randomUUID().slice(0, 8);
      const entry: SimEntry = { id, label: label || `Admin (${adminRole || 'super_admin'})`, role: 'admin', integrity: 'web', device: web, data: {}, userId: source.userId, phone: source.phone };
      devices.set(id, entry);
      record(entry.label, 'admin.login (passkey)', login);
      return res.json({ id });
    }
    const r = ROLES[role];
    if (!r) return res.status(400).json({ error: 'rol inválido' });
    try {
      const device = await SimDevice.create({ services, appId: r.appId, clientId: r.clientId, integrity });
      const id = randomUUID().slice(0, 8);
      const entry: SimEntry = { id, label: label || `${role === 'driver' ? 'Conductor' : 'Pasajero'} ${devices.size + 1}`, role, integrity, device, data: {} };
      devices.set(id, entry);
      record(entry.label, 'dispositivo.crear (atestación)', { status: 200, body: { deviceId: device.deviceId, integrity } });
      res.json({ id });
    } catch (e) {
      const result = (e as { result?: HttpResult }).result ?? { status: 500, body: String(e) };
      record(label ?? role, 'dispositivo.crear (atestación)', result);
      res.status(200).json({ error: 'atestación rechazada', result });
    }
  }),
);

app.delete('/sim/devices/:id', (req, res) => {
  devices.delete(req.params.id!);
  res.status(204).end();
});

app.post(
  '/sim/devices/:id/action',
  wrap(async (req, res) => {
    const entry = devices.get(req.params.id as string);
    if (!entry) return res.status(404).json({ error: 'dispositivo no existe' });
    const { action, params = {} } = req.body as { action: string; params?: Record<string, any> };
    const result = await runAction(entry, action, params, { services, devices, webauthn });
    record(entry.label, action, result);
    res.json(result);
  }),
);

app.get(
  '/sim/inbox',
  wrap(async (_req, res) => {
    const raw = await redis.lrange('devbox:messages', 0, 99);
    res.json(raw.map((m) => JSON.parse(m)));
  }),
);

app.delete(
  '/sim/inbox',
  wrap(async (_req, res) => {
    await redis.del('devbox:messages');
    res.status(204).end();
  }),
);

app.get(
  '/sim/audit',
  wrap(async (_req, res) => {
    const { rows } = await db.query(
      `SELECT seq, ts, action, resource_type, resource_id, outcome, actor_user_id, metadata FROM audit.audit_log ORDER BY seq DESC LIMIT 60`,
    );
    const chain = await db.query('SELECT audit.verify_chain() AS broken');
    res.json({ chainIntact: chain.rows[0].broken === null, entries: rows });
  }),
);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: String((err as Error)?.message ?? err) });
});

const port = Number(env('SIM_PORT', '4000'));
const host = env('SIM_HOST', '127.0.0.1');
app.listen(port, host, () => console.log(`Simulador Inti Taxi en http://${host}:${port}`));
