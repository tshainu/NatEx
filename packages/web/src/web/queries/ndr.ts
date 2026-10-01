import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
} from "@tanstack/react-query";
import { orpc, apiMessage, type client } from "../lib/api";

/**
 * NDR and RTO data hooks (PROJECT.md §8 NDR/SLA, §6 RTO transitions, §10 M3).
 *
 * Shared by the ops queue (/ops/ndr) and the merchant's own NDR screen. Reads
 * are `readProc` server-side; the service scopes a merchant to its own rows and
 * refuses a merchant naming another merchant with 403 (§5). Instructing is
 * `ndrProc` (merchant or ops on their behalf); closing without an instruction
 * and initiating an RTO by hand are `opsProc`.
 */

const LIVE = 10_000;

export type NdrState =
  | "open"
  | "instructed"
  | "reattempt_scheduled"
  | "rto"
  | "resolved"
  | "closed";

export type RtoState = "initiated" | "in_transit" | "delivered" | "closed";

export type NdrOut<K extends keyof typeof client.ndr> = Awaited<
  ReturnType<(typeof client.ndr)[K]>
>;
export type NdrQueueRow = NdrOut<"page">["rows"][number];
export type RtoQueueRow = NdrOut<"rtoPage">["rows"][number];

export function useNdrPage(filter: {
  state?: NdrState[];
  merchantId?: string;
  overdueOnly?: boolean;
  search?: string;
  page: number;
  pageSize: number;
}) {
  return useQuery({
    ...orpc.ndr.page.queryOptions({ input: filter }),
    refetchInterval: LIVE,
    placeholderData: (previous) => previous,
  });
}

export function useNdrCounts() {
  return useQuery({
    ...orpc.ndr.counts.queryOptions({ input: {} }),
    refetchInterval: LIVE,
  });
}

export function useNdr(ndrId: string | null) {
  return useQuery({
    ...orpc.ndr.get.queryOptions({ input: { ndrId: ndrId ?? "" } }),
    enabled: Boolean(ndrId),
  });
}

export function useRtoPage(filter: {
  state?: RtoState[];
  search?: string;
  page: number;
  pageSize: number;
}) {
  return useQuery({
    ...orpc.ndr.rtoPage.queryOptions({ input: filter }),
    refetchInterval: LIVE,
    placeholderData: (previous) => previous,
  });
}

export function useRtoCounts() {
  return useQuery({
    ...orpc.ndr.rtoCounts.queryOptions({ input: {} }),
    refetchInterval: LIVE,
  });
}

export function useRto(rtoId: string | null) {
  return useQuery({
    ...orpc.ndr.rtoGet.queryOptions({ input: { rtoId: rtoId ?? "" } }),
    enabled: Boolean(rtoId),
  });
}

type Handlers<T> = { onSuccess?: (result: T) => void; onError?: (message: string) => void };

function useNdrMutation<TInput, TResult>(
  options: UseMutationOptions<TResult, Error, TInput>,
  handlers: Handlers<TResult>,
  fallback: string,
) {
  const queryClient = useQueryClient();
  return useMutation<TResult, Error, TInput>({
    ...options,
    onSuccess: (result: TResult) => {
      // An instruction moves the NDR, the parcel, maybe an RTO, and the tallies.
      void queryClient.invalidateQueries();
      handlers.onSuccess?.(result);
    },
    onError: (error: Error) => handlers.onError?.(apiMessage(error, fallback)),
  });
}

export function useNdrInstruct(handlers: Handlers<NdrOut<"instruct">>) {
  return useNdrMutation(orpc.ndr.instruct.mutationOptions(), handlers, "The instruction was not recorded.");
}

export function useNdrClose(handlers: Handlers<NdrOut<"close">>) {
  return useNdrMutation(orpc.ndr.close.mutationOptions(), handlers, "The NDR could not be closed.");
}

export function useRtoInitiate(handlers: Handlers<NdrOut<"rtoInitiate">>) {
  return useNdrMutation(orpc.ndr.rtoInitiate.mutationOptions(), handlers, "The return could not be started.");
}

export function useRtoDispatch(handlers: Handlers<NdrOut<"rtoDispatch">>) {
  return useNdrMutation(orpc.ndr.rtoDispatch.mutationOptions(), handlers, "The return could not be dispatched.");
}

export function useRtoDeliver(handlers: Handlers<NdrOut<"rtoDeliver">>) {
  return useNdrMutation(orpc.ndr.rtoDeliver.mutationOptions(), handlers, "The hand-back could not be recorded.");
}
