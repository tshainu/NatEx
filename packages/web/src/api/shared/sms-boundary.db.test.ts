import { afterAll, describe, expect, test } from "bun:test";
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
const { MERCHANT_REGISTRATION_RECEIPT_SMS } = await import("./sms-policy");

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
});
