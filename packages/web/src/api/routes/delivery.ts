import { z } from "zod";
import {
  doorstepProc,
  mutate,
  opsProc,
  readProc,
  staffProc,
  transportProc,
} from "../middleware/pipeline";
import * as deliveryService from "../modules/delivery/service";
import { listReasonCodes } from "../modules/delivery/reasons";
import { POD_PHOTO_TYPES, presignPut } from "../shared/storage";
import { ulid } from "../shared/ulid";

/**
 * delivery routes — Milestone 3: runsheets, route order, dispatch, the delivery
 * OTP, and the doorstep record (PROJECT.md §5 delivery module, §6 POD rules,
 * §10 M3). The NDR queue and the RTO flow live in routes/ndr.ts.
 *
 * Role split follows §6's transition table exactly, not convenience:
 *   - building and dispatching a run is a hub action  → transportProc
 *     (OutForDelivery is ops/transport/admin — a rider does not load their own
 *     van, the hub hands it to them)
 *   - the doorstep record is the rider's               → doorstepProc
 *     (rider/ops/admin, never transport)
 *   - closing the run and forcing write-offs is ops    → opsProc
 *
 * Every mutation goes through `mutate()`: riders on 3G retry constantly and an
 * offline queue replays, so a repeated delivery must return the first result,
 * never a second POD.
 */

const awb = z.string().min(3).max(24);
const runDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD (Asia/Colombo).");
const geo = {
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
};
/** §7: the device mints this id so a replayed scan dedupes instead of doubling. */
const clientId = z.string().max(64).nullish();

// ----------------------------------------------------------------- reference

/** The failure reason codes the doorstep screen offers, with their flags. */
export const reasons = staffProc
  .input(z.object({ includeInactive: z.boolean().default(false) }))
  .handler(({ input }) => listReasonCodes(input.includeInactive));

// ----------------------------------------------------------------- runsheets

export const runsheetList = staffProc
  .input(
    z.object({
      status: z.array(z.enum(["draft", "dispatched", "closed", "cancelled"])).optional(),
      runDate: runDate.optional(),
      riderId: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
  )
  .handler(({ input, context }) => deliveryService.listRunsheets(context.principal, input));

/** The ops register (§11: server-side pagination, with a total). */
export const runsheetPage = staffProc
  .input(
    z.object({
      status: z.array(z.enum(["draft", "dispatched", "closed", "cancelled"])).optional(),
      runDate: runDate.optional(),
      riderId: z.string().optional(),
      search: z.string().max(60).optional(),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(25),
    }),
  )
  .handler(({ input, context }) => deliveryService.pageRunsheets(context.principal, input));

export const runsheetGet = staffProc
  .input(z.object({ runsheetId: z.string().min(1) }))
  .handler(({ input, context }) =>
    deliveryService.getRunsheetDetail(input.runsheetId, context.principal),
  );

/**
 * The rider app's home screen: today's own run, or null. Deliberately not a
 * 404 — "no run assigned yet" is a normal morning, not an error.
 */
export const myRunsheet = staffProc
  .input(z.object({ runDate: runDate.optional() }))
  .handler(({ input, context }) => deliveryService.myRunsheet(context.principal, input.runDate));

/** What is sitting at the hub and may legally go out, plus what is blocked and why. */
export const deliverable = staffProc
  .input(z.object({}))
  .handler(({ context }) => deliveryService.deliverableParcels(context.principal));

export const runsheetCreate = transportProc
  .input(
    z.object({
      riderId: z.string().min(1),
      runDate: runDate.optional(),
      hubId: z.string().min(1).optional(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "delivery.runsheetCreate",
        entity: "delivery_runsheet",
        entityId: (r) => (r as deliveryService.RunsheetRow).id,
        action: "runsheet.created",
      },
      () => deliveryService.createRunsheet(input, context.principal),
    ),
  );

/** Bulk load: one verdict per label, so a stray parcel never fails the burst. */
export const runsheetAdd = transportProc
  .input(
    z.object({
      runsheetId: z.string().min(1),
      awbs: z.array(awb).min(1).max(200),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "delivery.runsheetAdd",
        entity: "delivery_runsheet",
        entityId: (r) => (r as deliveryService.AddToRunsheetResult).runsheet.id,
        action: "runsheet.stops_added",
      },
      () => deliveryService.addToRunsheet(input, context.principal),
    ),
  );

export const runsheetRemove = transportProc
  .input(
    z.object({
      runsheetId: z.string().min(1),
      awb,
      reason: z.string().max(300).nullish(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "delivery.runsheetRemove",
        entity: "delivery_runsheet",
        entityId: () => input.runsheetId,
        action: "runsheet.stop_removed",
      },
      () => deliveryService.removeFromRunsheet(input, context.principal),
    ),
  );

/**
 * Order the stops. KNOWN DEVIATION: greedy nearest-neighbour in JS, not a
 * routing engine — the response carries `method` so the caller can see which
 * algorithm produced the order (README deviations table).
 */
export const runsheetOptimise = transportProc
  .input(z.object({ runsheetId: z.string().min(1) }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "delivery.runsheetOptimise",
        entity: "delivery_runsheet",
        entityId: (r) => (r as deliveryService.OptimiseResult).runsheet.id,
        action: "runsheet.optimised",
      },
      () => deliveryService.optimiseRunsheet(input.runsheetId, context.principal),
    ),
  );

export const runsheetDispatch = transportProc
  .input(z.object({ runsheetId: z.string().min(1), notes: z.string().max(400).nullish() }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "delivery.runsheetDispatch",
        entity: "delivery_runsheet",
        entityId: (r) => (r as deliveryService.DispatchResult).runsheet.id,
        action: "runsheet.dispatched",
      },
      () => deliveryService.dispatchRunsheet(input, context.principal),
    ),
  );

/**
 * End of day. `force` writes off whatever is still pending as TIME_EXHAUSTED —
 * a reason code that does NOT burn a consignee's attempt, because it was NatEx
 * that ran out of day. Ops only: a rider may not close their own cash position.
 */
export const runsheetClose = opsProc
  .input(
    z.object({
      runsheetId: z.string().min(1),
      force: z.boolean().default(false),
      notes: z.string().max(400).nullish(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "delivery.runsheetClose",
        entity: "delivery_runsheet",
        entityId: (r) => (r as deliveryService.CloseRunsheetResult).runsheet.id,
        action: "runsheet.closed",
      },
      () => deliveryService.closeRunsheet(input, context.principal),
    ),
  );

// ---------------------------------------------------------------- delivery OTP

/**
 * §9: the delivery OTP is SMS-only — no WhatsApp, no voice fallback. A resend
 * supersedes the live challenge rather than minting a parallel one.
 */
export const otpRequest = doorstepProc
  .input(z.object({ awb }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "delivery.otpRequest",
        entity: "delivery_otp",
        entityId: (r) => (r as deliveryService.OtpRequestResult).challengeId,
        action: "delivery_otp.requested",
        // Tight bucket: each send costs money and rings a consignee's phone.
        bucket: { capacity: 12, refillPerMinute: 6 },
        idempotency: false,
      },
      () => deliveryService.requestDeliveryOtp(input, context.principal),
    ),
  );

/**
 * Verification happens server-side and is recorded on the challenge. The
 * doorstep record then checks for a *consumed* challenge — a rider cannot
 * self-attest that they saw the right code.
 */
export const otpVerify = doorstepProc
  .input(z.object({ awb, code: z.string().min(4).max(8) }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "delivery.otpVerify",
        entity: "delivery_otp",
        entityId: (r) => (r as { challengeId: string }).challengeId,
        action: "delivery_otp.verified",
        bucket: { capacity: 20, refillPerMinute: 10 },
        idempotency: false,
      },
      () => deliveryService.verifyDeliveryOtp(input, context.principal),
    ),
  );

// ------------------------------------------------------------------- doorstep

/**
 * Delivered. The POD the merchant's policy requires must actually be present —
 * the service refuses a weaker proof than the policy asks for — and COD must
 * reconcile to the cent before the parcel changes hands (§1, §9).
 */
export const recordDelivery = doorstepProc
  .input(
    z.object({
      awb,
      receivedByName: z.string().min(2).max(120),
      receivedByRelation: z
        .enum(["self", "family", "neighbour", "security", "reception", "other"])
        .nullish(),
      method: z.enum(["otp", "signature", "photo"]).nullish(),
      // Base64 stroke data or a data URL; the mobile app captures it offline.
      signatureData: z.string().max(200_000).nullish(),
      photoUrl: z.string().max(500).nullish(),
      photoNote: z.string().max(300).nullish(),
      // MONEY: integer cents, never a float (§1).
      codCollectedCents: z.number().int().min(0).nullish(),
      notes: z.string().max(400).nullish(),
      ...geo,
      clientId,
      clientTs: z.coerce.date().nullish(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "delivery.recordDelivery",
        entity: "parcel",
        entityId: (r) => (r as deliveryService.RecordDeliveryResult).parcel.id,
        action: "parcel.delivered",
      },
      () => deliveryService.recordDelivery(input, context.principal),
    ),
  );

/**
 * Failed attempt. The reason code decides everything downstream: whether an
 * attempt is burned, whether the parcel turns straight back, and whether the
 * consignee is told. Nothing here is the rider's judgement call.
 */
export const recordFailure = doorstepProc
  .input(
    z.object({
      awb,
      reasonCode: z.string().min(2).max(40),
      notes: z.string().max(400).nullish(),
      ...geo,
      clientId,
      clientTs: z.coerce.date().nullish(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "delivery.recordFailure",
        entity: "parcel",
        entityId: (r) => (r as deliveryService.RecordFailureResult).parcel.id,
        action: "parcel.delivery_failed",
      },
      () => deliveryService.recordFailure(input, context.principal),
    ),
  );

/**
 * An upload slot for a doorstep photo (photo-policy merchants, §6). The phone
 * PUTs the image straight to object storage and then names the returned
 * `storageRef` as `photoUrl` on the delivery record — which may itself be
 * queued offline; only the upload needs signal.
 */
export const podPhotoUpload = doorstepProc
  .input(z.object({ awb, contentType: z.enum(POD_PHOTO_TYPES) }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "delivery.podPhotoUpload",
        entity: "delivery_pod",
        entityId: (r) => (r as { storageRef: string }).storageRef,
        action: "pod_photo.upload_slot",
        bucket: { capacity: 30, refillPerMinute: 15 },
        idempotency: false,
      },
      () => {
        const ext = input.contentType.split("/")[1] === "jpeg" ? "jpg" : input.contentType.split("/")[1];
        return presignPut(`pod/${input.awb.toUpperCase()}/${ulid()}.${ext}`, input.contentType);
      },
    ),
  );

// ----------------------------------------------------------------- read paths

/**
 * Every attempt, the POD and any live NDR for one AWB. `readProc` because a
 * merchant may see its own parcel's delivery history — the service scopes it.
 */
export const history = readProc
  .input(z.object({ awb }))
  .handler(({ input, context }) => deliveryService.deliveryHistory(input.awb, context.principal));

export const counts = staffProc
  .input(z.object({}))
  .handler(({ context }) => deliveryService.deliveryCounts(context.principal));

/** Router namespace — composed into the root router in api/index.ts. */
export const delivery = {
  reasons,
  runsheetList,
  runsheetPage,
  runsheetGet,
  myRunsheet,
  deliverable,
  runsheetCreate,
  runsheetAdd,
  runsheetRemove,
  runsheetOptimise,
  runsheetDispatch,
  runsheetClose,
  otpRequest,
  otpVerify,
  recordDelivery,
  recordFailure,
  podPhotoUpload,
  history,
  counts,
};
