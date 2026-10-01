import { z } from "zod";
import {
  mutate,
  ndrProc,
  opsProc,
  readProc,
  transportProc,
  doorstepProc,
} from "../middleware/pipeline";
import * as ndrService from "../modules/delivery/ndr";

/**
 * NDR and RTO routes — Milestone 3 (PROJECT.md §8 NDR/SLA, §6 RTO transitions,
 * §10 M3). Part of the delivery module; split out of routes/delivery.ts only to
 * keep each route file under the 500-line lint ceiling.
 *
 * Role split, again from §6's transition table:
 *   - answering an NDR is the merchant's, or ops' on their behalf → ndrProc
 *   - RTOInitiated is ops/admin                                   → opsProc
 *   - RTOInTransit is transport/ops/admin                         → transportProc
 *   - RTODelivered is rider/ops/admin (someone hands it back)     → doorstepProc
 *   - reads are readProc; the service scopes a merchant to its own rows (§5)
 */

const ndrState = z.enum([
  "open",
  "instructed",
  "reattempt_scheduled",
  "rto",
  "resolved",
  "closed",
]);
const runDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD (Asia/Colombo).");

// ----------------------------------------------------------------- NDR queue

/**
 * The queue itself. Oldest first, because the oldest is the one closest to
 * breaching its SLA — §8's clock is the whole point of this list existing.
 */
export const list = readProc
  .input(
    z.object({
      state: z.array(ndrState).optional(),
      merchantId: z.string().optional(),
      overdueOnly: z.boolean().default(false),
      limit: z.number().int().min(1).max(500).default(100),
    }),
  )
  .handler(({ input, context }) => ndrService.listNdr(context.principal, input));

/** The ops/merchant queue screen (§11: server-side pagination, with a total). */
export const page = readProc
  .input(
    z.object({
      state: z.array(ndrState).optional(),
      merchantId: z.string().optional(),
      overdueOnly: z.boolean().default(false),
      search: z.string().max(30).optional(),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(25),
    }),
  )
  .handler(({ input, context }) => ndrService.pageNdr(context.principal, input));

export const get = readProc
  .input(z.object({ ndrId: z.string().min(1) }))
  .handler(({ input, context }) => ndrService.getNdrDetail(input.ndrId, context.principal));

export const counts = readProc
  .input(z.object({}))
  .handler(({ context }) => ndrService.ndrCounts(context.principal));

/**
 * The merchant's answer. `address_change` is the one instruction that rewrites
 * consignee details, and it does so through the parcels service — the address
 * correction is its own parcel_event, never folded into a status change.
 */
export const instruct = ndrProc
  .input(
    z
      .object({
        ndrId: z.string().min(1),
        instruction: z.enum(["reattempt", "rto", "hold", "address_change"]),
        notes: z.string().max(600).nullish(),
        newAddress: z.string().max(400).nullish(),
        newPhone: z.string().max(24).nullish(),
        newLat: z.number().min(-90).max(90).nullish(),
        newLng: z.number().min(-180).max(180).nullish(),
        reattemptDate: runDate.nullish(),
      })
      .refine(
        (v) => v.instruction !== "address_change" || Boolean(v.newAddress ?? v.newPhone),
        {
          message: "address_change needs a new address or a new phone number.",
          path: ["newAddress"],
        },
      ),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "ndr.instruct",
        entity: "delivery_ndr",
        entityId: (r) => (r as ndrService.InstructNdrResult).ndr.id,
        action: `ndr.instructed.${input.instruction}`,
      },
      () => ndrService.instructNdr(input, context.principal),
    ),
  );

/**
 * Ops closing an NDR without an instruction — a duplicate row, or something
 * settled off-system. The reason is mandatory and long enough to be a sentence:
 * a queue that can be emptied without explanation is not a queue.
 */
export const close = opsProc
  .input(z.object({ ndrId: z.string().min(1), closeReason: z.string().min(10).max(600) }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "ndr.close",
        entity: "delivery_ndr",
        entityId: (r) => (r as ndrService.NdrRow).id,
        action: "ndr.closed",
      },
      () => ndrService.closeNdr(input, context.principal),
    ),
  );

// ---------------------------------------------------------------------- RTO

export const rtoList = readProc
  .input(
    z.object({
      state: z.array(z.enum(["initiated", "in_transit", "delivered", "closed"])).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
  )
  .handler(({ input, context }) => ndrService.listRto(context.principal, input));

export const rtoPage = readProc
  .input(
    z.object({
      state: z.array(z.enum(["initiated", "in_transit", "delivered", "closed"])).optional(),
      merchantId: z.string().optional(),
      search: z.string().max(30).optional(),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(25),
    }),
  )
  .handler(({ input, context }) => ndrService.pageRto(context.principal, input));

/** Scoped (§5) — another merchant's return is a 404, another branch's a 403. */
export const rtoGet = readProc
  .input(z.object({ rtoId: z.string().min(1) }))
  .handler(({ input, context }) => ndrService.getRtoDetail(input.rtoId, context.principal));

export const rtoCounts = readProc
  .input(z.object({}))
  .handler(({ context }) => ndrService.rtoCounts(context.principal));

/**
 * Turn a parcel back by ops decision. The automatic three-attempt rule and the
 * reason-code-triggered return both run inside the delivery service under the
 * system principal; this route is for the human decision only, hence the
 * mandatory reason.
 */
export const rtoInitiate = opsProc
  .input(
    z.object({
      awb: z.string().min(3).max(24).optional(),
      parcelId: z.string().min(1).optional(),
      reason: z.string().min(10).max(600),
      notes: z.string().max(600).nullish(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      { ...input, trigger: "ops_decision" },
      {
        route: "ndr.rtoInitiate",
        entity: "delivery_rto",
        entityId: (r) => (r as { rto: ndrService.RtoRow }).rto.id,
        action: "rto.initiated",
      },
      () =>
        ndrService.initiateRto({ ...input, trigger: "ops_decision" }, context.principal),
    ),
  );

export const rtoDispatch = transportProc
  .input(z.object({ rtoId: z.string().min(1), notes: z.string().max(400).nullish() }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "ndr.rtoDispatch",
        entity: "delivery_rto",
        entityId: (r) => (r as { rto: ndrService.RtoRow }).rto.id,
        action: "rto.dispatched",
      },
      () => ndrService.dispatchRto(input, context.principal),
    ),
  );

/**
 * The return is back in the merchant's hands. §6 requires a POD for
 * RTODelivered too — a return handed over with nobody's name on it is the same
 * unaccountable gap as a delivery with no signature.
 */
export const rtoDeliver = doorstepProc
  .input(
    z.object({
      rtoId: z.string().min(1),
      receivedByName: z.string().min(2).max(120),
      signatureData: z.string().max(200_000).nullish(),
      photoUrl: z.string().max(500).nullish(),
      notes: z.string().max(400).nullish(),
      lat: z.number().min(-90).max(90).nullish(),
      lng: z.number().min(-180).max(180).nullish(),
      clientId: z.string().max(64).nullish(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "ndr.rtoDeliver",
        entity: "delivery_rto",
        entityId: (r) => (r as { rto: ndrService.RtoRow }).rto.id,
        action: "rto.delivered",
      },
      () => ndrService.deliverRto(input, context.principal),
    ),
  );

/** Router namespace — composed into the root router in api/index.ts. */
export const ndr = {
  list,
  page,
  get,
  counts,
  instruct,
  close,
  rtoList,
  rtoPage,
  rtoGet,
  rtoCounts,
  rtoInitiate,
  rtoDispatch,
  rtoDeliver,
};
