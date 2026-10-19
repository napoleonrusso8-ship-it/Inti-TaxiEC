import type { ApiClient } from './client';

export type RealtimeMessage =
  | { type: 'ready' | 'reauthenticated'; userId: string }
  | { type: 'subscribed'; channel: string; snapshot: Record<string, unknown> | null }
  | { type: 'status'; status: string; at: string }
  | { type: 'driver'; driver: Record<string, unknown> }
  | { type: 'location'; lat: number; lng: number; heading?: number; at: string }
  | { type: 'chat'; from: string; text: string; at: string }
  | { type: 'error'; code: string; channel?: string }
  | { type: 'pong' };

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
}

/**
 * Conexión de tiempo real con reconexión automática (espera exponencial con tope),
 * re-suscripción a los canales y re-autenticación antes de que caduque el token de acceso.
 */
export class RealtimeClient {
  #ws: SocketLike | null = null;
  #channels = new Set<string>();
  #listeners = new Set<(m: RealtimeMessage) => void>();
  #attempt = 0;
  #closed = false;
  #timers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    private readonly client: ApiClient,
    private readonly open: (url: string) => SocketLike = (url) => new WebSocket(url) as unknown as SocketLike,
  ) {}

  on(fn: (m: RealtimeMessage) => void) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  connect() {
    this.#closed = false;
    const ws = this.open(`${this.client.config.services.realtime.replace(/^http/, 'ws')}/v1/ws`);
    this.#ws = ws;
    ws.onopen = async () => {
      this.#attempt = 0;
      ws.send(JSON.stringify(await this.client.socketAuth('auth')));
    };
    ws.onmessage = (e) => {
      let m: RealtimeMessage;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (m.type === 'ready') {
        for (const c of this.#channels) ws.send(JSON.stringify({ type: 'subscribe', channel: c }));
        // El token dura 10 min: se re-autentica cada 8.
        this.#timers.push(setInterval(async () => ws.readyState === 1 && ws.send(JSON.stringify(await this.client.socketAuth('reauth'))), 8 * 60_000));
      }
      for (const l of this.#listeners) l(m);
    };
    ws.onclose = () => {
      this.#clearTimers();
      if (this.#closed) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.#attempt++);
      this.#timers.push(setTimeout(() => this.connect(), delay));
    };
    ws.onerror = () => {};
  }

  subscribe(channel: string) {
    this.#channels.add(channel);
    if (this.#ws?.readyState === 1) this.#ws.send(JSON.stringify({ type: 'subscribe', channel }));
  }

  unsubscribe(channel: string) {
    this.#channels.delete(channel);
    if (this.#ws?.readyState === 1) this.#ws.send(JSON.stringify({ type: 'unsubscribe', channel }));
  }

  chat(tripId: string, text: string) {
    this.#ws?.send(JSON.stringify({ type: 'chat', tripId, text }));
  }

  close() {
    this.#closed = true;
    this.#clearTimers();
    this.#ws?.close();
  }

  #clearTimers() {
    this.#timers.forEach((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.#timers = [];
  }
}
