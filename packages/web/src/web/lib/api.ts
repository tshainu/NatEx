import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "../../api";
import {
  accessToken,
  deviceId,
  refreshTokenValue,
  setSession,
  storeApiSession,
  type ApiSession,
} from "./session";

const RPC_URL = `${window.location.origin}/api/rpc`;

/**
 * Every mutating route on this API requires an Idempotency-Key (§4/§7), so the
 * transport mints one per request rather than leaving it to each call site. A
 * user-initiated retry is a new intent and correctly gets a new key; a network
 * retry of the *same* fetch reuses it, which is exactly the replay the server
 * dedupes.
 */
function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * A second, plain client used only to rotate the refresh token. It must not go
 * through the interceptor below, or a failed refresh would try to refresh
 * itself.
 */
const bareClient: RouterClient<AppRouter> = createORPCClient(new RPCLink({ url: RPC_URL }));

/** Refresh is serialised: ten parallel 401s must not rotate ten times. */
let refreshing: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  const presented = refreshTokenValue();
  if (!presented) return false;
  try {
    const session = await bareClient.identity.refresh({ refreshToken: presented });
    storeApiSession(session as ApiSession);
    return true;
  } catch {
    // The refresh token is spent or revoked — the session is over.
    setSession(null);
    return false;
  }
}

async function refreshOnce(): Promise<boolean> {
  refreshing ??= refreshAccessToken().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/**
 * Per-call context. `idempotencyKey` pins the key for one call so a caller that
 * retries a *specific* intent — a bulk CSV chunk that timed out — sends the same
 * key again and the server replays the first result instead of booking twice.
 */
export interface ApiCallContext {
  idempotencyKey?: string;
}

const link = new RPCLink<ApiCallContext>({
  url: RPC_URL,
  headers: ({ context }) => {
    const token = accessToken();
    return {
      "idempotency-key": context?.idempotencyKey ?? newIdempotencyKey(),
      "x-device-id": deviceId(),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  },
  /**
   * Access tokens live 15 minutes (§2). Rather than tracking expiry in every
   * component, one 401 triggers a single rotation and the request is replayed.
   */
  fetch: async (input, init) => {
    const response = await fetch(input as RequestInfo, init);
    if (response.status !== 401 || !refreshTokenValue()) return response;

    const rotated = await refreshOnce();
    if (!rotated) return response;

    const token = accessToken();
    const headers = new Headers((init as RequestInit | undefined)?.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    return fetch(input as RequestInfo, { ...(init as RequestInit | undefined), headers });
  },
});

/** Direct typed client: await client.parcels.get({ awbOrId }) */
export const client: RouterClient<AppRouter, ApiCallContext> = createORPCClient(link);

/**
 * A client bound to a PENDING sign-in token (§2 MFA step). It is never stored
 * and never refreshed — a pending session cannot rotate — and the server only
 * accepts it on the `mfa.status/enrolStart/enrolConfirm/verify` routes.
 */
export function pendingClient(pendingAccessToken: string): RouterClient<AppRouter> {
  return createORPCClient(
    new RPCLink({
      url: RPC_URL,
      headers: () => ({
        "idempotency-key": newIdempotencyKey(),
        "x-device-id": deviceId(),
        authorization: `Bearer ${pendingAccessToken}`,
      }),
    }),
  );
}

/** TanStack Query helpers: useQuery(orpc.parcels.board.queryOptions()) */
export const orpc = createTanstackQueryUtils(client);

/**
 * The API speaks RFC 9457 problem+json through oRPC errors. This pulls out the
 * human sentence the service wrote — design.md: "an illegal state transition
 * surfaces as a plain-language message naming the current state, never a raw
 * 422".
 */
export function apiMessage(error: unknown, fallback = "Something went wrong."): string {
  if (!error || typeof error !== "object") return fallback;
  const err = error as {
    message?: string;
    data?: { detail?: string; title?: string; currentStatus?: string };
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
