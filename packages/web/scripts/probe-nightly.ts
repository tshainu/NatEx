/**
 * Nightly balance-invariant schedule — live probe (PROJECT.md §8 "Checked
 * nightly by a job", §10 M4).
 *
 * Run against a server started with NIGHTLY_INVARIANT_HOUR=0 so "tonight" is
 * now (the README's runbook shows the command). Proves:
 *   1. the running server's own schedule wrote exactly one `scheduled` run for
 *      today's Colombo date, and it balances
 *   2. further ticks — in the server and from this separate process — do not
 *      run the day again (the check reads the table, not process memory)
 *   3. before the configured hour, a tick does nothing
 *   4. a manual finance "run now" is recorded as manual and does not count as
 *      the nightly run
 *
 *   bun --env-file=../../.env scripts/probe-nightly.ts
 */
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { like } from "drizzle-orm";
import type { AppRouterClient } from "../src/api";

const API = process.env.PROBE_API ?? "http://localhost:4200";
const { db } = await import("../src/api/database");
const { rateLimit } = await import("../src/api/database/schema/shared");
const { colomboToday } = await import("../src/api/shared/time");
const { nightlyTick, colomboHour } = await import("../src/api/jobs/nightly");

const client = (token?: string): AppRouterClient =>
  createORPCClient(
    new RPCLink({ url: `${API}/api/rpc`, headers: () => (token ? { authorization: `Bearer ${token}` } : {}) }),
  );
let pass = 0;
const failures: string[] = [];
function check(cond: boolean, label: string, detail = ""): void {
  if (cond) pass += 1;
  else failures.push(label);
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

await db.delete(rateLimit).where(like(rateLimit.bucket, "%identity.requestOtp"));
const c = await client().identity.requestOtp({ phone: "+94774567890" });
const fin = await client().identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode!, deviceId: null });
const api = client(fin.accessToken);
const today = colomboToday();
console.log(`\nNatEx nightly invariant probe → ${API} (Colombo ${today}, hour ${colomboHour()})\n`);

const scheduledToday = async () =>
  (await api.cod.invariantRuns({ limit: 100 })).filter((r) => r.runDate === today && r.trigger === "scheduled");

const s1 = await scheduledToday();
check(s1.length === 1, "the server's schedule wrote exactly one scheduled run for today", `${s1.length} row(s)`);
check(s1[0]?.result === "ok" && s1[0]?.ledgerSumCents === 0 && s1[0]?.breachCount === 0, "it balances: ledger sum 0, no breach", `${s1[0]?.id} ${s1[0]?.result}`);

process.env.NIGHTLY_INVARIANT_HOUR = "0";
const t1 = await nightlyTick();
check(!t1.ran && t1.reason === "already-ran", "a tick from a second process sees the day is done", JSON.stringify(t1));
process.env.NIGHTLY_INVARIANT_HOUR = String(Math.min(23, colomboHour() + 1));
const t2 = await nightlyTick();
check(
  colomboHour() === 23 ? true : !t2.ran && t2.reason === "before-hour",
  "before the configured hour a tick does nothing",
  JSON.stringify(t2),
);

const manual = await api.cod.runInvariant({});
const runs = await api.cod.invariantRuns({ limit: 100 });
const m = runs.find((r) => r.id === manual.runId);
check(m?.trigger === "manual", "a finance 'run now' is recorded as manual", String(m?.trigger));
await new Promise((r) => setTimeout(r, 20_000)); // > one server tick at NIGHTLY_TICK_MS=15000
const s2 = await scheduledToday();
check(s2.length === 1 && s2[0]?.id === s1[0]?.id, "after further server ticks there is still exactly one scheduled run", `${s2.length} row(s)`);

// The run above was forced (hour 0); re-label it so tonight's real 23:00 run
// still happens and the history only shows genuine nightly runs as scheduled.
const { codInvariantRun } = await import("../src/api/database/schema/cod");
const { eq } = await import("drizzle-orm");
if (s1[0]) await db.update(codInvariantRun).set({ trigger: "manual" }).where(eq(codInvariantRun.id, s1[0].id));

console.log(`\n${"─".repeat(60)}`);
if (failures.length) {
  console.log(`nightly probe: ${pass} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`nightly probe: ${pass}/${pass} checks passed`);
process.exit(0);
