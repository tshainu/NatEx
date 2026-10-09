import { eq } from "drizzle-orm";
import { db } from "../database";
import { idempotencyKey } from "../database/schema/shared";
import { errors } from "../shared/errors";
import { isDevelopment } from "../shared/env";

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

const SENSITIVE_INPUT_KEYS = new Set(["password", "newpassword", "currentpassword", "passwordhash"]);

/** Replace low-entropy credential values with a keyed digest before request hashing. */
async function protectSensitiveInput(value: unknown): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map(protectSensitiveInput));
  if (!value || typeof value !== "object" || value instanceof Date) return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_INPUT_KEYS.has(key.toLowerCase()) && typeof item === "string") {
      const secret = process.env.JWT_ACCESS_SECRET ?? (isDevelopment() ? "natex-dev-idempotency-key" : "");
      if (!secret) throw new Error("JWT_ACCESS_SECRET is required to fingerprint sensitive idempotency input.");
      const hmacKey = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const digest = await crypto.subtle.sign(
        "HMAC",
        hmacKey,
        new TextEncoder().encode(`natex/idempotency/${key.toLowerCase()}/v1:${item}`),
      );
      out[key] = `keyed:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
    } else {
      out[key] = await protectSensitiveInput(item);
    }
  }
  return out;
}

/** Stable request fingerprint; password material is never stored or SHA-hashed alone. */
export async function requestFingerprint(route: string, input: unknown): Promise<string> {
  const protectedInput = await protectSensitiveInput(input ?? null);
  return sha256(`${route}:${JSON.stringify(protectedInput)}`);
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
  const requestHash = await requestFingerprint(params.route, params.input);

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
