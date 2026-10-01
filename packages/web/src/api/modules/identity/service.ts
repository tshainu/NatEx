import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../../database";
import { branch, user, otpChallenge, refreshToken } from "../../database/schema/identity";
import {
  REFRESH_TTL_SECONDS,
  fingerprint,
  hashSecret,
  mintRefreshToken,
  signAccessToken,
  verifySecret,
  type Principal,
  type Role,
} from "../../shared/auth";
import { errors } from "../../shared/errors";
import { prefixedId } from "../../shared/ulid";
import { normaliseLkPhone, sendSms } from "../../shared/sms";
import { writeAudit } from "../../shared/audit";
import { distanceMetres } from "../../shared/geo";

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
 * Returns the code itself ONLY when NODE_ENV !== "production" and the gateway
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

  const exposeCode = process.env.NODE_ENV !== "production" && sms.state !== "sent";
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
}

async function issueSession(
  account: IdentityUser,
  deviceId: string | null,
): Promise<Session> {
  const [homeBranch] = await db.select().from(branch).where(eq(branch.id, account.branchId));

  const { token: accessToken, expiresIn } = await signAccessToken({
    sub: account.id,
    role: account.role,
    branchId: account.branchId,
    merchantId: account.merchantId,
    deviceId,
    name: account.name,
  });

  const refresh = mintRefreshToken();
  await db.insert(refreshToken).values({
    id: prefixedId("rtk"),
    userId: account.id,
    tokenHash: await fingerprint(refresh),
    deviceId,
    expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
  });

  return {
    accessToken,
    expiresIn,
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
  };
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

  return issueSession(account!, deviceId ?? account!.deviceId);
}

/** Rotating refresh: the presented token is revoked and replaced (§2). */
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

  const session = await issueSession(account!, row!.deviceId);
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
