import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cbor } from '@intitaxi/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppAttestVerifier, type AppAttestKey, type AppAttestKeyStore } from './app-attest.js';
import { decodeCbor } from './cbor.js';

// Genera con openssl una PKI de prueba que imita la de Apple: raíz → intermedia → hoja con la extensión de nonce.
const APP_ID = 'ABCDE12345.ec.intitaxi.passenger';
const sha = (...b: Buffer[]) => createHash('sha256').update(Buffer.concat(b)).digest();
let dir: string;
let rootPem: string;
let otherRootPem: string;

function openssl(args: string[]) {
  execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'appattest-'));
  writeFileSync(join(dir, 'ca.ext'), 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  for (const name of ['root', 'other']) {
    openssl(['ecparam', '-name', 'secp384r1', '-genkey', '-noout', '-out', `${name}.key`]);
    openssl(['req', '-x509', '-new', '-key', `${name}.key`, '-subj', `/CN=Test ${name} CA`, '-days', '2', '-out', `${name}.pem`]);
  }
  openssl(['ecparam', '-name', 'secp384r1', '-genkey', '-noout', '-out', 'int.key']);
  openssl(['req', '-new', '-key', 'int.key', '-subj', '/CN=Test Intermediate', '-out', 'int.csr']);
  openssl(['x509', '-req', '-in', 'int.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-days', '2', '-extfile', 'ca.ext', '-out', 'int.pem']);
  rootPem = readFileSync(join(dir, 'root.pem'), 'utf8');
  otherRootPem = readFileSync(join(dir, 'other.pem'), 'utf8');
});

class MemStore implements AppAttestKeyStore {
  keys = new Map<string, AppAttestKey>();
  async get(k: string) { return this.keys.get(k) ?? null; }
  async insert(k: AppAttestKey) { this.keys.set(k.keyId, { ...k }); }
  async advanceCounter(k: string, from: number, to: number) {
    const key = this.keys.get(k);
    if (!key || key.signCount !== from || to <= from) return false;
    key.signCount = to;
    return true;
  }
}

/** Simula DCAppAttestService: genera la clave, el certificado hoja con el nonce y el objeto de atestación. */
function makeAttestation(serverNonce: string, opts: { appId?: string; aaguid?: Buffer; nonceOverride?: Buffer; counter?: number } = {}) {
  const id = randomBytes(4).toString('hex');
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `leaf${id}.key`]);
  const key = createPrivateKey(readFileSync(join(dir, `leaf${id}.key`)));
  const jwk = key.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  const keyId = sha(point);
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(opts.counter ?? 0);
  const idLen = Buffer.alloc(2);
  idLen.writeUInt16BE(32);
  const authData = Buffer.concat([sha(Buffer.from(opts.appId ?? APP_ID)), Buffer.from([0x40]), counter, opts.aaguid ?? Buffer.from('appattestdevelop'), idLen, keyId]);
  const nonce = opts.nonceOverride ?? sha(authData, sha(Buffer.from(serverNonce)));
  writeFileSync(join(dir, `leaf${id}.ext`), `1.2.840.113635.100.8.2=DER:3024a1220420${nonce.toString('hex')}\n`);
  openssl(['req', '-new', '-key', `leaf${id}.key`, '-subj', '/CN=attested key', '-out', `leaf${id}.csr`]);
  openssl(['x509', '-req', '-in', `leaf${id}.csr`, '-CA', 'int.pem', '-CAkey', 'int.key', '-CAcreateserial', '-days', '1', '-extfile', `leaf${id}.ext`, '-out', `leaf${id}.pem`]);
  const der = (f: string) => {
    const pem = readFileSync(join(dir, f), 'utf8');
    return Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  };
  const attestation = cbor({ fmt: 'apple-appattest', attStmt: { x5c: [der(`leaf${id}.pem`), der('int.pem')], receipt: Buffer.from('receipt') }, authData });
  const token = Buffer.from(JSON.stringify({ keyId: keyId.toString('base64'), attestation: attestation.toString('base64') })).toString('base64url');
  return { token, key, keyId: keyId.toString('base64') };
}

function makeAssertion(key: ReturnType<typeof createPrivateKey>, keyId: string, serverNonce: string, counter: number) {
  const c = Buffer.alloc(4);
  c.writeUInt32BE(counter);
  const authData = Buffer.concat([sha(Buffer.from(APP_ID)), Buffer.from([0x00]), c]);
  const signature = sign('sha256', sha(authData, sha(Buffer.from(serverNonce))), key);
  const assertion = cbor({ signature, authenticatorData: authData });
  return Buffer.from(JSON.stringify({ keyId, assertion: assertion.toString('base64') })).toString('base64url');
}

const verifierWith = (store: AppAttestKeyStore, root = () => rootPem) =>
  new AppAttestVerifier(store, { appIds: [APP_ID], rootCaPem: root(), environment: 'development' });

describe('App Attest', () => {
  it('acepta una atestación válida y luego aserciones con contador creciente', async () => {
    const store = new MemStore();
    const v = verifierWith(store);
    const a = makeAttestation('nonce-1');
    expect(await v.verify({ appId: APP_ID, token: a.token, nonce: 'nonce-1' })).toEqual({ passed: true, flags: [] });
    expect((await v.verify({ appId: APP_ID, token: makeAssertion(a.key, a.keyId, 'nonce-2', 1), nonce: 'nonce-2' })).passed).toBe(true);
    // repetición del contador
    expect((await v.verify({ appId: APP_ID, token: makeAssertion(a.key, a.keyId, 'nonce-3', 1), nonce: 'nonce-3' })).flags).toContain('counter_replay');
    // aserción firmada para otro nonce
    expect((await v.verify({ appId: APP_ID, token: makeAssertion(a.key, a.keyId, 'nonce-4', 5), nonce: 'otro' })).flags).toContain('signature_invalid');
  });

  it('rechaza una cadena que no termina en la raíz de Apple configurada', async () => {
    const v = verifierWith(new MemStore(), () => otherRootPem);
    expect((await v.verify({ appId: APP_ID, token: makeAttestation('n').token, nonce: 'n' })).flags).toContain('chain_invalid');
  });

  it('rechaza una atestación para otro nonce (repetición)', async () => {
    const v = verifierWith(new MemStore());
    expect((await v.verify({ appId: APP_ID, token: makeAttestation('n1').token, nonce: 'n2' })).flags).toContain('nonce_mismatch');
  });

  it('rechaza otra app, otro entorno o contador distinto de 0', async () => {
    const v = verifierWith(new MemStore());
    expect((await v.verify({ appId: APP_ID, token: makeAttestation('n', { appId: 'X.otra.app' }).token, nonce: 'n' })).flags).toContain('app_id_mismatch');
    expect((await v.verify({ appId: APP_ID, token: makeAttestation('n', { aaguid: Buffer.concat([Buffer.from('appattest'), Buffer.alloc(7)]) }).token, nonce: 'n' })).flags).toContain('environment_mismatch');
    expect((await v.verify({ appId: APP_ID, token: makeAttestation('n', { counter: 3 }).token, nonce: 'n' })).flags).toContain('counter_invalid');
  });

  it('no permite registrar dos veces la misma clave', async () => {
    const store = new MemStore();
    const v = verifierWith(store);
    const a = makeAttestation('n');
    await v.verify({ appId: APP_ID, token: a.token, nonce: 'n' });
    expect((await v.verify({ appId: APP_ID, token: a.token, nonce: 'n' })).passed).toBe(false);
  });

  it('rechaza tokens mal formados sin lanzar excepciones', async () => {
    const v = verifierWith(new MemStore());
    for (const token of ['', 'no-base64-json', Buffer.from('{"keyId":"x","attestation":"AAAA"}').toString('base64url')]) {
      expect((await v.verify({ appId: APP_ID, token, nonce: 'n' })).passed).toBe(false);
    }
  });
});

describe('decodeCbor', () => {
  it('decodifica lo que codifica el autenticador de pruebas', () => {
    const m = decodeCbor(cbor({ a: 1, b: Buffer.from([1, 2]), c: [-5, 'x'] })) as Map<string, unknown>;
    expect(m.get('a')).toBe(1);
    expect(m.get('c')).toEqual([-5, 'x']);
  });
  it('rechaza datos truncados, sobrantes o anidamiento excesivo', () => {
    expect(() => decodeCbor(Buffer.from([0x59, 0xff]))).toThrow();
    expect(() => decodeCbor(Buffer.from([0x01, 0x01]))).toThrow();
    expect(() => decodeCbor(Buffer.from(Array(40).fill(0x81).concat([0x01])))).toThrow();
  });
});
