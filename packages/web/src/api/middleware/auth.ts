import { base } from "../__core/app";
import { bearerFrom, PENDING_MFA, verifyAccessToken, type MfaLevel, type Principal, type Role } from "../shared/auth";
import { errors, fail, problem } from "../shared/errors";
import { getUserById, rolesOf } from "../modules/identity/service";
import { mfaRequiredForAny } from "../modules/identity/mfa";

/**
 * STEP 2 of the chain (PROJECT.md §4): auth guard — JWT → role + branch scope
 * in the request context.
 *
 * The token is verified cryptographically AND the user re-read from the
 * identity module, so a suspended user or a re-bound device cannot keep working
 * on a still-valid 15-minute access token.
 */
/**
 * Inspection tags on the guard functions. Nothing at runtime reads them: the
 * route-guard test (route-guards.test.ts) and scripts/security-review.ts walk
 * the router and read them to prove every procedure is gated as intended.
 */
export const GUARD_TAG = Symbol.for("natex.guard");
export type GuardTag = { kind: "auth"; allowPendingMfa: boolean } | { kind: "role"; roles: readonly Role[] };
function tag<T extends object>(fn: T, value: GuardTag): T {
  Object.defineProperty(fn, GUARD_TAG, { value, enumerable: false });
  return fn;
}

function authGuard(opts: { allowPendingMfa: boolean }) {
  return tag(base.middleware(async ({ context, next }) => {
    const token = bearerFrom(context.headers);
    if (!token) errors.unauthenticated("Missing bearer token.");

    const claims = await verifyAccessToken(token!);
    if (!claims) errors.unauthenticated("Access token is invalid or expired.");

    const user = await getUserById(claims!.sub);
    if (!user) errors.unauthenticated("User no longer exists.");
    if (user!.status !== "active") errors.forbidden("This account is suspended.");

    const roles = rolesOf(user!);
    // One active device per rider (PROJECT.md §5): a token minted for a device
    // that is no longer the bound one is refused.
    if (roles.includes("rider") && claims!.deviceId && user!.deviceId !== claims!.deviceId) {
      errors.forbidden("This device is no longer the active device for this rider.", {
        boundDeviceId: user!.deviceId,
      });
    }

    // §2 TOTP MFA for ops/admin/finance (M5).
    const mfa: MfaLevel = claims!.mfa ?? "none";
    if (PENDING_MFA.has(mfa)) {
      // A pending token is good for the MFA routes only.
      if (!opts.allowPendingMfa) {
        fail(
          "FORBIDDEN",
          problem("mfa-required", "Authenticator step required", 403,
            mfa === "enrol"
              ? "Enrol an authenticator app to finish signing in."
              : "Enter the code from your authenticator app to finish signing in.",
            { mfa }),
        );
      }
    } else if (mfa !== "verified" && (await mfaRequiredForAny(roles))) {
      // A session that began before enforcement (or before a role change) and
      // never passed MFA. 401, so the client's refresh runs — and refresh
      // refuses it too (identity/service.ts rotateRefresh): sign in again.
      errors.unauthenticated("Your role requires an authenticator code. Sign in again.");
    }

    const principal: Principal = {
      userId: user!.id,
      name: user!.name,
      role: user!.role as Role,
      roles,
      branchId: user!.branchId,
      merchantId: user!.merchantId,
      deviceId: claims!.deviceId ?? user!.deviceId,
      mfa,
    };

    return next({ context: { principal } });
  }), { kind: "auth", allowPendingMfa: opts.allowPendingMfa });
}

export const withAuth = authGuard({ allowPendingMfa: false });

/**
 * The MFA routes only (routes/mfa.ts): also admits a PENDING token, so a user
 * who has passed phone OTP can enrol or enter their code. Nothing else uses it.
 */
export const withAuthAllowingPendingMfa = authGuard({ allowPendingMfa: true });

/** Role gate. Applied per route — "each transition requires a role" (§6). */
export function requireRole(...allowed: Role[]) {
  return tag(base.middleware(async ({ context, next }) => {
    const principal = (context as { principal?: Principal }).principal;
    if (!principal) errors.unauthenticated();
    if (!principal!.roles.some((r) => allowed.includes(r))) {
      errors.forbidden(
        `Role ${principal!.roles.join("+")} may not perform this action. Allowed: ${allowed.join(", ")}.`,
        { requiredRoles: allowed },
      );
    }
    return next();
  }), { kind: "role", roles: allowed });
}
