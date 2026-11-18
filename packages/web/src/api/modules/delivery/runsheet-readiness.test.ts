import { describe, expect, test } from "bun:test";
import { RUNSHEET_ELIGIBLE_STATUSES, runsheetReadiness } from "./runsheet-readiness";

describe("runsheet stop readiness", () => {
  test("rejects an accountable-branch mismatch regardless of the operator's system role", () => {
    const result = runsheetReadiness({
      parcelStatus: "AtDestHub",
      parcelBranchId: "mannar-hub",
      runsheetBranchId: "jaffna-hub",
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toContain("different accountable branch");
    expect(result.correction).toContain("authorized branch transfer");
  });

  test("allows a destination-hub parcel on a runsheet for the same branch", () => {
    expect(runsheetReadiness({
      parcelStatus: "AtDestHub",
      parcelBranchId: "mannar-hub",
      runsheetBranchId: "mannar-hub",
    })).toEqual({ ready: true });
  });

  test("keeps the currently approved delivery and retry statuses eligible", () => {
    expect(RUNSHEET_ELIGIBLE_STATUSES).toEqual(["AtDestHub", "DeliveryAttempted", "OnHold"]);
    for (const parcelStatus of ["DeliveryAttempted", "OnHold"]) {
      expect(runsheetReadiness({
        parcelStatus,
        parcelBranchId: "mannar-hub",
        runsheetBranchId: "mannar-hub",
        reattemptAllowed: true,
      })).toEqual({ ready: true });
    }
  });

  test("holds a parcel in transit out of the run and tells Ops to complete hub receipt", () => {
    const result = runsheetReadiness({
      parcelStatus: "InTransit",
      parcelBranchId: "mannar-hub",
      runsheetBranchId: "mannar-hub",
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toContain("In transit");
    expect(result.correction).toContain("destination hub");
  });

  test("holds a retry-stop until its retry gate is cleared", () => {
    const result = runsheetReadiness({
      parcelStatus: "DeliveryAttempted",
      parcelBranchId: "mannar-hub",
      runsheetBranchId: "mannar-hub",
      reattemptAllowed: false,
      reattemptReason: "The retry window has expired.",
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("The retry window has expired.");
    expect(result.correction).toContain("Resolve the failed-delivery/retry hold");
  });
});
