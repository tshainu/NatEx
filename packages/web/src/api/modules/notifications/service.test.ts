import { describe, expect, test } from "bun:test";
import { DEFAULT_TEMPLATES, render, templateProblems } from "./service";

describe("notification SMS policy", () => {
  test("defaults SMS to POD, failed-delivery, and final-hub arrival notices", () => {
    const pod = DEFAULT_TEMPLATES.find((template) => template.key === "parcel.delivered");
    const failed = DEFAULT_TEMPLATES.find((template) => template.key === "parcel.delivery_failed");
    const arrival = DEFAULT_TEMPLATES.find((template) => template.key === "parcel.arrived_at_hub");
    expect(pod).toBeDefined();
    expect(failed).toBeDefined();
    expect(arrival).toBeDefined();
    expect(pod!.channelOrder.split(",")).toContain("sms");
    expect(pod!.bodySms).not.toMatch(/\{\{\s*(?:awb|trackUrl)\s*\}\}/i);
    expect(failed!.channelOrder.split(",")).toContain("sms");
    expect(failed!.bodySms).toContain("+94772772708");
    expect(failed!.bodySms).toMatch(/\{\{awb\}\}/i);
    expect(failed!.bodySms).toContain("{{merchantName}}");
    expect(failed!.bodySms).toContain("{{hubPhone}}");
    expect(arrival!.channelOrder).toBe("sms");
    expect(arrival!.bodySms).toContain("{{amountDueLine}}");
    expect(arrival!.bodySms).toContain("{{hubPhone}}");
    expect(DEFAULT_TEMPLATES.every((template) => !/^NatEx: /.test(template.bodySms))).toBe(true);

    for (const template of DEFAULT_TEMPLATES.filter((row) => !["parcel.delivered", "parcel.delivery_failed", "parcel.arrived_at_hub"].includes(row.key))) {
      expect(template.channelOrder.split(",")).not.toContain("sms");
    }
  });

  test("allows failure and arrival notices to use SMS and rejects it for other templates", () => {
    expect(templateProblems("parcel.delivery_failed", { channelOrder: "whatsapp,sms,push" }, null)).toEqual([]);
    expect(templateProblems("parcel.arrived_at_hub", { channelOrder: "sms" }, null)).toEqual([]);
    expect(templateProblems("parcel.booked", { channelOrder: "whatsapp,sms,push" }, null)).toContain(
      "SMS is allowed only for Proof of Delivery, failed-delivery, and destination-arrival notices.",
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
    expect(templateProblems("parcel.delivery_failed", { bodySms: "Dear {{consigneeName}}, {{merchantName}} {{awb}} {{hubPhone}}." }, null)).toEqual([]);
    expect(templateProblems("parcel.arrived_at_hub", { bodySms: "Dear {{consigneeName}}, {{merchantName}} {{awb}} {{amountDueLine}} {{hubPhone}}" }, null)).toEqual([]);
  });

  test("normalizes legacy NatEx colon prefixes in rendered template previews", () => {
    expect(render("NatEx: Dear {{consigneeName}}.", { consigneeName: "Meena" })).toEqual({
      text: "Dear Meena.",
      missing: [],
    });
  });

  test("renders the failed-attempt SMS with merchant and hub contact, without a tracking link", () => {
    const failed = DEFAULT_TEMPLATES.find((template) => template.key === "parcel.delivery_failed")!;
    const rendered = render(failed.bodySms, {
      consigneeName: "Meena",
      merchantName: "Royal Fabric",
      awb: "NX800002000",
      hubPhone: "+94771234567",
      reason: "Customer unavailable",
      attemptNo: "1",
    });
    expect(rendered.missing).toEqual([]);
    expect(rendered.text).toBe(
      "Dear Meena, Your order from Royal Fabric- NX800002000 has been rescheduled due to Customer unavailable. Please contact for further assistance +94771234567. Hotline: +94772772708.",
    );
    expect(rendered.text).not.toContain("NatEx: ");
    expect(rendered.text).not.toMatch(/https?:\/\//i);
    expect(rendered.text).not.toContain("natex.lk/track");
  });

  test("renders the destination-arrival SMS with total due and final-hub contact", () => {
    const arrival = DEFAULT_TEMPLATES.find((template) => template.key === "parcel.arrived_at_hub")!;
    const rendered = render(arrival.bodySms, {
      consigneeName: "Meena",
      merchantName: "Royal Fabric",
      awb: "NX800002000",
      codAmount: "Rs.4,800.00",
      amountDue: "Rs.5,200.00",
      amountDueLine: "Your COD amount is Rs.5,200.00 (including delivery charge); please keep this total amount ready.",
      hubPhone: "+94771234567",
    });
    expect(rendered.missing).toEqual([]);
    expect(rendered.text).toBe(
      "Dear Meena, Your package from Royal Fabric with Tracking number NX800002000. Your COD amount is Rs.5,200.00 (including delivery charge); please keep this total amount ready. Please contact for further assistance at +94771234567 (destination hub). Thank you.",
    );
    expect(rendered.text.length).toBeLessThanOrEqual(320);
    expect(rendered.text).not.toMatch(/^NatEx: /);
  });
});
