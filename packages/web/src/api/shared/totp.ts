/**
 * TOTP, RFC 6238 (HMAC-SHA1, 30-second steps, 6 digits) — the parameters every
 * authenticator app (Google Authenticator, Microsoft Authenticator, 1Password,
 * Authy) uses by default, so the otpauth:// URI needs no non-default fields.
 *
 * Web Crypto only: no Node imports, because mobile and desktop type-check the
 * API through AppRouter without Node types.
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps either side of "now" that are accepted — absorbs phone clock drift. */
export const TOTP_WINDOW = 1;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base32 character "${ch}"`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** A fresh 160-bit secret (RFC 4226 §4 recommends 160 bits), base32. */
export function newTotpSecret(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

export function stepAt(epochMs: number): number {
  return Math.floor(epochMs / 1000 / TOTP_STEP_SECONDS);
}

/** HOTP(secret, counter) — RFC 4226 §5.3 dynamic truncation. */
export async function hotp(secretB32: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    base32Decode(secretB32) as BufferSource,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const msg = new Uint8Array(8);
  // Counter as a big-endian 64-bit integer. Steps fit in 2^53 for millennia.
  let c = counter;
  for (let i = 7; i >= 0; i -= 1) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, "0");
}

export function totpAt(secretB32: string, step: number): Promise<string> {
  return hotp(secretB32, step);
}

/**
 * Which step (if any) a submitted code belongs to, within ±TOTP_WINDOW of now,
 * and strictly after `lastStep` — RFC 6238 §5.2 forbids accepting the same
 * code twice. Returns null for a wrong code; `{ replay: true }` for a code that
 * is right but was already used.
 */
export async function matchTotp(
  secretB32: string,
  code: string,
  lastStep: number,
  nowMs: number = Date.now(),
): Promise<{ step: number } | { replay: true } | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const now = stepAt(nowMs);
  let replay = false;
  for (let s = now - TOTP_WINDOW; s <= now + TOTP_WINDOW; s += 1) {
    if ((await totpAt(secretB32, s)) !== code) continue;
    if (s > lastStep) return { step: s };
    replay = true;
  }
  return replay ? { replay: true } : null;
}

/** otpauth:// URI for the authenticator app's QR code (Key Uri Format). */
export function otpauthUri(secretB32: string, accountLabel: string, issuer = "NatEx"): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}
