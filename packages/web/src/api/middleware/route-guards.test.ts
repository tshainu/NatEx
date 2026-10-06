import { describe, expect, test } from "bun:test";
import { router } from "../index";
import { GUARD_TAG, type GuardTag } from "./auth";
import type { Role } from "../shared/auth";

/**
 * Static guard inventory (M5 security review). Walks the composed router and
 * reads the tags middleware/auth.ts puts on its guards, so a procedure that is
 * accidentally public, or a desk-only read that slips back to a field role, is
 * caught by `bun run test` rather than by an attacker.
 *
 * The live counterpart — every refused (procedure, role) pair actually returns
 * 403 — is scripts/security-review.ts.
 */

interface Guard {
  path: string;
  auth: "public" | "auth" | "auth+pending";
  /** Intersection of every role gate on the chain; null when there is none. */
  roles: Role[] | null;
}

function inventory(): Guard[] {
  const out: Guard[] = [];
  const walk = (node: Record<string, unknown>, path: string[]) => {
    for (const [key, value] of Object.entries(node)) {
      if (!value || typeof value !== "object") continue;
      const def = (value as { "~orpc"?: { middlewares: unknown[] } })["~orpc"];
      if (!def) {
        walk(value as Record<string, unknown>, [...path, key]);
        continue;
      }
      const tags = def.middlewares
        .map((m) => (m as { [GUARD_TAG]?: GuardTag })[GUARD_TAG])
        .filter((t): t is GuardTag => Boolean(t));
      const auth = tags.find((t) => t.kind === "auth");
      let roles: Role[] | null = null;
      for (const t of tags) {
        if (t.kind !== "role") continue;
        roles = roles ? roles.filter((r) => t.roles.includes(r)) : [...t.roles];
      }
      out.push({
        path: [...path, key].join("."),
        auth: !auth ? "public" : auth.kind === "auth" && auth.allowPendingMfa ? "auth+pending" : "auth",
        roles,
      });
    }
  };
  walk(router as unknown as Record<string, unknown>, []);
  return out;
}

const guards = inventory();
const byPath = new Map(guards.map((g) => [g.path, g]));

/** The whole unauthenticated surface. Adding to it is a security decision. */
const PUBLIC = [
  "identity.environment",
  "identity.loginPassword",
  "identity.refresh",
  "identity.requestOtp",
  "identity.verifyOtp",
  "parcels.track",
  "ping",
];

/** The only routes a half-signed-in (phone OTP passed, TOTP not yet) token may reach. */
const PENDING_MFA_OK = ["mfa.enrolConfirm", "mfa.enrolStart", "mfa.status", "mfa.verify"];

/**
 * Authenticated with no role gate at the edge. Each is either about the
 * caller's own session, or its service enforces the role itself
 * (parcels: roleMayCommand + §5 scope; collection: manifest ownership).
 */
const SERVICE_GATED = [
  "collection.handover",
  "collection.scan",
  "identity.logout",
  "identity.me",
  "identity.mySessions",
  "identity.revokeMySession",
  "mfa.regenerateRecoveryCodes",
  "parcels.bulkCreate",
  "parcels.create",
  "parcels.stateMachine",
  "parcels.transition",
];

const FIELD_ROLES: Role[] = ["rider", "transport", "merchant"];

describe("route guards (static inventory)", () => {
  test("the router is non-trivial", () => {
    expect(guards.length).toBeGreaterThan(200);
  });

  test("only the allow-listed procedures are public", () => {
    expect(guards.filter((g) => g.auth === "public").map((g) => g.path).sort()).toEqual(PUBLIC);
  });

  test("a pending-MFA token reaches the MFA routes only", () => {
    expect(guards.filter((g) => g.auth === "auth+pending").map((g) => g.path).sort()).toEqual(PENDING_MFA_OK);
  });

  test("every other authenticated procedure without a role gate is a reviewed one", () => {
    const ungated = guards.filter((g) => g.auth === "auth" && g.roles === null).map((g) => g.path).sort();
    expect(ungated).toEqual(SERVICE_GATED);
  });

  test("no role gate is empty (an empty intersection would lock everyone out silently)", () => {
    expect(guards.filter((g) => g.roles !== null && g.roles.length === 0)).toEqual([]);
  });

  test("admin-only namespaces stay admin-only", () => {
    for (const g of guards.filter((x) => /^(audit|monitor|dashboard|awbBatches)\./.test(x.path))) {
      expect({ path: g.path, roles: g.roles }).toEqual({ path: g.path, roles: ["admin"] });
    }
    for (const path of ["settings.set", "rateCards.publish", "rateCards.assign", "identity.createUser"]) {
      const g = byPath.get(path);
      if (!g) continue; // name drift is caught by the next assertion
      expect({ path, roles: g.roles }).toEqual({ path, roles: ["admin"] });
    }
    expect(byPath.get("settings.set")?.roles).toEqual(["admin"]);
  });

  test("desk-only reads (staff phones, consignee messages, commercial terms) refuse field roles", () => {
    const desk = guards.filter(
      (g) =>
        /^(rateCards|settings)\./.test(g.path) ||
        ["identity.listUsers", "notifications.messages", "notifications.templates", "notifications.template",
          "notifications.templatePreview", "notifications.summary"].includes(g.path),
    );
    expect(desk.length).toBeGreaterThanOrEqual(19);
    for (const g of desk) {
      expect(g.roles).not.toBeNull();
      for (const r of FIELD_ROLES) expect({ path: g.path, has: g.roles!.includes(r) }).toEqual({ path: g.path, has: false });
    }
  });

  test("finance namespace never admits field roles", () => {
    for (const g of guards.filter((x) => x.path.startsWith("finance."))) {
      for (const r of ["rider", "transport"] as Role[]) {
        expect({ path: g.path, has: (g.roles ?? []).includes(r) }).toEqual({ path: g.path, has: false });
      }
    }
  });

  test("round 6 procedures carry the intended gates", () => {
    expect(byPath.get("dashboard.company")?.roles).toEqual(["admin"]);
    for (const r of FIELD_ROLES) expect(byPath.get("cod.dailyFlow")?.roles).not.toContain(r);
    // A bag photo is read like the bag itself: the same staff gate, never a merchant.
    expect(byPath.get("transport.bagPhotoView")?.roles).toEqual(byPath.get("transport.bagGet")!.roles);
    expect(byPath.get("transport.bagPhotoView")?.roles).not.toContain("merchant");
    for (const path of ["transport.bagPhotoUpload", "transport.bagPhotoAttach"]) {
      const g = byPath.get(path);
      expect(g?.roles).toContain("transport");
      for (const r of ["rider", "merchant"] as Role[]) expect({ path, has: g!.roles!.includes(r) }).toEqual({ path, has: false });
    }
    expect(byPath.get("parcels.trends")?.auth).toBe("auth");
  });
});
