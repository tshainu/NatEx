/**
 * Authenticated encryption for secrets that must be recoverable — today only
 * the TOTP shared secret (a code cannot be verified against a hash).
 *
 * AES-256-GCM, 96-bit random IV, key = SHA-256(MFA_ENCRYPTION_KEY). Output is
 * `v1.<iv b64url>.<ciphertext+tag b64url>` so the scheme can be rotated later.
 * Web Crypto only (no Node imports — see shared/request-scope.ts for why).
 */

import { isDevelopment } from "./env";

function keyMaterial(): string {
  const value = process.env.MFA_ENCRYPTION_KEY;
  if (value && value.length > 0) return value;
  if (!isDevelopment()) {
    throw new Error("MFA_ENCRYPTION_KEY is not set — refusing to encrypt MFA secrets with a dev key.");
  }
  // Dev fallback, same policy as the JWT secrets in shared/auth.ts.
  return "dev-insecure-MFA_ENCRYPTION_KEY";
}

async function aesKey(): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(keyMaterial()));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export async function seal(plain: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await aesKey(),
    new TextEncoder().encode(plain),
  );
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

export async function open(sealed: string): Promise<string> {
  const [version, iv, ct] = sealed.split(".");
  if (version !== "v1" || !iv || !ct) throw new Error("unrecognised sealed secret");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64url(iv) as BufferSource },
    await aesKey(),
    fromB64url(ct) as BufferSource,
  );
  return new TextDecoder().decode(plain);
}
