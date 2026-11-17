import { describe, expect, it } from "bun:test";
import { parseMerchantLabelText } from "./merchant-label-ocr";

describe("Merchant parcel-label OCR parser", () => {
  it("prefers a decoded barcode and maps labeled From/To data into booking fields", () => {
    const result = parseMerchantLabelText(
      [
        "From: NatEx Trading, 45 Main Road, Colombo",
        "To:",
        "Recipient: Nimal Perera",
        "Address: No. 21, Main Street, Jaffna, Northern Province",
        "Phone: +94 77 123 4567",
        "Tracking No: NX9999999999",
      ].join("\n"),
      "NX8000000123",
    );

    expect(result.awb).toBe("NX8000000123");
    expect(result.fromAddressText).toContain("45 Main Road");
    expect(result.consigneeName).toBe("Nimal Perera");
    expect(result.consigneePhone).toBe("0771234567");
    expect(result.destAddress).toEqual({
      line1: "No. 21",
      line2: "Main Street",
      district: "Jaffna",
      province: "Northern Province",
    });
  });

  it("parses a spaced AWB from printed OCR text and does not guess an unlabelled address", () => {
    const result = parseMerchantLabelText("Tracking number: NX 12345 67890\nNo. 21, Jaffna");

    expect(result.awb).toBe("NX1234567890");
    expect(result.toAddressText).toBeNull();
    expect(result.destAddress).toBeNull();
  });

  it("keeps a recognized tracking barcode when no To section is readable", () => {
    const result = parseMerchantLabelText("NatEx parcel label\nFrom: Colombo", "NX1234567890");

    expect(result.awb).toBe("NX1234567890");
    expect(result.toAddressText).toBeNull();
    expect(result.consigneeName).toBeNull();
  });

  it("normalizes a local-format recipient mobile from the To block", () => {
    const result = parseMerchantLabelText("To:\n077 123 4567\n12 Lake Road, Kandy, Central Province");

    expect(result.consigneePhone).toBe("0771234567");
    expect(result.destAddress?.district).toBe("Kandy");
    expect(result.destAddress?.province).toBe("Central Province");
  });
});
