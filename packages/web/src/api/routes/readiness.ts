import { sql } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "../database";
import { workerStatus } from "../jobs/worker";
import { nightlyStatus } from "../jobs/nightly";

/**
 * Public readiness probe for external uptime monitoring (§10 M5 — Uptime Kuma).
 *
 * `GET /api/health` (template) only proves the process answers. This one
 * proves the parts a courier day depends on: the database answers within a
 * budget, and the in-process outbox worker (SMS, notifications) has ticked
 * recently. It is unauthenticated — the monitor has no JWT — so it returns
 * states only: no counts, no hostnames, no error text.
 *
 *   200 {"status":"ok", ...}        everything healthy
 *   503 {"status":"down", ...}      database unreachable or slow, or the worker stalled
 *
 * Uptime Kuma: HTTP(s) – Keyword monitor on /api/health/ready, keyword `"status":"ok"`.
 */

const DB_BUDGET_MS = 3_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

export async function readiness(c: Context) {
  let dbState: "ok" | "slow" | "down" = "ok";
  const started = performance.now();
  try {
    await withTimeout(db.run(sql`select 1`), DB_BUDGET_MS);
    if (performance.now() - started > DB_BUDGET_MS / 2) dbState = "slow";
  } catch {
    dbState = "down";
  }

  const w = workerStatus();
  // Three missed polls (or 60 s, whichever is longer) means the drain is stuck.
  const staleAfter = Math.max(w.pollMs * 3, 60_000);
  const lastTick = w.lastTickAt?.getTime() ?? 0;
  const workerState: "ok" | "stalled" | "stopped" = !w.running ? "stopped" : Date.now() - lastTick > staleAfter ? "stalled" : "ok";
  const nightlyState = nightlyStatus().running ? "ok" : "stopped";

  const healthy = dbState !== "down" && workerState === "ok" && nightlyState === "ok";
  c.header("Cache-Control", "no-store");
  return c.json(
    {
      status: healthy ? "ok" : "down",
      db: dbState,
      worker: workerState,
      nightly: nightlyState,
      checkedAt: new Date().toISOString(),
    },
    healthy ? 200 : 503,
  );
}
