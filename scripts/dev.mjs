#!/usr/bin/env node
// Arranca todo Inti Taxi en local para usar el simulador:
//   pnpm dev            → genera .env.dev (secretos aleatorios, solo local), levanta Postgres/Redis con Docker
//                         si no se indicó DATABASE_URL/REDIS_URL, migra, compila y arranca servicios + simulador.
// Nunca usar estos valores fuera de tu computadora.
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const envFile = `${root}.env.dev`;
const rnd = (n = 32) => randomBytes(n).toString('base64');
const pw = () => randomBytes(18).toString('base64url');

if (!existsSync(envFile)) {
  const pgPass = pw();
  const redisPass = pw();
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString().replace(/\n/g, '\\n');
  writeFileSync(
    envFile,
    [
      '# Generado por scripts/dev.mjs — SOLO desarrollo local. No subir al repositorio.',
      `POSTGRES_PASSWORD=${pgPass}`,
      `REDIS_PASSWORD=${redisPass}`,
      `DATABASE_URL=postgres://intitaxi:${pgPass}@127.0.0.1:5432/intitaxi`,
      `REDIS_URL=redis://:${redisPass}@127.0.0.1:6379/0`,
      'NODE_ENV=development',
      'KEY_PROVIDER=local',
      `LOCAL_MASTER_KEY=${rnd()}`,
      `BLIND_INDEX_KEY=${rnd()}`,
      `OTP_PEPPER=${rnd()}`,
      `JWT_SIGNING_KEY_PEM=${pem}`,
      'JWT_SIGNING_KID=dev-1',
      'ATTESTATION_MODE=dev',
      'SMS_PROVIDER=devbox',
      'EMAIL_PROVIDER=devbox',
      'WEBAUTHN_RP_ID=localhost',
      'WEBAUTHN_ORIGINS=http://localhost:3001,http://localhost:4100',
      `INTERNAL_SIGNING_SECRET=${rnd()}`,
      `MANIFEST_SIGNING_SECRET=${rnd()}`,
      `WEBHOOK_SECRET_KYC=${rnd()}`,
      `WEBHOOK_SECRET_PAYMENTS=${rnd()}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  console.log('· .env.dev creado con secretos aleatorios (solo local)');
}

// Claves añadidas en módulos posteriores: se agregan a un .env.dev existente si faltan.
{
  const current = readFileSync(envFile, 'utf8');
  const extra = [];
  if (!current.includes('MANIFEST_SIGNING_KEY_PEM=')) {
    const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString().replace(/\n/g, '\\n');
    extra.push(`MANIFEST_SIGNING_KEY_PEM=${pem}`);
  }
  if (!current.includes('SAFETY_PIN_PEPPER=')) extra.push(`SAFETY_PIN_PEPPER=${rnd()}`);
  if (extra.length) writeFileSync(envFile, current + extra.join('\n') + '\n', { mode: 0o600 });
}

const fileEnv = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/\\n/g, '\n')]),
);
// Variables ya definidas en la terminal tienen prioridad (p. ej. Postgres/Redis propios).
const base = { ...fileEnv, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k in fileEnv && k !== 'NODE_ENV')) };

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, env: { ...process.env, ...base }, ...opts });
  if (r.status !== 0) throw new Error(`Falló: ${cmd} ${args.join(' ')}`);
};

if (!process.env.DATABASE_URL) {
  console.log('· Levantando Postgres y Redis con Docker…');
  run('docker', ['compose', '--env-file', envFile, 'up', '-d', '--wait']);
}
console.log('· Compilando…');
run('pnpm', ['build']);
console.log('· Migrando la base de datos…');
run('node', ['packages/db/dist/cli.js']);

const apiEnv = { SOS_INTERNAL_URL: 'http://localhost:3003', TRACKING_BASE_URL: 'http://localhost:3004', SUBJECT_PORTAL_URL: 'http://localhost:3002', INTERNAL_AUTH_URL: 'http://localhost:3001', AUTH_ISSUER: 'http://localhost:3001', AUTH_JWKS_URL: 'http://localhost:3001/jwks', DEV_TOOLS: 'true', KYC_PROVIDER: 'mock', PAYMENT_GATEWAY: 'mock', ECU911_ADAPTER: 'mock', ECU911_AUTO_ESCALATE_SECONDS: '60' };
// El panel web (4100) llama a auth/api/sos desde el navegador: CORS solo para ese origen.
const panel = { CORS_ORIGINS: 'http://localhost:4100' };
const SERVICES = [
  { name: 'auth', cmd: 'apps/auth/dist/main.js', env: { PORT: '3001', PUBLIC_BASE_URL: 'http://localhost:3001', WEBAUTHN_ORIGINS: 'http://localhost:3001,http://localhost:4100', ...panel } },
  { name: 'api', cmd: 'apps/api/dist/main.js', env: { PORT: '3002', PUBLIC_BASE_URL: 'http://localhost:3002', ...apiEnv, ...panel } },
  { name: 'sos', cmd: 'apps/api/dist/main-sos.js', env: { PORT: '3003', PUBLIC_BASE_URL: 'http://localhost:3003', ...apiEnv, ...panel } },
  { name: 'realtime', cmd: 'apps/realtime/dist/main.js', env: { PORT: '3004', PUBLIC_BASE_URL: 'http://localhost:3004', AUTH_ISSUER: 'http://localhost:3001', AUTH_JWKS_URL: 'http://localhost:3001/jwks' } },
  { name: 'admin', cmd: 'apps/admin-web/dist/server.js', env: { PORT: '4100', ADMIN_DEV_AUTHENTICATOR_URL: 'http://localhost:4000' } },
  { name: 'sim', cmd: 'apps/simulator/dist/server.js', env: { SIM_PORT: '4000' } },
];

const colors = [33, 36, 35, 32, 34, 31];
const children = [];
for (const [i, s] of SERVICES.entries()) {
  if (!existsSync(`${root}${s.cmd}`)) continue;
  const child = spawn('node', [s.cmd], { cwd: root, env: { ...process.env, ...base, ...s.env } });
  const tag = `\x1b[${colors[i % colors.length]}m[${s.name}]\x1b[0m `;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (b) => process.stdout.write(b.toString().replace(/(^|\n)(?=.)/g, `$1${tag}`)));
  children.push(child);
}
console.log('\n  Simulador:  http://localhost:4000');
if (existsSync(`${root}apps/admin-web/dist/server.js`)) console.log('  Panel admin: http://localhost:4100');
console.log('  App Android: conecta el teléfono por USB y ejecuta `pnpm android:usb` (ver docs/modules/11-app-android-pasajero.md)');
console.log('  Ctrl+C para detener.\n');
const stop = () => {
  children.forEach((c) => c.kill('SIGTERM'));
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
