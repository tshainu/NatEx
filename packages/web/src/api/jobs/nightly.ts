import { hasScheduledInvariantRun, runBalanceInvariant } from "../modules/cod/service";
import { colomboToday, TZ } from "../shared/time";

/**
 * Nightly balance-invariant schedule (PROJECT.md §8 "Checked nightly by a
 * job"; §10 M4 "Nightly balance-invariant job").
 *
 * KNOWN DEVIATION, same as jobs/worker.ts: §2 specifies BullMQ repeatable jobs
 * on Redis. The managed stack has neither, so this is an in-process tick.
 * What is preserved:
 *   - exactly one scheduled run per Asia/Colombo calendar day, recorded as a
 *     `trigger = scheduled` row in cod_invariant_run. The check reads the table,
 *     so a restart, a hot reload or a second process cannot double-run the day
 *     (the read-then-insert is not atomic across processes; one process runs)
 *   - a manual "run now" from the finance portal does NOT satisfy the schedule —
 *     the nightly row is the audit trail that the job itself ran
 *   - a missed night shows up as a gap in the run history, never backfilled
 *     with a run that claims a date it did not run on
 *
 * Runs at the first tick on or after NIGHTLY_INVARIANT_HOUR (Colombo local,
 * default 23 → 23:00–23:59). Ticks every NIGHTLY_TICK_MS (default 5 min).
 */

const TICK_MS = Number(process.env.NIGHTLY_TICK_MS ?? 5 * 60_000);

/** Read per tick so a test can move the hour without a restart. */
function runHour(): number {
  const h = Number(process.env.NIGHTLY_INVARIANT_HOUR ?? 23);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 23;
}

/** Colombo wall-clock hour, 0–23. */
export function colomboHour(now: Date = new Date()): number {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(now);
  return Number(h) % 24;
}

type NightlyGlobal = typeof globalThis & {
  __natexNightlyTimer?: ReturnType<typeof setInterval> | null;
  __natexNightlyBusy?: boolean;
};
const g = globalThis as NightlyGlobal;

export type NightlyOutcome =
  | { ran: true; runDate: string; runId: string; result: "ok" | "breached" }
  | { ran: false; runDate: string; reason: "before-hour" | "already-ran" | "busy" };

/** One scheduling decision. Exported so a probe can drive it deterministically. */
export async function nightlyTick(now: Date = new Date()): Promise<NightlyOutcome> {
  const runDate = colomboToday(now);
  if (g.__natexNightlyBusy) return { ran: false, runDate, reason: "busy" };
  if (colomboHour(now) < runHour()) return { ran: false, runDate, reason: "before-hour" };
  g.__natexNightlyBusy = true;
  try {
    if (await hasScheduledInvariantRun(runDate)) return { ran: false, runDate, reason: "already-ran" };
    const out = await runBalanceInvariant(now, "scheduled");
    console.log(`[nightly] balance invariant for ${runDate}: ${out.result} (${out.runId})`);
    pushHeartbeat(out.result, runDate);
    return { ran: true, runDate, runId: out.runId, result: out.result };
  } finally {
    g.__natexNightlyBusy = false;
  }
}

/**
 * Uptime Kuma push monitor (RUNBOOK §5): one heartbeat per completed nightly
 * run. A clean run reports up; a breached invariant reports down, so Kuma
 * alerts on a breach as well as on a missed night (heartbeat interval 26 h).
 * Optional: without KUMA_PUSH_URL nothing is sent. Never throws.
 */
function pushHeartbeat(result: "ok" | "breached", runDate: string): void {
  const base = process.env.KUMA_PUSH_URL;
  if (!base) return;
  try {
    const url = new URL(base);
    url.searchParams.set("status", result === "ok" ? "up" : "down");
    url.searchParams.set("msg", `COD invariant ${runDate}: ${result}`);
    void fetch(url, { signal: AbortSignal.timeout(10_000) }).catch((err: unknown) => {
      console.error("[nightly] Kuma heartbeat failed:", err);
    });
  } catch (err) {
    console.error("[nightly] KUMA_PUSH_URL is not a valid URL:", err);
  }
}

/** Start the tick. A second call (hot reload) replaces the previous loop. */
export function startNightly(): void {
  if (g.__natexNightlyTimer) clearInterval(g.__natexNightlyTimer);
  const tick = () =>
    void nightlyTick().catch((err: unknown) => {
      console.error("[nightly] invariant tick threw:", err);
    });
  const timer = setInterval(tick, TICK_MS);
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as unknown as { unref: () => void }).unref();
  }
  g.__natexNightlyTimer = timer;
  // Check once at boot too, so a server started at 23:30 does not wait a tick.
  setTimeout(tick, 10_000);
  console.log(`[nightly] invariant schedule started (daily from ${runHour()}:00 ${TZ}, tick ${TICK_MS}ms)`);
}

/** Job-monitor view of the nightly schedule (§10 M5). */
export function nightlyStatus() {
  return { running: Boolean(g.__natexNightlyTimer), runHour: runHour(), tickMs: TICK_MS, timezone: TZ };
}

export function stopNightly(): void {
  if (g.__natexNightlyTimer) clearInterval(g.__natexNightlyTimer);
  g.__natexNightlyTimer = null;
}
