import { describe, expect, test } from "bun:test";
import { deriveOriginBranch, type AccountabilityMoveEvent } from "./origin-branch";

const move = (
  id: string,
  ts: number,
  from: string,
  to: string,
): AccountabilityMoveEvent => ({
  id,
  ts,
  notes: `Hub receipt recorded. Accountability moved from ${from} to ${to}.`,
});

describe("legacy sender-branch derivation", () => {
  test("uses the current branch only when there is no movement evidence", () => {
    expect(deriveOriginBranch("branch-a", [])).toEqual({
      originBranchId: "branch-a",
      source: "current-branch",
    });
  });

  test("uses the source of the first audited movement, not the last accountable branch", () => {
    expect(deriveOriginBranch("branch-c", [
      move("later", 30, "branch-b", "branch-c"),
      move("first", 20, "branch-a", "branch-b"),
    ])).toEqual({
      originBranchId: "branch-a",
      source: "first-transfer",
    });
  });

  test("preserves an already-recorded origin", () => {
    expect(deriveOriginBranch("branch-c", [move("first", 20, "branch-a", "branch-b")], "branch-z"))
      .toEqual({ originBranchId: "branch-z", source: "existing" });
  });

  test("leaves malformed earliest movement history unresolved", () => {
    expect(deriveOriginBranch("branch-c", [
      { id: "bad", ts: 10, notes: "Accountability moved from an unknown format" },
      move("later", 20, "branch-a", "branch-b"),
    ])).toEqual({ originBranchId: null, source: "malformed-transfer" });
  });

  test("leaves conflicting same-time first movements unresolved", () => {
    expect(deriveOriginBranch("branch-c", [
      move("first-a", 10, "branch-a", "branch-c"),
      move("first-b", 10, "branch-b", "branch-c"),
    ])).toEqual({ originBranchId: null, source: "ambiguous-transfer" });
  });

  test("does not invent an origin when both history and current branch are absent", () => {
    expect(deriveOriginBranch(null, [])).toEqual({
      originBranchId: null,
      source: "missing-current-branch",
    });
  });
});
