import { eq } from "drizzle-orm";
import { db } from "../database";
import { smsLog } from "../database/schema/shared";
import { prefixedId } from "./ulid";
import {
  assertArrivalNoticeSms,
  assertRescheduleSms,
  assertDeliveryFailureSms,
  assertMerchantRegistrationSms,
  hasMerchantOnboardingPassword,
  redactMerchantOnboardingPassword,
  assertPodSmsHasNoTrackingMaterial,
  isSmsDisabled,
  NATEX_SMS_SENDER_ID,
  removeLeadingNatExPrefix,
} from "./sms-policy";

/**
 * SMS via execution link + sender ID ONLY (PROJECT.md §9).
 *
 * Hard rules encoded here:
 * - No provider SDK, no operator-specific API shape, no DLT (Indian TRAI
 *   mandate, not applicable in Sri Lanka).
 * - The complete integration surface is SMS_EXECUTION_URL + SMS_SENDER_ID.
 * - OTP/POD retain the opaque legacy response logging; registration responses
 *   are sanitized and never expose raw provider text.
 * - Credentials never hardcoded — environment variables only.
 */

export interface SendSmsInput {
  to: string;
  body: string;
  /** Approved redacted copy used only for internal logging of sensitive onboarding credentials. */
  sensitiveLogBody?: string;
  /** OTP, POD, delivery updates, two fixed registration messages, or the fixed reschedule notice. */
  purpose: "otp" | "pod" | "delivery_failure" | "arrival_notice" | "merchant_registration" | "reschedule";
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
  if (!["otp", "pod", "delivery_failure", "arrival_notice", "merchant_registration", "reschedule"].includes(input.purpose)) {
    throw new Error("Unsupported SMS purpose.");
  }
  const body = removeLeadingNatExPrefix(input.body);
  const sensitiveLogBody = input.sensitiveLogBody === undefined
    ? body
    : removeLeadingNatExPrefix(input.sensitiveLogBody);
  if (input.sensitiveLogBody !== undefined && input.purpose !== "merchant_registration") {
    throw new Error("A redacted SMS log body is supported only for merchant onboarding messages.");
  }
  if (input.purpose === "pod") assertPodSmsHasNoTrackingMaterial(body);
  if (input.purpose === "delivery_failure") assertDeliveryFailureSms(body);
  if (input.purpose === "arrival_notice") assertArrivalNoticeSms(body);
  const containsCredential = input.purpose === "merchant_registration"
    ? hasMerchantOnboardingPassword(body)
    : false;
  const expectedLogBody = containsCredential
    ? redactMerchantOnboardingPassword(body)
    : body;
  if (containsCredential && input.sensitiveLogBody === undefined) {
    throw new Error("Password-bearing onboarding SMS requires a redacted internal log body.");
  }
  if (input.sensitiveLogBody !== undefined && sensitiveLogBody !== expectedLogBody) {
    throw new Error("The onboarding SMS log body must match the exact password-redacted message.");
  }
  if (input.purpose === "merchant_registration") {
    assertMerchantRegistrationSms(body);
    if (input.sensitiveLogBody !== undefined) assertMerchantRegistrationSms(sensitiveLogBody);
  }
  if (input.purpose === "reschedule") assertRescheduleSms(body);
  const url = process.env.SMS_EXECUTION_URL;
  const senderId = NATEX_SMS_SENDER_ID;
  const to = normaliseLkPhone(input.to);

  const logId = prefixedId("sms");
  await db.insert(smsLog).values({
    id: logId,
    toPhone: to,
    senderId,
    body: containsCredential ? expectedLogBody : sensitiveLogBody,
    purpose: input.purpose,
    state: "queued",
  });

  if (isSmsDisabled()) {
    const raw = "SMS sending is disabled by configuration.";
    await db
      .update(smsLog)
      .set({ state: "failed", rawResponse: raw, updatedAt: new Date() })
      .where(eq(smsLog.id, logId));
    return { logId, state: "failed", gatewayRef: null, raw };
  }

  if (!url) {
    // Not configured yet. The message is logged, not silently dropped, and the
    // OTP flow falls back to resend-and-expire (PROJECT.md §9).
    const raw = "SMS_EXECUTION_URL is not configured — message logged, not sent.";
    await db
      .update(smsLog)
      .set({ state: "failed", rawResponse: raw, updatedAt: new Date() })
      .where(eq(smsLog.id, logId));
    if (input.purpose !== "merchant_registration") {
      console.warn(`[sms] ${raw} to=${to} purpose=${input.purpose}`);
    }
    return { logId, state: "failed", gatewayRef: null, raw };
  }

  // Local gateways expect 9477… rather than +9477…, so strip the leading plus.
  // For credential-bearing onboarding SMS the body is sent only in the POST
  // form (never the URL, which may be retained in access logs) and HTTPS is required.
  const gatewayTo = to.replace(/^\+/, "");
  let raw = "";
  try {
    const target = new URL(url);
    if (containsCredential && target.protocol !== "https:") {
      raw = "Credential-bearing registration SMS requires an HTTPS gateway.";
      await db
        .update(smsLog)
        .set({ state: "failed", rawResponse: raw, updatedAt: new Date() })
        .where(eq(smsLog.id, logId));
      return { logId, state: "failed", gatewayRef: null, raw };
    }
    target.searchParams.set("phone_no", gatewayTo);
    target.searchParams.delete("message");
    if (!containsCredential) target.searchParams.set("message", body);
    target.searchParams.set("sender_id", senderId);
    const res = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ phone_no: gatewayTo, message: body, sender_id: senderId }),
      signal: AbortSignal.timeout(10_000),
    });
    const providerResponse = await res.text();
    raw = input.purpose === "merchant_registration"
      ? (res.ok ? "Provider accepted registration message." : "Provider rejected registration message.")
      : providerResponse;
    const ref = input.purpose === "merchant_registration" ? null : extractRef(providerResponse);
    const state = res.ok ? "sent" : "failed";
    await db
      .update(smsLog)
      .set({ state, gatewayRef: ref, rawResponse: raw.slice(0, 4000), updatedAt: new Date() })
      .where(eq(smsLog.id, logId));
    return { logId, state, gatewayRef: ref, raw };
  } catch (err) {
    raw = input.purpose === "merchant_registration"
      ? "Registration SMS provider request failed."
      : err instanceof Error ? err.message : String(err);
    await db
      .update(smsLog)
      .set({ state: "failed", rawResponse: raw.slice(0, 4000), updatedAt: new Date() })
      .where(eq(smsLog.id, logId));
    return { logId, state: "failed", gatewayRef: null, raw };
  }
}
