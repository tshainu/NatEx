import { describe, expect, test } from "bun:test";
import { mergeMerchantLabelSuggestions, parseMerchantLabelText } from "./merchant-label-ocr";

const districts = {
  "Northern Province": ["Jaffna", "Mannar", "Kilinochchi"],
  "Western Province": ["Colombo", "Gampaha", "Kalutara"],
} as const;

describe("Merchant parcel label OCR parsing", () => {
  test("uses the barcode AWB and maps labeled From/To details to booking suggestions", () => {
    const result = parseMerchantLabelText(
      [
        "NATEX PARCEL\nTracking Number: NX1234567890",
        "FROM:\nRoyal Fabric, 12 Lake Road, Colombo",
        "TO:\nName: Nimal Perera\nAddress: 45 Temple Street, Mannar, Northern Province\nPhone: 077 123 4567",
      ],
      ["NX 1234567890"],
      districts,
    );

    expect(result.awb).toBe("NX1234567890");
    expect(result.senderAddressText).toContain("Royal Fabric");
    expect(result.toAddressText).toContain("45 Temple Street");
    expect(result.consigneeName).toBe("Nimal Perera");
    expect(result.consigneePhone).toBe("0771234567");
    expect(result.destinationAddress).toEqual({
      line1: "45 Temple Street",
      line2: null,
      district: "Mannar",
      province: "Northern Province",
    });
  });

  test("falls back to the printed tracking number when image barcode decoding returns none", () => {
    const result = parseMerchantLabelText(
      ["TO: Nimal Perera\nNo 4 Main Road, Jaffna\nAWB: NX4400440041"],
      [],
      districts,
    );
    expect(result.awb).toBe("NX4400440041");
    expect(result.consigneeName).toBe("Nimal Perera");
    expect(result.destinationAddress?.district).toBe("Jaffna");
    expect(result.destinationAddress?.province).toBe("Northern Province");
  });

  test("does not invent a destination when the label has no recognizable To section", () => {
    const result = parseMerchantLabelText(
      ["NX1234567890", "Royal Fabric, 12 Lake Road, Colombo"],
      [],
      districts,
    );
    expect(result.awb).toBe("NX1234567890");
    expect(result.senderAddressText).toBeNull();
    expect(result.destinationAddress).toBeNull();
    expect(result.consigneeName).toBeNull();
    expect(result.consigneePhone).toBeNull();
  });

  test("normalizes an international Sri Lankan mobile number", () => {
    const result = parseMerchantLabelText(
      ["TO: Jane Perera\nAddress: 4 Temple Road, Colombo\nPhone: +94 77 123 4567"],
      [],
      districts,
    );
    expect(result.consigneePhone).toBe("0771234567");
  });

  test("uses close-up recipient text to improve the full-label suggestions without losing the barcode", () => {
    const fullLabel = parseMerchantLabelText(
      ["TO: Nimal Perera\nTemple Street, Mannar"],
      ["NX1234567890"],
      districts,
    );
    const closeUp = parseMerchantLabelText(
      ["TO: Name: Nimal Perera\nAddress: 45 Temple Street, Mannar, Northern Province\nPhone: 077 123 4567"],
      [],
      districts,
    );

    const merged = mergeMerchantLabelSuggestions(fullLabel, closeUp);
    expect(merged.awb).toBe("NX1234567890");
    expect(merged.consigneeName).toBe("Nimal Perera");
    expect(merged.consigneePhone).toBe("0771234567");
    expect(merged.destinationAddress?.line1).toBe("45 Temple Street");
    expect(merged.destinationAddress?.district).toBe("Mannar");
    expect(merged.toAddressText).toContain("45 Temple Street");
  });
});
