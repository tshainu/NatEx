import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
} from "@tanstack/react-query";
import { orpc, apiMessage, type client } from "../lib/api";

/**
 * delivery (Milestone 3) data hooks — the ops desk's view of the last mile:
 * runsheets, their stops and the cash each rider is carrying (PROJECT.md §5
 * delivery module, §6 POD rules, §10 M3).
 *
 * Reads are `staffProc` server-side and branch-scoped in the service (§5): a
 * Kandy ops user sees Kandy's runs whatever filter they send. Building and
 * dispatching a run is `transportProc` (ops and admin are admitted); closing a
 * run is `opsProc` only — a transport clerk cannot close a rider's cash
 * position.
 *
 * Polling, not sockets (§2 deviation, same interval as queries/sync.ts).
 */

const LIVE = 10_000;

export type RunsheetStatus = "draft" | "dispatched" | "closed" | "cancelled";

export interface RunsheetFilter {
  status?: RunsheetStatus[];
  runDate?: string;
  search?: string;
  page: number;
  pageSize: number;
}

export function useRunsheetPage(filter: RunsheetFilter) {
  return useQuery({
    ...orpc.delivery.runsheetPage.queryOptions({ input: filter }),
    refetchInterval: LIVE,
    placeholderData: (previous) => previous,
  });
}

export function useRunsheet(runsheetId: string | null) {
  return useQuery({
    ...orpc.delivery.runsheetGet.queryOptions({ input: { runsheetId: runsheetId ?? "" } }),
    enabled: Boolean(runsheetId),
    refetchInterval: LIVE,
  });
}

/** Today's tally strip: runs, stops, and COD expected against collected. */
export function useDeliveryCounts() {
  return useQuery({
    ...orpc.delivery.counts.queryOptions({ input: {} }),
    refetchInterval: LIVE,
  });
}

/** Riders on this branch's roster — the only people a run can be opened for. */
export function useRiders() {
  return useQuery({
    ...orpc.identity.listRiders.queryOptions(),
    staleTime: 60_000,
  });
}

/** Stock at the hub that may legally go out, and what is blocked and why. */
export function useDeliverable(enabled: boolean) {
  return useQuery({
    ...orpc.delivery.deliverable.queryOptions({ input: {} }),
    enabled,
  });
}

/**
 * Every delivery mutation invalidates everything: a dispatch moves parcels on
 * the board, the runsheet list, the drawer and the tallies at once, and a stale
 * COD figure on a cash screen is worse than a redundant refetch.
 */
function useDeliveryMutation<TInput, TResult>(
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

type Handlers<T> = { onSuccess?: (result: T) => void; onError?: (message: string) => void };
/** The resolved result of a delivery route, straight from the router's types. */
export type DeliveryOut<K extends keyof typeof client.delivery> = Awaited<
  ReturnType<(typeof client.delivery)[K]>
>;

export function useRunsheetCreate(handlers: Handlers<DeliveryOut<"runsheetCreate">>) {
  return useDeliveryMutation(
    orpc.delivery.runsheetCreate.mutationOptions(),
    handlers,
    "The runsheet could not be opened.",
  );
}

export function useRunsheetAdd(handlers: Handlers<DeliveryOut<"runsheetAdd">>) {
  return useDeliveryMutation(
    orpc.delivery.runsheetAdd.mutationOptions(),
    handlers,
    "Those stops could not be added.",
  );
}

export function useRunsheetRemove(handlers: Handlers<DeliveryOut<"runsheetRemove">>) {
  return useDeliveryMutation(
    orpc.delivery.runsheetRemove.mutationOptions(),
    handlers,
    "That stop could not be taken off the run.",
  );
}

export function useRunsheetOptimise(handlers: Handlers<DeliveryOut<"runsheetOptimise">>) {
  return useDeliveryMutation(
    orpc.delivery.runsheetOptimise.mutationOptions(),
    handlers,
    "The stops could not be ordered.",
  );
}

export function useRunsheetDispatch(handlers: Handlers<DeliveryOut<"runsheetDispatch">>) {
  return useDeliveryMutation(
    orpc.delivery.runsheetDispatch.mutationOptions(),
    handlers,
    "The run could not be dispatched.",
  );
}

export function useRunsheetCancel(handlers: Handlers<DeliveryOut<"runsheetCancel">>) {
  return useDeliveryMutation(
    orpc.delivery.runsheetCancel.mutationOptions(),
    handlers,
    "The draft could not be cancelled.",
  );
}

export function useRunsheetClose(handlers: Handlers<DeliveryOut<"runsheetClose">>) {
  return useDeliveryMutation(
    orpc.delivery.runsheetClose.mutationOptions(),
    handlers,
    "The run could not be closed.",
  );
}
