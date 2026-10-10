/**
 * §2 TOTP MFA through the real module against the live database: replay
 * refusal, recovery-code single use, and the production guards on development
 * seed factors (a seeded factor is refused, no dev code is offered, and seeding
 * itself throws).
 *
 * Fixtures: two "[MFA test]" ops users in brn_cmb_central with phones in the
 * +9470000xxxx range, removed in afterAll.
 *
 * Run: `bun --env-file=../../.env test src/api/modules/identity/mfa.db.test.ts`
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { ORPCError } from "@orpc/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../database";
import { mfaFactor, mfaRecoveryCode, user } from "../../database/schema/identity";
import { seal } from "../../shared/secret-box";
import { stepAt, totpAt } from "../../shared/totp";
import {
  confirmEnrolment,
  devCodeFor,
  devTotpSecret,
  getFactor,
  mfaRequiredFor,
  mfaRequiredForAny,
  seedDevMfaFactors,
  startEnrolment,
  verifyChallenge,
} from "./mfa";

setDefaultTimeout(120_000);

const RUN = Date.now().toString(36).toUpperCase();
const SUFFIX = String(Date.now()).slice(-6);
const REAL = `usr_mfatest_real_${RUN}`;
const SEEDED = `usr_mfatest_seed_${RUN}`;

async function problemOf(p: Promise<unknown>): Promise<{ status: number; message: string; mfa?: string }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ORPCError) {
      const data = (err.data ?? {}) as { status?: number; mfa?: string };
      return { status: data.status ?? err.status, message: err.message, mfa: data.mfa };
    }
    throw err;
  }
  throw new Error("expected a rejection");
}

function withNodeEnv<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  return fn().finally(() => {
    process.env.NODE_ENV = prev;
  });
}

beforeAll(async () => {
  await db.insert(user).values([
    { id: REAL, branchId: "brn_cmb_central", role: "ops", name: "[MFA test] real", phone: `+9470001${SUFFIX.slice(-4)}` },
    { id: SEEDED, branchId: "brn_cmb_central", role: "ops", name: "[MFA test] seeded", phone: `+9470002${SUFFIX.slice(-4)}` },
  ]);
  await db.insert(mfaFactor).values({
    userId: SEEDED,
    secretEnc: await seal(await devTotpSecret(SEEDED)),
    confirmedAt: new Date(),
    lastStep: 0,
    seeded: true,
  });
});

afterAll(async () => {
  const ids = [REAL, SEEDED];
  await db.delete(mfaRecoveryCode).where(inArray(mfaRecoveryCode.userId, ids));
  await db.delete(mfaFactor).where(inArray(mfaFactor.userId, ids));
  await db.delete(user).where(inArray(user.id, ids));
});

describe("real enrolment", () => {
  let secret = "";
  let recovery: string[] = [];

  test("enrol, confirm with the current code, and get 10 distinct recovery codes", async () => {
    const started = await startEnrolment(REAL, "MFA test");
    secret = started.secret;
    const factor = await getFactor(REAL);
    expect(factor?.confirmedAt).toBeNull();
    expect(factor?.secretEnc).not.toContain(secret); // sealed at rest
    const step = stepAt(Date.now());
    const confirmed = await confirmEnrolment(REAL, await totpAt(secret, step - 1));
    recovery = confirmed.recoveryCodes;
    expect(recovery).toHaveLength(10);
    expect(new Set(recovery).size).toBe(10);
  });

  test("a code at or before the last accepted step is a replay", async () => {
    const factor = await getFactor(REAL);
    const sameStep = await totpAt(secret, factor!.lastStep);
    const p = await problemOf(verifyChallenge(REAL, sameStep));
    expect(p.status).toBe(400);
    expect(p.mfa).toBe("replay");
  });

  test("a later step in the window is accepted once, then refused", async () => {
    const factor = await getFactor(REAL);
    const next = await totpAt(secret, factor!.lastStep + 1);
    expect((await verifyChallenge(REAL, next)).method).toBe("totp");
    const again = await problemOf(verifyChallenge(REAL, next));
    expect(again.mfa).toBe("replay");
  });

  test("a recovery code works once, in any case and with or without the dash", async () => {
    const code = recovery[0];
    const ok = await verifyChallenge(REAL, code.toLowerCase().replace("-", ""));
    expect(ok).toEqual({ method: "recovery", recoveryCodesRemaining: 9 });
    const again = await problemOf(verifyChallenge(REAL, code));
    expect(again.status).toBe(400);
    expect(again.mfa).toBe("wrong_recovery");
  });

  test("a real (non-seeded) factor never offers a dev code", async () => {
    expect(await devCodeFor((await getFactor(REAL))!)).toBeNull();
  });
});

describe("HR role MFA enforcement", () => {
  test("HR always requires authenticator MFA, including when held alongside another role", async () => {
    expect(await mfaRequiredFor("hr")).toBe(true);
    expect(await mfaRequiredForAny(["rider", "hr"])).toBe(true);
  });
});

describe("development seed factors", () => {
  test("outside production a seeded factor offers a code that verifies", async () => {
    const code = await devCodeFor((await getFactor(SEEDED))!);
    expect(code).toMatch(/^\d{6}$/);
    expect((await verifyChallenge(SEEDED, code!)).method).toBe("totp");
  });

  test("near a step boundary the dev code is never one that is about to expire", async () => {
    const factor = (await getFactor(SEEDED))!;
    const secret = await devTotpSecret(SEEDED);
    // A step well after anything used, so every window step is still free.
    const step = Math.max(factor.lastStep, stepAt(Date.now())) + 10;
    const early = step * 30_000 + 1_000;
    const late = step * 30_000 + 27_000;
    expect(await devCodeFor({ ...factor }, early)).toBe(await totpAt(secret, step - 1));
    expect(await devCodeFor({ ...factor }, late)).toBe(await totpAt(secret, step));
  });

  test("in production a seeded factor offers no dev code", async () => {
    const factor = (await getFactor(SEEDED))!;
    expect(await withNodeEnv("production", () => devCodeFor(factor))).toBeNull();
  });

  test("in production a seeded factor is refused even with a correct code (403)", async () => {
    const factor = (await getFactor(SEEDED))!;
    const code = await totpAt(await devTotpSecret(SEEDED), Math.max(factor.lastStep + 1, stepAt(Date.now())));
    const p = await withNodeEnv("production", () => problemOf(verifyChallenge(SEEDED, code)));
    expect(p.status).toBe(403);
    // and nothing was consumed
    expect((await getFactor(SEEDED))!.lastStep).toBe(factor.lastStep);
  });

  test("seeding dev factors throws in production and writes nothing", async () => {
    const before = await db.select({ userId: mfaFactor.userId }).from(mfaFactor);
    await expect(withNodeEnv("production", () => seedDevMfaFactors())).rejects.toThrow(/NODE_ENV=production/);
    const after = await db.select({ userId: mfaFactor.userId }).from(mfaFactor);
    expect(after.length).toBe(before.length);
  });

  test("the seeded factor row is flagged", async () => {
    const [row] = await db.select({ seeded: mfaFactor.seeded }).from(mfaFactor).where(eq(mfaFactor.userId, SEEDED));
    expect(row.seeded).toBe(true);
  });
});
