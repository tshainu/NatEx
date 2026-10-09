import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../database";
import { branch, refreshToken, user } from "../../database/schema/identity";
import { createBranch, createUser, loginWithPassword } from "./service";

const RUN = Date.now().toString(36).toLowerCase();
const BRANCH_CODE = `T${Date.now().toString().slice(-8)}`;
const PHONE = `+9470${Date.now().toString().slice(-8)}`;
const USERNAME = `merchant_${RUN}`;
const PASSWORD = "merchant-test-password-47";
let branchId: string | null = null;
let userId: string | null = null;

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
  if (userId) {
    await db.delete(refreshToken).where(eq(refreshToken.userId, userId));
    await db.delete(user).where(eq(user.id, userId));
  }
  if (branchId) await db.delete(branch).where(eq(branch.id, branchId));
});

describe("merchant username/password sign-in", () => {
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
});
