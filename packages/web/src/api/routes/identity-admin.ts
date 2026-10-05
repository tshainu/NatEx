import { z } from "zod";
import { adminProc, authedProc, mutate } from "../middleware/pipeline";
import * as adminService from "../modules/identity/admin";
import { getMerchant } from "../modules/merchants/service";
import { ROLES, type Role } from "../shared/auth";
import { errors } from "../shared/errors";
import { toE6 } from "../shared/geo";

/**
 * identity routes, admin half (§10 M5: users, roles, branches, session
 * policy). Composed into the `identity` namespace in api/index.ts so the
 * client sees one identity API.
 */

const role = z.enum(ROLES as unknown as [Role, ...Role[]]);

export const updateUser = adminProc
  .input(
    z.object({
      userId: z.string().min(1),
      name: z.string().trim().min(2).max(120).optional(),
      phone: z.string().min(9).max(20).optional(),
      role: role.optional(),
      /** Full role set; when present it replaces `role`. */
      roles: z.array(role).min(1).optional(),
      branchId: z.string().min(1).optional(),
      merchantId: z.string().min(1).nullish(),
      /** Username/password sign-in credentials; empty string clears. */
      username: z.string().max(60).nullish(),
      password: z.string().max(200).nullish(),
    }),
  )
  .handler(async ({ input, context }) => {
    const { userId, ...patch } = input;
    if (patch.merchantId && !(await getMerchant(patch.merchantId))) {
      errors.badRequest(`Merchant ${patch.merchantId} does not exist.`);
    }
    return mutate(
      context,
      input,
      { route: "identity.updateUser", entity: "identity_user", entityId: () => userId, action: "user.updated" },
      () => adminService.updateUser(context.principal, userId, patch),
    );
  });

export const updateBranch = adminProc
  .input(
    z.object({
      id: z.string().min(1),
      name: z.string().trim().min(2).max(120).optional(),
      address: z.string().trim().min(4).optional(),
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
      type: z.enum(["hub", "branch"]).optional(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      { route: "identity.updateBranch", entity: "identity_branch", entityId: () => input.id, action: "branch.updated" },
      () =>
        adminService.updateBranch(input.id, {
          name: input.name,
          address: input.address,
          latE6: input.lat === undefined ? undefined : toE6(input.lat),
          lngE6: input.lng === undefined ? undefined : toE6(input.lng),
          type: input.type,
        }),
    ),
  );

/** Live sessions of any user (admin) — device, MFA level, start and last refresh. */
export const userSessions = adminProc
  .input(z.object({ userId: z.string().min(1) }))
  .handler(({ input }) => adminService.listSessions(input.userId));

export const revokeUserSessions = adminProc
  .input(z.object({ userId: z.string().min(1), reason: z.string().trim().min(5).max(300) }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "identity.revokeUserSessions",
        entity: "identity_user",
        entityId: () => input.userId,
        action: "session.revoked_by_admin",
      },
      async () => ({ ...(await adminService.revokeUserSessions(input.userId)), reason: input.reason }),
    ),
  );

/** My own live sessions — the security page. */
export const mySessions = authedProc.handler(({ context }) => adminService.listSessions(context.principal.userId));

export const revokeMySession = authedProc
  .input(z.object({ sessionId: z.string().min(1) }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "identity.revokeMySession",
        entity: "identity_user",
        entityId: () => context.principal.userId,
        action: "session.revoked",
      },
      async () => ({ sessionId: input.sessionId, ...(await adminService.revokeSession(context.principal.userId, input.sessionId)) }),
    ),
  );

export const identityAdmin = {
  updateUser,
  updateBranch,
  userSessions,
  revokeUserSessions,
  mySessions,
  revokeMySession,
};
