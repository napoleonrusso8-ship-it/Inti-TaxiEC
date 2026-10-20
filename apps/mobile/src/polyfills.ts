// Hermes (motor JS de React Native) no trae Web Crypto ni un URL completo. El código compartido de
// DPoP/PKCE (@intitaxi/auth-client) usa crypto.getRandomValues, crypto.subtle.digest y URL: se
// completan aquí con implementaciones nativas (expo-crypto) solo si faltan.
import * as ExpoCrypto from 'expo-crypto';
import { installUrlPolyfills } from './lib/url-polyfill';

const g = globalThis as any;
g.crypto ??= {};
g.crypto.getRandomValues ??= <T extends ArrayBufferView>(a: T): T => ExpoCrypto.getRandomValues(a as never) as T;
g.crypto.subtle ??= {};
g.crypto.subtle.digest ??= async (alg: string | { name: string }, data: BufferSource) => {
  const name = typeof alg === 'string' ? alg : alg.name;
  if (name.toUpperCase() !== 'SHA-256') throw new Error(`digest no soportado: ${name}`);
  return ExpoCrypto.digest(ExpoCrypto.CryptoDigestAlgorithm.SHA256, data);
};

installUrlPolyfills(g);
