import { db } from "../../database";
import type { DbTransaction } from "../../database/transaction";
import type { Principal } from "../../shared/auth";
import { errors } from "../../shared/errors";
import { writeAudit } from "../../shared/audit";
import { enqueue } from "../../shared/outbox";
import { createUser } from "../identity/service";
import { assignRateCard } from "./rate-cards";
import {
  convertRegistrationRequest,
  createMerchant,
  getStaffOnboardingRequestForApproval,
  markStaffOnboardingApproved,
  type CreateMerchantInput,
} from "./service";

export interface OnboardMerchantInput extends CreateMerchantInput {
  rateCardId?: string | null;
  registrationRequestId?: string;
  portalUser?: {
    name: string;
    phone: string;
    username?: string;
    password?: string;
  } | null;
}

export type StaffOnboardingApprovalInput = Omit<OnboardMerchantInput, "branchId" | "registrationRequestId"> & {
  requestId: string;
};

async function createOnboardedMerchant(
  input: OnboardMerchantInput,
  actor: Principal,
  executor: DbTransaction | typeof db,
) {
  const created = await createMerchant(
    {
      name: input.name,
      branchId: input.branchId,
      pickupRiderId: input.pickupRiderId ?? null,
      vatNo: input.vatNo ?? null,
      address: input.address,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      contactName: input.contactName,
      contactPhone: input.contactPhone,
      codEnabled: input.codEnabled,
      podPolicy: input.podPolicy,
    },
    actor,
    executor,
  );
  const rate = input.rateCardId ? await assignRateCard(created.id, input.rateCardId, executor) : null;
  const portal = input.portalUser
    ? await createUser({
        name: input.portalUser.name,
        phone: input.portalUser.phone,
        role: "merchant",
        branchId: input.branchId,
        merchantId: created.id,
        username: input.portalUser.username ?? null,
        password: input.portalUser.password ?? null,
      }, executor)
    : null;

  if (input.registrationRequestId) {
    await convertRegistrationRequest(input.registrationRequestId, created.id, executor);
  } else {
    // The converted-registration path already queues its fixed acceptance SMS.
    // Other admin-approved onboarding paths get the same credential-safe notice.
    await enqueue("merchant_welcome.sms", { merchantId: created.id }, executor);
  }

  return {
    merchant: { ...created, rateCardId: rate?.after ?? null },
    portalUser: portal
      ? { id: portal.id, name: portal.name, phone: portal.phone, username: portal.username }
      : null,
  };
}

const registrationConversionLocks = new Map<string, Promise<void>>();

async function withRegistrationConversionLock<T>(requestId: string, operation: () => Promise<T>): Promise<T> {
  const previous = registrationConversionLocks.get(requestId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  registrationConversionLocks.set(requestId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (registrationConversionLocks.get(requestId) === current) {
      registrationConversionLocks.delete(requestId);
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; extendedCode?: unknown; message?: unknown };
  return candidate.code === "SQLITE_BUSY" || candidate.extendedCode === "SQLITE_BUSY" ||
    (typeof candidate.message === "string" && /\bSQLITE_BUSY\b/.test(candidate.message));
}

async function withSqliteBusyRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isSqliteBusy(error) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (2 ** attempt)));
    }
  }
  throw new Error("Unreachable registration transaction retry state.");
}

/** Registration conversions are all-or-nothing; ordinary onboarding keeps its existing write path. */
export async function onboardMerchant(input: OnboardMerchantInput, actor: Principal) {
  if (actor.role !== "admin") errors.forbidden("Only an admin can onboard a merchant.");
  if (input.registrationRequestId) {
    return withRegistrationConversionLock(input.registrationRequestId, () =>
      withSqliteBusyRetry(() => db.transaction((tx) => createOnboardedMerchant(input, actor, tx))),
    );
  }
  return createOnboardedMerchant(input, actor, db);
}

/** Convert an internal Operations request only after Admin's final modal save. */
export async function approveStaffOnboardingRequest(input: StaffOnboardingApprovalInput, actor: Principal, requestIdForAudit?: string) {
  if (actor.role !== "admin") errors.forbidden("Only an admin can approve an Operations onboarding request.");
  const { requestId, ...merchantDetails } = input;
  return withRegistrationConversionLock(`operations:${requestId}`, () =>
    withSqliteBusyRetry(() => db.transaction(async (tx) => {
      const request = await getStaffOnboardingRequestForApproval(requestId, tx);
      if (request.status !== "pending") errors.conflict("This onboarding request has already been approved.");
      const onboarded = await createOnboardedMerchant(
        {
          ...merchantDetails,
          branchId: request.branchId,
          lat: merchantDetails.lat === undefined ? request.lat : merchantDetails.lat,
          lng: merchantDetails.lng === undefined ? request.lng : merchantDetails.lng,
        },
        actor,
        tx,
      );
      await markStaffOnboardingApproved(requestId, onboarded.merchant.id, actor, tx);
      const result = {
        ...onboarded,
        staffRequest: { id: requestId, status: "approved" as const, approvedMerchantId: onboarded.merchant.id },
      };
      await writeAudit({
        entity: "merchants_onboarding_request",
        entityId: requestId,
        action: "merchant.onboarding_approved",
        actor,
        requestId: requestIdForAudit,
        before: { status: request.status, branchId: request.branchId },
        after: result,
      }, tx);
      return result;
    })),
  );
}
