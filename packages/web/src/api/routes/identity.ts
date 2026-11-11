import { z } from "zod";
import {
  adminProc,
  authedProc,
  mutate,
  publicMutate,
  publicProc,
  staffProc,
  opsProc,
  deskProc,
} from "../middleware/pipeline";
import { changeUserStatus } from "../modules/identity/admin";
import * as identityService from "../modules/identity/service";
import { errors } from "../shared/errors";
import { isGlobalScope, MOBILE_FIELD_ROLES, ROLES } from "../shared/auth";
import { toE6 } from "../shared/geo";
import { isDevelopment } from "../shared/env";

/**
 * identity routes — auth, users, branches.
 *
 * OTP request/verify/refresh are public but rate limited hard (they are the
 * brute-force surface). Everything else runs the full chain.
 */

/**
 * Public: is this a demo/development deployment? The login page shows the
 * seeded demo accounts only when it is. It reveals nothing a visitor could not
 * learn from requestOtp (which returns devCode in exactly the same case).
 */
export const environment = publicProc.handler(() => ({ demo: isDevelopment() }));

export const requestOtp = publicProc
  .input(z.object({ phone: z.string().min(9).max(20) }))
  .handler(({ input, context }) =>
    publicMutate(
      context,
      {
        route: "identity.requestOtp",
        bucket: { capacity: 5, refillPerMinute: 1 },
        // Per destination number as well as per IP: each OTP is a paid SMS to
        // someone's phone. Keyed on the last nine digits so +94 / 0 / spaced
        // spellings of one number share a bucket. 5 at once, then one per 5 min.
        subject: { key: `phone:${input.phone.replace(/\D/g, "").slice(-9)}`, bucket: { capacity: 5, refillPerMinute: 0.2 } },
      },
      () => identityService.requestOtp(input.phone),
    ),
  );

export const loginPassword = publicProc
  .input(
    z.object({
      username: z.string().min(2).max(60),
      password: z.string().min(1).max(200),
      deviceId: z.string().nullish(),
      context: z.object({ client: z.literal("mobile"), role: z.enum(["rider", "transport", "merchant"]).optional() }).nullish(),
    }),
  )
  .handler(({ input, context }) =>
    publicMutate(
      context,
      {
        route: "identity.loginPassword",
        bucket: { capacity: 5, refillPerMinute: 1 },
        // Per username as well as per IP: credential stuffing one account must
        // not ride on fresh IPs.
        subject: { key: input.username.trim().toLowerCase(), bucket: { capacity: 5, refillPerMinute: 1 } },
      },
      () =>
        identityService.loginWithPassword({
          username: input.username,
          password: input.password,
          deviceId: input.deviceId ?? null,
          context: input.context ?? null,
        }),
    ),
  );

export const verifyOtp = publicProc
  .input(
    z.object({
      challengeId: z.string().min(1),
      code: z.string().length(6),
      deviceId: z.string().max(128).nullish(),
      context: z.object({ client: z.literal("mobile"), role: z.enum(["rider", "transport", "merchant"]).optional() }).nullish(),
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
  roles: context.principal.roles,
  branchId: context.principal.branchId,
  merchantId: context.principal.merchantId,
  deviceId: context.principal.deviceId,
}));

/** Live field-role discovery for this caller only; this does not alter JWT scope. */
export const mobileWorkspaces = authedProc.handler(({ context }) => {
  const scope = context.principal.scope;
  if (scope?.kind !== "mobile" || !(MOBILE_FIELD_ROLES as readonly string[]).includes(scope.role)) {
    errors.forbidden("Workspace discovery is available only in a Rider or Transport mobile session.");
  }
  return identityService.listMobileWorkspaces(context.principal.userId).then((roles) => ({ roles }));
});

/** Reissue an access/refresh pair with exactly the selected assigned field role. */
export const switchMobileRole = authedProc
  .input(z.object({ role: z.enum(["rider", "transport"]) }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "identity.switchMobileRole",
        entity: "identity_user",
        entityId: (result) => (result as identityService.Session).user.id,
        action: "mobile.workspace_switched",
      },
      async () => {
        return identityService.switchMobileWorkspace({
          userId: context.principal.userId,
          deviceId: context.principal.deviceId ?? null,
          currentScope: context.principal.scope ?? null,
          role: input.role,
        });
      },
    ),
  );

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

export const listBranches = staffProc
  .input(z.object({ includeInactive: z.boolean().optional() }).optional())
  .handler(({ input, context }) => {
    if (input?.includeInactive && !context.principal.roles.includes("admin")) {
      errors.forbidden("Only administrators may include inactive branches.");
    }
    return identityService.listBranches({ includeInactive: input?.includeInactive });
  });

/** Current staff member's branch only; used for branch-scoped Counter defaults. */
export const myBranch = staffProc.handler(({ context }) => identityService.getBranch(context.principal.branchId));

export const listUsers = deskProc.handler(({ context }) =>
  identityService.listOfficialUsers(context.principal),
);

export const listRiders = staffProc.handler(({ context }) =>
  identityService.listRiders(context.principal.branchId),
);

/** Active riders available to assign to a merchant; ops cannot cross branches. */
export const pickupRiderOptions = opsProc
  .input(z.object({ branchId: z.string().min(1) }))
  .handler(({ input, context }) => {
    if (!isGlobalScope(context.principal.role) && input.branchId !== context.principal.branchId) {
      errors.forbidden("You may only assign a rider from your own branch.");
    }
    return identityService.listRiders(input.branchId);
  });

export const createUser = adminProc
  .input(
    z.object({
      name: z.string().min(2).max(120),
      phone: z.string().min(9).max(20),
      /** One or more roles. The first is the primary role (branch scope, home portal). */
      roles: z.array(z.enum(ROLES as unknown as [string, ...string[]])).min(1),
      branchId: z.string().min(1),
      /** Optional username/password sign-in credentials (rider app). */
      username: z.string().min(2).max(60).nullish(),
      password: z.string().min(6).max(200).nullish(),
    }),
  )
  .handler(async ({ input, context }) => {
    if (input.roles.includes("merchant")) {
      errors.badRequest("Create Merchant portal accounts from Administration → Merchant users.");
    }
    if (!(await identityService.getBranch(input.branchId))) errors.badRequest(`Branch ${input.branchId} does not exist.`);
    return mutate(
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
          role: input.roles[0] as (typeof ROLES)[number],
          roles: input.roles as (typeof ROLES)[number][],
          branchId: input.branchId,
          username: input.username ?? null,
          password: input.password ?? null,
        }),
    );
  });

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
      () => changeUserStatus(context.principal, input.userId, input.status),
    ),
  );

export const createBranch = adminProc
  .input(
    z.object({
      code: z.string().min(2).max(12),
      name: z.string().min(2).max(120),
      address: z.string().min(4),
      phone: z.string().trim().max(40).nullish(),
      lat: z.number().min(-90).max(90).nullable().optional(),
      lng: z.number().min(-180).max(180).nullable().optional(),
      type: z.enum(["hub", "branch"]),
      parentHubId: z.string().min(1).nullable().optional(),
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
          phone: input.phone ?? null,
          // Coordinates are stored as microdegrees (integer) — see shared/geo.ts.
          latE6: input.lat == null ? null : toE6(input.lat),
          lngE6: input.lng == null ? null : toE6(input.lng),
          type: input.type,
          parentHubId: input.parentHubId,
        }),
    ),
  );

export const sessionCounts = adminProc.handler(() => identityService.sessionCounts());

/** Router namespace — composed into the root router in api/index.ts. */
export const identity = {
  environment,
  loginPassword,
  requestOtp,
  verifyOtp,
  refresh,
  me,
  mobileWorkspaces,
  switchMobileRole,
  logout,
  listBranches,
  myBranch,
  listUsers,
  listRiders,
  pickupRiderOptions,
  createUser,
  setUserStatus,
  createBranch,
  sessionCounts,
};
