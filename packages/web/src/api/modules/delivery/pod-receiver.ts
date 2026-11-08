import { normaliseLkPhone } from "../../shared/sms";

export interface DeliveryOtpBinding {
  awb: string;
  sentToPhone: string;
  verifiedAt: Date | null;
  consumedAt: Date | null;
  expiresAt: Date;
}

export type DeliveryOtpIssue = "required" | "binding" | "unverified" | "expired";

/** Return only canonical Sri Lankan mobile numbers; never silently accept a landline. */
export function normaliseReceiverPhone(input: string): string | null {
  if (typeof input !== "string") return null;
  const phone = normaliseLkPhone(input.trim());
  return /^\+947\d{8}$/.test(phone) ? phone : null;
}

/** Shared server guard for the AWB, receiver phone, verification and expiry contract. */
export function deliveryOtpIssue(
  challenge: DeliveryOtpBinding | null | undefined,
  expected: { awb: string; receiverPhone: string; now?: number },
): DeliveryOtpIssue | null {
  if (!challenge) return "required";
  const normalizedExpected = normaliseReceiverPhone(expected.receiverPhone);
  const normalizedSentTo = normaliseReceiverPhone(challenge.sentToPhone);
  if (
    challenge.awb !== expected.awb ||
    !normalizedExpected ||
    !normalizedSentTo ||
    normalizedSentTo !== normalizedExpected
  ) {
    return "binding";
  }
  if (!challenge.verifiedAt || !challenge.consumedAt) return "unverified";
  const now = expected.now ?? Date.now();
  if (
    challenge.verifiedAt.getTime() > challenge.expiresAt.getTime() ||
    challenge.consumedAt.getTime() !== challenge.verifiedAt.getTime() ||
    now - challenge.verifiedAt.getTime() > 30 * 60_000
  ) return "expired";
  return null;
}

/** Fields deliberately permitted in the POD audit row; no full NIC is accepted here. */
export function receiverPodAuditFields(input: {
  receiverPhone: string;
  receiverNicLast4: string;
}): { receiverPhone: string; receiverNicLast4: string } {
  const receiverPhone = normaliseReceiverPhone(input.receiverPhone);
  if (!receiverPhone) throw new Error("Enter a valid Sri Lankan receiver mobile number.");
  if (!/^\d{4}$/.test(input.receiverNicLast4)) {
    throw new Error("Only the receiver NIC's last four digits may be recorded.");
  }
  return { receiverPhone, receiverNicLast4: input.receiverNicLast4 };
}
