/**
 * Load test (§10 M5). Closed-loop: N virtual users each fire the next request
 * as soon as the last one answers, for a fixed time per stage. The request mix
 * is what a working day looks like on the screens people keep open — the ops
 * board and parcel list, the finance cash board, the merchant's own parcels,
 * parcel detail lookups, and a price quote.
 *
 * Reads only, on purpose: writes are per-user rate limited (120/min, §11) and
 * would fill the shared dev database with fixtures. The write path's limits are
 * exercised by scripts/security-review.ts instead.
 *
 * WHAT THE NUMBERS MEAN: this hits whatever BASE is — by default the Vite dev
 * server (one process, HMR on, unminified) talking to the hosted Turso
 * database over the internet. Treat them as a floor for a production build,
 * not as capacity.
 *
 *   bun --env-file=../../.env scripts/load-test.ts [--stage-seconds 20] [--levels 5,20,50]
 */

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { like, or } from "drizzle-orm";
import type { AppRouterClient } from "../src/api";
import { finishMfa } from "./lib/mfa";

const BASE = process.env.LOAD_BASE ?? "http://localhost:4200";
const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1]! : fallback);
const STAGE_SECONDS = Number(arg("--stage-seconds", "20"));
const LEVELS = arg("--levels", "5,20,50").split(",").map(Number);

const { db } = await import("../src/api/database");
const { hardenScriptReads } = await import("./lib/db-retry");
hardenScriptReads(db);
const { rateLimit } = await import("../src/api/database/schema/shared");
const { rateBand, rateCardVersion } = await import("../src/api/database/schema/merchants");
const { and, eq } = await import("drizzle-orm");
await db.delete(rateLimit).where(or(like(rateLimit.bucket, "%identity.%Otp%"), like(rateLimit.bucket, "%mfa.%")));

const anon: AppRouterClient = createORPCClient(new RPCLink({ url: `${BASE}/api/rpc` }));
async function client(phone: string): Promise<AppRouterClient> {
  const c = await anon.identity.requestOtp({ phone });
  if (!c.devCode) throw new Error(`no dev OTP for ${phone}`);
  const s = await finishMfa(BASE, await anon.identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode, deviceId: `load-${phone}` }));
  return createORPCClient(new RPCLink({ url: `${BASE}/api/rpc`, headers: () => ({ authorization: `Bearer ${s.accessToken}` }) }));
}

const [ops, finance, merchant, admin] = await Promise.all([
  client("+94772345678"),
  client("+94774567890"),
  client("+94775678901"),
  client("+94773456789"),
]);
// Parcels the Colombo ops user may open (§5 branch scope) — taken from their own list.
const awbs = (await ops.parcels.list({ page: 1, pageSize: 50 })).rows.map((r) => r.awb);
// No merchant has an agreed card yet (§15 q3 open), so price on the seeded
// placeholder card's active version directly.
const [active] = await db
  .select({ id: rateCardVersion.id })
  .from(rateCardVersion)
  .where(and(eq(rateCardVersion.rateCardId, "rtc_pilot_placeholder"), eq(rateCardVersion.status, "active")))
  .limit(1);
const [band] = active ? await db.select({ code: rateBand.band }).from(rateBand).where(eq(rateBand.versionId, active.id)).limit(1) : [];
if (!awbs.length || !active || !band) throw new Error("need parcels in the Colombo ops scope and the placeholder rate card — run bun run db:seed");

type Op = { name: string; weight: number; run: () => Promise<unknown> };
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;
const OPS: Op[] = [
  { name: "ops parcels.board", weight: 3, run: () => ops.parcels.board({}) },
  { name: "ops parcels.list", weight: 3, run: () => ops.parcels.list({ page: 1, pageSize: 25 }) },
  { name: "ops parcels.get", weight: 2, run: () => ops.parcels.get({ awbOrId: pick(awbs) }) },
  { name: "finance cod.riderCashBoard", weight: 1, run: () => finance.cod.riderCashBoard({}) },
  { name: "merchant parcels.list", weight: 2, run: () => merchant.parcels.list({ page: 1, pageSize: 25 }) },
  {
    name: "admin rateCards.quote",
    weight: 1,
    run: () => admin.rateCards.quote({ versionId: active.id, band: band.code, weightGrams: 1200, requested: [] }),
  },
];
const deck = OPS.flatMap((o) => Array.from({ length: o.weight }, () => o));

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0);

async function stage(users: number) {
  const lat: Record<string, number[]> = {};
  const errs: Record<string, number> = {};
  const errorKinds = new Map<string, number>();
  const end = performance.now() + STAGE_SECONDS * 1000;
  let done = 0;
  await Promise.all(
    Array.from({ length: users }, async () => {
      while (performance.now() < end) {
        const op = pick(deck);
        const t = performance.now();
        try {
          await op.run();
          (lat[op.name] ??= []).push(performance.now() - t);
        } catch (e) {
          errs[op.name] = (errs[op.name] ?? 0) + 1;
          const kind = `${op.name}: ${(e as { status?: number }).status ?? ""} ${(e as Error).message}`.slice(0, 140);
          errorKinds.set(kind, (errorKinds.get(kind) ?? 0) + 1);
        }
        done++;
      }
    }),
  );
  const all = Object.values(lat).flat().sort((a, b) => a - b);
  const errorCount = Object.values(errs).reduce((a, b) => a + b, 0);
  console.log(
    `\n${String(users).padStart(3)} users · ${done} requests in ${STAGE_SECONDS}s · ${(done / STAGE_SECONDS).toFixed(1)} req/s · errors ${errorCount} (${((errorCount / Math.max(done, 1)) * 100).toFixed(2)}%)`,
  );
  console.log(`    all      p50 ${pct(all, 50).toFixed(0)} ms · p95 ${pct(all, 95).toFixed(0)} ms · p99 ${pct(all, 99).toFixed(0)} ms · max ${(all.at(-1) ?? 0).toFixed(0)} ms`);
  for (const o of OPS) {
    const xs = (lat[o.name] ?? []).sort((a, b) => a - b);
    console.log(
      `    ${o.name.padEnd(34)} n=${String(xs.length).padStart(5)}  p50 ${pct(xs, 50).toFixed(0).padStart(5)}  p95 ${pct(xs, 95).toFixed(0).padStart(5)}  p99 ${pct(xs, 99).toFixed(0).padStart(5)} ms${errs[o.name] ? `  errors ${errs[o.name]}` : ""}`,
    );
  }
  for (const [k, n] of errorKinds) console.log(`    ! ${n}× ${k}`);
  return { users, rps: done / STAGE_SECONDS, p95: pct(all, 95), errorRate: errorCount / Math.max(done, 1) };
}

console.log(`Load test → ${BASE} · ${LEVELS.join("/")} users · ${STAGE_SECONDS}s per stage · reads only`);
const results = [];
for (const n of LEVELS) results.push(await stage(n));

console.log("\nSummary");
for (const r of results) console.log(`  ${String(r.users).padStart(3)} users  ${r.rps.toFixed(1).padStart(6)} req/s  p95 ${r.p95.toFixed(0).padStart(5)} ms  errors ${(r.errorRate * 100).toFixed(2)}%`);
const worst = Math.max(...results.map((r) => r.errorRate));
console.log(worst > 0.01 ? `\nFAIL — error rate above 1% (${(worst * 100).toFixed(2)}%)` : "\nPASS — error rate under 1% at every level");
process.exit(worst > 0.01 ? 1 : 0);
