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
    expect(html).toContain("@page { size: 6in 3in");
    expect(html).toContain("grid-template-columns: 0.92in 5.08in");
    expect(html).toContain("transform: rotate(-90deg)");
    expect(html).toContain("/natex-label-logo.jpg");
    expect(html).toContain("0 (Paid)");
    expect(html).toContain("Tracking Number");
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
    expect(html).toContain("1,250/-");
    expect(html).toContain("1,700/-");
    expect(html).toContain("<img src=\"/natex-label-logo.jpg\"");
  });

  test("escapes recipient and sender content", () => {
    const html = renderAddressLabel({ ...base, recipientName: "<script>bad()</script>" });
    expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(html).not.toContain("<script>bad()</script>");
  });

  test("keeps each comma-separated address detail visible on its own line", () => {
    const html = renderAddressLabel({
      ...base,
      recipientAddress: "14A, 1st Cross street, Wellawatta, Colombo-06",
      senderAddress: "24, Temple street, Nallur, Jaffna",
    });
    expect(html).toContain("14A<br>1st Cross street<br>Wellawatta<br>Colombo-06");
    expect(html).toContain("24<br>Temple street<br>Nallur<br>Jaffna");
    expect(html).not.toContain("text-overflow: ellipsis");
  });

  test("keeps a long sender address inside the reserved From row", () => {
    const html = renderAddressLabel({
      ...base,
      senderName: "A Sender With A Longer Registered Business Name",
      senderAddress: "No. 24, Temple street, Nallur, Jaffna, Northern Province, Sri Lanka",
    });
    expect(html).toContain("grid-template-rows: 1.88in 1fr");
    expect(html).toContain(".from-block { border-top: 1px solid #222");
    expect(html).toContain("font-size: 0.145in; line-height: 1.02");
    expect(html).toContain("No. 24<br>Temple street<br>Nallur<br>Jaffna<br>Northern Province<br>Sri Lanka");
  });

  test("allows a wrapped delivery charge while retaining every package row", () => {
    const html = renderAddressLabel({
      ...base,
      deliveryCharge: "Rs. 1,250.00 (weight-based)",
      totalCollectCents: 170000,
      advancedPaidCents: 50000,
    });
    expect(html).toContain("grid-template-rows: 2.05in 1fr");
    expect(html).toContain("overflow-wrap: anywhere; white-space: normal");
    expect(html).toContain(".details th { width: 52%");
    expect(html).toContain(".details td { width: 48%");
    expect(html).toContain("Delivery charge");
    expect(html).toContain("Rs. 1,250.00 (weight-based)");
    expect(html).toContain("Total collect");
    expect(html).toContain("Advanced paid");
  });
});
