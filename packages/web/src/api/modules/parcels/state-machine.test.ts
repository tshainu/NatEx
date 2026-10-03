/**
 * §6 parcel state machine — pure unit tests.
 *
 * "Write unit tests for every legal transition and every illegal one."
 *
 * The expected tables below are written out by hand from PROJECT.md §6 and the
 * decisions recorded in state-machine.ts. They are deliberately NOT derived
 * from TRANSITIONS / TRANSITION_ROLES: a test that reads the table it checks
 * would pass whatever the table said. Any edit to the real tables now has to be
 * made twice, on purpose.
 *
 * Run: `bun test src/api/modules/parcels/state-machine.test.ts` (no DB needed).
 */
import { describe, expect, test } from "bun:test";
import { ROLES, type Role } from "../../shared/auth";
import {
  ENABLED_BY_MILESTONE,
  ENABLED_STATUSES,
  EXCEPTION_STATUSES,
  EXPOSED_MILESTONE,
  IN_CUSTODY_STATUSES,
  MAX_DELIVERY_ATTEMPTS,
  PARCEL_STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  TRANSITION_ROLES,
  isEnabled,
  isLegalTransition,
  isTerminal,
  legalNext,
  locksCod,
  milestoneFor,
  requiresPod,
  requiresSealedBag,
  roleMayCommand,
  shouldAutoRto,
  type ParcelStatus,
} from "./state-machine";

// ── The specification, by hand ───────────────────────────────────────────────

const EXPECTED_STATUSES: ParcelStatus[] = [
  "Booked",
  "PickedUp",
  "AtOriginHub",
  "Bagged",
  "InTransit",
  "AtDestHub",
  "OutForDelivery",
  "Delivered",
  "DeliveryAttempted",
  "OnHold",
  "RTOInitiated",
  "RTOInTransit",
  "RTODelivered",
  "Lost",
  "Damaged",
  "Cancelled",
  "ReturnedToMerchant",
];

/** Every legal edge, as "From>To". Everything not listed must be illegal. */
const EXPECTED_LEGAL = new Set<string>([
  // Booked: picked up, cancelled by merchant/ops, held, or lost.
  "Booked>PickedUp",
  "Booked>Cancelled",
  "Booked>OnHold",
  "Booked>Lost",
  // PickedUp
  "PickedUp>AtOriginHub",
  "PickedUp>OnHold",
  "PickedUp>Lost",
  "PickedUp>Damaged",
  // AtOriginHub: bag for linehaul, or same-city direct to a runsheet.
  "AtOriginHub>Bagged",
  "AtOriginHub>OutForDelivery",
  "AtOriginHub>OnHold",
  "AtOriginHub>Lost",
  "AtOriginHub>Damaged",
  // Bagged: depart, or be removed from the bag back to the hub floor.
  "Bagged>InTransit",
  "Bagged>AtOriginHub",
  "Bagged>OnHold",
  "Bagged>Lost",
  "Bagged>Damaged",
  // InTransit
  "InTransit>AtDestHub",
  "InTransit>OnHold",
  "InTransit>Lost",
  "InTransit>Damaged",
  // AtDestHub: to a runsheet, or re-bagged onward.
  "AtDestHub>OutForDelivery",
  "AtDestHub>Bagged",
  "AtDestHub>OnHold",
  "AtDestHub>Lost",
  "AtDestHub>Damaged",
  // OutForDelivery
  "OutForDelivery>Delivered",
  "OutForDelivery>DeliveryAttempted",
  "OutForDelivery>OnHold",
  "OutForDelivery>Lost",
  "OutForDelivery>Damaged",
  // DeliveryAttempted: reattempt, hold, or RTO (automatic after 3 attempts).
  "DeliveryAttempted>OutForDelivery",
  "DeliveryAttempted>OnHold",
  "DeliveryAttempted>RTOInitiated",
  "DeliveryAttempted>Lost",
  "DeliveryAttempted>Damaged",
  // OnHold
  "OnHold>OutForDelivery",
  "OnHold>AtDestHub",
  "OnHold>RTOInitiated",
  "OnHold>Cancelled",
  "OnHold>Lost",
  "OnHold>Damaged",
  "OnHold>ReturnedToMerchant",
  // RTO chain
  "RTOInitiated>RTOInTransit",
  "RTOInitiated>OnHold",
  "RTOInitiated>Lost",
  "RTOInitiated>Damaged",
  "RTOInTransit>RTODelivered",
  "RTOInTransit>OnHold",
  "RTOInTransit>Lost",
  "RTOInTransit>Damaged",
  // Terminal states: nothing. "Corrections are reversal events, never edits."
]);

const EXPECTED_TERMINAL: ParcelStatus[] = [
  "Delivered",
  "RTODelivered",
  "Lost",
  "Damaged",
  "Cancelled",
  "ReturnedToMerchant",
];

/** Who may command a move INTO each status. */
const EXPECTED_ROLES: Record<ParcelStatus, Role[]> = {
  Booked: ["merchant", "ops", "admin"],
  PickedUp: ["rider", "ops", "admin"],
  AtOriginHub: ["rider", "transport", "ops", "admin"],
  Bagged: ["transport", "ops", "admin"],
  InTransit: ["transport", "ops", "admin"],
  AtDestHub: ["transport", "ops", "admin"],
  OutForDelivery: ["transport", "ops", "admin"],
  Delivered: ["rider", "ops", "admin"],
  DeliveryAttempted: ["rider", "ops", "admin"],
  OnHold: ["ops", "admin"],
  RTOInitiated: ["ops", "admin"],
  RTOInTransit: ["transport", "ops", "admin"],
  RTODelivered: ["rider", "ops", "admin"],
  Lost: ["ops", "admin"],
  Damaged: ["transport", "ops", "admin"],
  Cancelled: ["merchant", "ops", "admin"],
  ReturnedToMerchant: ["ops", "admin"],
};

const ALL_PAIRS: [ParcelStatus, ParcelStatus][] = PARCEL_STATUSES.flatMap((from) =>
  PARCEL_STATUSES.map((to) => [from, to] as [ParcelStatus, ParcelStatus]),
);
const LEGAL_PAIRS = ALL_PAIRS.filter(([f, t]) => EXPECTED_LEGAL.has(`${f}>${t}`));
const ILLEGAL_PAIRS = ALL_PAIRS.filter(([f, t]) => !EXPECTED_LEGAL.has(`${f}>${t}`));

// ── The enum ─────────────────────────────────────────────────────────────────

describe("status enum", () => {
  test("is exactly the 17 statuses of §6, in order", () => {
    expect([...PARCEL_STATUSES]).toEqual(EXPECTED_STATUSES);
  });

  test("has no duplicates", () => {
    expect(new Set(PARCEL_STATUSES).size).toBe(PARCEL_STATUSES.length);
  });

  test("the transition table has a row for every status and nothing else", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...EXPECTED_STATUSES].sort());
  });

  test("every target in the table is a real status, listed once", () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      expect(new Set(targets).size, `${from} lists a target twice`).toBe(targets.length);
      for (const to of targets) expect(EXPECTED_STATUSES).toContain(to);
    }
  });

  test("the pair space is fully partitioned: 289 pairs = legal + illegal", () => {
    expect(ALL_PAIRS).toHaveLength(17 * 17);
    expect(LEGAL_PAIRS).toHaveLength(EXPECTED_LEGAL.size);
    expect(LEGAL_PAIRS.length + ILLEGAL_PAIRS.length).toBe(289);
  });
});

// ── Every legal transition ───────────────────────────────────────────────────

describe(`every legal transition (${LEGAL_PAIRS.length})`, () => {
  test.each(LEGAL_PAIRS)("%s → %s is legal", (from, to) => {
    expect(isLegalTransition(from, to)).toBe(true);
    expect(legalNext(from)).toContain(to);
  });

  test("the table holds no legal edge the spec does not", () => {
    const actual = ALL_PAIRS.filter(([f, t]) => isLegalTransition(f, t)).map(
      ([f, t]) => `${f}>${t}`,
    );
    expect(actual.sort()).toEqual([...EXPECTED_LEGAL].sort());
  });
});

// ── Every illegal transition ─────────────────────────────────────────────────

describe(`every illegal transition (${ILLEGAL_PAIRS.length})`, () => {
  test.each(ILLEGAL_PAIRS)("%s → %s is illegal", (from, to) => {
    expect(isLegalTransition(from, to)).toBe(false);
    expect(legalNext(from)).not.toContain(to);
  });

  test.each([...EXPECTED_STATUSES])("%s → itself is illegal (no self-loops)", (s) => {
    expect(isLegalTransition(s, s)).toBe(false);
  });

  test.each([...EXPECTED_STATUSES])("nothing moves back to Booked from %s", (s) => {
    expect(isLegalTransition(s, "Booked")).toBe(false);
  });

  test("a status outside the enum has no legal moves", () => {
    expect(legalNext("Teleported" as ParcelStatus)).toEqual([]);
    expect(isLegalTransition("Teleported" as ParcelStatus, "Delivered")).toBe(false);
  });
});

// ── Terminal states are immutable ────────────────────────────────────────────

describe("terminal states", () => {
  test("are exactly the six §6 end states", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual([...EXPECTED_TERMINAL].sort());
  });

  test.each(EXPECTED_TERMINAL)("%s has no outgoing transition at all", (s) => {
    expect(isTerminal(s)).toBe(true);
    expect(legalNext(s)).toEqual([]);
    for (const to of EXPECTED_STATUSES) expect(isLegalTransition(s, to)).toBe(false);
  });

  test.each(EXPECTED_STATUSES.filter((s) => !EXPECTED_TERMINAL.includes(s)))(
    "%s is not terminal and has somewhere to go",
    (s) => {
      expect(isTerminal(s)).toBe(false);
      expect(legalNext(s).length).toBeGreaterThan(0);
    },
  );
});

// ── Graph properties ─────────────────────────────────────────────────────────

function reachableFrom(start: ParcelStatus): Set<ParcelStatus> {
  const seen = new Set<ParcelStatus>([start]);
  const queue = [start];
  while (queue.length) {
    for (const next of legalNext(queue.shift()!)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

describe("graph", () => {
  test("the §6 happy path is walkable end to end", () => {
    const path: ParcelStatus[] = [
      "Booked",
      "PickedUp",
      "AtOriginHub",
      "Bagged",
      "InTransit",
      "AtDestHub",
      "OutForDelivery",
      "Delivered",
    ];
    for (let i = 1; i < path.length; i++) {
      expect(isLegalTransition(path[i - 1]!, path[i]!)).toBe(true);
    }
  });

  test("the §6 exceptional path is walkable end to end", () => {
    const path: ParcelStatus[] = [
      "OutForDelivery",
      "DeliveryAttempted",
      "OnHold",
      "RTOInitiated",
      "RTOInTransit",
      "RTODelivered",
    ];
    for (let i = 1; i < path.length; i++) {
      expect(isLegalTransition(path[i - 1]!, path[i]!)).toBe(true);
    }
  });

  test("automatic RTO after the last attempt is a direct legal edge", () => {
    expect(isLegalTransition("DeliveryAttempted", "RTOInitiated")).toBe(true);
  });

  test("every status is reachable from Booked (no dead enum values)", () => {
    const reach = reachableFrom("Booked");
    for (const s of EXPECTED_STATUSES) expect(reach.has(s), `${s} unreachable`).toBe(true);
  });

  test.each(EXPECTED_STATUSES.filter((s) => !EXPECTED_TERMINAL.includes(s)))(
    "%s can still reach a terminal state (no traps)",
    (s) => {
      const reach = reachableFrom(s);
      expect(EXPECTED_TERMINAL.some((t) => reach.has(t))).toBe(true);
    },
  );

  test("Cancelled is only possible before pickup or from a hold", () => {
    const into = EXPECTED_STATUSES.filter((f) => isLegalTransition(f, "Cancelled"));
    expect(into.sort()).toEqual(["Booked", "OnHold"]);
  });

  test("Delivered is only reachable from OutForDelivery", () => {
    const into = EXPECTED_STATUSES.filter((f) => isLegalTransition(f, "Delivered"));
    expect(into).toEqual(["OutForDelivery"]);
  });

  test("custody and exception groupings contain only non-terminal statuses", () => {
    for (const s of [...IN_CUSTODY_STATUSES, ...EXCEPTION_STATUSES]) {
      expect(isTerminal(s)).toBe(false);
    }
  });
});

// ── Roles ────────────────────────────────────────────────────────────────────

const ROLE_CASES: [Role, ParcelStatus, boolean][] = ROLES.flatMap((role) =>
  EXPECTED_STATUSES.map(
    (to) => [role, to, EXPECTED_ROLES[to].includes(role)] as [Role, ParcelStatus, boolean],
  ),
);

describe(`roles (${ROLE_CASES.length} role × status cases)`, () => {
  test("the role list is the six roles of §5", () => {
    expect([...ROLES].sort()).toEqual(
      (["admin", "finance", "merchant", "ops", "rider", "transport"] as Role[]).sort(),
    );
  });

  test.each(ROLE_CASES)("%s → %s permitted: %p", (role, to, allowed) => {
    expect(roleMayCommand(role, to)).toBe(allowed);
  });

  test.each([...EXPECTED_STATUSES])("%s lists each role at most once", (to) => {
    const roles = TRANSITION_ROLES[to];
    expect(new Set(roles).size).toBe(roles.length);
    expect([...roles].sort()).toEqual([...EXPECTED_ROLES[to]].sort());
  });

  test("§6 verbatim: a merchant cannot mark Delivered", () => {
    expect(roleMayCommand("merchant", "Delivered")).toBe(false);
    expect(roleMayCommand("merchant", "RTODelivered")).toBe(false);
  });

  test("a merchant can only book and cancel", () => {
    const allowed = EXPECTED_STATUSES.filter((s) => roleMayCommand("merchant", s));
    expect(allowed.sort()).toEqual(["Booked", "Cancelled"]);
  });

  test("finance commands no parcel movement (it adjusts money, with audit)", () => {
    expect(EXPECTED_STATUSES.filter((s) => roleMayCommand("finance", s))).toEqual([]);
  });

  test("a rider cannot put a parcel on hold, RTO it, or write it off", () => {
    for (const s of ["OnHold", "RTOInitiated", "Lost", "Damaged", "Cancelled"] as const) {
      expect(roleMayCommand("rider", s)).toBe(false);
    }
  });

  test("admin may command every status", () => {
    for (const s of EXPECTED_STATUSES) expect(roleMayCommand("admin", s)).toBe(true);
  });

  test("an unknown role may command nothing", () => {
    for (const s of EXPECTED_STATUSES) expect(roleMayCommand("intern" as Role, s)).toBe(false);
  });
});

// ── Guards declared by §6 ────────────────────────────────────────────────────

describe("§6 guards", () => {
  test.each([...EXPECTED_STATUSES])("requiresPod(%s)", (s) => {
    expect(requiresPod(s)).toBe(s === "Delivered" || s === "RTODelivered");
  });

  test.each(ALL_PAIRS)("requiresSealedBag(%s, %s)", (from, to) => {
    expect(requiresSealedBag(from, to)).toBe(from === "Bagged" && to === "InTransit");
  });

  test.each([...EXPECTED_STATUSES])("locksCod(%s)", (s) => {
    expect(locksCod(s)).toBe(s === "Delivered");
  });

  test("maximum 3 delivery attempts", () => {
    expect(MAX_DELIVERY_ATTEMPTS).toBe(3);
  });

  test.each([
    [0, false],
    [1, false],
    [2, false],
    [3, true],
    [4, true],
  ] as const)("shouldAutoRto(%i) is %p", (attempts, expected) => {
    expect(shouldAutoRto(attempts)).toBe(expected);
  });
});

// ── Milestone exposure (§10) ─────────────────────────────────────────────────

describe("milestone exposure", () => {
  test("each status is owned by exactly one milestone", () => {
    const owned = Object.values(ENABLED_BY_MILESTONE).flat();
    expect(owned.sort()).toEqual([...EXPECTED_STATUSES].sort());
  });

  test.each([
    ["Booked", 1],
    ["PickedUp", 1],
    ["AtOriginHub", 1],
    ["OnHold", 1],
    ["Cancelled", 1],
    ["Lost", 1],
    ["Damaged", 1],
    ["Bagged", 2],
    ["InTransit", 2],
    ["AtDestHub", 2],
    ["OutForDelivery", 3],
    ["Delivered", 3],
    ["DeliveryAttempted", 3],
    ["RTOInitiated", 3],
    ["RTOInTransit", 3],
    ["RTODelivered", 3],
    ["ReturnedToMerchant", 3],
  ] as const)("milestoneFor(%s) is %i", (s, m) => {
    expect(milestoneFor(s)).toBe(m);
  });

  test("a status no milestone owns never unlocks", () => {
    expect(milestoneFor("Teleported" as ParcelStatus)).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("the API exposes exactly the statuses of milestones ≤ EXPOSED_MILESTONE", () => {
    // M4 (money) and M5 (hardening) own no parcel statuses: exposing M4 must
    // not have unlocked anything beyond M3's set.
    expect(EXPOSED_MILESTONE).toBe(5);
    const expected = EXPECTED_STATUSES.filter((s) => milestoneFor(s) <= EXPOSED_MILESTONE);
    expect([...ENABLED_STATUSES].sort()).toEqual(expected.sort());
    for (const s of EXPECTED_STATUSES) expect(isEnabled(s)).toBe(milestoneFor(s) <= 3);
  });
});
