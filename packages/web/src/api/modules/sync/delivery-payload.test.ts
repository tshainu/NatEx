import { describe, expect, test } from "bun:test";
import { sanitizeDeliveryPayload } from "./delivery-payload";

describe("delivery sync payload privacy", () => {
  test("retains only the masked NIC field and drops full/raw NIC properties", () => {
    const safe = sanitizeDeliveryPayload({
      awb: "NX123456789",
      receiverPhone: "+94771234567",
      receiverNicLast4: "5678",
      receiverNic: "200012345678",
      nic: "200012345678",
      nicNumber: "200012345678",
      rawNic: "200012345678",
    });
    expect(safe).toEqual({
      awb: "NX123456789",
      receiverPhone: "+94771234567",
      receiverNicLast4: "5678",
    });
    expect(JSON.stringify(safe)).not.toContain("200012345678");
  });
});
