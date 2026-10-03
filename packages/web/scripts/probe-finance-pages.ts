import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { like } from "drizzle-orm";
import type { AppRouterClient } from "../src/api";
import { finishMfa } from "./lib/mfa";
const BASE = "http://localhost:4200";
const { db } = await import("../src/api/database");
const { hardenScriptReads } = await import("./lib/db-retry");
hardenScriptReads(db);
const { rateLimit } = await import("../src/api/database/schema/shared");
let pass = 0; const fails: string[] = [];
const check = (c: boolean, l: string, d = "") => { if (c) { pass++; console.log("  PASS", l, d); } else { fails.push(l); console.log("  FAIL", l, d); } };
function clientFor(token?: string): AppRouterClient {
  return createORPCClient(new RPCLink({ url: `${BASE}/api/rpc`, headers: () => (token ? { authorization: `Bearer ${token}` } : {}) }));
}
const anon = clientFor();
async function login(phone: string) {
  await db.delete(rateLimit).where(like(rateLimit.bucket, "%identity.%Otp"));
  const c = await anon.identity.requestOtp({ phone });
  return finishMfa(BASE, await anon.identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode!, deviceId: null }));
}
const status = async (fn: () => Promise<unknown>) => { try { await fn(); return 200; } catch (e) { return (e as { data?: { status?: number } }).data?.status ?? -1; } };
const fin = clientFor((await login("+94774567890")).accessToken);
const mer = clientFor((await login("+94775678901")).accessToken);
const ops = clientFor((await login("+94772345678")).accessToken);

type P = { rows: unknown[]; total: number; page: number; pageSize: number };
async function pages(label: string, fetch: (page: number, pageSize: number) => Promise<P>, arr?: () => Promise<unknown[]>) {
  const p1 = await fetch(1, 2);
  check(Array.isArray(p1.rows) && typeof p1.total === "number" && p1.page === 1 && p1.pageSize === 2, `${label} shape`, `total=${p1.total} rows=${p1.rows.length}`);
  check(p1.rows.length === Math.min(2, p1.total), `${label} page size honoured`);
  if (p1.total > 2) {
    const p2 = await fetch(2, 2);
    const ids1 = new Set((p1.rows as { id: string }[]).map((r) => r.id));
    check((p2.rows as { id: string }[]).every((r) => !ids1.has(r.id)), `${label} page 2 disjoint`);
  }
  const all = await fetch(1, 200);
  check(all.rows.length === Math.min(200, all.total), `${label} total consistent with rows`, `${all.rows.length}/${all.total}`);
  if (arr) { const a = await arr(); check(a.length === Math.min(all.total, a.length) && (all.total <= 200 ? a.length === all.total || a.length === 200 : true), `${label} matches array route`, `array=${a.length}`); }
}
await pages("settlementPage", (page, pageSize) => fin.finance.settlementPage({ page, pageSize }), () => fin.finance.settlements({ limit: 200 }));
await pages("holdPage", (page, pageSize) => fin.finance.holdPage({ page, pageSize }), () => fin.finance.listHolds({ limit: 200 }));
await pages("invoicePage", (page, pageSize) => fin.finance.invoicePage({ page, pageSize }), () => fin.finance.invoices({ limit: 200 }));
await pages("depositPage", (page, pageSize) => fin.cod.depositPage({ page, pageSize }), () => fin.cod.deposits({ limit: 200 }));
await pages("alertPage", (page, pageSize) => fin.cod.alertPage({ page, pageSize }), () => fin.cod.listAlerts({ limit: 200 }));

// filters
const sp = await fin.finance.settlementPage({ status: ["paid"], pageSize: 200 });
check(sp.rows.every((r) => r.status === "paid"), "settlement status filter", `${sp.total}`);
const any = (await fin.finance.settlementPage({ pageSize: 1 })).rows[0];
if (any) { const q = await fin.finance.settlementPage({ q: any.code }); check(q.rows.some((r) => r.id === any.id), "settlement q by code", any.code); }
const anyInv = (await fin.finance.invoicePage({ pageSize: 1 })).rows[0];
if (anyInv) { const q = await fin.finance.invoicePage({ q: anyInv.merchantName.slice(0, 5) }); check(q.rows.some((r) => r.id === anyInv.id), "invoice q by merchant name"); }
const hp = await fin.finance.holdPage({ status: ["open"], reason: ["dispute"], pageSize: 200 });
check(hp.rows.every((r) => r.status === "open" && r.reason === "dispute"), "hold status+reason filter", `${hp.total}`);
const ap = await fin.cod.alertPage({ status: ["open"], pageSize: 200 });
check(ap.rows.every((r) => r.status === "open"), "alert status filter", `${ap.total}`);

// merchant scoping
const ms = await mer.finance.settlementPage({ pageSize: 200 });
check(ms.rows.every((r) => r.merchantId === "mch_ceylon_threads"), "merchant sees own settlements only", `${ms.total}`);
const mi = await mer.finance.invoicePage({ pageSize: 200 });
check(mi.rows.every((r) => r.merchantId === "mch_ceylon_threads"), "merchant sees own invoices only", `${mi.total}`);
const mh = await mer.finance.holdPage({ pageSize: 200 });
check(mh.rows.every((r) => r.merchantId === "mch_ceylon_threads"), "merchant sees own holds only", `${mh.total}`);
check((await status(() => mer.finance.settlementPage({ merchantId: "mch_lanka_gadgets" }))) === 403, "merchant naming other merchant settlements → 403");
check((await status(() => mer.finance.invoicePage({ merchantId: "mch_lanka_gadgets" }))) === 403, "merchant naming other merchant invoices → 403");
check((await status(() => mer.finance.holdPage({ merchantId: "mch_lanka_gadgets" }))) === 403, "merchant naming other merchant holds → 403");
check((await status(() => mer.cod.depositPage({}))) === 403, "merchant depositPage → 403");
check((await status(() => mer.cod.alertPage({}))) === 403, "merchant alertPage → 403");
check((await status(() => ops.cod.depositPage({}))) === 200, "ops can read depositPage");
check((await status(() => anon.finance.settlementPage({}))) === 401, "anon → 401");
check((await status(() => fin.finance.settlementPage({ pageSize: 201 }))) === 400, "pageSize 201 → 400");
console.log(`\n${pass} pass, ${fails.length} fail`); if (fails.length) { console.log(fails); process.exit(1); }
process.exit(0);
