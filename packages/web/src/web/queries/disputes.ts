import { useQuery } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";
import { useIntentMutation, type Handlers } from "../lib/mutation";

/**
 * Disputes and claims (PROJECT.md §10 M4 "dispute queue, claim register").
 *
 * `disputeProc` admits merchants, ops and finance: a merchant opens, lists and
 * withdraws its own cases (another merchant's case is a 404, §5). Assigning and
 * deciding a case is finance only, and the opener can never decide their own
 * case — the server enforces that by user id.
 */

const LIVE = 15_000;

export type DisputeOut<K extends keyof typeof client.disputes> = Awaited<
  ReturnType<(typeof client.disputes)[K]>
>;
export type DisputeIn<K extends keyof typeof client.disputes> = Parameters<(typeof client.disputes)[K]>[0];
export type DisputeRow = DisputeOut<"list">["rows"][number];

export type DisputeFilter = Omit<NonNullable<DisputeIn<"list">>, "limit" | "offset">;

export function useDisputePage(filter: DisputeFilter, page: number, pageSize: number) {
  return useQuery({
    ...orpc.disputes.list.queryOptions({
      input: { ...filter, limit: pageSize, offset: (page - 1) * pageSize },
    }),
    placeholderData: (previous) => previous,
    refetchInterval: LIVE,
  });
}

export function useDispute(disputeId: string | null) {
  return useQuery({
    ...orpc.disputes.get.queryOptions({ input: { disputeId: disputeId ?? "" } }),
    enabled: Boolean(disputeId),
  });
}

export function useDisputeCounts() {
  return useQuery({ ...orpc.disputes.counts.queryOptions({ input: {} }), refetchInterval: LIVE });
}

export function useDisputeMeta() {
  return useQuery({ ...orpc.disputes.meta.queryOptions({ input: {} }), staleTime: 10 * 60_000 });
}

export function useOpenDispute(handlers: Handlers<DisputeOut<"open">>) {
  return useIntentMutation(
    (input: DisputeIn<"open">, o) => client.disputes.open(input, o),
    handlers,
    "The case could not be opened.",
  );
}

export function useWithdrawDispute(handlers: Handlers<DisputeOut<"withdraw">>) {
  return useIntentMutation(
    (input: DisputeIn<"withdraw">, o) => client.disputes.withdraw(input, o),
    handlers,
    "The case could not be withdrawn.",
  );
}

export function useAssignDispute(handlers: Handlers<DisputeOut<"assign">>) {
  return useIntentMutation(
    (input: DisputeIn<"assign">, o) => client.disputes.assign(input, o),
    handlers,
    "The case could not be picked up.",
  );
}

export function useResolveDispute(handlers: Handlers<DisputeOut<"resolve">>) {
  return useIntentMutation(
    (input: DisputeIn<"resolve">, o) => client.disputes.resolve(input, o),
    handlers,
    "The case could not be decided.",
  );
}
