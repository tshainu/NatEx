import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiMessage, type ApiCallContext } from "./api";

/**
 * Mutation hook for money writes (§4 idempotency, §8).
 *
 * The transport in lib/api.ts mints a fresh Idempotency-Key per request, which
 * is right for most writes but wrong for money: if the server books a payout
 * and the response is lost on the way back, the user's natural reaction is to
 * click again — and a fresh key would book it twice.
 *
 * So the key here belongs to the *intent*, not the request:
 *   - the same input sent again after a failure with no definitive answer
 *     (network drop, timeout, 5xx) reuses the key, and the server replays the
 *     first result instead of acting twice;
 *   - a definitive answer (success, or a 4xx refusal) retires the key, so the
 *     next attempt — usually with corrected input — is a new intent;
 *   - a different input is always a new intent, so a replay never carries a
 *     body the server did not see the first time.
 */
export type Handlers<T> = { onSuccess?: (result: T) => void; onError?: (message: string, error: unknown) => void };

type Call<TInput, TResult> = (input: TInput, options: { context: ApiCallContext }) => Promise<TResult>;

function isDefinitive(error: unknown): boolean {
  const e = error as { status?: number; data?: { status?: number } } | null;
  const status = e?.data?.status ?? e?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}

export function useIntentMutation<TInput, TResult>(
  call: Call<TInput, TResult>,
  handlers: Handlers<TResult>,
  fallback: string,
) {
  const queryClient = useQueryClient();
  const intent = React.useRef<{ key: string; body: string } | null>(null);

  return useMutation<TResult, Error, TInput>({
    mutationFn: (input) => {
      const body = JSON.stringify(input);
      if (!intent.current || intent.current.body !== body) {
        intent.current = { key: crypto.randomUUID(), body };
      }
      return call(input, { context: { idempotencyKey: intent.current.key } });
    },
    onSuccess: (result) => {
      intent.current = null;
      // A stale figure on a cash screen is worse than a redundant refetch.
      void queryClient.invalidateQueries();
      handlers.onSuccess?.(result);
    },
    onError: (error) => {
      if (isDefinitive(error)) intent.current = null;
      handlers.onError?.(apiMessage(error, fallback), error);
    },
  });
}
