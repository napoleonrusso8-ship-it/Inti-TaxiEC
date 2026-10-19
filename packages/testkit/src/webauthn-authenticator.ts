// Autenticador WebAuthn por software, solo para pruebas: genera respuestas reales (CBOR/COSE + ECDSA)
// para ejercitar la verificación del servidor de extremo a extremo.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor> | { [k: string]: Cbor };

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

export function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();

export class SoftwareAuthenticator {
  readonly credentialId = randomBytes(16);
  readonly #priv: KeyObject;
  readonly #pub: KeyObject;
  counter = 0;
  userHandle = '';

  constructor(
    readonly rpId: string,
    readonly origin: string,
  ) {
    const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.#priv = kp.privateKey;
    this.#pub = kp.publicKey;
  }

  get id() {
    return b64u(this.credentialId);
  }

  #clientData(type: string, challenge: string, origin = this.origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  register(options: { challenge: string; user: { id: string } }) {
    this.userHandle = options.user.id;
    const jwk = this.#pub.export({ format: 'jwk' });
    const cose = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]));
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.credentialId.length);
    const counter = Buffer.alloc(4);
    const authData = Buffer.concat([sha(this.rpId), Buffer.from([0x01 | 0x04 | 0x40]), counter, Buffer.alloc(16), len, this.credentialId, cose]);
    const attestationObject = cbor({ fmt: 'none', attStmt: {}, authData });
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: { clientDataJSON: b64u(this.#clientData('webauthn.create', options.challenge)), attestationObject: b64u(attestationObject), transports: ['internal'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** `origin` permite firmar como si el navegador estuviera en otro origen del mismo rpId (puente de desarrollo del panel web). */
  assert(options: { challenge: string }, opts: { userVerified?: boolean; counter?: number; origin?: string } = {}) {
    this.counter = opts.counter ?? this.counter + 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const flags = 0x01 | (opts.userVerified === false ? 0 : 0x04);
    const authData = Buffer.concat([sha(this.rpId), Buffer.from([flags]), counter]);
    const clientData = this.#clientData('webauthn.get', options.challenge, opts.origin);
    const signature = sign('sha256', Buffer.concat([authData, sha(clientData)]), this.#priv);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: this.userHandle },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
