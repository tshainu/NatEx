import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { and, eq, inArray, like } from "drizzle-orm";
import type { AppRouterClient } from "../src/api";
import { finishMfa } from "./lib/mfa";

/**
 * End-to-end exercise of the Milestone 5 admin API against a running dev server
 * (PROJECT.md §10 M5, §2 TOTP MFA + session policy, §11 problem+json).
 *
 *   1. MFA: pending sessions, the seeded challenge, replay refusal, a real
 *      enrolment from scratch (secret → code → recovery codes), recovery-code
 *      single use, regeneration, admin reset, role gating
 *   2. Session policy: idle timeout (portal only, riders exempt), absolute
 *      lifetime, MFA level + family start carried through rotation
 *   3. Settings: read/write roles, range and reason validation
 *   4. Users and branches: self-lockout, session revocation on a role/branch
 *      change, own sessions
 *   5. Rate cards: create → draft → publish → new draft → supersede → frozen
 *      versions → assign → quote (PLACEHOLDER numbers, §15 q3)
 *   6. Merchant onboarding with a portal user, phone clash first
 *   7. Template editor: preview and refusal of unknown placeholders
 *   8. Audit viewer: filters, admin only, redaction of MFA material
 *   9. Job monitor and zone edit
 *
 * Owns its fixtures (prefix `SMK5`) and removes them at the end. Settings it
 * changes are restored. Requires a server on :4200 and a seeded database.
 *
 *   bun --env-file=../../.env scripts/smoke-m5.ts
 */

const BASE = process.env.SMOKE_BASE ?? "http://localhost:4200";
const RUN = Date.now().toString(36).toUpperCase();
const BRANCH = "brn_cmb_central";
const ADMIN_ID = "usr_admin_rajitha";

const { db } = await import("../src/api/database");
const { hardenScriptReads, cleanupWithRetry } = await import("./lib/db-retry");
hardenScriptReads(db);
const { rateLimit } = await import("../src/api/database/schema/shared");
const identity = await import("../src/api/database/schema/identity");
const merchants = await import("../src/api/database/schema/merchants");
const { totpAt, stepAt } = await import("../src/api/shared/totp");

let pass = 0;
const failures: string[] = [];
function check(cond: boolean, label: string, detail = ""): void {
  if (cond) pass += 1;
  else failures.push(`${label}${detail ? `: ${detail}` : ""}`);
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
function errOf(err: unknown): { status?: number; type?: string; message: string; data: Record<string, unknown> } {
  const e = err as { message?: string; data?: Record<string, unknown> & { status?: number; type?: string } };
  return { status: e?.data?.status, type: e?.data?.type, message: e?.message ?? String(err), data: e?.data ?? {} };
}
async function expectFail(label: string, status: number, fn: () => Promise<unknown>, typeEndsWith?: string) {
  try {
    await fn();
    check(false, label, "expected a rejection, got success");
  } catch (err) {
    const e = errOf(err);
    const typeOk = !typeEndsWith || (e.type ?? "").endsWith(typeEndsWith);
    check(e.status === status && typeOk, label, `${e.status} ${e.type ?? ""} ${e.message}`.trim());
  }
}

let keySeq = 0;
const key = (label: string) => `smoke-m5-${RUN}-${label}-${(keySeq += 1)}`;

function clientFor(token?: string): AppRouterClient {
  return createORPCClient(
    new RPCLink({
      url: `${BASE}/api/rpc`,
      headers: () => ({
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "idempotency-key": key("w"),
      }),
    }),
  );
}
const anon = clientFor();

async function clearOtpBuckets() {
  // The script's own DB socket idles between API calls and Turso sometimes
  // resets it (ECONNRESET). These deletes are idempotent, so retry once.
  for (let attempt = 0; ; attempt++) {
    try {
      await db.delete(rateLimit).where(like(rateLimit.bucket, "%identity.%Otp"));
      await db.delete(rateLimit).where(like(rateLimit.bucket, "%mfa.%"));
      return;
    } catch (err) {
      if (attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
/** Phone OTP only — returns whatever verifyOtp returns (pending for MFA roles). */
async function otpOnly(phone: string, deviceId: string | null = null) {
  await clearOtpBuckets();
  const c = await anon.identity.requestOtp({ phone });
  if (!c.devCode) throw new Error(`no dev OTP for ${phone}`);
  return anon.identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode, deviceId });
}
async function login(phone: string, deviceId: string | null = null) {
  return finishMfa(BASE, await otpOnly(phone, deviceId));
}
/** A TOTP code for a step the factor has not used yet. */
const codeAt = (secret: string, offset = 0) => totpAt(secret, stepAt(Date.now()) + offset);

const created = { users: [] as string[], merchants: [] as string[], rateCards: [] as string[] };

console.log(`\nNatEx M5 smoke (${RUN}) → ${BASE}\n`);

// ── 1. MFA ───────────────────────────────────────────────────────────────────
console.log("1. MFA (§2 TOTP for ops/admin/finance)");
const pendingA = await otpOnly("+94773456789");
check(pendingA.mfa.state === "challenge", "admin sign-in after phone OTP is PENDING (challenge)", pendingA.mfa.state);
check(typeof pendingA.mfa.devCode === "string" && /^\d{6}$/.test(pendingA.mfa.devCode), "a seeded factor carries a dev TOTP code outside production");
await expectFail("a pending token is refused on a normal route (403 mfa-required)", 403, () => clientFor(pendingA.accessToken).identity.listUsers(), "mfa-required");
await expectFail("a pending refresh token is never rotated", 401, () => anon.identity.refresh({ refreshToken: pendingA.refreshToken }));
const pendingA2 = await otpOnly("+94773456789");
check(pendingA2.mfa.devCode === pendingA.mfa.devCode, "two pending sign-ins in one step are offered the same unused code");
await expectFail("a wrong authenticator code is refused (400)", 400, () =>
  clientFor(pendingA2.accessToken).mfa.verify({ code: pendingA.mfa.devCode === "000000" ? "111111" : "000000" }),
);
const verifiedA = await clientFor(pendingA2.accessToken).mfa.verify({ code: pendingA.mfa.devCode! });
check(verifiedA.method === "totp" && verifiedA.session.mfa.state === "verified", "the code completes sign-in: full session, level verified");
await expectFail("the same code cannot be used twice (RFC 6238 §5.2 replay)", 400, () =>
  clientFor(pendingA.accessToken).mfa.verify({ code: pendingA.mfa.devCode! }),
);
const admin = clientFor(verifiedA.session.accessToken);
check((await admin.identity.listUsers()).length > 0, "the verified admin session works on admin routes");
await expectFail("verify on an already-verified session is refused (409)", 409, () => admin.mfa.verify({ code: "123456" }));

const rider = await login("+94771234567");
check(rider.mfa.state === "none", "a rider's sign-in needs no second factor (§2 scopes MFA to ops/admin/finance)");
const merchantS = await login("+94775678901");
check(merchantS.mfa.state === "none", "a merchant's sign-in needs no second factor");
await expectFail("a rider cannot enrol an authenticator (403)", 403, () => clientFor(rider.accessToken).mfa.enrolStart());

const opsS = await login("+94772345678");
const ops = clientFor(opsS.accessToken);
check(opsS.mfa.state === "verified", "the regression helper signs seeded ops in through the challenge");
await expectFail("ops cannot list MFA factors (admin only)", 403, () => ops.mfa.factors());

// A brand-new ops user enrols from nothing.
const phoneNew = `+9477${String(Date.now()).slice(-7)}`;
const newOps = await admin.identity.createUser({ name: `SMK5 Ops ${RUN}`, phone: phoneNew, role: "ops", branchId: BRANCH });
created.users.push(newOps.id);
const pendingN = await otpOnly(phoneNew, `smk5-${RUN}`);
check(pendingN.mfa.state === "enrol" && !pendingN.mfa.devCode, "a new ops user must ENROL, and no dev code is offered for a real factor");
const pn = clientFor(pendingN.accessToken);
await expectFail("an enrol-pending token cannot reach the ops board", 403, () => pn.identity.listUsers(), "mfa-required");
const st0 = await pn.mfa.status();
check(st0.required && !st0.enrolled && st0.sessionLevel === "enrol", "mfa.status reports required, not enrolled, session level enrol");
await expectFail("verify is refused on an enrol-pending session (409)", 409, () => pn.mfa.verify({ code: "123456" }));
const enrol = await pn.mfa.enrolStart();
check(decodeURIComponent(enrol.otpauthUri).startsWith("otpauth://totp/NatEx:") && enrol.otpauthUri.includes(`secret=${enrol.secret}`), "enrolStart returns an otpauth:// URI with the secret");
await expectFail("a wrong first code does not confirm the factor", 400, () => pn.mfa.enrolConfirm({ code: "000000" }));
const confirm = await pn.mfa.enrolConfirm({ code: await codeAt(enrol.secret) });
check(confirm.recoveryCodes.length === 10 && confirm.session?.mfa.state === "verified", "confirming returns 10 recovery codes once, and the full session");
check(new Set(confirm.recoveryCodes).size === 10, "the recovery codes are distinct");
const newOpsApi = clientFor(confirm.session!.accessToken);
check(Array.isArray(await newOpsApi.identity.listUsers()), "the freshly enrolled ops user's session works");
await expectFail("a confirmed factor cannot be re-enrolled over (409)", 409, () => newOpsApi.mfa.enrolStart());
const st1 = await newOpsApi.mfa.status();
check(st1.enrolled && st1.recoveryCodesRemaining === 10 && !st1.seeded, "status: enrolled, 10 recovery codes, not seeded");

const pendingN2 = await otpOnly(phoneNew, `smk5-${RUN}`);
check(pendingN2.mfa.state === "challenge", "the next sign-in is a challenge");
const viaRecovery = await clientFor(pendingN2.accessToken).mfa.verify({ code: confirm.recoveryCodes[0].toLowerCase() });
check(viaRecovery.method === "recovery" && viaRecovery.recoveryCodesRemaining === 9, "a recovery code (any case) signs in; 9 remain");
const pendingN3 = await otpOnly(phoneNew, `smk5-${RUN}`);
await expectFail("the same recovery code is single-use", 400, () => clientFor(pendingN3.accessToken).mfa.verify({ code: confirm.recoveryCodes[0] }));
const newOps2 = clientFor(viaRecovery.session.accessToken);
const regen = await newOps2.mfa.regenerateRecoveryCodes({ code: await codeAt(enrol.secret, 1) });
check(regen.recoveryCodes.length === 10 && !regen.recoveryCodes.includes(confirm.recoveryCodes[1]), "regenerating needs a live code and issues a new set");
await expectFail("the old set stops working after regeneration", 400, () => clientFor(pendingN3.accessToken).mfa.verify({ code: confirm.recoveryCodes[1] }));

await expectFail("an admin cannot reset their own authenticator (409)", 409, () => admin.mfa.reset({ userId: ADMIN_ID, reason: "smoke self reset" }));
await expectFail("ops cannot reset an authenticator", 403, () => ops.mfa.reset({ userId: newOps.id, reason: "smoke reset by ops" }));
const reset = await admin.mfa.reset({ userId: newOps.id, reason: "smoke: lost phone" });
check(reset.hadFactor && reset.sessionsRevoked, "admin reset removes the factor and revokes sessions");
await expectFail("the reset user's refresh token is dead", 401, () => anon.identity.refresh({ refreshToken: viaRecovery.session.refreshToken }));
check((await otpOnly(phoneNew, `smk5-${RUN}`)).mfa.state === "enrol", "after a reset the user enrols again");
const factors = await admin.mfa.factors();
check(factors.some((f) => f.userId === ADMIN_ID && f.enrolled && f.seeded) && !factors.some((f) => f.userId === newOps.id), "mfa.factors lists the seeded admin and no longer the reset user");

// ── 2. Session policy ────────────────────────────────────────────────────────
console.log("\n2. Session policy");
const before = await admin.settings.list();
const idleBefore = before.find((s) => s.key === "session_idle_minutes")!.value;
const maxBefore = before.find((s) => s.key === "session_max_days")!.value;
const opsFresh = await login("+94772345678");
const rot1 = await anon.identity.refresh({ refreshToken: opsFresh.refreshToken });
check(rot1.mfa.state === "verified", "rotation carries the verified MFA level");
const opsRows = await db
  .select()
  .from(identity.refreshToken)
  .where(eq(identity.refreshToken.userId, "usr_ops_nimali"));
const rotated = opsRows.find((r) => r.replacedById && !r.revokedAt === false && r.replacedById !== null);
const successor = opsRows.sort((a, z) => z.createdAt.getTime() - a.createdAt.getTime())[0];
check(successor.mfaLevel === "verified" && successor.familyStartedAt !== null, "the successor row stores level verified and the family start", `${successor.mfaLevel}`);
void rotated;
// Idle: a portal token last refreshed 31 minutes ago, with the idle limit at 30.
await admin.settings.set({ key: "session_idle_minutes", value: 30, reason: "smoke: idle timeout check" });
await expectFail("the idle timeout cannot go below 30 minutes (access token is 15)", 400, () =>
  admin.settings.set({ key: "session_idle_minutes", value: 20, reason: "smoke: below minimum" }),
);
const ago = (ms: number) => new Date(Date.now() - ms);
const rot2 = await anon.identity.refresh({ refreshToken: rot1.refreshToken });
await db.update(identity.refreshToken).set({ createdAt: ago(31 * 60_000) }).where(eq(identity.refreshToken.userId, "usr_ops_nimali"));
await expectFail("a portal session idle past the limit is ended at refresh", 401, () => anon.identity.refresh({ refreshToken: rot2.refreshToken }));
const riderS = await login("+94771234567");
await db.update(identity.refreshToken).set({ createdAt: ago(31 * 60_000) }).where(eq(identity.refreshToken.userId, "usr_rider_pradeep"));
const riderRot = await anon.identity.refresh({ refreshToken: riderS.refreshToken });
check(riderRot.mfa.state === "none", "a rider idle past the limit still refreshes (offline-first exemption, §7)");
// Absolute: a rider family that began 31 days ago, limit 30.
await db
  .update(identity.refreshToken)
  .set({ familyStartedAt: ago(31 * 86_400_000) })
  .where(and(eq(identity.refreshToken.userId, "usr_rider_pradeep")));
await expectFail("past the absolute lifetime every role signs in again, riders included", 401, () =>
  anon.identity.refresh({ refreshToken: riderRot.refreshToken }),
);
await admin.settings.set({ key: "session_idle_minutes", value: idleBefore, reason: "smoke: restore idle timeout" });
check((await admin.settings.list()).find((s) => s.key === "session_idle_minutes")!.value === idleBefore, `idle timeout restored to ${idleBefore}`);
check(maxBefore === 30 || maxBefore > 0, "absolute lifetime setting present", String(maxBefore));

// ── 3. Settings ──────────────────────────────────────────────────────────────
console.log("\n3. Settings (SLA & business rules)");
const opsList = await ops.settings.list();
check(opsList.some((s) => s.key === "ndr_sla_hours") && opsList.some((s) => s.key === "max_delivery_attempts" && !s.editable), "ops can read settings; max delivery attempts is shown read-only");
await expectFail("ops cannot change a setting", 403, () => ops.settings.set({ key: "ndr_sla_hours", value: 36, reason: "ops tries" }));
await expectFail("out-of-range value refused", 400, () => admin.settings.set({ key: "ndr_sla_hours", value: 500, reason: "smoke out of range" }));
await expectFail("a boolean setting accepts only 0/1", 400, () => admin.settings.set({ key: "mfa_enforced", value: 2, reason: "smoke bad flag" }));
await expectFail("a reason is mandatory (≥5 chars)", 400, () => admin.settings.set({ key: "ndr_sla_hours", value: 36, reason: "no" }));
const slaBefore = opsList.find((s) => s.key === "ndr_sla_hours")!.value;
const setRes = await admin.settings.set({ key: "ndr_sla_hours", value: 36, reason: "smoke: SLA change" });
check(setRes.before === slaBefore && setRes.after === 36, "admin changes the NDR SLA", `${setRes.before} → ${setRes.after}`);
const after = (await ops.settings.list()).find((s) => s.key === "ndr_sla_hours")!;
check(after.value === 36 && after.updatedByName === "Arjun Rajendran" && after.note === "smoke: SLA change", "the change is visible with who and why");
await admin.settings.set({ key: "ndr_sla_hours", value: slaBefore, reason: "smoke: restore SLA" });

// ── 4. Users & branches ─────────────────────────────────────────────────────
console.log("\n4. Users, branches, sessions");
await expectFail("an admin cannot demote themselves (409)", 409, () => admin.identity.updateUser({ userId: ADMIN_ID, role: "ops" }));
await expectFail("an admin cannot suspend themselves (409)", 409, () => admin.identity.setUserStatus({ userId: ADMIN_ID, status: "suspended" }));
await expectFail("ops cannot edit users", 403, () => ops.identity.updateUser({ userId: newOps.id, name: "Nope" }));
const fixtureMerchantUser = await admin.identity.createUser({
  name: `SMK5 Shop ${RUN}`,
  phone: `+9476${String(Date.now()).slice(-7)}`,
  role: "merchant",
  branchId: BRANCH,
  merchantId: "mch_ceylon_threads",
});
created.users.push(fixtureMerchantUser.id);
const fmS = await login(fixtureMerchantUser.phone, `smk5m-${RUN}`);
const fmSessions = await admin.identity.userSessions({ userId: fixtureMerchantUser.id });
check(fmSessions.length === 1 && fmSessions[0].deviceId === `smk5m-${RUN}`, "admin sees the user's live session with its device");
const renamed = await admin.identity.updateUser({ userId: fixtureMerchantUser.id, name: `SMK5 Shop renamed ${RUN}` });
check(!renamed.sessionsRevoked && renamed.after.name.includes("renamed"), "a rename keeps the user's sessions");
const moved = await admin.identity.updateUser({ userId: fixtureMerchantUser.id, branchId: "brn_kdy_hub" });
check(moved.sessionsRevoked, "a branch change revokes the user's sessions");
await expectFail("…and their refresh token is dead", 401, () => anon.identity.refresh({ refreshToken: fmS.refreshToken }));
await expectFail("a merchant user cannot lose its merchant", 400, () => admin.identity.updateUser({ userId: fixtureMerchantUser.id, merchantId: null }));
const fm2 = await login(fixtureMerchantUser.phone, `smk5m-${RUN}`);
const revoked = await admin.identity.revokeUserSessions({ userId: fixtureMerchantUser.id, reason: "smoke: revoke all" });
check(revoked.revoked === 1, "admin revokes all of a user's sessions", String(revoked.revoked));
await expectFail("…which kills the refresh token", 401, () => anon.identity.refresh({ refreshToken: fm2.refreshToken }));
const fm3 = await login(fixtureMerchantUser.phone, `smk5m-${RUN}`);
const mine = await clientFor(fm3.accessToken).identity.mySessions();
check(mine.length === 1, "a user lists their own sessions");
await clientFor(fm3.accessToken).identity.revokeMySession({ sessionId: mine[0].id });
await expectFail("revoking my own session ends it", 401, () => anon.identity.refresh({ refreshToken: fm3.refreshToken }));
await expectFail("a session id from another user is not found", 404, () => clientFor(merchantS.accessToken).identity.revokeMySession({ sessionId: mine[0].id }));
const branches = await admin.identity.listBranches();
const cmb = branches.find((b) => b.id === BRANCH)!;
const br = await admin.identity.updateBranch({ id: BRANCH, name: `${cmb.name} (smoke)` });
check(br.after.name.endsWith("(smoke)") && br.after.code === cmb.code, "admin renames a branch; the code is untouched");
await admin.identity.updateBranch({ id: BRANCH, name: cmb.name });
await expectFail("ops cannot edit a branch", 403, () => ops.identity.updateBranch({ id: BRANCH, name: "Ops was here" }));

// ── 5. Rate cards ────────────────────────────────────────────────────────────
console.log("\n5. Rate cards (engine real, numbers PLACEHOLDER — §15 q3)");
const cards = await ops.rateCards.list();
const pilot = cards.find((c) => c.code === "PILOT-PLACEHOLDER");
check(!!pilot && pilot.placeholder && !!pilot.activeVersion, "the seeded pilot card exists, flagged placeholder, with an active version");
await expectFail("ops cannot create a rate card", 403, () => ops.rateCards.create({ code: `SMK5-${RUN}`.slice(0, 24), name: "Ops card" }));
const card = await admin.rateCards.create({ code: `SMK5-${RUN}`.slice(0, 24), name: `Smoke card ${RUN}` });
created.rateCards.push(card.card.id);
check(card.card.placeholder === true, "a new card defaults to placeholder");
await expectFail("an empty draft cannot be published", 400, () => admin.rateCards.publish({ versionId: card.versionId, reason: "smoke publish empty" }));
const doc = {
  volumetricDivisor: 5000,
  roundingGrams: 500,
  note: "smoke",
  bands: [
    { band: "local", label: "Local", extraPerKgCents: 10_000 },
    { band: "outstation", label: "Outstation", extraPerKgCents: 15_000 },
  ],
  slabs: [
    { band: "local", maxGrams: 1000, priceCents: 30_000 },
    { band: "local", maxGrams: 2000, priceCents: 40_000 },
    { band: "outstation", maxGrams: 1000, priceCents: 45_000 },
  ],
  surcharges: [{ code: "fragile", label: "Fragile", kind: "flat" as const, amount: 5_000, mode: "on_request" as const }],
};
const saved = await admin.rateCards.saveDraft({ versionId: card.versionId, ...doc });
check(saved.problems.length === 0, "a complete draft saves with no problems", saved.problems.join("; "));
const q0 = await ops.rateCards.quote({ versionId: card.versionId, band: "local", weightGrams: 800, requested: [] });
check(q0.totalCents === 30_000 && q0.version.status === "draft", "a draft can be previewed: 800 g local = Rs. 300.00", String(q0.totalCents));
const pub1 = await admin.rateCards.publish({ versionId: card.versionId, reason: "smoke publish v1" });
check(pub1.version === 1 && pub1.superseded === null, "v1 published");
// 2.6 kg local, rounded to 3000 g: top slab 2000 g = 40000 + 1 kg × 10000 = 50000; fragile +5000.
const q1 = await ops.rateCards.quote({ versionId: card.versionId, band: "local", weightGrams: 2600, requested: ["fragile"] });
check(q1.roundedGrams === 3000 && q1.freightCents === 50_000 && q1.totalCents === 55_000, "over the top slab: per-kg extra on the rounded weight plus a requested surcharge", `${q1.roundedGrams} g ${q1.freightCents}/${q1.totalCents}`);
const qVol = await ops.rateCards.quote({ versionId: card.versionId, band: "local", weightGrams: 300, lengthCm: 30, widthCm: 20, heightCm: 10, requested: [] });
check(qVol.volumetricGrams === 1200 && qVol.chargeableGrams === 1200 && qVol.totalCents === 40_000, "volumetric weight wins when it is higher (30×20×10 ÷ 5000 = 1.2 kg)", `${qVol.volumetricGrams} g → ${qVol.totalCents}`);
await expectFail("an unknown band is a 400, not a guess", 400, () => ops.rateCards.quote({ versionId: card.versionId, band: "moon", weightGrams: 500, requested: [] }));
await expectFail("a published version is frozen", 409, () => admin.rateCards.saveDraft({ versionId: card.versionId, ...doc }));
const d2 = await admin.rateCards.newDraft({ rateCardId: card.card.id });
check(d2.version.version === 2 && d2.slabs.length === 3, "a new draft starts as a copy of the active version");
await expectFail("only one draft at a time", 409, () => admin.rateCards.newDraft({ rateCardId: card.card.id }));
await admin.rateCards.saveDraft({ versionId: d2.version.id, ...doc, slabs: doc.slabs.map((s) => ({ ...s, priceCents: s.priceCents + 2_000 })) });
const pub2 = await admin.rateCards.publish({ versionId: d2.version.id, reason: "smoke publish v2" });
check(pub2.superseded?.version === 1, "publishing v2 supersedes v1");
const full = await admin.rateCards.get({ id: card.card.id });
check(full.versions.map((v) => `${v.version}:${v.status}`).join(",") === "2:active,1:superseded", "history: v2 active, v1 superseded", full.versions.map((v) => `${v.version}:${v.status}`).join(","));
const d3 = await admin.rateCards.newDraft({ rateCardId: card.card.id });
const disc = await admin.rateCards.discard({ versionId: d3.version.id });
check(disc.discarded, "a draft can be discarded");
await expectFail("an active version cannot be discarded", 409, () => admin.rateCards.discard({ versionId: d2.version.id }));

// ── 6. Merchant onboarding ───────────────────────────────────────────────────
console.log("\n6. Merchant onboarding");
await expectFail("a portal phone that already exists is refused before anything is created", 409, () =>
  admin.merchants.onboard({
    name: `SMK5 Clash ${RUN}`,
    branchId: BRANCH,
    address: "1 Smoke Lane, Colombo",
    contactName: "Clash",
    contactPhone: "+94770000001",
    portalUser: { name: "Clash", phone: "+94775678901" },
  }),
);
const portalPhone = `+9475${String(Date.now()).slice(-7)}`;
const onb = await admin.merchants.onboard({
  name: `SMK5 Merchant ${RUN}`,
  branchId: BRANCH,
  address: "1 Smoke Lane, Colombo 03",
  contactName: "Smoke Owner",
  contactPhone: "+94770000002",
  codEnabled: true,
  podPolicy: "otp",
  rateCardId: card.card.id,
  portalUser: { name: "Smoke Owner", phone: portalPhone },
});
created.merchants.push(onb.merchant.id);
if (onb.portalUser) created.users.push(onb.portalUser.id);
check(onb.merchant.rateCardId === card.card.id && !!onb.portalUser, "onboarding creates the merchant, assigns the card and its portal user");
const portal = await admin.merchants.portalUsers({ merchantId: onb.merchant.id });
check(portal.length === 1 && portal[0].phone === portalPhone, "the portal user is listed under the merchant");
const portalS = await login(portalPhone);
check(portalS.user.role === "merchant" && portalS.user.merchantId === onb.merchant.id, "the new portal user can sign in, scoped to the new merchant");
const qm = await ops.rateCards.quoteForMerchant({ merchantId: onb.merchant.id, band: "outstation", weightGrams: 900, requested: [] });
check(qm.version.version === 2 && qm.totalCents === 47_000, "quoteForMerchant prices on the card's ACTIVE version", String(qm.totalCents));
await expectFail("a merchant without a card cannot be quoted", 409, () => ops.rateCards.quoteForMerchant({ merchantId: "mch_lanka_gadgets", band: "local", weightGrams: 500, requested: [] }));
await expectFail("ops cannot onboard", 403, () => ops.merchants.onboard({ name: "x", branchId: BRANCH, address: "addr x", contactName: "xx", contactPhone: "+94770000003" }));
const upd = await ops.merchants.update({ id: onb.merchant.id, contactName: "Smoke Manager" });
check((upd as { after: { contactName: string } }).after.contactName === "Smoke Manager", "ops may edit a merchant's contact");
await expectFail("ops may not move a merchant to another branch", 403, () => ops.merchants.update({ id: onb.merchant.id, branchId: "brn_kdy_hub" }));
const unassign = await admin.rateCards.assign({ merchantId: onb.merchant.id, rateCardId: null });
check(unassign.before === card.card.id && unassign.after === null, "a card can be unassigned");

// ── 7. Templates ─────────────────────────────────────────────────────────────
console.log("\n7. Notification templates");
const templates = await ops.notifications.templates({});
const t = templates.find((x) => x.active) ?? templates[0];
const pv = await ops.notifications.templatePreview({ key: t.key, bodySms: "Hello {{bogus}} {{awb}}" });
check(pv.problems.some((p) => p.includes("bogus")) && pv.allowed.length > 0, "preview names the unknown placeholder and lists the allowed ones", pv.problems[0] ?? "");
const pvOk = await ops.notifications.templatePreview({ key: t.key });
check(pvOk.problems.length === 0 && !pvOk.rendered.sms.includes("{{"), "the stored template previews clean, placeholders filled with samples");
await expectFail("saving an unknown placeholder is refused", 400, () => admin.notifications.templateUpdate({ key: t.key, bodySms: "Hi {{bogus}}" }));
await expectFail("a malformed channel ladder is refused", 400, () => admin.notifications.templateUpdate({ key: t.key, channelOrder: "pigeon,sms" }));
await expectFail("ops cannot edit templates", 403, () => ops.notifications.templateUpdate({ key: t.key, bodySms: t.bodySms ?? "" }));

// ── 8. Audit viewer ─────────────────────────────────────────────────────────
console.log("\n8. Audit viewer");
await expectFail("ops cannot read the audit log", 403, () => ops.audit.list({}));
const settingRows = await admin.audit.list({ entity: "settings_value", entityId: "ndr_sla_hours", limit: 5 });
check(settingRows.total >= 2 && settingRows.rows[0].actorId === ADMIN_ID, "the SLA change is in the log with its actor", `${settingRows.total} rows`);
const rc = await admin.audit.list({ action: "rate_card.", from: new Date(Date.now() - 10 * 60_000).toISOString() });
check(rc.rows.length >= 5 && rc.rows.every((r) => r.action.startsWith("rate_card.")), "action-prefix and time filters", `${rc.rows.length}`);
const page1 = await admin.audit.list({ limit: 3, offset: 0 });
const page2 = await admin.audit.list({ limit: 3, offset: 3 });
check(page1.rows.length === 3 && !page2.rows.some((r) => page1.rows.some((p) => p.id === r.id)), "offset paging does not repeat rows");
const enrolledRow = (await admin.audit.list({ entityId: newOps.id, action: "mfa.enrolled", limit: 1 })).rows[0];
check(!!enrolledRow && enrolledRow.afterJson!.includes("[redacted]") && !confirm.recoveryCodes.some((c) => enrolledRow.afterJson!.includes(c)), "recovery codes never reach the log");
const startRow = (await admin.audit.list({ entityId: newOps.id, action: "mfa.enrol_started", limit: 1 })).rows[0];
check(!!startRow && !startRow.afterJson!.includes(enrol.secret), "the TOTP secret never reaches the log");
const verifiedRow = (await admin.audit.list({ entityId: ADMIN_ID, action: "mfa.verified", limit: 1 })).rows[0];
check(!!verifiedRow && !verifiedRow.afterJson!.includes(verifiedA.session.refreshToken), "session tokens never reach the log");
const ents = await admin.audit.entities();
check(ents.includes("identity_user") && ents.includes("merchants_rate_card"), "entity filter list");

// ── 9. Monitor, zones ───────────────────────────────────────────────────────
console.log("\n9. Job monitor, zones");
const health = await admin.monitor.health();
check(health.db.ok && typeof health.db.latencyMs === "number", "health: database reachable", `${health.db.latencyMs} ms`);
check(health.worker.lastTickAt !== null, "health: the outbox worker has ticked", String(health.worker.lastTickAt));
const jobs = await admin.monitor.jobs({ limit: 5 });
check(Array.isArray(jobs.rows) && typeof jobs.total === "number", "job list is paged", `${jobs.total} jobs`);
const notFailed = jobs.rows.find((j) => j.state !== "failed");
if (notFailed) await expectFail("only a failed job can be retried", 409, () => admin.monitor.retryJob({ id: notFailed.id }));
else check(true, "only a failed job can be retried (no non-failed job to try)");
await expectFail("ops cannot read the job monitor", 403, () => ops.monitor.health());
const zones = await ops.routing.listZones({ branchId: BRANCH });
const z = zones[0];
const zn = await admin.routing.updateZone({ id: z.id, name: `${z.name} (smoke)` });
check(zn.after.name.endsWith("(smoke)"), "admin renames a zone");
await admin.routing.updateZone({ id: z.id, name: z.name });
await expectFail("a zone whose min is above its max is refused", 400, () => admin.routing.updateZone({ id: z.id, minLat: 10, maxLat: 5 }));
await expectFail("ops cannot edit a zone", 403, () => ops.routing.updateZone({ id: z.id, name: "Ops zone" }));

// ── Cleanup ─────────────────────────────────────────────────────────────────
await cleanupWithRetry(async () => {
  if (created.users.length) {
    await db.delete(identity.refreshToken).where(inArray(identity.refreshToken.userId, created.users));
    await db.delete(identity.mfaRecoveryCode).where(inArray(identity.mfaRecoveryCode.userId, created.users));
    await db.delete(identity.mfaFactor).where(inArray(identity.mfaFactor.userId, created.users));
    await db.delete(identity.user).where(inArray(identity.user.id, created.users));
  }
  if (created.merchants.length) await db.delete(merchants.merchant).where(inArray(merchants.merchant.id, created.merchants));
  for (const id of created.rateCards) {
    const versions = await db.select({ id: merchants.rateCardVersion.id }).from(merchants.rateCardVersion).where(eq(merchants.rateCardVersion.rateCardId, id));
    const vids = versions.map((v) => v.id);
    if (vids.length) {
      await db.delete(merchants.rateBand).where(inArray(merchants.rateBand.versionId, vids));
      await db.delete(merchants.rateSlab).where(inArray(merchants.rateSlab.versionId, vids));
      await db.delete(merchants.rateSurcharge).where(inArray(merchants.rateSurcharge.versionId, vids));
      await db.delete(merchants.rateCardVersion).where(inArray(merchants.rateCardVersion.id, vids));
    }
    await db.delete(merchants.rateCard).where(eq(merchants.rateCard.id, id));
  }
});

console.log(`\n${pass} pass, ${failures.length} fail`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
