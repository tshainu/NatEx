import { base } from "../__core/app";
import { withRequestId } from "./request-id";
import { withAuth, withAuthAllowingPendingMfa, requireRole } from "./auth";
import * as idem from "./idempotency";
import { consumeToken, clientIp, type BucketSpec } from "./rate-limit";
import { writeAudit } from "../shared/audit";
import { errors } from "../shared/errors";
import { markWrite } from "../shared/request-scope";
import type { Principal, Role } from "../shared/auth";

/**
 * The cross-cutting chain, in the exact order PROJECT.md §4 fixes.
 * DO NOT REORDER.
 *
 *   1 Request ID (ULID)        → middleware/request-id.ts
 *   2 Auth guard               → middleware/auth.ts
 *   3 Idempotency              → middleware/idempotency.ts      (in `mutate`)
 *   4 Zod validation           → each route's `.input(schema)`
 *   5 Rate limiting            → middleware/rate-limit.ts       (in `mutate`)
 *   6 Audit writer             → shared/audit.ts                (in `mutate`)
 *
 * Steps 3, 5 and 6 run inside `mutate()` rather than as oRPC middleware,
 * because all three need the *validated* input (step 4) — the idempotency
 * request hash and the audit record are computed from it. Running them as
 * middleware would place them before validation and hash unvalidated input.
 */

/** Unauthenticated, but request-id'd: login, OTP, public tracking. */
export const publicProc = base.use(withRequestId);

/** Authenticated: JWT → principal with role + branch scope. */
export const authedProc = publicProc.use(withAuth);

/**
 * MFA routes only: admits a session that has passed phone OTP but not yet the
 * authenticator step (§2, M5). Never use it for anything else.
 */
export const mfaProc = publicProc.use(withAuthAllowingPendingMfa);

export const riderProc = authedProc.use(requireRole("rider"));
export const opsProc = authedProc.use(requireRole("ops", "admin"));
export const financeProc = authedProc.use(requireRole("finance", "admin"));
export const hrProc = authedProc.use(requireRole("hr", "admin"));
export const payrollReadProc = authedProc.use(requireRole("hr", "finance", "admin"));
/**
 * Hub and linehaul custody actions (§6 role table): the transport role owns
 * them, ops supervises, admin overrides. Riders are deliberately excluded —
 * a rider hands parcels *to* a hub, it never bags or seals them.
 */
export const transportProc = authedProc.use(requireRole("transport", "ops", "admin"));
export const adminProc = authedProc.use(requireRole("admin"));
export const merchantProc = authedProc.use(requireRole("merchant"));
/**
 * Doorstep actions (§6 role table for Delivered / DeliveryAttempted /
 * RTODelivered): the rider who is standing there owns them, ops records them on
 * a rider's behalf when a device is dead, admin overrides. Transport is
 * excluded — a hub never delivers to a consignee.
 */
export const doorstepProc = authedProc.use(requireRole("rider", "ops", "admin"));
/**
 * The NDR queue is answered by the merchant whose parcel it is, or by ops on
 * their behalf when the SLA clock runs out (§8). The service row-scopes a
 * merchant principal to its own rows.
 */
export const ndrProc = authedProc.use(requireRole("merchant", "ops", "admin"));
/**
 * Disputes and claims (§10 M4): raised by a merchant or by the desks on its
 * behalf, decided by finance. Riders and transport have no part in a claim.
 * The disputes service applies §5 scoping for a merchant principal.
 */
export const disputeProc = authedProc.use(requireRole("merchant", "ops", "finance", "admin"));
/** Any staff member who can read the operational board. */
export const staffProc = authedProc.use(
  requireRole("ops", "admin", "finance", "transport", "rider"),
);
/**
 * The desks: ops, finance and admin — web-portal staff, never field roles.
 * For reads that carry other people's personal data (every staff phone, every
 * message sent to a consignee) or commercial terms (rate cards). A rider's or
 * transport clerk's app never needs them (M5 security review: least privilege).
 */
export const deskProc = authedProc.use(requireRole("ops", "admin", "finance"));
/**
 * Money reads a merchant may also make about itself: statements, settlements,
 * invoices, holds, AR, payable balance and payout (bank) details. The finance
 * routes pin a merchant principal to its own rows (routes/finance.ts
 * scopeMerchant / assertOwned). Field roles are excluded: until the M5 security
 * review these were readProc, which let any rider or transport clerk read any
 * merchant's full bank account number.
 */
export const moneyReadProc = authedProc.use(requireRole("ops", "admin", "finance", "merchant"));
/**
 * Staff plus merchant users. Used only on reads where the module service
 * applies PROJECT.md §5 row-level scoping — a merchant principal reaching one
 * of these sees exactly its own rows, because the service adds
 * `merchantId = principal.merchantId` to the query. Never use this on a route
 * whose service does not scope.
 */
export const readProc = authedProc.use(
  requireRole("ops", "admin", "finance", "transport", "rider", "merchant"),
);

export interface AuthedContext {
  headers: Headers;
  requestId: string;
  route: string;
  principal: Principal;
}

export interface PublicContext {
  headers: Headers;
  requestId: string;
  route: string;
}

export interface MutateOptions {
  /** Route name recorded on the idempotency key and the audit row. */
  route: string;
  /** Audit target. */
  entity: string;
  entityId: (result: unknown) => string;
  action: string;
  /** Per-user bucket. Defaults to 120/min. */
  bucket?: BucketSpec;
  /** Skip the Idempotency-Key requirement (only for non-side-effecting writes). */
  idempotency?: boolean;
}

const DEFAULT_BUCKET: BucketSpec = { capacity: 120, refillPerMinute: 120 };

/**
 * Wraps every mutating handler: idempotency (3) → rate limit (5) → handler →
 * audit (6). Every mutating route in this API goes through here.
 */
export async function mutate<T>(
  context: AuthedContext,
  input: unknown,
  options: MutateOptions,
  run: () => Promise<T>,
): Promise<T> {
  // Never transparently re-run a request that reached a write path.
  markWrite();
  const requireIdem = options.idempotency !== false;
  const key = idem.keyFrom(context.headers);

  if (requireIdem && !key) errors.idempotencyRequired(options.route);

  // 3 — Idempotency: replay the stored response for a duplicate key.
  if (key) {
    const hit = await idem.reserve({
      key,
      route: options.route,
      userId: context.principal.userId,
      input,
    });
    if (hit) return hit.response as T;
  }

  try {
    // 5 — Rate limiting, per-user and per-IP.
    const spec = options.bucket ?? DEFAULT_BUCKET;
    await consumeToken(`user:${context.principal.userId}:${options.route}`, spec);
    await consumeToken(`ip:${clientIp(context.headers)}:${options.route}`, {
      capacity: spec.capacity * 4,
      refillPerMinute: spec.refillPerMinute * 4,
    });

    const result = await run();

    // 6 — Audit: who, what, when, from which device.
    await writeAudit({
      entity: options.entity,
      entityId: options.entityId(result),
      action: options.action,
      actor: context.principal,
      requestId: context.requestId,
      after: result,
    });

    if (key) await idem.complete(key, result);
    return result;
  } catch (err) {
    // A failed handler releases the key so the client can retry cleanly.
    if (key) await idem.release(key);
    throw err;
  }
}

/** Public (unauthenticated) mutations: OTP request, OTP verify, refresh. */
export async function publicMutate<T>(
  context: PublicContext,
  options: {
    route: string;
    bucket: BucketSpec;
    ipScope?: string;
    /**
     * A second bucket on the thing being asked about, not the asker — e.g. the
     * phone number an OTP is sent to, so rotating IPs cannot pump SMS at one
     * number (M5 security review).
     */
    subject?: { key: string; bucket: BucketSpec };
  },
  run: () => Promise<T>,
): Promise<T> {
  // The bucket write is bookkeeping, not business state: re-running it after a
  // dropped socket costs the caller at most one extra token (stricter, never
  // looser). So the request only counts as having written once `run()` starts —
  // a reset on the bucket alone is retried instead of failing a sign-in.
  await consumeToken(
    `anon:${options.ipScope ?? clientIp(context.headers)}:${options.route}`,
    options.bucket,
  );
  if (options.subject) {
    await consumeToken(`anon:${options.subject.key}:${options.route}`, options.subject.bucket);
  }
  markWrite();
  return run();
}

export type { Role };

/**
 * Unauthenticated *reads* (public tracking). There is no principal to bucket
 * against, so the limit is per-IP only and deliberately tight: the AWB space is
 * enumerable, and §9's PDPA duty means scraping it must be expensive.
 */
export async function publicRead(
  context: PublicContext,
  route: string,
  bucket: BucketSpec = { capacity: 60, refillPerMinute: 30 },
): Promise<void> {
  await consumeToken(`anon:${clientIp(context.headers)}:${route}`, bucket);
}
