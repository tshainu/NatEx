import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Always override any inherited/.env database before importing application modules.
const sqlitePath = join(tmpdir(), `natex-registration-${process.pid}-${Date.now()}.db`);
const databaseUrl = `file:${sqlitePath}`;
process.env.DATABASE_URL = databaseUrl;
delete process.env.DATABASE_AUTH_TOKEN;
process.env.NODE_ENV = "test";
process.env.SMS_DISABLE_ALL = "true";
delete process.env.SMS_EXECUTION_URL;

const { createClient } = await import("@libsql/client");
const setupClient = createClient({ url: databaseUrl });
const ddl = [
  `CREATE TABLE merchants_merchant (
    id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, pickup_rider_id TEXT, name TEXT NOT NULL,
    vat_no TEXT, address TEXT NOT NULL, lat_e6 INTEGER, lng_e6 INTEGER, contact_name TEXT NOT NULL,
    contact_phone TEXT NOT NULL, rate_card_id TEXT, cod_enabled INTEGER NOT NULL DEFAULT 1,
    pod_policy TEXT NOT NULL DEFAULT 'signature', status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE merchants_registration_request (
    id TEXT PRIMARY KEY, submission_id TEXT NOT NULL, business_name TEXT NOT NULL, contact_name TEXT NOT NULL,
    phone TEXT NOT NULL, email TEXT NOT NULL, district TEXT NOT NULL, business_type TEXT NOT NULL,
    monthly_volume TEXT NOT NULL, notes TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', merchant_id TEXT,
    created_at INTEGER NOT NULL, converted_at INTEGER, receipt_sms_state TEXT NOT NULL DEFAULT 'queued',
    confirmation_sms_state TEXT NOT NULL DEFAULT 'not_queued', sms_consent INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX merchants_registration_submission_idx ON merchants_registration_request(submission_id)`,
  `CREATE INDEX merchants_registration_status_created_idx ON merchants_registration_request(status, created_at)`,
  `CREATE TABLE merchants_registration_cooldown (phone TEXT PRIMARY KEY, cooldown_until INTEGER NOT NULL)`,
  `CREATE TABLE shared_outbox (
    id TEXT PRIMARY KEY, topic TEXT NOT NULL, payload_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, available_at INTEGER NOT NULL, processed_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE shared_rate_limit (bucket TEXT PRIMARY KEY, tokens INTEGER NOT NULL, refilled_at INTEGER NOT NULL)`,
  `CREATE TABLE shared_sms_log (
    id TEXT PRIMARY KEY, to_phone TEXT NOT NULL, sender_id TEXT NOT NULL, body TEXT NOT NULL,
    purpose TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', gateway_ref TEXT, raw_response TEXT,
    raw_dlr TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE identity_branch (
    id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, address TEXT NOT NULL,
    lat_e6 INTEGER NOT NULL, lng_e6 INTEGER NOT NULL, type TEXT NOT NULL, counter_rate_card_id TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE identity_user (
    id TEXT PRIMARY KEY, branch_id TEXT NOT NULL REFERENCES identity_branch(id), role TEXT NOT NULL,
    roles TEXT NOT NULL DEFAULT '', username TEXT UNIQUE, password_hash TEXT, name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE, device_id TEXT, status TEXT NOT NULL DEFAULT 'active', merchant_id TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE merchants_rate_card (
    id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    placeholder INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE merchants_rate_card_version (
    id TEXT PRIMARY KEY, rate_card_id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
    volumetric_divisor INTEGER NOT NULL DEFAULT 5000, rounding_grams INTEGER NOT NULL DEFAULT 500,
    note TEXT, activated_at INTEGER, updated_at INTEGER NOT NULL, updated_by_name TEXT, created_at INTEGER NOT NULL
  )`,
];
for (const statement of ddl) await setupClient.execute(statement);

const { call } = await import("@orpc/server");
const { db } = await import("../../database");
const { branch, user } = await import("../../database/schema/identity");
const { merchant } = await import("../../database/schema/merchants");
const { outbox, smsLog } = await import("../../database/schema/shared");
const { registrationInputSchema, submitRegistration } = await import("../../routes/merchants");
const merchantsService = await import("./service");
const { onboardMerchant } = await import("./onboarding");
const { sendSms } = await import("../../shared/sms");
const { dispatchMerchantRegistrationSms } = await import("../../jobs/worker");
const { MERCHANT_REGISTRATION_ACCEPTED_SMS, MERCHANT_REGISTRATION_RECEIPT_SMS } = await import("../../shared/sms-policy");

const RUN = `${process.pid}_${Date.now()}`;
const BRANCH_ID = `brn_registration_${RUN}`;
const ACTOR = {
  userId: `usr_admin_${RUN}`,
  name: "Registration integration test admin",
  role: "admin" as const,
  roles: ["admin" as const],
  branchId: BRANCH_ID,
  merchantId: null,
  deviceId: null,
};
let phoneCounter = 0;
let ipCounter = 0;
function testPhone(): string {
  phoneCounter += 1;
  return `+947${String(Date.now() + phoneCounter).slice(-8)}`;
}
function registrationInput(overrides: Record<string, unknown> = {}) {
  return {
    businessName: "Test merchant business",
    contactName: "Test contact person",
    phone: testPhone(),
    email: "merchant-test@example.invalid",
    district: "Colombo",
    businessType: "Retail",
    monthlyVolume: "100-250 parcels",
    notes: "Please contact during business hours.",
    smsConsent: true,
    website: "",
    submissionId: randomUUID(),
    ...overrides,
  };
}
function rpcContext(ip?: string) {
  ipCounter += 1;
  const clientIp = ip ?? `198.51.100.${(ipCounter % 200) + 20}`;
  return { context: { headers: new Headers({ "x-real-ip": clientIp }) } };
}
async function createRequest(overrides: Record<string, unknown> = {}) {
  const input = registrationInput(overrides);
  await call(submitRegistration, input as never, rpcContext());
  const page = await merchantsService.listRegistrationRequests({ page: 1, pageSize: 100, status: "new" });
  const request = page.rows.find((row) => row.phone === input.phone);
  if (!request) throw new Error("Test request was not persisted.");
  return request;
}
function onboardingInput(requestId: string, overrides: Record<string, unknown> = {}) {
  return {
    name: "Test merchant onboarding",
    branchId: BRANCH_ID,
    pickupRiderId: null,
    vatNo: null,
    address: "No. 1 Test Road, Colombo, Western Province",
    contactName: "Test contact person",
    contactPhone: testPhone(),
    codEnabled: true,
    podPolicy: "signature",
    registrationRequestId: requestId,
    ...overrides,
  };
}

beforeAll(async () => {
  await db.insert(branch).values({
    id: BRANCH_ID,
    code: `RG${String(Date.now()).slice(-6)}`,
    name: "Merchant registration test branch",
    address: "No. 1 Test Road, Colombo, Western Province",
    lat: 6_927_100,
    lng: 79_861_200,
    type: "branch",
  });
  await setupClient.execute({
    sql: `INSERT INTO merchants_rate_card (id, code, name, placeholder, created_at) VALUES (?, ?, ?, ?, ?)`,
    args: [`rtc_${RUN}`, `REG${String(Date.now()).slice(-6)}`, "Approved test card", 0, Date.now()],
  });
  await setupClient.execute({
    sql: `INSERT INTO merchants_rate_card_version (id, rate_card_id, version, status, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [`rcv_${RUN}`, `rtc_${RUN}`, 1, "active", Date.now(), Date.now()],
  });
});

afterAll(async () => {
  await setupClient.close();
});

describe("merchant registration backend (isolated SQLite)", () => {
  test("validates public fields and normalizes only valid Sri Lankan mobile numbers", async () => {
    const valid = registrationInput({ phone: "077 123 4567" });
    const parsed = registrationInputSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.phone).toBe("+94771234567");

    for (const invalid of [
      registrationInput({ phone: "+14155550123" }),
      registrationInput({ smsConsent: false }),
      registrationInput({ district: "Mars" }),
      registrationInput({ notes: "x".repeat(2001) }),
      registrationInput({ submissionId: "not-a-uuid" }),
    ]) {
      expect(registrationInputSchema.safeParse(invalid).success).toBe(false);
      await expect(call(submitRegistration, invalid as never, rpcContext())).rejects.toThrow();
    }
    expect(await merchantsService.registrationRequestCount()).toEqual({ newCount: 0 });
    expect((await db.select().from(outbox)).length).toBe(0);
  });

  test("returns only neutral success for first submit, persistent UUID replay, cooldown replay, and honeypot", async () => {
    const input = registrationInput({ phone: "0771234567" });
    const first = await call(submitRegistration, input as never, rpcContext());
    expect(first).toEqual({ received: true });
    expect(JSON.stringify(first)).not.toContain(input.phone);
    expect(JSON.stringify(first)).not.toContain(input.email);

    expect(await call(submitRegistration, input as never, rpcContext())).toEqual({ received: true });
    expect(await call(submitRegistration, { ...input, submissionId: randomUUID() } as never, rpcContext())).toEqual({ received: true });

    const trapped = registrationInput({ website: "filled-by-bot.invalid" });
    expect(await call(submitRegistration, trapped as never, rpcContext())).toEqual({ received: true });
    expect(await merchantsService.registrationRequestCount()).toEqual({ newCount: 1 });

    const queue = await db.select().from(outbox);
    expect(queue).toHaveLength(1);
    const payload = JSON.parse(queue[0]!.payloadJson) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["registrationRequestId", "stage"]);
    expect(payload.stage).toBe("receipt");
    expect(JSON.stringify(payload)).not.toContain(input.phone);
    const list = await merchantsService.listRegistrationRequests({ page: 1, pageSize: 10 });
    expect(list).toMatchObject({ total: 1, page: 1, pageSize: 10 });
    expect("submissionId" in list.rows[0]!).toBe(false);
  });

  test("keeps request count and conversion atomic with merchant, rate card, portal user, and acceptance outbox", async () => {
    const request = await createRequest();
    expect(await merchantsService.registrationRequestCount()).toEqual({ newCount: 2 });
    const selected = await merchantsService.getRegistrationRequest(request.id);
    expect(selected).toMatchObject({ status: "new", merchantId: null, smsConsent: true });

    const onboarded = await onboardMerchant(onboardingInput(request.id, {
      rateCardId: `rtc_${RUN}`,
      portalUser: { name: "Test portal account", phone: testPhone() },
    }), ACTOR);
    expect(onboarded.merchant.rateCardId).toBe(`rtc_${RUN}`);
    expect(onboarded.portalUser?.id).toBeTruthy();
    const converted = await merchantsService.getRegistrationRequest(request.id);
    expect(converted).toMatchObject({
      status: "converted",
      merchantId: onboarded.merchant.id,
      receiptSmsState: "queued",
      confirmationSmsState: "queued",
    });
    expect(converted.convertedAt).toBeInstanceOf(Date);
    expect(await merchantsService.registrationRequestCount()).toEqual({ newCount: 1 });
    const jobs = await db.select().from(outbox);
    expect(jobs.filter((job) => job.topic === "merchant_registration.sms")).toHaveLength(3);
    const confirmation = jobs.map((job) => JSON.parse(job.payloadJson) as Record<string, unknown>)
      .find((payload) => payload.registrationRequestId === request.id && payload.stage === "confirmation");
    expect(confirmation).toEqual({ registrationRequestId: request.id, stage: "confirmation" });

    const sent: { to: string; body: string; purpose: string }[] = [];
    const sender = async (message: { to: string; body: string; purpose: "otp" | "pod" | "merchant_registration" }) => {
      sent.push(message);
      return { logId: "sms_test", state: "sent" as const, gatewayRef: null, raw: "accepted" };
    };
    const oldEnv = { nodeEnv: process.env.NODE_ENV, disable: process.env.SMS_DISABLE_ALL };
    process.env.NODE_ENV = "production";
    delete process.env.SMS_DISABLE_ALL;
    try {
      await dispatchMerchantRegistrationSms({ registrationRequestId: request.id, stage: "confirmation" }, sender);
      await dispatchMerchantRegistrationSms({ registrationRequestId: request.id, stage: "confirmation" }, sender);
    } finally {
      process.env.NODE_ENV = oldEnv.nodeEnv;
      process.env.SMS_DISABLE_ALL = oldEnv.disable;
    }
    expect(sent).toEqual([{
      to: request.phone,
      body: MERCHANT_REGISTRATION_ACCEPTED_SMS,
      purpose: "merchant_registration",
    }]);
    expect((await merchantsService.getRegistrationRequest(request.id)).confirmationSmsState).toBe("sent");
  });

  test("rolls back merchant/rate/user writes on failure and rejects concurrent duplicate conversion", async () => {
    const failedRequest = await createRequest();
    const conflictingPhone = testPhone();
    await db.insert(user).values({
      id: `usr_conflict_${RUN}`,
      branchId: BRANCH_ID,
      role: "merchant",
      roles: JSON.stringify(["merchant"]),
      username: null,
      passwordHash: null,
      name: "Existing test portal user",
      phone: conflictingPhone,
      deviceId: null,
      status: "active",
      merchantId: null,
      createdAt: new Date(),
    });
    const merchantCountBefore = (await db.select().from(merchant)).length;
    await expect(onboardMerchant(onboardingInput(failedRequest.id, {
      rateCardId: `rtc_${RUN}`,
      portalUser: { name: "Duplicate phone account", phone: conflictingPhone },
    }), ACTOR)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await db.select().from(merchant)).length).toBe(merchantCountBefore);
    expect(await merchantsService.getRegistrationRequest(failedRequest.id)).toMatchObject({
      status: "new",
      merchantId: null,
      confirmationSmsState: "not_queued",
    });
    expect((await db.select().from(outbox)).filter((job) => {
      const payload = JSON.parse(job.payloadJson) as Record<string, unknown>;
      return payload.registrationRequestId === failedRequest.id && payload.stage === "confirmation";
    })).toHaveLength(0);

    const repeatedRequest = await createRequest();
    const outcomes = await Promise.allSettled([
      onboardMerchant(onboardingInput(repeatedRequest.id), ACTOR),
      onboardMerchant(onboardingInput(repeatedRequest.id), ACTOR),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "CONFLICT" });
    expect((await merchantsService.getRegistrationRequest(repeatedRequest.id)).status).toBe("converted");
    const conversionJobs = (await db.select().from(outbox)).filter((job) => {
      const payload = JSON.parse(job.payloadJson) as Record<string, unknown>;
      return payload.registrationRequestId === repeatedRequest.id && payload.stage === "confirmation";
    });
    expect(conversionJobs).toHaveLength(1);
    const createdMerchantIds = fulfilled.map((outcome) => outcome.value.merchant.id);
    expect((await db.select().from(merchant)).filter((row) => createdMerchantIds.includes(row.id))).toHaveLength(1);
  });

  test("suppresses non-production registration SMS and SMS_DISABLE_ALL prevents every provider call", async () => {
    const request = await createRequest();
    let fakeProviderCalls = 0;
    const sender = async () => {
      fakeProviderCalls += 1;
      return { logId: "sms_test", state: "sent" as const, gatewayRef: null, raw: "accepted" };
    };
    const oldEnv = {
      nodeEnv: process.env.NODE_ENV,
      disable: process.env.SMS_DISABLE_ALL,
      url: process.env.SMS_EXECUTION_URL,
    };
    process.env.NODE_ENV = "development";
    process.env.SMS_DISABLE_ALL = "false";
    process.env.SMS_EXECUTION_URL = "https://sms-provider.invalid/send";
    await dispatchMerchantRegistrationSms({ registrationRequestId: request.id, stage: "receipt" }, sender as typeof sendSms);
    expect(fakeProviderCalls).toBe(0);
    expect((await merchantsService.getRegistrationRequest(request.id)).receiptSmsState).toBe("suppressed");

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("test fetch must not run");
    }) as unknown as typeof fetch;
    process.env.SMS_DISABLE_ALL = "true";
    try {
      const otp = await sendSms({ to: request.phone, purpose: "otp", body: "NatEx verification code: 123456." });
      const registration = await sendSms({
        to: request.phone,
        purpose: "merchant_registration",
        body: MERCHANT_REGISTRATION_RECEIPT_SMS,
      });
      expect(otp.state).toBe("failed");
      expect(registration.state).toBe("failed");
      expect(registration.raw).not.toContain(request.phone);
      expect(fetchCalls).toBe(0);
      await expect(sendSms({
        to: request.phone,
        purpose: "merchant_registration",
        body: "Arbitrary public message body",
      })).rejects.toThrow("Merchant-registration SMS must match an approved fixed template.");
      const logs = await db.select().from(smsLog);
      expect(logs.slice(-2).every((row) => row.state === "failed")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.NODE_ENV = oldEnv.nodeEnv;
      process.env.SMS_DISABLE_ALL = oldEnv.disable;
      if (oldEnv.url === undefined) delete process.env.SMS_EXECUTION_URL;
      else process.env.SMS_EXECUTION_URL = oldEnv.url;
    }
  });
});
