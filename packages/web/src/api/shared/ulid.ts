/**
 * ULID — lexicographically sortable, time-prefixed ids.
 * PROJECT.md §4 (request id) and §7 (client-minted ids stable across retries).
 * Implemented locally to avoid a dependency; Crockford base32, 48-bit time + 80-bit random.
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

/** Prefixed id for readability in logs and URLs, e.g. `pcl_01J...`. */
export function prefixedId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}
