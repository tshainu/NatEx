const TRACKING_MATERIAL = /\{\{\s*(?:awb|tracking_?number|track_?url|tracking_?url)\s*\}\}|\bNX(?:\d{8,}|B-\d{8}-[A-Z0-9]{6,})\b|https?:\/\/|www\.|\/track\//i;

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
