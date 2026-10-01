import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";

/**
 * Merchant-portal data hooks (§10 M3 "Merchant portal: dashboard, booking,
 * bulk upload, pickups, tracking, NDR").
 *
 * Every read is `readProc` server-side and the service scopes a merchant to its
 * own rows (§5) — nothing here passes a merchant id to a read, so nothing here
 * could widen the scope. Writes that must name the merchant (booking, pickup
 * request) pass the session's own `merchantId`; the server refuses any other
 * with 403.
 */

const LIVE = 15_000;

type Out<N extends keyof typeof client, K extends keyof (typeof client)[N]> = (typeof client)[N][K] extends (
  ...args: never[]
) => Promise<infer R>
  ? R
  : never;

export type ParcelSummary = Out<"parcels", "summary">;
export type PickupRequestRow = Out<"collection", "pickupRequests">["rows"][number];
export type BulkReport = Out<"parcels", "bulkCreate">;

export function useMerchantProfile() {
  return useQuery({
    ...orpc.merchants.list.queryOptions({ input: { page: 1, pageSize: 1 } }),
    staleTime: 5 * 60_000,
    select: (data) => data.rows[0] ?? null,
  });
}

export function useParcelSummary() {
  return useQuery({ ...orpc.parcels.summary.queryOptions(), refetchInterval: LIVE });
}

export function usePickupCounts() {
  return useQuery({
    ...orpc.collection.pickupRequestCounts.queryOptions({ input: {} }),
    refetchInterval: LIVE,
  });
}

export type PickupStatus = "requested" | "scheduled" | "cancelled";

export function usePickupRequests(filter: { page: number; pageSize: number; status?: PickupStatus[] }) {
  return useQuery({
    ...orpc.collection.pickupRequests.queryOptions({ input: filter }),
    placeholderData: (prev) => prev,
    refetchInterval: LIVE,
  });
}

/** Booked parcels that a pickup request may still name. */
export function useBookedParcels(search: string) {
  return useQuery({
    ...orpc.parcels.list.queryOptions({
      input: { page: 1, pageSize: 100, status: ["Booked"], search: search.trim() || undefined },
    }),
    placeholderData: (prev) => prev,
  });
}

function useInvalidateMerchant() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: orpc.collection.key() }),
      qc.invalidateQueries({ queryKey: orpc.parcels.key() }),
    ]);
}

export function useRequestPickup() {
  const invalidate = useInvalidateMerchant();
  return useMutation({
    mutationFn: (input: Parameters<typeof client.collection.requestPickup>[0]) =>
      client.collection.requestPickup(input),
    onSuccess: () => invalidate(),
  });
}

export function useCancelPickup() {
  const invalidate = useInvalidateMerchant();
  return useMutation({
    mutationFn: (input: { id: string; reason: string }) => client.collection.cancelPickupRequest(input),
    onSuccess: () => invalidate(),
  });
}

/**
 * One bulk chunk. The key is supplied by the caller so a retry of the SAME
 * chunk replays the server's first answer instead of booking twice (§4).
 */
export function bulkChunk(
  input: { merchantId: string; dryRun: boolean; rows: Record<string, unknown>[] },
  idempotencyKey: string,
) {
  return client.parcels.bulkCreate(input, { context: { idempotencyKey } });
}

export function useInvalidateParcels() {
  return useInvalidateMerchant();
}
