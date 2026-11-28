import { describe, expect, test } from "bun:test";
import { renderAddressLabel, type AddressLabelData } from "./address-label-print";

const base: AddressLabelData = {
  awb: "NX1234567890",
  recipientName: "Recipient Name",
  recipientPhone: "0770000000",
  recipientAddress: "Recipient address",
  senderName: "Sender Name",
  senderPhone: "0710000000",
  senderAddress: "Sender address",
  weightGrams: 1500,
  codStatus: "No — prepaid",
  codAmountCents: 0,
  deliveryCharge: "Rs. 450.00",
  totalCollectCents: 45000,
  advancedPaidCents: 0,
};

describe("NatEx address label", () => {
  test("prints zero paid delivery charge and keeps the sticker area", () => {
    const html = renderAddressLabel({ ...base, deliveryCharge: "0 (Paid)", totalCollectCents: 0, advancedPaidCents: 45000 });
    expect(html).toContain("0 (Paid)");
    expect(html).toContain("Tracking label");
    expect(html).toContain("NX1234567890");
  });

  test("prints the unpaid weight-based charge and COD totals", () => {
    const html = renderAddressLabel({
      ...base,
      codStatus: "Yes",
      codAmountCents: 125000,
      deliveryCharge: "Rs. 450.00",
      totalCollectCents: 170000,
    });
    expect(html).toContain("Rs. 450.00");
    expect(html).toContain("Rs. 1250.00");
    expect(html).toContain("Rs. 1700.00");
    expect(html).toContain("<img src=\"/natex-logo.png\"");
  });

  test("escapes recipient and sender content", () => {
    const html = renderAddressLabel({ ...base, recipientName: "<script>bad()</script>" });
    expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(html).not.toContain("<script>bad()</script>");
  });
});
