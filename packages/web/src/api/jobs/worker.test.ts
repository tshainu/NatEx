import { describe, expect, test } from "bun:test";
import type { SendSmsInput, SendSmsResult } from "../shared/sms";
import { dispatchQueuedSms } from "./worker";

const sent: SendSmsInput[] = [];
const fakeSender = async (input: SendSmsInput): Promise<SendSmsResult> => {
  sent.push(input);
  return { logId: "sms_test", state: "sent", gatewayRef: null, raw: "accepted" };
};

describe("raw sms.send outbox policy", () => {
  test("never sends legacy notification jobs or POD jobs carrying a tracking number/link", async () => {
    sent.length = 0;
    for (const payload of [
      { to: "+94770000000", purpose: "notification", body: "Booked: NX2610020001" },
      { to: "+94770000000", purpose: "pod", body: "Delivered: NX2610020001" },
      { to: "+94770000000", purpose: "pod", body: "Delivered: NXB-20261007-FYCWQW1NWQ" },
      { to: "+94770000000", purpose: "pod", body: "Delivered: https://natex.example/track/" },
    ] as const) {
      await dispatchQueuedSms(payload, fakeSender);
    }
    expect(sent).toEqual([]);
  });

  test("sends a clean POD confirmation using the POD purpose only", async () => {
    sent.length = 0;
    await dispatchQueuedSms(
      { to: "+94770000000", purpose: "pod", body: "NatEx: your parcel has been delivered. Thank you." },
      fakeSender,
    );
    expect(sent).toEqual([
      { to: "+94770000000", purpose: "pod", body: "NatEx: your parcel has been delivered. Thank you." },
    ]);
  });
});
