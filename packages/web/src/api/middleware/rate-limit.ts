import { eq } from "drizzle-orm";
import { db } from "../database";
import { rateLimit } from "../database/schema/shared";
import { errors } from "../shared/errors";

/**
 * STEP 5 of the chain (PROJECT.md §4): token bucket, per-user and per-IP.
 *
 * KNOWN DEVIATION: §2 specifies a Redis token bucket. No Redis on the managed
 * stack, so the buckets live in a SQLite table. Same algorithm, coarser
 * concurrency guarantees.
 */
export interface BucketSpec {
  /** Bucket capacity. */
  capacity: number;
  /** Tokens added per minute. */
  refillPerMinute: number;
}

export async function consumeToken(bucketKey: string, spec: BucketSpec): Promise<void> {
  const now = new Date();
  const [existing] = await db.select().from(rateLimit).where(eq(rateLimit.bucket, bucketKey));

  if (!existing) {
    await db
      .insert(rateLimit)
      .values({ bucket: bucketKey, tokens: spec.capacity - 1, refilledAt: now })
      .onConflictDoNothing();
    return;
  }

  const elapsedMs = now.getTime() - existing.refilledAt.getTime();
  const refill = Math.floor((elapsedMs / 60_000) * spec.refillPerMinute);
  const tokens = Math.min(spec.capacity, existing.tokens + refill);

  if (tokens <= 0) {
    // Fractional refill rates (e.g. 0.2/min = one per 5 min) report the true wait.
    const secondsPerToken = Math.ceil(60 / Math.max(0.01, spec.refillPerMinute));
    errors.rateLimited(secondsPerToken);
  }

  await db
    .update(rateLimit)
    .set({ tokens: tokens - 1, refilledAt: refill > 0 ? now : existing.refilledAt })
    .where(eq(rateLimit.bucket, bucketKey));
}

/**
 * The caller's IP for per-IP buckets (M5 security review).
 *
 * Order matters. The hosting edge (Cloudflare, seen live on the preview host)
 * strips any client-sent X-Forwarded-For and sets `cf-connecting-ip` and
 * `x-real-ip` itself, so those come first. X-Forwarded-For is a fallback, and
 * its RIGHTMOST entry is used — the one the nearest proxy appended. The leftmost
 * entry is whatever the client typed, and trusting it let anyone rotate the
 * header to get a fresh bucket on every request.
 *
 * A server exposed with no proxy in front can be fed any of these headers;
 * production must sit behind the edge (RUNBOOK.md "Security headers & proxy").
 */
export function clientIp(headers: Headers): string {
  const edge = headers.get("cf-connecting-ip") ?? headers.get("x-real-ip");
  if (edge?.trim()) return edge.trim();
  const hops = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return hops.at(-1) ?? "unknown";
}
