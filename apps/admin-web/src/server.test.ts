import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPanelServer, loadConfig, safeJoin } from './server.js';

const cfg = loadConfig({ NODE_ENV: 'development' });
const server = createPanelServer(cfg);
let base = '';
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

describe('servidor del panel', () => {
  it('sirve la página con CSP estricta (sin inline, connect-src solo a los servicios)', async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain('connect-src \'self\' http://localhost:3001 http://localhost:3002 http://localhost:3003');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('sirve el cliente DPoP compartido como módulo ES', async () => {
    const r = await fetch(`${base}/lib/auth-client/index.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/javascript');
  });

  it('no permite salir del directorio público (path traversal) ni servir tipos desconocidos', async () => {
    expect(safeJoin('/srv/public/', '../secret')).toBeNull();
    expect(safeJoin('/srv/public/', '%2e%2e/secret')).toBeNull();
    expect(safeJoin('/srv/public/', 'js/app.js')).toBe('/srv/public/js/app.js');
    for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/src/server.ts', '/lib/auth-client/..%2f..%2fpackage.json', '/js/app.js.map']) {
      expect((await fetch(`${base}${p}`)).status).toBe(404);
    }
  });

  it('el puente de autenticador no existe si no está configurado y solo se acepta GET en estáticos', async () => {
    expect((await fetch(`${base}/dev/authenticator/devices`)).status).toBe(404);
    expect((await fetch(`${base}/index.html`, { method: 'POST' })).status).toBe(405);
  });

  it('en producción exige https y prohíbe el puente de desarrollo', () => {
    const prod = { NODE_ENV: 'production', ADMIN_AUTH_URL: 'https://auth.intitaxi.ec', ADMIN_API_URL: 'https://api.intitaxi.ec', ADMIN_SOS_URL: 'https://sos.intitaxi.ec' };
    expect(loadConfig(prod).services.api).toBe('https://api.intitaxi.ec');
    expect(() => loadConfig({ ...prod, ADMIN_API_URL: 'http://api.intitaxi.ec' })).toThrow(/https/);
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/Falta/);
    expect(() => loadConfig({ ...prod, ADMIN_DEV_AUTHENTICATOR_URL: 'http://localhost:4000' })).toThrow(/desarrollo/);
  });
});
