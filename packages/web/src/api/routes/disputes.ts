import { z } from "zod";
import { disputeProc, financeProc, mutate } from "../middleware/pipeline";
import * as svc from "../modules/cod/disputes";
import type { Principal } from "../shared/auth";
import { errors } from "../shared/errors";

/**
 * Disputes and the claim register — Milestone 4 (PROJECT.md §10 M4: "Finance
 * portal: … disputes"; §8 settlement holds; §5 merchant scoping).
 *
 * Role split:
 *   - a merchant raises, reads and withdraws ITS OWN cases       → disputeProc
 *   - ops/finance may raise on a merchant's behalf               → disputeProc
 *   - picking a case up and deciding it is finance only          → financeProc
 *     (the service adds maker–checker: the opener cannot decide)
 *
 * ROW SCOPING. A merchant principal is pinned to its own merchantId on every
 * read. Naming another merchant is a 403 (the caller asked for something it
 * may not have); reaching another merchant's case by id is a 404 (the caller
 * learns nothing about whether it exists) — the service enforces the latter.
 */

const disputeType = z.enum(svc.DISPUTE_TYPES);
const disputeStatus = z.enum(svc.DISPUTE_STATUSES);
const remedy = z.enum(svc.REMEDIES);

/** Pins a merchant to itself; staff pass the filter through. */
function scopeMerchant(principal: Principal, requested: string | undefined): string | undefined {
  if (principal.role !== "merchant") return requested;
  if (!principal.merchantId) errors.forbidden("This account is not linked to a merchant.");
  if (requested && requested !== principal.merchantId) {
    errors.forbidden("A merchant can only see its own disputes.");
  }
  return principal.merchantId!;
}

export const open = disputeProc
  .input(
    z.object({
      merchantId: z.string().optional(),
      awb: z.string().trim().max(40).optional(),
      type: disputeType,
      claimAmountCents: z.number().int().min(0).max(100_000_000_00),
      description: z.string().trim().min(10).max(2000),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "disputes.open",
        entity: "cod_dispute",
        entityId: (r) => (r as svc.DisputeRow).id,
        action: "disputes.open",
        bucket: { capacity: 30, refillPerMinute: 30 },
      },
      () => svc.openDispute(input, context.principal),
    ),
  );

export const list = disputeProc
  .input(
    z.object({
      status: z.array(disputeStatus).optional(),
      type: z.array(disputeType).optional(),
      register: z.boolean().optional(),
      merchantId: z.string().optional(),
      overdueOnly: z.boolean().optional(),
      q: z.string().max(80).optional(),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
    }),
  )
  .handler(({ input, context }) =>
    svc.listDisputes({ ...input, merchantId: scopeMerchant(context.principal, input.merchantId) }),
  );

export const get = disputeProc
  .input(z.object({ disputeId: z.string() }))
  .handler(({ input, context }) => svc.getDispute(input.disputeId, context.principal));

export const counts = disputeProc
  .input(z.object({ merchantId: z.string().optional() }))
  .handler(({ input, context }) => svc.disputeCounts(scopeMerchant(context.principal, input.merchantId)));

export const withdraw = disputeProc
  .input(z.object({ disputeId: z.string(), reason: z.string().trim().min(5).max(500) }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      { route: "disputes.withdraw", entity: "cod_dispute", entityId: () => input.disputeId, action: "disputes.withdraw" },
      () => svc.withdrawDispute(input, context.principal),
    ),
  );

export const assign = financeProc
  .input(
    z.object({
      disputeId: z.string(),
      assigneeId: z.string().optional(),
      assigneeName: z.string().max(120).optional(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      { route: "disputes.assign", entity: "cod_dispute", entityId: () => input.disputeId, action: "disputes.assign" },
      () => svc.assignDispute(input, context.principal),
    ),
  );

export const resolve = financeProc
  .input(
    z.object({
      disputeId: z.string(),
      outcome: z.enum(["upheld", "rejected"]),
      approvedAmountCents: z.number().int().min(0).optional(),
      resolution: z.string().trim().min(10).max(1000),
      remedy: remedy.optional(),
      invoiceId: z.string().optional(),
      payoutRef: z.string().trim().max(64).optional(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      { route: "disputes.resolve", entity: "cod_dispute", entityId: () => input.disputeId, action: "disputes.resolve" },
      () => svc.resolveDispute(input, context.principal),
    ),
  );

/** Reference data for the forms: labels, and which types are claims. */
export const meta = disputeProc.input(z.object({})).handler(() => ({
  types: svc.DISPUTE_TYPES.map((t) => ({
    type: t,
    label: svc.TYPE_LABEL[t],
    isClaim: svc.CLAIM_TYPES.includes(t),
  })),
  statuses: svc.DISPUTE_STATUSES,
  remedies: svc.REMEDIES,
}));

/** Router namespace — composed into the root router in api/index.ts. */
export const disputes = { open, list, get, counts, withdraw, assign, resolve, meta };
