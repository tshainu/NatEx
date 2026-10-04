import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";

/**
 * Dashboard chart reads (Round 6). Every series is aggregated server-side:
 *
 *   parcels.trends     readProc — the caller's own §5 scope (merchant → its
 *                      account, ops → its branch, admin/finance → network)
 *   cod.dailyFlow      deskProc — ops, finance, admin
 *   dashboard.company  adminProc — the whole-company view
 *
 * Charts refresh on a slower cadence than the live tiles: a day-by-day series
 * does not change meaningfully every few seconds.
 */

const CHART_MS = 60_000;

export type ParcelTrends = Awaited<ReturnType<typeof client.parcels.trends>>;
export type CompanyDashboard = Awaited<ReturnType<typeof client.dashboard.company>>;

export function useParcelTrends(days = 30) {
  return useQuery({
    ...orpc.parcels.trends.queryOptions({ input: { days } }),
    refetchInterval: CHART_MS,
    placeholderData: keepPreviousData,
  });
}

export function useCodFlow(days = 30, enabled = true) {
  return useQuery({
    ...orpc.cod.dailyFlow.queryOptions({ input: { days } }),
    enabled,
    refetchInterval: CHART_MS,
    placeholderData: keepPreviousData,
  });
}

export function useCompanyDashboard(days = 30) {
  return useQuery({
    ...orpc.dashboard.company.queryOptions({ input: { days } }),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}
