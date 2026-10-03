/**
 * Live UI proof of /ops/runsheets and /ops/ndr (§10 M3, §11) in headless
 * Chrome, signed in as the Kandy ops desk.
 *
 * Drives the screens the way a person does — clicks, Tab/Enter/Escape, arrow
 * keys on the tab strip — and checks every outcome against the database, not
 * just the toast:
 *   runsheets: register + total, CSV export (row count = server total),
 *              keyboard-open drawer, create → fill → add → dispatch (Escape on
 *              the confirm changes nothing; confirming dispatches), force-close
 *              gated on checkbox + 10-char notes, behind a confirm.
 *   NDR:       tallies = API, CSV export, Overdue tile filter on a fixture row,
 *              keyboard-open drawer, instruct reattempt, close with reason
 *              (disabled under 10 chars, confirm), arrow-key tab switch,
 *              start a return by ops decision (confirm), dispatch it (confirm),
 *              hand it back with a name (confirm) → POD on record.
 * Fails on any console error or page error.
 *
 *   bun --env-file=../../.env scripts/ui-ops-delivery.ts
 */

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { chromium, type Page } from "playwright-core";
import { readFileSync } from "node:fs";
import { and, eq, inArray, like } from "drizzle-orm";
import type { AppRouterClient } from "../src/api";
import { finishMfa } from "./lib/mfa";
import { CMB_BRANCH, railToKandyHub } from "./lib/rail";
import { retireRun } from "./lib/retire";

const BASE = process.env.UI_CHECK_BASE ?? "http://localhost:4200";
const { db } = await import("../src/api/database");
const { hardenScriptReads } = await import("./lib/db-retry");
hardenScriptReads(db);
const { rateLimit } = await import("../src/api/database/schema/shared");
const { ndr, rto, runsheet } = await import("../src/api/database/schema/delivery");
const { parcel } = await import("../src/api/database/schema/parcels");
await db.delete(rateLimit);

let keySeq = 0;
const key = (l: string) => `ui-ops-${l}-${Date.now()}-${++keySeq}`;
function clientFor(token?: string, idemKey?: string): AppRouterClient {
  return createORPCClient(
    new RPCLink({
      url: `${BASE}/api/rpc`,
      headers: () => ({
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(idemKey ? { "idempotency-key": idemKey } : {}),
      }),
    }),
  );
}
const anon = clientFor();
async function login(phone: string) {
  await db.delete(rateLimit).where(like(rateLimit.bucket, "%identity.requestOtp"));
  const c = await anon.identity.requestOtp({ phone });
  if (!c.devCode) throw new Error(`no dev OTP for ${phone}`);
  return finishMfa(BASE, await anon.identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode, deviceId: "ui-ops" }));
}

let pass = 0;
const failures: string[] = [];
function check(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
async function step(label: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    check(true, label, detail ?? "");
  } catch (error) {
    check(false, label, (error as Error).message.split("\n")[0]!.slice(0, 240));
    // Leave evidence: what was on screen and which dialogs were open.
    const shot = `/tmp/ui-ops-fail-${failures.length}.png`;
    await page?.screenshot({ path: shot, fullPage: true }).catch(() => {});
    const open = await page?.getByRole("dialog").evaluateAll((ds) => ds.map((d) => d.getAttribute("aria-labelledby") && document.getElementById(d.getAttribute("aria-labelledby")!)?.textContent)).catch(() => []);
    console.log(`        screenshot ${shot}; open dialogs: ${JSON.stringify(open)}`);
  }
}

const KDY = "brn_kdy_hub";
const kdyOps = await login("+94779012345");
const admin = await login("+94773456789");
const kdyRider = await login("+94778901234");
const ops = clientFor(kdyOps.accessToken);

// ── Fixtures, through the real API ────────────────────────────────────────────
// Retire the Kandy rider's live run (one per rider per day) the audited way.
for (const open of await ops.delivery.runsheetList({ riderId: kdyRider.user.id, status: ["draft", "dispatched"] })) {
  await retireRun(clientFor(kdyOps.accessToken, key("retire")), open, "left open by an earlier pass, retired before the UI proof");
}
// NDR fixtures are chosen BEFORE the runsheet part: dispatching a run pulls its
// stops OutForDelivery, so the two sets must never overlap.
const liveOpen = await db
  .select()
  .from(ndr)
  .where(and(eq(ndr.branchId, KDY), eq(ndr.state, "open")))
  .limit(80);
const withParcel: (typeof liveOpen)[number][] = [];
for (const r of liveOpen) {
  const [p] = await db.select().from(parcel).where(eq(parcel.id, r.parcelId));
  if (p?.status === "DeliveryAttempted") withParcel.push(r);
  if (withParcel.length === 3) break;
}
if (withParcel.length < 3) throw new Error(`need 3 open Kandy NDRs on DeliveryAttempted parcels, found ${withParcel.length}`);

// Runsheet stops: two parcels booked and railed for this run alone — fresh
// (no attempts), AtDestHub, typed into "Add stops" by AWB. Never "Fill from
// ready stock": that loads every ready parcel at the hub.
const stopAwbs: string[] = [];
for (let i = 0; i < 2; i += 1) {
  const created = await clientFor(admin.accessToken, key(`stage-${i}`)).parcels.create({
    merchantId: "mch_ceylon_threads",
    branchId: CMB_BRANCH,
    weightGrams: 600,
    declaredValueCents: 80_000,
    codAmountCents: 0,
    originAddress: "12 Dharmapala Mawatha, Kandy",
    consigneeName: `UI Ops Fixture ${i + 1}`,
    consigneePhone: "+94761112233",
    destAddress: `${i + 3} Peradeniya Road, Kandy`,
  });
  stopAwbs.push(created.parcel.awb);
}
await railToKandyHub({ clientFor, login, adminToken: admin.accessToken, awbs: stopAwbs, key, label: "ui-ops" });
for (const awb of stopAwbs) {
  const [p] = await db.select().from(parcel).where(eq(parcel.awb, awb));
  if (p?.status !== "AtDestHub" || p.deliveryAttempts !== 0) throw new Error(`stop fixture ${awb}: ${p?.status}/${p?.deliveryAttempts}`);
}

const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
await context.addInitScript(
  ([k, v]: string[]) => {
    localStorage.setItem(k!, v!);
    localStorage.setItem("natex.deviceId", "ui-ops");
  },
  [
    "natex.session",
    JSON.stringify({
      accessToken: kdyOps.accessToken,
      refreshToken: kdyOps.refreshToken,
      expiresAt: Date.now() + kdyOps.expiresIn * 1000,
      user: kdyOps.user,
    }),
  ],
);
const page = await context.newPage();
const problems: string[] = [];
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const t = m.text();
  if (/React DevTools|\[vite\]|favicon|onedollarstats|analytics/i.test(t)) return;
  problems.push(t.slice(0, 300));
});
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message.slice(0, 300)}`));

async function exportRows(p: Page): Promise<string[]> {
  const [download] = await Promise.all([
    p.waitForEvent("download", { timeout: 30_000 }),
    p.getByRole("button", { name: "Export CSV" }).first().click(),
  ]);
  const path = await download.path();
  return readFileSync(path!, "utf8").replace(/^﻿/, "").trim().split(/\r?\n/);
}
const dialog = (name: string | RegExp) => page.getByRole("dialog", { name });

// ═══════════════════════════════════════════════════════════════ runsheets
console.log(`\nUI proof — /ops/runsheets → ${BASE}`);
await page.goto(`${BASE}/ops/runsheets`, { waitUntil: "networkidle" });

await step("the register renders under the ops shell, with Runsheets in the nav", async () => {
  await page.getByRole("heading", { name: "Runsheets" }).waitFor();
  await page.getByRole("link", { name: "Runsheets" }).waitFor();
});

await step("All filter: the footer total equals the server's", async () => {
  await page.getByLabel("Status").selectOption("all");
  const api = await ops.delivery.runsheetPage({ page: 1, pageSize: 1 });
  await page.getByText(new RegExp(`of\\s+${api.total}\\s+rows`)).waitFor({ timeout: 10_000 });
  return `${api.total} rows`;
});

await step("CSV export carries every filtered row, not just the visible page", async () => {
  const lines = await exportRows(page);
  const api = await ops.delivery.runsheetPage({ page: 1, pageSize: 1 });
  if (!lines[0]!.startsWith("code,run_date,rider,status")) throw new Error(`header ${lines[0]}`);
  if (lines.length - 1 !== api.total) throw new Error(`csv ${lines.length - 1} rows, server ${api.total}`);
  return `${lines.length - 1} rows + header`;
});

await step("a row opens its drawer from the keyboard (focus + Enter), Escape closes it", async () => {
  const row = page.locator("tbody tr").first();
  await row.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog").getByText("COD expected").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
});

let sheetId = "";
let sheetCode = "";
await step("New runsheet → rider → Open as draft opens the new run's drawer", async () => {
  await page.getByRole("button", { name: "New runsheet" }).click();
  const d = dialog("Open a runsheet");
  await d.getByLabel("Rider").selectOption(kdyRider.user.id);
  await d.getByRole("button", { name: "Open as draft" }).click();
  await page.getByRole("button", { name: /Fill from ready stock/ }).waitFor();
  const [row] = await db
    .select()
    .from(runsheet)
    .where(and(eq(runsheet.riderId, kdyRider.user.id), eq(runsheet.status, "draft")));
  if (!row) throw new Error("no draft row in the DB");
  sheetId = row.id;
  sheetCode = row.code;
  await page.getByRole("dialog").getByText(sheetCode).first().waitFor();
  return sheetCode;
});

await step("typed AWBs → Add stops: each AWB gets a verdict, exactly those stops land in the DB", async () => {
  await page.getByLabel("Add stops").fill(stopAwbs.join("\n"));
  await page.getByRole("button", { name: /^Add 2 stops$/ }).click();
  await page.getByText(/stops? added\./).waitFor({ timeout: 30_000 });
  for (const awb of stopAwbs) {
    await page.getByRole("dialog").locator("li", { hasText: awb }).getByText("added", { exact: true }).waitFor();
  }
  const [row] = await db.select().from(runsheet).where(eq(runsheet.id, sheetId));
  if (!row || row.plannedCount !== 2) throw new Error(`planned ${row?.plannedCount}`);
  return `${row.plannedCount} stops: ${stopAwbs.join(", ")}`;
});

await step("Dispatch asks first; Escape on the confirm leaves the run a draft", async () => {
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  await dialog("Hand this van over?").waitFor();
  await page.keyboard.press("Escape");
  await dialog("Hand this van over?").waitFor({ state: "detached" });
  const [row] = await db.select().from(runsheet).where(eq(runsheet.id, sheetId));
  if (row!.status !== "draft") throw new Error(`status ${row!.status}`);
});

await step("confirming dispatches the van: DB status dispatched", async () => {
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  await dialog("Hand this van over?").getByRole("button", { name: /^Dispatch \d+ stop/ }).click();
  await page.getByText(/out for delivery\./).waitFor({ timeout: 45_000 });
  const [row] = await db.select().from(runsheet).where(eq(runsheet.id, sheetId));
  if (row!.status !== "dispatched") throw new Error(`status ${row!.status}`);
});

await step("force-close stays disabled until the write-off box is ticked and notes reach 10 chars", async () => {
  const closeBtn = page.getByRole("button", { name: "Close the run" });
  await closeBtn.waitFor();
  if (await closeBtn.isEnabled()) throw new Error("enabled with no checkbox");
  await page.getByLabel("Write off the open stops and close").check();
  await page.getByLabel("Notes").fill("too short");
  if (await closeBtn.isEnabled()) throw new Error("enabled with 9-char notes");
  await page.getByLabel("Notes").fill("UI proof: van recalled before any attempt.");
  if (!(await closeBtn.isEnabled())) throw new Error("still disabled with valid notes");
});

await step("force-close behind its confirm: DB closed, stops written off", async () => {
  await page.getByRole("button", { name: "Close the run" }).click();
  await dialog("Force-close this run?").getByRole("button", { name: "Close the run" }).click();
  await page.getByText(/^Closed\./).waitFor({ timeout: 45_000 });
  const [row] = await db.select().from(runsheet).where(eq(runsheet.id, sheetId));
  if (row!.status !== "closed") throw new Error(`status ${row!.status}`);
  return sheetCode;
});
// The confirm animates out after the run closes; an Escape pressed while it is
// still the top layer goes to it, not to the drawer. Wait for it to be gone,
// then Escape must close the drawer (the next step asserts the detach).
await dialog("Force-close this run?").waitFor({ state: "detached" });
await page.keyboard.press("Escape");

let draftId = "";
await step("a second draft the same day is cancelled from the drawer: reason gate, confirm, DB cancelled", async () => {
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "New runsheet" }).click();
  const d = dialog("Open a runsheet");
  await d.getByLabel("Rider").selectOption(kdyRider.user.id);
  await d.getByRole("button", { name: "Open as draft" }).click();
  await page.getByRole("button", { name: /Fill from ready stock/ }).waitFor();
  const [row] = await db
    .select()
    .from(runsheet)
    .where(and(eq(runsheet.riderId, kdyRider.user.id), eq(runsheet.status, "draft")));
  if (!row) throw new Error("no draft row in the DB");
  draftId = row.id;
  const cancelBtn = page.getByRole("button", { name: "Cancel the draft" });
  if (await cancelBtn.isEnabled()) throw new Error("enabled with no reason");
  await page.getByLabel("Reason for cancelling the draft").fill("UI proof: van failed its morning check.");
  await cancelBtn.click();
  await dialog("Cancel this draft run?").getByRole("button", { name: "Cancel the draft" }).click();
  await page.getByText(/^Cancelled\./).waitFor({ timeout: 30_000 });
  const [after] = await db.select().from(runsheet).where(eq(runsheet.id, draftId));
  if (after!.status !== "cancelled") throw new Error(`status ${after!.status}`);
  return `${row.code} → cancelled`;
});
await page.keyboard.press("Escape");

// ═══════════════════════════════════════════════════════════════ NDR
console.log("\nUI proof — /ops/ndr");
const [toInstruct, toClose, toReturn] = withParcel as [typeof liveOpen[number], typeof liveOpen[number], typeof liveOpen[number]];
const originalSla = toInstruct.slaDueAt;
await db.update(ndr).set({ slaDueAt: new Date(Date.now() - 3_600_000) }).where(eq(ndr.id, toInstruct.id));

await page.goto(`${BASE}/ops/ndr`, { waitUntil: "networkidle" });
await step("the queue renders with NDR & returns in the nav", async () => {
  await page.getByRole("heading", { name: "NDR & returns" }).waitFor();
  await page.getByRole("link", { name: "NDR & returns" }).waitFor();
});

await step("tally tiles equal ndr.counts", async () => {
  const c = await ops.ndr.counts({});
  const tile = page.getByText("Awaiting answer").locator("..");
  await tile.getByText(String(c.open), { exact: true }).waitFor({ timeout: 10_000 });
  const overdueTile = page.getByRole("button", { name: /Overdue/ });
  await overdueTile.getByText(String(c.overdue), { exact: true }).waitFor();
  return `open ${c.open}, overdue ${c.overdue}`;
});

await step("All states: CSV export row count = server total", async () => {
  await page.getByLabel("NDR state").selectOption("all");
  const api = await ops.ndr.page({ page: 1, pageSize: 1 });
  await page.getByText(new RegExp(`of\\s+${api.total}\\s+rows`)).waitFor({ timeout: 10_000 });
  const lines = await exportRows(page);
  if (!lines[0]!.startsWith("awb,merchant,state")) throw new Error(`header ${lines[0]}`);
  if (lines.length - 1 !== api.total) throw new Error(`csv ${lines.length - 1}, server ${api.total}`);
  return `${api.total} rows`;
});

await step("the Overdue tile filters to exactly the overdue rows (fixture row present)", async () => {
  await page.getByLabel("NDR state").selectOption("live");
  await page.getByRole("button", { name: /Overdue/ }).click();
  const api = await ops.ndr.page({ overdueOnly: true, page: 1, pageSize: 100 });
  await page.getByText(new RegExp(`of\\s+${api.total}\\s+rows`)).waitFor({ timeout: 10_000 });
  await page.locator("tbody tr", { hasText: toInstruct.awb }).waitFor();
  if (!(await page.getByLabel("Overdue only").isChecked())) throw new Error("checkbox not in sync with tile");
  return `${api.total} overdue`;
});

await step("keyboard-open the overdue NDR: drawer flags the SLA breach", async () => {
  await page.locator("tbody tr", { hasText: toInstruct.awb }).focus();
  await page.keyboard.press("Enter");
  await dialog(`NDR · ${toInstruct.awb}`).getByText("SLA breached").waitFor();
});

await step("ops instructs a reattempt on the merchant's behalf: NDR leaves open in the DB", async () => {
  const d = dialog(`NDR · ${toInstruct.awb}`);
  await d.getByLabel("Try again", { exact: true }).check();
  await d.getByRole("button", { name: "Send instruction" }).click();
  await d.getByText(/Instruction recorded/).waitFor({ timeout: 15_000 });
  const [row] = await db.select().from(ndr).where(eq(ndr.id, toInstruct.id));
  if (row!.state === "open") throw new Error("still open");
  return `${row!.state}, instruction ${row!.merchantInstruction}`;
});
await page.keyboard.press("Escape");
await db.update(ndr).set({ slaDueAt: originalSla }).where(eq(ndr.id, toInstruct.id));

await step("close: disabled under 10 chars; confirm; DB closed with the reason", async () => {
  await page.getByLabel("Overdue only").uncheck();
  await page.getByLabel("Search NDRs by AWB").fill(toClose.awb);
  const row = page.locator("tbody tr", { hasText: toClose.awb });
  await row.waitFor({ timeout: 10_000 });
  await row.click();
  const d = dialog(`NDR · ${toClose.awb}`);
  const btn = d.getByRole("button", { name: "Close NDR" });
  await d.getByLabel("Reason").fill("dup");
  if (await btn.isEnabled()) throw new Error("enabled with a 3-char reason");
  const reason = "UI proof: duplicate of a report already settled by phone.";
  await d.getByLabel("Reason").fill(reason);
  await btn.click();
  await dialog("Close this NDR?").getByRole("button", { name: "Close NDR" }).click();
  await d.getByText(/NDR closed/).waitFor({ timeout: 15_000 });
  const [r] = await db.select().from(ndr).where(eq(ndr.id, toClose.id));
  if (r!.state !== "closed" || r!.closeReason !== reason) throw new Error(`${r!.state} / ${r!.closeReason}`);
});
await page.keyboard.press("Escape");

await step("ArrowRight on the tab strip switches to Returns and records ?tab=rto", async () => {
  await page.getByRole("tab", { name: /Non-delivery reports/ }).focus();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("tab", { name: /Returns \(RTO\)/, selected: true }).waitFor();
  if (!page.url().includes("tab=rto")) throw new Error(page.url());
  if ((await page.evaluate(() => document.activeElement?.id)) !== "tab-rto") throw new Error("focus did not follow");
});

await step("RTO CSV export = server total", async () => {
  await page.getByLabel("Return state").selectOption("all");
  const api = await ops.ndr.rtoPage({ page: 1, pageSize: 1 });
  await page.getByText(new RegExp(`of\\s+${api.total}\\s+rows`)).waitFor({ timeout: 10_000 });
  const lines = await exportRows(page);
  if (lines.length - 1 !== api.total) throw new Error(`csv ${lines.length - 1}, server ${api.total}`);
  return `${api.total} rows`;
});

let rtoId = "";
await step("Start a return (ops decision) behind a confirm: RTO row + parcel RTOInitiated", async () => {
  await page.getByRole("button", { name: "Start a return" }).click();
  const d = dialog("Start a return by ops decision");
  await d.getByLabel("AWB").fill(toReturn.awb);
  await d.getByLabel("Reason").fill("UI proof: consignee unreachable for a week, merchant agreed.");
  await d.getByRole("button", { name: "Start return" }).click();
  await dialog("Send this parcel back to the merchant?").getByRole("button", { name: "Start return" }).click();
  await dialog(`Return · ${toReturn.awb}`).waitFor({ timeout: 15_000 });
  const [r] = await db.select().from(rto).where(and(eq(rto.parcelId, toReturn.parcelId), inArray(rto.state, ["initiated"])));
  const [p] = await db.select().from(parcel).where(eq(parcel.id, toReturn.parcelId));
  if (!r || p!.status !== "RTOInitiated") throw new Error(`rto ${r?.id} parcel ${p!.status}`);
  rtoId = r.id;
  return toReturn.awb;
});

await step("dispatch the return leg (confirm): DB in_transit", async () => {
  const d = dialog(`Return · ${toReturn.awb}`);
  await d.getByRole("button", { name: "Dispatch return leg" }).click();
  await dialog("Dispatch the return leg?").getByRole("button", { name: "Dispatch" }).click();
  await d.getByText("Return leg dispatched.").waitFor({ timeout: 15_000 });
  const [r] = await db.select().from(rto).where(eq(rto.id, rtoId));
  if (r!.state !== "in_transit") throw new Error(r!.state);
});

await step("hand-back needs a name, confirms, writes the POD: DB delivered", async () => {
  const d = dialog(`Return · ${toReturn.awb}`);
  const btn = d.getByRole("button", { name: "Record hand-back" });
  if (await btn.isEnabled()) throw new Error("enabled with no name");
  await d.getByLabel("Received by").fill("Sanjay Perera");
  await btn.click();
  await dialog("Record the hand-back?").getByRole("button", { name: "Record hand-back" }).click();
  await d.getByText(/Proof of hand-back on record/).waitFor({ timeout: 15_000 });
  const [r] = await db.select().from(rto).where(eq(rto.id, rtoId));
  const [p] = await db.select().from(parcel).where(eq(parcel.id, toReturn.parcelId));
  if (r!.state !== "delivered" || p!.status !== "RTODelivered") throw new Error(`${r!.state} / ${p!.status}`);
});

check(problems.length === 0, "no console or page errors across both screens", problems.join(" | "));
await browser.close();

console.log(`\n${"─".repeat(60)}`);
if (failures.length === 0) {
  console.log(`ops delivery UI proof: ${pass}/${pass} checks passed\n`);
  process.exit(0);
}
console.log(`ops delivery UI proof: ${pass} passed, ${failures.length} FAILED`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
