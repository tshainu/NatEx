import { z } from "zod";
import { financeProc, mutate, opsProc } from "../middleware/pipeline";
import * as ledger from "../modules/freight/ledger";
import { createRetailCounterBooking } from "../modules/parcels/service";

const paymentMethod = z.enum(["cash", "bank_transfer", "qr", "card"]);

const counterInput = z.object({
  branchId: z.string().min(1),
  awb: z.string().trim().max(24).nullish(),
  weightGrams: z.number().int().min(1).max(200_000),
  lengthCm: z.number().int().min(1).max(500).nullish(),
  widthCm: z.number().int().min(1).max(500).nullish(),
  heightCm: z.number().int().min(1).max(500).nullish(),
  declaredValueCents: z.number().int().min(0).max(10_000_000_000).default(0),
  senderName: z.string().trim().min(2).max(160),
  senderPhone: z.string().trim().min(9).max(24),
  senderAddress: z.string().trim().max(500).nullish(),
  payer: z.enum(["sender", "recipient"]),
  freightAmountCents: z.number().int().positive().max(100_000_000),
  paymentMethod: paymentMethod.optional(),
  externalReference: z.string().trim().max(120).nullish(),
  consigneeName: z.string().trim().min(2).max(160),
  consigneePhone: z.string().trim().min(9).max(24),
  destAddress: z.string().trim().min(4).max(1000),
  destLat: z.number().int().min(-90_000_000).max(90_000_000).nullish(),
  destLng: z.number().int().min(-180_000_000).max(180_000_000).nullish(),
  destZoneId: z.string().max(100).nullish(),
}).superRefine((input, ctx) => {
  if (input.payer === "sender" && !input.paymentMethod) {
    ctx.addIssue({ code: "custom", path: ["paymentMethod"], message: "Select the sender's payment method." });
  }
  if (input.payer === "sender" && input.paymentMethod && input.paymentMethod !== "cash" && (input.externalReference?.length ?? 0) < 3) {
    ctx.addIssue({ code: "custom", path: ["externalReference"], message: "Enter the payment reference." });
  }
});

/** Walk-in customer booking, separate from Merchant booking and merchant settlement. */
export const counterBooking = opsProc
  .input(counterInput)
  .handler(({ input, context }) => mutate(
    context,
    input,
    {
      route: "freight.counterBooking",
      entity: "parcels_parcel",
      entityId: (result) => (result as Awaited<ReturnType<typeof createRetailCounterBooking>>).parcel.id,
      action: "retail_parcel.accepted",
    },
    () => {
      const requestId = context.headers.get("idempotency-key");
      if (!requestId) throw new Error("The idempotency key is missing.");
      return createRetailCounterBooking({ ...input, requestId }, context.principal);
    },
  ));

/** Finance/Admin sees all counter and Rider customer-freight collection events. */
export const entries = financeProc
  .input(z.object({
    branchId: z.string().optional(),
    awbOrReceipt: z.string().trim().max(100).optional(),
    entryType: z.enum(["collection", "refund", "adjustment"]).optional(),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(50),
  }))
  .handler(({ input, context }) => ledger.pageFreightEntries(context.principal, input));

export const charges = financeProc
  .input(z.object({
    branchId: z.string().optional(),
    awbOrCode: z.string().trim().max(100).optional(),
    payer: z.enum(["sender", "recipient"]).optional(),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(50),
  }))
  .handler(({ input, context }) => ledger.pageFreightCharges(context.principal, input));

export const reconcile = financeProc
  .input(z.object({ entryId: z.string().min(1), reference: z.string().trim().min(2).max(120), note: z.string().trim().max(500).nullish() }))
  .handler(({ input, context }) => mutate(
    context,
    input,
    {
      route: "freight.reconcile",
      entity: "freight_reconciliation",
      entityId: (result) => (result as Awaited<ReturnType<typeof ledger.reconcileFreightEntry>>).reconciliation.id,
      action: "freight.collection_reconciled",
    },
    () => ledger.reconcileFreightEntry(input, context.principal),
  ));

export const refund = financeProc
  .input(z.object({
    chargeId: z.string().min(1),
    amountCents: z.number().int().positive().max(100_000_000),
    paymentMethod,
    externalReference: z.string().trim().max(120).nullish(),
    reason: z.string().trim().min(8).max(500),
  }).superRefine((input, ctx) => {
    if (input.paymentMethod !== "cash" && (input.externalReference?.length ?? 0) < 3) {
      ctx.addIssue({ code: "custom", path: ["externalReference"], message: "Enter the refund transfer reference." });
    }
  }))
  .handler(({ input, context }) => mutate(
    context,
    input,
    {
      route: "freight.refund",
      entity: "freight_entry",
      entityId: (result) => (result as Awaited<ReturnType<typeof ledger.refundFreight>>).entry.id,
      action: "freight.refunded",
    },
    () => ledger.refundFreight(input, context.principal),
  ));

export const receipt = financeProc
  .input(z.object({ code: z.string().trim().min(5).max(40) }))
  .handler(({ input, context }) => ledger.freightReceipt(input.code, context.principal));

export const freight = { counterBooking, entries, charges, reconcile, refund, receipt };
