import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { db } from "../../database";
import { branch, user, mfaFactor, refreshToken, otpChallenge } from "../../database/schema/identity";
import { base } from "../../__core/app";
import { withAuth, requireRole } from "../../middleware/auth";
import { hashSecret, fingerprint, verifyAccessToken } from "../../shared/auth";
import { seal } from "../../shared/secret-box";
import { loginWithPassword, rotateRefresh, verifyOtp } from "./service";

if (!process.env.DATABASE_URL?.startsWith("file:/tmp/")) {
  throw new Error("mobile-session.db.test.ts must run on a disposable file:/tmp database, never production");
}
const run = `${process.pid}-${Date.now()}`;
const branchId = `brn-mobile-test-${run}`;
const userId = `usr-mobile-test-${run}`;
const username = `mobile-test-${run}`;
const password = "test-only-mobile-password";
const deviceId = `android-mobile-test-${run}`;
const phone = `+9470${String(Date.now()).slice(-7)}`;
const probe = {
  field: base.use(withAuth).use(requireRole("rider")).handler(({ context }) => context.principal),
  ops: base.use(withAuth).use(requireRole("ops")).handler(() => "forbidden back-office result"),
};
const clientFor = (token: string, activeRole?: string) => createRouterClient(probe, {
  context: { headers: new Headers({ authorization: `Bearer ${token}`, ...(activeRole ? { "x-natex-active-role": activeRole } : {}) }) },
});

beforeAll(async () => {
  await db.insert(branch).values({ id: branchId, code: branchId, name: "Test Mannar branch", address: "Test only", type: "branch" });
  await db.insert(user).values({ id: userId, branchId, name: "Test dual-role staff", role: "ops", roles: JSON.stringify(["ops", "transport", "rider"]), phone, username, passwordHash: await hashSecret(password) });
  await db.insert(mfaFactor).values({ userId, secretEnc: await seal("JBSWY3DPEHPK3PXP"), confirmedAt: new Date(), seeded: false });
});
afterAll(async () => {
  await db.delete(refreshToken).where(eq(refreshToken.userId, userId));
  await db.delete(mfaFactor).where(eq(mfaFactor.userId, userId));
  await db.delete(otpChallenge).where(eq(otpChallenge.phone, phone));
  await db.delete(user).where(eq(user.id, userId));
  await db.delete(branch).where(eq(branch.id, branchId));
});

describe("mobile MFA exemption is a signed least-privilege field session", () => {
  test("an enrolled primary-ops account signs into rider mobile without changing web MFA", async () => {
    const mobile = await loginWithPassword({ username, password, deviceId, context: { client: "mobile" } });
    expect(mobile.mfa.state).toBe("none");
    expect(mobile.scope).toEqual({ kind: "mobile", role: "rider", mfaExempt: true });
    expect(mobile.user.roles).toEqual(["rider"]);
    const claims = await verifyAccessToken(mobile.accessToken);
    expect(claims?.roles).toEqual(["rider"]);
    const principal = await clientFor(mobile.accessToken).field();
    expect(principal.role).toBe("rider");
    expect(principal.roles).toEqual(["rider"]);
    await expect(clientFor(mobile.accessToken).ops()).rejects.toThrow();
    await expect(clientFor(mobile.accessToken, "ops").field()).rejects.toThrow();
    const web = await loginWithPassword({ username, password, deviceId });
    expect(web.mfa.state).toBe("challenge");
    expect(web.scope).toBeNull();
    expect(web.user.roles).toEqual(["ops", "transport", "rider"]);
    await expect(clientFor(web.accessToken).ops()).rejects.toThrow();
  });

  test("mobile OTP sign-in follows the same scoped policy", async () => {
    const challengeId = `otp-mobile-test-${run}`;
    await db.insert(otpChallenge).values({ id: challengeId, phone, codeHash: await hashSecret("123456"), expiresAt: new Date(Date.now() + 60_000) });
    const mobile = await verifyOtp({ challengeId, code: "123456", deviceId, context: { client: "mobile", role: "rider" } });
    expect(mobile.user.roles).toEqual(["rider"]);
    expect(mobile.mfa.state).toBe("none");
    await expect(clientFor(mobile.accessToken).ops()).rejects.toThrow();
  });

  test("mobile context cannot request a back-office role", async () => {
    await expect(loginWithPassword({ username, password, deviceId, context: { client: "mobile", role: "ops" } })).rejects.toThrow();
  });

  test("refresh preserves field-only scope and field offline idle exemption", async () => {
    const mobile = await loginWithPassword({ username, password, deviceId, context: { client: "mobile", role: "rider" } });
    await db.update(refreshToken).set({ createdAt: new Date(Date.now() - 3 * 86_400_000) }).where(and(eq(refreshToken.userId, userId), eq(refreshToken.tokenHash, await fingerprint(mobile.refreshToken))));
    const refreshed = await rotateRefresh(mobile.refreshToken);
    expect(refreshed.scope).toEqual(mobile.scope);
    expect(refreshed.user.roles).toEqual(["rider"]);
    expect(refreshed.mfa.state).toBe("none");
    await expect(clientFor(refreshed.accessToken).ops()).rejects.toThrow();
    await expect(rotateRefresh(mobile.refreshToken)).rejects.toThrow();
  });

  test("removing the field role invalidates the scoped access and refresh tokens", async () => {
    const mobile = await loginWithPassword({ username, password, deviceId, context: { client: "mobile", role: "rider" } });
    await db.update(user).set({ roles: JSON.stringify(["ops"]), role: "ops" }).where(eq(user.id, userId));
    await expect(clientFor(mobile.accessToken).field()).rejects.toThrow();
    await expect(rotateRefresh(mobile.refreshToken)).rejects.toThrow();
  });
});
