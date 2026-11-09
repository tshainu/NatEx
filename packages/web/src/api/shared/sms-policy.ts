const TRACKING_MATERIAL = /\{\{\s*(?:awb|tracking_?number|track_?url|tracking_?url)\s*\}\}|\bNX(?:\d{8,}|B-\d{8}-[A-Z0-9]{6,})\b|https?:\/\/|www\.|\/track\//i;

export const NATEX_SMS_SENDER_ID = "NatEx";

export const MERCHANT_REGISTRATION_RECEIPT_SMS =
  "NatEx: We received your merchant registration request. We’ll contact you after review.";
export const MERCHANT_REGISTRATION_ACCEPTED_SMS =
  "NatEx: Your merchant registration has been accepted and set up. Contact NatEx if you need help.";

/** Merchant-registration SMS is limited to the two user-approved literal copies. */
export function assertMerchantRegistrationSms(body: string): void {
  if (body !== MERCHANT_REGISTRATION_RECEIPT_SMS && body !== MERCHANT_REGISTRATION_ACCEPTED_SMS) {
    throw new Error("Merchant-registration SMS must match an approved fixed template.");
  }
}

/** True when an SMS body contains a tracking number, tracking placeholder, or link. */
export function containsTrackingMaterial(body: string): boolean {
  return TRACKING_MATERIAL.test(body);
}

/** Defense-in-depth at the last SMS boundary, including raw outbox callers. */
export function assertPodSmsHasNoTrackingMaterial(body: string): void {
  if (containsTrackingMaterial(body)) {
    throw new Error("POD SMS must not include a tracking number or tracking link.");
  }
}

/** A failed-delivery notice may identify the parcel, but must remain a short, single-line customer message. */
export function assertDeliveryFailureSms(body: string): void {
  const hasControlCharacter = [...body].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (!body.trim() || body.length > 320 || hasControlCharacter) {
    throw new Error("Failed-delivery SMS must be a non-empty, single-line message of at most 320 characters.");
  }
}

export interface RescheduleSmsCopy {
  trackingNumber: string;
  newDate: string;
  reason: string;
}

const RESCHEDULE_SMS_PATTERN =
  /^NatEx: Tracking [A-Z0-9-]{3,24}\. Delivery rescheduled to (\d{4}-\d{2}-\d{2})\. Reason: [A-Za-z0-9][A-Za-z0-9 ,.'-]{0,39}\.$/;

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month! - 1 && parsed.getUTCDate() === day;
}

/**
 * Reduce the stored public reason label to short GSM-7-safe wording. Internal
 * instruction notes, names, addresses, and other free-form fields are never
 * accepted by this builder.
 */
function shortPublicReason(value: string): string {
  const withoutEmail = value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, " ");
  const withoutPhone = withoutEmail.replace(/\+?\d[\d\s().-]{7,}\d/g, " ");
  const withoutLink = withoutPhone.replace(/(?:https?:\/\/|www\.)\S+/gi, " ");
  const withoutTracking = withoutLink.replace(/\bNX(?:\d{8,}|B-\d{8}-[A-Z0-9]{6,})\b/gi, " ");
  const ascii = withoutTracking.replace(/[^\x20-\x7e]/g, " ");
  const cleaned = ascii.replace(/[^A-Za-z0-9 ,.'-]/g, " ").replace(/\s+/g, " ").trim();
  const shortened = cleaned.slice(0, 40).trim().replace(/[ ,.'-]+$/g, "");
  return shortened || "delivery issue";
}

/** Build the sole approved receiver reschedule SMS; the fixed copy stays ASCII and <=160 GSM-7 septets. */
export function buildRescheduleSms(copy: RescheduleSmsCopy): string {
  const trackingNumber = copy.trackingNumber.trim().toUpperCase();
  if (!/^[A-Z0-9-]{3,24}$/.test(trackingNumber)) {
    throw new Error("Reschedule SMS requires a valid tracking number.");
  }
  if (!isCalendarDate(copy.newDate)) {
    throw new Error("Reschedule SMS requires a valid YYYY-MM-DD delivery date.");
  }
  const body = `NatEx: Tracking ${trackingNumber}. Delivery rescheduled to ${copy.newDate}. Reason: ${shortPublicReason(copy.reason)}.`;
  assertRescheduleSms(body);
  return body;
}

/** Final-boundary validation: no arbitrary status copy can use the reschedule purpose. */
export function assertRescheduleSms(body: string): void {
  const match = body.match(RESCHEDULE_SMS_PATTERN);
  if (body.length > 160 || !match || !isCalendarDate(match[1]!)) {
    throw new Error("Reschedule SMS must match the approved fixed template and fit one GSM-7 SMS.");
  }
}

export function isSmsDisabled(): boolean {
  return process.env.SMS_DISABLE_ALL?.trim().toLowerCase() === "true";
}
