import { AccessTokenVerifier } from '@intitaxi/auth-verifier';
import { sha256 } from '@intitaxi/crypto';
import { Redis } from 'ioredis';
import { createRemoteJWKSet } from 'jose';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
import { Gateway } from './gateway.js';

const config = loadConfig();
const redis = new Redis(config.REDIS_URL, { tls: config.REDIS_TLS ? {} : undefined });
const sub = redis.duplicate();
const verifier = new AccessTokenVerifier({
  issuer: config.AUTH_ISSUER,
  audience: config.API_AUDIENCE,
  keys: createRemoteJWKSet(new URL(config.AUTH_JWKS_URL), { cooldownDuration: 30_000 }),
  replayStore: Gateway.replayStore(redis),
  revocation: { isSessionRevoked: async (sid) => (await redis.exists(`revoked:sid:${sid}`)) === 1 },
});
const gateway = new Gateway(config, redis, verifier);

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const leafletDir = dirname(createRequire(import.meta.url).resolve('leaflet/dist/leaflet.js'));
const STATIC: Record<string, [string, string]> = {
  '/static/track.js': [join(publicDir, 'track.js'), 'text/javascript'],
  '/static/track.css': [join(publicDir, 'track.css'), 'text/css'],
  '/static/leaflet.js': [join(leafletDir, 'leaflet.js'), 'text/javascript'],
  '/static/leaflet.css': [join(leafletDir, 'leaflet.css'), 'text/css'],
};

function clientIp(req: IncomingMessage) {
  const xff = (req.headers['x-forwarded-for'] as string | undefined)?.split(',').map((s) => s.trim()) ?? [];
  return config.TRUST_PROXY_HOPS > 0 && xff.length >= config.TRUST_PROXY_HOPS ? xff[xff.length - config.TRUST_PROXY_HOPS]! : req.socket.remoteAddress ?? '';
}

function securityHeaders(res: ServerResponse) {
  const tiles = new URL(config.MAP_TILES_URL.replace(/\{[a-z]\}/g, '0')).origin;
  res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: ${tiles}; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
  res.setHeader('Referrer-Policy', 'no-referrer'); // el token del enlace no debe filtrarse a terceros
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.setHeader('Cache-Control', 'no-store');
}

const server = createServer(async (req, res) => {
  securityHeaders(res);
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/healthz') return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
  const st = STATIC[url.pathname];
  if (st && req.method === 'GET') return res.writeHead(200, { 'Content-Type': st[1] }).end(await readFile(st[0]));
  const m = /^\/t\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
  if (m && req.method === 'GET') {
    const valid = await redis.exists(`rt:share:${sha256(m[1]!).toString('base64url')}`);
    if (!valid) return res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><title>Enlace vencido</title><p>Este enlace de seguimiento venció o no existe.</p>');
    const html = (await readFile(join(publicDir, 'track.html'), 'utf8')).replace('{{TILES}}', config.MAP_TILES_URL.replace(/[<>"']/g, ''));
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
  }
  res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"title":"not_found"}');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname !== '/v1/ws') return socket.destroy();
  const ip = clientIp(req);
  // Límite de conexiones nuevas por IP (anti DoS).
  const k = `rt:conn:${ip}:${Math.floor(Date.now() / 60_000)}`;
  if ((await redis.multi().incr(k).expire(k, 120).exec())?.[0]?.[1] as number > 60) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => void gateway.onConnection(ws, req, ip));
});

await sub.psubscribe('rt:trip:*', 'rt:ops:incidents');
sub.on('pmessage', (_p, channel, message) => gateway.deliver(channel, message));

// Latido: cierra conexiones muertas.
setInterval(() => {
  for (const c of gateway.conns) {
    if ((c.ws as unknown as { isAlive?: boolean }).isAlive === false) c.ws.terminate();
    (c.ws as unknown as { isAlive?: boolean }).isAlive = false;
    c.ws.ping();
  }
}, 30_000).unref();
wss.on('connection', (ws) => ws.on('pong', () => ((ws as unknown as { isAlive?: boolean }).isAlive = true)));

server.listen(config.PORT, () => console.log(`realtime escuchando en :${config.PORT}`));
const stop = () => {
  wss.close();
  server.close();
  void redis.quit();
  void sub.quit();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
