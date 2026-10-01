import { z } from "zod";
import type { Principal } from "../../shared/auth";
import { errors } from "../../shared/errors";
import { normaliseLkPhone } from "../../shared/sms";
import { getMerchant } from "../merchants/service";
import { createParcel } from "./service";
import { roleMayCommand } from "./state-machine";

/**
 * Bulk CSV booking (§10 M3: "Merchant portal: … booking, bulk upload").
 *
 * The CSV is parsed in the browser — rupees to integer cents there, with no
 * floats — and arrives here as rows. Each row is validated on its own and then
 * booked through the ONE booking choke point, `createParcel()`, so a bulk
 * parcel is indistinguishable from a hand-booked one: same Booked entry state,
 * same genesis event, same outbox message, same §5 scoping.
 *
 * One bad row never fails the batch. The response is a per-row report
 * (accepted with AWB / rejected with reasons) keyed by the CSV line number the
 * client sent, which is what a merchant needs to fix the file.
 *
 * Batch-level problems — wrong merchant, unknown or suspended merchant, a role
 * that may not book — DO fail the whole request: no row could succeed.
 */

/** Rows per request. The client chunks larger files, one Idempotency-Key per chunk. */
export const BULK_ROW_LIMIT = 100;

const intCents = (label: string) =>
  z
    .number({ error: `${label} must be a number of cents` })
    .int(`${label} must be whole cents — no fractions`)
    .min(0, `${label} cannot be negative`)
    .max(100_000_000_00, `${label} is implausibly large`);

const optionalCm = z.number().int("Dimensions are whole centimetres").min(1).max(500).nullish();

export const bulkRowSchema = z.object({
  /** CSV line number as the merchant sees it in their spreadsheet. */
  line: z.number().int().min(1),
  orderRef: z.string().trim().max(60).nullish(),
  consigneeName: z
    .string({ error: "Consignee name is required" })
    .trim()
    .min(2, "Consignee name is too short")
    .max(160),
  consigneePhone: z
    .string({ error: "Consignee phone is required" })
    .trim()
    .transform((v) => normaliseLkPhone(v))
    .refine((v) => /^\+94\d{9}$/.test(v), "Consignee phone is not a Sri Lankan number"),
  destAddress: z
    .string({ error: "Delivery address is required" })
    .trim()
    .min(8, "Delivery address is too short to deliver to")
    .max(500),
  weightGrams: z
    .number({ error: "Weight (grams) is required" })
    .int("Weight is whole grams")
    .min(1, "Weight must be at least 1 g")
    .max(200_000, "Weight over 200 kg — book as freight"),
  lengthCm: optionalCm,
  widthCm: optionalCm,
  heightCm: optionalCm,
  codAmountCents: intCents("COD").default(0),
  declaredValueCents: intCents("Declared value").default(0),
  destZoneId: z.string().max(64).nullish(),
});
export type BulkRow = z.infer<typeof bulkRowSchema>;

export interface BulkRowError {
  field: string;
  message: string;
}
export interface BulkAccepted {
  line: number;
  orderRef: string | null;
  awb: string | null;
  parcelId: string | null;
  codAmountCents: number;
}
export interface BulkRejected {
  line: number;
  orderRef: string | null;
  errors: BulkRowError[];
}
export interface BulkReport {
  merchantId: string;
  dryRun: boolean;
  total: number;
  accepted: BulkAccepted[];
  rejected: BulkRejected[];
  /** Sum of COD over accepted rows, integer cents. */
  codTotalCents: number;
}

function lineOf(raw: unknown, index: number): number {
  const l = (raw as { line?: unknown } | null)?.line;
  return typeof l === "number" && Number.isInteger(l) && l > 0 ? l : index + 1;
}
function refOf(raw: unknown): string | null {
  const r = (raw as { orderRef?: unknown } | null)?.orderRef;
  return typeof r === "string" && r.trim() ? r.trim() : null;
}

export async function bulkCreateParcels(
  input: { merchantId: string; rows: unknown[]; dryRun: boolean },
  actor: Principal,
): Promise<BulkReport> {
  if (input.rows.length === 0) errors.badRequest("The file has no rows to book.");
  if (input.rows.length > BULK_ROW_LIMIT) {
    errors.badRequest(`At most ${BULK_ROW_LIMIT} rows per request — split the file.`, {
      rows: input.rows.length,
      limit: BULK_ROW_LIMIT,
    });
  }
  if (!roleMayCommand(actor.role, "Booked")) {
    errors.forbidden(`Role ${actor.role} may not book parcels.`);
  }
  // §5: refused, never silently re-scoped to the caller's own merchant.
  if (actor.role === "merchant" && input.merchantId !== actor.merchantId) {
    errors.forbidden("A merchant may only book parcels for its own account.", {
      merchantId: input.merchantId,
    });
  }
  const owner = await getMerchant(input.merchantId);
  if (!owner) errors.notFound(`Merchant ${input.merchantId}`);
  if (actor.role === "ops" && owner!.branchId !== actor.branchId) {
    errors.forbidden("This merchant belongs to another branch.", {
      merchantBranchId: owner!.branchId,
    });
  }
  if (owner!.status !== "active") {
    errors.conflict(`Merchant ${owner!.name} is ${owner!.status} and cannot book parcels.`, {
      merchantStatus: owner!.status,
    });
  }

  const valid: BulkRow[] = [];
  const rejected: BulkRejected[] = [];
  const seenRefs = new Map<string, number>();

  input.rows.forEach((raw, index) => {
    const line = lineOf(raw, index);
    const orderRef = refOf(raw);
    const parsed = bulkRowSchema.safeParse({ ...(raw as object), line });
    const rowErrors: BulkRowError[] = parsed.success
      ? []
      : parsed.error.issues.map((i) => ({
          field: i.path.join(".") || "row",
          message: i.message,
        }));

    if (parsed.success && parsed.data.codAmountCents > 0 && !owner!.codEnabled) {
      rowErrors.push({ field: "codAmountCents", message: `${owner!.name} is not enabled for COD` });
    }
    if (orderRef) {
      const first = seenRefs.get(orderRef);
      if (first !== undefined) {
        rowErrors.push({ field: "orderRef", message: `Duplicate order ref — first used on line ${first}` });
      } else {
        seenRefs.set(orderRef, line);
      }
    }

    if (rowErrors.length) rejected.push({ line, orderRef, errors: rowErrors });
    else valid.push(parsed.data!);
  });

  const accepted: BulkAccepted[] = [];
  if (input.dryRun) {
    for (const r of valid) {
      accepted.push({ line: r.line, orderRef: r.orderRef ?? null, awb: null, parcelId: null, codAmountCents: r.codAmountCents });
    }
  } else {
    for (const r of valid) {
      // Every row is caught: an unexpected failure on row 40 must not throw away
      // the report for rows 1–39, which ARE booked — the idempotent replay of
      // this request depends on the handler returning, not throwing.
      try {
        const d = await createParcel(
          {
            merchantId: owner!.id,
            branchId: owner!.branchId,
            weightGrams: r.weightGrams,
            lengthCm: r.lengthCm ?? null,
            widthCm: r.widthCm ?? null,
            heightCm: r.heightCm ?? null,
            declaredValueCents: r.declaredValueCents,
            codAmountCents: r.codAmountCents,
            originAddress: owner!.address,
            originLat: owner!.lat,
            originLng: owner!.lng,
            consigneeName: r.consigneeName,
            consigneePhone: r.consigneePhone,
            destAddress: r.destAddress,
            destZoneId: r.destZoneId ?? null,
          },
          actor,
        );
        accepted.push({
          line: r.line,
          orderRef: r.orderRef ?? null,
          awb: d.parcel.awb,
          parcelId: d.parcel.id,
          codAmountCents: d.parcel.codAmountCents,
        });
      } catch (err) {
        rejected.push({
          line: r.line,
          orderRef: r.orderRef ?? null,
          errors: [{ field: "row", message: err instanceof Error ? err.message : "Booking failed" }],
        });
      }
    }
  }

  rejected.sort((a, b) => a.line - b.line);
  return {
    merchantId: owner!.id,
    dryRun: input.dryRun,
    total: input.rows.length,
    accepted,
    rejected,
    codTotalCents: accepted.reduce((sum, a) => sum + a.codAmountCents, 0),
  };
}
