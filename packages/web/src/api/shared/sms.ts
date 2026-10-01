import { eq } from "drizzle-orm";
import { db } from "../database";
import { smsLog } from "../database/schema/shared";
import { prefixedId } from "./ulid";

/**
 * SMS via execution link + sender ID ONLY (PROJECT.md §9).
 *
 * Hard rules encoded here:
 * - No provider SDK, no operator-specific API shape, no DLT (Indian TRAI
 *   mandate, not applicable in Sri Lanka).
 * - The complete integration surface is SMS_EXECUTION_URL + SMS_SENDER_ID.
 * - The gateway response is OPAQUE: logged raw, with any reference id extracted
 *   only on a best-effort basis.
 * - Credentials never hardcoded — environment variables only.
 */

export interface SendSmsInput {
  to: string;
  body: string;
  /** otp | notification — recorded for the delivery log. */
  purpose: string;
}

export interface SendSmsResult {
  logId: string;
  state: "sent" | "failed" | "queued";
  gatewayRef: string | null;
  raw: string;
}

/** Best-effort reference extraction from an unknown response shape. */
function extractRef(raw: string): string | null {
  const trimmed = raw.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      for (const key of ["messageId", "message_id", "id", "ref", "reference", "transactionId", "txnId"]) {
        const v = obj[key];
        if (typeof v === "string" || typeof v === "number") return String(v);
      }
    }
  } catch {
    // Not JSON — the gateway may return plain text like "OK|12345".
    const m = trimmed.match(/[A-Za-z0-9_-]{6,}/);
    if (m) return m[0];
  }
  return null;
}

/** Normalise to Sri Lankan E.164: 0771234567 → +94771234567. */
export function normaliseLkPhone(input: string): string {
  const digits = input.replace(/[^\d+]/g, "");
  if (digits.startsWith("+94")) return digits;
  if (digits.startsWith("94")) return `+${digits}`;
  if (digits.startsWith("0")) return `+94${digits.slice(1)}`;
  return `+94${digits}`;
}

export async function sendSms(input: SendSmsInput): Promise<SendSmsResult> {
  const url = process.env.SMS_EXECUTION_URL;
  const senderId = process.env.SMS_SENDER_ID ?? "NATEX";
  const to = normaliseLkPhone(input.to);

  const logId = prefixedId("sms");
  await db.insert(smsLog).values({
    id: logId,
    toPhone: to,
    senderId,
    body: input.body,
    purpose: input.purpose,
    state: "queued",
  });

  if (!url) {
    // Not configured yet. The message is logged, not silently dropped, and the
    // OTP flow falls back to resend-and-expire (PROJECT.md §9).
    const raw = "SMS_EXECUTION_URL is not configured — message logged, not sent.";
    await db
      .update(smsLog)
      .set({ state: "failed", rawResponse: raw, updatedAt: new Date() })
      .where(eq(smsLog.id, logId));
    console.warn(`[sms] ${raw} to=${to} purpose=${input.purpose}`);
    return { logId, state: "failed", gatewayRef: null, raw };
  }

  // The gateway is a black box reached by HTTP. Destination, sender id and body
  // are sent both as query params and as a JSON body so either convention works
  // without assuming a provider.
  const target = new URL(url);
  target.searchParams.set("to", to);
  target.searchParams.set("sender_id", senderId);
  target.searchParams.set("message", input.body);

  let raw = "";
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, senderId, message: input.body }),
      signal: AbortSignal.timeout(10_000),
    });
    raw = await res.text();
    const ref = extractRef(raw);
    const state = res.ok ? "sent" : "failed";
    await db
      .update(smsLog)
      .set({ state, gatewayRef: ref, rawResponse: raw.slice(0, 4000), updatedAt: new Date() })
      .where(eq(smsLog.id, logId));
    return { logId, state, gatewayRef: ref, raw };
  } catch (err) {
    raw = err instanceof Error ? err.message : String(err);
    await db
      .update(smsLog)
      .set({ state: "failed", rawResponse: raw.slice(0, 4000), updatedAt: new Date() })
      .where(eq(smsLog.id, logId));
    return { logId, state: "failed", gatewayRef: null, raw };
  }
}
