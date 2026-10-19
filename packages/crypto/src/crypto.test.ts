import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  BlindIndex,
  FieldCipher,
  KmsKeyProvider,
  LocalKeyProvider,
  keyedMac,
  maskDocument,
  maskEmail,
  maskPhone,
} from './index.js';

const master = randomBytes(32).toString('base64');
const ctx = { service: 'test', purpose: 'pii' };

describe('FieldCipher', () => {
  it('cifra y descifra con el mismo AAD', async () => {
    const c = new FieldCipher(new LocalKeyProvider(master), { context: ctx });
    const blob = await c.encrypt('0912345678', 'identity.persons.doc:1');
    expect(blob.includes(Buffer.from('0912345678'))).toBe(false);
    expect(await c.decrypt(blob, 'identity.persons.doc:1')).toBe('0912345678');
  });

  it('produce textos cifrados distintos para el mismo valor (IV aleatorio)', async () => {
    const c = new FieldCipher(new LocalKeyProvider(master), { context: ctx });
    const a = await c.encrypt('x', 'aad');
    const b = await c.encrypt('x', 'aad');
    expect(a.equals(b)).toBe(false);
  });

  it('rechaza un texto cifrado copiado a otra fila (AAD distinto)', async () => {
    const c = new FieldCipher(new LocalKeyProvider(master), { context: ctx });
    const blob = await c.encrypt('secreto', 'users.phone:A');
    await expect(c.decrypt(blob, 'users.phone:B')).rejects.toThrow();
  });

  it('detecta manipulación de un bit', async () => {
    const c = new FieldCipher(new LocalKeyProvider(master), { context: ctx });
    const blob = await c.encrypt('secreto', 'aad');
    blob[blob.length - 1]! ^= 0x01;
    await expect(c.decrypt(blob, 'aad')).rejects.toThrow();
  });

  it('rechaza DEK envueltas con otro contexto de cifrado', async () => {
    const p = new LocalKeyProvider(master);
    const blob = await new FieldCipher(p, { context: ctx }).encrypt('v', 'aad');
    const other = new FieldCipher(p, { context: { service: 'otro' } });
    await expect(other.decrypt(blob, 'aad')).rejects.toThrow();
  });

  it('rota la DEK al alcanzar el máximo de usos y sigue descifrando lo antiguo', async () => {
    const p = new LocalKeyProvider(master);
    const spy = vi.spyOn(p, 'generateDataKey');
    const c = new FieldCipher(p, { context: ctx, maxUsesPerKey: 2 });
    const blobs = [];
    for (let i = 0; i < 5; i++) blobs.push(await c.encrypt(`v${i}`, 'aad'));
    expect(spy).toHaveBeenCalledTimes(3);
    const fresh = new FieldCipher(p, { context: ctx });
    for (let i = 0; i < 5; i++) expect(await fresh.decrypt(blobs[i]!, 'aad')).toBe(`v${i}`);
  });

  it('genera una sola DEK ante cifrados concurrentes', async () => {
    const p = new LocalKeyProvider(master);
    const spy = vi.spyOn(p, 'generateDataKey');
    const c = new FieldCipher(p, { context: ctx });
    await Promise.all(Array.from({ length: 20 }, (_, i) => c.encrypt(String(i), 'aad')));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('se recupera si el proveedor de claves falla una vez', async () => {
    const p = new LocalKeyProvider(master);
    vi.spyOn(p, 'generateDataKey').mockRejectedValueOnce(new Error('KMS caído'));
    const c = new FieldCipher(p, { context: ctx });
    await expect(c.encrypt('v', 'aad')).rejects.toThrow('KMS caído');
    await expect(c.encrypt('v', 'aad')).resolves.toBeInstanceOf(Buffer);
  });
});

describe('LocalKeyProvider', () => {
  it('exige una clave maestra de 32 bytes', () => {
    expect(() => new LocalKeyProvider(randomBytes(16).toString('base64'))).toThrow();
  });
});

describe('KmsKeyProvider', () => {
  it('envía el contexto de cifrado a KMS', async () => {
    const send = vi.fn().mockResolvedValue({ Plaintext: new Uint8Array(32), CiphertextBlob: new Uint8Array([1, 2]) });
    const p = new KmsKeyProvider({ send } as never, 'arn:aws:kms:test');
    await p.generateDataKey(ctx);
    expect(send.mock.calls[0]![0].input).toMatchObject({ KeyId: 'arn:aws:kms:test', EncryptionContext: ctx });
  });
});

describe('BlindIndex', () => {
  const bi = new BlindIndex(randomBytes(32).toString('base64'));
  it('es determinista para el mismo propósito', () => {
    expect(bi.compute('phone', '+593991234567').equals(bi.compute('phone', '+593991234567'))).toBe(true);
  });
  it('separa propósitos', () => {
    expect(bi.compute('phone', 'x').equals(bi.compute('email', 'x'))).toBe(false);
  });
  it('keyedMac depende de la clave', () => {
    expect(keyedMac(randomBytes(32), 'otp', '123456').equals(keyedMac(randomBytes(32), 'otp', '123456'))).toBe(false);
  });
});

describe('enmascarado', () => {
  it('cédula', () => expect(maskDocument('0912345623')).toBe('09******23'));
  it('teléfono', () => expect(maskPhone('+593991234567')).toBe('+5939******67'));
  it('correo', () => expect(maskEmail('juan@correo.com')).toBe('j***@correo.com'));
  it('valores cortos', () => expect(maskDocument('123')).toBe('***'));
});
