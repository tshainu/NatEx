import { describe, expect, test } from "bun:test";
import { DEFAULT_TEMPLATES, templateProblems } from "./service";

describe("notification SMS policy", () => {
  test("defaults SMS to POD delivery only and the POD message contains no tracking identifier", () => {
    const pod = DEFAULT_TEMPLATES.find((template) => template.key === "parcel.delivered");
    expect(pod).toBeDefined();
    expect(pod!.channelOrder.split(",")).toContain("sms");
    expect(pod!.bodySms).not.toMatch(/\{\{\s*(?:awb|trackUrl)\s*\}\}/i);

    for (const template of DEFAULT_TEMPLATES.filter((row) => row.key !== "parcel.delivered")) {
      expect(template.channelOrder.split(",")).not.toContain("sms");
    }
  });

  test("rejects enabling SMS for non-POD templates", () => {
    expect(templateProblems("parcel.booked", { channelOrder: "whatsapp,sms,push" }, null)).toContain(
      "SMS is reserved for Proof of Delivery; remove sms from this notification.",
    );
  });

  test("rejects a tracking number or link in any SMS template body", () => {
    for (const bodySms of [
      "Delivered: {{awb}} {{trackUrl}}",
      "Delivered: NX1234567890",
      "Delivered: NXB-20261007-FYCWQW1NWQ",
      "Delivered: https://natex.example/track/NX1234567890",
    ]) {
      const problems = templateProblems("parcel.delivered", { bodySms }, null);
      expect(problems).toContain("SMS messages must not include a tracking number or tracking link.");
    }
  });
});
