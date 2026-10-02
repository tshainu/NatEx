/**
 * Rider delivery app — live end-to-end check (PROJECT.md §6 POD, §7 offline
 * sync, §10 M3 rider app).
 *
 * Drives the REAL Expo app (web build on :4300) in a headless phone-sized
 * browser, signed in as the Kandy rider, against the live API and database.
 * Nothing is mocked: the hub builds and dispatches a real run first, then the
 * script taps through the screens the way a rider would, and every claim is
 * checked twice — once on screen, once against the server's own records.
 *
 *   1. the run opens with every stop in route order, COD and POD policy shown
 *   2. signature POD + exact-cent COD: a wrong amount keeps the button locked;
 *      the right one delivers; the server has a signature POD, the cash, the
 *      device's ULID as clientId and the device's own clock as clientTs
 *   3. OFFLINE failure: network cut, failure recorded, the screen says
 *      "saved on phone", the outbox is on disk, the server has NOT moved;
 *      network back → drains → server shows the attempt with the reason
 *   4. OTP POD: code requested + verified through the screen, then delivered
 *   5. §7 conflict: delivered offline while ops records a failure on the same
 *      parcel → on reconnect the app shows "Needs ops" and the server has an
 *      open offline_delivery_vs_fail conflict — nothing silently overwritten
 *   6. no console errors / page errors throughout
 *
 * Repeatable: retires any open run for the rider and stages fresh parcels
 * through the audited endpoints each pass (nothing is deleted).
 *
 *   bun --env-file=../../.env scripts/ui-rider.ts
 */

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { chromium, type Page } from "playwright-core";
import { and, desc, eq, like } from "drizzle-orm";
import type { AppRouterClient } from "../src/api";
import { CMB_BRANCH, railToKandyHub } from "./lib/rail";
import { bankRiderCash } from "./lib/cash";
import { retireRun } from "./lib/retire";

const API = process.env.UI_RIDER_API ?? "http://localhost:4200";
const APP = process.env.UI_RIDER_APP ?? "http://localhost:4300";
const DEVICE = "rider-ui-check-device";

const { db } = await import("../src/api/database");
const { hardenScriptReads } = await import("./lib/db-retry");
hardenScriptReads(db);
const { rateLimit } = await import("../src/api/database/schema/shared");
const { deliveryAttempt, deliveryPod } = await import("../src/api/database/schema/delivery");
const { syncConflict } = await import("../src/api/database/schema/sync");
await db.delete(rateLimit);

let keySeq = 0;
const key = (l: string) => `ui-rider-${l}-${Date.now()}-${++keySeq}`;
function clientFor(token?: string, idem?: string, device?: string): AppRouterClient {
  return createORPCClient(
    new RPCLink({
      url: `${API}/api/rpc`,
      headers: () => ({
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(idem ? { "idempotency-key": idem } : {}),
        ...(device ? { "x-device-id": device } : {}),
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
  return anon.identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode, deviceId: deviceId ?? null });
}

console.log(`\nNatEx rider delivery app check → app ${APP}, api ${API}\n`);

// ── 0. The hub's morning ──────────────────────────────────────────────────────
console.log("0. Hub builds and dispatches the rider's run");
const admin = await login("+94773456789");
const transport = await login("+94777890123");
const ops = await login("+94779012345");
const rider = await login("+94778901234", DEVICE);

async function stage(merchantId: string, count: number, label: string, codAmountCents: number) {
  const awbs: string[] = [];
  for (let i = 0; i < count; i++) {
    const created = await clientFor(admin.accessToken, key(`stage-${label}-${i}`)).parcels.create({
      merchantId,
      branchId: CMB_BRANCH,
      weightGrams: 700,
      declaredValueCents: 90_000,
      codAmountCents,
      originAddress: "12 Dharmapala Mawatha, Kandy",
      consigneeName: `Rider UI ${label} ${i + 1}`,
      consigneePhone: "+94761112233",
      destAddress: `${20 + i} Peradeniya Road, Kandy`,
    });
    awbs.push(created.parcel.awb);
  }
  // Real custody chain — Bagged → InTransit needs a sealed bag on a trip (§6).
  await railToKandyHub({ clientFor, login: (p) => login(p), adminToken: admin.accessToken, awbs: awbs, key, label: label });
  return awbs;
}

const open = await clientFor(transport.accessToken).delivery.runsheetList({
  riderId: rider.user.id,
  status: ["draft", "dispatched"],
});
for (const r of open) {
  await retireRun(clientFor(ops.accessToken, key(`retire-${r.id}`)), r, "retired by ui-rider check before a fresh run");
}
const [sigCod, sigFail, sigConflict] = await stage("mch_ceylon_threads", 3, "sig", 0).then(async (plain) => {
  const cod = await stage("mch_ceylon_threads", 1, "sigcod", 185_050);
  return [cod[0]!, plain[0]!, plain[1]!];
});
const [otpAwb] = await stage("mch_lanka_gadgets", 1, "otp", 0);
const stops = [sigCod!, sigFail!, sigConflict!, otpAwb!];

const sheet = await clientFor(transport.accessToken, key("create")).delivery.runsheetCreate({ riderId: rider.user.id });
await clientFor(transport.accessToken, key("add")).delivery.runsheetAdd({ runsheetId: sheet.id, awbs: stops });
await clientFor(transport.accessToken, key("opt")).delivery.runsheetOptimise({ runsheetId: sheet.id });
// COD deliveries now post COLLECT entries; settle what earlier runs left on
// the rider so the §8 cash-ceiling gate at dispatch is not tripped by fixtures.
await bankRiderCash({ clientFor, login: (p) => login(p), riderToken: rider.accessToken, branchId: "brn_kdy_hub", key, label: "ui-rider" });
await clientFor(transport.accessToken, key("dispatch")).delivery.runsheetDispatch({ runsheetId: sheet.id });
check(true, "run built and dispatched", `${sheet.code} with ${stops.length} stops (COD ${sigCod}, fail ${sigFail}, conflict ${sigConflict}, otp ${otpAwb})`);

// ── browser ──────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({ viewport: { width: 400, height: 860 }, hasTouch: false });
const session = {
  accessToken: rider.accessToken,
  refreshToken: rider.refreshToken,
  expiresAt: Date.now() + rider.expiresIn * 1000,
  user: rider.user,
};
await context.addInitScript(
  ([s, d]: string[]) => {
    if (!localStorage.getItem("natex.session")) localStorage.setItem("natex.session", s!);
    localStorage.setItem("natex.deviceId", d!);
  },
  [JSON.stringify(session), DEVICE],
);
const page = await context.newPage();
const consoleErrors: string[] = [];
// The wrong-OTP step expects exactly one 400 from the server; anything beyond
// that budget is a real error.
let expected400 = 0;
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const t = m.text();
  if (expected400 > 0 && /status of 400/.test(t)) {
    expected400 -= 1;
    return;
  }
  // A deliberately cut network logs failed fetches; those are the test, not a defect.
  if (/ERR_INTERNET_DISCONNECTED|Failed to fetch|favicon|DevTools|onedollarstats/i.test(t)) return;
  consoleErrors.push(t);
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

async function shot(name: string) {
  await page.screenshot({ path: `/tmp/ui-rider-${name}.png`, fullPage: true });
}
async function visible(p: Page, text: string | RegExp, timeout = 15_000): Promise<boolean> {
  try {
    await p.getByText(text).first().waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}
async function openStop(awb: string) {
  await page.goto(`${APP}/stop/${awb}`);
  await visible(page, `Stop`, 20_000);
}
const parcelOf = (awb: string) => clientFor(ops.accessToken).parcels.get({ awbOrId: awb });

// ── 1. The run ───────────────────────────────────────────────────────────────
console.log("\n1. The run opens");
await page.goto(`${APP}/deliveries`);
check(await visible(page, "Today's deliveries", 30_000), "Deliveries screen renders");
check(await visible(page, sheet.code), "run code shown", sheet.code);
check(await visible(page, /Next stops · 4/), "all four stops listed as next stops");
check(await visible(page, "COD Rs. 1,850.50"), "COD amount shown on the stop card, to the cent");
check(await visible(page, /otp POD/i) && (await visible(page, /signature POD/i)), "each stop shows its merchant's POD policy");
check(await visible(page, "All records synced"), "sync strip says everything is synced");
await shot("1-run");

// ── 2. Signature + exact-cent COD ───────────────────────────────────────────
console.log("\n2. Signature POD with COD");
await openStop(sigCod!);
await page.getByRole("button", { name: "Deliver", exact: true }).click();
await page.getByLabel("Received by").fill("Kumari Wijesinghe");
await page.getByRole("button", { name: "Family" }).click();
await page.getByLabel("Cash received (Rs.)").fill("1850.49");
check(await visible(page, /Must be exactly Rs\. 1,850\.50/), "one cent short is flagged at the door");
const pad = page.getByTestId("signature-pad");
await pad.scrollIntoViewIfNeeded();
const box = (await pad.boundingBox())!;
await page.mouse.move(box.x + 30, box.y + 120);
await page.mouse.down();
for (let i = 0; i <= 30; i++) {
  await page.mouse.move(box.x + 30 + i * 9, box.y + 120 - Math.sin(i / 3) * 50, { steps: 1 });
}
await page.mouse.up();
const confirm = page.getByRole("button", { name: /Confirm delivery/ });
check(await confirm.isDisabled(), "confirm stays locked while the cash is wrong");
await page.getByLabel("Cash received (Rs.)").fill("1,850.50");
check(await visible(page, "Matches to the cent."), "exact amount accepted");
await shot("2-deliver-form");
check(!(await confirm.isDisabled()), "confirm unlocks with name, signature and exact cash");
await confirm.click();
check(await visible(page, "Today's deliveries"), "returns to the run after saving");
let p1 = await parcelOf(sigCod!);
for (let i = 0; i < 20 && p1.parcel.status !== "Delivered"; i++) {
  await page.waitForTimeout(500);
  p1 = await parcelOf(sigCod!);
}
check(p1.parcel.status === "Delivered", "server: parcel Delivered via the outbox", p1.parcel.status);
const [pod] = await db.select().from(deliveryPod).where(eq(deliveryPod.awb, sigCod!)).orderBy(desc(deliveryPod.ts)).limit(1);
check(pod?.method === "signature" && !!pod.signatureData?.startsWith("data:image/svg+xml"), "server: signature POD stored as SVG", `${pod?.signatureData?.length ?? 0} chars`);
check(pod?.receivedByName === "Kumari Wijesinghe" && pod.receivedByRelation === "family", "server: receiver + relation recorded");
const [att1] = await db.select().from(deliveryAttempt).where(eq(deliveryAttempt.awb, sigCod!)).orderBy(desc(deliveryAttempt.ts)).limit(1);
check(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(att1?.clientId ?? ""), "server: attempt carries the device's ULID", att1?.clientId ?? "none");
check(att1?.clientTs instanceof Date && Math.abs(att1.clientTs.getTime() - Date.now()) < 120_000, "server: device clock recorded as clientTs", String(att1?.clientTs));
check(att1?.deviceId === DEVICE, "server: attempt attributed to this device", att1?.deviceId ?? "none");
// The parcel transition and the run's cash tally are sequential writes in one
// request (no cross-module transaction on Turso), so allow the request to finish.
let run1 = await clientFor(transport.accessToken).delivery.runsheetGet({ runsheetId: sheet.id });
for (let i = 0; i < 20 && run1.cash.collectedCents !== 185_050; i++) {
  await page.waitForTimeout(250);
  run1 = await clientFor(transport.accessToken).delivery.runsheetGet({ runsheetId: sheet.id });
}
check(run1.cash.collectedCents === 185_050, "server: run cash collected = Rs. 1,850.50 exactly", String(run1.cash.collectedCents));
check(await visible(page, "COD in hand"), "run screen shows cash in hand");
check(await visible(page, "Rs. 1,850.50"), "cash in hand matches");

// ── 3. Offline failure ──────────────────────────────────────────────────────
console.log("\n3. Failure recorded with no signal");
await openStop(sigFail!);
await context.setOffline(true);
await page.getByRole("button", { name: "Could not deliver" }).click();
check(await visible(page, "Nobody at the address"), "reason codes available offline");
check(await visible(page, "Returns to merchant"), "reason flags shown (refusal → RTO)");
await page.getByRole("button", { name: "Nobody at the address" }).click();
check(await visible(page, /merchant is notified/), "consequence explained before saving");
await page.getByRole("button", { name: "Record failed attempt" }).click();
check(await visible(page, "Today's deliveries"), "back on the run");
check(await visible(page, /Offline · 1 record saved on phone/), "sync strip: offline, 1 saved on phone");
check(await visible(page, "Failed · not synced"), "stop shows failed-not-synced");
await shot("3-offline");
const stored = await page.evaluate(() => {
  const k = Object.keys(localStorage).find((x) => x.startsWith("natex.outbox.v1."));
  return k ? localStorage.getItem(k) : null;
});
const disk = stored ? (JSON.parse(stored) as { entries: { awb: string; state: string; seq: number }[] }) : null;
const queued = disk?.entries.find((e) => e.awb === sigFail && e.state === "pending");
check(!!queued, "outbox persisted to device storage", queued ? `seq ${queued.seq}` : "missing");
const pOff = await parcelOf(sigFail!);
check(pOff.parcel.status === "OutForDelivery", "server has NOT moved while offline", pOff.parcel.status);
await context.setOffline(false);
await page.getByRole("button", { name: "Sync now" }).click();
check(await visible(page, "All records synced", 20_000), "reconnect drains the outbox");
const pOn = await parcelOf(sigFail!);
check(pOn.parcel.status === "DeliveryAttempted", "server: DeliveryAttempted after drain", pOn.parcel.status);
const [att2] = await db.select().from(deliveryAttempt).where(eq(deliveryAttempt.awb, sigFail!)).orderBy(desc(deliveryAttempt.ts)).limit(1);
check(att2?.reasonCode === "CONSIGNEE_NOT_AT_HOME" && att2.outcome === "failed", "server: failure reason recorded", att2?.reasonCode ?? "none");
const hist2 = await clientFor(ops.accessToken).delivery.history({ awb: sigFail! });
check(!!hist2.ndr, "server: the failure raised an NDR to the merchant (§8)", hist2.ndr ? `${hist2.ndr.id} ${hist2.ndr.state}` : "none");
await openStop(sigFail!);
check(await visible(page, "A non-delivery report went to the merchant"), "rider sees the NDR outcome on the stop");
await page.goto(`${APP}/deliveries`);
await visible(page, "Today's deliveries", 20_000);
check(
  !!att2?.clientTs && !!att2.ts && att2.clientTs.getTime() < att2.ts.getTime(),
  "server: clientTs (tap time, offline) precedes server ts (sync time)",
  `${att2?.clientTs?.toISOString()} < ${att2?.ts?.toISOString()}`,
);

// ── 4. OTP ──────────────────────────────────────────────────────────────────
console.log("\n4. OTP POD");
await openStop(otpAwb!);
await page.getByRole("button", { name: "Deliver", exact: true }).click();
await page.getByLabel("Received by").fill("Ruwan Jayasuriya");
check(await page.getByRole("button", { name: /Confirm delivery/ }).isDisabled(), "cannot confirm before OTP");
await page.getByRole("button", { name: "Send code to consignee" }).click();
const devLine = page.getByText(/DEV \(no SMS gateway\): \d+/);
let devCode = "";
try {
  await devLine.waitFor({ timeout: 15_000 });
  devCode = (await devLine.textContent())?.match(/: (\d+)/)?.[1] ?? "";
} catch {
  /* fall through to the check */
}
check(devCode.length >= 4, "OTP sent; dev code surfaced (flagged DEV, no gateway)", devCode || "none");
await page.getByLabel("Code from consignee").fill("000000");
expected400 = 1;
await page.getByRole("button", { name: "Verify code" }).click();
check(await visible(page, /not|incorrect|wrong|invalid/i, 10_000), "wrong code refused by the server");
await page.getByLabel("Code from consignee").fill(devCode);
await page.getByRole("button", { name: "Verify code" }).click();
check(await visible(page, "OTP verified by server"), "right code verified server-side");
await page.getByRole("button", { name: /Confirm delivery/ }).click();
check(await visible(page, "Today's deliveries"), "back on the run");
let p4 = await parcelOf(otpAwb!);
for (let i = 0; i < 20 && p4.parcel.status !== "Delivered"; i++) {
  await page.waitForTimeout(500);
  p4 = await parcelOf(otpAwb!);
}
check(p4.parcel.status === "Delivered", "server: OTP stop Delivered", p4.parcel.status);
const [pod4] = await db.select().from(deliveryPod).where(eq(deliveryPod.awb, otpAwb!)).orderBy(desc(deliveryPod.ts)).limit(1);
check(pod4?.method === "otp" && pod4.otpVerified === true, "server: POD is a verified OTP");

// ── 5. §7 conflict ──────────────────────────────────────────────────────────
console.log("\n5. Delivered offline while ops failed it (§7 conflict)");
await openStop(sigConflict!);
await context.setOffline(true);
await page.getByRole("button", { name: "Deliver", exact: true }).click();
await page.getByLabel("Received by").fill("Late Signer");
const pad2 = page.getByTestId("signature-pad");
await pad2.scrollIntoViewIfNeeded();
const b2 = (await pad2.boundingBox())!;
await page.mouse.move(b2.x + 40, b2.y + 100);
await page.mouse.down();
for (let i = 0; i <= 25; i++) await page.mouse.move(b2.x + 40 + i * 10, b2.y + 100 + Math.cos(i / 2) * 40);
await page.mouse.up();
await page.getByRole("button", { name: /Confirm delivery/ }).click();
check(await visible(page, "Delivered · not synced"), "delivery saved on phone while offline");
// Meanwhile, at the hub, ops records a failure on the same parcel.
await clientFor(ops.accessToken, key("ops-fail")).delivery.recordFailure({
  awb: sigConflict!,
  reasonCode: "CONSIGNEE_UNREACHABLE",
  notes: "ui-rider check: ops failed it while the rider was offline",
});
await context.setOffline(false);
await page.getByRole("button", { name: "Sync now" }).click();
check(await visible(page, /Needs ops · 1/, 20_000), "app surfaces the conflict as Needs ops");
await shot("5-conflict");
const [conf] = await db
  .select()
  .from(syncConflict)
  .where(and(eq(syncConflict.awb, sigConflict!), eq(syncConflict.state, "open")))
  .limit(1);
check(conf?.policy === "offline_delivery_vs_fail", "server: open offline_delivery_vs_fail conflict in the ops queue", conf?.id ?? "none");
const p5 = await parcelOf(sigConflict!);
check(p5.parcel.status === "DeliveryAttempted", "server state not silently overwritten", p5.parcel.status);
await openStop(sigConflict!);
check(await visible(page, "Conflict — sent to ops"), "stop screen explains the conflict to the rider");
check(await visible(page, /Policy: Offline delivery vs fail/), "stop screen names the §7 policy");
check(await visible(page, "1 record needs ops"), "strip counts the problem, in plain English");
check(await visible(page, /Last synced/), "strip shows server contact after a cold load (no pending pushes)");
await shot("5-stop-conflict");

// ── 6. hygiene ──────────────────────────────────────────────────────────────
console.log("\n6. Console");
check(consoleErrors.length === 0, "no console or page errors", consoleErrors.slice(0, 5).join(" | "));

await browser.close();
console.log(
  failures.length === 0
    ? `\nALL GREEN — ${pass} rider app checks passed.\n`
    : `\n${failures.length} FAILED, ${pass} passed:\n  - ${failures.join("\n  - ")}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
