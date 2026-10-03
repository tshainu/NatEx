import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../database";
import { branch, user, otpChallenge, refreshToken } from "../../database/schema/identity";
import {
  REFRESH_TTL_SECONDS,
  fingerprint,
  hashSecret,
  mintRefreshToken,
  signAccessToken,
  verifySecret,
  PENDING_MFA,
  type MfaLevel,
  type Principal,
  type Role,
} from "../../shared/auth";
import { errors } from "../../shared/errors";
import { prefixedId } from "../../shared/ulid";
import { normaliseLkPhone, sendSms } from "../../shared/sms";
import { writeAudit } from "../../shared/audit";
import { distanceMetres } from "../../shared/geo";
import { SETTING_KEYS, settingValue } from "../settings/service";
import { devCodeFor, getFactor, MFA_ROLES, mfaRequiredFor } from "./mfa";
import { isDevelopment } from "../../shared/env";

/**
 * MODULE: identity — the ONLY reader of identity_* tables (PROJECT.md §4).
 * Other modules call these exported functions.
 */

const OTP_TTL_SECONDS = 5 * 60;
const OTP_MAX_ATTEMPTS = 5;

export interface IdentityUser {
  id: string;
  branchId: string;
  role: Role;
  name: string;
  phone: string;
  deviceId: string | null;
  status: string;
  merchantId: string | null;
}

export async function getUserById(id: string): Promise<IdentityUser | null> {
  const [row] = await db.select().from(user).where(eq(user.id, id));
  return row ? (row as IdentityUser) : null;
}

export async function getUserByPhone(phone: string): Promise<IdentityUser | null> {
  const [row] = await db.select().from(user).where(eq(user.phone, normaliseLkPhone(phone)));
  return row ? (row as IdentityUser) : null;
}

function sixDigitCode(): string {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return (100000 + (bytes[0] % 900000)).toString();
}

/**
 * Phone + OTP step 1. The code is sent through the SMS execution link and
 * stored only as an argon2id hash.
 *
 * Returns the code itself ONLY in a development/test process (shared/env.ts) and when the gateway
 * is not configured — otherwise nobody could log in to the pilot. Flagged, not
 * hidden.
 */
export async function requestOtp(phoneInput: string): Promise<{
  challengeId: string;
  expiresInSeconds: number;
  smsState: string;
  devCode?: string;
}> {
  const phone = normaliseLkPhone(phoneInput);
  const account = await getUserByPhone(phone);
  if (!account) errors.notFound("Account for that phone number");
  if (account!.status !== "active") errors.forbidden("This account is suspended.");

  const code = sixDigitCode();
  const challengeId = prefixedId("otp");
  await db.insert(otpChallenge).values({
    id: challengeId,
    phone,
    codeHash: await hashSecret(code),
    expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
  });

  const sms = await sendSms({
    to: phone,
    purpose: "otp",
    body: `NatEx verification code: ${code}. Valid ${OTP_TTL_SECONDS / 60} minutes. Do not share it.`,
  });

  await db.update(otpChallenge).set({ smsRef: sms.gatewayRef }).where(eq(otpChallenge.id, challengeId));

  const exposeCode = isDevelopment() && sms.state !== "sent";
  return {
    challengeId,
    expiresInSeconds: OTP_TTL_SECONDS,
    smsState: sms.state,
    ...(exposeCode ? { devCode: code } : {}),
  };
}

export interface Session {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  user: {
    id: string;
    name: string;
    role: Role;
    branchId: string;
    branchName: string;
    merchantId: string | null;
    deviceId: string | null;
  };
  /**
   * M5 (§2). `state` is the session's MFA level. When it is `enrol` or
   * `challenge` the tokens above are PENDING — good only for the `mfa.*`
   * routes, for PENDING_SESSION_SECONDS — and the client must finish the
   * second step before it has a usable session. `devCode` is present only
   * outside production, for a development-seeded factor (see mfa.ts).
   */
  mfa: { state: MfaLevel; devCode?: string };
}

/** A pending (pre-MFA) session lives ten minutes and is never refreshed. */
export const PENDING_SESSION_SECONDS = 10 * 60;

/** Roles exempt from the idle timeout: offline-first field apps (§7). */
const IDLE_EXEMPT: ReadonlySet<Role> = new Set<Role>(["rider", "transport"]);

async function issueSession(
  account: IdentityUser,
  deviceId: string | null,
  opts: { mfaLevel: MfaLevel; familyStartedAt?: Date; devCode?: string | null } = { mfaLevel: "none" },
): Promise<Session> {
  const [homeBranch] = await db.select().from(branch).where(eq(branch.id, account.branchId));
  const pending = PENDING_MFA.has(opts.mfaLevel);

  const { token: accessToken, expiresIn } = await signAccessToken({
    sub: account.id,
    role: account.role,
    branchId: account.branchId,
    merchantId: account.merchantId,
    deviceId,
    name: account.name,
    mfa: opts.mfaLevel,
  });

  const refresh = mintRefreshToken();
  const ttl = pending ? PENDING_SESSION_SECONDS : REFRESH_TTL_SECONDS;
  await db.insert(refreshToken).values({
    id: prefixedId("rtk"),
    userId: account.id,
    tokenHash: await fingerprint(refresh),
    deviceId,
    expiresAt: new Date(Date.now() + ttl * 1000),
    mfaLevel: opts.mfaLevel,
    familyStartedAt: opts.familyStartedAt ?? new Date(),
  });

  return {
    accessToken,
    expiresIn: pending ? Math.min(expiresIn, PENDING_SESSION_SECONDS) : expiresIn,
    refreshToken: refresh,
    user: {
      id: account.id,
      name: account.name,
      role: account.role,
      branchId: account.branchId,
      branchName: homeBranch?.name ?? "—",
      merchantId: account.merchantId,
      deviceId,
    },
    mfa: { state: opts.mfaLevel, ...(opts.devCode ? { devCode: opts.devCode } : {}) },
  };
}

/** What a fresh sign-in must still prove, for this account, right now. */
async function signInLevel(account: IdentityUser): Promise<{ level: MfaLevel; devCode: string | null }> {
  if (!(MFA_ROLES as readonly string[]).includes(account.role)) return { level: "none", devCode: null };
  // An enrolled authenticator is always asked for, even with enforcement off:
  // a user who chose MFA keeps it.
  const factor = await getFactor(account.id);
  if (factor?.confirmedAt) return { level: "challenge", devCode: await devCodeFor(factor) };
  if (await mfaRequiredFor(account.role)) return { level: "enrol", devCode: null };
  return { level: "none", devCode: null };
}

/**
 * The second step succeeded (mfa.ts verified a TOTP or recovery code, or
 * confirmed a first enrolment): swap the pending session for a full one. Every
 * pending refresh token the user holds is revoked, so a pending token cannot
 * be replayed into a second full session.
 */
export async function completeMfaSignIn(userId: string, deviceId: string | null): Promise<Session> {
  const account = await getUserById(userId);
  if (!account || account.status !== "active") errors.unauthenticated("Account unavailable.");
  await db
    .update(refreshToken)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshToken.userId, userId),
        isNull(refreshToken.revokedAt),
        inArray(refreshToken.mfaLevel, [...PENDING_MFA]),
      ),
    );
  return issueSession(account!, deviceId, { mfaLevel: "verified" });
}

/**
 * Phone + OTP step 2, plus device binding.
 * "One active device per rider" (§5): a rider logging in from a new device
 * re-binds it, the previous device's refresh tokens are revoked, and the
 * re-bind is audited.
 */
export async function verifyOtp(params: {
  challengeId: string;
  code: string;
  deviceId?: string | null;
}): Promise<Session> {
  const [challenge] = await db
    .select()
    .from(otpChallenge)
    .where(eq(otpChallenge.id, params.challengeId));

  if (!challenge) errors.notFound("OTP challenge");
  if (challenge!.consumedAt) errors.badRequest("This code has already been used.");
  if (challenge!.expiresAt.getTime() < Date.now()) {
    errors.badRequest("This code has expired. Request a new one.");
  }
  if (challenge!.attempts >= OTP_MAX_ATTEMPTS) {
    errors.forbidden("Too many incorrect attempts. Request a new code.");
  }

  const ok = await verifySecret(params.code, challenge!.codeHash);
  if (!ok) {
    await db
      .update(otpChallenge)
      .set({ attempts: challenge!.attempts + 1 })
      .where(eq(otpChallenge.id, challenge!.id));
    errors.badRequest("Incorrect code.", {
      attemptsRemaining: OTP_MAX_ATTEMPTS - (challenge!.attempts + 1),
    });
  }

  await db
    .update(otpChallenge)
    .set({ consumedAt: new Date() })
    .where(eq(otpChallenge.id, challenge!.id));

  const account = await getUserByPhone(challenge!.phone);
  if (!account) errors.notFound("Account");

  const deviceId = params.deviceId ?? null;
  if (account!.role === "rider" && deviceId && account!.deviceId !== deviceId) {
    const previous = account!.deviceId;
    await db.update(user).set({ deviceId }).where(eq(user.id, account!.id));
    // Revoke every session bound to the old device.
    await db
      .update(refreshToken)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshToken.userId, account!.id), isNull(refreshToken.revokedAt)));
    await writeAudit({
      entity: "identity_user",
      entityId: account!.id,
      action: "device.rebound",
      actor: {
        userId: account!.id,
        name: account!.name,
        role: account!.role,
        branchId: account!.branchId,
      },
      before: { deviceId: previous },
      after: { deviceId },
      deviceId,
    });
    account!.deviceId = deviceId;
  } else if (deviceId && !account!.deviceId) {
    await db.update(user).set({ deviceId }).where(eq(user.id, account!.id));
    account!.deviceId = deviceId;
  }

  const { level, devCode } = await signInLevel(account!);
  return issueSession(account!, deviceId ?? account!.deviceId, { mfaLevel: level, devCode });
}

async function revokeFamily(userId: string, rowId: string): Promise<void> {
  await db.update(refreshToken).set({ revokedAt: new Date() }).where(and(eq(refreshToken.id, rowId), eq(refreshToken.userId, userId)));
}

/**
 * Rotating refresh: the presented token is revoked and replaced (§2). M5
 * session policy is enforced here, because the access token lives only 15
 * minutes — refusing the rotation ends the session:
 *   - pending (pre-MFA) sessions are never refreshed;
 *   - an MFA role whose session did not pass MFA is sent back to sign in
 *     (enforcement switched on, or the role changed, after it began);
 *   - absolute lifetime: `session_max_days` from the sign-in, every role;
 *   - idle timeout: `session_idle_minutes` since the last rotation, portal
 *     roles only — riders and transport are exempt (offline-first, §7).
 * The MFA level and the family start are carried into the successor unchanged.
 */
export async function rotateRefresh(presented: string): Promise<Session> {
  const hash = await fingerprint(presented);
  const [row] = await db
    .select()
    .from(refreshToken)
    .where(and(eq(refreshToken.tokenHash, hash), isNull(refreshToken.revokedAt)));

  if (!row) errors.unauthenticated("Refresh token is invalid or already used.");
  if (row!.expiresAt.getTime() < Date.now()) errors.unauthenticated("Refresh token expired.");

  const account = await getUserById(row!.userId);
  if (!account || account.status !== "active") errors.unauthenticated("Account unavailable.");

  const level = (row!.mfaLevel ?? "none") as MfaLevel;
  if (PENDING_MFA.has(level)) {
    await revokeFamily(account!.id, row!.id);
    errors.unauthenticated("Finish signing in: this session has not passed the authenticator step.");
  }
  if (level !== "verified" && (await mfaRequiredFor(account!.role))) {
    await revokeFamily(account!.id, row!.id);
    errors.unauthenticated("Sign in again: your role now requires an authenticator code.");
  }

  const now = Date.now();
  const familyStartedAt = row!.familyStartedAt ?? row!.createdAt;
  const maxDays = await settingValue(SETTING_KEYS.SESSION_MAX_DAYS);
  if (now - familyStartedAt.getTime() > maxDays * 86_400_000) {
    await revokeFamily(account!.id, row!.id);
    errors.unauthenticated(`Session ended: sessions last at most ${maxDays} days. Sign in again.`);
  }
  if (!IDLE_EXEMPT.has(account!.role)) {
    const idleMinutes = await settingValue(SETTING_KEYS.SESSION_IDLE_MINUTES);
    if (now - row!.createdAt.getTime() > idleMinutes * 60_000) {
      await revokeFamily(account!.id, row!.id);
      errors.unauthenticated(`Session ended after ${idleMinutes} minutes without activity. Sign in again.`);
    }
  }

  const session = await issueSession(account!, row!.deviceId, { mfaLevel: level, familyStartedAt });
  const [successor] = await db
    .select({ id: refreshToken.id })
    .from(refreshToken)
    .where(eq(refreshToken.userId, account!.id))
    .orderBy(desc(refreshToken.createdAt))
    .limit(1);

  await db
    .update(refreshToken)
    .set({ revokedAt: new Date(), replacedById: successor?.id ?? null })
    .where(eq(refreshToken.id, row!.id));

  return session;
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await db
    .update(refreshToken)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshToken.userId, userId), isNull(refreshToken.revokedAt)));
}

// ── Branches & users (read paths other modules and the admin portal use) ─────

export async function listBranches() {
  return db.select().from(branch).orderBy(branch.code);
}

export async function getBranch(id: string) {
  const [row] = await db.select().from(branch).where(eq(branch.id, id));
  return row ?? null;
}

/** Nearest branch — Haversine stand-in for PostGIS `<->` (§5, see shared/geo.ts). */
export async function nearestBranch(latE6: number, lngE6: number) {
  const rows = await db.select().from(branch);
  if (rows.length === 0) return null;
  const ranked = rows
    .map((b) => ({ branch: b, metres: distanceMetres(b.lat, b.lng, latE6, lngE6) }))
    .sort((a, z) => a.metres - z.metres);
  return ranked[0];
}

export async function listUsers(scope: Principal) {
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      phone: user.phone,
      role: user.role,
      status: user.status,
      deviceId: user.deviceId,
      branchId: user.branchId,
      branchName: branch.name,
      merchantId: user.merchantId,
      createdAt: user.createdAt,
    })
    .from(user)
    .leftJoin(branch, eq(branch.id, user.branchId))
    .orderBy(user.name);

  if (scope.role === "admin" || scope.role === "finance") return rows;
  return rows.filter((r) => r.branchId === scope.branchId);
}

export async function listRiders(branchId: string) {
  return db
    .select({ id: user.id, name: user.name, phone: user.phone, deviceId: user.deviceId })
    .from(user)
    .where(and(eq(user.branchId, branchId), eq(user.role, "rider"), eq(user.status, "active")))
    .orderBy(user.name);
}

export async function createUser(input: {
  branchId: string;
  role: Role;
  name: string;
  phone: string;
  merchantId?: string | null;
}): Promise<IdentityUser> {
  const phone = normaliseLkPhone(input.phone);
  const existing = await getUserByPhone(phone);
  if (existing) errors.conflict(`A user with phone ${phone} already exists.`);

  const [row] = await db
    .insert(user)
    .values({
      id: prefixedId("usr"),
      branchId: input.branchId,
      role: input.role,
      name: input.name,
      phone,
      merchantId: input.merchantId ?? null,
      status: "active",
    })
    .returning();
  return row as IdentityUser;
}

export async function setUserStatus(userId: string, status: "active" | "suspended") {
  const [row] = await db.update(user).set({ status }).where(eq(user.id, userId)).returning();
  if (!row) errors.notFound("User");
  if (status === "suspended") await revokeAllSessions(userId);
  return row as IdentityUser;
}

export async function createBranch(input: {
  code: string;
  name: string;
  address: string;
  latE6: number;
  lngE6: number;
  type: "hub" | "branch";
}) {
  const [row] = await db
    .insert(branch)
    .values({
      id: prefixedId("brn"),
      code: input.code.toUpperCase(),
      name: input.name,
      address: input.address,
      lat: input.latE6,
      lng: input.lngE6,
      type: input.type,
    })
    .returning();
  return row;
}

/** Active-session count per user, for the admin portal. */
export async function sessionCounts() {
  const rows = await db
    .select({ userId: refreshToken.userId, count: sql<number>`count(*)` })
    .from(refreshToken)
    .where(and(isNull(refreshToken.revokedAt), gt(refreshToken.expiresAt, new Date())))
    .groupBy(refreshToken.userId);
  // Returned as an array, not a Map — this crosses the RPC boundary as JSON.
  return rows.map((r) => ({ userId: r.userId, activeSessions: Number(r.count) }));
}
