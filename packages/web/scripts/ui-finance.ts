/**
 * Live UI proof of the finance portal (§10 M4: "Finance portal: dashboard, COD
 * ledger, remittances, invoices, disputes") in headless Chrome, signed in as
 * the seeded finance user (Dilani, the maker) and the admin (Rajitha, the
 * checker) — plus the merchant's half of the dispute loop (Ceylon Threads).
 *
 * Every outcome is checked against the database or the API, never a toast:
 *   sweep        every finance route and tab renders for finance and admin
 *                with no console/page error and no sideways scroll; a merchant
 *                sent to /finance lands on /merchant; /finance/alerts lands on
 *                the alerts tab; arrow keys move the tab strip and ?tab=
 *   overview     the four-way tiles equal cod.reconciliation
 *   deposits     finance counts and banks a rider's deposit → DB banked
 *   holds        a merchant hold raised in the UI shows in the draft preview,
 *                then is cleared in the UI → DB cleared
 *   settlement   due card → draft with a Rs. 25.50 deduction (preview net =
 *                gross − 2550) → propose → the MAKER's approve is refused and
 *                the refusal is shown, DB still proposed → the CHECKER's
 *                approve response is lost on the wire and the second click
 *                replays the SAME Idempotency-Key → DB approved once → payout
 *                file carries the beneficiary account and exact net → a second
 *                export is refused as already-exported and only goes out after
 *                an explicit "Export again" → UTR recorded → DB paid
 *   invoices     draft with a manual charge → issue → part payment → DB
 *   disputes     merchant raises a case in the portal → finance picks it up
 *                and rejects it (behind a confirm) → merchant sees rejected;
 *                a second case is withdrawn by the merchant
 *   controls     "Run now" adds one invariant run; a fixture alert is
 *                acknowledged and resolved; a setting is changed and changed
 *                back, with a short reason refused client-side
 *   CSV          ledger / settlements / invoices / deposits / holds / disputes
 *                export row counts equal the server totals
 *
 * Owns a fixture merchant (mch_m4_ui) and wipes its money rows each run.
 *
 *   bun --env-file=../../.env scripts/ui-finance.ts
 */

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { chromium, type Browser, type Page } from "playwright-core";
import { readFileSync } from "node:fs";
import { and, desc, eq, gte, like } from "drizzle-orm";
import type { AppRouterClient } from "../src/api";
import { money } from "../src/web/lib/format";
import { resetMerchantMoney } from "./lib/money-fixture";

const BASE = process.env.UI_CHECK_BASE ?? "http://localhost:4200";
const { db } = await import("../src/api/database");
const { cleanupWithRetry, hardenScriptReads } = await import("./lib/db-retry");
hardenScriptReads(db);
const { rateLimit, auditLog } = await import("../src/api/database/schema/shared");
const { merchant: merchantTable } = await import("../src/api/database/schema/merchants");
const cod = await import("../src/api/database/schema/cod");
const { recordCollection } = await import("../src/api/modules/cod/service");
const { raiseAlert } = await import("../src/api/modules/cod/alerts");
const { seedFinanceConfig } = await import("../src/api/modules/cod/config");

const RUN = Date.now().toString(36).slice(-5).toUpperCase();
/** Audit `ts` is second-precision; back off a second so nothing this run wrote is missed. */
const RUN_STARTED = new Date(Math.floor(Date.now() / 1000) * 1000 - 1000);
const MCH = "mch_m4_ui";
const MCH_NAME = "M4 UI Traders";
const BRANCH = "brn_cmb_central";
const SEEDED_MCH = "mch_ceylon_threads";
const SRC = "m4ui";

let keySeq = 0;
const key = (label: string) => `ui-fin-${label}-${Date.now()}-${++keySeq}`;
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
type Session = Awaited<ReturnType<typeof anon.identity.verifyOtp>>;
async function login(phone: string): Promise<Session> {
  await db.delete(rateLimit).where(like(rateLimit.bucket, "%identity.%Otp"));
  const c = await anon.identity.requestOtp({ phone });
  if (!c.devCode) throw new Error(`no dev OTP for ${phone}`);
  return anon.identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode, deviceId: "ui-finance" });
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
/** The page a failing step screenshots, as evidence (set once the browser is up). */
let evidencePage: { screenshot: (o: { path: string; fullPage: boolean }) => Promise<unknown> } | null = null;
let failShots = 0;
async function step(label: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    check(true, label, detail ?? "");
  } catch (error) {
    if (evidencePage) {
      const path = `/tmp/ui-fin-fail-${++failShots}.png`;
      await evidencePage.screenshot({ path, fullPage: true }).catch(() => undefined);
      console.log(`        evidence: ${path}`);
    }
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const why = cause ? ` [cause: ${cause.code ?? ""} ${cause.message ?? ""}]` : "";
    check(false, label, (error as Error).message.split("\n")[0]!.slice(0, 300) + why);
  }
}
function must(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

// ═══════════════════════════════════════════════════════════════ fixtures
console.log(`\nUI proof — finance portal → ${BASE}, run ${RUN}`);
await seedFinanceConfig();
await db
  .insert(merchantTable)
  .values({
    id: MCH,
    branchId: BRANCH,
    name: MCH_NAME,
    address: "4 Ledger Lane, Colombo 02",
    contactName: "UI Fixture",
    contactPhone: "+94700000044",
  })
  .onConflictDoNothing();
const reset = await resetMerchantMoney(MCH, SRC);
if (reset.sharedDeposits.length) console.log(`  NOTE  left shared deposits alone: ${reset.sharedDeposits.join(", ")}`);

const financeS = await login("+94774567890");
const adminS = await login("+94773456789");
const merchantS = await login("+94775678901");
const riderS = await login("+94771234567");
const finance = clientFor(financeS.accessToken);
const merchantC = clientFor(merchantS.accessToken);
must(financeS.user.id !== adminS.user.id, "maker and checker must differ");
must(merchantS.user.merchantId === SEEDED_MCH, `merchant login is ${merchantS.user.merchantId}`);

// Two COD parcels collected by the Colombo rider, declared at the branch. The
// doorstep half is smoke-m3's job; counting and banking are this script's.
const amounts = [312_500, 187_550];
const collected: string[] = [];
for (const [i, amountCents] of amounts.entries()) {
  const r = await recordCollection({
    parcelId: `${SRC}-p${i + 1}-${RUN}`,
    awb: `M4UI${RUN}${i + 1}`,
    merchantId: MCH,
    riderId: riderS.user.id,
    branchId: BRANCH,
    amountCents,
    mode: "cash",
    clientId: `${SRC}-${RUN}-${i + 1}`,
    actor: { userId: riderS.user.id, name: riderS.user.name, role: "rider", branchId: BRANCH },
  });
  collected.push(r.entry.id);
}
const grossCents = amounts.reduce((a, b) => a + b, 0);
const deposit = await clientFor(riderS.accessToken, key("declare")).cod.declareDeposit({
  branchId: BRANCH,
  declaredCents: grossCents,
  entryIds: collected,
  note: `ui-finance ${RUN}`,
});
await clientFor(financeS.accessToken, key("payout")).finance.setPayoutDetails({
  merchantId: MCH,
  beneficiaryName: MCH_NAME,
  bankName: "Commercial Bank",
  branchName: "Colombo 02",
  accountNumber: "8004400440",
  verified: true,
});
const alertFx = await raiseAlert({
  topic: "cod.deposit_variance",
  kind: "deposit_variance",
  severity: "medium",
  audience: "finance",
  summary: `UI fixture ${RUN}: Rs. 10.00 short on a test deposit`,
  sourceKey: `${SRC}:alert:${RUN}`,
  merchantId: MCH,
  amountCents: 1000,
});
console.log(`  fixture  ${MCH} · deposit ${deposit.code} ${money(grossCents)} · alert ${alertFx.alert.id}`);

// ═══════════════════════════════════════════════════════════════ browser
const problems: string[] = [];
let expected: { status: number; path: string }[] = [];
let droppedOnPurpose = 0;
async function signedInPage(browser: Browser, s: Session, label: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await context.addInitScript(
    ([k, v]: string[]) => {
      localStorage.setItem(k!, v!);
      localStorage.setItem("natex.deviceId", "ui-finance");
    },
    [
      "natex.session",
      JSON.stringify({ accessToken: s.accessToken, refreshToken: s.refreshToken, expiresAt: Date.now() + s.expiresIn * 1000, user: s.user }),
    ],
  );
  const p = await context.newPage();
  p.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/React DevTools|\[vite\]|favicon|onedollarstats|analytics/i.test(t)) return;
    if (/Failed to load resource: the server responded/.test(t)) return;
    if (/ERR_FAILED|Failed to fetch/i.test(t) && droppedOnPurpose > 0) return;
    problems.push(`[${label}] ${t.slice(0, 300)}`);
  });
  p.on("response", (r) => {
    if (r.status() < 400) return;
    const path = new URL(r.url()).pathname;
    if (expected.some((e) => e.status === r.status() && path.endsWith(e.path))) return;
    problems.push(`[${label}] HTTP ${r.status()} ${path}`);
  });
  p.on("pageerror", (e) => problems.push(`[${label}] pageerror: ${e.message.slice(0, 300)}`));
  return p;
}
type Scope = Pick<Page, "locator">;
const fieldLabel = (p: Scope, label: string) => p.locator(`label:has(> span.label-xs:text-is(${JSON.stringify(label)}))`);
const field = (p: Scope, label: string) => fieldLabel(p, label).locator("input, textarea, select").first();
const dialog = (p: Page, name: string | RegExp) => p.getByRole("dialog", { name });
const tile = (p: Scope, label: string) => p.locator("p.label-xs", { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).locator("..");
async function tileValue(p: Scope, label: string): Promise<string> {
  return ((await tile(p, label).locator("p").nth(1).textContent()) ?? "").trim();
}
async function confirm(p: Page, title: string | RegExp, button: string | RegExp) {
  const d = dialog(p, title);
  await d.waitFor();
  await d.getByRole("button", { name: button }).click();
  await d.waitFor({ state: "hidden", timeout: 20_000 });
}
async function readDownload(p: Page, click: () => Promise<void>): Promise<string[]> {
  const [d] = await Promise.all([p.waitForEvent("download", { timeout: 60_000 }), click()]);
  return readFileSync((await d.path())!, "utf8").replace(/^﻿/, "").trim().split(/\r?\n/);
}
async function exportRows(p: Page, scope?: Scope): Promise<number> {
  const lines = await readDownload(p, () => (scope ?? p).locator("button", { hasText: "Export CSV" }).first().click());
  return lines.length - 1;
}
async function noOverflow(p: Page) {
  const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  if (m.sw > m.iw + 1) throw new Error(`page scrolls sideways: ${m.sw}px > ${m.iw}px`);
}
async function go(p: Page, path: string) {
  await p.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
}

const browser = await chromium.launch({ channel: "chrome" });
const fin = await signedInPage(browser, financeS, "finance");
const adm = await signedInPage(browser, adminS, "admin");
const mer = await signedInPage(browser, merchantS, "merchant");
evidencePage = fin;

// ─────────────────────────────────────────────────────────────── sweep
console.log("\n1. Every finance screen renders");
const ROUTES: [string, string][] = [
  ["/finance", "Finance"],
  ...["ledger", "recon", "riders", "deposits", "invariant", "alerts", "config"].map((t) => [`/finance/cod?tab=${t}`, "COD ledger"] as [string, string]),
  ["/finance/remittances?tab=settlements", "Remittances"],
  ["/finance/remittances?tab=holds", "Remittances"],
  ["/finance/invoices?tab=invoices", "Invoices"],
  ["/finance/invoices?tab=ageing", "Invoices"],
  ["/finance/disputes?tab=queue", "Disputes"],
  ["/finance/disputes?tab=register", "Disputes"],
];
for (const [label, p] of [["finance", fin], ["admin", adm]] as const) {
  await step(`${label}: ${ROUTES.length} finance screens render with their heading, a selected tab and no sideways scroll`, async () => {
    for (const [path, h1] of ROUTES) {
      await go(p, path);
      const got = (await p.locator("h1").first().textContent())?.trim();
      must(got === h1, `${path}: h1 "${got}" ≠ "${h1}"`);
      const tab = new URL(`${BASE}${path}`).searchParams.get("tab");
      if (tab) must((await p.locator(`#tab-${tab}`).getAttribute("aria-selected")) === "true", `${path}: tab ${tab} not selected`);
      await noOverflow(p);
    }
    return `${ROUTES.length} routes`;
  });
}
await step("admin's sidebar carries the whole finance nav", async () => {
  const links = await adm.locator("nav a").allTextContents();
  for (const want of ["COD ledger", "Remittances", "Invoices", "Disputes"]) must(links.some((l) => l.includes(want)), `no "${want}" in ${links.join(",")}`);
  return "COD ledger, Remittances, Invoices, Disputes";
});
await step("/finance/alerts lands on the COD alerts tab", async () => {
  await go(fin, "/finance/alerts");
  must(fin.url().endsWith("/finance/cod?tab=alerts"), fin.url());
  must((await fin.locator("#tab-alerts").getAttribute("aria-selected")) === "true", "alerts tab not selected");
  return fin.url().replace(BASE, "");
});
await step("arrow keys move the tab strip and mirror ?tab=", async () => {
  await go(fin, "/finance/cod?tab=ledger");
  await fin.locator("#tab-ledger").focus();
  await fin.keyboard.press("ArrowRight");
  must(fin.url().endsWith("tab=recon"), fin.url());
  must(await fin.locator("#tab-recon").evaluate((el) => el === document.activeElement), "focus did not follow");
  await fin.keyboard.press("End");
  must(fin.url().endsWith("tab=config"), fin.url());
  return "ledger → recon → (End) config";
});
await step("a merchant sent to /finance lands on their own portal; /merchant/disputes renders", async () => {
  await go(mer, "/finance/remittances");
  must(new URL(mer.url()).pathname === "/merchant", mer.url());
  await go(mer, "/merchant/disputes");
  must((await mer.locator("h1").first().textContent())?.trim() === "Disputes & claims", "no disputes heading");
  must((await mer.locator("nav a", { hasText: "Disputes & claims" }).count()) === 1, "no nav item");
  await noOverflow(mer);
  return "/finance → /merchant";
});

// ─────────────────────────────────────────────────────────────── overview
console.log("\n2. Overview");
await step("the four-way tiles equal cod.reconciliation", async () => {
  await go(fin, "/finance");
  const r = await finance.cod.reconciliation({});
  const want: [string, number][] = [
    ["1 · Collected", r.collectedCents],
    ["2 · Deposited", r.depositedCents],
    ["3 · Banked", r.bankedCents],
    ["4 · Settled", r.settledCents],
  ];
  for (const [label, cents] of want) {
    const got = await tileValue(fin, label);
    must(got === money(cents), `${label}: "${got}" ≠ ${money(cents)}`);
  }
  return want.map(([l, c]) => `${l.slice(4)} ${money(c)}`).join(" · ");
});

// ─────────────────────────────────────────────────────────────── deposits
console.log("\n3. Count and bank a deposit (§8 checkpoints 2–3)");
await step("finance counts the fixture deposit in the drawer → DB verified, no variance", async () => {
  await go(fin, "/finance/cod?tab=deposits");
  await fin.locator("tr", { hasText: deposit.code }).click();
  const d = dialog(fin, deposit.code);
  await d.getByLabel("Counted amount in rupees").fill(String(grossCents / 100));
  await d.getByRole("button", { name: "Record count" }).click();
  await confirm(fin, "Record this count?", /^Record Rs\./);
  await d.getByText("Bank the cash · checkpoint 3").waitFor({ timeout: 20_000 }).catch(() => undefined);
  const [row] = await db.select().from(cod.codDeposit).where(eq(cod.codDeposit.id, deposit.id));
  must(row?.status === "verified" && row.countedCents === grossCents, `DB ${row?.status} counted ${row?.countedCents}`);
  return `${deposit.code} counted ${money(grossCents)}`;
});
await step("…and banks it → DB banked with the slip reference", async () => {
  await go(fin, "/finance/cod?tab=deposits");
  await fin.locator("tr", { hasText: deposit.code }).click();
  const d = dialog(fin, deposit.code);
  await field(d, "Bank slip reference").fill(`UISLIP-${RUN}`);
  await field(d, "NatEx account").fill("BOC 0071234567");
  await d.getByRole("button", { name: "Record banking" }).click();
  await confirm(fin, "Record this banking?", "Record banking");
  const [row] = await db.select().from(cod.codDeposit).where(eq(cod.codDeposit.id, deposit.id));
  must(row?.status === "banked" && row.bankRef === `UISLIP-${RUN}`, `DB ${row?.status} ${row?.bankRef}`);
  await fin.keyboard.press("Escape");
  return `${deposit.code} banked`;
});

// The merchant's ACCRUE entries are posted at banking time — today, which is
// in the period that has not closed yet. Back-date this FIXTURE merchant's
// accruals into the last completed period so the run can be drafted now, the
// way it would be on payout week.
const period = await finance.finance.currentPeriod({});
await db
  .update(cod.codEntry)
  .set({ ts: new Date(`${period.periodStart}T06:00:00Z`) })
  .where(and(eq(cod.codEntry.merchantId, MCH), eq(cod.codEntry.type, "ACCRUE")));

// ─────────────────────────────────────────────────────────────── holds
console.log("\n4. Holds");
let holdId = "";
await step("a merchant-wide hold raised in the UI → DB open hold", async () => {
  await go(fin, "/finance/remittances?tab=holds");
  await fin.getByRole("button", { name: "Raise hold" }).click();
  const d = dialog(fin, "Raise a payout hold");
  await d.getByLabel("Hold scope").selectOption("merchant");
  await d.getByLabel("Merchant").selectOption(MCH);
  await field(d, "Why (required)").fill(`UI proof ${RUN}: KYC re-check before payout`);
  await d.getByRole("button", { name: "Raise hold" }).click();
  await confirm(fin, "Raise this hold?", "Raise hold");
  const rows = await db.select().from(cod.codHold).where(and(eq(cod.codHold.merchantId, MCH), eq(cod.codHold.status, "open")));
  must(rows.length === 1 && rows[0]!.scope === "merchant", `${rows.length} open holds`);
  holdId = rows[0]!.id;
  return holdId;
});
await step("the settlement preview warns about the open merchant hold", async () => {
  await go(fin, "/finance/remittances");
  await fin.locator("tr", { hasText: MCH_NAME }).getByRole("button", { name: "Draft run" }).click();
  const d = dialog(fin, "Draft a settlement run");
  await d.getByText(/merchant-level hold\(s\) are open/).waitFor({ timeout: 20_000 });
  await fin.keyboard.press("Escape");
  return "warning shown";
});
await step("the hold is cleared in the UI with a note → DB cleared", async () => {
  await go(fin, "/finance/remittances?tab=holds");
  await fin.locator("tr", { hasText: MCH_NAME }).first().click();
  const d = fin.getByRole("dialog").first();
  await field(d, "Why is it safe to release? (required)").fill("KYC documents re-verified");
  await d.getByRole("button", { name: "Clear hold" }).click();
  await confirm(fin, "Clear this hold?", "Clear hold");
  const [row] = await db.select().from(cod.codHold).where(eq(cod.codHold.id, holdId));
  must(row?.status === "cleared", `DB ${row?.status}`);
  await fin.keyboard.press("Escape");
  return `${holdId} cleared`;
});

// ─────────────────────────────────────────────────────────────── settlement
console.log("\n5. Settlement run — maker, checker, payout file, UTR (§8 checkpoints 4–6)");
let stl: typeof cod.codSettlement.$inferSelect | undefined;
await step("due card lists the fixture merchant at the banked gross", async () => {
  await go(fin, "/finance/remittances");
  const row = fin.locator("tr", { hasText: MCH_NAME });
  await row.waitFor();
  const text = (await row.textContent()) ?? "";
  must(text.includes((grossCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })), `row: ${text}`);
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
});
await step("draft with a Rs. 25.50 penalty: preview net = gross − 2550, created → DB draft", async () => {
  await fin.locator("tr", { hasText: MCH_NAME }).getByRole("button", { name: "Draft run" }).click();
  const d = dialog(fin, "Draft a settlement run");
  await d.getByRole("button", { name: "Add deduction" }).click();
  await d.getByLabel("Deduction 1 type").selectOption("penalty");
  await d.getByLabel("Deduction 1 amount in rupees").fill("25.50");
  await d.getByLabel("Deduction 1 description").fill(`UI proof ${RUN} late pickup penalty`);
  const net = grossCents - 2550;
  await d.getByRole("button", { name: "Create draft" }).waitFor();
  await fin.waitForFunction((want) => document.body.innerText.includes(want), money(net), { timeout: 20_000 });
  await d.getByRole("button", { name: "Create draft" }).click();
  await confirm(fin, "Create this settlement draft?", `Draft ${money(net)}`);
  [stl] = await db.select().from(cod.codSettlement).where(eq(cod.codSettlement.merchantId, MCH)).orderBy(desc(cod.codSettlement.createdAt)).limit(1);
  must(stl && stl.status === "draft" && stl.netCents === net && stl.grossCents === grossCents, `DB ${stl?.status} net ${stl?.netCents}`);
  must(stl.createdById === financeS.user.id, `maker ${stl.createdById}`);
  return `${stl.code}: ${money(stl.grossCents)} − 25.50 = ${money(stl.netCents)}`;
});
const code = stl?.code ?? "STL-missing";
await step("the maker proposes it → DB proposed; the drawer names them as the maker", async () => {
  const d = dialog(fin, code);
  await d.waitFor();
  await d.getByRole("button", { name: "Propose" }).click();
  await confirm(fin, "Propose for approval?", "Propose");
  await d.getByText(/You drafted this run\. Maker–checker/).waitFor({ timeout: 20_000 });
  const [row] = await db.select().from(cod.codSettlement).where(eq(cod.codSettlement.code, code));
  must(row?.status === "proposed", `DB ${row?.status}`);
  return "proposed";
});
await step("the maker's own approve is refused by the server, the refusal is shown, DB unchanged", async () => {
  expected = [{ status: 403, path: "/finance/approveSettlement" }];
  const d = dialog(fin, code);
  await d.getByRole("button", { name: "Approve" }).click();
  await confirm(fin, "Approve this payout?", "Approve");
  const note = d.getByRole("alert").first();
  await note.waitFor({ timeout: 20_000 });
  const text = (await note.textContent()) ?? "";
  const [row] = await db.select().from(cod.codSettlement).where(eq(cod.codSettlement.code, code));
  must(row?.status === "proposed" && !row.approvedById, `DB ${row?.status}`);
  must(/approve|maker|checker|drafted/i.test(text), `message: ${text}`);
  expected = [];
  return text.trim().slice(0, 120);
});

const approveCalls: { key: string; status: number | "dropped" }[] = [];
await step("the checker's approve: response lost, retry replays the SAME key → DB approved by the checker", async () => {
  await go(adm, "/finance/remittances");
  await adm.locator("tr", { hasText: code }).click();
  const d = dialog(adm, code);
  await d.getByText(/You are the checker/).waitFor();
  let dropNext = true;
  await adm.route("**/api/rpc/finance/approveSettlement", async (route) => {
    const k = route.request().headers()["idempotency-key"] ?? "";
    if (dropNext) {
      dropNext = false;
      droppedOnPurpose += 1;
      await route.fetch(); // the server DOES approve…
      approveCalls.push({ key: k, status: "dropped" });
      await route.abort("failed"); // …but the browser never hears back
      return;
    }
    const resp = await route.fetch();
    approveCalls.push({ key: k, status: resp.status() });
    await route.fulfill({ response: resp });
  });
  await d.getByRole("button", { name: "Approve" }).click();
  await confirm(adm, "Approve this payout?", "Approve");
  await d.getByRole("alert").first().waitFor({ timeout: 20_000 });
  must(approveCalls.length === 1, `${approveCalls.length} calls after the drop`);
  await d.getByRole("button", { name: "Approve" }).click();
  await confirm(adm, "Approve this payout?", "Approve");
  await d.getByRole("button", { name: /Record payment/ }).waitFor({ timeout: 20_000 });
  await adm.unroute("**/api/rpc/finance/approveSettlement");
  must(Number(approveCalls.length) === 2, `${approveCalls.length} calls`);
  must(approveCalls[0]!.key !== "" && approveCalls[0]!.key === approveCalls[1]!.key, `keys ${approveCalls.map((c) => c.key).join(" vs ")}`);
  must(approveCalls[1]!.status === 200, `retry status ${approveCalls[1]!.status}`);
  const [row] = await db.select().from(cod.codSettlement).where(eq(cod.codSettlement.code, code));
  must(row?.status === "approved" && row.approvedById === adminS.user.id, `DB ${row?.status} by ${row?.approvedById}`);
  return `same key ${approveCalls[0]!.key.slice(0, 8)}… twice; approved by ${adminS.user.name}`;
});
await step("payout file: beneficiary account and exact net; DB stamped exported", async () => {
  const d = dialog(adm, code);
  const lines = await readDownload(adm, () => d.getByRole("button", { name: /^Payout file/ }).click());
  const body = lines.join("\n");
  must(lines.length === 2, `${lines.length} lines`);
  must(body.includes("8004400440"), "no account number");
  must(body.includes(((grossCents - 2550) / 100).toFixed(2)), `no net in: ${lines[1]}`);
  const [row] = await db.select().from(cod.codSettlement).where(eq(cod.codSettlement.code, code));
  must(row?.exportedAt, "exportedAt not stamped");
  return lines[1]!.slice(0, 120);
});
await step("a second export is refused as already-exported; only 'Export again' sends it", async () => {
  expected = [{ status: 409, path: "/finance/exportPayoutCsv" }];
  const d = dialog(adm, code);
  await d.getByRole("button", { name: /^Payout file/ }).click();
  const again = dialog(adm, "Send this payout file again?");
  await again.waitFor({ timeout: 20_000 });
  const lines = await readDownload(adm, () => again.getByRole("button", { name: "Export again" }).click());
  must(lines.length === 2 && lines.join("\n").includes("8004400440"), `${lines.length} lines`);
  expected = [];
  return "forced re-export downloaded";
});
await step("the UTR is required, then recorded → DB paid with the UTR", async () => {
  const d = dialog(adm, code);
  await d.getByRole("button", { name: /Record payment/ }).click();
  const c = dialog(adm, "Record the bank payment?");
  const go_ = c.getByRole("button", { name: "Record payment" });
  must(await go_.isDisabled(), "confirm enabled before a UTR");
  await c.getByLabel("Bank UTR").fill(`UIUTR${RUN}`);
  await go_.click();
  await c.waitFor({ state: "hidden", timeout: 20_000 });
  const [row] = await db.select().from(cod.codSettlement).where(eq(cod.codSettlement.code, code));
  must(row?.status === "paid" && row.utr === `UIUTR${RUN}`, `DB ${row?.status} ${row?.utr}`);
  await adm.keyboard.press("Escape");
  return `${code} paid, UTR ${row.utr}`;
});

// ─────────────────────────────────────────────────────────────── invoices
console.log("\n6. Invoices");
let invCode = "";
await step("draft with a manual charge → issue → DB issued", async () => {
  await go(fin, "/finance/invoices");
  await fin.getByRole("button", { name: "Draft invoice" }).click();
  const d = dialog(fin, "Draft an invoice");
  await d.getByLabel("Merchant").selectOption(MCH);
  await d.getByRole("button", { name: /Add charge/ }).click();
  await d.getByLabel("Charge 1 description").fill(`UI proof ${RUN} packaging`);
  await d.getByLabel("Charge 1 unit price in rupees").fill("1000");
  await d.getByLabel("Charge 1 quantity").fill("2");
  await d.getByRole("button", { name: /Create draft/ }).waitFor();
  await fin.waitForFunction(() => !document.body.innerText.includes("Computing preview"), undefined, { timeout: 20_000 });
  await fin.waitForTimeout(600);
  await d.getByRole("button", { name: /Create draft/ }).click();
  await confirm(fin, "Create this invoice draft?", /^Draft Rs\./);
  const [inv] = await db.select().from(cod.codInvoice).where(eq(cod.codInvoice.merchantId, MCH)).orderBy(desc(cod.codInvoice.createdAt)).limit(1);
  must(inv && inv.status === "draft" && inv.subtotalCents >= 200_000, `DB ${inv?.status} ${inv?.subtotalCents}`);
  invCode = inv.code;
  const drawer = dialog(fin, invCode);
  await drawer.getByRole("button", { name: "Issue" }).click();
  await confirm(fin, /Issue/, /Issue/);
  const [after] = await db.select().from(cod.codInvoice).where(eq(cod.codInvoice.id, inv.id));
  // COD already recovered against the charges (§8 set-off) makes it part paid on issue.
  const want = after && (after.recoveredCents > 0 || after.creditedCents > 0) ? "part_paid" : "issued";
  must(after?.status === want, `DB ${after?.status}, want ${want} (recovered ${after?.recoveredCents})`);
  return `${invCode} ${money(after.totalCents)}`;
});
await step("a Rs. 400.00 payment with a bank reference → DB part paid", async () => {
  const drawer = dialog(fin, invCode);
  await drawer.getByRole("button", { name: "Record payment" }).click();
  const c = fin.getByRole("dialog").filter({ hasText: "Amount (Rs.)" });
  await c.getByLabel("Amount in rupees").fill("400");
  await c.getByLabel("Bank reference").fill(`UIPAY-${RUN}`);
  await c.getByRole("button", { name: /Record/ }).click();
  await c.waitFor({ state: "hidden", timeout: 20_000 });
  const [inv] = await db.select().from(cod.codInvoice).where(eq(cod.codInvoice.code, invCode));
  must(inv?.paidCents === 40_000 && inv.status === "part_paid", `DB ${inv?.status} paid ${inv?.paidCents}`);
  await fin.keyboard.press("Escape");
  return `${invCode} part paid`;
});
await step("AR ageing outstanding tile equals finance.arAgeing", async () => {
  await go(fin, "/finance/invoices?tab=ageing");
  const ar = await finance.finance.arAgeing({});
  const got = await tileValue(fin, "Outstanding");
  must(got === money(ar.outstandingCents), `"${got}" ≠ ${money(ar.outstandingCents)}`);
  return got;
});

// ─────────────────────────────────────────────────────────────── disputes
console.log("\n7. Disputes — merchant raises, finance decides");
let caseCode = "";
await step("the merchant raises a billing dispute in the portal → DB open, scoped to them", async () => {
  await go(mer, "/merchant/disputes");
  await mer.getByRole("button", { name: /Raise a dispute|Open a case/ }).click();
  const d = dialog(mer, "Raise a dispute");
  await d.getByLabel("Dispute type").selectOption("billing");
  await d.getByLabel("Amount claimed in rupees").fill("150");
  await field(d, "What happened (at least 10 characters)").fill(`UI proof ${RUN}: charged twice for one pickup`);
  await d.getByRole("button", { name: /Submit|Raise|Open/ }).first().click();
  await confirm(mer, "Submit this dispute?", "Submit");
  const [row] = await db.select().from(cod.codDispute).where(and(eq(cod.codDispute.merchantId, SEEDED_MCH), like(cod.codDispute.description, `%${RUN}: charged twice%`)));
  must(row?.status === "open" && row.claimAmountCents === 15_000, `DB ${row?.status} ${row?.claimAmountCents}`);
  caseCode = row.code;
  return caseCode;
});
await step("finance sees it in the queue, picks it up and rejects it behind a confirm → DB rejected", async () => {
  await go(fin, "/finance/disputes");
  await fin.locator("tr", { hasText: caseCode }).click();
  const d = dialog(fin, caseCode);
  await d.getByRole("button", { name: "Pick up" }).click();
  await confirm(fin, "Pick up this case?", "Pick up");
  await d.getByRole("button", { name: "Decide" }).click();
  await d.getByLabel("Outcome").selectOption("rejected");
  await field(d, "Reasoning (at least 10 characters — the merchant sees this)").fill("Two separate pickups were booked on that day.");
  await d.getByRole("button", { name: "Record decision" }).click();
  await confirm(fin, "Reject this case?", "Reject");
  const [row] = await db.select().from(cod.codDispute).where(eq(cod.codDispute.code, caseCode));
  must(row?.status === "rejected" && row.resolvedById === financeS.user.id && row.assignedToId === financeS.user.id, `DB ${row?.status}`);
  // Its dispute_opened alert closes with the case (the worker may raise it late).
  let alerts = await db.select().from(cod.codOpsAlert).where(eq(cod.codOpsAlert.disputeId, row.id));
  for (let i = 0; i < 20 && alerts.length === 0; i++) {
    await fin.waitForTimeout(500);
    alerts = await db.select().from(cod.codOpsAlert).where(eq(cod.codOpsAlert.disputeId, row.id));
  }
  must(alerts.length > 0 && alerts.every((a) => a.status === "resolved"), `alerts: ${alerts.map((a) => a.status).join(",") || "none raised"}`);
  await fin.keyboard.press("Escape");
  return `${caseCode} rejected by ${financeS.user.name}; its ${alerts.length} alert(s) resolved`;
});
await step("the merchant sees the decision and the reasoning", async () => {
  await go(mer, "/merchant/disputes");
  await mer.locator("[aria-label='Dispute status']").selectOption("");
  await mer.locator("tr", { hasText: caseCode }).click();
  const d = dialog(mer, caseCode);
  await d.getByText("Two separate pickups were booked on that day.").waitFor();
  must(!(await d.getByRole("button", { name: "Decide" }).count()), "merchant offered Decide");
  await mer.keyboard.press("Escape");
  return "rejected + reasoning visible, no Decide";
});
await step("a second case is withdrawn by the merchant (reason required) → DB withdrawn", async () => {
  const c = await clientFor(merchantS.accessToken, key("open2")).disputes.open({
    type: "billing",
    claimAmountCents: 5_000,
    description: `UI proof ${RUN}: second case to withdraw`,
  });
  await go(mer, "/merchant/disputes");
  await mer.locator("tr", { hasText: c.code }).click();
  const d = dialog(mer, c.code);
  await d.getByRole("button", { name: "Withdraw" }).click();
  const w = dialog(mer, "Withdraw this dispute?");
  must(await w.getByRole("button", { name: "Withdraw" }).isDisabled(), "withdraw enabled without a reason");
  await field(w, "Why (at least 5 characters)").fill("Sorted it out with the branch");
  await w.getByRole("button", { name: "Withdraw" }).click();
  await w.waitFor({ state: "hidden", timeout: 20_000 });
  const [row] = await db.select().from(cod.codDispute).where(eq(cod.codDispute.id, c.id));
  must(row?.status === "withdrawn", `DB ${row?.status}`);
  await mer.keyboard.press("Escape");
  return `${c.code} withdrawn`;
});

// ─────────────────────────────────────────────────────────────── controls
console.log("\n8. Controls");
await step("'Run now' records exactly one new manual invariant run", async () => {
  const before = await finance.cod.invariantRuns({ limit: 5 });
  const top = before[0]?.id;
  await go(fin, "/finance/cod?tab=invariant");
  await fin.getByRole("button", { name: /Run now/ }).click();
  await confirm(fin, "Run the invariant check now?", "Run check");
  let runs = await finance.cod.invariantRuns({ limit: 5 });
  for (let i = 0; i < 20 && runs[0]?.id === top; i++) {
    await fin.waitForTimeout(500);
    runs = await finance.cod.invariantRuns({ limit: 5 });
  }
  must(runs[0]!.id !== top && runs[0]!.trigger === "manual", `newest run ${runs[0]?.id} (${runs[0]?.trigger}), was ${top}`);
  must(runs[1]?.id === top, `more than one new run: ${runs.slice(0, 3).map((r) => r.id).join(", ")}`);
  return `${runs[0]!.result}: ${runs[0]!.ridersChecked} riders, ${runs[0]!.breachCount} breaches`;
});
await step("the fixture alert is acknowledged then resolved with a note → DB resolved", async () => {
  await go(fin, "/finance/cod?tab=alerts");
  await fin.locator("tr", { hasText: `UI fixture ${RUN}` }).click();
  const d = fin.getByRole("dialog").first();
  await d.getByRole("button", { name: /Acknowledge/ }).click();
  await fin.waitForFunction(() => document.body.innerText.includes("Dilani"), undefined, { timeout: 20_000 });
  await field(d, "Resolution note (at least 3 characters)").fill("Fixture: rider topped up the shortfall");
  await d.getByRole("button", { name: /^Resolve/ }).click();
  await confirm(fin, "Resolve this alert?", "Resolve");
  const [row] = await db.select().from(cod.codOpsAlert).where(eq(cod.codOpsAlert.id, alertFx.alert.id));
  must(row?.status === "resolved" && row.acknowledgedById === financeS.user.id, `DB ${row?.status}`);
  await fin.keyboard.press("Escape");
  return alertFx.alert.id;
});
await step("a setting is changed and changed back; a short reason keeps Save disabled", async () => {
  const k = "dispute_sla_days";
  const before = (await finance.cod.listConfig({})).find((r) => r.key === k)!.value;
  await go(fin, "/finance/cod?tab=config");
  const change = async (to: number, reason: string) => {
    await fin.getByRole("button", { name: `Change ${k}` }).click();
    const d = dialog(fin, k);
    await d.getByLabel("New value").fill(String(to));
    const reasonBox = field(d, "Reason (at least 5 characters, kept in the audit log)");
    await reasonBox.fill("ab");
    const save = d.getByRole("button", { name: /Review|Save|Change|Set/ }).first();
    must(await save.isDisabled(), "save enabled with a 2-char reason");
    await reasonBox.fill(reason);
    await save.click();
    await confirm(fin, "Change this setting?", `Set to ${to}`);
    await d.getByText(`${k}: `).waitFor({ timeout: 20_000 });
    await fin.keyboard.press("Escape");
  };
  await change(before + 1, `UI proof ${RUN} temporary change`);
  const mid = (await finance.cod.listConfig({})).find((r) => r.key === k)!.value;
  await change(before, `UI proof ${RUN} revert`);
  const after = (await finance.cod.listConfig({})).find((r) => r.key === k)!.value;
  must(mid === before + 1 && after === before, `${before} → ${mid} → ${after}`);
  return `${k}: ${before} → ${mid} → ${after}`;
});

// ─────────────────────────────────────────────────────────────── bank details
const selectAll = async (p: Page, ariaLabel: string) => {
  await p.getByLabel(ariaLabel, { exact: true }).selectOption("");
  await p.waitForLoadState("networkidle");
};
console.log("\n8b. Bank details");
// An approved run for a merchant with NO bank details: the payout file must be
// refused, and the refusal must lead straight to the Bank details tab.
const bankFxCode = `UIF-BANK-${RUN}`;
await db.delete(cod.codMerchantPayout).where(eq(cod.codMerchantPayout.merchantId, MCH));
await db.insert(cod.codSettlement).values({
  id: `stl_uif_${RUN}`,
  code: bankFxCode,
  merchantId: MCH,
  merchantName: MCH_NAME,
  periodStart: "2020-04-04",
  periodEnd: "2020-04-10",
  payoutDate: "2020-04-15",
  grossCents: 1_000_00,
  netCents: 1_000_00,
  status: "approved",
  createdById: "ui-finance",
  createdByName: "ui-finance",
  approvedById: "ui-finance-checker",
  approvedByName: "Checker",
  approvedAt: new Date(),
});
try {
  await step("payout file for a merchant with no bank details: refused, and 'Add bank details' opens the tab for that merchant", async () => {
    expected = [{ status: 409, path: "/finance/exportPayoutCsv" }];
    await go(fin, "/finance/remittances");
    await selectAll(fin, "Settlement status");
    await fin.getByLabel("Search settlement runs").fill(bankFxCode);
    await fin.waitForLoadState("networkidle");
    await fin.locator("tbody tr", { hasText: bankFxCode }).click();
    const d = dialog(fin, bankFxCode);
    await d.waitFor();
    await d.getByRole("button", { name: /^Payout file/ }).click();
    const link = d.getByRole("link", { name: "Add bank details" });
    await link.waitFor({ timeout: 20_000 });
    await link.click();
    await fin.waitForURL(/tab=bank/);
    must(fin.url().includes(`merchant=${MCH}`), fin.url());
    await fin.getByRole("tab", { name: "Bank details", selected: true }).waitFor();
    must((await fin.getByLabel("Merchant for bank details").inputValue()) === MCH, "merchant not pre-selected");
    await fin.getByText("No bank details on file.").first().waitFor();
    must((await dialog(fin, bankFxCode).count()) === 0, "drawer still open");
    expected = [];
    const [row] = await db.select().from(cod.codSettlement).where(eq(cod.codSettlement.code, bankFxCode));
    must(row?.exportedAt === null, "a refused export stamped the run");
    return "409 payout-details-missing → /finance/remittances?tab=bank&merchant=" + MCH;
  });
  const acctField = () => field(fin, "Account number");
  const againField = () => field(fin, "Account number again");
  const saveBtn = () => fin.getByRole("button", { name: /^Save (bank|corrected) details$/ });
  await step("account numbers that differ: inline error and Save stays disabled", async () => {
    await field(fin, "Beneficiary name, exactly as the bank has it").fill(`${MCH_NAME} (Pvt) Ltd`);
    await field(fin, "Bank").fill("Commercial Bank");
    await field(fin, "Branch").fill("Union Place");
    await acctField().fill("8004400440");
    await againField().fill("8004400441");
    await fin.getByText("The two account numbers differ.").waitFor();
    must(await saveBtn().isDisabled(), "Save enabled on a mismatch");
    return "blocked";
  });
  await step("matching numbers, ticked as verified, saved through the confirm → DB row, masked on screen and in the audit", async () => {
    await againField().fill("8004400440");
    must(!(await fin.getByText("The two account numbers differ.").count()), "error persists");
    await fin.getByLabel("Checked against a bank document").check();
    await saveBtn().click();
    const d = dialog(fin, "Save these bank details?");
    await d.waitFor();
    const body = await d.innerText();
    must(body.includes("•••• 0440") && !body.includes("8004400440"), `confirm shows: ${body.slice(0, 160)}`);
    must(body.includes(MCH_NAME), "confirm does not name the merchant");
    await confirm(fin, "Save these bank details?", "Save details");
    await fin.getByText(/Saved\. Payouts for/).waitFor({ timeout: 20_000 });
    const [row] = await db.select().from(cod.codMerchantPayout).where(eq(cod.codMerchantPayout.merchantId, MCH));
    must(row?.accountNumber === "8004400440" && row.verified === true && row.bankName === "Commercial Bank", `DB ${row?.accountNumber} ${row?.verified}`);
    const onFile = await fin.locator("main").getByText("On file", { exact: true }).locator("xpath=ancestor::*[contains(@class,'rounded')][1]").innerText();
    must(onFile.includes("•••• 0440") && !onFile.includes("8004400440"), `on-file card: ${onFile.slice(0, 160)}`);
    // innerText applies the badge's CSS uppercase, so compare case-insensitively.
    must(/\bverified\b/i.test(onFile) && !/not verified/i.test(onFile), "no Verified badge");
    // Every audit row this run wrote — including the payout-file exports above,
    // whose response carries the full file — must hold only the masked account.
    const mine = await db.select().from(auditLog).where(gte(auditLog.ts, RUN_STARTED));
    const set = mine.filter((a) => a.action === "cod.payout_details_set" && a.entityId === MCH);
    must(set.length > 0, "no payout_details_set audit row");
    must(set.some((a) => a.afterJson?.includes("****0440")), "audit lacks the masked account");
    const leaks = mine.filter((a) => `${a.beforeJson}${a.afterJson}`.includes("8004400440"));
    must(leaks.length === 0, `full account number in ${leaks.length} audit row(s): ${[...new Set(leaks.map((a) => a.action))].join(", ")}`);
    return `DB verified; ${mine.length} audit rows this run, none with the full account`;
  });
  await step("re-pointing to a new account needs a reason (≥5 chars) and a destructive confirm → DB changed", async () => {
    await acctField().fill("8004400999");
    await againField().fill("8004400999");
    const reason = field(fin, "Why is the account changing? (required)");
    await reason.waitFor();
    await reason.fill("abc");
    must(await saveBtn().isDisabled(), "Save enabled with a 3-char reason");
    await reason.fill(`UI proof ${RUN}: merchant moved banks`);
    await saveBtn().click();
    const d = dialog(fin, "Re-point this merchant's payouts?");
    await d.waitFor();
    must((await d.innerText()).includes("•••• 0999"), "confirm missing the new masked account");
    await confirm(fin, "Re-point this merchant's payouts?", "Save details");
    await fin.getByText(/Saved\. Payouts for .* •••• 0999/).waitFor({ timeout: 20_000 });
    const [row] = await db.select().from(cod.codMerchantPayout).where(eq(cod.codMerchantPayout.merchantId, MCH));
    must(row?.accountNumber === "8004400999", `DB ${row?.accountNumber}`);
    return "•••• 0440 → •••• 0999";
  });
  await step("ops sent to the bank details tab never gets the form (money writes are finance-only)", async () => {
    const opsS = await login("+94772345678");
    const opsPage = await signedInPage(browser, opsS, "ops");
    await opsPage.goto(`${BASE}/finance/remittances?tab=bank&merchant=${MCH}`, { waitUntil: "networkidle" });
    const url = opsPage.url();
    const forms = await opsPage.getByRole("button", { name: /^Save (bank|corrected) details$/ }).count();
    await opsPage.context().close();
    must(forms === 0, "ops sees the save button");
    return url.includes("/finance") ? "no form" : `redirected to ${new URL(url).pathname}`;
  });
} finally {
  await cleanupWithRetry(() => db.delete(cod.codSettlement).where(like(cod.codSettlement.id, "stl_uif_%")));
}

// ─────────────────────────────────────────────────────────────── CSV
console.log("\n9. CSV exports equal the server totals");
await step("ledger (fixture merchant) = cod.entries total", async () => {
  await go(fin, "/finance/cod?tab=ledger");
  await fin.locator("#panel-ledger").getByLabel("Merchant").selectOption(MCH);
  await fin.waitForLoadState("networkidle");
  const n = await exportRows(fin);
  const t = (await finance.cod.entries({ merchantId: MCH, limit: 1 })).total;
  must(n === t, `${n} ≠ ${t}`);
  return `${n} rows`;
});
await step("settlements (All) = settlementPage total", async () => {
  await go(fin, "/finance/remittances");
  await selectAll(fin, "Settlement status");
  const n = await exportRows(fin, fin.locator("#panel-settlements"));
  const t = (await finance.finance.settlementPage({ page: 1, pageSize: 1 })).total;
  must(n === t, `${n} ≠ ${t}`);
  return `${n} rows`;
});
await step("invoices (All) = invoicePage total", async () => {
  await go(fin, "/finance/invoices");
  await selectAll(fin, "Invoice status");
  const n = await exportRows(fin);
  const t = (await finance.finance.invoicePage({ page: 1, pageSize: 1 })).total;
  must(n === t, `${n} ≠ ${t}`);
  return `${n} rows`;
});
await step("deposits (All) = depositPage total", async () => {
  await go(fin, "/finance/cod?tab=deposits");
  await selectAll(fin, "Deposit status");
  const n = await exportRows(fin);
  const t = (await finance.cod.depositPage({ page: 1, pageSize: 1 })).total;
  must(n === t, `${n} ≠ ${t}`);
  return `${n} rows`;
});
await step("holds (All) = holdPage total", async () => {
  await go(fin, "/finance/remittances?tab=holds");
  await selectAll(fin, "Hold status");
  const n = await exportRows(fin);
  const t = (await finance.finance.holdPage({ page: 1, pageSize: 1 })).total;
  must(n === t, `${n} ≠ ${t}`);
  return `${n} rows`;
});
await step("merchant disputes (All) = disputes.list total, scoped to the merchant", async () => {
  await go(mer, "/merchant/disputes");
  await selectAll(mer, "Dispute status");
  const n = await exportRows(mer);
  const t = (await merchantC.disputes.list({ limit: 1 })).total;
  must(n === t, `${n} ≠ ${t}`);
  return `${n} rows`;
});

// ─────────────────────────────────────────────────────────────── result
await browser.close();
check(problems.length === 0, "no console errors, page errors or unexpected HTTP failures", problems.slice(0, 6).join(" | "));
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
