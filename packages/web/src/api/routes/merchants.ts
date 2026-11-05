import { z } from "zod";
import { adminProc, authedProc, mutate, opsProc, publicMutate, publicProc, readProc } from "../middleware/pipeline";
import { requireRole } from "../middleware/auth";
import { consumeToken } from "../middleware/rate-limit";
import * as merchantsService from "../modules/merchants/service";
import * as identityService from "../modules/identity/service";
import { errors } from "../shared/errors";
import { DISTRICTS } from "../shared/address";

function normalizeRegistrationPhone(value: string): string {
  const compact = value.replace(/[\s().-]/g, "");
  let international: string;
  if (compact.startsWith("+94")) international = compact;
  else if (compact.startsWith("94")) international = `+${compact}`;
  else if (compact.startsWith("0")) international = `+94${compact.slice(1)}`;
  else international = `+94${compact}`;
  return international;
}

/** Stable non-secret bucket key that keeps this route importable by mobile typecheck. */
function phoneBucketKey(phone: string): string {
  let hash = 2166136261;
  for (let index = 0; index < phone.length; index += 1) {
    hash ^= phone.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

const registrationPhone = z
  .string()
  .trim()
  .min(9)
  .max(24)
  .regex(/^\+?[0-9][0-9\s().-]*$/)
  .transform(normalizeRegistrationPhone)
  .pipe(z.string().regex(/^\+947\d{8}$/));

const operationsProc = authedProc.use(requireRole("ops"));

export const registrationInputSchema = z.object({
  businessName: z.string().trim().min(2).max(160),
  contactName: z.string().trim().min(2).max(120),
  phone: registrationPhone,
  email: z.email().trim().max(254),
  district: z.enum(DISTRICTS),
  businessType: z.string().trim().min(2).max(80),
  monthlyVolume: z.string().trim().min(1).max(80),
  notes: z.string().trim().max(2000),
  smsConsent: z.literal(true),
  website: z.string().max(200).optional(),
  submissionId: z.uuid(),
});

export const submitRegistration = publicProc
  .input(registrationInputSchema)
  .handler(({ input, context }) =>
    publicMutate(
      context,
      {
        route: "merchants.submitRegistration",
        bucket: { capacity: 6, refillPerMinute: 2 },
      },
      async () => {
        // Bots that fill the hidden field get the same bland success, but never
        // create a request, consume a phone token, or enqueue an SMS.
        if (input.website?.trim()) return { received: true as const };

        const { website: _website, ...submission } = input;
        const phoneBucket = phoneBucketKey(submission.phone);
        await merchantsService.createRegistrationRequest(
          submission,
          (executor) => consumeToken(
            `anon:merchant-registration-phone:${phoneBucket}`,
            { capacity: 3, refillPerMinute: 3 / 1440 },
            executor,
          ),
        );
        return { received: true as const };
      },
    ),
  );

async function validatePickupRider(riderId: string | null | undefined, branchId: string) {
  if (riderId && !(await identityService.isActiveRiderInBranch(riderId, branchId))) {
    errors.badRequest("Choose an active Rider assigned to the merchant's owning branch.");
  }
}

export const list = readProc
  .input(
    z.object({
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(25),
      search: z.string().max(60).optional(),
    }),
  )
  .handler(({ input, context }) => merchantsService.listMerchants(input, context.principal));

export const get = readProc
  .input(z.object({ id: z.string().min(1) }))
  .handler(({ input, context }) => merchantsService.getMerchantScoped(input.id, context.principal));

export const options = readProc.handler(({ context }) =>
  merchantsService.merchantOptions(context.principal),
);

export const create = adminProc
  .input(
    z.object({
      name: z.string().min(2).max(160),
      branchId: z.string().min(1),
      pickupRiderId: z.string().min(1).nullish(),
      vatNo: z.string().max(40).nullish(),
      address: z.string().min(4),
      lat: z.number().int().nullish(),
      lng: z.number().int().nullish(),
      contactName: z.string().min(2).max(120),
      contactPhone: z.string().min(9).max(20),
      codEnabled: z.boolean().default(true),
      podPolicy: z.enum(["signature", "otp", "photo"]).default("signature"),
    }),
  )
  .handler(async ({ input, context }) => {
    await validatePickupRider(input.pickupRiderId, input.branchId);
    return mutate(
      context,
      input,
      {
        route: "merchants.create",
        entity: "merchants_merchant",
        entityId: (r) => (r as merchantsService.MerchantRow).id,
        action: "merchant.created",
      },
      () => merchantsService.createMerchant(input, context.principal),
    );
  });

export const submitOnboardingRequest = operationsProc
  .input(z.object({
    name: z.string().trim().min(2).max(160),
    pickupRiderId: z.string().min(1).nullish(),
    vatNo: z.string().trim().max(40).nullish(),
    address: z.string().trim().min(4),
    lat: z.number().int().nullish(),
    lng: z.number().int().nullish(),
    contactName: z.string().trim().min(2).max(120),
    contactPhone: z.string().min(9).max(20),
    codEnabled: z.boolean().default(true),
    podPolicy: z.enum(["signature", "otp", "photo"]).default("signature"),
  }))
  .handler(async ({ input, context }) => {
    await validatePickupRider(input.pickupRiderId, context.principal.branchId);
    return mutate(
      context,
      input,
      {
        route: "merchants.submitOnboardingRequest",
        entity: "merchants_onboarding_request",
        entityId: (result) => (result as merchantsService.MerchantOnboardingRequestRow).id,
        action: "merchant.onboarding_requested",
      },
      () => merchantsService.createStaffOnboardingRequest(input, context.principal),
    );
  });

export const setStatus = opsProc
  .input(
    z.object({
      id: z.string().min(1),
      status: z.enum(["active", "suspended"]),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "merchants.setStatus",
        entity: "merchants_merchant",
        entityId: () => input.id,
        action: `merchant.${input.status}`,
      },
      () => merchantsService.setMerchantStatus(input.id, input.status, context.principal),
    ),
  );

/** Router namespace — composed into the root router in api/index.ts. */
export const merchants = {
  submitRegistration,
  list,
  get,
  options,
  create,
  submitOnboardingRequest,
  setStatus,
};
