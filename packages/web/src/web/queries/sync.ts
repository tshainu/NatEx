import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
} from "@tanstack/react-query";
import { orpc, apiMessage } from "../lib/api";

/**
 * sync (Milestone 3) data hooks — the ops half of PROJECT.md §7.
 *
 * §7 closes with a requirement, not a suggestion: "Every unresolved conflict
 * appears in the Ops exception queue. Silent data loss is unacceptable in a
 * logistics system." These hooks feed the screen that discharges it, plus the
 * fleet-health view that tells ops which devices are behind and whose clock is
 * so far out that their captured timestamps cannot be trusted.
 *
 * Every read here is `opsProc` server-side (ops and admin only — transport is
 * NOT admitted, unlike the custody exception queue) and additionally
 * branch-scoped in the service (§5), so a Kandy ops user sees Kandy's
 * conflicts even though the role check would have passed either way.
 *
 * Polling, not sockets: §2 specifies Socket.io and this build has none, so the
 * live views refresh on an interval. Same deviation, same interval, as
 * queries/transport.ts.
 */

const LIVE = 5_000;

export type ConflictState = "open" | "reviewing" | "resolved" | "dismissed";

export type ConflictPolicy =
  | "duplicate_operation"
  | "duplicate_claim"
  | "offline_delivery_vs_fail"
  | "double_cod"
  | "stale_runsheet"
  | "illegal_state"
  | "unknown_kind";

export type ConflictResolution =
  | "accepted_client"
  | "kept_server"
  | "manual_correction"
  | "dismissed";

export function useSyncConflicts(filter: {
  state?: ConflictState[];
  policy?: ConflictPolicy;
  limit?: number;
}) {
  return useQuery({
    ...orpc.sync.conflicts.queryOptions({ input: { limit: 150, ...filter } }),
    refetchInterval: LIVE,
  });
}

export function useSyncConflictCounts() {
  return useQuery({
    ...orpc.sync.conflictCounts.queryOptions({ input: {} }),
    refetchInterval: LIVE,
  });
}

/**
 * One conflict in full: the device's claim and the server's state side by side,
 * plus the journal row the conflict was raised from. Fetched on demand when the
 * drawer opens rather than fattening the list payload — the list is a queue,
 * this is the evidence.
 */
export function useSyncConflict(conflictId: string | null) {
  return useQuery({
    ...orpc.sync.conflictGet.queryOptions({ input: { conflictId: conflictId ?? "" } }),
    enabled: Boolean(conflictId),
  });
}

/** Fleet health (§7): who is behind, who has a backlog, whose clock is wrong. */
export function useSyncDevices() {
  return useQuery({
    ...orpc.sync.devices.queryOptions({ input: { limit: 100 } }),
    refetchInterval: LIVE,
  });
}

/**
 * Both mutations invalidate everything. Claiming or resolving a conflict moves
 * it between the queue, the tally strip and the device's own counts at once,
 * and a stale tally on an exception screen is worse than a redundant refetch.
 */
function useSyncMutation<TInput, TResult>(
  options: UseMutationOptions<TResult, Error, TInput>,
  handlers: { onSuccess?: (result: TResult) => void; onError?: (message: string) => void },
  fallback: string,
) {
  const queryClient = useQueryClient();
  return useMutation<TResult, Error, TInput>({
    ...options,
    onSuccess: (result: TResult) => {
      void queryClient.invalidateQueries();
      handlers.onSuccess?.(result);
    },
    onError: (error: Error) => handlers.onError?.(apiMessage(error, fallback)),
  });
}

/**
 * Take a conflict off the pile. The server refuses the second claimant with a
 * 409 rather than letting two ops users work the same dispute — the error text
 * that comes back names who holds it.
 */
export function useSyncConflictClaim(handlers: {
  onSuccess?: (result: unknown) => void;
  onError?: (message: string) => void;
}) {
  return useSyncMutation(
    orpc.sync.conflictClaim.mutationOptions(),
    handlers,
    "That conflict could not be claimed.",
  );
}

export function useSyncConflictResolve(handlers: {
  onSuccess?: (result: unknown) => void;
  onError?: (message: string) => void;
}) {
  return useSyncMutation(
    orpc.sync.conflictResolve.mutationOptions(),
    handlers,
    "That conflict could not be resolved.",
  );
}
