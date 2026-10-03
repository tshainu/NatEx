import { and, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { db } from "../../database";
import { branch, refreshToken, user } from "../../database/schema/identity";
import type { Principal, Role } from "../../shared/auth";
import { errors } from "../../shared/errors";
import { normaliseLkPhone } from "../../shared/sms";
import { getUserById, getUserByPhone, revokeAllSessions, type IdentityUser } from "./service";

/**
 * MODULE: identity — admin portal writes (§10 M5 "users, roles, branches").
 *
 * Two guards protect the portal from locking itself out:
 *   1. an admin never changes their OWN role or status — a second admin does;
 *   2. the last active admin cannot be demoted or suspended, whoever asks.
 * Both are refused with 409, not silently ignored.
 */

async function activeAdminCount(excludingUserId?: string): Promise<number> {
  const where = excludingUserId
    ? and(eq(user.role, "admin"), eq(user.status, "active"), ne(user.id, excludingUserId))
    : and(eq(user.role, "admin"), eq(user.status, "active"));
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(user).where(where);
  return Number(row?.n ?? 0);
}

async function guardAdminLoss(actor: Principal, target: IdentityUser, losing: string): Promise<void> {
  if (target.id === actor.userId) {
    errors.conflict(`You cannot ${losing} your own account. Ask another admin.`, { selfLockout: true });
  }
  if (target.role === "admin" && target.status === "active" && (await activeAdminCount(target.id)) === 0) {
    errors.conflict(`${target.name} is the last active admin and cannot be ${losing === "suspend" ? "suspended" : "demoted"}.`, {
      lastAdmin: true,
    });
  }
}

export interface UserPatch {
  name?: string;
  phone?: string;
  role?: Role;
  branchId?: string;
  merchantId?: string | null;
}

/**
 * Edit a user. A change to role, branch or merchant revokes the user's
 * sessions: the access token is re-read on every request (middleware/auth.ts),
 * but a role change can add or remove the MFA requirement, so the user signs
 * in again under the new rules.
 */
export async function updateUser(
  actor: Principal,
  userId: string,
  patch: UserPatch,
): Promise<{ before: IdentityUser; after: IdentityUser; sessionsRevoked: boolean }> {
  const before = await getUserById(userId);
  if (!before) errors.notFound("User");

  const next: Partial<typeof user.$inferInsert> = {};
  if (patch.name !== undefined && patch.name !== before!.name) next.name = patch.name.trim();

  if (patch.phone !== undefined) {
    const phone = normaliseLkPhone(patch.phone);
    if (phone !== before!.phone) {
      const clash = await getUserByPhone(phone);
      if (clash && clash.id !== userId) errors.conflict(`Phone ${phone} already belongs to ${clash.name}.`);
      next.phone = phone;
    }
  }

  const role = patch.role ?? (before!.role as Role);
  if (patch.role !== undefined && patch.role !== before!.role) {
    if (before!.role === "admin") await guardAdminLoss(actor, before!, "demote");
    else if (before!.id === actor.userId) errors.conflict("You cannot change your own role.", { selfLockout: true });
    next.role = patch.role;
  }

  if (patch.branchId !== undefined && patch.branchId !== before!.branchId) {
    const [b] = await db.select({ id: branch.id }).from(branch).where(eq(branch.id, patch.branchId));
    if (!b) errors.badRequest(`Branch ${patch.branchId} does not exist.`);
    next.branchId = patch.branchId;
  }

  // A merchant-portal user is meaningless without its merchant; a staff user
  // with a merchantId would be row-scoped as if it were one (§5).
  const merchantId = patch.merchantId !== undefined ? patch.merchantId : before!.merchantId;
  if (role === "merchant" && !merchantId) errors.badRequest("A merchant user needs a merchant.");
  const wantMerchant = role === "merchant" ? merchantId : null;
  if (wantMerchant !== before!.merchantId) next.merchantId = wantMerchant;

  if (Object.keys(next).length === 0) return { before: before!, after: before!, sessionsRevoked: false };

  const [row] = await db.update(user).set(next).where(eq(user.id, userId)).returning();
  const sessionsRevoked = "role" in next || "branchId" in next || "merchantId" in next || "phone" in next;
  if (sessionsRevoked) await revokeAllSessions(userId);
  return { before: before!, after: row as IdentityUser, sessionsRevoked };
}

/** Suspend or reactivate, with the self-lockout and last-admin guards. */
export async function changeUserStatus(
  actor: Principal,
  userId: string,
  status: "active" | "suspended",
): Promise<IdentityUser> {
  const target = await getUserById(userId);
  if (!target) errors.notFound("User");
  if (status === "suspended") await guardAdminLoss(actor, target!, "suspend");
  const [row] = await db.update(user).set({ status }).where(eq(user.id, userId)).returning();
  if (status === "suspended") await revokeAllSessions(userId);
  return row as IdentityUser;
}

/**
 * Edit a branch. The code is immutable: it is printed into AWB-adjacent
 * documents (runsheets, manifests) and a renamed code would orphan them.
 */
export async function updateBranch(
  id: string,
  patch: { name?: string; address?: string; latE6?: number; lngE6?: number; type?: "hub" | "branch" },
) {
  const [before] = await db.select().from(branch).where(eq(branch.id, id));
  if (!before) errors.notFound("Branch");
  const next: Partial<typeof branch.$inferInsert> = {};
  if (patch.name !== undefined) next.name = patch.name.trim();
  if (patch.address !== undefined) next.address = patch.address.trim();
  if (patch.latE6 !== undefined) next.lat = patch.latE6;
  if (patch.lngE6 !== undefined) next.lng = patch.lngE6;
  if (patch.type !== undefined) next.type = patch.type;
  if (Object.keys(next).length === 0) return { before, after: before };
  const [after] = await db.update(branch).set(next).where(eq(branch.id, id)).returning();
  return { before, after: after! };
}

export interface SessionView {
  id: string;
  deviceId: string | null;
  mfaLevel: string;
  startedAt: Date;
  lastRefreshedAt: Date;
  expiresAt: Date;
}

/** Live sessions (unrevoked, unexpired refresh tokens) for one user. */
export async function listSessions(userId: string): Promise<SessionView[]> {
  const rows = await db
    .select()
    .from(refreshToken)
    .where(
      and(
        eq(refreshToken.userId, userId),
        isNull(refreshToken.revokedAt),
        gt(refreshToken.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(refreshToken.createdAt));
  return rows.map((r) => ({
    id: r.id,
    deviceId: r.deviceId,
    mfaLevel: r.mfaLevel,
    startedAt: r.familyStartedAt ?? r.createdAt,
    lastRefreshedAt: r.createdAt,
    expiresAt: r.expiresAt,
  }));
}

/** Revoke one session. Scoped to the owner so a session id cannot be guessed across users. */
export async function revokeSession(userId: string, sessionId: string): Promise<{ revoked: boolean }> {
  const rows = await db
    .update(refreshToken)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshToken.id, sessionId), eq(refreshToken.userId, userId), isNull(refreshToken.revokedAt)))
    .returning({ id: refreshToken.id });
  if (rows.length === 0) errors.notFound("Session");
  return { revoked: true };
}

export async function revokeUserSessions(userId: string): Promise<{ userId: string; revoked: number }> {
  const target = await getUserById(userId);
  if (!target) errors.notFound("User");
  const live = await listSessions(userId);
  await revokeAllSessions(userId);
  return { userId, revoked: live.length };
}

/** Merchant-portal users for one merchant (merchant onboarding view). */
export async function usersForMerchant(merchantId: string) {
  return db
    .select({ id: user.id, name: user.name, phone: user.phone, status: user.status, createdAt: user.createdAt })
    .from(user)
    .where(and(eq(user.role, "merchant"), eq(user.merchantId, merchantId)))
    .orderBy(user.name);
}
