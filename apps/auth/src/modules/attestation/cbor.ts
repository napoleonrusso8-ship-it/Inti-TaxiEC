/**
 * Decodificador CBOR mínimo (RFC 8949) para objetos de atestación de App Attest.
 * Soporta: enteros, bytes, texto, arrays, mapas y simples (false/true/null). Rechaza longitudes indefinidas.
 */
export type CborValue = number | bigint | string | Uint8Array | boolean | null | CborValue[] | Map<CborValue, CborValue>;

export function decodeCbor(buf: Uint8Array, maxDepth = 16): CborValue {
  let pos = 0;
  const need = (n: number) => {
    if (pos + n > buf.length) throw new Error('CBOR truncado');
  };
  const readLen = (info: number): number => {
    if (info < 24) return info;
    const sizes: Record<number, number> = { 24: 1, 25: 2, 26: 4, 27: 8 };
    const size = sizes[info];
    if (!size) throw new Error('CBOR: longitud no soportada');
    need(size);
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + buf[pos++]!;
    if (v > Number.MAX_SAFE_INTEGER) throw new Error('CBOR: longitud demasiado grande');
    return v;
  };
  const item = (depth: number): CborValue => {
    if (depth > maxDepth) throw new Error('CBOR: anidamiento excesivo');
    need(1);
    const b = buf[pos++]!;
    const major = b >> 5;
    const info = b & 31;
    switch (major) {
      case 0:
        return readLen(info);
      case 1:
        return -1 - readLen(info);
      case 2: {
        const n = readLen(info);
        need(n);
        const out = buf.slice(pos, pos + n);
        pos += n;
        return out;
      }
      case 3: {
        const n = readLen(info);
        need(n);
        const out = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(pos, pos + n));
        pos += n;
        return out;
      }
      case 4: {
        const n = readLen(info);
        if (n > 1000) throw new Error('CBOR: array demasiado grande');
        return Array.from({ length: n }, () => item(depth + 1));
      }
      case 5: {
        const n = readLen(info);
        if (n > 1000) throw new Error('CBOR: mapa demasiado grande');
        const m = new Map<CborValue, CborValue>();
        for (let i = 0; i < n; i++) m.set(item(depth + 1), item(depth + 1));
        return m;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new Error('CBOR: simple no soportado');
      default:
        throw new Error('CBOR: tipo no soportado');
    }
  };
  const v = item(0);
  if (pos !== buf.length) throw new Error('CBOR: bytes sobrantes');
  return v;
}

/** Lee un TLV DER (para extraer la extensión de nonce del certificado de App Attest). */
export function readDer(buf: Uint8Array, offset: number): { tag: number; start: number; end: number } {
  const tag = buf[offset]!;
  let len = buf[offset + 1]!;
  let start = offset + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('DER: longitud inválida');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[start + i]!;
    start += n;
  }
  if (start + len > buf.length) throw new Error('DER truncado');
  return { tag, start, end: start + len };
}
