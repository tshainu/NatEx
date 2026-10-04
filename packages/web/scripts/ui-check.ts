/**
 * UI smoke check. Logs in over the real API (dev exposes the OTP code), drops
 * the session into localStorage the way the app does, then loads every portal
 * route in a headless browser and fails on any console error, page error or
 * visible error surface.
 *
 * The public tracking page is checked separately, in a browser context with no
 * session at all — that is the whole point of it, and a check that carried a
 * session would not prove it.
 *
 * This exists because `tsc` proves the screens compile, not that they render —
 * a wrong query shape or a bad hook order only shows up in the browser.
 *
 *   bun --env-file=../../.env scripts/ui-check.ts
 */

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { chromium, type Browser, type BrowserContext, type ConsoleMessage } from "playwright-core";
import { ne } from "drizzle-orm";
import type { AppRouterClient } from "../src/api";
import { finishMfa } from "./lib/mfa";

const BASE = process.env.UI_CHECK_BASE ?? "http://localhost:4200";

const ROUTES = [
  "/ops/board",
  "/ops/parcels",
  "/ops/book",
  "/ops/manifests",
  "/ops/hub-receipt",
  "/ops/bagging",
  "/ops/linehaul",
  "/ops/inbound",
  "/ops/scan-log",
  "/ops/runsheets",
  "/ops/ndr",
  "/ops/exceptions",
  "/ops/sync-conflicts",
  "/ops/serviceability",
  "/ops/merchants",
  "/admin/dashboard",
  "/admin/users",
  "/admin/branches",
  "/admin/zones",
  "/admin/rate-cards",
  "/admin/settings",
  "/admin/templates",
  "/admin/audit",
  "/admin/monitor",
  "/admin/monitor?tab=jobs",
  "/admin/monitor?tab=invariants",
  "/security",
  "/finance",
  "/finance/cod",
  "/finance/cod?tab=recon",
  "/finance/cod?tab=riders",
  "/finance/cod?tab=deposits",
  "/finance/cod?tab=invariant",
  "/finance/cod?tab=alerts",
  "/finance/cod?tab=config",
  "/finance/remittances",
  "/finance/remittances?tab=holds",
  "/finance/remittances?tab=bank",
  "/finance/invoices",
  "/finance/invoices?tab=ageing",
  "/finance/disputes",
  "/finance/disputes?tab=register",
];

/** Merchant portal — merchant-only in mayVisit, so it runs under its own session. */
const MERCHANT_ROUTES = [
  "/merchant",
  "/merchant/book",
  "/merchant/book?mode=csv",
  "/merchant/pickups",
  "/merchant/parcels",
  "/merchant/tracking",
  "/merchant/ndr",
  "/merchant/ndr?tab=rto",
  "/merchant/disputes",
  "/merchant/statement",
  "/merchant/statement?tab=settlements",
  "/merchant/statement?tab=invoices",
  "/merchant/account",
];

/** Console noise that is not a defect: Vite's dev chatter, React devtools. */
const IGNORE = [
  /Download the React DevTools/i,
  /\[vite\]/i,
  /favicon/i,
  /onedollarstats/i,
  /analytics/i,
];

// The OTP bucket is tight (5 per phone, refilling 1/min) and this script logs
// in once per run, so drain it first the way scripts/smoke.ts does.
const { db } = await import("../src/api/database");
const { hardenScriptReads } = await import("./lib/db-retry");
hardenScriptReads(db);
const { rateLimit } = await import("../src/api/database/schema/shared");
const { parcel } = await import("../src/api/database/schema/parcels");
await db.delete(rateLimit);

const anon: AppRouterClient = createORPCClient(new RPCLink({ url: `${BASE}/api/rpc` }));

async function signIn(phone: string) {
  const challenge = await anon.identity.requestOtp({ phone });
  if (!challenge.devCode) {
    throw new Error(`no dev OTP for ${phone} (smsState=${challenge.smsState})`);
  }
  return finishMfa(BASE, await anon.identity.verifyOtp({
    challengeId: challenge.challengeId,
    code: challenge.devCode,
    deviceId: "ui-check",
  }));
}

const failures: string[] = [];

/**
 * Load one route and assert it rendered. `expect` names text that must appear
 * (the found/not-found branches of a page are otherwise indistinguishable from
 * a blank render).
 */
async function visit(
  context: BrowserContext,
  route: string,
  options: {
    label?: string;
    expect?: RegExp;
    allowRedirect?: boolean;
    /** Extra console noise this route is expected to produce, e.g. a 404 the
     *  page is deliberately asking for. */
    ignore?: RegExp[];
  } = {},
): Promise<void> {
  const page = await context.newPage();
  const problems: string[] = [];
  const ignore = [...IGNORE, ...(options.ignore ?? [])];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (ignore.some((pattern) => pattern.test(text))) return;
    problems.push(`console: ${text.slice(0, 300)}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message.slice(0, 300)}`));

  let heading = "";
  try {
    await page.goto(`${BASE}${route}`, { waitUntil: "networkidle", timeout: 30_000 });
    // Let the polling queries settle one round.
    await page.waitForTimeout(1200);

    const here = new URL(page.url());
    const url = here.pathname + here.search;
    if (url !== route && !options.allowRedirect) problems.push(`redirected to ${url}`);

    const bodyText = (await page.locator("body").innerText()).slice(0, 6000);
    if (/Something went wrong|Unexpected Application Error|No such screen/i.test(bodyText)) {
      problems.push(`error surface: ${bodyText.slice(0, 200).replace(/\s+/g, " ")}`);
    }
    if (options.expect && !options.expect.test(bodyText)) {
      problems.push(`expected ${options.expect} in page, not found`);
    }
    heading = (await page.locator("h1").allInnerTexts())[0] ?? "(no h1)";
  } catch (error) {
    problems.push(`navigation: ${(error as Error).message.slice(0, 200)}`);
  }

  const name = options.label ? `${route} [${options.label}]` : route;
  console.log(problems.length === 0 ? `  PASS  ${name} — ${heading}` : `  FAIL  ${name}`);
  for (const problem of problems) {
    console.log(`        ${problem}`);
    failures.push(`${name} — ${problem}`);
  }
  await page.close();
}

/** The public tracking page, in a context that has never held a session. */
async function checkPublic(browser: Browser): Promise<number> {
  const moved = await db.select().from(parcel).where(ne(parcel.status, "Booked")).limit(1);
  const awb = moved[0]?.awb;
  if (!awb) throw new Error("no parcel past Booked in the database — seed first");

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const checks: Array<Parameters<typeof visit>[2] & { route: string }> = [
    // A real AWB: the status, the destination locality and the journey.
    { route: `/track/${awb}`, label: "found", expect: new RegExp(awb) },
    // A well-formed AWB that belongs to nothing must say so, not crash. The
    // API answering 404 is the correct behaviour here, so its network error is
    // expected noise rather than a defect.
    {
      route: "/track/NX0000000000",
      label: "not found",
      expect: /No shipment matches NX0000000000/i,
      ignore: [/status of 404/i],
    },
    // No AWB at all: the search prompt, reachable without a session.
    { route: "/track", label: "prompt", expect: /track/i },
  ];
  for (const { route, ...options } of checks) await visit(context, route, options);
  await context.close();
  return checks.length;
}

async function main() {
  // The seeded admin — the only role that can reach every portal route.
  const phone = process.env.UI_CHECK_PHONE ?? "+94773456789";
  const session = await signIn(phone);
  console.log(`signed in as ${phone}`);

  const stored = {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: Date.now() + session.expiresIn * 1000,
    user: session.user,
  };

  // playwright-core ships no browser binaries — drive the sandbox's Chrome.
  const browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(
    ([key, value]: string[]) => {
      localStorage.setItem(key!, value!);
      localStorage.setItem("natex.deviceId", "ui-check");
    },
    ["natex.session", JSON.stringify(stored)],
  );

  for (const route of ROUTES) await visit(context, route);
  await context.close();

  console.log("\n  — merchant portal, signed in as the seeded merchant —");
  const merchantSession = await signIn(process.env.UI_CHECK_MERCHANT_PHONE ?? "+94775678901");
  const mctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await mctx.addInitScript(
    ([key, value]: string[]) => {
      localStorage.setItem(key!, value!);
      localStorage.setItem("natex.deviceId", "ui-check-merchant");
    },
    [
      "natex.session",
      JSON.stringify({
        accessToken: merchantSession.accessToken,
        refreshToken: merchantSession.refreshToken,
        expiresAt: Date.now() + merchantSession.expiresIn * 1000,
        user: merchantSession.user,
      }),
    ],
  );
  for (const route of MERCHANT_ROUTES) await visit(mctx, route);
  await mctx.close();

  console.log("\n  — public, no session —");
  const publicCount = await checkPublic(browser);

  await browser.close();

  const total = ROUTES.length + MERCHANT_ROUTES.length + publicCount;
  console.log("");
  if (failures.length === 0) {
    console.log(`ALL GREEN — ${total} routes rendered clean.`);
    return;
  }
  console.log(`${failures.length} problem(s) across ${total} routes.`);
  process.exit(1);
}

void main();
