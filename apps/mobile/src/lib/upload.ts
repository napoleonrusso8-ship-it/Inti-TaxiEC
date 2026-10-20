import * as Crypto from 'expo-crypto';
import type { UploadInstructions } from '@intitaxi/mobile-core';

/** Sube un archivo según lo que indique el servidor (URL firmada PUT o formulario POST). */
export async function sendFile(u: UploadInstructions, uri: string, blob: Blob, contentType: string) {
  let r: Response;
  if (u.method === 'PUT') {
    r = await fetch(u.url, { method: 'PUT', headers: { 'content-type': contentType, ...u.headers }, body: blob });
  } else {
    const form = new FormData();
    for (const [k, v] of Object.entries(u.fields ?? {})) form.append(k, v);
    form.append('file', { uri, type: contentType, name: 'archivo' } as unknown as Blob);
    r = await fetch(u.url, { method: 'POST', headers: u.headers, body: form });
  }
  if (!r.ok) throw new Error('No se pudo subir el archivo. Revisa tu conexión e intenta de nuevo.');
}

/** Lee el archivo local y calcula su SHA-256 (el servidor comprueba que lo subido es exactamente esto). */
export async function readFile(uri: string): Promise<{ blob: Blob; size: number; sha256: string }> {
  const blob = await (await fetch(uri)).blob();
  const bytes = new Uint8Array(await new Response(blob).arrayBuffer());
  const digest = new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes));
  return { blob, size: bytes.byteLength, sha256: Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('') };
}
