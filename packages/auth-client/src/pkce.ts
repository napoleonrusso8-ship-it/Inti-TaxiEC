import { randomBase64url, sha256Base64url } from './encoding.js';

export function createCodeVerifier(): string {
  return randomBase64url(32);
}

export function codeChallengeS256(verifier: string): Promise<string> {
  return sha256Base64url(verifier);
}
