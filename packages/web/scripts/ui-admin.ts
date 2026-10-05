/**
 * Live UI proof of the M5 admin portal (§10 M5) and the MFA sign-in (§2) in
 * headless Chrome. Every outcome is checked against the database or the API.
 *
 *   sign-in      admin and finance pass the TOTP challenge in the real login
 *                page; a brand-new ops user enrols from nothing (QR + key,
 *                code, 10 recovery codes) and later signs in with a recovery
 *                code; a merchant signs in with no MFA step at all
 *   security     the Security page shows the factor and recovery codes left,
 *                issues a new set behind a fresh TOTP code, and signs out
 *                another session → DB revoked
 *   users        edit a user's name → DB; reset their authenticator → DB
 *                factor gone and sessions revoked
 *   branches     edit a branch address → DB (restored afterwards)
 *   zones        edit a zone name → DB (restored afterwards)
 *   rate cards   create a card → draft → add slabs → save → quote equals the
 *                API quote → publish behind a reason → DB active
 *   merchants    onboard a merchant with that card and a portal login → DB;
 *                edit details → DB; reassign the rate card → DB
 *   settings     change an SLA with a reason (short reason refused) → DB
 *   templates    live preview follows the typing; an unknown placeholder
 *                blocks save; a valid edit saves as a new version → DB
 *   audit        action-prefix filter, detail drawer, CSV = API total
 *   monitor      health renders; a failed job fixture is retried → DB pending
 *   guards       ops sees the read-only reference set, no write buttons, and
 *                is bounced off the audit log and monitor; every admin screen
 *                renders with no sideways scroll; keyboard tab strip
 *
 *   bun --env-file=../../.env scripts/ui-admin.ts
 */

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { readFileSync } from "node:fs";
import { and, eq, inArray, isNull, like } from "drizzle-orm";
import type { AppRouterClient } from "../src/api";
import { finishMfa } from "./lib/mfa";

const BASE = process.env.UI_CHECK_BASE ?? "http://localhost:4200";
const { db } = await import("../src/api/database");
const { cleanupWithRetry, hardenScriptReads } = await import("./lib/db-retry");
hardenScriptReads(db);
const { rateLimit, outbox } = await import("../src/api/database/schema/shared");
const identity = await import("../src/api/database/schema/identity");
const merchants = await import("../src/api/database/schema/merchants");
const { settingValue } = await import("../src/api/database/schema/settings");
const { notifyTemplate } = await import("../src/api/database/schema/notifications");
const { totpAt, stepAt, TOTP_WINDOW } = await import("../src/api/shared/totp");
const { getFactor, devCodeFor } = await import("../src/api/modules/identity/mfa");

const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const DIGITS = String(Date.now()).slice(-7);
const BRANCH = "brn_cmb_central";
const ADMIN_PHONE = "+94773456789";
const FINANCE_PHONE = "+94774567890";
const OPS_PHONE = "+94772345678";
const MERCHANT_PHONE = "+94775678901";

let keySeq = 0;
function clientFor(token?: string): AppRouterClient {
  return createORPCClient(
    new RPCLink({
      url: `${BASE}/api/rpc`,
      headers: () => ({
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "idempotency-key": `ui-admin-${RUN}-${++keySeq}`,
      }),
    }),
  );
}
const anon = clientFor();
type Session = Awaited<ReturnType<typeof anon.identity.verifyOtp>>;
async function clearBuckets() {
  await db.delete(rateLimit).where(like(rateLimit.bucket, "%identity.%Otp"));
  await db.delete(rateLimit).where(like(rateLimit.bucket, "%mfa.%"));
}
async function login(phone: string, deviceId: string): Promise<Session> {
  await clearBuckets();
  const c = await anon.identity.requestOtp({ phone });
  if (!c.devCode) throw new Error(`no dev OTP for ${phone}`);
  return finishMfa(BASE, await anon.identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode, deviceId }));
}
/** A code for a TOTP step this factor has not used yet; waits for the next step if the window is spent. */
async function freshCode(userId: string, secret: string): Promise<string> {
  for (let tries = 0; tries < 4; tries += 1) {
    const f = await getFactor(userId);
    const now = stepAt(Date.now());
    for (let s = now - TOTP_WINDOW + 1; s <= now + TOTP_WINDOW; s += 1) if (s > (f?.lastStep ?? 0)) return totpAt(secret, s);
    await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 300));
  }
  throw new Error("no unused TOTP step");
}

let pass = 0;
const failures: string[] = [];
function check(cond: boolean, label: string, detail = ""): void {
  if (cond) pass += 1;
  else failures.push(label);
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
let evidencePage: Page | null = null;
let shots = 0;
async function step(label: string, fn: () => Promise<string | void>) {
  try {
    check(true, label, (await fn()) ?? "");
  } catch (error) {
    if (evidencePage) {
      const path = `/tmp/ui-admin-fail-${++shots}.png`;
      await evidencePage.screenshot({ path, fullPage: true }).catch(() => undefined);
      console.log(`        evidence: ${path}`);
    }
    check(false, label, (error as Error).message.split("\n")[0]!.slice(0, 300));
  }
}
function must(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const created = { users: [] as string[], merchants: [] as string[], rateCards: [] as string[], outbox: [] as string[] };
const restore: (() => Promise<unknown>)[] = [];

// ═══════════════════════════════════════════════════════════════ browser plumbing
const problems: string[] = [];
const expected: { status: number; path: string }[] = [];
function watch(p: Page, label: string) {
  p.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/React DevTools|\[vite\]|favicon|onedollarstats|analytics/i.test(t)) return;
    if (/Failed to load resource: the server responded/.test(t)) return;
    problems.push(`[${label}] ${t.slice(0, 300)}`);
  });
  p.on("response", (r) => {
    if (r.status() < 400) return;
    const path = new URL(r.url()).pathname;
    if (expected.some((e) => e.status === r.status() && path.endsWith(e.path))) return;
    problems.push(`[${label}] HTTP ${r.status()} ${path}`);
  });
  p.on("pageerror", (e) => problems.push(`[${label}] pageerror: ${e.message.slice(0, 300)}`));
}
async function freshContext(browser: Browser, deviceId: string): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await context.addInitScript((d: string) => localStorage.setItem("natex.deviceId", d), deviceId);
  return context;
}
async function signedInPage(browser: Browser, s: Session, label: string, deviceId: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await context.addInitScript(
    ([k, v, d]: string[]) => {
      localStorage.setItem(k!, v!);
      localStorage.setItem("natex.deviceId", d!);
    },
    ["natex.session", JSON.stringify({ accessToken: s.accessToken, refreshToken: s.refreshToken, expiresAt: Date.now() + s.expiresIn * 1000, user: s.user }), deviceId],
  );
  const p = await context.newPage();
  watch(p, label);
  return p;
}
type Scope = Pick<Page, "locator">;
const field = (p: Scope, label: string) =>
  p.locator(`label:has(> span.label-xs:text-is(${JSON.stringify(label)}))`).locator("input, textarea, select").first();
const dialog = (p: Page, name: string | RegExp) => p.getByRole("dialog", { name });
async function go(p: Page, path: string) {
  await p.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
}
async function noOverflow(p: Page) {
  const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  if (m.sw > m.iw + 1) throw new Error(`page scrolls sideways: ${m.sw}px > ${m.iw}px`);
}
async function h1(p: Page): Promise<string> {
  return ((await p.locator("h1").first().textContent()) ?? "").trim();
}
/** Phone OTP in the real login page; returns once the MFA step (or the portal) is showing. */
async function phoneStep(p: Page, phone: string) {
  await clearBuckets();
  await go(p, "/login");
  await field(p, "Phone number").fill(phone);
  await p.getByRole("button", { name: "Send code" }).click();
  await p.getByText("Enter your code").waitFor();
  must((await field(p, "Six-digit code").inputValue()).length === 6, "dev OTP was not pre-filled");
  await p.getByRole("button", { name: "Verify and sign in" }).click();
}

// ═══════════════════════════════════════════════════════════════ fixtures
console.log(`\nUI proof — M5 admin portal → ${BASE}, run ${RUN}`);
const browser = await chromium.launch({ channel: "chrome" });

// ─────────────────────────────────────────────────────────────── 1. sign-in
console.log("\n1. Sign-in with MFA (§2)");
const loginCtx = await freshContext(browser, `ui-admin-login-${RUN}`);
const lp = await loginCtx.newPage();
watch(lp, "login");
evidencePage = lp;

await step("admin: phone OTP → TOTP challenge (dev code pre-filled) → admin portal", async () => {
  await phoneStep(lp, ADMIN_PHONE);
  await lp.getByText(/authenticator/i).first().waitFor();
  const code = field(lp, "Six-digit code");
  if ((await code.inputValue()).length !== 6) {
    const f = await getFactor("usr_admin_rajitha");
    const c = f ? await devCodeFor(f) : null;
    must(c, "no dev TOTP code available");
    await code.fill(c);
  }
  await lp.getByRole("button", { name: "Verify and sign in" }).click();
  await lp.waitForURL(/\/admin\/dashboard/, { timeout: 20_000 });
  const stored = await lp.evaluate(() => JSON.parse(localStorage.getItem("natex.session") ?? "{}"));
  must(stored.user?.role === "admin" && !stored.mfa?.state?.match(/challenge|enrol/), `stored session ${JSON.stringify(stored.mfa)}`);
  return new URL(lp.url()).pathname;
});

await step("finance: TOTP challenge → finance portal", async () => {
  await lp.evaluate(() => localStorage.removeItem("natex.session"));
  await phoneStep(lp, FINANCE_PHONE);
  await lp.getByRole("button", { name: "Verify and sign in" }).waitFor();
  if ((await field(lp, "Six-digit code").inputValue()).length !== 6) {
    const f = await getFactor("usr_finance_dilani");
    await field(lp, "Six-digit code").fill((await devCodeFor(f!))!);
  }
  await lp.getByRole("button", { name: "Verify and sign in" }).click();
  await lp.waitForURL(/\/finance$/, { timeout: 20_000 });
  return new URL(lp.url()).pathname;
});

await step("merchant: phone OTP alone lands in the merchant portal (no MFA step)", async () => {
  await lp.evaluate(() => localStorage.removeItem("natex.session"));
  await phoneStep(lp, MERCHANT_PHONE);
  await lp.waitForURL(/\/merchant$/, { timeout: 20_000 });
  return new URL(lp.url()).pathname;
});

// A brand-new ops user, created through the API by the admin.
const adminS = await login(ADMIN_PHONE, `ui-admin-api-${RUN}`);
const admin = clientFor(adminS.accessToken);
const newPhone = `+9477${DIGITS}`;
const newOps = await admin.identity.createUser({ name: `UIA Ops ${RUN}`, phone: newPhone, roles: ["ops"], branchId: BRANCH });
created.users.push(newOps.id);
let enrolSecret = "";
let recoveryCodes: string[] = [];

const enrolCtx = await freshContext(browser, `ui-admin-enrol-${RUN}`);
const ep = await enrolCtx.newPage();
watch(ep, "enrol");
evidencePage = ep;
await step("new ops user: enrol from nothing — QR and key shown, one code confirms, 10 recovery codes, then the ops board", async () => {
  await phoneStep(ep, newPhone);
  await ep.getByRole("button", { name: "Set up authenticator" }).click();
  await ep.getByAltText(/QR code/).waitFor();
  enrolSecret = ((await ep.getByTestId("mfa-secret").textContent()) ?? "").replace(/\s+/g, "");
  must(/^[A-Z2-7]{16,}$/.test(enrolSecret), `secret "${enrolSecret}"`);
  const src = await ep.getByAltText(/QR code/).getAttribute("src");
  must(src?.startsWith("data:image/png;base64,"), "QR is not a PNG data URL");
  await field(ep, "Code from the app").fill(await totpAt(enrolSecret, stepAt(Date.now())));
  await ep.getByRole("button", { name: "Confirm authenticator" }).click();
  await ep.getByTestId("recovery-code").first().waitFor();
  recoveryCodes = (await ep.getByTestId("recovery-code").allTextContents()).map((c) => c.trim());
  must(recoveryCodes.length === 10, `${recoveryCodes.length} recovery codes`);
  const cont = ep.getByRole("button", { name: /saved them/ });
  must(await cont.isDisabled(), "continue enabled before acknowledging");
  await ep.getByLabel("I have saved my recovery codes").check();
  await cont.click();
  await ep.waitForURL(/\/ops\/board/, { timeout: 20_000 });
  const f = await getFactor(newOps.id);
  must(f?.confirmedAt && !f.seeded, "DB factor not confirmed");
  return `${recoveryCodes.length} codes, DB factor confirmed`;
});

const recoveryCtx = await freshContext(browser, `ui-admin-recovery-${RUN}`);
const rp = await recoveryCtx.newPage();
watch(rp, "recovery");
evidencePage = rp;
await step("new ops user: a recovery code signs in once → DB code marked used", async () => {
  expected.push({ status: 400, path: "/mfa/verify" }, { status: 401, path: "/mfa/verify" });
  await phoneStep(rp, newPhone);
  await rp.getByRole("button", { name: "Lost your phone? Use a recovery code" }).click();
  await field(rp, "Recovery code").fill(recoveryCodes[0]!);
  await rp.getByRole("button", { name: "Verify and sign in" }).click();
  await rp.waitForURL(/\/ops\/board/, { timeout: 20_000 });
  const rows = await db.select().from(identity.mfaRecoveryCode).where(eq(identity.mfaRecoveryCode.userId, newOps.id));
  const used = rows.filter((r) => r.usedAt).length;
  must(used === 1, `${used} used codes`);
  return `${rows.length - used} left`;
});

// ─────────────────────────────────────────────────────────────── 2. security
console.log("\n2. Security page");
evidencePage = ep;
await step("Security is in the top bar and shows the factor and 9 of 10 codes left", async () => {
  await ep.getByRole("link", { name: "Security" }).click();
  await ep.waitForURL(/\/security$/);
  await ep.getByTestId("mfa-enrolled").waitFor();
  const left = (await ep.getByTestId("recovery-remaining").textContent())?.trim();
  must(left === "9 of 10", `"${left}"`);
  await noOverflow(ep);
  return left;
});
await step("new recovery codes need a current TOTP code → 10 fresh codes, old ones dead (DB)", async () => {
  const before = (await db.select().from(identity.mfaRecoveryCode).where(eq(identity.mfaRecoveryCode.userId, newOps.id))).map((r) => r.id);
  await ep.getByRole("button", { name: "New recovery codes" }).click();
  const d = dialog(ep, "Generate new recovery codes");
  const submit = d.getByRole("button", { name: "Issue new codes" });
  must(await submit.isDisabled(), "submit enabled with no code");
  await d.getByTestId("regen-code").fill(await freshCode(newOps.id, enrolSecret));
  await submit.click();
  await ep.getByTestId("recovery-code").first().waitFor();
  const codes = await ep.getByTestId("recovery-code").allTextContents();
  must(codes.length === 10 && !codes.includes(recoveryCodes[1]!), `${codes.length} codes`);
  const after = await db.select().from(identity.mfaRecoveryCode).where(eq(identity.mfaRecoveryCode.userId, newOps.id));
  must(after.length === 10 && after.every((r) => !before.includes(r.id) && !r.usedAt), "DB codes not replaced");
  await ep.getByLabel("I have saved my recovery codes").check();
  await ep.getByRole("button", { name: /saved them — close/ }).click();
  await ep.waitForFunction(() => document.querySelector('[data-testid="recovery-remaining"]')?.textContent?.trim() === "10 of 10");
  return "10 of 10";
});
await step("signing out the other browser's session from the sessions table → DB revoked", async () => {
  await ep.reload({ waitUntil: "networkidle" });
  const other = ep.locator("tr", { hasText: `ui-admin-rec` });
  await other.waitFor();
  must((await ep.locator("tr", { hasText: "This browser" }).count()) === 1, "current browser not marked");
  await other.getByRole("button", { name: /Sign out session/ }).click();
  await dialog(ep, "Sign out this session?").getByRole("button", { name: "Sign out" }).click();
  await ep.getByText("Session signed out.").waitFor();
  const live = await db
    .select()
    .from(identity.refreshToken)
    .where(and(eq(identity.refreshToken.userId, newOps.id), eq(identity.refreshToken.deviceId, `ui-admin-recovery-${RUN}`), isNull(identity.refreshToken.revokedAt)));
  must(live.length === 0, `${live.length} live tokens remain for that device`);
  return "revoked";
});

// ─────────────────────────────────────────────────────────────── signed-in pages
const opsS = await login(OPS_PHONE, `ui-admin-ops-${RUN}`);
const adm = await signedInPage(browser, adminS, "admin", `ui-admin-api-${RUN}`);
const ops = await signedInPage(browser, opsS, "ops", `ui-admin-ops-${RUN}`);
evidencePage = adm;

// ─────────────────────────────────────────────────────────────── 3. users
console.log("\n3. Users");
await step("edit a user's name in the drawer → DB", async () => {
  await go(adm, "/admin/users");
  await adm.locator("tr", { hasText: newPhone }).click();
  const drawer = dialog(adm, `UIA Ops ${RUN}`);
  await drawer.getByText("Enrolled").waitFor();
  await drawer.getByRole("button", { name: "Edit user" }).click();
  const d = dialog(adm, `Edit UIA Ops ${RUN}`);
  await field(d, "Full name").fill(`UIA Ops ${RUN} Renamed`);
  await d.getByRole("button", { name: "Save changes" }).click();
  await d.waitFor({ state: "hidden" });
  const [row] = await db.select().from(identity.user).where(eq(identity.user.id, newOps.id));
  must(row?.name === `UIA Ops ${RUN} Renamed`, `DB name ${row?.name}`);
  await adm.keyboard.press("Escape");
  return row.name;
});
await step("reset their authenticator with a reason → DB factor and codes gone, sessions revoked", async () => {
  await go(adm, "/admin/users");
  await adm.locator("tr", { hasText: newPhone }).click();
  const drawer = dialog(adm, `UIA Ops ${RUN} Renamed`);
  await drawer.getByRole("button", { name: "Reset authenticator" }).click();
  const d = dialog(adm, "Reset this user's authenticator?");
  const go1 = d.getByRole("button", { name: "Reset authenticator" });
  await field(d, "Reason").fill("no");
  must(await go1.isDisabled(), "short reason accepted");
  await field(d, "Reason").fill(`UI proof ${RUN}: phone replaced`);
  await go1.click();
  await adm.getByText("Authenticator reset.").waitFor();
  must(!(await getFactor(newOps.id)), "DB factor still present");
  const codes = await db.select().from(identity.mfaRecoveryCode).where(eq(identity.mfaRecoveryCode.userId, newOps.id));
  const live = await db.select().from(identity.refreshToken).where(and(eq(identity.refreshToken.userId, newOps.id), isNull(identity.refreshToken.revokedAt)));
  must(codes.length === 0 && live.length === 0, `${codes.length} codes, ${live.length} live sessions`);
  await adm.keyboard.press("Escape");
  return "factor gone, 0 live sessions";
});

// ─────────────────────────────────────────────────────────────── 4. branches & zones
console.log("\n4. Branches and zones");
await step("edit a branch's address → DB (restored after)", async () => {
  const [b] = await db.select().from(identity.branch).where(eq(identity.branch.id, "brn_cmb_hub"));
  must(b, "no brn_cmb_hub");
  restore.push(() => db.update(identity.branch).set({ address: b.address }).where(eq(identity.branch.id, b.id)));
  await go(adm, "/admin/branches");
  await adm.locator("tr", { hasText: b.code }).click();
  const d = dialog(adm, `Edit ${b.code}`);
  await field(d, "Address").fill(`${b.address} (UI ${RUN})`);
  await d.getByRole("button", { name: "Save branch" }).click();
  await d.waitFor({ state: "hidden" });
  const [after] = await db.select().from(identity.branch).where(eq(identity.branch.id, b.id));
  must(after?.address === `${b.address} (UI ${RUN})`, `DB ${after?.address}`);
  return b.code;
});
await step("edit a zone's name → DB (restored after)", async () => {
  const zones = await admin.routing.listZones({});
  const z = zones[0];
  must(z, "no zones");
  const { zone: zoneTable } = await import("../src/api/database/schema/routing");
  restore.push(() => db.update(zoneTable).set({ name: z.name }).where(eq(zoneTable.id, z.id)));
  await go(adm, "/admin/zones");
  await adm.locator("tr", { hasText: z.name }).first().click();
  const d = dialog(adm, `Edit zone ${z.name}`);
  await field(d, "Name").fill(`${z.name} UI${RUN}`);
  await d.getByRole("button", { name: "Save zone" }).click();
  await d.waitFor({ state: "hidden" });
  const [after] = await db.select().from(zoneTable).where(eq(zoneTable.id, z.id));
  must(after?.name === `${z.name} UI${RUN}`, `DB ${after?.name}`);
  return z.name;
});

// ─────────────────────────────────────────────────────────────── 5. rate cards
console.log("\n5. Rate cards (§15 q3 open — placeholder numbers)");
const CARD_CODE = `UIA-${RUN}`;
let cardId = "";
let versionId = "";
await step("the q3 banner is shown and a new card opens an empty draft", async () => {
  await go(adm, "/admin/rate-cards");
  await adm.getByTestId("q3-banner").waitFor();
  await adm.getByRole("button", { name: "New rate card" }).click();
  const d = dialog(adm, "New rate card");
  await field(d, "Code").fill(CARD_CODE);
  await field(d, "Name").fill(`UI proof card ${RUN}`);
  await d.getByRole("button", { name: "Create" }).click();
  await d.waitFor({ state: "hidden" });
  const [card] = await db.select().from(merchants.rateCard).where(eq(merchants.rateCard.code, CARD_CODE));
  must(card?.placeholder, "DB card missing or not placeholder");
  cardId = card.id;
  created.rateCards.push(card.id);
  await adm.getByRole("button", { name: "Save draft" }).waitFor();
  const [v] = await db.select().from(merchants.rateCardVersion).where(eq(merchants.rateCardVersion.rateCardId, card.id));
  must(v?.status === "draft", `DB version ${v?.status}`);
  versionId = v.id;
  return `${CARD_CODE} v${v.version} draft`;
});
let bands: string[] = [];
await step("add one slab per band, save → DB slabs in cents, no problems left", async () => {
  const doc = await admin.rateCards.version({ versionId });
  bands = doc.bands.map((b) => b.band);
  must(bands.length >= 1, "no bands");
  for (const [i, band] of bands.entries()) {
    await adm.getByRole("button", { name: "Add slab" }).click();
    await adm.getByLabel(`Slab ${i + 1} band`).selectOption(band);
    await adm.getByLabel(`Slab ${i + 1} weight limit in grams`).fill("1000");
    await adm.getByLabel(`Slab ${i + 1} price in rupees`).fill(i === 0 ? "350.50" : "420");
  }
  await adm.getByRole("button", { name: "Save draft" }).click();
  await adm.getByText("Draft saved. It is ready to publish.").waitFor({ timeout: 20_000 });
  const slabs = await db.select().from(merchants.rateSlab).where(eq(merchants.rateSlab.versionId, versionId));
  must(slabs.length === bands.length, `${slabs.length} slabs`);
  const first = slabs.find((s) => s.band === bands[0]);
  must(first?.priceCents === 35_050 && first.maxGrams === 1000, `DB slab ${JSON.stringify(first)}`);
  return `${slabs.length} slabs, first Rs. 350.50 = 35050 cents`;
});
await step("quote preview equals the API quote for 0.8 kg", async () => {
  await field(adm, "Band").selectOption(bands[0]!);
  await field(adm, "Weight (kg)").fill("0.8");
  await adm.getByRole("button", { name: "Quote", exact: true }).click();
  await adm.getByTestId("quote-total").waitFor();
  const shown = (await adm.getByTestId("quote-total").textContent())?.trim();
  const q = await admin.rateCards.quote({ versionId, band: bands[0]!, weightGrams: 800, requested: [] });
  const { money } = await import("../src/web/lib/format");
  must(shown === money(q.totalCents), `"${shown}" ≠ ${money(q.totalCents)}`);
  return shown;
});
await step("publish needs a reason, warns it is a placeholder → DB active", async () => {
  await adm.getByRole("button", { name: "Publish", exact: true }).click();
  const d = dialog(adm, "Publish v1?");
  await d.getByText(/PLACEHOLDER/).waitFor();
  const btn = d.getByRole("button", { name: "Publish", exact: true });
  must(await btn.isDisabled(), "publish enabled without a reason");
  await field(d, "Reason").fill(`UI proof ${RUN}`);
  await btn.click();
  await d.waitFor({ state: "hidden" });
  const [v] = await db.select().from(merchants.rateCardVersion).where(eq(merchants.rateCardVersion.id, versionId));
  must(v?.status === "active" && v.activatedAt, `DB ${v?.status}`);
  return "active";
});

// ─────────────────────────────────────────────────────────────── 6. merchant onboarding
console.log("\n6. Merchant onboarding");
const MCH_NAME = `UIA Traders ${RUN}`;
const portalPhone = `+9476${DIGITS}`;
let mchId = "";
await step("onboard a merchant with the new card and a portal login → DB merchant, card, user", async () => {
  await go(adm, "/ops/merchants");
  await adm.getByRole("button", { name: "Onboard merchant" }).click();
  const d = dialog(adm, "Onboard a merchant");
  await field(d, "Trading name").fill(MCH_NAME);
  await field(d, "Pickup address").fill("12 Proof Road, Colombo 03");
  await field(d, "Contact name").fill("Proof Contact");
  await field(d, "Contact phone").fill(`+9471${DIGITS}`);
  await field(d, "Rate card").selectOption(cardId);
  await d.getByText(/PLACEHOLDER tariff/).waitFor();
  await field(d, "Login name").fill(`UIA Shop ${RUN}`);
  await field(d, "Login phone").fill(portalPhone);
  await d.getByRole("button", { name: "Onboard merchant" }).click();
  await d.waitFor({ state: "hidden", timeout: 20_000 });
  const [m] = await db.select().from(merchants.merchant).where(eq(merchants.merchant.name, MCH_NAME));
  must(m, "DB merchant missing");
  mchId = m.id;
  created.merchants.push(m.id);
  const users = await db.select().from(identity.user).where(eq(identity.user.merchantId, m.id));
  for (const u of users) created.users.push(u.id);
  must(m.rateCardId === cardId, `DB rateCardId ${m.rateCardId}`);
  must(users.length === 1 && users[0]!.phone === portalPhone && users[0]!.role === "merchant", `${users.length} portal users`);
  await dialog(adm, MCH_NAME).getByText(`UIA Shop ${RUN}`).waitFor();
  return `${m.id} + ${users[0]!.id}`;
});
await step("edit details from the drawer → DB", async () => {
  const drawer = dialog(adm, MCH_NAME);
  await drawer.getByRole("button", { name: "Edit details" }).click();
  const d = dialog(adm, `Edit ${MCH_NAME}`);
  await field(d, "Contact name").fill("Proof Contact Two");
  await d.getByRole("button", { name: "Save merchant" }).click();
  await d.waitFor({ state: "hidden" });
  const [m] = await db.select().from(merchants.merchant).where(eq(merchants.merchant.id, mchId));
  must(m?.contactName === "Proof Contact Two", `DB ${m?.contactName}`);
  return m.contactName;
});
await step("reassign the rate card behind a confirm → DB", async () => {
  const drawer = dialog(adm, MCH_NAME);
  await field(drawer, "Assign").selectOption("rtc_pilot_placeholder");
  await drawer.getByRole("button", { name: "Assign", exact: true }).click();
  const d = dialog(adm, "Assign this rate card?");
  await d.getByRole("button", { name: "Assign", exact: true }).click();
  await d.waitFor({ state: "hidden" });
  const [m] = await db.select().from(merchants.merchant).where(eq(merchants.merchant.id, mchId));
  must(m?.rateCardId === "rtc_pilot_placeholder", `DB ${m?.rateCardId}`);
  await adm.keyboard.press("Escape");
  return "rtc_pilot_placeholder";
});

// ─────────────────────────────────────────────────────────────── 7. settings
console.log("\n7. Settings");
await step("change the NDR SLA with a reason (short reason refused) → DB", async () => {
  const rows = await admin.settings.list();
  const s = rows.find((r) => r.key === "ndr_sla_hours");
  must(s, "no ndr_sla_hours");
  restore.push(() => admin.settings.set({ key: "ndr_sla_hours", value: s.value, reason: `ui-admin ${RUN} restore` }));
  const next = s.value === s.max ? s.value - 1 : s.value + 1;
  await go(adm, "/admin/settings");
  await adm.getByRole("button", { name: `Change ${s.label}` }).click();
  const d = dialog(adm, `Change ${s.label}`);
  await d.locator("input").first().fill(String(next));
  await field(d, "Reason").fill("no");
  must(await d.getByRole("button", { name: "Save" }).isDisabled(), "short reason accepted");
  await field(d, "Reason").fill(`UI proof ${RUN}`);
  await d.getByRole("button", { name: "Save" }).click();
  await d.waitFor({ state: "hidden" });
  const [row] = await db.select().from(settingValue).where(eq(settingValue.key, "ndr_sla_hours"));
  must(row?.value === next, `DB ${row?.value}`);
  must(((await adm.getByTestId("setting-value-ndr_sla_hours").textContent()) ?? "").startsWith(String(next)), "page not updated");
  return `${s.value} → ${next}`;
});

// ─────────────────────────────────────────────────────────────── 8. templates
console.log("\n8. Notification templates");
await step("live preview follows the SMS body; an unknown placeholder blocks save; a valid edit saves a new version → DB", async () => {
  const all = await admin.notifications.templates({});
  const t = all.find((x) => x.bodySms && x.active) ?? all[0];
  must(t, "no templates");
  restore.push(() => admin.notifications.templateUpdate({ key: t.key, bodySms: t.bodySms ?? "" }));
  await go(adm, "/admin/templates");
  await adm.getByRole("list", { name: "Templates" }).getByRole("button", { name: new RegExp(t.key) }).click();
  const sms = field(adm, "SMS");
  await sms.fill(`${t.bodySms ?? ""} {{nope_${RUN.toLowerCase()}}}`);
  await adm.getByText(new RegExp(`nope_${RUN.toLowerCase()}`)).first().waitFor();
  const save = adm.getByRole("button", { name: "Save template" });
  await adm.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.includes("Save template"));
    return b?.hasAttribute("disabled");
  });
  const marker = `UI proof ${RUN}`;
  await sms.fill(`${t.bodySms ?? ""} ${marker}`);
  await adm.waitForFunction((m) => document.querySelector('[data-testid="preview-sms"]')?.textContent?.includes(m), marker, { timeout: 10_000 });
  await adm.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.includes("Save template"));
    return b && !b.hasAttribute("disabled");
  });
  await save.click();
  await adm.getByText(/Saved as version/).waitFor();
  const [row] = await db.select().from(notifyTemplate).where(eq(notifyTemplate.key, t.key));
  must(row?.bodySms?.endsWith(marker) && row.version === t.version + 1, `DB v${row?.version} "${row?.bodySms}"`);
  return `${t.key} v${t.version} → v${row.version}`;
});

// ─────────────────────────────────────────────────────────────── 9. audit
console.log("\n9. Audit log");
await step("action-prefix filter finds this run's rate-card writes; the drawer shows the after JSON", async () => {
  await go(adm, "/admin/audit");
  await adm.getByLabel("Entity id").fill(cardId);
  await adm.waitForLoadState("networkidle");
  const api = await admin.audit.list({ entityId: cardId, limit: 50, offset: 0 });
  must(api.total >= 1, "API shows no audit rows for the card");
  const rows = adm.locator("tbody tr");
  await adm.waitForFunction((n) => document.querySelectorAll("tbody tr").length === n, Math.min(api.total, 50), { timeout: 10_000 });
  await rows.first().click();
  await adm.getByTestId("audit-detail").waitFor();
  const after = (await adm.getByTestId("audit-afterJson").textContent()) ?? "";
  must(after.length > 1, "empty after JSON");
  await adm.keyboard.press("Escape");
  return `${api.total} rows for ${cardId}`;
});
await step("CSV export (action prefix rate_card.) row count = API total", async () => {
  await adm.getByLabel("Entity id").fill("");
  await adm.getByLabel("Action prefix").fill("rate_card.");
  await adm.waitForLoadState("networkidle");
  const t = (await admin.audit.list({ action: "rate_card.", limit: 1, offset: 0 })).total;
  const [dl] = await Promise.all([adm.waitForEvent("download", { timeout: 60_000 }), adm.locator("button", { hasText: "Export CSV" }).first().click()]);
  const lines = readFileSync((await dl.path())!, "utf8").replace(/^﻿/, "").trim().split(/\r?\n/);
  must(lines.length - 1 === t, `${lines.length - 1} ≠ ${t}`);
  return `${t} rows`;
});

// ─────────────────────────────────────────────────────────────── 10. monitor
console.log("\n10. System monitor");
const jobId = `obx_uia_${RUN}`;
await step("health shows the database, worker and queue", async () => {
  await go(adm, "/admin/monitor");
  await adm.getByTestId("monitor-health").waitFor();
  const w = (await adm.getByTestId("worker-state").textContent())?.trim();
  must(w === "Running" || w === "Stalled" || w === "Stopped", `worker "${w}"`);
  return `worker ${w}`;
});
await step("a failed job is retried behind a confirm → DB pending", async () => {
  await db.insert(outbox).values({
    id: jobId,
    topic: `uiadmin.fixture`,
    payloadJson: "{}",
    state: "failed",
    attempts: 1,
    lastError: `ui-admin fixture ${RUN}`,
    availableAt: new Date(Date.now() + 3_600_000),
  });
  created.outbox.push(jobId);
  await go(adm, "/admin/monitor?tab=jobs");
  const row = adm.locator("tr", { hasText: `ui-admin fixture ${RUN}` });
  await row.getByRole("button", { name: `Retry job ${jobId}` }).click();
  await dialog(adm, "Retry this job?").getByRole("button", { name: "Retry job" }).click();
  await adm.getByText("Job queued again.").waitFor();
  const [j] = await db.select().from(outbox).where(eq(outbox.id, jobId));
  must(j && j.state !== "failed", `DB ${j?.state}`);
  // Out of the worker's way at once: the fixture topic has no handler.
  await db.delete(outbox).where(eq(outbox.id, jobId));
  return `DB ${j.state}`;
});
await step("arrow keys move the monitor tab strip and mirror ?tab=", async () => {
  await go(adm, "/admin/monitor?tab=health");
  await adm.locator("#tab-health").focus();
  await adm.keyboard.press("ArrowRight");
  must(adm.url().endsWith("tab=jobs"), adm.url());
  await adm.keyboard.press("End");
  must(adm.url().endsWith("tab=invariants"), adm.url());
  return "health → jobs → (End) invariants";
});

// ─────────────────────────────────────────────────────────────── 11. guards & sweep
console.log("\n11. Role guards and route sweep");
const ADMIN_ROUTES: [string, string][] = [
  ["/admin/dashboard", "Company dashboard"],
  ["/admin/users", "Users"],
  ["/admin/branches", "Branches"],
  ["/admin/zones", "Serviceability zones"],
  ["/admin/rate-cards", "Rate cards"],
  ["/admin/settings", "Settings"],
  ["/admin/templates", "Notification templates"],
  ["/admin/audit", "Audit log"],
  ["/admin/monitor", "System monitor"],
  ["/security", "Security"],
];
evidencePage = adm;
await step(`admin: ${ADMIN_ROUTES.length} screens render with their heading and no sideways scroll; nav lists them`, async () => {
  for (const [path, want] of ADMIN_ROUTES) {
    await go(adm, path);
    const got = await h1(adm);
    must(got === want, `${path}: "${got}" ≠ "${want}"`);
    await noOverflow(adm);
  }
  const links = await adm.locator("nav a").allTextContents();
  for (const want of ["Company dashboard", "Rate cards", "Settings", "Templates", "Audit log", "System monitor"]) must(links.some((l) => l.includes(want)), `nav lacks ${want}`);
  must(!links.some((l) => /M5/.test(l)), "a nav item still carries an M5 milestone tag");
  return `${ADMIN_ROUTES.length} routes`;
});
evidencePage = ops;
await step("ops: reference nav is read-only (no write buttons) and the audit log / monitor bounce to the board", async () => {
  await go(ops, "/ops/board");
  const links = await ops.locator("nav a").allTextContents();
  for (const want of ["Users", "Branches", "Zones", "Rate cards", "Settings", "Templates"]) must(links.some((l) => l.includes(want)), `ops nav lacks ${want}`);
  must(!links.some((l) => /Audit log|System monitor/.test(l)), "ops nav shows admin-only items");
  await go(ops, "/admin/rate-cards");
  must((await h1(ops)) === "Rate cards", "ops cannot read rate cards");
  must((await ops.getByRole("button", { name: "New rate card" }).count()) === 0, "ops sees New rate card");
  await go(ops, "/admin/settings");
  must((await ops.getByRole("button", { name: /^Change / }).count()) === 0, "ops sees Change buttons");
  await go(ops, "/admin/templates");
  must((await ops.getByRole("button", { name: "Save template" }).count()) === 0, "ops sees Save template");
  for (const path of ["/admin/audit", "/admin/monitor"]) {
    await go(ops, path);
    must(new URL(ops.url()).pathname === "/ops/board", `${path} → ${ops.url()}`);
  }
  await go(ops, "/security");
  must((await h1(ops)) === "Security", "ops cannot open Security");
  return "6 reference screens, 2 bounced";
});

// ═══════════════════════════════════════════════════════════════ cleanup
await browser.close();
check(problems.length === 0, "no console errors, page errors or unexpected HTTP failures", problems.slice(0, 6).join(" | "));

await cleanupWithRetry(async () => {
  for (const fn of restore.reverse()) await fn();
  if (created.outbox.length) await db.delete(outbox).where(inArray(outbox.id, created.outbox));
  if (created.users.length) {
    await db.delete(identity.refreshToken).where(inArray(identity.refreshToken.userId, created.users));
    await db.delete(identity.mfaRecoveryCode).where(inArray(identity.mfaRecoveryCode.userId, created.users));
    await db.delete(identity.mfaFactor).where(inArray(identity.mfaFactor.userId, created.users));
    await db.delete(identity.user).where(inArray(identity.user.id, created.users));
  }
  if (created.merchants.length) await db.delete(merchants.merchant).where(inArray(merchants.merchant.id, created.merchants));
  for (const id of created.rateCards) {
    const vids = (await db.select({ id: merchants.rateCardVersion.id }).from(merchants.rateCardVersion).where(eq(merchants.rateCardVersion.rateCardId, id))).map((v) => v.id);
    if (vids.length) {
      await db.delete(merchants.rateBand).where(inArray(merchants.rateBand.versionId, vids));
      await db.delete(merchants.rateSlab).where(inArray(merchants.rateSlab.versionId, vids));
      await db.delete(merchants.rateSurcharge).where(inArray(merchants.rateSurcharge.versionId, vids));
      await db.delete(merchants.rateCardVersion).where(inArray(merchants.rateCardVersion.id, vids));
    }
    await db.delete(merchants.rateCard).where(eq(merchants.rateCard.id, id));
  }
});

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
