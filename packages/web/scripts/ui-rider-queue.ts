/**
 * Rider offline queue — the PHONE half of §7, under load.
 *
 * `soak-sync.ts` proves the server applies 500 queued operations in device
 * order. This proves the app's own outbox (`packages/mobile/lib/outbox.ts`)
 * produces that order, driving the real Expo app on :4300:
 *
 *   - the API is unreachable for the whole capture (requests to /api/rpc are
 *     aborted, the app bundle still loads, which is what a dead SIM looks like)
 *   - six doorstep outcomes, deliveries and failures interleaved, each written
 *     to the phone first: the screen moves on with no server answer
 *   - the device clock runs BACKWARDS between taps, so clock order and tap
 *     order disagree; anything sorting by clock would scramble the queue
 *   - after three taps the app is force-quit and cold-started: the queue comes
 *     back from disk and the seq counter carries on, it does not restart at 1
 *   - reconnect: every push the app sends carries its operations in strictly
 *     ascending seq = tap order; the server journal holds exactly those six,
 *     seq 1..6 with no gaps, all applied once, clockTs kept verbatim
 *   - a second drain after reconnect pushes nothing (nothing re-sent)
 *
 *   bun --env-file=../../.env scripts/ui-rider-queue.ts
 */

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { and, eq, inArray, like } from "drizzle-orm";
import type { AppRouterClient } from "../src/api";
import { finishMfa } from "./lib/mfa";
import { CMB_BRANCH, railToKandyHub } from "./lib/rail";
import { retireRun } from "./lib/retire";

const API = process.env.UI_RIDER_API ?? "http://localhost:4200";
const APP = process.env.UI_RIDER_APP ?? "http://localhost:4300";
const DEVICE = `rider-queue-${Date.now()}`;
const N = 6;

const { db } = await import("../src/api/database");
const { hardenScriptReads } = await import("./lib/db-retry");
hardenScriptReads(db);
const { rateLimit } = await import("../src/api/database/schema/shared");
const { syncOperation } = await import("../src/api/database/schema/sync");
await db.delete(rateLimit);

let keySeq = 0;
const key = (l: string) => `ui-queue-${l}-${Date.now()}-${++keySeq}`;
function clientFor(token?: string, idem?: string): AppRouterClient {
  return createORPCClient(
    new RPCLink({
      url: `${API}/api/rpc`,
      headers: () => ({
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(idem ? { "idempotency-key": idem } : {}),
      }),
    }),
  );
}
const anon = clientFor();

let pass = 0;
const failures: string[] = [];
function check(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(`${label}: ${detail || "assertion failed"}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
async function login(phone: string, deviceId?: string) {
  await db.delete(rateLimit).where(like(rateLimit.bucket, "%identity.requestOtp"));
  const c = await anon.identity.requestOtp({ phone });
  if (!c.devCode) throw new Error(`no dev OTP for ${phone}`);
  return finishMfa(API, await anon.identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode, deviceId: deviceId ?? null }));
}

console.log(`\nNatEx rider offline queue check → app ${APP}, api ${API}, device ${DEVICE}\n`);

// ── 0. A run of six ─────────────────────────────────────────────────────────
console.log("0. Hub dispatches a six-stop run");
const admin = await login("+94773456789");
const transport = await login("+94777890123");
const ops = await login("+94779012345");
const rider = await login("+94778901234", DEVICE);

const awbs: string[] = [];
for (let i = 0; i < N; i++) {
  const created = await clientFor(admin.accessToken, key(`stage-${i}`)).parcels.create({
    merchantId: "mch_ceylon_threads",
    branchId: CMB_BRANCH,
    weightGrams: 500,
    declaredValueCents: 40_000,
    codAmountCents: 0,
    originAddress: "12 Dharmapala Mawatha, Kandy",
    consigneeName: `Queue ${i + 1}`,
    consigneePhone: "+94761112233",
    destAddress: `${40 + i} William Gopallawa Mawatha, Kandy`,
  });
  awbs.push(created.parcel.awb);
}
// Real custody chain — Bagged → InTransit needs a sealed bag on a trip (§6).
await railToKandyHub({ clientFor, login: (p) => login(p), adminToken: admin.accessToken, awbs: awbs, key, label: "queue" });
for (const r of await clientFor(transport.accessToken).delivery.runsheetList({
  riderId: rider.user.id,
  status: ["draft", "dispatched"],
})) {
  await retireRun(clientFor(ops.accessToken, key(`retire-${r.id}`)), r, "retired by rider queue check before a fresh run");
}
const sheet = await clientFor(transport.accessToken, key("create")).delivery.runsheetCreate({ riderId: rider.user.id });
await clientFor(transport.accessToken, key("add")).delivery.runsheetAdd({ runsheetId: sheet.id, awbs });
await clientFor(transport.accessToken, key("dispatch")).delivery.runsheetDispatch({ runsheetId: sheet.id });
check(true, "run dispatched", `${sheet.code}: ${awbs.join(", ")}`);

// Tap plan: interleaved outcomes, and a clock that goes backwards in places.
const MIN = 60_000;
const realStart = Date.now();
const plan = awbs.map((awb, i) => ({
  awb,
  kind: i % 2 === 0 ? ("delivery.fail" as const) : ("delivery.deliver" as const),
  // -10, -40, -5, -50, -15, -45 minutes: non-monotonic, never ahead of the
  // server (a token minted "now" must not look expired).
  clock: realStart + [-10, -40, -5, -50, -15, -45][i]! * MIN,
}));

// ── browser ─────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({ viewport: { width: 400, height: 860 } });
await context.addInitScript(
  ([s, d]: string[]) => {
    if (!localStorage.getItem("natex.session")) localStorage.setItem("natex.session", s!);
    localStorage.setItem("natex.deviceId", d!);
  },
  [
    JSON.stringify({
      accessToken: rider.accessToken,
      refreshToken: rider.refreshToken,
      expiresAt: Date.now() + rider.expiresIn * 1000,
      user: rider.user,
    }),
    DEVICE,
  ],
);

const consoleErrors: string[] = [];
interface Push {
  online: boolean;
  ops: { clientOpId: string; seq: number; clientTs: number; kind: string; awb: string }[];
}
const pushes: Push[] = [];
let apiDown = false;
function watch(p: Page) {
  p.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/ERR_INTERNET_DISCONNECTED|ERR_FAILED|Failed to fetch|favicon|DevTools|onedollarstats/i.test(t)) return;
    consoleErrors.push(t);
  });
  p.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
}
context.on("request", (req) => {
  if (!req.url().includes("/api/rpc/sync/push")) return;
  try {
    const body = JSON.parse(req.postData() ?? "{}") as {
      json?: { operations?: { clientOpId: string; seq: number; clientTs: number; kind: string; payload: { awb: string } }[] };
    };
    pushes.push({
      online: !apiDown,
      ops: (body.json?.operations ?? []).map((o) => ({
        clientOpId: o.clientOpId,
        seq: o.seq,
        clientTs: Number(o.clientTs),
        kind: o.kind,
        awb: o.payload.awb,
      })),
    });
  } catch {
    pushes.push({ online: !apiDown, ops: [] });
  }
});
async function cutApi(ctx: BrowserContext) {
  apiDown = true;
  await ctx.route("**/api/rpc/**", (route) => route.abort("internetdisconnected"));
}
async function restoreApi(ctx: BrowserContext) {
  await ctx.unroute("**/api/rpc/**");
  apiDown = false;
}

async function visible(p: Page, text: string | RegExp, timeout = 15_000): Promise<boolean> {
  try {
    await p.getByText(text).first().waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}
async function sign(p: Page) {
  const pad = p.getByTestId("signature-pad");
  await pad.scrollIntoViewIfNeeded();
  const b = (await pad.boundingBox())!;
  await p.mouse.move(b.x + 30, b.y + 110);
  await p.mouse.down();
  for (let i = 0; i <= 25; i++) await p.mouse.move(b.x + 30 + i * 10, b.y + 110 - Math.sin(i / 3) * 45);
  await p.mouse.up();
}
async function tap(p: Page, step: (typeof plan)[number], n: number) {
  await p.clock.setFixedTime(step.clock);
  await p.goto(`${APP}/stop/${step.awb}`);
  await visible(p, `Queue ${n}`, 20_000);
  if (step.kind === "delivery.fail") {
    await p.getByRole("button", { name: "Could not deliver" }).click();
    await p.getByRole("button", { name: "Nobody at the address" }).click();
    await p.getByRole("button", { name: "Record failed attempt" }).click();
  } else {
    await p.getByRole("button", { name: "Deliver", exact: true }).click();
    await p.getByLabel("Received by").fill(`Signer ${n}`);
    await sign(p);
    await p.getByRole("button", { name: /Confirm delivery/ }).click();
  }
  return visible(p, "Today's deliveries");
}
const readDisk = (p: Page) =>
  p.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith("natex.outbox.v1."));
    return k
      ? (JSON.parse(localStorage.getItem(k)!) as {
          nextSeq: number;
          entries: { clientOpId: string; awb: string; seq: number; state: string; clientTs: number }[];
        })
      : null;
  });

// ── 1. Prime the phone with signal, then lose it ────────────────────────────
console.log("\n1. Run and reason codes reach the phone, then the signal goes");
let page = await context.newPage();
watch(page);
await page.goto(`${APP}/deliveries`);
check(await visible(page, `Next stops · ${N}`, 30_000), "six stops on the phone");
check(await visible(page, /Last synced/, 20_000), "phone has talked to the server");
await page.waitForTimeout(1500); // let the reason-code cache write land
await cutApi(context);

// ── 2. Three taps, then force-quit ──────────────────────────────────────────
console.log("\n2. Three outcomes with no signal, then the app is killed");
for (let i = 0; i < 3; i++) {
  check(await tap(page, plan[i]!, i + 1), `tap ${i + 1} (${plan[i]!.kind}) saved, screen moved on`);
}
check(await visible(page, /Offline · 3 records saved on phone/), "strip: 3 saved on phone");
const before = await readDisk(page);
check(
  JSON.stringify(before?.entries.map((e) => [e.awb, e.seq, e.state])) ===
    JSON.stringify(plan.slice(0, 3).map((s, i) => [s.awb, i + 1, "pending"])),
  "on disk: 3 pending, seq 1..3 in tap order",
  JSON.stringify(before?.entries.map((e) => e.seq)),
);
await page.close(); // force-quit: no unload work, no drain

console.log("\n3. Cold start, still no signal");
page = await context.newPage();
watch(page);
await page.clock.setFixedTime(plan[2]!.clock);
await page.goto(`${APP}/deliveries`);
check(await visible(page, /Offline · 3 records saved on phone/, 30_000), "queue survived the kill: 3 saved on phone");
for (let i = 3; i < N; i++) {
  check(await tap(page, plan[i]!, i + 1), `tap ${i + 1} (${plan[i]!.kind}) saved after restart`);
}
check(await visible(page, /Offline · 6 records saved on phone/), "strip: 6 saved on phone");
const disk = await readDisk(page);
const seqs = disk?.entries.map((e) => e.seq) ?? [];
check(JSON.stringify(seqs) === "[1,2,3,4,5,6]", "seq carried on across the restart — no reset to 1", JSON.stringify(seqs));
check(
  JSON.stringify(disk?.entries.map((e) => e.awb)) === JSON.stringify(awbs),
  "on disk in tap order",
);
const clocks = disk?.entries.map((e) => e.clientTs) ?? [];
check(
  clocks.some((t, i) => i > 0 && t < clocks[i - 1]!),
  "device clock ran backwards between taps — clock order ≠ tap order",
  clocks.map((t) => `${Math.round((t - realStart) / MIN)}m`).join(" "),
);
check(
  JSON.stringify(clocks) === JSON.stringify(plan.map((p) => p.clock)),
  "each record holds the clock reading at its own tap",
);
const unmoved = await Promise.all(awbs.map((a) => clientFor(ops.accessToken).parcels.get({ awbOrId: a })));
check(unmoved.every((p) => p.parcel.status === "OutForDelivery"), "server unmoved while offline", unmoved.map((p) => p.parcel.status).join(","));

// ── 4. Reconnect ────────────────────────────────────────────────────────────
console.log("\n4. Signal returns");
const offlinePushes = pushes.length;
await page.clock.setFixedTime(Date.now());
await restoreApi(context);
await page.getByRole("button", { name: "Sync now" }).click();
check(await visible(page, "All records synced", 30_000), "outbox drained");

const all = pushes.filter((p) => p.ops.length > 0);
check(all.length > 0 && offlinePushes > 0, "the app kept trying while offline", `${offlinePushes} aborted push(es) before reconnect`);
check(
  all.every((p) => p.ops.every((o, i) => i === 0 || o.seq > p.ops[i - 1]!.seq)),
  "EVERY push the app sent (offline attempts included) is in ascending seq",
  all.map((p) => `[${p.ops.map((o) => o.seq).join(",")}]`).join(" "),
);
const online = pushes.filter((p) => p.online && p.ops.length > 0);
const sent = online.flatMap((p) => p.ops);
check(
  JSON.stringify(sent.map((o) => o.awb)) === JSON.stringify(awbs) && JSON.stringify(sent.map((o) => o.seq)) === "[1,2,3,4,5,6]",
  "on reconnect the app sent all six in tap order, once",
  `${online.length} push(es): ${sent.map((o) => o.seq).join(",")}`,
);
check(
  JSON.stringify(sent.map((o) => o.kind)) === JSON.stringify(plan.map((p) => p.kind)),
  "deliveries and failures interleaved exactly as tapped",
);

const ids = disk!.entries.map((e) => e.clientOpId);
const journal = await db
  .select()
  .from(syncOperation)
  .where(and(eq(syncOperation.deviceId, DEVICE), inArray(syncOperation.clientOpId, ids)));
journal.sort((a, b) => a.seq - b.seq);
check(journal.length === N, "server journal: exactly six operations from this device", String(journal.length));
check(
  JSON.stringify(journal.map((j) => j.clientOpId)) === JSON.stringify(ids),
  "server journal seq order = tap order, by the phone's own ULIDs",
);
check(journal.every((j) => j.state === "applied"), "all six applied, none duplicated or refused", journal.map((j) => j.state).join(","));
check(
  journal.every((j, i) => Math.abs((j.clientTs?.getTime() ?? 0) - plan[i]!.clock) < 1000),
  "server kept each device clock reading verbatim (used as evidence, not order)",
);
const after = await Promise.all(awbs.map((a) => clientFor(ops.accessToken).parcels.get({ awbOrId: a })));
check(
  after.every((p, i) => p.parcel.status === (plan[i]!.kind === "delivery.deliver" ? "Delivered" : "DeliveryAttempted")),
  "every parcel landed in the state its tap meant",
  after.map((p) => p.parcel.status).join(","),
);

console.log("\n5. Nothing is sent twice");
const settledPushes = pushes.length;
await page.getByRole("button", { name: "Sync now" }).click();
await page.waitForTimeout(3000);
const resent = pushes.slice(settledPushes).flatMap((p) => p.ops);
check(resent.length === 0, "a later drain pushes nothing", `${resent.length} op(s) re-sent`);
const stillSix = await db.select().from(syncOperation).where(eq(syncOperation.deviceId, DEVICE));
check(stillSix.length === N, "journal still holds six", String(stillSix.length));
await page.screenshot({ path: "/tmp/ui-rider-queue.png", fullPage: true });

console.log("\n6. Console");
check(consoleErrors.length === 0, "no console or page errors", consoleErrors.slice(0, 4).join(" | "));

await browser.close();
console.log(
  failures.length === 0
    ? `\nALL GREEN — ${pass} offline queue checks passed.\n`
    : `\n${failures.length} FAILED, ${pass} passed:\n  - ${failures.join("\n  - ")}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
