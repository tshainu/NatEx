import { z } from "zod";
import { adminProc, authedProc, mfaProc, mutate } from "../middleware/pipeline";
import * as mfaService from "../modules/identity/mfa";
import { completeMfaSignIn, getUserById, revokeAllSessions } from "../modules/identity/service";
import { errors } from "../shared/errors";

/**
 * MFA routes (§2 "TOTP MFA for ops/admin/finance", §10 M5 "MFA enrolment").
 *
 * Sign-in for an MFA role is two steps. `identity.verifyOtp` returns a PENDING
 * session (`mfa.state` = `enrol` or `challenge`) whose token is accepted only
 * by the `mfaProc` routes below; `verify` or `enrolConfirm` then swaps it for
 * a full session. Code-bearing routes have a tight per-user bucket — a
 * six-digit code is a brute-force surface — and the audit row never holds the
 * secret, the URI or the recovery codes (shared/redact.ts).
 */

const CODE_BUCKET = { capacity: 5, refillPerMinute: 2 };
const code = z.string().trim().min(6).max(16);

function requireMfaRole(roles: readonly string[]): void {
  if (!roles.some((r) => (mfaService.MFA_ROLES as readonly string[]).includes(r))) {
    errors.forbidden(`An authenticator is for ${mfaService.MFA_ROLES.join(", ")} accounts.`);
  }
}

/** The caller's own MFA state, including what this session has proved. */
export const status = mfaProc.handler(async ({ context }) => ({
  ...(await mfaService.mfaStatus(context.principal.userId, context.principal.role)),
  sessionLevel: context.principal.mfa ?? "none",
}));

/** Start enrolment: a fresh secret and its otpauth:// URI (the web client draws the QR). */
export const enrolStart = mfaProc.handler(async ({ context }) => {
  requireMfaRole(context.principal.roles);
  if (context.principal.mfa === "challenge") errors.conflict("An authenticator is already enrolled. Enter its code.");
  const account = await getUserById(context.principal.userId);
  return mutate(
    context,
    {},
    {
      route: "mfa.enrolStart",
      entity: "identity_user",
      entityId: () => context.principal.userId,
      action: "mfa.enrol_started",
      idempotency: false,
      bucket: { capacity: 10, refillPerMinute: 5 },
    },
    () => mfaService.startEnrolment(context.principal.userId, `${account!.name} (${account!.phone})`),
  );
});

/**
 * Confirm enrolment with a first code. Returns the recovery codes — shown
 * once, never again — and, when this was the pending sign-in, the full session.
 */
export const enrolConfirm = mfaProc.input(z.object({ code })).handler(async ({ input, context }) => {
  requireMfaRole(context.principal.roles);
  return mutate(
    context,
    {},
    {
      route: "mfa.enrolConfirm",
      entity: "identity_user",
      entityId: () => context.principal.userId,
      action: "mfa.enrolled",
      idempotency: false,
      bucket: CODE_BUCKET,
    },
    async () => {
      const { recoveryCodes } = await mfaService.confirmEnrolment(context.principal.userId, input.code);
      const session =
        context.principal.mfa === "enrol"
          ? await completeMfaSignIn(context.principal.userId, context.principal.deviceId ?? null)
          : null;
      return { recoveryCodes, session };
    },
  );
});

/** The sign-in challenge: a TOTP code or one recovery code → the full session. */
export const verify = mfaProc.input(z.object({ code })).handler(({ input, context }) => {
  if (context.principal.mfa !== "challenge") errors.conflict("This session is not waiting for an authenticator code.");
  return mutate(
    context,
    {},
    {
      route: "mfa.verify",
      entity: "identity_user",
      entityId: () => context.principal.userId,
      action: "mfa.verified",
      idempotency: false,
      bucket: CODE_BUCKET,
    },
    async () => {
      const result = await mfaService.verifyChallenge(context.principal.userId, input.code);
      const session = await completeMfaSignIn(context.principal.userId, context.principal.deviceId ?? null);
      return { ...result, session };
    },
  );
});

/** New recovery codes (the old set stops working). Needs a full session and a live code. */
export const regenerateRecoveryCodes = authedProc.input(z.object({ code })).handler(({ input, context }) =>
  mutate(
    context,
    {},
    {
      route: "mfa.regenerateRecoveryCodes",
      entity: "identity_user",
      entityId: () => context.principal.userId,
      action: "mfa.recovery_regenerated",
      bucket: CODE_BUCKET,
    },
    () => mfaService.regenerateRecoveryCodes(context.principal.userId, input.code),
  ),
);

/** Enrolment state of every user, for the admin users table. */
export const factors = adminProc.handler(() => mfaService.factorStates());

/**
 * Admin reset of another user's authenticator (lost phone). Their sessions are
 * revoked; at next sign-in they enrol again. An admin cannot reset their own —
 * a second admin does, so a stolen admin session cannot strip its own MFA.
 */
export const reset = adminProc
  .input(z.object({ userId: z.string().min(1), reason: z.string().trim().min(5).max(500) }))
  .handler(({ input, context }) => {
    if (input.userId === context.principal.userId) {
      errors.conflict("You cannot reset your own authenticator. Ask another admin.", { selfLockout: true });
    }
    return mutate(
      context,
      input,
      {
        route: "mfa.reset",
        entity: "identity_user",
        entityId: () => input.userId,
        action: "mfa.reset",
      },
      async () => {
        const target = await getUserById(input.userId);
        if (!target) errors.notFound("User");
        const { hadFactor } = await mfaService.resetFactor(input.userId);
        await revokeAllSessions(input.userId);
        return { userId: input.userId, hadFactor, sessionsRevoked: true, reason: input.reason };
      },
    );
  });

export const mfa = { status, enrolStart, enrolConfirm, verify, regenerateRecoveryCodes, factors, reset };
