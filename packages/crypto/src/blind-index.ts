import { createHmac, hkdfSync } from 'node:crypto';

/**
 * Índice ciego: HMAC-SHA256 determinista que permite buscar por igualdad (teléfono, correo,
 * cédula) sin almacenar el valor en claro. Cada propósito usa una subclave distinta derivada
 * con HKDF, de modo que el mismo valor produce índices distintos en tablas distintas.
 */
export class BlindIndex {
  readonly #root: Buffer;

  constructor(rootKeyBase64: string) {
    const key = Buffer.from(rootKeyBase64, 'base64');
    if (key.length < 32) throw new Error('BlindIndex: la clave raíz debe tener al menos 32 bytes');
    this.#root = key;
  }

  compute(purpose: string, normalizedValue: string): Buffer {
    const sub = Buffer.from(hkdfSync('sha256', this.#root, Buffer.alloc(0), `intitaxi:bidx:${purpose}`, 32));
    return createHmac('sha256', sub).update(normalizedValue, 'utf8').digest();
  }
}

/** MAC con clave secreta para valores de baja entropía y vida corta (OTP, PIN). */
export function keyedMac(key: Buffer, purpose: string, value: string): Buffer {
  return createHmac('sha256', key).update(`${purpose}\u0000${value}`, 'utf8').digest();
}
