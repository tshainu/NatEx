const TRACKING_MATERIAL = /\{\{\s*(?:awb|tracking_?number|track_?url|tracking_?url)\s*\}\}|\bNX(?:\d{8,}|B-\d{8}-[A-Z0-9]{6,})\b|https?:\/\/|www\.|\/track\//i;

export const NATEX_SMS_SENDER_ID = "NatEx";
export const NATEX_HOTLINE_NUMBER = "+94772772708";

/** Remove the legacy body prefix exactly once; the sender ID remains separate. */
export function removeLeadingNatExPrefix(body: string): string {
  return body.startsWith("NatEx: ") ? body.slice("NatEx: ".length) : body;
}

export const MERCHANT_REGISTRATION_RECEIPT_SMS =
  "We received your merchant registration request. We’ll contact you after review.";
export const MERCHANT_REGISTRATION_ACCEPTED_SMS =
  "Congratulations! You have been successfully registered as a Merchant. Keep your login details confidential. Passwords are never sent by SMS; contact NatEx if you need help.";
export const MERCHANT_ONBOARDING_WELCOME_SMS = MERCHANT_REGISTRATION_ACCEPTED_SMS;

export interface MerchantOnboardingSmsDetails {
  username?: string | null;
  password?: string | null;
  allocation?: { awbStart: string; awbEnd: string; labelCount: number } | null;
}

export interface MerchantOnboardingSmsCopy {
  body: string;
  logBody: string;
}

/** Build the approved welcome SMS and a separate copy that never exposes its password in internal logs. */
export function buildMerchantOnboardingSms(details: MerchantOnboardingSmsDetails): MerchantOnboardingSmsCopy {
  const username = details.username?.trim().toLowerCase() ?? "";
  if (username && !/^[a-z0-9._-]{2,60}$/.test(username)) {
    throw new Error("Merchant welcome SMS requires a valid username.");
  }
  const password = details.password ?? "";
  if (password && (password.length < 8 || password.length > 200 || password === "[REDACTED]" || /[\u0000-\u001f\u007f]/.test(password) || password.includes(". "))) {
    throw new Error("Merchant welcome SMS requires a valid single-line temporary password.");
  }
  const allocation = details.allocation ?? null;
  if (allocation) {
    if (!/^NX\d{10}$/.test(allocation.awbStart) || !/^NX\d{10}$/.test(allocation.awbEnd) ||
      !Number.isInteger(allocation.labelCount) || allocation.labelCount < 1 || allocation.labelCount > 50_000 ||
      BigInt(allocation.awbEnd.slice(2)) - BigInt(allocation.awbStart.slice(2)) + 1n !== BigInt(allocation.labelCount)) {
      throw new Error("Merchant welcome SMS requires a valid contiguous tracking-number allocation.");
    }
  }

  const login = username ? `Your app login username: ${username}.` : "Sign in with your registered phone number.";
  const passwordLine = password
    ? `Your password is ${password}.`
    : "Your password will be shared securely by your Admin.";
  const tracking = allocation
    ? ` Your tracking-number series: ${allocation.awbStart}-${allocation.awbEnd}.`
    : "";
  const intro = "Congratulations! You have been approved as a merchant, and your account is active now.";
  const body = `${intro} ${login} ${passwordLine}${tracking} Keep login details confidential.`;
  const logBody = `${intro} ${login} ${password ? "Your password is [REDACTED]." : passwordLine}${tracking} Keep login details confidential.`;
  assertMerchantRegistrationSms(body);
  assertMerchantRegistrationSms(logBody);
  return { body, logBody };
}

/** Merchant registration/onboarding SMS is limited to exact approved literal copies. */
export function assertMerchantRegistrationSms(body: string): void {
  const dynamicWelcome = body.match(/^Congratulations! You have been approved as a merchant, and your account is active now\. (?:Your app login username: ([a-z0-9._-]{2,60})\.|Sign in with your registered phone number\.) (?:Your password is (.{8,200}?)\.|Your password will be shared securely by your Admin\.)(?: Your tracking-number series: (NX\d{10})-(NX\d{10})\.)? Keep login details confidential\.$/);
  const hasValidAllocation = !dynamicWelcome?.[3] || (
    dynamicWelcome[4] !== undefined &&
    BigInt(dynamicWelcome[4].slice(2)) >= BigInt(dynamicWelcome[3].slice(2)) &&
    BigInt(dynamicWelcome[4].slice(2)) - BigInt(dynamicWelcome[3].slice(2)) < 50_000n
  );
  const hasValidPassword = !dynamicWelcome?.[2] || (
    Boolean(dynamicWelcome[1]) && dynamicWelcome[2].length <= 200 &&
    !dynamicWelcome[2].includes(". ")
  );
  const isSingleLine = !/[\u0000-\u001f\u007f]/.test(body);
  if (
    body !== MERCHANT_REGISTRATION_RECEIPT_SMS &&
    body !== MERCHANT_REGISTRATION_ACCEPTED_SMS &&
    body !== MERCHANT_ONBOARDING_WELCOME_SMS &&
    (!dynamicWelcome || !hasValidAllocation || !hasValidPassword || !isSingleLine || body.length > 320)
  ) {
    throw new Error("Merchant-registration SMS must match an approved fixed template.");
  }
}

/** True only for an approved onboarding template containing an actual password value. */
export function hasMerchantOnboardingPassword(body: string): boolean {
  assertMerchantRegistrationSms(body);
  if (body.includes("Your password is [REDACTED].")) {
    throw new Error("The redaction marker cannot be sent as an onboarding password.");
  }
  return body.includes("Your password is ");
}

/** Return the exact approved onboarding body with only its password value redacted. */
export function redactMerchantOnboardingPassword(body: string): string {
  assertMerchantRegistrationSms(body);
  const passwordPrefix = "Your password is ";
  const prefixIndex = body.indexOf(passwordPrefix);
  if (prefixIndex < 0) return body;
  const valueStart = prefixIndex + passwordPrefix.length;
  const finalMarker = " Keep login details confidential.";
  const finalStart = body.lastIndexOf(finalMarker);
  if (finalStart < valueStart) return body;
  const beforeFinal = body.slice(0, finalStart);
  const trackingMarker = " Your tracking-number series: ";
  const trackingStart = beforeFinal.lastIndexOf(trackingMarker);
  let valueEnd: number;
  if (trackingStart >= valueStart) {
    if (!/^ Your tracking-number series: NX\d{10}-NX\d{10}\.$/.test(beforeFinal.slice(trackingStart))) return body;
    valueEnd = trackingStart - 1;
  } else {
    valueEnd = beforeFinal.length - 1;
  }
  if (valueEnd <= valueStart) return body;
  const value = body.slice(valueStart, valueEnd);
  if (value.length > 200 || value.includes(". ")) return body;
  return `${body.slice(0, valueStart)}[REDACTED]${body.slice(valueEnd)}`;
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

/** Arrival SMS may identify a parcel, but must remain a short single-line notice. */
export function assertArrivalNoticeSms(body: string): void {
  const hasControlCharacter = [...body].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (!body.trim() || body.length > 320 || hasControlCharacter) {
    throw new Error("Destination-arrival SMS must be a non-empty, single-line message of at most 320 characters.");
  }
  if (!/\bNX[A-Z0-9-]{3,24}\b/i.test(body) || /https?:\/\/|www\./i.test(body)) {
    throw new Error("Destination-arrival SMS must include the tracking number and must not include a link.");
  }
}

export interface RescheduleSmsCopy {
  trackingNumber: string;
  newDate: string;
  reason: string;
}

const RESCHEDULE_SMS_PATTERN =
  /^Tracking [A-Z0-9-]{3,24}\. Delivery rescheduled to (\d{4}-\d{2}-\d{2})\. Reason: [A-Za-z0-9][A-Za-z0-9 ,.'-]{0,39}\.$/;

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
  const body = `Tracking ${trackingNumber}. Delivery rescheduled to ${copy.newDate}. Reason: ${shortPublicReason(copy.reason)}.`;
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
