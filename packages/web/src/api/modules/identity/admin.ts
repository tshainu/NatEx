import { and, asc, desc, eq, gt, isNull, like, ne, or, sql } from "drizzle-orm";
import { db } from "../../database";
import { branch, refreshToken, user } from "../../database/schema/identity";
import { hrEmployee } from "../../database/schema/hr";
import type { Principal, Role } from "../../shared/auth";
import { errors } from "../../shared/errors";
import { normaliseLkPhone } from "../../shared/sms";
import { cleanOptionalReceiptPhone, receiptPhoneProblem } from "../../shared/receipt-contact";
import {
  dedupeRoles,
  createUser,
  getUserById,
  getUserByPhone,
  getUserByUsername,
  normaliseUsername,
  requireActiveBranch,
  revokeAllSessions,
  rolesOf,
  validateBranchParent,
  type IdentityUser,
} from "./service";
import { hashSecret } from "../../shared/auth";

/**
 * MODULE: identity — admin portal writes (§10 M5 "users, roles, branches").
 *
 * Two guards protect the portal from locking itself out:
 *   1. an admin never changes their OWN role or status — a second admin does;
 *   2. the last active admin cannot be demoted or suspended, whoever asks.
 * Both are refused with 409, not silently ignored.
 */

/** Anyone HOLDING the admin role, on either the legacy or the multi-role column. */
const IS_ADMIN = or(like(user.roles, '%"admin"%'), and(eq(user.roles, ""), eq(user.role, "admin")));

export interface EmployeeLoginInput {
  employeeId: string;
  roles: Role[];
  username?: string | null;
  password?: string | null;
}

/** Minimal, non-payroll fields used to start an official login from HR. */
export async function listEmployeeLoginOptions() {
  return db
    .select({
      id: hrEmployee.id,
      employeeCode: hrEmployee.employeeCode,
      fullName: hrEmployee.fullName,
      phone: hrEmployee.phone,
      branchId: hrEmployee.branchId,
      branchName: branch.name,
    })
    .from(hrEmployee)
    .innerJoin(branch, eq(branch.id, hrEmployee.branchId))
    .where(and(eq(hrEmployee.status, "active"), isNull(hrEmployee.identityUserId), eq(branch.status, "active")))
    .orderBy(asc(hrEmployee.employeeCode));
}

/**
 * Create an official identity for one active, currently unlinked employee.
 * The conditional employee update is inside the same transaction as account
 * creation, so a concurrent claim cannot leave an orphan login behind.
 */
export async function createEmployeeLogin(actor: Principal, input: EmployeeLoginInput) {
  const roles = dedupeRoles(input.roles);
  if (roles.length === 0) errors.badRequest("A login needs at least one recognized role.");
  if (roles.includes("merchant")) errors.badRequest("Merchant portal accounts cannot be linked to employees.");

  return db.transaction(async (tx) => {
    const [employee] = await tx
      .select({
        id: hrEmployee.id,
        fullName: hrEmployee.fullName,
        phone: hrEmployee.phone,
        branchId: hrEmployee.branchId,
        status: hrEmployee.status,
        identityUserId: hrEmployee.identityUserId,
      })
      .from(hrEmployee)
      .where(eq(hrEmployee.id, input.employeeId));
    if (!employee) errors.notFound("Employee");
    if (employee!.status !== "active") errors.badRequest("Only active employees may receive a login.");
    if (employee!.identityUserId) errors.conflict("This employee is already linked to a login.");
    if (!employee!.phone?.trim() || employee!.phone.trim().length < 9) {
      errors.badRequest("The employee must have a valid phone number before a login can be created.");
    }
    if (employee!.fullName.trim().length < 2) errors.badRequest("The employee needs a valid name before a login can be created.");
    const employeePhone = employee!.phone!.trim();

    const account = await createUser(
      {
        name: employee!.fullName,
        phone: employeePhone,
        role: roles[0]!,
        roles,
        branchId: employee!.branchId,
        username: input.username ?? null,
        password: input.password ?? null,
      },
      tx,
    );

    const [linked] = await tx
      .update(hrEmployee)
      .set({ identityUserId: account.id, updatedBy: actor.userId, updatedAt: new Date() })
      .where(and(eq(hrEmployee.id, employee!.id), isNull(hrEmployee.identityUserId), eq(hrEmployee.status, "active")))
      .returning({ id: hrEmployee.id });
    if (!linked) errors.conflict("This employee was linked to a login by another administrator. Please refresh and try again.");

    return { user: account, employeeId: linked.id };
  });
}

async function activeAdminCount(excludingUserId?: string): Promise<number> {
  const where = excludingUserId
    ? and(IS_ADMIN, eq(user.status, "active"), ne(user.id, excludingUserId))
    : and(IS_ADMIN, eq(user.status, "active"));
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(user).where(where);
  return Number(row?.n ?? 0);
}

async function guardAdminLoss(actor: Principal, target: IdentityUser, losing: string): Promise<void> {
  if (target.id === actor.userId) {
    errors.conflict(`You cannot ${losing} your own account. Ask another admin.`, { selfLockout: true });
  }
  if (rolesOf(target).includes("admin") && target.status === "active" && (await activeAdminCount(target.id)) === 0) {
    errors.conflict(`${target.name} is the last active admin and cannot be ${losing === "suspend" ? "suspended" : "demoted"}.`, {
      lastAdmin: true,
    });
  }
}

export interface UserPatch {
  name?: string;
  phone?: string;
  role?: Role;
  /** Full replacement of the role set. Takes precedence over `role`. */
  roles?: Role[];
  branchId?: string;
  merchantId?: string | null;
  /** Username/password sign-in credentials. Empty string clears them. */
  username?: string | null;
  password?: string | null;
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

  // Multi-role: `roles` replaces the whole set; `role` alone stays supported.
  const nextRoles = patch.roles?.length
    ? dedupeRoles(patch.roles)
    : patch.role !== undefined
      ? [patch.role]
      : rolesOf(before!);
  if (nextRoles.length === 0) errors.badRequest("A user needs at least one role.");
  const role = nextRoles[0]!;
  const rolesChanged = JSON.stringify(nextRoles) !== JSON.stringify(rolesOf(before!));
  if (rolesChanged) {
    const hadAdmin = rolesOf(before!).includes("admin");
    if (hadAdmin && !nextRoles.includes("admin")) await guardAdminLoss(actor, before!, "demote");
    else if (before!.id === actor.userId && hadAdmin !== nextRoles.includes("admin")) {
      errors.conflict("You cannot change your own role.", { selfLockout: true });
    }
    next.role = role;
    next.roles = JSON.stringify(nextRoles);
  }

  // Username/password credentials (rider app sign-in). Empty string clears.
  if (patch.username !== undefined) {
    const username = patch.username ? normaliseUsername(patch.username) : null;
    if (username && username !== before!.username) {
      const clash = await getUserByUsername(username);
      if (clash && clash.id !== userId) errors.conflict(`Username ${username} already belongs to ${clash.name}.`);
    }
    if (username !== (before!.username ?? null)) next.username = username;
  }
  if (patch.password) next.passwordHash = await hashSecret(patch.password);
  else if (patch.password === "") next.passwordHash = null;

  if (patch.branchId !== undefined && patch.branchId !== before!.branchId) {
    await requireActiveBranch(patch.branchId);
    next.branchId = patch.branchId;
  }

  // A merchant-portal user is meaningless without its merchant; a staff user
  // with a merchantId would be row-scoped as if it were one (§5).
  const merchantId = patch.merchantId !== undefined ? patch.merchantId : before!.merchantId;
  if (nextRoles.includes("merchant") && !merchantId) errors.badRequest("A merchant user needs a merchant.");
  const wantMerchant = nextRoles.includes("merchant") ? merchantId : null;
  if (wantMerchant !== before!.merchantId) next.merchantId = wantMerchant;

  if (Object.keys(next).length === 0) return { before: before!, after: before!, sessionsRevoked: false };

  const [row] = await db.update(user).set(next).where(eq(user.id, userId)).returning();
  const sessionsRevoked =
    "role" in next || "branchId" in next || "merchantId" in next || "phone" in next || "passwordHash" in next;
  if (sessionsRevoked) await revokeAllSessions(userId);
  const { passwordHash: _passwordHash, ...safeRow } = row!;
  return { before: before!, after: { ...safeRow, roles: rolesOf(row!) } as IdentityUser, sessionsRevoked };
}

/** Suspend or reactivate, with the self-lockout and last-admin guards. */
export async function changeUserStatus(
  actor: Principal,
  userId: string,
  status: "active" | "suspended",
): Promise<IdentityUser> {
  const target = await getUserById(userId);
  if (!target) errors.notFound("User");
  if (status === "active") await requireActiveBranch(target!.branchId);
  if (status === "suspended") await guardAdminLoss(actor, target!, "suspend");
  const [row] = await db.update(user).set({ status }).where(eq(user.id, userId)).returning();
  if (status === "suspended") await revokeAllSessions(userId);
  const { passwordHash: _passwordHash, ...safeRow } = row!;
  return { ...safeRow, roles: rolesOf(row!) } as IdentityUser;
}

/**
 * Edit a branch. The code is immutable: it is printed into tracking number-adjacent
 * documents (runsheets, manifests) and a renamed code would orphan them.
 */
export async function updateBranch(
  id: string,
  patch: { name?: string; address?: string; phone?: string | null; latE6?: number | null; lngE6?: number | null; type?: "hub" | "branch"; parentHubId?: string | null; counterRateCardId?: string | null },
) {
  const [before] = await db.select().from(branch).where(eq(branch.id, id));
  if (!before) errors.notFound("Branch");
  const nextType = (patch.type ?? before!.type) as "hub" | "branch";
  const nextParentHubId = patch.parentHubId !== undefined ? patch.parentHubId : before!.parentHubId;
  await validateBranchParent({ id, type: nextType, parentHubId: nextParentHubId });
  if (before!.type === "hub" && nextType === "branch") {
    const children = await db.select({ id: branch.id }).from(branch).where(eq(branch.parentHubId, id)).limit(1);
    if (children.length) errors.badRequest("Reassign or clear every child branch before changing this hub to a branch.");
  }
  const next: Partial<typeof branch.$inferInsert> = {};
  if (patch.name !== undefined) next.name = patch.name.trim();
  if (patch.address !== undefined) next.address = patch.address.trim();
  if (patch.phone !== undefined) {
    const phoneProblem = receiptPhoneProblem(patch.phone);
    if (phoneProblem) errors.badRequest(`Branch telephone: ${phoneProblem}`, { field: "phone" });
    next.phone = cleanOptionalReceiptPhone(patch.phone);
  }
  if (patch.latE6 !== undefined) next.lat = patch.latE6;
  if (patch.lngE6 !== undefined) next.lng = patch.lngE6;
  if (patch.type !== undefined) next.type = patch.type;
  if (patch.parentHubId !== undefined) next.parentHubId = patch.parentHubId;
  if (patch.counterRateCardId !== undefined) next.counterRateCardId = patch.counterRateCardId;
  if (Object.keys(next).length === 0) return { before, after: before };
  const [after] = await db.update(branch).set(next).where(eq(branch.id, id)).returning();
  return { before, after: after! };
}

/** Deactivate/reactivate without deleting or rewriting branch-owned history. */
export async function changeBranchStatus(id: string, status: "active" | "inactive") {
  const [before] = await db.select().from(branch).where(eq(branch.id, id));
  if (!before) errors.notFound("Branch");
  if (before!.status === status) return { before: before!, after: before! };
  const [after] = await db.update(branch).set({ status }).where(eq(branch.id, id)).returning();
  return { before: before!, after: after! };
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
    .select({ id: user.id, name: user.name, phone: user.phone, username: user.username, status: user.status, createdAt: user.createdAt })
    .from(user)
    .where(and(or(eq(user.role, "merchant"), like(user.roles, '%"merchant"%')), eq(user.merchantId, merchantId)))
    .orderBy(user.name);
}

/** Admin-only paginated Merchant portal user register, separate from staff Users. */
export async function listMerchantUsers(input: {
  page: number;
  pageSize: number;
  search?: string;
  merchantId?: string;
}) {
  const filters = [or(eq(user.role, "merchant"), like(user.roles, '%"merchant"%'))];
  if (input.merchantId) filters.push(eq(user.merchantId, input.merchantId));
  if (input.search?.trim()) {
    const term = `%${input.search.trim()}%`;
    filters.push(or(like(user.name, term), like(user.phone, term), like(user.username, term)));
  }
  const where = and(...filters);
  const page = Math.max(1, input.page);
  const pageSize = Math.min(100, Math.max(1, input.pageSize));
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: user.id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        roles: user.roles,
        username: user.username,
        status: user.status,
        deviceId: user.deviceId,
        branchId: user.branchId,
        branchName: branch.name,
        merchantId: user.merchantId,
        createdAt: user.createdAt,
      })
      .from(user)
      .leftJoin(branch, eq(branch.id, user.branchId))
      .where(where)
      .orderBy(user.name)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ value: sql<number>`count(*)` }).from(user).where(where),
  ]);
  return {
    rows: rows.map((row) => ({ ...row, roles: rolesOf(row) })),
    total: Number(total?.value ?? 0),
    page,
    pageSize,
  };
}
