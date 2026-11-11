import { z } from "zod";
import { adminProc, mutate, opsProc } from "../middleware/pipeline";
import { usersForMerchant } from "../modules/identity/admin";
import { getUserByPhone, getUserByUsername, isActiveRiderInBranch, requireActiveBranch } from "../modules/identity/service";
import * as merchantsService from "../modules/merchants/service";
import { approveStaffOnboardingRequest, onboardMerchant } from "../modules/merchants/onboarding";
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
const payoutDetails = z.object({
  beneficiaryName: z.string().trim().min(2).max(200),
  bankName: z.string().trim().min(2).max(200),
  branchName: z.string().trim().min(2).max(200),
  accountNumber: z.string().trim().regex(/^[0-9][0-9 -]{3,40}$/, "Enter a valid bank account number."),
}).optional();

export const registrationRequests = adminProc
  .input(z.object({
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(25),
    status: z.enum(["new", "converted"]).optional(),
  }))
  .handler(({ input }) => merchantsService.listRegistrationRequests(input));

export const registrationRequestCount = adminProc.handler(() => merchantsService.registrationRequestCount());

export const registrationRequest = adminProc
  .input(z.object({ id: z.string().min(1).max(100) }))
  .handler(({ input }) => merchantsService.getRegistrationRequest(input.id));

export const onboardingRequests = opsProc
  .input(z.object({
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(25),
    status: z.enum(["pending", "approved"]).optional(),
  }))
  .handler(({ input, context }) => merchantsService.listStaffOnboardingRequests(input, context.principal));

export const onboardingRequestCount = opsProc
  .handler(({ context }) => merchantsService.staffOnboardingRequestCount(context.principal));

export const onboardingRequest = opsProc
  .input(z.object({ id: z.string().min(1).max(100) }))
  .handler(({ input, context }) => merchantsService.getStaffOnboardingRequest(input.id, context.principal));

async function validatePickupRider(riderId: string | null | undefined, branchId: string) {
  if (riderId && !(await isActiveRiderInBranch(riderId, branchId))) {
    errors.badRequest("Choose an active Rider assigned to the merchant's owning branch.");
  }
}

export const update = opsProc
  .input(
    z.object({
      id: z.string().min(1),
      name: z.string().trim().min(2).max(160).optional(),
      branchId: z.string().min(1).optional(),
      pickupRiderId: z.string().min(1).nullish(),
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
    const before = await merchantsService.getMerchantScoped(id, context.principal);
    if (patch.branchId && patch.branchId !== before.branchId) await requireActiveBranch(patch.branchId);
    const effectiveBranchId = patch.branchId ?? before.branchId;
    const effectiveRiderId = patch.pickupRiderId !== undefined ? patch.pickupRiderId : before.pickupRiderId;
    await validatePickupRider(effectiveRiderId, effectiveBranchId);
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
      pickupRiderId: z.string().min(1).nullish(),
      vatNo: z.string().trim().max(40).nullish(),
      address: z.string().trim().min(4),
      contactName: z.string().trim().min(2).max(120),
      contactPhone: z.string().min(9).max(20),
      codEnabled: z.boolean().default(true),
      podPolicy: pod.default("signature"),
      rateCardId: z.string().min(1).nullish(),
      payoutDetails,
      registrationRequestId: z.string().min(1).max(100).optional(),
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
    await requireActiveBranch(input.branchId);
    await validatePickupRider(input.pickupRiderId, input.branchId);
    if (input.portalUser) {
      const clash = await getUserByPhone(normaliseLkPhone(input.portalUser.phone));
      if (clash) errors.conflict("A user with that phone already exists.");
      if (input.portalUser.username) {
        const usernameClash = await getUserByUsername(input.portalUser.username);
        if (usernameClash) errors.conflict("That username is already taken.");
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
      () => onboardMerchant(input, context.principal),
    );
  });

const staffApprovalInputSchema = z.object({
  requestId: z.string().min(1).max(100),
  name: z.string().trim().min(2).max(160),
  pickupRiderId: z.string().min(1).nullish(),
  vatNo: z.string().trim().max(40).nullish(),
  address: z.string().trim().min(4),
  lat: z.number().int().nullish(),
  lng: z.number().int().nullish(),
  contactName: z.string().trim().min(2).max(120),
  contactPhone: z.string().min(9).max(20),
  codEnabled: z.boolean().default(true),
  podPolicy: pod.default("signature"),
  rateCardId: z.string().min(1).nullish(),
  payoutDetails,
  portalUser: z.object({
    name: z.string().trim().min(2).max(120),
    phone: z.string().min(9).max(20),
    username: z.string().trim().min(2).max(60).optional(),
    password: z.string().min(8).max(200).optional(),
  }).refine((portal) => Boolean(portal.username) === Boolean(portal.password), {
    message: "Provide both a username and password, or leave both blank.",
    path: ["username"],
  }).nullish(),
});

export const approveOnboardingRequest = adminProc
  .input(staffApprovalInputSchema)
  .handler(async ({ input, context }) => {
    const source = await merchantsService.getStaffOnboardingRequest(input.requestId, context.principal);
    await requireActiveBranch(source.branchId);
    await validatePickupRider(input.pickupRiderId, source.branchId);
    if (input.portalUser) {
      const clash = await getUserByPhone(normaliseLkPhone(input.portalUser.phone));
      if (clash) errors.conflict("A user with that phone already exists.");
      if (input.portalUser.username && await getUserByUsername(input.portalUser.username)) {
        errors.conflict("That username is already taken.");
      }
    }
    return mutate(
      context,
      input,
      {
        route: "merchants.approveOnboardingRequest",
        entity: "merchants_onboarding_request",
        entityId: (result) => (result as { staffRequest: { id: string } }).staffRequest.id,
        action: "merchant.onboarding_approved",
        auditWrittenByHandler: true,
      },
      () => approveStaffOnboardingRequest(input, context.principal, context.requestId),
    );
  });

export const portalUsers = adminProc
  .input(z.object({ merchantId: z.string().min(1) }))
  .handler(({ input }) => usersForMerchant(input.merchantId));

export const merchantAdmin = {
  update,
  onboard,
  portalUsers,
  registrationRequests,
  registrationRequestCount,
  registrationRequest,
  onboardingRequests,
  onboardingRequestCount,
  onboardingRequest,
  approveOnboardingRequest,
};
