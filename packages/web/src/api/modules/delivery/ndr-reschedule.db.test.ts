import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const dbPath = join(tmpdir(), `natex-ndr-sms-${process.pid}-${Date.now()}.db`);
const databaseUrl = `file:${dbPath}`;
process.env.DATABASE_URL = databaseUrl;
delete process.env.DATABASE_AUTH_TOKEN;
process.env.NODE_ENV = "test";
process.env.SMS_DISABLE_ALL = "true";
delete process.env.SMS_EXECUTION_URL;

const { createClient } = await import("@libsql/client");
const setupClient = createClient({ url: databaseUrl });
const ddl = [
  `CREATE TABLE parcels_parcel (
    id TEXT PRIMARY KEY, awb TEXT NOT NULL UNIQUE, merchant_id TEXT, branch_id TEXT NOT NULL,
    status TEXT NOT NULL, weight_grams INTEGER NOT NULL, length_cm INTEGER, width_cm INTEGER, height_cm INTEGER,
    description TEXT, declared_value_cents INTEGER DEFAULT 0, cod_amount_cents INTEGER NOT NULL DEFAULT 0,
    cod_locked_at INTEGER, origin_address TEXT NOT NULL, origin_lat_e6 INTEGER, origin_lng_e6 INTEGER,
    consignee_name TEXT NOT NULL, consignee_phone TEXT NOT NULL, dest_address TEXT NOT NULL,
    dest_lat_e6 INTEGER, dest_lng_e6 INTEGER, dest_zone_id TEXT,
    delivery_attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE parcels_parcel_event (
    id TEXT PRIMARY KEY, parcel_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
    actor_id TEXT, actor_name TEXT, actor_role TEXT, device_id TEXT, lat_e6 INTEGER, lng_e6 INTEGER,
    notes TEXT, client_id TEXT, ts INTEGER NOT NULL
  )`,
  `CREATE TABLE delivery_ndr (
    id TEXT PRIMARY KEY, parcel_id TEXT NOT NULL, awb TEXT NOT NULL, branch_id TEXT NOT NULL,
    merchant_id TEXT, attempts INTEGER NOT NULL DEFAULT 1, last_reason_code TEXT, last_reason_label TEXT,
    state TEXT NOT NULL DEFAULT 'open', merchant_instruction TEXT, instruction_notes TEXT,
    instructed_by_name TEXT, instructed_at INTEGER, new_address TEXT, new_phone TEXT, reattempt_date TEXT,
    reschedule_sms_key TEXT, reschedule_sms_state TEXT, sla_due_at INTEGER, raised_at INTEGER NOT NULL,
    actioned_at INTEGER, actioned_by_name TEXT, closed_at INTEGER, close_reason TEXT
  )`,
  `CREATE TABLE delivery_reason_code (
    code TEXT PRIMARY KEY, label TEXT NOT NULL, category TEXT NOT NULL,
    counts_as_attempt INTEGER NOT NULL DEFAULT 1, allows_reattempt INTEGER NOT NULL DEFAULT 1,
    triggers_rto INTEGER NOT NULL DEFAULT 0, notify_consignee INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 100, active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE shared_outbox (
    id TEXT PRIMARY KEY, topic TEXT NOT NULL, payload_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, available_at INTEGER NOT NULL,
    processed_at INTEGER, created_at INTEGER NOT NULL
  )`,
];
for (const statement of ddl) await setupClient.execute(statement);

const { db } = await import("../../database");
const { parcel } = await import("../../database/schema/parcels");
const { ndr, reasonCode } = await import("../../database/schema/delivery");
const { outbox } = await import("../../database/schema/shared");
const ndrService = await import("./ndr");
const worker = await import("../../jobs/worker");
const RUN = randomUUID().replace(/-/g, "").slice(0, 10);
const BRANCH = `brn_sms_${RUN}`;
const actor = {
  userId: `usr_sms_${RUN}`,
  name: "NDR SMS test ops",
  role: "admin" as const,
  roles: ["admin" as const],
  branchId: BRANCH,
  merchantId: null,
  deviceId: null,
};
const ids = {
  reattemptNdr: `ndr_retry_${RUN}`,
  reattemptParcel: `parcel_retry_${RUN}`,
  addressNdr: `ndr_addr_${RUN}`,
  addressParcel: `parcel_addr_${RUN}`,
  suppressedNdr: `ndr_suppress_${RUN}`,
  suppressedParcel: `parcel_suppress_${RUN}`,
};

async function addFixture(id: string, parcelId: string, awb: string, reasonCode = "ADDRESS_INCOMPLETE", reasonLabel = "Address incomplete or unreadable") {
  const now = new Date();
  await db.insert(parcel).values({
    id: parcelId,
    awb,
    merchantId: null,
    branchId: BRANCH,
    status: "AtDestHub",
    weightGrams: 500,
    originAddress: "Origin",
    consigneeName: "Test Receiver",
    consigneePhone: "+94770000001",
    destAddress: "Original delivery address",
    deliveryAttempts: 1,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(ndr).values({
    id,
    parcelId,
    awb,
    branchId: BRANCH,
    merchantId: null,
    attempts: 1,
    lastReasonCode: reasonCode,
    lastReasonLabel: reasonLabel,
    state: "open",
    raisedAt: now,
  });
}

beforeAll(async () => {
  await db.insert(reasonCode).values({
    code: "ADDRESS_INCOMPLETE",
    label: "Address incomplete or unreadable",
    category: "address",
    countsAsAttempt: true,
    allowsReattempt: false,
    triggersRto: false,
    notifyConsignee: true,
    sortOrder: 60,
    active: true,
  });
  await db.insert(reasonCode).values({
    code: "CONSIGNEE_UNREACHABLE",
    label: "Phone not answered or switched off",
    category: "consignee",
    countsAsAttempt: true,
    allowsReattempt: true,
    triggersRto: false,
    notifyConsignee: true,
    sortOrder: 10,
    active: true,
  });
  await addFixture(ids.reattemptNdr, ids.reattemptParcel, "NX2611057001", "CONSIGNEE_UNREACHABLE", "Phone not answered or switched off");
  await addFixture(ids.addressNdr, ids.addressParcel, "NX2611057002");
  await addFixture(ids.suppressedNdr, ids.suppressedParcel, "NX2611057003");
});

afterAll(async () => {
  await setupClient.close();
});

describe("NDR receiver reschedule SMS", () => {
  test("atomically queues only once per schedule with receiver's corrected phone and a public fixed-template reason", async () => {
    const input = {
      ndrId: ids.addressNdr,
      instruction: "address_change" as const,
      notes: "INTERNAL: receiver called from +94771234567; keep this private",
      newAddress: "Corrected delivery address",
      newPhone: "+94770000099",
      reattemptDate: "2026-11-12",
    };
    const first = await ndrService.instructNdr(input, actor);
    expect(first.ndr.state).toBe("reattempt_scheduled");
    expect(first.parcel.consigneePhone).toBe("+94770000099");

    const queuedBeforeReplay = (await db.select().from(outbox)).filter((row) => {
      if (row.topic !== "sms.send") return false;
      const body = JSON.parse(row.payloadJson) as { ndrId?: string };
      return body.ndrId === ids.addressNdr;
    });
    expect(queuedBeforeReplay).toHaveLength(1);
    const payload = JSON.parse(queuedBeforeReplay[0]!.payloadJson) as Record<string, unknown>;
    expect(payload).toMatchObject({
      purpose: "reschedule",
      ndrId: ids.addressNdr,
      toPhone: "+94770000099",
      trackingNumber: "NX2611057002",
      newDate: "2026-11-12",
      reason: "Address incomplete or unreadable",
    });
    expect(JSON.stringify(payload)).not.toContain("INTERNAL");
    expect(JSON.stringify(payload)).not.toContain("+94771234567");

    await ndrService.instructNdr(input, actor);
    const queuedAfterReplay = (await db.select().from(outbox)).filter((row) => {
      if (row.topic !== "sms.send") return false;
      return (JSON.parse(row.payloadJson) as { ndrId?: string }).ndrId === ids.addressNdr;
    });
    expect(queuedAfterReplay).toHaveLength(1);

    const sent: { to: string; body: string; purpose: string }[] = [];
    const sender = async (message: { to: string; body: string; purpose: "otp" | "pod" | "delivery_failure" | "arrival_notice" | "merchant_registration" | "reschedule" }) => {
      sent.push(message);
      return { logId: "sms-test", state: "sent" as const, gatewayRef: null, raw: "accepted" };
    };
    const job = payload as unknown as Parameters<typeof worker.dispatchRescheduleSms>[0];
    const oldEnv = { nodeEnv: process.env.NODE_ENV, disable: process.env.SMS_DISABLE_ALL };
    process.env.NODE_ENV = "production";
    process.env.SMS_DISABLE_ALL = "false";
    try {
      await worker.dispatchRescheduleSms(job, sender);
      await worker.dispatchRescheduleSms(job, sender);
      await ndrService.instructNdr(input, actor);
      await worker.dispatchRescheduleSms(job, sender);
    } finally {
      process.env.NODE_ENV = oldEnv.nodeEnv;
      if (oldEnv.disable === undefined) delete process.env.SMS_DISABLE_ALL;
      else process.env.SMS_DISABLE_ALL = oldEnv.disable;
    }
    expect(sent).toEqual([{
      to: "+94770000099",
      body: "Tracking NX2611057002. Delivery rescheduled to 2026-11-12. Reason: Address incomplete or unreadable.",
      purpose: "reschedule",
    }]);
    const completedNdr = await ndrService.getNdr(ids.addressNdr);
    expect(completedNdr?.rescheduleSmsState).toBe("sent");
  });

  test("reattempt scheduling informs the existing receiver only after scheduling", async () => {
    const result = await ndrService.instructNdr({
      ndrId: ids.reattemptNdr,
      instruction: "reattempt",
      reattemptDate: "2026-11-13",
    }, actor);
    expect(result.ndr.state).toBe("reattempt_scheduled");
    const row = (await db.select().from(outbox)).find((candidate) => {
      if (candidate.topic !== "sms.send") return false;
      return (JSON.parse(candidate.payloadJson) as { ndrId?: string }).ndrId === ids.reattemptNdr;
    });
    expect(row).toBeDefined();
    expect(JSON.parse(row!.payloadJson)).toMatchObject({
      purpose: "reschedule",
      ndrId: ids.reattemptNdr,
      toPhone: "+94770000001",
      trackingNumber: "NX2611057001",
      newDate: "2026-11-13",
      reason: "Phone not answered or switched off",
    });
  });

  test("SMS_DISABLE_ALL remains an independent production kill switch", async () => {
    const result = await ndrService.instructNdr({
      ndrId: ids.suppressedNdr,
      instruction: "address_change",
      newPhone: "+94770000088",
      reattemptDate: "2026-11-14",
    }, actor);
    const job = (await db.select().from(outbox)).find((candidate) => {
      if (candidate.topic !== "sms.send") return false;
      return (JSON.parse(candidate.payloadJson) as { ndrId?: string }).ndrId === ids.suppressedNdr;
    });
    expect(job).toBeDefined();
    const sent: unknown[] = [];
    const sender = async (message: unknown) => {
      sent.push(message);
      return { logId: "sms-test", state: "sent" as const, gatewayRef: null, raw: "accepted" };
    };
    const oldEnv = { nodeEnv: process.env.NODE_ENV, disable: process.env.SMS_DISABLE_ALL };
    process.env.NODE_ENV = "production";
    process.env.SMS_DISABLE_ALL = "true";
    try {
      await worker.dispatchRescheduleSms(
        JSON.parse(job!.payloadJson) as Parameters<typeof worker.dispatchRescheduleSms>[0],
        sender as never,
      );
    } finally {
      process.env.NODE_ENV = oldEnv.nodeEnv;
      if (oldEnv.disable === undefined) delete process.env.SMS_DISABLE_ALL;
      else process.env.SMS_DISABLE_ALL = oldEnv.disable;
    }
    expect(sent).toEqual([]);
    expect((await ndrService.getNdr(result.ndr.id))?.rescheduleSmsState).toBe("suppressed");
  });
  test("a canceled schedule cannot produce a late receiver SMS", async () => {
    const id = `ndr_cancel_${RUN}`;
    await addFixture(id, `parcel_cancel_${RUN}`, "NX2611057004");
    await ndrService.instructNdr({ ndrId: id, instruction: "address_change", newPhone: "+94770000077", reattemptDate: "2026-11-15" }, actor);
    const queued = (await db.select().from(outbox)).find(row => JSON.parse(row.payloadJson).ndrId === id)!;
    await ndrService.closeNdr({ ndrId: id, closeReason: "Schedule canceled before notification" }, actor);
    const sent: unknown[] = [];
    await worker.dispatchRescheduleSms(JSON.parse(queued.payloadJson), async message => {
      sent.push(message);
      return { logId: "test", state: "sent", gatewayRef: null, raw: "accepted" };
    });
    expect(sent).toEqual([]);
  });
});
