import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
} from "@tanstack/react-query";
import { orpc, client, apiMessage } from "../lib/api";

/**
 * Transport (Milestone 2) data hooks — bags, linehaul trips, the inbound queue,
 * the hub scan log and the Ops exception queue.
 *
 * Every live list polls on an interval. PROJECT.md §2 specifies Socket.io for
 * realtime; this build has no socket server, so the whole product refreshes by
 * polling every 5s (logged as a known deviation). The interval lives here, once,
 * rather than in each screen.
 */

const LIVE = 5_000;

export function useTransportCounts() {
  return useQuery({
    ...orpc.transport.counts.queryOptions({ input: {} }),
    refetchInterval: LIVE,
  });
}

/** Parcels sitting at this hub that are free to be bagged. */
export function useBaggable() {
  return useQuery({
    ...orpc.transport.baggable.queryOptions({ input: {} }),
    refetchInterval: LIVE,
  });
}

export function useBags(status?: ("open" | "sealed" | "in_transit" | "received" | "reconciled" | "cancelled")[]) {
  return useQuery({
    ...orpc.transport.bagList.queryOptions({ input: status ? { status } : {} }),
    refetchInterval: LIVE,
  });
}

export function useBag(bagId: string | null) {
  return useQuery({
    ...orpc.transport.bagGet.queryOptions({ input: { bagId: bagId ?? "" } }),
    enabled: Boolean(bagId),
    refetchInterval: bagId ? LIVE : false,
  });
}

export function useLinehaul() {
  return useQuery({
    ...orpc.transport.tripList.queryOptions({ input: {} }),
    refetchInterval: LIVE,
  });
}

export function useTrip(tripId: string | null) {
  return useQuery({
    ...orpc.transport.tripGet.queryOptions({ input: { tripId: tripId ?? "" } }),
    enabled: Boolean(tripId),
    refetchInterval: tripId ? LIVE : false,
  });
}

export function useInboundBags() {
  return useQuery({
    ...orpc.transport.inbound.queryOptions({ input: {} }),
    refetchInterval: LIVE,
  });
}

export function useScanLog(filter: {
  kind?: "bag_in" | "bag_out" | "parcel_in" | "parcel_out" | "bag_receive" | "trip_load";
  outcome?: "accepted" | "duplicate" | "rejected";
  search?: string;
  limit?: number;
}) {
  return useQuery({
    ...orpc.transport.scans.queryOptions({ input: { limit: 150, ...filter } }),
    refetchInterval: LIVE,
  });
}

export function useExceptions(filter: {
  status?: ("open" | "investigating" | "resolved" | "written_off")[];
  kind?: string;
  search?: string;
}) {
  return useQuery({
    ...orpc.transport.exceptions.queryOptions({ input: filter }),
    refetchInterval: LIVE,
  });
}

export function useCustodyChain(awb: string | null) {
  return useQuery({
    ...orpc.transport.custody.queryOptions({ input: { awb: awb ?? "" } }),
    enabled: Boolean(awb && awb.length >= 3),
  });
}

/** Branches, for the destination-hub pickers. Reference data, cached longer. */
export function useBranches() {
  return useQuery({
    ...orpc.identity.listBranches.queryOptions(),
    staleTime: 5 * 60_000,
  });
}

/**
 * Every custody mutation invalidates everything: a scan changes a parcel's
 * status, the bag, the trip's load, the counts and possibly the exception
 * queue at once. Precision invalidation here would be a source of stale boards.
 */
function useCustodyMutation<TInput, TResult>(
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

export function useBagCreate(handlers: {
  onSuccess?: (bag: { id: string; code: string }) => void;
  onError?: (message: string) => void;
}) {
  return useCustodyMutation(
    orpc.transport.bagCreate.mutationOptions(),
    handlers,
    "The bag could not be opened.",
  );
}

export function useBagScan(handlers: {
  onSuccess?: (result: unknown) => void;
  onError?: (message: string) => void;
}) {
  return useCustodyMutation(
    orpc.transport.bagScan.mutationOptions(),
    handlers,
    "That scan burst could not be recorded.",
  );
}

export function useBagRemove(handlers: { onError?: (message: string) => void }) {
  return useCustodyMutation(
    orpc.transport.bagRemove.mutationOptions(),
    handlers,
    "That parcel could not be taken out of the bag.",
  );
}

export function useBagSeal(handlers: {
  onSuccess?: (result: unknown) => void;
  onError?: (message: string) => void;
}) {
  return useCustodyMutation(
    orpc.transport.bagSeal.mutationOptions(),
    handlers,
    "The bag could not be sealed.",
  );
}

export function useBagBreakSeal(handlers: {
  onSuccess?: (result: unknown) => void;
  onError?: (message: string) => void;
}) {
  return useCustodyMutation(
    orpc.transport.bagBreakSeal.mutationOptions(),
    handlers,
    "The seal could not be broken.",
  );
}

export function useTripCreate(handlers: {
  onSuccess?: (trip: { id: string; code: string }) => void;
  onError?: (message: string) => void;
}) {
  return useCustodyMutation(
    orpc.transport.tripCreate.mutationOptions(),
    handlers,
    "The trip could not be created.",
  );
}

export function useTripLoad(handlers: {
  onSuccess?: (result: unknown) => void;
  onError?: (message: string) => void;
}) {
  return useCustodyMutation(
    orpc.transport.tripLoad.mutationOptions(),
    handlers,
    "That bag could not be loaded onto the trip.",
  );
}

export function useTripDepart(handlers: {
  onSuccess?: (result: unknown) => void;
  onError?: (message: string) => void;
}) {
  return useCustodyMutation(
    orpc.transport.tripDepart.mutationOptions(),
    handlers,
    "The trip could not be despatched.",
  );
}

export function useTripArrive(handlers: {
  onSuccess?: (result: unknown) => void;
  onError?: (message: string) => void;
}) {
  return useCustodyMutation(
    orpc.transport.tripArrive.mutationOptions(),
    handlers,
    "Arrival could not be recorded.",
  );
}

export function useBagReceive(handlers: {
  onSuccess?: (result: unknown) => void;
  onError?: (message: string) => void;
}) {
  return useCustodyMutation(
    orpc.transport.bagReceive.mutationOptions(),
    handlers,
    "The hub receipt could not be recorded.",
  );
}

export function useExceptionResolve(handlers: {
  onSuccess?: (result: unknown) => void;
  onError?: (message: string) => void;
}) {
  return useCustodyMutation(
    orpc.transport.exceptionResolve.mutationOptions(),
    handlers,
    "That exception could not be updated.",
  );
}

// ---------------------------------------------------------------- bag photo

/**
 * Shrink a camera photo before upload: longest side 1600px, JPEG. A hub on a
 * weak line should not push a 6 MB original for a bag snapshot.
 */
async function shrinkPhoto(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not read that image."))), "image/jpeg", 0.85),
  );
}

/** Upload slot → PUT straight to the bucket → attach the ref to the bag. */
export function useBagPhotoUpload(handlers: {
  onSuccess?: (bag: { id: string; code: string }) => void;
  onError?: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ bagId, file }: { bagId: string; file: File }) => {
      if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
      const body = await shrinkPhoto(file);
      const slot = await client.transport.bagPhotoUpload({ bagId, contentType: "image/jpeg" });
      const put = await fetch(slot.uploadUrl, {
        method: "PUT",
        headers: { "content-type": "image/jpeg" },
        body,
      });
      if (!put.ok) throw new Error(`The photo upload failed (${put.status}). Try again.`);
      return client.transport.bagPhotoAttach({ bagId, storageRef: slot.storageRef });
    },
    onSuccess: (bag) => {
      void queryClient.invalidateQueries();
      handlers.onSuccess?.(bag);
    },
    onError: (error: Error) => handlers.onError?.(apiMessage(error, error.message || "The photo could not be saved.")),
  });
}

/** A short-lived link to view one bag's photo; refreshed before it expires. */
export function useBagPhotoView(bagId: string | null) {
  return useQuery({
    ...orpc.transport.bagPhotoView.queryOptions({ input: { bagId: bagId ?? "" } }),
    enabled: Boolean(bagId),
    staleTime: 4 * 60_000,
  });
}
