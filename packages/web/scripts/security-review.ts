import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { and, eq, gte, like, ne } from "drizzle-orm";
import type { AppRouterClient } from "../src/api";
import { finishMfa } from "./lib/mfa";

/**
 * M5 security review — live probes against a running dev server (PROJECT.md
 * §10 M5 "security review", §2 auth, §4 chain, §5 scoping, §9 PDPA).
 *
 *   1. Tokens: missing, garbage, alg:none, HS512 header, signed with the public
 *      dev fallback key, privilege-escalated body, expired, no exp
 *   2. Pending MFA: a half-signed-in ops token reaches the MFA routes only
 *   3. Role matrix: field roles refused every desk-only read and the money reads
 *      that used to leak bank details; desk roles refused admin-only routes
 *   4. Scoping: merchant ↔ merchant, branch ↔ branch, merchant ↔ finance records
 *   5. Rate limits: OTP per IP (X-Forwarded-For rotation does not help), OTP per
 *      destination phone (IP rotation does not help), mfa.verify brute force,
 *      OTP verify attempt cap
 *   6. Idempotency: replay, payload mismatch, cross-user key reuse
 *   7. Suspended user: live access token and refresh token both dead
 *   8. Surface: security headers, readiness body, public tracking body, error
 *      bodies, SMS webhook secret
 *
 * The static half (every procedure's guard) is src/api/middleware/route-guards.test.ts.
 * Restores everything it touches. Needs a server on :4200 and a seeded DB.
 *
 *   bun --env-file=../../.env scripts/security-review.ts
 */

const BASE = process.env.SMOKE_BASE ?? "http://localhost:4200";
const RUN = Date.now().toString(36).toUpperCase();

const PHONE = {
  admin: "+94773456789",
  finance: "+94774567890",
  merchant: "+94775678901",
  riderCmb: "+94771234567",
  opsCmb: "+94772345678",
  transportCmb: "+94776789012",
  riderKdy: "+94778901234",
  opsKdy: "+94779012345",
};

const { db } = await import("../src/api/database");
const { hardenScriptReads, cleanupWithRetry } = await import("./lib/db-retry");
hardenScriptReads(db);
const { rateLimit, auditLog } = await import("../src/api/database/schema/shared");
const identitySchema = await import("../src/api/database/schema/identity");
const { parcel } = await import("../src/api/database/schema/parcels");

let pass = 0;
const failures: string[] = [];
function check(cond: boolean, label: string, detail = ""): void {
  if (cond) pass += 1;
  else failures.push(`${label}${detail ? `: ${detail}` : ""}`);
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
function errOf(err: unknown) {
  const e = err as { message?: string; data?: Record<string, unknown> & { status?: number; type?: string } };
  return { status: e?.data?.status, type: e?.data?.type ?? "", message: e?.message ?? String(err), data: e?.data ?? {} };
}
async function expectFail(label: string, status: number | number[], fn: () => Promise<unknown>, typeEndsWith?: string) {
  const ok = Array.isArray(status) ? status : [status];
  try {
    await fn();
    check(false, label, "expected a rejection, got success");
  } catch (err) {
    const e = errOf(err);
    const typeOk = !typeEndsWith || e.type.endsWith(typeEndsWith);
    check(ok.includes(e.status ?? -1) && typeOk, label, `${e.status} ${e.type.split("/").at(-1)}`);
  }
}

let keySeq = 0;
const key = (l: string) => `secrev-${RUN}-${l}-${(keySeq += 1)}`;
function clientFor(token?: string, extra: Record<string, string> = {}, idemKey?: () => string): AppRouterClient {
  return createORPCClient(
    new RPCLink({
      url: `${BASE}/api/rpc`,
      headers: () => ({
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "idempotency-key": idemKey ? idemKey() : key("w"),
        ...extra,
      }),
    }),
  );
}
const anon = clientFor();

async function clearBuckets() {
  await cleanupWithRetry(async () => {
    await db.delete(rateLimit).where(like(rateLimit.bucket, "%identity.%Otp"));
    await db.delete(rateLimit).where(like(rateLimit.bucket, "%mfa.%"));
  });
}
async function otpOnly(phone: string, deviceId: string | null = null) {
  await clearBuckets();
  const c = await anon.identity.requestOtp({ phone });
  if (!c.devCode) throw new Error(`no dev OTP for ${phone}`);
  return anon.identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode, deviceId });
}
async function login(phone: string, deviceId: string | null = null) {
  return finishMfa(BASE, await otpOnly(phone, deviceId));
}

// ── JWT crafting (the script holds the real secret, as an insider test would)
const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64s = (s: string) => b64url(enc.encode(s));
const fromB64 = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
async function hs256(secret: string, data: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data))));
}
async function signWith(secret: string, header: object, claims: object) {
  const h = b64s(JSON.stringify(header));
  const b = b64s(JSON.stringify(claims));
  return `${h}.${b}.${await hs256(secret, `${h}.${b}`)}`;
}

const restore: Array<() => Promise<unknown>> = [];

try {
  console.log("\nSigning in the cast");
  const admin = await login(PHONE.admin);
  const finance = await login(PHONE.finance);
  const merchant = await login(PHONE.merchant);
  const rider = await login(PHONE.riderCmb, `secrev-${RUN}-rider`);
  const transport = await login(PHONE.transportCmb);
  const opsCmb = await login(PHONE.opsCmb);
  const opsKdy = await login(PHONE.opsKdy);
  const adminC = clientFor(admin.accessToken);
  const financeC = clientFor(finance.accessToken);
  const merchantC = clientFor(merchant.accessToken);
  const riderC = clientFor(rider.accessToken);
  const transportC = clientFor(transport.accessToken);
  const opsCmbC = clientFor(opsCmb.accessToken);
  const opsKdyC = clientFor(opsKdy.accessToken);
  check(true, "seven roles signed in (MFA roles through TOTP)");

  // ─────────────────────────────────────────────── 1. tokens
  console.log("\n1. Tokens");
  const secret = process.env.JWT_ACCESS_SECRET ?? "";
  check(secret.length >= 32, "JWT_ACCESS_SECRET is set and long", `${secret.length} chars`);
  const [h, b] = rider.accessToken.split(".");
  const claims = JSON.parse(fromB64(b)) as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);

  await expectFail("no bearer token → 401", 401, () => anon.identity.me());
  await expectFail("garbage token → 401", 401, () => clientFor("not.a.jwt").identity.me());
  await expectFail("two-part token → 401", 401, () => clientFor(`${h}.${b}`).identity.me());
  await expectFail(
    "alg:none with the real body and no signature → 401",
    401,
    () => clientFor(`${b64s(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b}.`).identity.me(),
  );
  await expectFail(
    "alg:HS512 header over a valid HS256 signature → 401 (algorithm pinned)",
    401,
    async () => {
      const hh = b64s(JSON.stringify({ alg: "HS512", typ: "JWT" }));
      return clientFor(`${hh}.${b}.${await hs256(secret, `${hh}.${b}`)}`).identity.me();
    },
  );
  await expectFail(
    "signed with the public dev fallback key → 401",
    401,
    async () => clientFor(await signWith("dev-insecure-JWT_ACCESS_SECRET", { alg: "HS256", typ: "JWT" }, claims)).identity.me(),
  );
  await expectFail(
    "rider body edited to role=admin, original signature kept → 401",
    401,
    () => clientFor(`${h}.${b64s(JSON.stringify({ ...claims, role: "admin" }))}.${rider.accessToken.split(".")[2]}`).identity.me(),
  );
  await expectFail(
    "correctly signed but expired → 401",
    401,
    async () => clientFor(await signWith(secret, { alg: "HS256", typ: "JWT" }, { ...claims, iat: now - 3600, exp: now - 60 })).identity.me(),
  );
  await expectFail(
    "correctly signed with no exp → 401 (no immortal tokens)",
    401,
    async () => {
      const { exp: _drop, ...rest } = claims;
      return clientFor(await signWith(secret, { alg: "HS256", typ: "JWT" }, rest)).identity.me();
    },
  );
  {
    // Even a correctly signed token claiming admin is re-read against the user row.
    const forged = await signWith(secret, { alg: "HS256", typ: "JWT" }, { ...claims, role: "admin", iat: now, exp: now + 600 });
    const me = await clientFor(forged).identity.me();
    check(me.role === "rider", "a validly signed token claiming role=admin still acts as the stored role", me.role);
    await expectFail("…and is refused the admin audit log", 403, () => clientFor(forged).audit.list({}));
  }

  // ─────────────────────────────────────────────── 2. pending MFA
  console.log("\n2. Pending MFA");
  const pending = await otpOnly(PHONE.opsCmb);
  check(pending.mfa.state === "challenge", "ops after phone OTP alone is PENDING", pending.mfa.state);
  const pendC = clientFor(pending.accessToken);
  const st = await pendC.mfa.status();
  check(Boolean(st), "pending token may read mfa.status");
  await expectFail("pending token refused identity.me", 403, () => pendC.identity.me(), "mfa-required");
  await expectFail("pending token refused parcels.list", 403, () => pendC.parcels.list({}), "mfa-required");
  await expectFail("pending token refused cod.reconciliation", 403, () => pendC.cod.reconciliation({}), "mfa-required");
  await expectFail(
    "pending token refused a write (identity.revokeMySession)",
    403,
    () => pendC.identity.revokeMySession({ sessionId: "rt_nope" }),
    "mfa-required",
  );
  await expectFail("pending refresh token is never rotated", 401, () => anon.identity.refresh({ refreshToken: pending.refreshToken }));

  // ─────────────────────────────────────────────── 3. role matrix
  console.log("\n3. Role matrix");
  const desk: Array<[string, (c: AppRouterClient) => Promise<unknown>]> = [
    ["identity.listUsers", (c) => c.identity.listUsers({})],
    ["rateCards.list", (c) => c.rateCards.list({})],
    ["rateCards.quote", (c) => c.rateCards.quote({ rateCardId: "rtc_pilot_placeholder", weightGrams: 500, destZoneId: "x" } as never)],
    ["settings.list", (c) => c.settings.list({})],
    ["notifications.templates", (c) => c.notifications.templates({})],
    ["notifications.messages", (c) => c.notifications.messages({})],
    ["finance.payoutDetails (full bank account)", (c) => c.finance.payoutDetails({ merchantId: "mch_ceylon_threads" })],
    ["finance.statement", (c) => c.finance.statement({ merchantId: "mch_ceylon_threads" } as never)],
    ["finance.settlementPage", (c) => c.finance.settlementPage({} as never)],
    ["finance.arAgeing", (c) => c.finance.arAgeing({} as never)],
    ["cod.reconciliation", (c) => c.cod.reconciliation({})],
    ["cod.listAlerts", (c) => c.cod.listAlerts({})],
    ["cod.acknowledgeAlert", (c) => c.cod.acknowledgeAlert({ alertId: "cal_nope" } as never)],
    ["cod.resolveAlert", (c) => c.cod.resolveAlert({ alertId: "cal_nope", resolution: "probe" } as never)],
  ];
  for (const [who, c] of [["rider", riderC], ["transport", transportC]] as const) {
    for (const [name, call] of desk) await expectFail(`${who} refused ${name}`, 403, () => call(c), "forbidden");
  }
  for (const [name, call] of desk.slice(0, 6)) await expectFail(`merchant refused ${name}`, 403, () => call(merchantC), "forbidden");
  const adminOnly: Array<[string, (c: AppRouterClient) => Promise<unknown>]> = [
    ["audit.list", (c) => c.audit.list({})],
    ["monitor.health", (c) => c.monitor.health({} as never)],
    ["settings.set", (c) => c.settings.set({ key: "ndr_sla_hours", value: 24, reason: "security review" } as never)],
    ["identity.setUserStatus", (c) => c.identity.setUserStatus({ userId: "usr_admin_rajitha", status: "suspended" })],
    ["rateCards.publish", (c) => c.rateCards.publish({ rateCardId: "rtc_pilot_placeholder", reason: "probe" } as never)],
  ];
  for (const [who, c] of [["ops", opsCmbC], ["finance", financeC]] as const) {
    for (const [name, call] of adminOnly) await expectFail(`${who} refused ${name}`, 403, () => call(c), "forbidden");
  }
  await expectFail("ops refused finance.setPayoutDetails (ops never moves money)", 403, () =>
    opsCmbC.finance.setPayoutDetails({ merchantId: "mch_ceylon_threads", beneficiaryName: "x", bankName: "x", branchName: "x", accountNumber: "1" }),
  );
  await expectFail("merchant refused finance.setPayoutDetails (cannot redirect its own payouts)", 403, () =>
    merchantC.finance.setPayoutDetails({ merchantId: "mch_ceylon_threads", beneficiaryName: "x", bankName: "x", branchName: "x", accountNumber: "1" }),
  );
  // The positive side: the routes still work for the people who need them.
  const ownPayout = await merchantC.finance.payoutDetails({});
  check(true, "merchant still reads its own payout details", ownPayout ? "row" : "none on file");
  check((await opsCmbC.identity.listUsers({})) !== undefined, "ops still lists users");
  check((await financeC.cod.listAlerts({})) !== undefined, "finance still reads the alert worklist");
  check((await riderC.identity.listBranches({})) !== undefined, "rider still lists branches (needed by the app)");

  // ─────────────────────────────────────────────── 4. scoping
  console.log("\n4. Scoping");
  const [otherMerchantParcel] = await db.select().from(parcel).where(ne(parcel.merchantId, "mch_ceylon_threads")).limit(1);
  const [cmbParcel] = await db.select().from(parcel).where(eq(parcel.branchId, "brn_cmb_central")).limit(1);
  if (otherMerchantParcel) {
    await expectFail("merchant cannot open another merchant's parcel", [403, 404], () =>
      merchantC.parcels.get({ awbOrId: otherMerchantParcel.awb }),
    );
  } else check(false, "fixture: a parcel owned by another merchant exists");
  if (cmbParcel) {
    await expectFail("Kandy ops cannot open a Colombo parcel", [403, 404], () => opsKdyC.parcels.get({ awbOrId: cmbParcel.awb }));
    const seen = await opsCmbC.parcels.get({ awbOrId: cmbParcel.awb });
    check(seen.parcel.id === cmbParcel.id, "Colombo ops can open it");
  } else check(false, "fixture: a Colombo parcel exists");
  await expectFail("merchant cannot read another merchant's payout details", 403, () =>
    merchantC.finance.payoutDetails({ merchantId: "mch_lanka_gadgets" }),
  );
  await expectFail("merchant cannot read another merchant's statement", 403, () =>
    merchantC.finance.statement({ merchantId: "mch_lanka_gadgets" } as never),
  );
  const mList = await merchantC.parcels.list({});
  const rows = (mList as { rows?: Array<{ merchantId: string }> }).rows ?? (mList as unknown as Array<{ merchantId: string }>);
  check(Array.isArray(rows) && rows.every((r) => r.merchantId === "mch_ceylon_threads"), "merchant parcel list holds only its own rows", `${rows.length} rows`);

  // ─────────────────────────────────────────────── 5. rate limits
  console.log("\n5. Rate limits");
  await clearBuckets();
  {
    // X-Forwarded-For rotation: the leftmost entry is attacker-typed; the server
    // uses the rightmost (the hop the nearest proxy appended) when no edge header.
    let n429 = -1;
    for (let i = 0; i < 8; i += 1) {
      try {
        await clientFor(undefined, { "x-forwarded-for": `10.9.${i}.${i}, 203.0.113.7` }).identity.requestOtp({ phone: PHONE.riderKdy });
      } catch (err) {
        if (errOf(err).status === 429) { n429 = i; break; }
        throw err;
      }
    }
    check(n429 === 5, "OTP request: rotating the client-typed X-Forwarded-For does not reset the IP bucket", `429 at request ${n429 + 1}`);
  }
  await clearBuckets();
  {
    // IP rotation (simulated through the edge header): the per-number bucket holds.
    let n429 = -1;
    for (let i = 0; i < 8; i += 1) {
      try {
        await clientFor(undefined, { "cf-connecting-ip": `198.51.100.${i + 10}` }).identity.requestOtp({ phone: i % 2 ? "0778901234" : PHONE.riderKdy });
      } catch (err) {
        if (errOf(err).status === 429) { n429 = i; break; }
        throw err;
      }
    }
    check(n429 === 5, "OTP request: a fresh IP per request still hits the per-phone bucket (spellings shared)", `429 at request ${n429 + 1}`);
  }
  await clearBuckets();
  {
    const c = await anon.identity.requestOtp({ phone: PHONE.riderKdy });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      try {
        await anon.identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode === "000000" ? "111111" : "000000" });
      } catch (err) {
        statuses.push(errOf(err).status ?? 0);
      }
    }
    // The right code is now refused too: the challenge is burned.
    let burned = false;
    try {
      await anon.identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode! });
    } catch (err) {
      burned = errOf(err).status === 403;
    }
    check(statuses.length === 6 && burned, "OTP verify: wrong codes burn the challenge; the right code is refused after", statuses.join(","));
  }
  await clearBuckets();
  {
    const p = await otpOnly(PHONE.opsKdy);
    const pc = clientFor(p.accessToken);
    let n429 = -1;
    for (let i = 0; i < 10; i += 1) {
      try {
        await pc.mfa.verify({ code: "000000" });
      } catch (err) {
        if (errOf(err).status === 429) { n429 = i; break; }
      }
    }
    check(n429 >= 0 && n429 <= 5, "mfa.verify: brute force is cut off by the 5-token bucket", `429 at attempt ${n429 + 1}`);
  }
  await clearBuckets();

  // ─────────────────────────────────────────────── 6. idempotency
  console.log("\n6. Idempotency");
  {
    const [cfg] = await financeC.cod.listConfig({});
    const input = { key: cfg.key, value: cfg.value, reason: `security review ${RUN} (same value)` } as never;
    const k = key("idem");
    const since = new Date(Date.now() - 1000);
    const countRows = async () =>
      (await db.select().from(auditLog).where(and(eq(auditLog.action, "cod.config_set"), gte(auditLog.ts, since)))).length;
    const before = await countRows();
    const first = await clientFor(finance.accessToken, {}, () => k).cod.setConfig(input);
    const second = await clientFor(finance.accessToken, {}, () => k).cod.setConfig(input);
    const after = await countRows();
    check(JSON.stringify(first) === JSON.stringify(second), "same key + same body → stored response replayed");
    check(after - before === 1, "…and the handler ran once (one audit row)", `${after - before}`);
    await expectFail("same key + different body → 409", 409, () =>
      clientFor(finance.accessToken, {}, () => k).cod.setConfig({ ...(input as object), reason: `different ${RUN}` } as never),
      "idempotency-key-reused",
    );
    await expectFail("same key + same body from another user → 409, never their response", 409, () =>
      clientFor(admin.accessToken, {}, () => k).cod.setConfig(input),
      "idempotency-key-reused",
    );
  }

  // ─────────────────────────────────────────────── 7. suspended user
  console.log("\n7. Suspended user");
  {
    const victim = await login(PHONE.riderKdy, `secrev-${RUN}-kdy`);
    const vc = clientFor(victim.accessToken);
    check((await vc.identity.me()).userId === victim.user.id, "Kandy rider token works before suspension");
    restore.push(() => adminC.identity.setUserStatus({ userId: victim.user.id, status: "active" }));
    await adminC.identity.setUserStatus({ userId: victim.user.id, status: "suspended" });
    await expectFail("a suspended user's unexpired access token is refused", 403, () => vc.identity.me());
    await expectFail("…and their refresh token is dead", 401, () => anon.identity.refresh({ refreshToken: victim.refreshToken }));
    await expectFail("…and they cannot request a new OTP", 403, () => anon.identity.requestOtp({ phone: PHONE.riderKdy }));
    await adminC.identity.setUserStatus({ userId: victim.user.id, status: "active" });
    restore.pop();
    const [u] = await db.select().from(identitySchema.user).where(eq(identitySchema.user.id, victim.user.id));
    check(u.status === "active", "rider re-activated");
  }

  // ─────────────────────────────────────────────── 8. surface
  console.log("\n8. Surface");
  {
    const r = await fetch(`${BASE}/api/rpc/ping`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const hd = (n: string) => r.headers.get(n) ?? "";
    check(hd("x-content-type-options") === "nosniff", "API: X-Content-Type-Options nosniff");
    check(hd("x-frame-options") === "DENY", "API: X-Frame-Options DENY");
    check(hd("content-security-policy").includes("frame-ancestors 'none'"), "API: CSP frame-ancestors none");
    check(hd("strict-transport-security").includes("max-age="), "API: HSTS");
    check(hd("cache-control").includes("no-store"), "API: Cache-Control no-store");
    check(hd("referrer-policy") === "no-referrer", "API: Referrer-Policy no-referrer");
  }
  {
    const r = await fetch(`${BASE}/api/health/ready`);
    const body = (await r.json()) as Record<string, unknown>;
    check(
      JSON.stringify(Object.keys(body).sort()) === JSON.stringify(["checkedAt", "db", "nightly", "status", "worker"]),
      "readiness body carries states only",
      Object.keys(body).join(","),
    );
    check(r.status === 200 && body.status === "ok", "readiness is green", `${r.status}`);
  }
  if (cmbParcel) {
    const t = await anon.parcels.track({ awb: cmbParcel.awb });
    const s = JSON.stringify(t);
    const leaks = [cmbParcel.consigneeName, cmbParcel.consigneePhone, cmbParcel.destAddress, cmbParcel.merchantId].filter(
      (v) => v && s.includes(String(v)),
    );
    check(leaks.length === 0, "public tracking exposes no consignee name, phone, address or merchant (§9 PDPA)", leaks.join(",") || "clean");
  }
  {
    const r = await fetch(`${BASE}/api/rpc/parcels/get`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opsCmb.accessToken}` },
      body: JSON.stringify({ json: { awbOrId: 1 } }),
    });
    const text = await r.text();
    check(r.status === 400 && !/\bat \/|node_modules|\.ts:\d+/.test(text), "a validation error carries no stack trace or file paths", `${r.status}`);
  }
  {
    const r = await fetch(`${BASE}/api/webhooks/sms/dlr`, { method: "POST", body: "id=1&status=delivered" });
    check(r.status === 401, "SMS delivery-receipt webhook refuses a request without the secret", `${r.status}`);
  }
} catch (err) {
  failures.push(`crashed: ${String((err as Error)?.stack ?? err).slice(0, 600)}`);
  console.error(err);
} finally {
  for (const undo of restore.reverse()) await undo().catch((e) => console.error("restore failed", e));
  await clearBuckets().catch(() => {});
}

console.log(`\n${pass} pass, ${failures.length} fail`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
