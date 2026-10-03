import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { AppRouterClient } from "../../src/api";

/**
 * The second sign-in step for the regression scripts (M5, §2 TOTP MFA for
 * ops/admin/finance).
 *
 * `identity.verifyOtp` returns a PENDING session for an MFA role. The seeded
 * staff hold a development-only factor (identity/mfa.ts `seedDevMfaFactors`),
 * and outside production the response carries its `devCode` — the same
 * arrangement as the SMS `devCode`. This passes that code to `mfa.verify` and
 * returns the full session, so every script's `login()` stays a one-liner.
 *
 * A code is good once (RFC 6238 §5.2). When a script signs the same person in
 * more often than the ±1-step window allows, the response has no `devCode`;
 * the helper then waits for the next 30-second step and derives the code from
 * the dev factor itself. Nothing here works against a production server: the
 * server neither issues `devCode` nor accepts a seeded factor there.
 */

interface PendingAware {
  accessToken: string;
  user: { id: string };
  mfa: { state: string; devCode?: string };
}

export async function finishMfa<S extends PendingAware>(baseUrl: string, session: S): Promise<S> {
  if (session.mfa.state === "none" || session.mfa.state === "verified") return session;
  if (session.mfa.state === "enrol") {
    throw new Error(`${session.user.id} has no authenticator enrolled — run seedDevMfaFactors (bun run db:seed does).`);
  }
  let code = session.mfa.devCode ?? null;
  if (!code) {
    const { getFactor, devCodeFor } = await import("../../src/api/modules/identity/mfa");
    for (let tries = 0; tries < 4 && !code; tries += 1) {
      const factor = await getFactor(session.user.id);
      if (!factor) throw new Error(`${session.user.id} has no factor`);
      code = await devCodeFor(factor);
      if (!code) await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 250));
    }
    if (!code) throw new Error(`no usable dev TOTP step for ${session.user.id}`);
  }
  const pending: AppRouterClient = createORPCClient(
    new RPCLink({ url: `${baseUrl}/api/rpc`, headers: () => ({ authorization: `Bearer ${session.accessToken}` }) }),
  );
  const { session: full } = await pending.mfa.verify({ code });
  return full as unknown as S;
}
