import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "../database";
import { branch, mfaFactor, user } from "../database/schema/identity";
import { codEntry } from "../database/schema/cod";
import { cod } from "./cod";
import { mfa } from "./mfa";
import { seal } from "../shared/secret-box";
import { signAccessToken } from "../shared/auth";

const TEST_DATABASE_URL = "file:/tmp/natex-ops-admin-validation-20261108.sqlite";
if (process.env.DATABASE_URL !== TEST_DATABASE_URL) {
  throw new Error(`security-integration.db.test.ts requires DATABASE_URL=${TEST_DATABASE_URL}`);
}

const run = `${process.pid}-${Date.now()}`;
const branchId = `brn-security-test-${run}`;
const otherBranchId = `brn-security-other-${run}`;
const riderId = `usr-security-rider-${run}`;
const transportId = `usr-security-transport-${run}`;
const riderEntryId = `cod-security-rider-${run}`;
const otherEntryId = `cod-security-other-${run}`;

async function token(input: {
  userId: string;
  role: "rider" | "transport" | "ops";
  roles: ("rider" | "transport" | "ops")[];
  scope?: "rider" | "transport";
}) {
  return (await signAccessToken({
    sub: input.userId,
    role: input.role,
    roles: input.roles,
    branchId,
    name: input.role === "rider" ? "Security test rider" : "Security test transport",
    mfa: input.scope ? "none" : "verified",
    scope: input.scope ? { kind: "mobile", role: input.scope, mfaExempt: true } : null,
  })).token;
}

function clientFor(router: any, accessToken: string): any {
  return createRouterClient(router, {
    context: { headers: new Headers({ authorization: `Bearer ${accessToken}` }) },
  });
}

beforeAll(async () => {
  await db.insert(branch).values([
    { id: branchId, code: branchId, name: "Security test branch", address: "Test only", type: "branch" },
    { id: otherBranchId, code: otherBranchId, name: "Security test other branch", address: "Test only", type: "branch" },
  ]);
  await db.insert(user).values([
    {
      id: riderId,
      branchId,
      name: "Security test rider",
      role: "ops",
      roles: JSON.stringify(["ops", "rider"]),
      phone: `+9471${String(Date.now()).slice(-8)}`,
    },
    {
      id: transportId,
      branchId,
      name: "Security test transport",
      role: "transport",
      roles: JSON.stringify(["transport"]),
      phone: `+9472${String(Date.now() + 1).slice(-8)}`,
    },
  ]);
  await db.insert(mfaFactor).values({
    userId: riderId,
    secretEnc: await seal("JBSWY3DPEHPK3PXP"),
    confirmedAt: new Date(),
    lastStep: 0,
    seeded: false,
  });
  await db.insert(codEntry).values([
    {
      id: riderEntryId,
      seq: 990000,
      type: "COLLECT",
      amountCents: 500,
      debitAccount: "rider_cash",
      creditAccount: "merchant_payable",
      riderId,
      branchId,
      parcelId: `parcel-security-rider-${run}`,
      awb: `AWB-SECURITY-RIDER-${run}`,
      ts: new Date(),
    },
    {
      id: otherEntryId,
      seq: 990001,
      type: "COLLECT",
      amountCents: 700,
      debitAccount: "rider_cash",
      creditAccount: "merchant_payable",
      riderId: `rider-other-${run}`,
      branchId: otherBranchId,
      parcelId: `parcel-security-other-${run}`,
      awb: `AWB-SECURITY-OTHER-${run}`,
      ts: new Date(),
    },
  ]);
});

afterAll(async () => {
  await db.delete(codEntry).where(inArray(codEntry.id, [riderEntryId, otherEntryId]));
  await db.delete(mfaFactor).where(eq(mfaFactor.userId, riderId));
  await db.delete(user).where(inArray(user.id, [riderId, transportId]));
  await db.delete(branch).where(inArray(branch.id, [branchId, otherBranchId]));
});

describe("security integration route regressions", () => {
  test("mobile rider keeps own COD reads but cannot query another rider or the desk registers", async () => {
    const riderClient = clientFor(cod, await token({ userId: riderId, role: "rider", roles: ["rider"], scope: "rider" }));

    const entries = await riderClient.entries({});
    expect(entries.rows.map((row: { id: string }) => row.id)).toContain(riderEntryId);
    expect(entries.rows.map((row: { id: string }) => row.id)).not.toContain(otherEntryId);
    expect((await riderClient.riderCash({ riderId })).riderId).toBe(riderId);
    expect((await riderClient.myUndeposited({})).map((row: { id: string }) => row.id)).toEqual([riderEntryId]);

    await expect(riderClient.entries({ riderId: `rider-other-${run}` })).rejects.toThrow();
    await expect(riderClient.riderCash({ riderId: `rider-other-${run}` })).rejects.toThrow();
    await expect(riderClient.cashCeiling({ riderId: `rider-other-${run}` })).rejects.toThrow();
    await expect(riderClient.myUndeposited({ riderId: `rider-other-${run}` })).rejects.toThrow();
    await expect(riderClient.stale({})).rejects.toThrow();
    await expect(riderClient.deposits({})).rejects.toThrow();
    await expect(riderClient.depositPage({})).rejects.toThrow();
  });

  test("transport mobile sessions cannot reach COD ledger or cash routes", async () => {
    const transportClient = clientFor(cod, await token({ userId: transportId, role: "transport", roles: ["transport"], scope: "transport" }));

    await expect(transportClient.entries({})).rejects.toThrow();
    await expect(transportClient.riderCash({ riderId })).rejects.toThrow();
    await expect(transportClient.cashCeiling({ riderId })).rejects.toThrow();
    await expect(transportClient.myUndeposited({})).rejects.toThrow();
    await expect(transportClient.declareDeposit({
      riderId,
      branchId,
      declaredCents: 500,
      entryIds: [riderEntryId],
    })).rejects.toThrow();
  });

  test("desk COD register remains available while unfiltered field access is refused", async () => {
    const opsClient = clientFor(cod, await token({ userId: riderId, role: "ops", roles: ["ops", "rider"] }));
    expect(Array.isArray(await opsClient.deposits({}))).toBe(true);
    expect((await opsClient.depositPage({})).page).toBe(1);

    await expect(opsClient.declareDeposit({
      riderId,
      branchId: otherBranchId,
      declaredCents: 500,
      entryIds: [riderEntryId],
    })).rejects.toThrow();
  });

  test("a mobile rider cannot regenerate recovery codes for a dual-role account", async () => {
    const riderClient = clientFor(mfa, await token({ userId: riderId, role: "rider", roles: ["rider"], scope: "rider" }));
    await expect(riderClient.regenerateRecoveryCodes({ code: "123456" })).rejects.toThrow();
  });
});
