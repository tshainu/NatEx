import type { AppRouterClient } from "../../src/api";

/** Request and verify a development/test delivery OTP using the real API routes. */
export async function verifiedDeliveryOtp(
  client: AppRouterClient,
  awb: string,
  receiverPhone: string,
): Promise<string> {
  const challenge = await client.delivery.otpRequest({
    awb,
    receiverPhone,
  });
  if (!challenge.devCode) {
    throw new Error("A development/test SMS gateway must expose the delivery OTP for this probe.");
  }
  const verified = await client.delivery.otpVerify({
    awb,
    receiverPhone,
    challengeId: challenge.challengeId,
    code: challenge.devCode,
  });
  if (
    !verified.verified ||
    verified.challengeId !== challenge.challengeId
  ) {
    throw new Error("The delivery OTP challenge was not verified.");
  }
  return challenge.challengeId;
}
