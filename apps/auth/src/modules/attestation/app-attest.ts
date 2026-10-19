import { createHash, createPublicKey, verify as verifySig, X509Certificate } from 'node:crypto';
import { decodeCbor, readDer } from './cbor.js';
import type { AttestationResult, AttestationVerifier } from './verifiers.js';

/** OID 1.2.840.113635.100.8.2 (nonce de App Attest) en DER. */
const NONCE_OID = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02]);
const AAGUID = { production: Buffer.concat([Buffer.from('appattest'), Buffer.alloc(7)]), development: Buffer.from('appattestdevelop') };

export interface AppAttestKey {
  keyId: string;
  appId: string;
  publicKeyDer: Buffer;
  signCount: number;
}

export interface AppAttestKeyStore {
  get(keyId: string): Promise<AppAttestKey | null>;
  insert(key: AppAttestKey & { receipt: Buffer | null; environment: string }): Promise<void>;
  /** Actualiza el contador solo si aumenta (atómico). Devuelve false si otro uso lo adelantó. */
  advanceCounter(keyId: string, from: number, to: number): Promise<boolean>;
}

interface AuthData {
  rpIdHash: Buffer;
  flags: number;
  counter: number;
  aaguid?: Buffer;
  credentialId?: Buffer;
}

function parseAuthData(a: Buffer): AuthData {
  if (a.length < 37) throw new Error('authData corto');
  const out: AuthData = { rpIdHash: a.subarray(0, 32), flags: a[32]!, counter: a.readUInt32BE(33) };
  if (a.length >= 55) {
    out.aaguid = a.subarray(37, 53);
    const len = a.readUInt16BE(53);
    out.credentialId = a.subarray(55, 55 + len);
  }
  return out;
}

const sha256 = (...parts: Buffer[]) => createHash('sha256').update(Buffer.concat(parts)).digest();

/** Extrae el nonce (32 bytes) de la extensión 1.2.840.113635.100.8.2 del certificado. */
export function extractNonce(certDer: Buffer): Buffer {
  const at = certDer.indexOf(NONCE_OID);
  if (at < 0) throw new Error('certificado sin extensión de nonce');
  let tlv = readDer(certDer, at + NONCE_OID.length);
  if (tlv.tag === 0x01) tlv = readDer(certDer, tlv.end); // campo "critical" opcional
  if (tlv.tag !== 0x04) throw new Error('extensión mal formada');
  const seq = readDer(certDer, tlv.start);
  const tagged = readDer(certDer, seq.start);
  const octet = readDer(certDer, tagged.start);
  if (seq.tag !== 0x30 || tagged.tag !== 0xa1 || octet.tag !== 0x04 || octet.end - octet.start !== 32) throw new Error('nonce mal formado');
  return certDer.subarray(octet.start, octet.end);
}

/**
 * Verificador de App Attest (iOS) según la guía de Apple:
 * - Primera vez (token `{keyId, attestation}`): valida la cadena X.509 hasta la Apple App Attestation Root CA,
 *   el nonce = SHA256(authData ‖ SHA256(nonceServidor)), keyId = SHA256(clave pública), rpIdHash = SHA256(appId),
 *   contador 0 y AAGUID del entorno; guarda la clave pública.
 * - Siguientes (token `{keyId, assertion}`): firma ECDSA sobre SHA256(authData ‖ SHA256(nonceServidor)) y contador creciente.
 */
export class AppAttestVerifier implements AttestationVerifier {
  constructor(
    private readonly store: AppAttestKeyStore,
    private readonly opts: { appIds: string[]; rootCaPem: string; environment: 'production' | 'development'; now?: () => Date },
  ) {}

  async verify({ appId, token, nonce }: { appId: string; token: string; nonce: string }): Promise<AttestationResult> {
    if (!this.opts.appIds.includes(appId)) return { passed: false, flags: ['app_id_mismatch'] };
    let parsed: { keyId?: string; attestation?: string; assertion?: string };
    try {
      parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    } catch {
      return { passed: false, flags: ['malformed_token'] };
    }
    if (typeof parsed.keyId !== 'string') return { passed: false, flags: ['malformed_token'] };
    const clientDataHash = sha256(Buffer.from(nonce, 'utf8'));
    try {
      if (parsed.attestation) return await this.#attest(appId, parsed.keyId, Buffer.from(parsed.attestation, 'base64'), clientDataHash);
      if (parsed.assertion) return await this.#assert(appId, parsed.keyId, Buffer.from(parsed.assertion, 'base64'), clientDataHash);
    } catch {
      return { passed: false, flags: ['app_attest_invalid'] };
    }
    return { passed: false, flags: ['malformed_token'] };
  }

  async #attest(appId: string, keyIdB64: string, obj: Buffer, clientDataHash: Buffer): Promise<AttestationResult> {
    const att = decodeCbor(obj) as Map<string, unknown>;
    if (att.get('fmt') !== 'apple-appattest') return { passed: false, flags: ['wrong_format'] };
    const stmt = att.get('attStmt') as Map<string, unknown>;
    const x5c = (stmt.get('x5c') as Uint8Array[]).map((c) => new X509Certificate(Buffer.from(c)));
    const authData = Buffer.from(att.get('authData') as Uint8Array);
    if (x5c.length < 2) return { passed: false, flags: ['chain_invalid'] };

    // 1. Cadena: hoja → intermedio(s) → raíz de Apple (fijada en configuración).
    const root = new X509Certificate(this.opts.rootCaPem);
    const chain = [...x5c, root];
    const now = (this.opts.now ?? (() => new Date()))();
    for (let i = 0; i < chain.length - 1; i++) {
      const cert = chain[i]!;
      const issuer = chain[i + 1]!;
      if (!cert.checkIssued(issuer) || !cert.verify(issuer.publicKey)) return { passed: false, flags: ['chain_invalid'] };
      if (new Date(cert.validFrom) > now || new Date(cert.validTo) < now) return { passed: false, flags: ['cert_expired'] };
    }
    const leaf = x5c[0]!;
    // 2. Nonce ligado al reto del servidor.
    if (!extractNonce(Buffer.from(leaf.raw)).equals(sha256(authData, clientDataHash))) return { passed: false, flags: ['nonce_mismatch'] };
    // 3. keyId = SHA256(clave pública sin comprimir).
    const jwk = leaf.publicKey.export({ format: 'jwk' });
    const point = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
    const keyId = Buffer.from(keyIdB64, 'base64');
    if (!sha256(point).equals(keyId)) return { passed: false, flags: ['key_id_mismatch'] };
    // 4-6. authData: app, contador, entorno y credentialId.
    const ad = parseAuthData(authData);
    if (!ad.rpIdHash.equals(sha256(Buffer.from(appId)))) return { passed: false, flags: ['app_id_mismatch'] };
    if (ad.counter !== 0) return { passed: false, flags: ['counter_invalid'] };
    if (!ad.aaguid?.equals(AAGUID[this.opts.environment])) return { passed: false, flags: ['environment_mismatch'] };
    if (!ad.credentialId?.equals(keyId)) return { passed: false, flags: ['key_id_mismatch'] };
    if (await this.store.get(keyIdB64)) return { passed: false, flags: ['key_reused'] };

    const receipt = stmt.get('receipt');
    await this.store.insert({
      keyId: keyIdB64,
      appId,
      publicKeyDer: leaf.publicKey.export({ format: 'der', type: 'spki' }),
      signCount: 0,
      receipt: receipt instanceof Uint8Array ? Buffer.from(receipt) : null,
      environment: this.opts.environment,
    });
    return { passed: true, flags: [] };
  }

  async #assert(appId: string, keyIdB64: string, obj: Buffer, clientDataHash: Buffer): Promise<AttestationResult> {
    const key = await this.store.get(keyIdB64);
    if (!key || key.appId !== appId) return { passed: false, flags: ['unknown_key'] };
    const a = decodeCbor(obj) as Map<string, unknown>;
    const signature = Buffer.from(a.get('signature') as Uint8Array);
    const authData = Buffer.from(a.get('authenticatorData') as Uint8Array);
    const ad = parseAuthData(authData);
    const publicKey = createPublicKey({ key: key.publicKeyDer, format: 'der', type: 'spki' });
    if (!verifySig('sha256', sha256(authData, clientDataHash), publicKey, signature)) return { passed: false, flags: ['signature_invalid'] };
    if (!ad.rpIdHash.equals(sha256(Buffer.from(appId)))) return { passed: false, flags: ['app_id_mismatch'] };
    if (ad.counter <= key.signCount) return { passed: false, flags: ['counter_replay'] };
    if (!(await this.store.advanceCounter(keyIdB64, key.signCount, ad.counter))) return { passed: false, flags: ['counter_replay'] };
    return { passed: true, flags: [] };
  }
}
