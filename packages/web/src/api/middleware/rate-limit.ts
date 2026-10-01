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
    const secondsPerToken = Math.ceil(60 / Math.max(1, spec.refillPerMinute));
    errors.rateLimited(secondsPerToken);
  }

  await db
    .update(rateLimit)
    .set({ tokens: tokens - 1, refilledAt: refill > 0 ? now : existing.refilledAt })
    .where(eq(rateLimit.bucket, bucketKey));
}

export function clientIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    headers.get("x-real-ip") ??
    "unknown"
  );
}
