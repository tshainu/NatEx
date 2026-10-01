/**
 * Client-side ULID. The clients mint the id for a custody event so a retry of
 * the same intent — an offline rider's queued scan, a dispatcher's double
 * click — dedupes on the server instead of appending a second event (§7).
 *
 * Same Crockford base32 encoding as api/shared/ulid.ts. Duplicated rather than
 * imported because nothing in src/web may reach into the server module tree.
 */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(now: number, len = 10): string {
  let out = "";
  let t = now;
  for (let i = len - 1; i >= 0; i--) {
    out = ENCODING[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(len = 16): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ENCODING[b % 32];
  return out;
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}
