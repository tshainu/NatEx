import { useQuery } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";
import { useIntentMutation, type Handlers } from "../lib/mutation";

/**
 * Settlement, hold and invoicing hooks (PROJECT.md §8 checkpoints 4–5, §10 M4
 * "settlement runs with maker–checker approval, payout file export, UTR" and
 * "invoicing with VAT/SSCL, credit notes, AR ageing").
 *
 * Reads on settlements, holds and invoices are `readProc`: a merchant gets its
 * own rows only, enforced by the server (§5). Previews, the due list and AR
 * ageing are staff reads. Every write is `financeProc`, and maker–checker is
 * the server's rule — the screen surfaces the refusal, it does not pre-empt it.
 */

const LIVE = 15_000;

export type FinanceOut<K extends keyof typeof client.finance> = Awaited<
  ReturnType<(typeof client.finance)[K]>
>;
export type FinanceIn<K extends keyof typeof client.finance> = Parameters<(typeof client.finance)[K]>[0];

export function useMerchantOptions() {
  return useQuery({ ...orpc.merchants.options.queryOptions(), staleTime: 5 * 60_000 });
}

export function useCurrentPeriod() {
  return useQuery({ ...orpc.finance.currentPeriod.queryOptions({ input: {} }), staleTime: 60_000 });
}

export function useSettlementDue(enabled = true) {
  return useQuery({
    ...orpc.finance.settlementDue.queryOptions({ input: {} }),
    enabled,
    refetchInterval: LIVE,
  });
}

export type SettlementFilter = Omit<NonNullable<FinanceIn<"settlementPage">>, "page" | "pageSize">;

export function useSettlementPage(filter: SettlementFilter, page: number, pageSize: number) {
  return useQuery({
    ...orpc.finance.settlementPage.queryOptions({ input: { ...filter, page, pageSize } }),
    placeholderData: (previous) => previous,
    refetchInterval: LIVE,
  });
}

export function useSettlement(settlementId: string | null) {
  return useQuery({
    ...orpc.finance.settlementById.queryOptions({ input: { settlementId: settlementId ?? "" } }),
    enabled: Boolean(settlementId),
  });
}

export function useSettlementPreview(input: FinanceIn<"settlementPreview"> | null) {
  return useQuery({
    ...orpc.finance.settlementPreview.queryOptions({
      input: input ?? { merchantId: "" },
    }),
    enabled: Boolean(input?.merchantId),
    placeholderData: (previous) => previous,
  });
}

export function usePayoutDetails(merchantId: string | null) {
  return useQuery({
    ...orpc.finance.payoutDetails.queryOptions({ input: { merchantId: merchantId ?? undefined } }),
    enabled: merchantId !== null,
  });
}

export type HoldFilter = Omit<NonNullable<FinanceIn<"holdPage">>, "page" | "pageSize">;

export function useHoldPage(filter: HoldFilter, page: number, pageSize: number) {
  return useQuery({
    ...orpc.finance.holdPage.queryOptions({ input: { ...filter, page, pageSize } }),
    placeholderData: (previous) => previous,
    refetchInterval: LIVE,
  });
}

export type InvoiceFilter = Omit<NonNullable<FinanceIn<"invoicePage">>, "page" | "pageSize">;

export function useInvoicePage(filter: InvoiceFilter, page: number, pageSize: number, enabled = true) {
  return useQuery({
    ...orpc.finance.invoicePage.queryOptions({ input: { ...filter, page, pageSize } }),
    enabled,
    placeholderData: (previous) => previous,
    refetchInterval: LIVE,
  });
}

export function useInvoice(invoiceId: string | null) {
  return useQuery({
    ...orpc.finance.invoiceById.queryOptions({ input: { invoiceId: invoiceId ?? "" } }),
    enabled: Boolean(invoiceId),
  });
}

export function useInvoicePreview(input: FinanceIn<"invoicePreview"> | null) {
  return useQuery({
    ...orpc.finance.invoicePreview.queryOptions({ input: input ?? { merchantId: "" } }),
    enabled: Boolean(input?.merchantId),
    placeholderData: (previous) => previous,
  });
}

export function useArAgeing(enabled = true) {
  return useQuery({
    ...orpc.finance.arAgeing.queryOptions({ input: {} }),
    enabled,
    refetchInterval: 60_000,
  });
}

/** The merchant's own account: what it is owed, its runs, holds and bank details. */
export function useMerchantStatement() {
  return useQuery({ ...orpc.finance.statement.queryOptions({ input: {} }), refetchInterval: 60_000 });
}

export function useMerchantAr() {
  return useQuery({ ...orpc.finance.merchantAr.queryOptions({ input: {} }), refetchInterval: 60_000 });
}

// ─────────────────────────────────────────────────────────────── writes

function writer<K extends keyof typeof client.finance>(key: K, fallback: string) {
  return (handlers: Handlers<FinanceOut<K>>) =>
    useIntentMutation(
      (input: FinanceIn<K>, options) =>
        (client.finance[key] as unknown as (
          i: FinanceIn<K>,
          o: typeof options,
        ) => Promise<FinanceOut<K>>)(input, options),
      handlers,
      fallback,
    );
}

export const useCreateSettlement = writer("createSettlement", "The settlement could not be drafted.");
export const useProposeSettlement = writer("proposeSettlement", "The settlement could not be proposed.");
export const useApproveSettlement = writer("approveSettlement", "The settlement could not be approved.");
export const useRejectSettlement = writer("rejectSettlement", "The settlement could not be rejected.");
export const useHoldSettlement = writer("holdSettlement", "The settlement could not be held.");
export const useReleaseSettlement = writer("releaseSettlement", "The settlement could not be released.");
export const useRecordPayout = writer("recordPayout", "The UTR could not be recorded.");
export const useExportPayoutCsv = writer("exportPayoutCsv", "The payout file could not be produced.");
export const useSetPayoutDetails = writer("setPayoutDetails", "The bank details could not be saved.");
export const useRaiseHold = writer("raiseHold", "The hold could not be raised.");
export const useClearHold = writer("clearHold", "The hold could not be cleared.");
export const useCreateInvoice = writer("createInvoice", "The invoice could not be drafted.");
export const useIssueInvoice = writer("issueInvoice", "The invoice could not be issued.");
export const useRecordInvoicePayment = writer("recordInvoicePayment", "The payment could not be recorded.");
export const useIssueCreditNote = writer("issueCreditNote", "The credit note could not be issued.");
export const useVoidInvoice = writer("voidInvoice", "The invoice could not be voided.");
