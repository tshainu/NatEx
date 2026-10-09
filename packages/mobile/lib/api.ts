import Constants from "expo-constants";
import { randomUUID } from "expo-crypto";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { AppRouterClient } from "@template/web";
import {
  accessToken,
  deviceId,
  getSession,
  refreshTokenValue,
  setSession,
  storeApiSession,
  type ApiSession,
} from "./session";

const configured =
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ??
  process.env.EXPO_PUBLIC_API_URL ??
  "";

/** The configured base URL carries a trailing slash; `${base}/api/rpc` would double it. */
const RPC_URL = `${configured.replace(/\/+$/, "")}/api/rpc`;

/**
 * Every mutating route on this API requires an Idempotency-Key (§4/§7), so the
 * transport mints one per request rather than leaving it to each call site.
 *
 * This matters far more here than in the portals: a rider scanning a bag in a
 * lift loses signal mid-request constantly, and a retried scan must not
 * double-count a parcel. A user-initiated retry is a new intent and correctly
 * gets a new key; a network-level retry of the *same* fetch reuses it, which is
 * exactly the replay the server dedupes.
 */
function newIdempotencyKey(): string {
  return randomUUID();
}

/**
 * A second, plain client used only to rotate the refresh token. It must not go
 * through the interceptor below, or a failed refresh would try to refresh
 * itself.
 */
const bareClient: AppRouterClient = createORPCClient(new RPCLink({ url: RPC_URL }));

/** Refresh is serialised: four tabs firing 401s at once must not rotate four times. */
let refreshing: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  const presented = refreshTokenValue();
  if (!presented) return false;
  try {
    const preferredRole = getSession()?.activeRole;
    const session = await bareClient.identity.refresh({ refreshToken: presented });
    await storeApiSession(session as ApiSession, preferredRole);
    return true;
  } catch {
    // The refresh token is spent, revoked, or this device was re-bound
    // elsewhere (§5, one active device per rider) — the session is over.
    await setSession(null);
    return false;
  }
}

async function refreshOnce(): Promise<boolean> {
  refreshing ??= refreshAccessToken().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

const link = new RPCLink({
  url: RPC_URL,
  headers: () => {
    const token = accessToken();
    const session = getSession();
    const activeRole = session?.activeRole ?? session?.user.role;
    return {
      "idempotency-key": newIdempotencyKey(),
      "x-device-id": deviceId(),
      ...(token
        ? {
            authorization: `Bearer ${token}`,
            ...(activeRole ? { "x-natex-active-role": activeRole } : {}),
          }
        : {}),
    };
  },
  /**
   * Access tokens live 15 minutes (§2) and a rider keeps the app open for a
   * whole shift. Rather than tracking expiry in every screen, one 401 triggers
   * a single rotation and the request is replayed.
   */
  fetch: async (input, init) => {
    const request = (init ?? undefined) as RequestInit | undefined;
    const response = await fetch(input as RequestInfo, request);
    if (response.status !== 401 || !refreshTokenValue()) return response;

    const rotated = await refreshOnce();
    if (!rotated) return response;

    const token = accessToken();
    const headers = new Headers(request?.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    return fetch(input as RequestInfo, { ...request, headers });
  },
});

/** Direct typed client: await client.collection.riderToday({}) */
export const client: AppRouterClient = createORPCClient(link);

/** TanStack Query helpers: useQuery(orpc.collection.riderToday.queryOptions()) */
export const orpc = createTanstackQueryUtils(client);

/**
 * The API speaks RFC 9457 problem+json through oRPC errors. This pulls out the
 * human sentence the service wrote — design.md: "an illegal state transition
 * surfaces as a plain-language message naming the current state, never a raw
 * 422". On a 6-inch screen in a stairwell that sentence is the entire UI.
 */
export function apiMessage(error: unknown, fallback = "Something went wrong."): string {
  if (!error || typeof error !== "object") return fallback;
  const err = error as {
    message?: string;
    data?: { detail?: string; title?: string };
  };
  const detail = err.data?.detail ?? err.data?.title;
  if (detail) return detail;
  if (err.message && err.message !== "Internal server error") return err.message;
  return fallback;
}

/** Extra structured fields a problem carries (e.g. legalNext on a 422). */
export function apiDetails(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return {};
  const data = (error as { data?: unknown }).data;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}
