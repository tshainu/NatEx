import { prefixedId } from "./ulid";
import { isDevelopment } from "./env";

/**
 * JWT + RBAC + branch scope (PROJECT.md §2, §4).
 *
 * - Access token: 15 minutes, HS256.
 * - Refresh token: opaque random string, hashed at rest, rotated on every use.
 * - Secrets hashed with argon2id (exactly as §2 specifies), via hash-wasm.
 *
 * HS256 is signed with Web Crypto rather than a jsonwebtoken dependency — same
 * algorithm, no extra package.
 */

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

export type Role = "rider" | "transport" | "ops" | "finance" | "admin" | "merchant";

export const ROLES: readonly Role[] = [
  "rider",
  "transport",
  "ops",
  "finance",
  "admin",
  "merchant",
] as const;

/**
 * What the sign-in behind a token proved (§2 TOTP MFA for ops/admin/finance):
 *   none      — the role needs no second factor (or enforcement is off)
 *   enrol     — an MFA role with no authenticator yet: the token may only enrol
 *   challenge — an MFA role that has yet to enter its code: may only verify
 *   verified  — phone OTP + TOTP (or a recovery code)
 * `enrol` and `challenge` are PENDING: middleware/auth.ts refuses them on every
 * route except the MFA routes.
 */
export type MfaLevel = "none" | "enrol" | "challenge" | "verified";
export const PENDING_MFA: ReadonlySet<MfaLevel> = new Set<MfaLevel>(["enrol", "challenge"]);

export interface AccessClaims {
  sub: string;
  /** Absent on tokens minted before M5 — treated as `none`. */
  mfa?: MfaLevel;
  role: Role;
  /** Every role the user holds (absent on pre-multi-role tokens: read as [role]). */
  roles?: Role[];
  branchId: string;
  merchantId?: string | null;
  deviceId?: string | null;
  name: string;
  iat: number;
  exp: number;
}

/** The authenticated request context every module route reads. */
export interface Principal {
  userId: string;
  name: string;
  role: Role;
  /** Every role the user holds; `role` is roles[0]. */
  roles: Role[];
  /** Branch scope — every operational query filters by this unless the role is global. */
  branchId: string;
  merchantId?: string | null;
  deviceId?: string | null;
  /** The token's MFA level (see MfaLevel). */
  mfa?: MfaLevel;
}

function secret(name: "JWT_ACCESS_SECRET" | "JWT_REFRESH_SECRET"): string {
  const value = process.env[name];
  if (value && value.length > 0) return value;
  // Dev fallback so `bun run dev` works before secrets are provisioned. The
  // fallback string is public (it is in this file), so a token signed with it
  // can be forged by anyone: outside an explicit development/test process the
  // server refuses to sign or verify instead (M5 security review — this used to
  // claim __server.ts refused to boot, which it never did).
  if (!isDevelopment()) throw new Error(`${name} is not set — refusing to sign or verify tokens with a public dev key.`);
  return `dev-insecure-${name}`;
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlFromString(s: string): string {
  return b64url(new TextEncoder().encode(s));
}

function bytesFromB64url(s: string): Uint8Array<ArrayBuffer> {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function stringFromB64url(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function hmacKey(secretValue: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretValue),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signAccessToken(
  claims: Omit<AccessClaims, "iat" | "exp">,
): Promise<{ token: string; expiresIn: number }> {
  const iat = Math.floor(Date.now() / 1000);
  const payload: AccessClaims = { ...claims, iat, exp: iat + ACCESS_TTL_SECONDS };
  const header = b64urlFromString(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64urlFromString(JSON.stringify(payload));
  const key = await hmacKey(secret("JWT_ACCESS_SECRET"));
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${body}`));
  return {
    token: `${header}.${body}.${b64url(new Uint8Array(sig))}`,
    expiresIn: ACCESS_TTL_SECONDS,
  };
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  try {
    // Pin the algorithm (M5 security review). The signature check below would
    // already refuse `alg: none`, but an explicit pin means no future code path
    // can be talked into another algorithm by the token's own header.
    const head = JSON.parse(stringFromB64url(header)) as { alg?: unknown; typ?: unknown };
    if (head.alg !== "HS256") return null;

    // crypto.subtle.verify compares in constant time; a string `!==` on the
    // recomputed signature leaks how many leading characters matched.
    const key = await hmacKey(secret("JWT_ACCESS_SECRET"));
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      bytesFromB64url(sig),
      new TextEncoder().encode(`${header}.${body}`),
    );
    if (!ok) return null;

    const claims = JSON.parse(stringFromB64url(body)) as AccessClaims;
    // A token with no numeric expiry must not live forever.
    if (typeof claims.exp !== "number" || typeof claims.sub !== "string") return null;
    if (claims.exp <= Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Opaque refresh token — random, never a JWT, hashed before storage. */
export function mintRefreshToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${prefixedId("rt")}.${b64url(bytes)}`;
}

/**
 * argon2id, per PROJECT.md §2.
 *
 * Implemented with hash-wasm rather than `Bun.password`: the Vite dev server
 * that serves the API runs on Node, where the `Bun` global does not exist, so
 * `Bun.password` throws in development and would only work in the built
 * server. Algorithm and parameters are unchanged — argon2id, 19 MiB, 2 passes,
 * 1 lane, 32-byte tag (OWASP's second recommended parameter set), PHC-encoded
 * output. A library swap, not an algorithm substitution.
 */
const ARGON2 = { parallelism: 1, iterations: 2, memorySize: 19_456, hashLength: 32 } as const;

export async function hashSecret(plain: string): Promise<string> {
  const { argon2id } = await import("hash-wasm");
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return argon2id({ password: plain, salt, ...ARGON2, outputType: "encoded" });
}

export async function verifySecret(plain: string, hash: string): Promise<boolean> {
  try {
    const { argon2Verify } = await import("hash-wasm");
    return await argon2Verify({ password: plain, hash });
  } catch {
    return false;
  }
}

/** Stable, non-reversible fingerprint for refresh-token lookup. */
export async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return b64url(new Uint8Array(digest));
}

export function bearerFrom(headers: Headers): string | null {
  const raw = headers.get("authorization") ?? headers.get("Authorization");
  if (!raw) return null;
  const [scheme, token] = raw.split(" ");
  if (!token || scheme.toLowerCase() !== "bearer") return null;
  return token;
}

/** Roles that see every branch (PROJECT.md §5 row-level scoping). */
const GLOBAL_ROLES: ReadonlySet<Role> = new Set<Role>(["admin", "finance"]);

export function isGlobalScope(role: Role): boolean {
  return GLOBAL_ROLES.has(role);
}
