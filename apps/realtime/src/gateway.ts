import { AccessTokenVerifier, AuthError, type AuthContext, type DpopReplayStore } from '@intitaxi/auth-verifier';
import { sha256 } from '@intitaxi/crypto';
import type { IncomingMessage } from 'node:http';
import type { Redis } from 'ioredis';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { Config } from './config.js';
import { redactPii } from './pii-filter.js';

export type Conn = {
  ws: WebSocket;
  ip: string;
  kind: 'pending' | 'user' | 'share';
  auth?: AuthContext;
  exp?: number;
  shareTripId?: string;
  channels: Set<string>;
  timer?: NodeJS.Timeout;
  /** Se resuelve al terminar la autenticación inicial; los mensajes que llegan antes esperan. */
  ready: Promise<void>;
};

const Inbound = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), authorization: z.string().max(4096), dpop: z.string().max(4096) }),
  z.object({ type: z.literal('reauth'), authorization: z.string().max(4096), dpop: z.string().max(4096) }),
  z.object({ type: z.literal('subscribe'), channel: z.string().regex(/^(trip:[0-9a-f-]{36}|ops:incidents)$/) }),
  z.object({ type: z.literal('unsubscribe'), channel: z.string().max(60) }),
  z.object({ type: z.literal('chat'), tripId: z.string().uuid(), text: z.string().min(1).max(500) }),
  z.object({ type: z.literal('ping') }),
]);

export class Gateway {
  readonly conns = new Set<Conn>();
  readonly #byChannel = new Map<string, Set<Conn>>();
  readonly #perUser = new Map<string, number>();

  constructor(
    private readonly config: Config,
    private readonly redis: Redis,
    private readonly verifier: AccessTokenVerifier,
  ) {}

  static replayStore(redis: Redis): DpopReplayStore {
    return { markUsed: async (jti, ttl) => (await redis.set(`dpop:jti:${jti}`, '1', 'EX', ttl, 'NX')) === 'OK' };
  }

  #send(c: Conn, msg: unknown) {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  }

  #close(c: Conn, code: number, reason: string) {
    this.#send(c, { type: 'error', code: reason });
    c.ws.close(code, reason);
  }

  /** Autentica con token DPoP (cabeceras del upgrade o primer mensaje) y programa el cierre al vencer el token. */
  async #authenticate(c: Conn, authorization: string | undefined, dpop: string | undefined) {
    const auth = await this.verifier.verify({ authorization, dpop, method: 'GET', url: `${this.config.PUBLIC_BASE_URL}/v1/ws` });
    if (c.auth && c.auth.userId !== auth.userId) throw new AuthError('invalid_token', 'reauth con otro usuario');
    if (!c.auth) {
      const n = this.#perUser.get(auth.userId) ?? 0;
      if (n >= this.config.MAX_CONNECTIONS_PER_USER) throw new AuthError('invalid_token', 'demasiadas conexiones');
      this.#perUser.set(auth.userId, n + 1);
    }
    c.auth = auth;
    c.kind = 'user';
    const [, payload] = authorization!.split(' ')[1]!.split('.');
    c.exp = JSON.parse(Buffer.from(payload!, 'base64url').toString()).exp;
    clearTimeout(c.timer);
    // Al vencer el token se cierra la conexión salvo que el cliente envíe "reauth" con un token nuevo.
    c.timer = setTimeout(() => this.#close(c, 4001, 'token_expired'), Math.max(c.exp! * 1000 - Date.now(), 0) + 5_000);
    c.timer.unref();
  }

  async onConnection(ws: WebSocket, req: IncomingMessage, ip: string) {
    let markReady!: () => void;
    const c: Conn = { ws, ip, kind: 'pending', channels: new Set(), ready: new Promise<void>((r) => (markReady = r)) };
    this.conns.add(c);
    ws.on('close', () => this.#cleanup(c));
    ws.on('error', () => this.#cleanup(c));
    ws.on('message', (data, isBinary) => void c.ready.then(() => this.#onMessage(c, data.toString(), isBinary)));

    const url = new URL(req.url ?? '/', 'http://x');
    const share = url.searchParams.get('share');
    try {
      if (share) {
        // Enlace de seguimiento (tercero sin app / contacto de confianza): solo lectura de UN viaje.
        if (!/^[A-Za-z0-9_-]{43}$/.test(share)) throw new AuthError('invalid_token', 'enlace');
        const tripId = await this.redis.get(`rt:share:${sha256(share).toString('base64url')}`);
        if (!tripId) throw new AuthError('invalid_token', 'enlace vencido');
        c.kind = 'share';
        c.shareTripId = tripId;
        await this.#subscribe(c, `trip:${tripId}`);
      } else if (req.headers.authorization) {
        await this.#authenticate(c, req.headers.authorization, req.headers.dpop as string | undefined);
        this.#send(c, { type: 'ready', userId: c.auth!.userId });
      } else {
        // Navegadores no pueden fijar cabeceras en WebSocket: 5 s para autenticarse por mensaje.
        c.timer = setTimeout(() => c.kind === 'pending' && this.#close(c, 4001, 'auth_timeout'), 5_000);
        c.timer.unref();
      }
    } catch {
      this.#close(c, 4001, 'unauthorized');
    } finally {
      markReady();
    }
  }

  async #onMessage(c: Conn, raw: string, isBinary: boolean) {
    if (isBinary || raw.length > 8192) return this.#close(c, 1009, 'too_large');
    if ((await this.redis.incr(`rt:rate:${c.ip}:${Math.floor(Date.now() / 10_000)}`)) > 100) return this.#close(c, 4029, 'rate_limited');
    let msg: z.infer<typeof Inbound>;
    try {
      msg = Inbound.parse(JSON.parse(raw));
    } catch {
      return this.#send(c, { type: 'error', code: 'invalid_message' });
    }
    try {
      if (msg.type === 'ping') return this.#send(c, { type: 'pong' });
      if (msg.type === 'auth' || msg.type === 'reauth') {
        if (c.kind === 'share') return this.#send(c, { type: 'error', code: 'forbidden' });
        await this.#authenticate(c, msg.authorization, msg.dpop);
        return this.#send(c, { type: msg.type === 'auth' ? 'ready' : 'reauthenticated', userId: c.auth!.userId });
      }
      if (c.kind !== 'user') return this.#send(c, { type: 'error', code: 'forbidden' });
      if (msg.type === 'subscribe') {
        if (!(await this.#canSubscribe(c, msg.channel))) return this.#send(c, { type: 'error', code: 'forbidden', channel: msg.channel });
        return this.#subscribe(c, msg.channel);
      }
      if (msg.type === 'unsubscribe') {
        c.channels.delete(msg.channel);
        this.#byChannel.get(msg.channel)?.delete(c);
        return;
      }
      if (msg.type === 'chat') return this.#chat(c, msg.tripId, msg.text);
    } catch {
      this.#close(c, 4001, 'unauthorized');
    }
  }

  /** Autorización por canal: miembros del viaje (lista que mantiene la API) u operadores SOS. */
  async #canSubscribe(c: Conn, channel: string) {
    if (channel === 'ops:incidents') {
      return c.auth!.clientId === 'intitaxi-admin' && (await this.redis.sismember('rt:ops:members', c.auth!.userId)) === 1;
    }
    const tripId = channel.slice(5);
    return (await this.redis.sismember(`rt:trip:${tripId}:members`, c.auth!.userId)) === 1;
  }

  async #subscribe(c: Conn, channel: string) {
    c.channels.add(channel);
    if (!this.#byChannel.has(channel)) this.#byChannel.set(channel, new Set());
    this.#byChannel.get(channel)!.add(c);
    const snapshot = channel.startsWith('trip:') ? await this.redis.get(`rt:${channel}:last`) : null;
    this.#send(c, { type: 'subscribed', channel, snapshot: snapshot ? JSON.parse(snapshot) : null });
  }

  async #chat(c: Conn, tripId: string, text: string) {
    if ((await this.redis.sismember(`rt:trip:${tripId}:members`, c.auth!.userId)) !== 1) return this.#send(c, { type: 'error', code: 'forbidden' });
    const k = `rt:chatrate:${c.auth!.userId}:${Math.floor(Date.now() / 60_000)}`;
    if ((await this.redis.multi().incr(k).expire(k, 120).exec())?.[0]?.[1] as number > 20) return this.#send(c, { type: 'error', code: 'rate_limited' });
    const role = (await this.redis.hget(`rt:trip:${tripId}:roles`, c.auth!.userId)) ?? 'passenger';
    const msg = { type: 'chat', tripId, from: role, text: redactPii(text), at: new Date().toISOString() };
    // Se conserva 30 días para atender reclamos e incidentes (más si hay un reporte o SOS).
    await this.redis.multi().lpush(`rt:chat:${tripId}`, JSON.stringify(msg)).ltrim(`rt:chat:${tripId}`, 0, 199).expire(`rt:chat:${tripId}`, 30 * 86400).exec();
    await this.redis.publish(`rt:trip:${tripId}`, JSON.stringify(msg));
  }

  /** Mensaje publicado por la API en Redis → a los suscriptores del canal. A los enlaces públicos solo estado y ubicación. */
  deliver(channel: string, payload: string) {
    const subs = this.#byChannel.get(channel.replace(/^rt:/, ''));
    if (!subs) return;
    const msg = JSON.parse(payload) as { type: string };
    for (const c of subs) {
      if (c.kind === 'share' && !['status', 'location', 'driver'].includes(msg.type)) continue;
      this.#send(c, { channel: channel.replace(/^rt:/, ''), ...msg });
    }
  }

  #cleanup(c: Conn) {
    if (!this.conns.delete(c)) return;
    clearTimeout(c.timer);
    for (const ch of c.channels) this.#byChannel.get(ch)?.delete(c);
    if (c.auth) this.#perUser.set(c.auth.userId, Math.max((this.#perUser.get(c.auth.userId) ?? 1) - 1, 0));
  }
}
