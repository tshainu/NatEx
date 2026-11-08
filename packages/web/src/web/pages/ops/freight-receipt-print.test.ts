import { describe, expect, test } from "bun:test";
import { renderFreightReceiptDocument } from "./freight-receipt-print";

describe("freight counter printable document", () => {
  test("reuses the payment renderer and escapes sender and branch data", () => {
    const html = renderFreightReceiptDocument({
      booking: {
        freightCharge: {
          branchName: "Mannar Hub", senderName: "<script>bad()</script>", senderPhone: "0000000000",
          senderAddress: "Sample address", recipientName: "Sample recipient", recipientPhone: "0000000001",
          destinationAddress: "Test destination", awb: "NX1234567890", code: "FC-TEST", amountCents: 125000,
          payer: "sender", pricingSnapshotJson: null,
        },
        paidReceipt: { code: "RC-TEST", paymentMethod: "cash", externalReference: null },
        parcel: { description: "Test parcel", declaredValueCents: null },
      },
      branch: { name: "Mannar Hub", address: "Test & branch", phone: "0000000000" },
    });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("80mm");
    expect(html).toContain("/natex-logo.png");
    expect(html).toContain("RC-TEST");
    expect(html).toContain("Rs. 1,250.00");
    expect(html).toContain("Test &amp; branch");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>bad()");
  });
});
