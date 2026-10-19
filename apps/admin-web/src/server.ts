/**
 * Servidor del panel de administración: solo archivos estáticos con cabeceras estrictas.
 * No guarda sesiones ni tokens (todo vive en la memoria del navegador) y no hace de proxy hacia la API:
 * el navegador llama a auth/api/sos directamente con DPoP y CORS restringido al origen del panel.
 * En producción va detrás de ZTNA (acceso solo para personal autorizado y dispositivos gestionados).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PanelConfig {
  services: { auth: string; api: string; sos: string };
  /** Solo desarrollo: URL del simulador para usar sus passkeys por software (puente). */
  devAuthenticatorUrl: string | null;
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PanelConfig {
  const prod = env.NODE_ENV === 'production';
  const url = (k: string, d: string) => {
    const v = env[k] ?? (prod ? undefined : d);
    if (!v) throw new Error(`Falta ${k}`);
    if (prod && !v.startsWith('https://')) throw new Error(`${k} debe usar https en producción`);
    return new URL(v).origin;
  };
  const dev = env.ADMIN_DEV_AUTHENTICATOR_URL ?? null;
  if (prod && dev) throw new Error('El puente de autenticador de desarrollo no se permite en producción');
  return { services: { auth: url('ADMIN_AUTH_URL', 'http://localhost:3001'), api: url('ADMIN_API_URL', 'http://localhost:3002'), sos: url('ADMIN_SOS_URL', 'http://localhost:3003') }, devAuthenticatorUrl: dev };
}

export function securityHeaders(cfg: PanelConfig): Record<string, string> {
  const connect = ["'self'", cfg.services.auth, cfg.services.api, cfg.services.sos].join(' ');
  return {
    'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ${connect}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
    'Cache-Control': 'no-store',
  };
}

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
// El cliente DPoP/PKCE compartido con las apps (paquete @intitaxi/auth-client), servido como módulo ES.
const authClientDir = fileURLToPath(new URL('../node_modules/@intitaxi/auth-client/dist/', import.meta.url));

/** Resuelve una ruta dentro de un directorio; null si intenta salir de él (path traversal). */
export function safeJoin(root: string, path: string): string | null {
  const p = normalize(join(root, decodeURIComponent(path)));
  return p.startsWith(root.endsWith(sep) ? root : root + sep) ? p : null;
}

export function createPanelServer(cfg: PanelConfig) {
  const headers = securityHeaders(cfg);
  const send = (res: ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { ...headers, 'Content-Type': type });
    res.end(body);
  };

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://panel.local');
      if (url.pathname === '/healthz') return send(res, 200, 'ok');
      if (url.pathname === '/config.json' && req.method === 'GET') {
        return send(res, 200, JSON.stringify({ services: cfg.services, devAuthenticator: !!cfg.devAuthenticatorUrl }), TYPES['.json']);
      }
      if (url.pathname.startsWith('/dev/authenticator/')) {
        if (!cfg.devAuthenticatorUrl) return send(res, 404, 'No encontrado');
        return devBridge(cfg.devAuthenticatorUrl, url.pathname.slice('/dev/authenticator/'.length), req, res, send);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método no permitido');
      const [root, rel] = url.pathname.startsWith('/lib/auth-client/') ? [authClientDir, url.pathname.slice('/lib/auth-client/'.length)] : [publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1)];
      const file = safeJoin(root, rel);
      const type = file ? TYPES[extname(file)] : undefined;
      if (!file || !type) return send(res, 404, 'No encontrado');
      return send(res, 200, await readFile(file), type);
    } catch (e) {
      const code = (e as { code?: string }).code;
      return send(res, code === 'ENOENT' ? 404 : code === 'ERR_INVALID_URL' || e instanceof URIError ? 400 : 500, code === 'ENOENT' ? 'No encontrado' : 'Error');
    }
  });
}

/** Reenvía al simulador (solo desarrollo) la lista de passkeys simuladas y la firma de un reto. */
async function devBridge(base: string, op: string, req: IncomingMessage, res: ServerResponse, send: (res: ServerResponse, s: number, b: string, t?: string) => void) {
  if (op === 'devices' && req.method === 'GET') {
    const r = await fetch(`${base}/sim/dev-authenticator/devices`);
    return send(res, r.status, await r.text(), TYPES['.json']);
  }
  if (op === 'assert' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 16_384) return send(res, 413, 'Demasiado grande');
      chunks.push(c as Buffer);
    }
    const r = await fetch(`${base}/sim/dev-authenticator/assert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: Buffer.concat(chunks) });
    return send(res, r.status, await r.text(), TYPES['.json']);
  }
  return send(res, 404, 'No encontrado');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cfg = loadConfig();
  const port = Number(process.env.PORT ?? 4100);
  const host = process.env.HOST ?? '127.0.0.1';
  createPanelServer(cfg).listen(port, host, () => console.log(`Panel de administración en http://${host === '127.0.0.1' ? 'localhost' : host}:${port}`));
}
