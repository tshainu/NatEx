import { z } from "zod";
import {
  adminProc,
  authedProc,
  mutate,
  publicMutate,
  publicProc,
  staffProc,
} from "../middleware/pipeline";
import * as identityService from "../modules/identity/service";
import { ROLES } from "../shared/auth";
import { toE6 } from "../shared/geo";

/**
 * identity routes — auth, users, branches.
 *
 * OTP request/verify/refresh are public but rate limited hard (they are the
 * brute-force surface). Everything else runs the full chain.
 */

export const requestOtp = publicProc
  .input(z.object({ phone: z.string().min(9).max(20) }))
  .handler(({ input, context }) =>
    publicMutate(
      context,
      { route: "identity.requestOtp", bucket: { capacity: 5, refillPerMinute: 1 } },
      () => identityService.requestOtp(input.phone),
    ),
  );

export const verifyOtp = publicProc
  .input(
    z.object({
      challengeId: z.string().min(1),
      code: z.string().length(6),
      deviceId: z.string().max(128).nullish(),
    }),
  )
  .handler(({ input, context }) =>
    publicMutate(
      context,
      { route: "identity.verifyOtp", bucket: { capacity: 10, refillPerMinute: 2 } },
      () => identityService.verifyOtp(input),
    ),
  );

export const refresh = publicProc
  .input(z.object({ refreshToken: z.string().min(1) }))
  .handler(({ input, context }) =>
    publicMutate(
      context,
      { route: "identity.refresh", bucket: { capacity: 30, refillPerMinute: 10 } },
      () => identityService.rotateRefresh(input.refreshToken),
    ),
  );

/** Who am I — the client's source of truth for role-based UI. */
export const me = authedProc.handler(({ context }) => ({
  userId: context.principal.userId,
  name: context.principal.name,
  role: context.principal.role,
  branchId: context.principal.branchId,
  merchantId: context.principal.merchantId,
  deviceId: context.principal.deviceId,
}));

export const logout = authedProc.handler(({ context }) =>
  mutate(
    context,
    {},
    {
      route: "identity.logout",
      entity: "identity_user",
      entityId: () => context.principal.userId,
      action: "session.revoked_all",
      idempotency: false,
    },
    async () => {
      await identityService.revokeAllSessions(context.principal.userId);
      return { ok: true as const };
    },
  ),
);

export const listBranches = staffProc.handler(() => identityService.listBranches());

export const listUsers = staffProc.handler(({ context }) =>
  identityService.listUsers(context.principal),
);

export const listRiders = staffProc.handler(({ context }) =>
  identityService.listRiders(context.principal.branchId),
);

export const createUser = adminProc
  .input(
    z.object({
      name: z.string().min(2).max(120),
      phone: z.string().min(9).max(20),
      role: z.enum(ROLES as unknown as [string, ...string[]]),
      branchId: z.string().min(1),
      merchantId: z.string().nullish(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "identity.createUser",
        entity: "identity_user",
        entityId: (r) => (r as { id: string }).id,
        action: "user.created",
      },
      () =>
        identityService.createUser({
          name: input.name,
          phone: input.phone,
          role: input.role as (typeof ROLES)[number],
          branchId: input.branchId,
          merchantId: input.merchantId ?? null,
        }),
    ),
  );

export const setUserStatus = adminProc
  .input(
    z.object({
      userId: z.string().min(1),
      status: z.enum(["active", "suspended"]),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "identity.setUserStatus",
        entity: "identity_user",
        entityId: () => input.userId,
        action: `user.${input.status}`,
      },
      () => identityService.setUserStatus(input.userId, input.status),
    ),
  );

export const createBranch = adminProc
  .input(
    z.object({
      code: z.string().min(2).max(12),
      name: z.string().min(2).max(120),
      address: z.string().min(4),
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      type: z.enum(["hub", "branch"]),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "identity.createBranch",
        entity: "identity_branch",
        entityId: (r) => (r as { id: string }).id,
        action: "branch.created",
      },
      () =>
        identityService.createBranch({
          code: input.code,
          name: input.name,
          address: input.address,
          // Coordinates are stored as microdegrees (integer) — see shared/geo.ts.
          latE6: toE6(input.lat),
          lngE6: toE6(input.lng),
          type: input.type,
        }),
    ),
  );

export const sessionCounts = adminProc.handler(() => identityService.sessionCounts());

/** Router namespace — composed into the root router in api/index.ts. */
export const identity = {
  requestOtp,
  verifyOtp,
  refresh,
  me,
  logout,
  listBranches,
  listUsers,
  listRiders,
  createUser,
  setUserStatus,
  createBranch,
  sessionCounts,
};
