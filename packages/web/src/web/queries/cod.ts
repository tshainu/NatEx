import { useQuery } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";
import { useIntentMutation, type Handlers } from "../lib/mutation";

/**
 * COD ledger data hooks (PROJECT.md §8, §10 M4): the ledger browser, the
 * four-way reconciliation, rider cash, deposits and banking, the controls
 * (stale collections, alerts, the nightly invariant) and the finance config.
 *
 * Reads are `staffProc` (ops, finance, admin) except `entries`, which is
 * `readProc` and merchant-scoped server-side. Every money write is
 * `financeProc` — ops is refused them by the server, and the screens hide the
 * buttons to match so nobody is offered a 403.
 */

const LIVE = 15_000;

export type CodOut<K extends keyof typeof client.cod> = Awaited<ReturnType<(typeof client.cod)[K]>>;
export type CodIn<K extends keyof typeof client.cod> = Parameters<(typeof client.cod)[K]>[0];

export type EntryFilter = Omit<NonNullable<CodIn<"entries">>, "limit" | "offset">;

export function useEntries(filter: EntryFilter, page: number, pageSize: number) {
  return useQuery({
    ...orpc.cod.entries.queryOptions({
      input: { ...filter, limit: pageSize, offset: (page - 1) * pageSize },
    }),
    placeholderData: (previous) => previous,
    refetchInterval: LIVE,
  });
}

export function useReconciliation(filter: CodIn<"reconciliation"> = {}) {
  return useQuery({
    ...orpc.cod.reconciliation.queryOptions({ input: filter }),
    refetchInterval: LIVE,
  });
}

export function useStale() {
  return useQuery({ ...orpc.cod.stale.queryOptions({ input: {} }), refetchInterval: LIVE });
}

export function useRiderCashBoard() {
  return useQuery({ ...orpc.cod.riderCashBoard.queryOptions({ input: {} }), refetchInterval: LIVE });
}

export type DepositFilter = Omit<NonNullable<CodIn<"depositPage">>, "page" | "pageSize">;

export function useDepositPage(filter: DepositFilter, page: number, pageSize: number) {
  return useQuery({
    ...orpc.cod.depositPage.queryOptions({ input: { ...filter, page, pageSize } }),
    placeholderData: (previous) => previous,
    refetchInterval: LIVE,
  });
}

export function useInvariantRuns(limit = 30) {
  return useQuery({ ...orpc.cod.invariantRuns.queryOptions({ input: { limit } }), refetchInterval: 60_000 });
}

export function useFinanceConfig() {
  return useQuery({ ...orpc.cod.listConfig.queryOptions({ input: {} }) });
}

export type AlertFilter = Omit<NonNullable<CodIn<"alertPage">>, "page" | "pageSize">;

export function useAlertPage(filter: AlertFilter, page: number, pageSize: number) {
  return useQuery({
    ...orpc.cod.alertPage.queryOptions({ input: { ...filter, page, pageSize } }),
    placeholderData: (previous) => previous,
    refetchInterval: LIVE,
  });
}

export function useAlertCounts() {
  return useQuery({ ...orpc.cod.alertCounts.queryOptions({ input: {} }), refetchInterval: LIVE });
}

// ─────────────────────────────────────────────────────────────── writes

export function useReverseEntry(handlers: Handlers<CodOut<"reverseEntry">>) {
  return useIntentMutation(
    (input: CodIn<"reverseEntry">, o) => client.cod.reverseEntry(input, o),
    handlers,
    "The entry could not be reversed.",
  );
}

export function useVerifyDeposit(handlers: Handlers<CodOut<"verifyDeposit">>) {
  return useIntentMutation(
    (input: CodIn<"verifyDeposit">, o) => client.cod.verifyDeposit(input, o),
    handlers,
    "The count could not be recorded.",
  );
}

export function useBankDeposit(handlers: Handlers<CodOut<"bankDeposit">>) {
  return useIntentMutation(
    (input: CodIn<"bankDeposit">, o) => client.cod.bankDeposit(input, o),
    handlers,
    "The banking could not be recorded.",
  );
}

export function useRunInvariant(handlers: Handlers<CodOut<"runInvariant">>) {
  return useIntentMutation(
    (input: CodIn<"runInvariant">, o) => client.cod.runInvariant(input, o),
    handlers,
    "The invariant check could not be run.",
  );
}

export function useSetConfig(handlers: Handlers<CodOut<"setConfig">>) {
  return useIntentMutation(
    (input: CodIn<"setConfig">, o) => client.cod.setConfig(input, o),
    handlers,
    "The setting could not be saved.",
  );
}

export function useAcknowledgeAlert(handlers: Handlers<CodOut<"acknowledgeAlert">>) {
  return useIntentMutation(
    (input: CodIn<"acknowledgeAlert">, o) => client.cod.acknowledgeAlert(input, o),
    handlers,
    "The alert could not be acknowledged.",
  );
}

export function useResolveAlert(handlers: Handlers<CodOut<"resolveAlert">>) {
  return useIntentMutation(
    (input: CodIn<"resolveAlert">, o) => client.cod.resolveAlert(input, o),
    handlers,
    "The alert could not be resolved.",
  );
}
