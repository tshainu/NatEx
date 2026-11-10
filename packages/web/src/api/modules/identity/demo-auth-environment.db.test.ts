import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../database";
import { branch, mfaFactor, otpChallenge, refreshToken, user } from "../../database/schema/identity";
import { smsLog } from "../../database/schema/shared";
import { hashSecret } from "../../shared/auth";
import { seal } from "../../shared/secret-box";
import { loginWithPassword, requestOtp, verifyOtp } from "./service";

if (!process.env.DATABASE_URL?.startsWith("file:/tmp/")) {
  throw new Error("demo-auth-environment.db.test.ts must run on a disposable file:/tmp database, never production");
}

const DEMO_PHONE = "+94711336666";
const RUN = `${process.pid}-${Date.now()}`;
const BRANCH_ID = `brn-demo-auth-${RUN}`;
const ANCHOR_ID = `usr-demo-anchor-${RUN}`;
const DEMO_USER_ID = `usr-demo-phone-${RUN}`;
const OTP_ID = `otp-demo-known-${RUN}`;
const DEVICE_ID = `demo-auth-device-${RUN}`;
const PASSWORD = "auth-demo-legacy-password";
const LEGACY_USERNAME = "actual-admin";
let legacyPasswordHash = "";

async function withNodeEnv<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

beforeAll(async () => {
  await db.insert(branch).values({
    id: BRANCH_ID,
    code: BRANCH_ID,
    name: "Demo auth test branch",
    address: "Test only",
    type: "branch",
  });
  await db.insert(user).values({
    id: ANCHOR_ID,
    branchId: BRANCH_ID,
    role: "admin",
    roles: JSON.stringify(["admin"]),
    name: "Demo auth test anchor",
    phone: `+947000${String(Date.now()).slice(-6)}`,
    username: `anchor-${RUN}`,
    status: "active",
  });
  legacyPasswordHash = await hashSecret(PASSWORD);
});

afterAll(async () => {
  const userIds = [ANCHOR_ID, DEMO_USER_ID];
  await db.delete(refreshToken).where(inArray(refreshToken.userId, userIds));
  await db.delete(mfaFactor).where(eq(mfaFactor.userId, DEMO_USER_ID));
  await db.delete(otpChallenge).where(eq(otpChallenge.phone, DEMO_PHONE));
  await db.delete(smsLog).where(eq(smsLog.toPhone, DEMO_PHONE));
  await db.delete(user).where(inArray(user.id, userIds));
  await db.delete(branch).where(eq(branch.id, BRANCH_ID));
});

describe("demo admin credentials are unavailable in production", () => {
  test("production phone login does not seed a missing demo admin", async () => {
    await withNodeEnv("production", async () => {
      await expect(requestOtp("0711336666")).rejects.toThrow(/Account for that phone number/);
    });
    const rows = await db.select({ id: user.id }).from(user).where(eq(user.phone, DEMO_PHONE));
    expect(rows).toHaveLength(0);
  });

  test("production phone OTP is not fixed or disclosed and cannot overwrite an existing account", async () => {
    await db.insert(user).values({
      id: DEMO_USER_ID,
      branchId: BRANCH_ID,
      role: "admin",
      roles: JSON.stringify(["admin"]),
      name: "Demo auth test user",
      phone: DEMO_PHONE,
      username: LEGACY_USERNAME,
      passwordHash: legacyPasswordHash,
      status: "active",
    });
    await db.insert(mfaFactor).values({
      userId: DEMO_USER_ID,
      secretEnc: await seal("JBSWY3DPEHPK3PXP"),
      confirmedAt: new Date(),
      lastStep: 0,
      seeded: false,
    });

    const result = await withNodeEnv("production", () => requestOtp("0711336666"));
    expect(result.devCode).toBeUndefined();
    const [unchanged] = await db.select().from(user).where(eq(user.id, DEMO_USER_ID));
    expect(unchanged?.username).toBe(LEGACY_USERNAME);
    expect(unchanged?.passwordHash).toBe(legacyPasswordHash);

    await expect(
      withNodeEnv("production", () => loginWithPassword({ username: "demo", password: "demo123" })),
    ).rejects.toThrow("Incorrect username or password.");

    const passwordSession = await withNodeEnv("production", () =>
      loginWithPassword({ username: LEGACY_USERNAME, password: PASSWORD, deviceId: DEVICE_ID }),
    );
    expect(passwordSession.mfa.state).toBe("challenge");

    await db.insert(otpChallenge).values({
      id: OTP_ID,
      phone: DEMO_PHONE,
      codeHash: await hashSecret("123456"),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const otpSession = await withNodeEnv("production", () =>
      verifyOtp({ challengeId: OTP_ID, code: "123456", deviceId: DEVICE_ID }),
    );
    expect(otpSession.mfa.state).toBe("challenge");
    expect(otpSession.scope).toBeNull();
  });

  test("explicit test mode retains the seeded demo login flow", async () => {
    const response = await withNodeEnv("test", () => requestOtp("0711336666"));
    expect(response.devCode).toMatch(/^\d{6}$/);
    const session = await withNodeEnv("test", () =>
      verifyOtp({ challengeId: response.challengeId, code: response.devCode!, deviceId: DEVICE_ID }),
    );
    expect(session.mfa.state).toBe("none");
  });
});
