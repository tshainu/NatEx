import { base } from "../__core/app";
import { bearerFrom, verifyAccessToken, type Principal, type Role } from "../shared/auth";
import { errors } from "../shared/errors";
import { getUserById } from "../modules/identity/service";

/**
 * STEP 2 of the chain (PROJECT.md §4): auth guard — JWT → role + branch scope
 * in the request context.
 *
 * The token is verified cryptographically AND the user re-read from the
 * identity module, so a suspended user or a re-bound device cannot keep working
 * on a still-valid 15-minute access token.
 */
export const withAuth = base.middleware(async ({ context, next }) => {
  const token = bearerFrom(context.headers);
  if (!token) errors.unauthenticated("Missing bearer token.");

  const claims = await verifyAccessToken(token!);
  if (!claims) errors.unauthenticated("Access token is invalid or expired.");

  const user = await getUserById(claims!.sub);
  if (!user) errors.unauthenticated("User no longer exists.");
  if (user!.status !== "active") errors.forbidden("This account is suspended.");

  // One active device per rider (PROJECT.md §5): a token minted for a device
  // that is no longer the bound one is refused.
  if (user!.role === "rider" && claims!.deviceId && user!.deviceId !== claims!.deviceId) {
    errors.forbidden("This device is no longer the active device for this rider.", {
      boundDeviceId: user!.deviceId,
    });
  }

  const principal: Principal = {
    userId: user!.id,
    name: user!.name,
    role: user!.role as Role,
    branchId: user!.branchId,
    merchantId: user!.merchantId,
    deviceId: claims!.deviceId ?? user!.deviceId,
  };

  return next({ context: { principal } });
});

/** Role gate. Applied per route — "each transition requires a role" (§6). */
export function requireRole(...allowed: Role[]) {
  return base.middleware(async ({ context, next }) => {
    const principal = (context as { principal?: Principal }).principal;
    if (!principal) errors.unauthenticated();
    if (!allowed.includes(principal!.role)) {
      errors.forbidden(
        `Role ${principal!.role} may not perform this action. Allowed: ${allowed.join(", ")}.`,
        { requiredRoles: allowed },
      );
    }
    return next();
  });
}
