import { describe, expect, test } from "bun:test";
import type { OutboxEntry } from "./outbox";
import { assignmentNeedsRefresh, resolveStopView } from "./rider-run-reconcile";

function outboxEntry(
  state: OutboxEntry["state"],
  kind: OutboxEntry["kind"] = "delivery.deliver",
): OutboxEntry {
  return {
    clientOpId: "01JTESTDELIVERY000000000000",
    kind,
    awb: "NX4400440045",
    payload: {},
    seq: 1,
    clientTs: 1,
    state,
    error: "Parcel NX4400440045 is Delivered, not out for delivery.",
    policy: null,
    conflictId: null,
    result: null,
    tries: 1,
    settledAt: 2,
  };
}

describe("rider stop reconciliation", () => {
  test("server Delivered wins over a stale pending runsheet item and preserves the conflict record", () => {
    const conflict = outboxEntry("conflict");
    const result = resolveStopView({ status: "Delivered", state: "pending" }, conflict);

    expect(result.view).toBe("delivered");
    expect(result.entry).toBe(conflict);
  });

  test("a delivered runsheet item is non-actionable even if parcel status lags", () => {
    const result = resolveStopView({ status: "OutForDelivery", state: "delivered" }, null);
    expect(result.view).toBe("delivered");
  });

  test("an unresolved conflict on an out-for-delivery parcel remains a problem", () => {
    const conflict = outboxEntry("conflict");
    const result = resolveStopView({ status: "OutForDelivery", state: "pending" }, conflict);

    expect(result.view).toBe("problem");
    expect(result.entry).toBe(conflict);
  });

  test("a settled old failure does not block a newly dispatched reattempt", () => {
    const failure = outboxEntry("applied", "delivery.fail");
    const result = resolveStopView({ status: "OutForDelivery", state: "pending" }, failure);

    expect(result.view).toBe("todo");
    expect(result.entry).toBeNull();
  });

  test("a queued offline delivery remains visibly queued until the server responds", () => {
    expect(resolveStopView({ status: "OutForDelivery", state: "pending" }, outboxEntry("pending")).view).toBe(
      "queued_delivered",
    );
  });
});

describe("runsheet revision reconciliation", () => {
  const activeId = "run-1";

  test("refreshes when the same runsheet gets a new server revision", () => {
    expect(
      assignmentNeedsRefresh(
        { runsheetId: activeId, revision: "4:2:0:100" },
        { runsheetId: activeId, revision: "4:1:0:100" },
        activeId,
      ),
    ).toBe(true);
  });

  test("does not refresh when the same runsheet revision is unchanged", () => {
    expect(
      assignmentNeedsRefresh(
        { runsheetId: activeId, revision: "4:1:0:100" },
        { runsheetId: activeId, revision: "4:1:0:100" },
        activeId,
      ),
    ).toBe(false);
  });

  test("refreshes for a changed or removed assignment", () => {
    expect(
      assignmentNeedsRefresh(
        { runsheetId: "run-2", revision: "1:0:0:0" },
        { runsheetId: activeId, revision: "4:1:0:100" },
        activeId,
      ),
    ).toBe(true);
    expect(assignmentNeedsRefresh(null, null, activeId)).toBe(true);
  });
});
