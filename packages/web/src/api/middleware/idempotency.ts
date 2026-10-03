import { eq } from "drizzle-orm";
import { db } from "../database";
import { idempotencyKey } from "../database/schema/shared";
import { errors } from "../shared/errors";

/**
 * STEP 3 of the chain (PROJECT.md §4) — MANDATORY, NOT OPTIONAL.
 *
 * "A rider's phone will retry a delivery confirmation that actually succeeded.
 *  Every mutating endpoint accepts an Idempotency-Key, stores the key with the
 *  resulting response, and replays it on duplicate. Omitting this causes silent
 *  double-counted COD collections."
 */

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function keyFrom(headers: Headers): string | null {
  return headers.get("idempotency-key") ?? headers.get("Idempotency-Key");
}

export interface ReplayHit {
  replayed: true;
  response: unknown;
}

/**
 * Reserves the key. Returns a replay when this exact request already completed,
 * or null when the caller should run the handler and then call `complete()`.
 */
export async function reserve(params: {
  key: string;
  route: string;
  userId: string | null;
  input: unknown;
}): Promise<ReplayHit | null> {
  const requestHash = await sha256(`${params.route}:${JSON.stringify(params.input ?? null)}`);

  const inserted = await db
    .insert(idempotencyKey)
    .values({
      key: params.key,
      route: params.route,
      userId: params.userId,
      requestHash,
      state: "in_progress",
    })
    .onConflictDoNothing()
    .returning({ key: idempotencyKey.key });

  if (inserted.length > 0) return null; // First time — run the handler.

  const [existing] = await db
    .select()
    .from(idempotencyKey)
    .where(eq(idempotencyKey.key, params.key));

  if (!existing) return null;

  // A key belongs to the caller that first used it (M5 security review). Keys
  // are global in the table, so without this a second user presenting the same
  // key and body would be handed the first user's stored response.
  if ((existing.userId ?? null) !== (params.userId ?? null)) errors.idempotencyMismatch();

  // Same key, different payload — a client bug that must never be silently accepted.
  if (existing.requestHash !== requestHash) errors.idempotencyMismatch();

  if (existing.state === "completed" && existing.responseJson) {
    return { replayed: true, response: JSON.parse(existing.responseJson) as unknown };
  }

  // A retry arrived while the original is still running. Safer to make the
  // client retry than to run the side effect twice.
  errors.conflict("An identical request is still in flight. Retry shortly.", {
    idempotencyKey: params.key,
  });
  return null;
}

export async function complete(key: string, response: unknown): Promise<void> {
  await db
    .update(idempotencyKey)
    .set({ state: "completed", responseJson: JSON.stringify(response ?? null) })
    .where(eq(idempotencyKey.key, key));
}

/** A failed handler must release the key so the client can retry cleanly. */
export async function release(key: string): Promise<void> {
  await db.delete(idempotencyKey).where(eq(idempotencyKey.key, key));
}
