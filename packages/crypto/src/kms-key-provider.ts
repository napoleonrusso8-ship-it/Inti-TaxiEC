import { DecryptCommand, GenerateDataKeyCommand, type KMSClient } from '@aws-sdk/client-kms';
import type { EncryptionContext, KeyProvider } from './key-provider.js';

/**
 * Proveedor respaldado por AWS KMS. La CMK vive en KMS (o CloudHSM vía custom key store);
 * el contexto de cifrado queda registrado en CloudTrail en cada uso, lo que da trazabilidad.
 */
export class KmsKeyProvider implements KeyProvider {
  constructor(
    private readonly client: Pick<KMSClient, 'send'>,
    readonly keyId: string,
  ) {}

  async generateDataKey(context: EncryptionContext) {
    const out = await this.client.send(
      new GenerateDataKeyCommand({ KeyId: this.keyId, KeySpec: 'AES_256', EncryptionContext: { ...context } }),
    );
    if (!out.Plaintext || !out.CiphertextBlob) throw new Error('KMS no devolvió la clave de datos');
    return { plaintext: Buffer.from(out.Plaintext), wrapped: Buffer.from(out.CiphertextBlob) };
  }

  async unwrapDataKey(wrapped: Buffer, context: EncryptionContext) {
    const out = await this.client.send(
      new DecryptCommand({ KeyId: this.keyId, CiphertextBlob: wrapped, EncryptionContext: { ...context } }),
    );
    if (!out.Plaintext) throw new Error('KMS no pudo descifrar la clave de datos');
    return Buffer.from(out.Plaintext);
  }
}
