import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database";
import { nightlyStatus } from "../jobs/nightly";
import { workerStatus } from "../jobs/worker";
import { adminProc, mutate } from "../middleware/pipeline";
import { listInvariantRuns } from "../modules/cod/service";
import { listOutbox, outboxSummary, retryFailed } from "../shared/outbox";
import { errors } from "../shared/errors";

/**
 * Job monitor (§10 M5 "Monitoring"). Admin only.
 *
 * KNOWN DEVIATION (same as jobs/worker.ts): there is no BullMQ dashboard
 * because there is no BullMQ. This reads the outbox the in-process worker
 * drains, the worker's own heartbeat, and the nightly invariant run history.
 */

/** When this server process loaded the API (no `process.uptime()`: the mobile and desktop typecheck has no Node types). */
const STARTED_AT = Date.now();

export const health = adminProc.handler(async () => {
  const started = performance.now();
  await db.run(sql`select 1`);
  const dbMs = Math.round(performance.now() - started);
  return {
    now: new Date(),
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    db: { ok: true, latencyMs: dbMs },
    worker: workerStatus(),
    nightly: nightlyStatus(),
    outbox: await outboxSummary(),
    lastInvariantRuns: (await listInvariantRuns(7)).map((r) => ({
      id: r.id,
      runDate: r.runDate,
      result: r.result,
      breachCount: r.breachCount,
      trigger: r.trigger,
      ranAt: r.ranAt,
    })),
  };
});

export const jobs = adminProc
  .input(
    z.object({
      state: z.enum(["pending", "processing", "done", "failed"]).optional(),
      topic: z.string().max(60).optional(),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
    }),
  )
  .handler(({ input }) => listOutbox(input));

export const retryJob = adminProc.input(z.object({ id: z.string().min(1) })).handler(({ input, context }) =>
  mutate(
    context,
    input,
    { route: "monitor.retryJob", entity: "shared_outbox", entityId: () => input.id, action: "job.retried" },
    async () => {
      const out = await retryFailed(input.id);
      if (!out.retried) errors.conflict("Only a failed job can be retried.", { id: input.id });
      return out;
    },
  ),
);

export const invariantRuns = adminProc
  .input(z.object({ limit: z.number().int().min(1).max(100).default(30) }))
  .handler(({ input }) => listInvariantRuns(input.limit));

export const monitor = { health, jobs, retryJob, invariantRuns };
