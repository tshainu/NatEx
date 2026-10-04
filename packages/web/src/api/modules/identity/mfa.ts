import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../database";
import { mfaFactor, mfaRecoveryCode, user } from "../../database/schema/identity";
import type { Role } from "../../shared/auth";
import { fingerprint } from "../../shared/auth";
import { errors } from "../../shared/errors";
import { open, seal } from "../../shared/secret-box";
import { base32Encode, matchTotp, newTotpSecret, otpauthUri, stepAt, TOTP_STEP_SECONDS, TOTP_WINDOW, totpAt } from "../../shared/totp";
import { prefixedId } from "../../shared/ulid";
import { SETTING_KEYS, settingFlag } from "../settings/service";
import { isDevelopment } from "../../shared/env";

/**
 * MODULE: identity — TOTP second factor (PROJECT.md §2: "TOTP MFA for
 * ops/admin/finance").
 *
 *   sign-in = phone OTP (something you have: the SIM)
 *           + TOTP code (something you have: the enrolled authenticator)
 *
 * The secret is encrypted at rest (shared/secret-box.ts, AES-256-GCM with
 * MFA_ENCRYPTION_KEY) because verifying a code needs it back. Recovery codes
 * are SHA-256 fingerprints and single-use. A code is accepted for ±1 step
 * (30 s either side) and never twice (RFC 6238 §5.2, `lastStep`).
 *
 * DEVELOPMENT ONLY — seeded factors: the seeded staff identities get a factor
 * whose secret is derived from the user id (`devTotpSecret`), so the preview
 * and the regression scripts can sign in. The sign-in response then carries a
 * `devCode` for that factor, exactly as `requestOtp` carries the SMS `devCode`
 * when no gateway is configured. Neither happens with NODE_ENV=production: the
 * seeder refuses, and a seeded factor is refused at sign-in.
 */

export const MFA_ROLES: readonly Role[] = ["ops", "admin", "finance"];
export const RECOVERY_CODE_COUNT = 10;

/** Fail-closed: anything that is not an explicit dev/test process counts as production (shared/env.ts). */
const isProduction = () => !isDevelopment();

export async function mfaRequiredFor(role: Role | string): Promise<boolean> {
  if (!(MFA_ROLES as readonly string[]).includes(role)) return false;
  return settingFlag(SETTING_KEYS.MFA_ENFORCED);
}

export type FactorRow = typeof mfaFactor.$inferSelect;

export async function getFactor(userId: string): Promise<FactorRow | null> {
  const [row] = await db.select().from(mfaFactor).where(eq(mfaFactor.userId, userId));
  return row ?? null;
}

/** Deterministic dev secret for a seeded identity. Never used in production. */
export async function devTotpSecret(userId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`natex-dev-totp:${userId}`)),
  );
  return base32Encode(digest.slice(0, 20));
}

/**
 * The next code this factor will accept, for a seeded factor outside
 * production (null otherwise, or when both window steps are already used —
 * the caller waits for the next 30-second step).
 */
export async function devCodeFor(factor: FactorRow, nowMs = Date.now()): Promise<string | null> {
  if (isProduction() || !factor.seeded) return null;
  const now = stepAt(nowMs);
  const secret = await open(factor.secretEnc);
  // A past step is accepted only until the current step ends. Offering one in
  // its last few seconds let the boundary pass between verifyOtp and
  // mfa.verify, and the caller got "Incorrect authenticator code" (Round 6
  // regression flake). Oldest first otherwise, so a step serves three sign-ins.
  const stepMs = TOTP_STEP_SECONDS * 1000;
  const msLeftInStep = stepMs - (nowMs % stepMs);
  for (let s = now - TOTP_WINDOW; s <= now + TOTP_WINDOW; s += 1) {
    if (s < now && msLeftInStep < 5_000) continue;
    if (s > factor.lastStep) return totpAt(secret, s);
  }
  return null;
}

/** Start (or restart) enrolment: a fresh unconfirmed secret. A confirmed factor is never overwritten here. */
export async function startEnrolment(userId: string, accountLabel: string) {
  const existing = await getFactor(userId);
  if (existing?.confirmedAt) errors.conflict("An authenticator is already enrolled. An admin must reset it first.");
  const secret = newTotpSecret();
  const secretEnc = await seal(secret);
  if (existing) {
    await db.update(mfaFactor).set({ secretEnc, lastStep: 0, seeded: false, createdAt: new Date() }).where(eq(mfaFactor.userId, userId));
  } else {
    await db.insert(mfaFactor).values({ userId, secretEnc, lastStep: 0, seeded: false });
  }
  return { secret, otpauthUri: otpauthUri(secret, accountLabel) };
}

function newRecoveryCode(): string {
  // 10 chars of Crockford base32 as xxxxx-xxxxx: ~50 bits, typed by a human once.
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const chars = [...bytes].map((b) => alphabet[b & 31]).join("");
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

function normaliseRecovery(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

async function issueRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  const rows = await Promise.all(
    codes.map(async (c) => ({ id: prefixedId("mrc"), userId, codeHash: await fingerprint(normaliseRecovery(c)) })),
  );
  await db.batch([db.delete(mfaRecoveryCode).where(eq(mfaRecoveryCode.userId, userId)), db.insert(mfaRecoveryCode).values(rows)]);
  return codes;
}

async function acceptTotp(factor: FactorRow, code: string): Promise<void> {
  if (isProduction() && factor.seeded) errors.forbidden("This factor is a development seed and is refused in production.");
  const secret = await open(factor.secretEnc);
  const hit = await matchTotp(secret, code.trim(), factor.lastStep);
  if (!hit) errors.badRequest("Incorrect authenticator code.", { mfa: "wrong_code" });
  if ("replay" in hit!) errors.badRequest("That code was already used. Wait for the next one.", { mfa: "replay" });
  // Conditional on the step we read, so two concurrent submissions of the same code cannot both win.
  const won = await db
    .update(mfaFactor)
    .set({ lastStep: (hit as { step: number }).step })
    .where(and(eq(mfaFactor.userId, factor.userId), eq(mfaFactor.lastStep, factor.lastStep)))
    .returning({ userId: mfaFactor.userId });
  if (won.length === 0) errors.badRequest("That code was already used. Wait for the next one.", { mfa: "replay" });
}

/** Prove the authenticator works; confirms the factor and returns the one-time recovery codes. */
export async function confirmEnrolment(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
  const factor = await getFactor(userId);
  if (!factor) errors.badRequest("Start enrolment first.");
  if (factor!.confirmedAt) errors.conflict("This authenticator is already confirmed.");
  await acceptTotp(factor!, code);
  await db.update(mfaFactor).set({ confirmedAt: new Date() }).where(eq(mfaFactor.userId, userId));
  return { recoveryCodes: await issueRecoveryCodes(userId) };
}

/** The sign-in challenge: a TOTP code, or one unused recovery code. */
export async function verifyChallenge(
  userId: string,
  code: string,
): Promise<{ method: "totp" | "recovery"; recoveryCodesRemaining: number }> {
  const factor = await getFactor(userId);
  if (!factor?.confirmedAt) errors.badRequest("No authenticator is enrolled for this account.");
  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed)) {
    await acceptTotp(factor!, trimmed);
    return { method: "totp", recoveryCodesRemaining: await recoveryRemaining(userId) };
  }
  const hash = await fingerprint(normaliseRecovery(trimmed));
  const used = await db
    .update(mfaRecoveryCode)
    .set({ usedAt: new Date() })
    .where(and(eq(mfaRecoveryCode.userId, userId), eq(mfaRecoveryCode.codeHash, hash), isNull(mfaRecoveryCode.usedAt)))
    .returning({ id: mfaRecoveryCode.id });
  if (used.length === 0) errors.badRequest("Incorrect or already-used recovery code.", { mfa: "wrong_recovery" });
  return { method: "recovery", recoveryCodesRemaining: await recoveryRemaining(userId) };
}

export async function recoveryRemaining(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(mfaRecoveryCode)
    .where(and(eq(mfaRecoveryCode.userId, userId), isNull(mfaRecoveryCode.usedAt)));
  return Number(row?.n ?? 0);
}

/** New recovery codes; the old set stops working. Requires a live TOTP code. */
export async function regenerateRecoveryCodes(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
  const factor = await getFactor(userId);
  if (!factor?.confirmedAt) errors.badRequest("No authenticator is enrolled for this account.");
  await acceptTotp(factor!, code);
  return { recoveryCodes: await issueRecoveryCodes(userId) };
}

export async function mfaStatus(userId: string, role: Role) {
  const factor = await getFactor(userId);
  return {
    required: await mfaRequiredFor(role),
    roleRequiresMfa: (MFA_ROLES as readonly string[]).includes(role),
    enrolled: Boolean(factor?.confirmedAt),
    confirmedAt: factor?.confirmedAt ?? null,
    seeded: factor?.seeded ?? false,
    recoveryCodesRemaining: factor?.confirmedAt ? await recoveryRemaining(userId) : 0,
  };
}

/** Admin reset: the user enrols again at next sign-in. The caller revokes sessions. */
export async function resetFactor(userId: string): Promise<{ hadFactor: boolean }> {
  const factor = await getFactor(userId);
  await db.batch([
    db.delete(mfaRecoveryCode).where(eq(mfaRecoveryCode.userId, userId)),
    db.delete(mfaFactor).where(eq(mfaFactor.userId, userId)),
  ]);
  return { hadFactor: Boolean(factor) };
}

/** Per-user enrolment state for the admin users table. */
export async function factorStates(): Promise<{ userId: string; enrolled: boolean; seeded: boolean }[]> {
  const rows = await db.select({ userId: mfaFactor.userId, confirmedAt: mfaFactor.confirmedAt, seeded: mfaFactor.seeded }).from(mfaFactor);
  return rows.map((r) => ({ userId: r.userId, enrolled: Boolean(r.confirmedAt), seeded: r.seeded }));
}

/**
 * DEVELOPMENT ONLY. Give every active ops/admin/finance user that has no factor
 * a confirmed, seeded one with the deterministic dev secret. Idempotent.
 */
export async function seedDevMfaFactors(): Promise<{ seeded: string[] }> {
  if (isProduction()) throw new Error("Refusing to seed development MFA factors with NODE_ENV=production.");
  const staff = await db
    .select({ id: user.id })
    .from(user)
    .where(and(inArray(user.role, [...MFA_ROLES]), eq(user.status, "active")));
  const have = new Set((await db.select({ userId: mfaFactor.userId }).from(mfaFactor)).map((r) => r.userId));
  const seeded: string[] = [];
  for (const s of staff) {
    if (have.has(s.id)) continue;
    await db.insert(mfaFactor).values({
      userId: s.id,
      secretEnc: await seal(await devTotpSecret(s.id)),
      confirmedAt: new Date(),
      lastStep: 0,
      seeded: true,
    });
    seeded.push(s.id);
  }
  return { seeded };
}
