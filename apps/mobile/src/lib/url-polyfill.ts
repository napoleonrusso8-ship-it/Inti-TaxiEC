// URL y URLSearchParams mínimos para Hermes (solo lo que usa el cliente DPoP/PKCE).
/** URL mínimo para URLs absolutas http(s)/ws(s); solo se instala si el de la plataforma está incompleto. */
export class MiniURL {
  readonly protocol: string;
  readonly hostname: string;
  readonly port: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  constructor(input: string) {
    const m = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#:]+)(?::(\d+))?([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(String(input));
    if (!m) throw new TypeError(`URL inválida: ${input}`);
    this.protocol = m[1]!.toLowerCase();
    this.hostname = m[2]!.toLowerCase();
    this.port = m[3] ?? '';
    this.pathname = m[4] || '/';
    this.search = m[5] ?? '';
    this.hash = m[6] ?? '';
  }
  get host() {
    return this.port ? `${this.hostname}:${this.port}` : this.hostname;
  }
  get origin() {
    return `${this.protocol}//${this.host}`;
  }
  get href() {
    return `${this.origin}${this.pathname}${this.search}${this.hash}`;
  }
  toString() {
    return this.href;
  }
}

export function urlWorks() {
  try {
    const u = new URL('https://a.example:8443/p/q?x=1');
    return u.host === 'a.example:8443' && u.pathname === '/p/q' && u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function searchParamsWork() {
  try {
    return new URLSearchParams({ a: 'b c', d: 'é' }).toString() === 'a=b+c&d=%C3%A9';
  } catch {
    return false;
  }
}
export class MiniSearchParams {
  #pairs: [string, string][];
  constructor(init: Record<string, string> = {}) {
    this.#pairs = Object.entries(init).map(([k, v]) => [k, String(v)]);
  }
  toString() {
    const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');
    return this.#pairs.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
  }
}

/** Instala las versiones mínimas solo si las de la plataforma están incompletas. */
export function installUrlPolyfills(g: any) {
  if (!urlWorks()) g.URL = MiniURL;
  if (!searchParamsWork()) g.URLSearchParams = MiniSearchParams;
}
