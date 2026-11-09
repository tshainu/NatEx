import { describe, expect, test } from "bun:test";
import { DEFAULT_TEMPLATES, templateProblems } from "./service";

describe("notification SMS policy", () => {
  test("defaults SMS to POD and failed-delivery notices, with the approved hotline", () => {
    const pod = DEFAULT_TEMPLATES.find((template) => template.key === "parcel.delivered");
    const failed = DEFAULT_TEMPLATES.find((template) => template.key === "parcel.delivery_failed");
    expect(pod).toBeDefined();
    expect(failed).toBeDefined();
    expect(pod!.channelOrder.split(",")).toContain("sms");
    expect(pod!.bodySms).not.toMatch(/\{\{\s*(?:awb|trackUrl)\s*\}\}/i);
    expect(failed!.channelOrder.split(",")).toContain("sms");
    expect(failed!.bodySms).toContain("0772772708");
    expect(failed!.bodySms).toMatch(/\{\{awb\}\}/i);

    for (const template of DEFAULT_TEMPLATES.filter((row) => !["parcel.delivered", "parcel.delivery_failed"].includes(row.key))) {
      expect(template.channelOrder.split(",")).not.toContain("sms");
    }
  });

  test("allows failure notices to use SMS and rejects it for other non-POD templates", () => {
    expect(templateProblems("parcel.delivery_failed", { channelOrder: "whatsapp,sms,push" }, null)).toEqual([]);
    expect(templateProblems("parcel.booked", { channelOrder: "whatsapp,sms,push" }, null)).toContain(
      "SMS is allowed only for Proof of Delivery and failed-delivery notices.",
    );
  });

  test("keeps tracking material forbidden in POD SMS but permits it in a failed-delivery notice", () => {
    for (const bodySms of [
      "Delivered: {{awb}} {{trackUrl}}",
      "Delivered: NX1234567890",
      "Delivered: NXB-20261007-FYCWQW1NWQ",
      "Delivered: https://natex.example/track/NX1234567890",
    ]) {
      const problems = templateProblems("parcel.delivered", { bodySms }, null);
      expect(problems).toContain("SMS messages must not include a tracking number or tracking link.");
    }
    expect(templateProblems("parcel.delivery_failed", { bodySms: "NatEx {{awb}}. {{trackUrl}}" }, null)).toEqual([]);
  });
});
