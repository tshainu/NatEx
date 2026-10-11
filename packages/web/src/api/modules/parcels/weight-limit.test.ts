import { expect, test } from "bun:test";
import type { Principal } from "../../shared/auth";
import { createParcel, type CreateParcelInput } from "./service";

const admin: Principal = {
  userId: "usr_weight_limit_test",
  name: "Weight limit test",
  role: "admin",
  roles: ["admin"],
  branchId: "brn_weight_limit_test",
};

const parcelInput = (overrides: Partial<CreateParcelInput> = {}): CreateParcelInput => ({
  merchantId: "mch_weight_limit_test",
  branchId: "brn_weight_limit_test",
  weightGrams: 30_001,
  declaredValueCents: 0,
  codAmountCents: 0,
  originAddress: "1 Test Road, Colombo",
  consigneeName: "Test Recipient",
  consigneePhone: "+94700000000",
  destAddress: "2 Test Road, Kandy",
  ...overrides,
});

test("merchant booking service rejects actual weight over 30 kg before database access", async () => {
  await expect(createParcel(parcelInput(), admin)).rejects.toThrow("30 kg");
});

test("merchant booking service rejects volumetric chargeable weight over 30 kg", async () => {
  await expect(createParcel(parcelInput({
    weightGrams: 1000,
    lengthCm: 101,
    widthCm: 50,
    heightCm: 30,
  }), admin)).rejects.toThrow("30 kg");
});
