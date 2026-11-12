import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const databaseUrl = `file:${join(tmpdir(), `natex-sms-boundary-${randomUUID()}.db`)}`;
process.env.DATABASE_URL = databaseUrl;
delete process.env.DATABASE_AUTH_TOKEN;
process.env.NODE_ENV = "test";
process.env.SMS_DISABLE_ALL = "false";
process.env.SMS_EXECUTION_URL = "https://sms-gateway.invalid/send";

const { createClient } = await import("@libsql/client");
const setupClient = createClient({ url: databaseUrl });
await setupClient.execute(`CREATE TABLE shared_sms_log (
  id TEXT PRIMARY KEY,
  to_phone TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
  purpose TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  gateway_ref TEXT,
  raw_response TEXT,
  raw_dlr TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`);

const { db } = await import("../database");
const { smsLog } = await import("../database/schema/shared");
const { sendSms } = await import("./sms");
const { buildMerchantOnboardingSms, MERCHANT_REGISTRATION_RECEIPT_SMS } = await import("./sms-policy");

afterAll(async () => {
  await setupClient.close();
});

describe("SMS sender prefix normalization", () => {
  test("stores and sends the canonical body after removing the legacy leading brand prefix", async () => {
    const originalFetch = globalThis.fetch;
    const requests: { url: string; body: string }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response("accepted", { status: 200 });
    }) as typeof fetch;

    try {
      const prefixedCopy = `NatEx: ${MERCHANT_REGISTRATION_RECEIPT_SMS}`;
      const result = await sendSms({
        to: "07770000000",
        body: prefixedCopy,
        purpose: "merchant_registration",
      });
      expect(result.state).toBe("sent");

      const [log] = await db.select().from(smsLog);
      expect(log?.body).toBe(MERCHANT_REGISTRATION_RECEIPT_SMS);

      expect(requests).toHaveLength(1);
      expect(new URL(requests[0]!.url).searchParams.get("message")).toBe(MERCHANT_REGISTRATION_RECEIPT_SMS);
      expect(new URLSearchParams(requests[0]!.body).get("message")).toBe(MERCHANT_REGISTRATION_RECEIPT_SMS);
      expect(requests[0]!.body).not.toContain("NatEx%3A");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sends onboarding password only in the HTTPS form body and persists the redacted copy", async () => {
    const originalFetch = globalThis.fetch;
    const requests: { url: string; body: string }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response("accepted", { status: 200 });
    }) as unknown as typeof fetch;
    const copy = buildMerchantOnboardingSms({
      username: "royalfabric",
      password: "Abc@@122",
      allocation: { awbStart: "NX8000000000", awbEnd: "NX8000000999", labelCount: 1_000 },
    });
    try {
      const result = await sendSms({
        to: "07770000000",
        body: copy.body,
        sensitiveLogBody: copy.logBody,
        purpose: "merchant_registration",
      });
      expect(result.state).toBe("sent");
      const [log] = await db.select().from(smsLog).where(eq(smsLog.id, result.logId));
      expect(log?.body).toBe(copy.logBody);
      expect(log?.body).not.toContain("Abc@@122");
      expect(requests).toHaveLength(1);
      const requestUrl = new URL(requests[0]!.url);
      expect(requestUrl.protocol).toBe("https:");
      expect(requestUrl.searchParams.has("message")).toBe(false);
      expect(new URLSearchParams(requests[0]!.body).get("message")).toBe(copy.body);
      expect(requests[0]!.url).not.toContain("Abc%40%40122");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("refuses credential-bearing onboarding SMS over HTTP", async () => {
    const originalUrl = process.env.SMS_EXECUTION_URL;
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    process.env.SMS_EXECUTION_URL = "http://sms-gateway.invalid/send";
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("accepted", { status: 200 });
    }) as unknown as typeof fetch;
    const copy = buildMerchantOnboardingSms({ username: "royalfabric", password: "Abc@@122" });
    try {
      const result = await sendSms({
        to: "07770000000",
        body: copy.body,
        sensitiveLogBody: copy.logBody,
        purpose: "merchant_registration",
      });
      expect(result.state).toBe("failed");
      expect(result.raw).toBe("Credential-bearing registration SMS requires an HTTPS gateway.");
      expect(fetchCalls).toBe(0);
      const [log] = await db.select().from(smsLog).where(eq(smsLog.id, result.logId));
      expect(log?.body).toBe(copy.logBody);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalUrl === undefined) delete process.env.SMS_EXECUTION_URL;
      else process.env.SMS_EXECUTION_URL = originalUrl;
    }
  });

  test("refuses a password-bearing body that omits its redacted log copy", async () => {
    const copy = buildMerchantOnboardingSms({ username: "royalfabric", password: "Abc@@122" });
    await expect(sendSms({
      to: "07770000000",
      body: copy.body,
      purpose: "merchant_registration",
    })).rejects.toThrow("requires a redacted internal log body");
    const logs = await db.select().from(smsLog);
    expect(logs.some((log) => log.body.includes("Abc@@122"))).toBe(false);
  });

  test("rejects the redaction marker as a password before logging or gateway access", async () => {
    const body = "Congratulations! You have been approved as a merchant, and your account is active now. Your app login username: royalfabric. Your password is [REDACTED]. Keep login details confidential.";
    const before = await db.select().from(smsLog);
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("accepted", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await expect(sendSms({
        to: "07770000000",
        body,
        sensitiveLogBody: body,
        purpose: "merchant_registration",
      })).rejects.toThrow("The redaction marker cannot be sent as an onboarding password.");
      expect(fetchCalls).toBe(0);
      expect((await db.select().from(smsLog)).length).toBe(before.length);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
