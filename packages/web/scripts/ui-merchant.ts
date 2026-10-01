/**
 * Live UI proof of the merchant portal (§10 M3: "Merchant portal: booking,
 * bulk upload, tracking, NDR") in headless Chrome, signed in as the seeded
 * merchant Ceylon Threads — and of the ops half of the pickup loop, signed in
 * as the Colombo ops desk.
 *
 * Every outcome is checked against the database or the API, never just a toast:
 *   dashboard   tiles = parcels.summary / pickupRequestCounts / ndr.counts
 *   book        single booking → DB row at Booked with exact COD cents; a
 *               response lost on the wire then a second click replays the same
 *               Idempotency-Key and books ONE parcel; field errors for weight,
 *               3-decimal COD (nothing sent) and a bad phone (server's answer)
 *   bulk CSV    template download; setInputFiles a 152-row file with 2 local
 *               and 2 server-only faults; dry run books nothing; "COD on good
 *               rows" = exact cents; booking runs in 100-row chunks with one
 *               key each; a chunk dropped on the wire is retried with the SAME
 *               key; DB has exactly the good rows; error CSV lists exactly the
 *               4 bad lines; AWB CSV has every line
 *   pickups     request (ticked AWBs) → DB requested; cancel blocked under 5
 *               chars, confirm cancels; the same AWBs are free for a new
 *               request; ops Schedule → rider → manifest → DB scheduled, and
 *               the merchant sees the manifest code
 *   shipments   CSV export row count = server total
 *   tracking    own AWB found; another merchant's AWB reads not found
 *   NDR         arrow-key tab switch records ?tab=rto
 *   drawer      as admin: Delivered / RTO delivered / In transit are never
 *               offered as buttons (evidence-gated, §7)
 *   layout      bleed pages (pickups, tracking, shipments) never overflow
 *               horizontally; tiles and table both visible
 * Fails on any console or page error (except the one expected 404 lookup).
 *
 *   bun --env-file=../../.env scripts/ui-merchant.ts
 */

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { chromium, type Browser, type Page, type Request } from "playwright-core";
import { readFileSync } from "node:fs";
import { and, eq, like, ne, sql } from "drizzle-orm";
import type { AppRouterClient } from "../src/api";
import { humanise, money } from "../src/web/lib/format";
import { parseCsv } from "../src/web/lib/csv";
import { TEMPLATE_HEADER } from "../src/web/lib/bulk-csv";

const BASE = process.env.UI_CHECK_BASE ?? "http://localhost:4200";
const { db } = await import("../src/api/database");
const { rateLimit } = await import("../src/api/database/schema/shared");
const { parcel } = await import("../src/api/database/schema/parcels");
const { pickupRequest, manifest } = await import("../src/api/database/schema/collection");
await db.delete(rateLimit);

const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const TAG = `UIM${RUN}`;
const MERCHANT = "mch_ceylon_threads";

function clientFor(token?: string): AppRouterClient {
  return createORPCClient(
    new RPCLink({
      url: `${BASE}/api/rpc`,
      headers: () => (token ? { authorization: `Bearer ${token}` } : {}),
    }),
  );
}
const anon = clientFor();
type Session = Awaited<ReturnType<typeof anon.identity.verifyOtp>>;
async function login(phone: string): Promise<Session> {
  await db.delete(rateLimit).where(like(rateLimit.bucket, "%identity.requestOtp"));
  const c = await anon.identity.requestOtp({ phone });
  if (!c.devCode) throw new Error(`no dev OTP for ${phone}`);
  return anon.identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode, deviceId: "ui-merchant" });
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
    check(false, label, (error as Error).message.split("\n")[0]!.slice(0, 260));
  }
}

const merchantS = await login("+94775678901");
const opsS = await login("+94772345678");
const adminS = await login("+94773456789");
const riderS = await login("+94771234567");
const merchant = clientFor(merchantS.accessToken);
const admin = clientFor(adminS.accessToken);
if (merchantS.user.merchantId !== MERCHANT) throw new Error(`merchant login is ${merchantS.user.merchantId}`);

const problems: string[] = [];
/** Refusals a step provokes on purpose; anything else ≥ 400 is a failure. */
let expected: { status: number; path: string }[] = [];
const expectedSeen: string[] = [];
async function signedInPage(browser: Browser, s: Session, label: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await context.addInitScript(
    ([k, v]: string[]) => {
      localStorage.setItem(k!, v!);
      localStorage.setItem("natex.deviceId", "ui-merchant");
    },
    [
      "natex.session",
      JSON.stringify({
        accessToken: s.accessToken,
        refreshToken: s.refreshToken,
        expiresAt: Date.now() + s.expiresIn * 1000,
        user: s.user,
      }),
    ],
  );
  const p = await context.newPage();
  p.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/React DevTools|\[vite\]|favicon|onedollarstats|analytics/i.test(t)) return;
    // HTTP failures are judged by the response listener below, which knows the URL.
    if (/Failed to load resource: the server responded/.test(t)) return;
    // The deliberately dropped requests below surface as net::ERR_FAILED.
    if (/ERR_FAILED|Failed to fetch/i.test(t) && droppedOnPurpose > 0) return;
    problems.push(`[${label}] ${t.slice(0, 300)}`);
  });
  p.on("response", (r) => {
    if (r.status() < 400) return;
    const path = new URL(r.url()).pathname;
    if (expected.some((e) => e.status === r.status() && path.endsWith(e.path))) {
      expectedSeen.push(`${r.status()} ${path}`);
      return;
    }
    problems.push(`[${label}] HTTP ${r.status()} ${path}`);
  });
  p.on("pageerror", (e) => problems.push(`[${label}] pageerror: ${e.message.slice(0, 300)}`));
  return p;
}
let droppedOnPurpose = 0;

async function download(p: Page, button: string | RegExp): Promise<string[]> {
  const [d] = await Promise.all([
    p.waitForEvent("download", { timeout: 60_000 }),
    p.getByRole("button", { name: button }).first().click(),
  ]);
  return readFileSync((await d.path())!, "utf8").replace(/^﻿/, "").trim().split(/\r?\n/);
}
async function noHorizontalOverflow(p: Page): Promise<string> {
  const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  if (m.sw > m.iw + 1) throw new Error(`page scrolls sideways: ${m.sw}px > ${m.iw}px`);
  return `${m.sw}px ≤ ${m.iw}px`;
}
const tile = (p: Page, label: string) => p.locator("p.label-xs", { hasText: new RegExp(`^${label}$`) }).locator("..");
// <Field> wraps label text, control, hint and error in one <label>, so the
// control's accessible name carries the hint too; locate by the label span.
type Scope = Pick<Page, "locator">;
const fieldLabel = (p: Scope, label: string) => p.locator(`label:has(> span.label-xs:text-is(${JSON.stringify(label)}))`);
const field = (p: Scope, label: string) => fieldLabel(p, label).locator("input, textarea, select").first();
const fieldError = (p: Scope, label: string) => fieldLabel(p, label).locator("span.text-status-warn");

// Every bulkCreate the browser sends: its key, dry-run flag and row count.
interface Sent {
  key: string;
  dryRun: boolean;
  rows: number;
}
const sent: Sent[] = [];
function record(r: Request) {
  if (!r.url().includes("/api/rpc/parcels/bulkCreate")) return;
  const body = JSON.parse(r.postData() ?? "{}") as { json?: { dryRun?: boolean; rows?: unknown[] } };
  sent.push({ key: r.headers()["idempotency-key"] ?? "", dryRun: body.json?.dryRun === true, rows: body.json?.rows?.length ?? 0 });
}

const browser = await chromium.launch({ channel: "chrome" });
const page = await signedInPage(browser, merchantS, "merchant");
page.on("request", record);

// ═══════════════════════════════════════════════════════════════ dashboard
console.log(`\nUI proof — merchant portal as ${merchantS.user.name} (${MERCHANT}) → ${BASE}, run ${TAG}`);
await page.goto(`${BASE}/merchant`, { waitUntil: "networkidle" });

await step("dashboard tiles equal parcels.summary, pickupRequestCounts and ndr.counts", async () => {
  const [s, pc, n] = await Promise.all([
    merchant.parcels.summary(),
    merchant.collection.pickupRequestCounts({}),
    merchant.ndr.counts({}),
  ]);
  const ndrOpen = n.open + n.instructed + n.reattemptScheduled;
  const want: [string, string][] = [
    ["Booked today", String(s.bookedToday)],
    ["Open shipments", String(s.open)],
    ["COD to collect", money(s.codOpenCents)],
    ["Need your answer", String(ndrOpen)],
    ["Delivered · 30 days", String(s.last30d.delivered)],
    ["COD on deliveries · 30 days", money(s.last30d.deliveredCodCents)],
    ["Returns started · 30 days", String(s.last30d.returnsStarted)],
  ];
  for (const [label, value] of want) {
    await tile(page, label).getByText(value, { exact: true }).waitFor({ timeout: 10_000 });
  }
  const card = page.locator("dl");
  for (const [label, v] of [["Awaiting NatEx", pc.requested], ["Scheduled with a rider", pc.scheduled], ["Cancelled", pc.cancelled]] as const) {
    const dd = await card.locator("div", { has: page.getByText(label, { exact: true }) }).locator("dd").innerText();
    if (dd.trim() !== String(v)) throw new Error(`${label}: UI ${dd} vs API ${v}`);
  }
  return `open ${s.open}, COD ${money(s.codOpenCents)}, NDR ${ndrOpen}, pickups ${pc.requested}/${pc.scheduled}/${pc.cancelled}`;
});

await step("status breakdown links to the filtered Shipments list", async () => {
  const s = await merchant.parcels.summary();
  const first = s.byStatus.find((r) => r.count > 0);
  if (!first) return "no parcels yet";
  await page.locator(`a[href="/merchant/parcels?status=${first.status}"]`).click();
  await page.getByRole("heading", { name: "Shipments" }).waitFor();
  const api = await merchant.parcels.list({ page: 1, pageSize: 1, status: [first.status] });
  await page.getByText(new RegExp(`of\\s+${api.total}\\s+rows`)).waitFor({ timeout: 10_000 });
  return `${first.status}: ${api.total}`;
});

// ═══════════════════════════════════════════════════════════════ single booking
console.log("\nUI proof — /merchant/book (single)");
await page.goto(`${BASE}/merchant/book`, { waitUntil: "networkidle" });
const singleName = `${TAG} Single`;
async function fillSingle(over: Partial<Record<string, string>> = {}) {
  const v = {
    "Consignee name": singleName,
    "Consignee phone": "0771234567",
    "Delivery address": "27 Flower Road, Colombo 07",
    "Weight (kg)": "1.25",
    "COD to collect (Rs.)": "1250.50",
    "Declared value (Rs.)": "3000",
    ...over,
  };
  for (const [label, value] of Object.entries(v)) await field(page, label).fill(value!);
}

await step("weight with 4 decimals and COD with 3 decimals: field errors, nothing sent", async () => {
  const before = sent.length;
  await fillSingle({ "Weight (kg)": "1.2345", "COD to collect (Rs.)": "10.505" });
  await page.getByRole("button", { name: "Book parcel" }).click();
  await fieldError(page, "Weight (kg)").waitFor();
  await fieldError(page, "COD to collect (Rs.)").waitFor();
  if (sent.length !== before) throw new Error(`${sent.length - before} request(s) sent`);
  return `"${await fieldError(page, "Weight (kg)").innerText()}" / "${await fieldError(page, "COD to collect (Rs.)").innerText()}"`;
});

await step("a non-Sri-Lankan phone: the server's answer lands under the phone field, nothing booked", async () => {
  await fillSingle({ "Consignee phone": "12345" });
  await page.getByRole("button", { name: "Book parcel" }).click();
  await fieldError(page, "Consignee phone").waitFor({ timeout: 15_000 });
  const rows = await db.select().from(parcel).where(eq(parcel.consigneeName, singleName));
  if (rows.length) throw new Error(`${rows.length} parcel(s) booked`);
  return await fieldError(page, "Consignee phone").innerText();
});

let singleAwb = "";
await step("response lost on the wire, second click replays the same key: ONE parcel, Booked, COD 125050 cents", async () => {
  await fillSingle();
  let dropped = false;
  await page.route("**/api/rpc/parcels/bulkCreate", async (route) => {
    if (dropped) return route.continue();
    dropped = true;
    droppedOnPurpose += 1;
    await route.fetch(); // the server books it …
    await route.abort("failed"); // … and the browser never hears back
  });
  const before = sent.length;
  await page.getByRole("button", { name: "Book parcel" }).click();
  await page.getByText(/a retry will not book it twice|could not be booked|Failed to fetch/i).first().waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "Book parcel" }).click();
  singleAwb = (await page.getByTestId("booked-awb").innerText({ timeout: 20_000 })).trim();
  await page.unroute("**/api/rpc/parcels/bulkCreate");
  const mine = sent.slice(before);
  if (mine.length !== 2 || mine[0]!.key !== mine[1]!.key) throw new Error(`keys ${mine.map((m) => m.key).join(", ")}`);
  const rows = await db.select().from(parcel).where(eq(parcel.consigneeName, singleName));
  if (rows.length !== 1) throw new Error(`${rows.length} parcels in the DB`);
  const p = rows[0]!;
  if (p.awb !== singleAwb || p.status !== "Booked" || p.codAmountCents !== 125_050 || p.weightGrams !== 1250 || p.declaredValueCents !== 300_000 || p.merchantId !== MERCHANT)
    throw new Error(`${p.awb} ${p.status} cod ${p.codAmountCents} w ${p.weightGrams} dv ${p.declaredValueCents} ${p.merchantId}`);
  if (p.consigneePhone !== "+94771234567") throw new Error(`phone stored as ${p.consigneePhone}`);
  return `${singleAwb}, both attempts keyed ${mine[0]!.key.slice(0, 8)}…`;
});
await step("the booked card shows COD in rupees from cents", async () => {
  await page.getByRole("status").getByText(`COD to collect: ${money(125_050)}`).waitFor();
});

// ═══════════════════════════════════════════════════════════════ bulk CSV
console.log("\nUI proof — /merchant/book?mode=csv");
await step("ArrowRight on the method tabs opens the CSV upload and records ?mode=csv", async () => {
  await page.getByRole("tab", { name: "Single parcel" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("tab", { name: "Bulk CSV upload", selected: true }).waitFor();
  if (!page.url().includes("mode=csv")) throw new Error(page.url());
});

await step("Download template: the header row is exactly the template columns, plus one example", async () => {
  const lines = await download(page, "Download template");
  if (lines[0] !== TEMPLATE_HEADER.join(",")) throw new Error(lines[0]);
  if (lines.length !== 2) throw new Error(`${lines.length} lines`);
  return lines[0];
});

const GOOD = 148;
const header = TEMPLATE_HEADER.join(",");
const good: string[] = [];
let expectedCod = 0;
for (let i = 1; i <= GOOD; i += 1) {
  const cod = i % 3 === 0 ? "" : `${1000 + i}.75`;
  if (cod) expectedCod += (1000 + i) * 100 + 75;
  good.push(`${TAG}-${i},${TAG} Csv ${i},07712${String(10000 + i).slice(-5)},"${i} Galle Road, Colombo 03",0.75,20,15,10,${cod},2500`);
}
// Lines are counted with the header as line 1.
const bad = [
  `${TAG}-B1,${TAG} BadPhone,12345,"9 Duplication Road, Colombo 04",1,,,,,1000`, // server: phone
  `${TAG}-B2,${TAG} BadCod,0771112223,"9 Duplication Road, Colombo 04",1,,,,10.505,1000`, // local: 3-decimal COD
  `${TAG}-1,${TAG} DupRef,0771112224,"9 Duplication Road, Colombo 04",1,,,,,1000`, // local: duplicate ref
  `${TAG}-B4,${TAG} ShortAddr,0771112225,Kandy,1,,,,,1000`, // server: address too short
];
const body = [...good.slice(0, 50), bad[0]!, ...good.slice(50, 100), bad[1]!, bad[2]!, ...good.slice(100), bad[3]!];
const csv = [header, ...body].join("\n");
const badLines = body.map((r, i) => ({ r, line: i + 2 })).filter(({ r }) => bad.includes(r)).map((x) => x.line);

await step(`upload a ${body.length}-row file: 2 rows fail in the browser, ${GOOD + 2} are sendable`, async () => {
  await page.getByLabel("Booking CSV file").setInputFiles({ name: `${TAG}.csv`, mimeType: "text/csv", buffer: Buffer.from(csv) });
  await tile(page, "Rows in file").getByText(String(body.length), { exact: true }).waitFor();
  await tile(page, "Need fixing").getByText("2", { exact: true }).waitFor();
  await page.getByRole("button", { name: `Check ${GOOD + 2} rows with NatEx` }).waitFor();
  return `bad lines ${badLines.join(", ")}`;
});

await step("Check with NatEx: dry run in 100-row chunks, server rejects 2 more, NOTHING booked", async () => {
  const before = sent.length;
  await page.getByRole("button", { name: `Check ${GOOD + 2} rows with NatEx` }).click();
  await page.getByRole("button", { name: `Book ${GOOD} parcels` }).waitFor({ timeout: 60_000 });
  await tile(page, "Need fixing").getByText("4", { exact: true }).waitFor();
  const dry = sent.slice(before);
  if (dry.length !== 2 || !dry.every((d) => d.dryRun) || dry[0]!.rows !== 100 || dry[1]!.rows !== GOOD + 2 - 100)
    throw new Error(JSON.stringify(dry));
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(parcel).where(like(parcel.consigneeName, `${TAG} %`));
  if (Number(n) !== 1) throw new Error(`${n} parcels with the run tag (want only the single booking)`);
  return `chunks ${dry.map((d) => d.rows).join(" + ")}`;
});

await step("COD on good rows = the exact cents of the good rows", async () => {
  await tile(page, "COD on good rows").getByText(money(expectedCod), { exact: true }).waitFor();
  return money(expectedCod);
});

await step("Need fixing filters to the problem rows, with the server's reasons", async () => {
  await page.getByRole("button", { name: /Need fixing/ }).click();
  await page.getByText(/of\s+4\s+rows/).waitFor();
  await page.getByText(/not a Sri Lankan number/).waitFor();
  await page.getByText(/too short to deliver to/).waitFor();
  await page.getByText(/Duplicate order ref — first used on line 2/).waitFor();
  await page.getByRole("button", { name: /Need fixing/ }).click();
});

await step(`Book ${GOOD}: chunks of 100 with one key each; the dropped chunk is retried with the SAME key`, async () => {
  const before = sent.length;
  let bookingCalls = 0;
  await page.route("**/api/rpc/parcels/bulkCreate", async (route) => {
    const isBooking = (route.request().postData() ?? "").includes('"dryRun":false');
    if (isBooking) bookingCalls += 1;
    if (isBooking && bookingCalls === 2) {
      droppedOnPurpose += 1;
      return route.abort("failed"); // never reaches the server
    }
    return route.continue();
  });
  await page.getByRole("button", { name: `Book ${GOOD} parcels` }).click();
  await page.getByRole("button", { name: "Retry 1 failed chunk" }).waitFor({ timeout: 120_000 });
  await page.getByText(/Retrying sends the same request key/).waitFor();
  const [{ n: mid }] = await db.select({ n: sql<number>`count(*)` }).from(parcel).where(like(parcel.consigneeName, `${TAG} Csv %`));
  if (Number(mid) !== 100) throw new Error(`${mid} booked after the drop (want 100)`);
  await page.getByRole("button", { name: "Retry 1 failed chunk" }).click();
  await page.getByRole("status").getByText(`${GOOD} parcels booked.`).waitFor({ timeout: 120_000 });
  await page.unroute("**/api/rpc/parcels/bulkCreate");
  const booking = sent.slice(before);
  if (booking.length !== 3 || booking.some((b) => b.dryRun)) throw new Error(JSON.stringify(booking));
  const [a, b, retry] = booking as [Sent, Sent, Sent];
  if (a.rows !== 100 || b.rows !== GOOD - 100 || retry.rows !== b.rows) throw new Error(`rows ${a.rows}/${b.rows}/${retry.rows}`);
  if (a.key === b.key) throw new Error("two chunks shared one key");
  if (retry.key !== b.key) throw new Error("the retry minted a new key");
  return `chunks ${a.rows} + ${b.rows}; retry reused ${b.key.slice(0, 8)}…`;
});

await step(`the DB holds exactly the ${GOOD} good rows, all Booked, COD to the cent; no bad row was booked`, async () => {
  const rows = await db.select().from(parcel).where(like(parcel.consigneeName, `${TAG} Csv %`));
  if (rows.length !== GOOD) throw new Error(`${rows.length} rows`);
  if (rows.some((r) => r.status !== "Booked" || r.merchantId !== MERCHANT || r.weightGrams !== 750)) throw new Error("a row is off");
  const cod = rows.reduce((s, r) => s + r.codAmountCents, 0);
  if (cod !== expectedCod) throw new Error(`COD ${cod} vs ${expectedCod}`);
  for (const n of ["BadPhone", "BadCod", "DupRef", "ShortAddr"]) {
    const x = await db.select().from(parcel).where(eq(parcel.consigneeName, `${TAG} ${n}`));
    if (x.length) throw new Error(`${n} was booked`);
  }
  return `${rows.length} parcels, ${cod} cents`;
});

await step("error report CSV lists exactly the 4 bad lines with their reasons", async () => {
  const lines = await download(page, "Download error report");
  if (lines[0] !== ["line", ...TEMPLATE_HEADER, "errors"].join(",")) throw new Error(lines[0]);
  const recs = parseCsv(lines.join("\n")).slice(1);
  const got = recs.map((r) => Number(r.cells[0]));
  if (JSON.stringify(got) !== JSON.stringify(badLines)) throw new Error(`lines ${got.join(",")} vs ${badLines.join(",")}`);
  if (recs.some((r) => !r.cells.at(-1))) throw new Error("a row has no reason");
  return `lines ${got.join(", ")}`;
});

await step("AWB results CSV: one row per line, AWBs matching the DB", async () => {
  const lines = await download(page, "Download AWBs");
  const recs = parseCsv(lines.join("\n")).slice(1);
  if (recs.length !== body.length) throw new Error(`${recs.length} rows`);
  const withAwb = recs.filter((r) => r.cells[3]);
  if (withAwb.length !== GOOD) throw new Error(`${withAwb.length} AWBs`);
  const dbAwbs = new Set((await db.select({ awb: parcel.awb }).from(parcel).where(like(parcel.consigneeName, `${TAG} Csv %`))).map((r) => r.awb));
  if (withAwb.some((r) => !dbAwbs.has(r.cells[3]!))) throw new Error("an AWB in the file is not in the DB");
  return `${withAwb.length} AWBs`;
});

// ═══════════════════════════════════════════════════════════════ pickups
console.log("\nUI proof — /merchant/pickups");
const csvAwbs = (await db.select({ awb: parcel.awb }).from(parcel).where(like(parcel.consigneeName, `${TAG} Csv %`)).limit(2)).map((r) => r.awb);
const pickAwbs = [singleAwb, ...csvAwbs];
await page.goto(`${BASE}/merchant/pickups`, { waitUntil: "networkidle" });

await step("bleed layout: tiles above, table below, no sideways scroll", async () => {
  await tile(page, "Awaiting NatEx").waitFor();
  await page.locator("table").waitFor();
  const t = await tile(page, "Awaiting NatEx").boundingBox();
  const tb = await page.locator("table").boundingBox();
  if (!t || !tb || tb.y < t.y + t.height) throw new Error("table overlaps the tiles");
  return await noHorizontalOverflow(page);
});

async function requestPickup(previous = ""): Promise<string> {
  await page.getByRole("button", { name: "Request pickup" }).first().click();
  const d = page.getByRole("dialog", { name: "Request a pickup" });
  await d.waitFor();
  for (const awb of pickAwbs) {
    await d.getByLabel("Filter booked parcels").fill(awb);
    const row = d.locator("li", { hasText: awb });
    await row.waitFor({ timeout: 10_000 });
    await row.getByRole("checkbox").check();
  }
  await d.getByText(`${pickAwbs.length} selected`).waitFor();
  await field(d, "Window").selectOption("afternoon");
  await field(d, "Notes for the rider").fill(`${TAG}: gate 2, ask for Sanjay`);
  await d.getByRole("button", { name: "Request pickup" }).click();
  const note = page.getByText(new RegExp(`Pickup PR\\S+ requested for ${pickAwbs.length} parcels`));
  for (let i = 0; i < 60; i += 1) {
    if (await note.count()) {
      const code = (await note.innerText()).match(/PR\S+/)![0];
      if (code !== previous) return code;
    }
    await page.waitForTimeout(250);
  }
  throw new Error("no new pickup code was announced");
}

let firstCode = "";
await step("Request pickup with 3 ticked AWBs → DB row requested, exactly those AWBs", async () => {
  firstCode = await requestPickup();
  const [r] = await db.select().from(pickupRequest).where(eq(pickupRequest.code, firstCode));
  if (!r || r.status !== "requested" || r.merchantId !== MERCHANT || r.window !== "afternoon") throw new Error(JSON.stringify(r));
  const awbs = JSON.parse(r.awbs) as string[];
  if (awbs.slice().sort().join() !== pickAwbs.slice().sort().join()) throw new Error(`awbs ${awbs.join(",")}`);
  return `${firstCode}: ${awbs.join(", ")}`;
});

await step("the same AWBs cannot go on a second live request (server refuses, dialog says why)", async () => {
  await page.getByRole("button", { name: "Request pickup" }).first().click();
  const d = page.getByRole("dialog", { name: "Request a pickup" });
  await d.getByLabel("Filter booked parcels").fill(singleAwb);
  await d.locator("li", { hasText: singleAwb }).getByRole("checkbox").check();
  expected = [{ status: 400, path: "/collection/requestPickup" }, { status: 409, path: "/collection/requestPickup" }];
  await d.getByRole("button", { name: "Request pickup" }).click();
  await d.locator("li", { hasText: singleAwb }).locator(".text-status-bad").waitFor({ timeout: 15_000 });
  const why = await d.locator("li", { hasText: singleAwb }).locator(".text-status-bad").innerText();
  expected = [];
  const n = await db.select().from(pickupRequest).where(and(eq(pickupRequest.merchantId, MERCHANT), like(pickupRequest.notes, `${TAG}%`)));
  if (n.length !== 1) throw new Error(`${n.length} requests`);
  await d.getByRole("button", { name: "Close", exact: true }).last().click();
  await d.waitFor({ state: "detached" });
  return why;
});

await step("Cancel: a 3-char reason is refused and nothing changes; a real reason cancels (DB)", async () => {
  const row = page.locator("tbody tr", { hasText: firstCode });
  await row.getByRole("button", { name: "Cancel" }).click();
  const d = page.getByRole("dialog", { name: "Cancel this pickup?" });
  await field(d, "Reason").fill("abc");
  await d.getByRole("button", { name: "Cancel pickup" }).click();
  await d.getByText("Give a reason of at least 5 characters.").waitFor();
  let [r] = await db.select().from(pickupRequest).where(eq(pickupRequest.code, firstCode));
  if (r!.status !== "requested") throw new Error(`status ${r!.status} after a short reason`);
  const reason = `${TAG} proof: wrong day, rebooking`;
  await field(d, "Reason").fill(reason);
  await d.getByRole("button", { name: "Cancel pickup" }).click();
  await page.getByText(`Pickup ${firstCode} cancelled.`, { exact: false }).waitFor({ timeout: 15_000 });
  [r] = await db.select().from(pickupRequest).where(eq(pickupRequest.code, firstCode));
  if (r!.status !== "cancelled" || r!.cancelReason !== reason) throw new Error(`${r!.status} / ${r!.cancelReason}`);
});

let secondCode = "";
await step("the cancelled request's AWBs are free: a new request takes all 3", async () => {
  secondCode = await requestPickup(firstCode);
  if (secondCode === firstCode) throw new Error("same code");
  const [r] = await db.select().from(pickupRequest).where(eq(pickupRequest.code, secondCode));
  if (r!.status !== "requested" || r!.parcelCount !== 3) throw new Error(`${r!.status} / ${r!.parcelCount}`);
  return secondCode;
});

await step("pickups CSV export = server total", async () => {
  const api = await merchant.collection.pickupRequests({ page: 1, pageSize: 1 });
  const lines = await download(page, "Export CSV");
  if (!lines[0]!.startsWith("code,pickup_date,window")) throw new Error(lines[0]);
  if (lines.length - 1 !== api.total) throw new Error(`csv ${lines.length - 1} vs ${api.total}`);
  return `${api.total} rows`;
});

// ═══════════════════════════════════════════════════════════════ ops answers it
console.log("\nUI proof — /ops/manifests?tab=requests as Colombo ops");
const opsPage = await signedInPage(browser, opsS, "ops");
await opsPage.goto(`${BASE}/ops/manifests?tab=requests`, { waitUntil: "networkidle" });
let manifestCode = "";
await step("the request is waiting on the ops tab; Schedule → rider → Create manifest → DB scheduled", async () => {
  const row = opsPage.locator("tbody tr", { hasText: secondCode });
  await row.waitFor({ timeout: 15_000 });
  await row.getByRole("button", { name: "Schedule" }).click();
  const d = opsPage.getByRole("dialog", { name: `Schedule pickup ${secondCode}` });
  await d.waitFor();
  if (await field(d, "Merchant").isEnabled()) throw new Error("merchant select editable on a prefilled request");
  const awbText = await field(d, "Declared AWBs").inputValue();
  if (pickAwbs.some((a) => !awbText.includes(a))) throw new Error(`prefill ${awbText}`);
  await field(d, "Rider").selectOption(riderS.user.id);
  await d.getByRole("button", { name: "Create manifest" }).click();
  await d.waitFor({ state: "detached", timeout: 20_000 });
  const [r] = await db.select().from(pickupRequest).where(eq(pickupRequest.code, secondCode));
  if (r!.status !== "scheduled" || !r!.manifestId) throw new Error(`${r!.status} / ${r!.manifestId}`);
  const [m] = await db.select().from(manifest).where(eq(manifest.id, r!.manifestId));
  if (!m || m.riderId !== riderS.user.id || m.merchantId !== MERCHANT) throw new Error(JSON.stringify(m));
  manifestCode = m.code;
  if (!opsPage.url().includes("tab=manifests")) throw new Error(`stayed on ${opsPage.url()}`);
  return `${secondCode} → ${manifestCode}`;
});
await opsPage.context().close();

await step("the merchant sees the request Scheduled with the rider's manifest code", async () => {
  await page.reload({ waitUntil: "networkidle" });
  const row = page.locator("tbody tr", { hasText: secondCode });
  await row.getByText(manifestCode).waitFor({ timeout: 15_000 });
  await row.getByText("scheduled").waitFor();
  if (await row.getByRole("button", { name: "Cancel" }).count()) throw new Error("Cancel still offered");
});

// ═══════════════════════════════════════════════════════════════ shipments
console.log("\nUI proof — /merchant/parcels");
await page.goto(`${BASE}/merchant/parcels`, { waitUntil: "networkidle" });
await step("Shipments: footer total = server total, CSV export carries every row", async () => {
  const api = await merchant.parcels.list({ page: 1, pageSize: 1 });
  await page.getByText(new RegExp(`of\\s+${api.total}\\s+rows`)).waitFor({ timeout: 15_000 });
  const lines = await download(page, "Export CSV");
  if (!lines[0]!.startsWith("awb,status,consignee_name")) throw new Error(lines[0]);
  const want = Math.min(api.total, 5000);
  if (lines.length - 1 !== want) throw new Error(`csv ${lines.length - 1} vs ${want} (total ${api.total})`);
  return `${api.total} rows${api.total > 5000 ? " (capped at 5000)" : ""}`;
});
await step("Shipments search by the run tag → exactly this run's parcels; bleed layout holds", async () => {
  await page.getByPlaceholder("AWB, consignee or phone").fill(TAG);
  await page.getByText(new RegExp(`of\\s+${GOOD + 1}\\s+rows`)).waitFor({ timeout: 15_000 });
  return await noHorizontalOverflow(page);
});
await step("the merchant's drawer offers exactly the moves the server says it may command", async () => {
  const detail = await merchant.parcels.get({ awbOrId: singleAwb });
  await page.getByPlaceholder("AWB, consignee or phone").fill(singleAwb);
  await page.locator("tbody tr", { hasText: singleAwb }).click();
  const d = page.getByRole("dialog");
  await d.getByText(singleName).first().waitFor({ timeout: 10_000 });
  await d.getByText(/Booked|Pickup/).first().waitFor();
  for (const to of detail.legalNext as string[]) {
    const shown = (await d.getByRole("button", { name: humanise(to), exact: true }).count()) > 0;
    const may = (detail.commandable as string[]).includes(to);
    if (shown !== may) throw new Error(`${to}: shown ${shown}, commandable ${may}`);
  }
  await page.keyboard.press("Escape");
  return `${detail.parcel.status}: offered ${detail.commandable.join(", ") || "nothing"} of ${detail.legalNext.join(", ")}`;
});

// ═══════════════════════════════════════════════════════════════ tracking
console.log("\nUI proof — /merchant/tracking");
await page.goto(`${BASE}/merchant/tracking`, { waitUntil: "networkidle" });
await step("own AWB: found, with the public tracking link", async () => {
  await field(page, "AWB").fill(singleAwb.toLowerCase());
  await page.getByRole("button", { name: "Find" }).click();
  const res = page.getByTestId("lookup-result");
  await res.getByText(singleAwb).waitFor({ timeout: 10_000 });
  const href = await res.getByRole("link", { name: "What the customer sees" }).getAttribute("href");
  if (href !== `${BASE}/track/${singleAwb}`) throw new Error(`href ${href}`);
  return href;
});
const [foreign] = await db.select().from(parcel).where(ne(parcel.merchantId, MERCHANT)).limit(1);
await step("another merchant's AWB reads not found (404, §5) and shows no parcel", async () => {
  expected = [{ status: 404, path: "/parcels/get" }];
  await field(page, "AWB").fill(foreign!.awb);
  await page.getByRole("button", { name: "Find" }).click();
  await page.locator("text=/not found|No parcel/i").first().waitFor({ timeout: 10_000 });
  if (await page.getByTestId("lookup-result").count()) throw new Error("a result is shown");
  await page.waitForTimeout(500);
  expected = [];
  return `${foreign!.awb} (${foreign!.merchantId})`;
});
await step("tracking bleed layout: lookup card above the moving list, no sideways scroll", async () => {
  await page.getByText("On the road now").waitFor();
  return await noHorizontalOverflow(page);
});

// ═══════════════════════════════════════════════════════════════ NDR
console.log("\nUI proof — /merchant/ndr");
await page.goto(`${BASE}/merchant/ndr`, { waitUntil: "networkidle" });
await step("ArrowRight switches to Returns to you and records ?tab=rto; focus follows", async () => {
  await page.getByRole("tab", { name: /Need your answer/ }).focus();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("tab", { name: /Returns to you/, selected: true }).waitFor();
  if (!page.url().includes("tab=rto")) throw new Error(page.url());
  if ((await page.evaluate(() => document.activeElement?.id)) !== "tab-rto") throw new Error("focus did not follow");
  await page.keyboard.press("Home");
  await page.getByRole("tab", { name: /Need your answer/, selected: true }).waitFor();
});
await step("NDR tab badge = ndr.counts for this merchant", async () => {
  const n = await merchant.ndr.counts({});
  const want = n.open + n.instructed + n.reattemptScheduled;
  const txt = await page.getByRole("tab", { name: /Need your answer/ }).innerText();
  if (!txt.includes(String(want))) throw new Error(`tab "${txt}" vs ${want}`);
  return String(want);
});

// ═══════════════════════════════════════════════════════════════ drawer, as admin
console.log("\nUI proof — parcel drawer as admin: evidence-gated moves are never buttons");
const adminPage = await signedInPage(browser, adminS, "admin");
const gated: [string, string][] = [
  ["OutForDelivery", "Delivered"],
  ["RTOInTransit", "RTODelivered"],
  ["Bagged", "In Transit"],
];
for (const [status, label] of gated) {
  const [p] = await db.select().from(parcel).where(eq(parcel.status, status)).limit(1);
  if (!p) {
    check(true, `${status}: no parcel in that state to open`, "skipped");
    continue;
  }
  await step(`${status} ${p.awb}: the drawer has no "${label}" button, and the API agrees`, async () => {
    const detail = await admin.parcels.get({ awbOrId: p.awb });
    const target = label.replace(/\s/g, "");
    if ((detail.commandable as string[]).includes(target)) throw new Error(`API offers ${target}`);
    if (!(detail.legalNext as string[]).includes(target)) throw new Error(`${target} not even legal from ${status}`);
    await adminPage.goto(`${BASE}/ops/parcels`, { waitUntil: "networkidle" });
    await adminPage.getByPlaceholder("AWB, consignee or phone").fill(p.awb);
    await adminPage.locator("tbody tr", { hasText: p.awb }).click();
    const d = adminPage.getByRole("dialog");
    await d.getByText(p.consigneeName).first().waitFor({ timeout: 10_000 });
    await adminPage.waitForTimeout(300);
    if (await d.getByRole("button", { name: label, exact: true }).count()) throw new Error("button rendered");
    const offered = await d.locator("footer button, [data-slot=drawer-footer] button").allInnerTexts();
    return `offered: ${detail.commandable.join(", ") || "none"}${offered.length ? ` (UI: ${offered.join(", ")})` : ""}`;
  });
}

console.log(`  (provoked on purpose: ${expectedSeen.join(", ") || "none"})`);
check(problems.length === 0, "no console or page errors across the merchant, ops and admin screens", problems.join(" | "));
await browser.close();

console.log(`\n${"─".repeat(60)}`);
if (failures.length === 0) {
  console.log(`merchant portal UI proof: ${pass}/${pass} checks passed (run ${TAG})\n`);
  process.exit(0);
}
console.log(`merchant portal UI proof: ${pass} passed, ${failures.length} FAILED (run ${TAG})`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
