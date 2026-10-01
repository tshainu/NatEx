import { getRandomBytes } from "expo-crypto";

/**
 * ULID (§7: "client IDs are ULIDs") — 48-bit millisecond time + 80 random bits,
 * Crockford base32, 26 characters.
 *
 * The time half makes ids sort roughly by creation, which is handy when reading
 * a journal; it is NOT what orders the outbox. A rider's phone clock can be
 * hours wrong, so the queue drains by its own monotonic `seq`, never by this.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = getRandomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i]! % 32];
  return time + rand;
}
