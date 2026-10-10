import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../database";
import { branch, refreshToken, user } from "../../database/schema/identity";
import type { Principal } from "../../shared/auth";
import { changeUserStatus as adminChangeUserStatus, listMerchantUsers, updateUser } from "./admin";
import { createBranch, createUser, listOfficialUsers, loginWithPassword } from "./service";

const RUN = Date.now().toString(36).toLowerCase();
const BRANCH_CODE = `T${Date.now().toString().slice(-8)}`;
const PHONE = `+9470${Date.now().toString().slice(-8)}`;
const USERNAME = `merchant_${RUN}`;
const PASSWORD = "merchant-test-password-47";
const UPDATED_USERNAME = `merchant_updated_${RUN}`;
const UPDATED_PASSWORD = "merchant-new-test-password-83";
let branchId: string | null = null;
let userId: string | null = null;
let extraUserId: string | null = null;

beforeAll(async () => {
  const createdBranch = await createBranch({
    code: BRANCH_CODE,
    name: "Merchant password test branch",
    address: "Test address, Colombo",
    latE6: 6_927_100,
    lngE6: 79_861_200,
    type: "branch",
  });
  branchId = createdBranch!.id;
  const account = await createUser({
    branchId,
    role: "merchant",
    name: "Merchant password test account",
    phone: PHONE,
    username: USERNAME,
    password: PASSWORD,
    merchantId: `mch_password_test_${RUN}`,
  });
  userId = account.id;
});

afterAll(async () => {
  if (extraUserId) {
    await db.delete(refreshToken).where(eq(refreshToken.userId, extraUserId));
    await db.delete(user).where(eq(user.id, extraUserId));
  }
  if (userId) {
    await db.delete(refreshToken).where(eq(refreshToken.userId, userId));
    await db.delete(user).where(eq(user.id, userId));
  }
  if (branchId) await db.delete(branch).where(eq(branch.id, branchId));
});

describe("merchant username/password sign-in", () => {
  test("Merchant logins are separated from official users and responses never expose password hashes", async () => {
    const actor: Principal = {
      userId: `usr_admin_test_${RUN}`,
      name: "Test administrator",
      role: "admin",
      roles: ["admin"],
      branchId: branchId!,
    };
    const extra = await createUser({
      branchId: branchId!,
      role: "merchant",
      name: "Another Merchant login",
      phone: `+9471${Date.now().toString().slice(-8)}`,
      username: `another_${RUN}`,
      password: PASSWORD,
      merchantId: `mch_password_test_${RUN}`,
    });
    extraUserId = extra.id;
    expect("passwordHash" in extra).toBe(false);
    const official = await listOfficialUsers(actor);
    const merchantUsers = await listMerchantUsers({ page: 1, pageSize: 100 });
    expect(official.some((entry) => entry.id === userId)).toBe(false);
    expect(merchantUsers.rows.some((entry) => entry.id === userId)).toBe(true);

    const suspended = await adminChangeUserStatus(actor, userId!, "suspended");
    expect("passwordHash" in suspended).toBe(false);
    expect(JSON.stringify(suspended)).not.toContain("argon2id");
    await adminChangeUserStatus(actor, userId!, "active");
  });

  test("stores a password hash and signs in as the linked merchant", async () => {
    const [stored] = await db.select({ passwordHash: user.passwordHash }).from(user).where(eq(user.id, userId!));
    expect(stored?.passwordHash).toBeTruthy();
    expect(stored?.passwordHash).not.toBe(PASSWORD);

    const session = await loginWithPassword({ username: USERNAME.toUpperCase(), password: PASSWORD });
    expect(session.user.id).toBe(userId!);
    expect(session.user.role).toBe("merchant");
    expect(session.user.merchantId).toBe(`mch_password_test_${RUN}`);
    expect(session.mfa.state).toBe("none");
  });

  test("rejects an incorrect password", async () => {
    await expect(loginWithPassword({ username: USERNAME, password: "not-the-password" })).rejects.toMatchObject({
      status: 401,
    });
  });

  test("admin can update login credentials without exposing the password hash", async () => {
    const actor: Principal = {
      userId: `usr_admin_test_${RUN}`,
      name: "Test administrator",
      role: "admin",
      roles: ["admin"],
      branchId: branchId!,
    };
    const result = await updateUser(actor, userId!, {
      username: UPDATED_USERNAME,
      password: UPDATED_PASSWORD,
    });
    expect(result.after.username).toBe(UPDATED_USERNAME);
    expect("passwordHash" in result.after).toBe(false);
    expect(JSON.stringify(result)).not.toContain("argon2id");

    const session = await loginWithPassword({ username: UPDATED_USERNAME, password: UPDATED_PASSWORD });
    expect(session.user.id).toBe(userId!);
    await expect(loginWithPassword({ username: USERNAME, password: PASSWORD })).rejects.toMatchObject({ status: 401 });
  });
});
