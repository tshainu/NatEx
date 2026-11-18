export interface AccountabilityMoveEvent {
  id: string;
  ts: number | bigint | string | Date;
  notes: string | null;
}

export type OriginBranchDerivation =
  | { originBranchId: string; source: "existing" | "first-transfer" | "current-branch" }
  | { originBranchId: null; source: "malformed-transfer" | "ambiguous-transfer" | "missing-current-branch" };

function timestampValue(value: AccountabilityMoveEvent["ts"]): number {
  if (value instanceof Date) return value.getTime();
  return Number(value);
}

/**
 * Derive the immutable sender branch for a parcel that predates origin_branch_id.
 * The earliest append-only accountability move is authoritative. With no move
 * event, the legacy current branch is the booking branch. Malformed or
 * same-time conflicting evidence is left unresolved rather than guessed.
 */
export function deriveOriginBranch(
  currentBranchId: string | null | undefined,
  events: readonly AccountabilityMoveEvent[],
  existingOriginBranchId?: string | null,
): OriginBranchDerivation {
  const existing = existingOriginBranchId?.trim();
  if (existing) return { originBranchId: existing, source: "existing" };

  const movementEvents = events.filter((event) =>
    event.notes?.includes("Accountability moved from"),
  );
  if (movementEvents.length === 0) {
    const current = currentBranchId?.trim();
    return current
      ? { originBranchId: current, source: "current-branch" }
      : { originBranchId: null, source: "missing-current-branch" };
  }

  const parsed = movementEvents.map((event) => {
    const match = event.notes?.match(/Accountability moved from ([^\s.]+) to ([^\s.]+)\./);
    const ts = timestampValue(event.ts);
    return {
      ts,
      valid: Number.isFinite(ts) && Boolean(match),
      fromBranchId: match?.[1] ?? null,
    };
  });
  const validTimes = parsed.filter((event) => Number.isFinite(event.ts)).map((event) => event.ts);
  if (validTimes.length === 0) return { originBranchId: null, source: "malformed-transfer" };

  const firstTimestamp = Math.min(...validTimes);
  const firstEvents = parsed.filter((event) => event.ts === firstTimestamp);
  if (firstEvents.some((event) => !event.valid || !event.fromBranchId)) {
    return { originBranchId: null, source: "malformed-transfer" };
  }
  const firstOrigins = new Set(firstEvents.map((event) => event.fromBranchId!));
  if (firstOrigins.size !== 1) return { originBranchId: null, source: "ambiguous-transfer" };

  return {
    originBranchId: [...firstOrigins][0]!,
    source: "first-transfer",
  };
}
