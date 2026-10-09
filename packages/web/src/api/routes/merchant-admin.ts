import { z } from "zod";
import { adminProc, mutate, opsProc } from "../middleware/pipeline";
import { usersForMerchant } from "../modules/identity/admin";
import { createUser, getBranch, getUserByPhone, getUserByUsername } from "../modules/identity/service";
import { assignRateCard } from "../modules/merchants/rate-cards";
import * as merchantsService from "../modules/merchants/service";
import { errors } from "../shared/errors";
import { normaliseLkPhone } from "../shared/sms";

/**
 * merchants routes, onboarding half (§10 M5 "merchant onboarding").
 * Composed into the `merchants` namespace in api/index.ts.
 *
 * Onboarding = the merchant row (merchants module) + its first portal user
 * (identity module) + optionally a rate card. Each module writes its own rows
 * through its own service (§4). The portal phone is checked BEFORE the merchant
 * is created so a phone clash cannot leave a merchant without its user.
 */

const pod = z.enum(["signature", "otp", "photo"]);

export const update = opsProc
  .input(
    z.object({
      id: z.string().min(1),
      name: z.string().trim().min(2).max(160).optional(),
      branchId: z.string().min(1).optional(),
      vatNo: z.string().trim().max(40).nullish(),
      address: z.string().trim().min(4).optional(),
      contactName: z.string().trim().min(2).max(120).optional(),
      contactPhone: z.string().min(9).max(20).optional(),
      codEnabled: z.boolean().optional(),
      podPolicy: pod.optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const { id, ...patch } = input;
    if (patch.branchId && !(await getBranch(patch.branchId))) errors.badRequest(`Branch ${patch.branchId} does not exist.`);
    return mutate(
      context,
      input,
      { route: "merchants.update", entity: "merchants_merchant", entityId: () => id, action: "merchant.updated" },
      () => merchantsService.updateMerchant(id, patch, context.principal),
    );
  });

export const onboard = adminProc
  .input(
    z.object({
      name: z.string().trim().min(2).max(160),
      branchId: z.string().min(1),
      vatNo: z.string().trim().max(40).nullish(),
      address: z.string().trim().min(4),
      contactName: z.string().trim().min(2).max(120),
      contactPhone: z.string().min(9).max(20),
      codEnabled: z.boolean().default(true),
      podPolicy: pod.default("signature"),
      rateCardId: z.string().min(1).nullish(),
      portalUser: z
        .object({
          name: z.string().trim().min(2).max(120),
          phone: z.string().min(9).max(20),
          username: z.string().trim().min(2).max(60).optional(),
          password: z.string().min(8).max(200).optional(),
        })
        .refine((portal) => Boolean(portal.username) === Boolean(portal.password), {
          message: "Provide both a username and password, or leave both blank.",
          path: ["username"],
        })
        .nullish(),
    }),
  )
  .handler(async ({ input, context }) => {
    if (!(await getBranch(input.branchId))) errors.badRequest(`Branch ${input.branchId} does not exist.`);
    if (input.portalUser) {
      const clash = await getUserByPhone(normaliseLkPhone(input.portalUser.phone));
      if (clash) errors.conflict(`Phone ${clash.phone} already belongs to ${clash.name}.`, { userId: clash.id });
      if (input.portalUser.username) {
        const usernameClash = await getUserByUsername(input.portalUser.username);
        if (usernameClash) errors.conflict(`Username ${input.portalUser.username.trim().toLowerCase()} is already taken.`);
      }
    }
    return mutate(
      context,
      input,
      {
        route: "merchants.onboard",
        entity: "merchants_merchant",
        entityId: (r) => (r as { merchant: { id: string } }).merchant.id,
        action: "merchant.onboarded",
      },
      async () => {
        const created = await merchantsService.createMerchant(
          {
            name: input.name,
            branchId: input.branchId,
            vatNo: input.vatNo ?? null,
            address: input.address,
            contactName: input.contactName,
            contactPhone: input.contactPhone,
            codEnabled: input.codEnabled,
            podPolicy: input.podPolicy,
          },
          context.principal,
        );
        const rate = input.rateCardId ? await assignRateCard(created.id, input.rateCardId) : null;
        const portal = input.portalUser
          ? await createUser({
              name: input.portalUser.name,
              phone: input.portalUser.phone,
              role: "merchant",
              branchId: input.branchId,
              merchantId: created.id,
              username: input.portalUser.username ?? null,
              password: input.portalUser.password ?? null,
            })
          : null;
        return {
          merchant: { ...created, rateCardId: rate?.after ?? null },
          portalUser: portal
            ? { id: portal.id, name: portal.name, phone: portal.phone, username: portal.username }
            : null,
        };
      },
    );
  });

export const portalUsers = adminProc
  .input(z.object({ merchantId: z.string().min(1) }))
  .handler(({ input }) => usersForMerchant(input.merchantId));

export const merchantAdmin = { update, onboard, portalUsers };
