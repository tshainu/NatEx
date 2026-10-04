/**
 * §6 through the real choke point — `transitionParcel()` and `createParcel()`
 * against the live database.
 *
 * state-machine.test.ts proves the TABLE. This file proves the CODE that
 * enforces it: that every legal edge actually writes status + parcel_event
 * together, that every illegal edge is refused with 422 and the current state
 * and writes nothing, that every role refusal is a 403, and that the §6 guards
 * (POD, sealed bag) cannot be skipped by calling the generic transition.
 *
 * Isolation: every fixture lives in a synthetic branch (TEST_BRANCH) under
 * three "[§6 test]" merchants, so no real branch's board or runsheets see it.
 * Admins (global scope) will see the rows; they are labelled as test data.
 *
 * Run: `bun --env-file=../../.env test src/api/modules/parcels/transition.db.test.ts`
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { ORPCError } from "@orpc/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../database";
import { parcel, parcelEvent } from "../../database/schema/parcels";
import { merchant } from "../../database/schema/merchants";
import type { Principal, Role } from "../../shared/auth";
import { getMerchant, seedMerchant, setMerchantStatus } from "../merchants/service";
import {
  createParcel,
  getParcelById,
  seedParcel,
  transitionParcel,
  type CreateParcelInput,
  type ParcelRow,
} from "./service";
import {
  PARCEL_STATUSES,
  TRANSITION_ROLES,
  isLegalTransition,
  isTerminal,
  legalNext,
  type ParcelStatus,
} from "./state-machine";

setDefaultTimeout(300_000);

const TEST_BRANCH = "brn_test_sm6";
const OTHER_BRANCH = "brn_kdy_hub";
const M_COD = "mch_sm6_test_cod";
const M_NOCOD = "mch_sm6_test_nocod";
const M_SUSP = "mch_sm6_test_suspended";
const REAL_MERCHANT = "mch_ceylon_threads"; // brn_cmb_central — another branch
const RUN = Date.now().toString(36).toUpperCase();

const principal = (role: Role, extra: Partial<Principal> = {}): Principal => ({
  userId: `usr_sm6_${role}`,
  name: `§6 test ${role}`,
  role,
  branchId: TEST_BRANCH,
  merchantId: role === "merchant" ? M_COD : null,
  deviceId: null,
  ...extra,
});
const AS: Record<Role, Principal> = {
  admin: principal("admin"),
  ops: principal("ops"),
  rider: principal("rider"),
  transport: principal("transport"),
  finance: principal("finance"),
  merchant: principal("merchant"),
};
const ALL_ROLES = Object.keys(AS) as Role[];
/** Full guard evidence, for the tests that are about the table, not the guards. */
const ALL_GUARDS = { podId: "pod_sm6_fixture", tripId: "trp_sm6_fixture" };

let awbCounter = 0;
const nextAwb = () => `SM6${RUN}${(awbCounter++).toString().padStart(4, "0")}`;

const baseInput = (merchantId = M_COD): CreateParcelInput => ({
  merchantId,
  branchId: TEST_BRANCH,
  weightGrams: 500,
  declaredValueCents: 150_000,
  codAmountCents: 0,
  originAddress: "§6 test origin, Kandy",
  consigneeName: "§6 state-machine test",
  consigneePhone: "+94700000000",
  destAddress: "§6 test destination, Kandy",
});

async function parcelAt(status: ParcelStatus): Promise<ParcelRow> {
  return seedParcel({ ...baseInput(), awb: nextAwb(), status }, [
    { status, actorName: "§6 fixture", actorRole: "admin", at: new Date() },
  ]);
}

async function eventCount(parcelId: string): Promise<number> {
  const rows = await db.select().from(parcelEvent).where(eq(parcelEvent.parcelId, parcelId));
  return rows.length;
}

/** Run `fn`, expect an ORPCError, return its HTTP status and problem document. */
async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ORPCError) {
      return { status: err.status, data: err.data as Record<string, unknown> };
    }
    throw err;
  }
  throw new Error("expected a refusal, but the call succeeded");
}

async function ensureMerchant(id: string, codEnabled: boolean) {
  if (await getMerchant(id)) return;
  await seedMerchant({
    id,
    branchId: TEST_BRANCH,
    name: `[§6 test] ${id}`,
    address: "Test fixture — not a real merchant",
    contactName: "§6 test",
    contactPhone: "+94700000000",
    codEnabled,
    podPolicy: "signature",
  });
}

const LEGAL: [ParcelStatus, ParcelStatus][] = PARCEL_STATUSES.flatMap((f) =>
  legalNext(f).map((t) => [f, t] as [ParcelStatus, ParcelStatus]),
);

/** One untouched parcel per status: refusals must leave them exactly so. */
const atStatus = new Map<ParcelStatus, ParcelRow>();

beforeAll(async () => {
  await ensureMerchant(M_COD, true);
  await ensureMerchant(M_NOCOD, false);
  await ensureMerchant(M_SUSP, true);
  await setMerchantStatus(M_SUSP, "suspended", AS.admin);
  for (const s of PARCEL_STATUSES) atStatus.set(s, await parcelAt(s));
});

/**
 * Leave the dev database as it was found (Round 6): the fixtures otherwise
 * pile up as a "[§6 test]" merchant and an unnamed branch on the admin
 * company dashboard. Only rows this file owns — its synthetic branch and its
 * three test merchants — are removed. Nothing references a parcel by FK.
 */
afterAll(async () => {
  const ids = (await db.select({ id: parcel.id }).from(parcel).where(eq(parcel.branchId, TEST_BRANCH))).map((r) => r.id);
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    await db.delete(parcelEvent).where(inArray(parcelEvent.parcelId, chunk));
    await db.delete(parcel).where(inArray(parcel.id, chunk));
  }
  await db.delete(merchant).where(inArray(merchant.id, [M_COD, M_NOCOD, M_SUSP]));
});

// ── Every legal transition, written for real ─────────────────────────────────

describe(`legal transitions through transitionParcel (${LEGAL.length})`, () => {
  test.each(LEGAL)("%s → %s moves the parcel and appends one event", async (from, to) => {
    const p = await parcelAt(from);
    const result = await transitionParcel({ awbOrId: p.awb, to }, AS.admin, ALL_GUARDS);

    expect(result.deduped).toBe(false);
    expect(result.parcel.status).toBe(to);
    expect(result.event.fromStatus).toBe(from);
    expect(result.event.toStatus).toBe(to);
    expect(result.event.actorRole).toBe("admin");

    const reread = await getParcelById(p.id);
    expect(reread!.status).toBe(to);
    expect(await eventCount(p.id)).toBe(2); // fixture genesis + this one
    // §6: COD is locked the moment a parcel is Delivered, and only then.
    expect(reread!.codLockedAt !== null).toBe(to === "Delivered");
  });
});

// ── Every illegal transition, refused with nothing written ───────────────────

const ILLEGAL: [ParcelStatus, ParcelStatus][] = PARCEL_STATUSES.flatMap((f) =>
  PARCEL_STATUSES.filter((t) => t !== f && !isLegalTransition(f, t)).map(
    (t) => [f, t] as [ParcelStatus, ParcelStatus],
  ),
);

describe(`illegal transitions through transitionParcel (${ILLEGAL.length})`, () => {
  test.each(ILLEGAL)("%s → %s is 422 with the current state", async (from, to) => {
    const p = atStatus.get(from)!;
    const r = await refusal(() => transitionParcel({ awbOrId: p.awb, to }, AS.admin, ALL_GUARDS));
    expect(r.status).toBe(422);
    expect(r.data.type).toBe("https://natex.lk/problems/illegal-transition");
    expect(r.data.currentStatus).toBe(from);
    expect(r.data.attemptedStatus).toBe(to);
    expect(r.data.legalTransitions).toEqual(isTerminal(from) ? [] : [...legalNext(from)]);
  });

  test.each([...PARCEL_STATUSES])("%s → itself is 409 'already', not a silent no-op", async (s) => {
    const p = atStatus.get(s)!;
    const r = await refusal(() => transitionParcel({ awbOrId: p.awb, to: s }, AS.admin, ALL_GUARDS));
    expect(r.status).toBe(409);
    expect(r.data.currentStatus).toBe(s);
  });

  test("after every refusal above, no fixture parcel moved or gained an event", async () => {
    for (const [s, p] of atStatus) {
      const reread = await getParcelById(p.id);
      expect(reread!.status).toBe(s);
      expect(await eventCount(p.id)).toBe(1);
    }
  });
});

// ── Roles ────────────────────────────────────────────────────────────────────

const ROLE_REFUSALS: [Role, ParcelStatus, ParcelStatus][] = LEGAL.flatMap(([f, t]) =>
  ALL_ROLES.filter((r) => !TRANSITION_ROLES[t].includes(r)).map(
    (r) => [r, f, t] as [Role, ParcelStatus, ParcelStatus],
  ),
);

describe(`role refusals on legal edges (${ROLE_REFUSALS.length})`, () => {
  test.each(ROLE_REFUSALS)("%s may not command %s → %s: 403", async (role, from, to) => {
    const p = atStatus.get(from)!;
    const r = await refusal(() => transitionParcel({ awbOrId: p.awb, to }, AS[role], ALL_GUARDS));
    expect(r.status).toBe(403);
    expect(r.data.requiredRoles).toEqual([...TRANSITION_ROLES[to]]);
  });

  test("§6 verbatim: a merchant cannot mark its own parcel Delivered", async () => {
    const p = atStatus.get("OutForDelivery")!;
    const r = await refusal(() =>
      transitionParcel({ awbOrId: p.awb, to: "Delivered" }, AS.merchant, ALL_GUARDS),
    );
    expect(r.status).toBe(403);
  });

  test("a permitted non-admin role succeeds on its own edge (rider: OutForDelivery → DeliveryAttempted)", async () => {
    const p = await parcelAt("OutForDelivery");
    const res = await transitionParcel({ awbOrId: p.awb, to: "DeliveryAttempted" }, AS.rider);
    expect(res.parcel.status).toBe("DeliveryAttempted");
    expect(res.event.actorRole).toBe("rider");
  });

  test("the refusals left every fixture untouched", async () => {
    for (const [s, p] of atStatus) expect((await getParcelById(p.id))!.status).toBe(s);
  });
});

// ── §6 workflow guards cannot be skipped ─────────────────────────────────────

describe("§6 guards at the choke point", () => {
  test("Delivered without a POD is 422 pod-required, even for admin", async () => {
    const p = await parcelAt("OutForDelivery");
    const r = await refusal(() => transitionParcel({ awbOrId: p.awb, to: "Delivered" }, AS.admin));
    expect(r.status).toBe(422);
    expect(r.data.guard).toBe("pod-required");
    expect(r.data.currentStatus).toBe("OutForDelivery");
    expect(r.data.legalTransitions).not.toContain("Delivered");
    expect((await getParcelById(p.id))!.status).toBe("OutForDelivery");
    expect(await eventCount(p.id)).toBe(1);
  });

  test("a rider calling the generic transition cannot skip POD either", async () => {
    const p = await parcelAt("OutForDelivery");
    const r = await refusal(() => transitionParcel({ awbOrId: p.awb, to: "Delivered" }, AS.rider));
    expect(r.status).toBe(422);
    expect(r.data.guard).toBe("pod-required");
  });

  test("RTODelivered without a POD is 422 pod-required", async () => {
    const p = await parcelAt("RTOInTransit");
    const r = await refusal(() => transitionParcel({ awbOrId: p.awb, to: "RTODelivered" }, AS.admin));
    expect(r.status).toBe(422);
    expect(r.data.guard).toBe("pod-required");
  });

  test("Bagged → InTransit without a departing trip is 422 sealed-bag-required", async () => {
    const p = await parcelAt("Bagged");
    const r = await refusal(() => transitionParcel({ awbOrId: p.awb, to: "InTransit" }, AS.transport));
    expect(r.status).toBe(422);
    expect(r.data.guard).toBe("sealed-bag-required");
    expect((await getParcelById(p.id))!.status).toBe("Bagged");
  });

  test("a POD id is not enough for an illegal edge (guards never widen the table)", async () => {
    const p = atStatus.get("InTransit")!;
    const r = await refusal(() => transitionParcel({ awbOrId: p.awb, to: "Delivered" }, AS.admin, ALL_GUARDS));
    expect(r.status).toBe(422);
    expect(r.data.guard).toBeUndefined();
  });
});

// ── Scope, dedupe, concurrency ───────────────────────────────────────────────

describe("scope, dedupe and concurrency", () => {
  test("ops of another branch is refused with 403 (§5)", async () => {
    const p = atStatus.get("AtOriginHub")!;
    const r = await refusal(() =>
      transitionParcel({ awbOrId: p.awb, to: "OnHold" }, principal("ops", { branchId: OTHER_BRANCH })),
    );
    expect(r.status).toBe(403);
  });

  test("another merchant cannot even see the parcel: 404", async () => {
    const p = atStatus.get("Booked")!;
    const r = await refusal(() =>
      transitionParcel({ awbOrId: p.awb, to: "Cancelled" }, principal("merchant", { merchantId: REAL_MERCHANT })),
    );
    expect(r.status).toBe(404);
  });

  test("unknown parcel is 404", async () => {
    const r = await refusal(() => transitionParcel({ awbOrId: "SM6NOSUCHAWB", to: "OnHold" }, AS.admin));
    expect(r.status).toBe(404);
  });

  test("the same clientId applied twice writes one event (§7 dedupe)", async () => {
    const p = await parcelAt("Booked");
    const clientId = `sm6-${RUN}-dedupe`;
    const a = await transitionParcel({ awbOrId: p.awb, to: "OnHold", clientId }, AS.ops);
    const b = await transitionParcel({ awbOrId: p.awb, to: "OnHold", clientId }, AS.ops);
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(b.event.id).toBe(a.event.id);
    expect(await eventCount(p.id)).toBe(2);
  });

  test("three racing terminal transitions from one state: exactly one wins, one event", async () => {
    // All three targets are terminal, so in ANY interleaving only one can
    // land: losers that read before the winner wrote hit the guarded UPDATE
    // (409), losers that read after it see a terminal parcel (422).
    const p = await parcelAt("OutForDelivery");
    const outcomes = await Promise.allSettled(
      (["Delivered", "Lost", "Damaged"] as const).map((to) =>
        transitionParcel({ awbOrId: p.awb, to }, AS.admin, ALL_GUARDS),
      ),
    );
    const won = outcomes.filter((o) => o.status === "fulfilled");
    const lost = outcomes.filter((o) => o.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(2);
    for (const l of lost) expect([409, 422]).toContain((l.reason as ORPCError<string, unknown>).status);
    expect(await eventCount(p.id)).toBe(2);
    console.log(
      `      race losers: ${lost.map((l) => (l.reason as ORPCError<string, unknown>).status).join(", ")}`,
    );
  });
});

// ── Booking: entry state and §5 merchant scoping ─────────────────────────────

describe("createParcel", () => {
  test("a merchant books for itself: Booked, with a genesis event", async () => {
    const d = await createParcel(baseInput(M_COD), AS.merchant);
    expect(d.parcel.status).toBe("Booked");
    expect(d.parcel.merchantId).toBe(M_COD);
    expect(d.timeline).toHaveLength(1);
    expect(d.timeline[0]!.fromStatus).toBeNull();
    expect(d.timeline[0]!.toStatus).toBe("Booked");
  });

  test("a merchant booking for another merchant is 403, never re-scoped", async () => {
    const r = await refusal(() => createParcel(baseInput(REAL_MERCHANT), AS.merchant));
    expect(r.status).toBe(403);
    expect(r.data.merchantId).toBe(REAL_MERCHANT);
  });

  test.each(["rider", "transport", "finance"] as Role[])("%s may not book: 403", async (role) => {
    const r = await refusal(() => createParcel(baseInput(M_COD), AS[role]));
    expect(r.status).toBe(403);
  });

  test("ops booking for a merchant of another branch is 403", async () => {
    const r = await refusal(() => createParcel(baseInput(REAL_MERCHANT), AS.ops));
    expect(r.status).toBe(403);
  });

  test("unknown merchant is 404", async () => {
    const r = await refusal(() => createParcel(baseInput("mch_does_not_exist"), AS.admin));
    expect(r.status).toBe(404);
  });

  test("a suspended merchant cannot book: 409", async () => {
    const r = await refusal(() => createParcel(baseInput(M_SUSP), AS.admin));
    expect(r.status).toBe(409);
  });

  test("COD on a merchant without COD is 400; zero COD is fine", async () => {
    const r = await refusal(() => createParcel({ ...baseInput(M_NOCOD), codAmountCents: 250_00 }, AS.ops));
    expect(r.status).toBe(400);
    const ok = await createParcel({ ...baseInput(M_NOCOD), codAmountCents: 0 }, AS.ops);
    expect(ok.parcel.codAmountCents).toBe(0);
  });

  test("COD must be integer cents: 12.5 and -1 are refused", async () => {
    expect((await refusal(() => createParcel({ ...baseInput(), codAmountCents: 12.5 }, AS.ops))).status).toBe(400);
    expect((await refusal(() => createParcel({ ...baseInput(), codAmountCents: -1 }, AS.ops))).status).toBe(400);
  });
});
