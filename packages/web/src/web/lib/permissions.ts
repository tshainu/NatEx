import type { Role } from "./session";

/**
 * Which portal a role lands in, and what it may see in the nav.
 *
 * This is UI shaping, NOT security. Every route is enforced server-side by the
 * role gates in api/middleware/pipeline.ts and by row-level scoping in each
 * module service (§5). Hiding a link here never grants or protects anything.
 */

export type Portal = "ops" | "merchant" | "finance" | "admin" | "field";

export interface NavItem {
  label: string;
  to: string;
  /** Marked in the nav as belonging to a later milestone. */
  milestone?: number;
}

export interface PortalConfig {
  portal: Portal;
  name: string;
  /** The dark ops board is the one dark surface (design.md). */
  home: string;
  nav: NavItem[];
}

const OPS: PortalConfig = {
  portal: "ops",
  name: "Operations",
  home: "/ops/board",
  nav: [
    { label: "Live board", to: "/ops/board" },
    { label: "Parcels", to: "/ops/parcels" },
    { label: "Book a parcel", to: "/ops/book" },
    { label: "Pickup manifests", to: "/ops/manifests" },
    { label: "Hub receipt", to: "/ops/hub-receipt" },
    // §8 NDR/SLA queue + the RTO register. Ops-and-admin: closing an NDR and
    // starting a return by hand are opsProc routes.
    { label: "NDR & returns", to: "/ops/ndr" },
    { label: "Serviceability", to: "/ops/serviceability" },
    { label: "Merchants", to: "/ops/merchants" },
    // §7's ops exception queue for the offline engine. Ops-and-admin only —
    // deliberately NOT in TRANSPORT_NAV below, because sync.conflict* are
    // opsProc routes and a transport clerk is refused them server-side.
    { label: "Sync conflicts", to: "/ops/sync-conflicts" },
  ],
};

/**
 * Transport screens (§6, §7). Separated from the ops nav above because they are
 * also the whole of a transport clerk's web sidebar — the server's transport
 * gate (api/middleware/pipeline.ts) already admits transport, ops and admin to
 * exactly these routes.
 */
const TRANSPORT_NAV: NavItem[] = [
  { label: "Bagging", to: "/ops/bagging" },
  { label: "Linehaul", to: "/ops/linehaul" },
  { label: "Inbound bags", to: "/ops/inbound" },
  { label: "Scan log", to: "/ops/scan-log" },
  { label: "Exceptions", to: "/ops/exceptions" },
  // Building, ordering and dispatching a van is transportProc (transport, ops,
  // admin); closing it is opsProc, so the page hides Close from transport.
  { label: "Runsheets", to: "/ops/runsheets" },
];

const TRANSPORT_PATHS = TRANSPORT_NAV.map((item) => item.to);

const ADMIN: PortalConfig = {
  portal: "admin",
  name: "Administration",
  home: "/admin/users",
  nav: [
    { label: "Users", to: "/admin/users" },
    { label: "Branches", to: "/admin/branches" },
    { label: "Zones", to: "/admin/zones" },
    { label: "Rate cards", to: "/admin/rate-cards" },
    { label: "Settings", to: "/admin/settings" },
    { label: "Templates", to: "/admin/templates" },
    { label: "Audit log", to: "/admin/audit" },
    { label: "System monitor", to: "/admin/monitor" },
  ],
};

/**
 * Admin screens ops may READ (the server refuses ops writes on all of them).
 * The audit log and the job monitor are adminProc reads, so ops never sees
 * them — keep this list and ADMIN_ONLY_PATHS in step with the server gates.
 */
const OPS_REFERENCE_PATHS = ["/admin/users", "/admin/branches", "/admin/zones", "/admin/rate-cards", "/admin/settings", "/admin/templates"];
const ADMIN_ONLY_PATHS = ["/admin/audit", "/admin/monitor"];

const FINANCE: PortalConfig = {
  portal: "finance",
  name: "Finance",
  home: "/finance",
  nav: [
    { label: "Overview", to: "/finance" },
    { label: "COD ledger", to: "/finance/cod" },
    { label: "Remittances", to: "/finance/remittances" },
    { label: "Invoices", to: "/finance/invoices" },
    { label: "Disputes", to: "/finance/disputes" },
  ],
};

const MERCHANT: PortalConfig = {
  portal: "merchant",
  name: "Merchant",
  home: "/merchant",
  nav: [
    { label: "Dashboard", to: "/merchant" },
    { label: "Book parcels", to: "/merchant/book" },
    { label: "Pickups", to: "/merchant/pickups" },
    { label: "Shipments", to: "/merchant/parcels" },
    { label: "Tracking", to: "/merchant/tracking" },
    { label: "NDR & returns", to: "/merchant/ndr" },
    { label: "Statement", to: "/merchant/statement" },
    { label: "Disputes & claims", to: "/merchant/disputes" },
    { label: "Account", to: "/merchant/account" },
  ],
};

const FIELD: PortalConfig = {
  portal: "field",
  name: "Field staff",
  home: "/field",
  nav: [{ label: "Use the mobile app", to: "/field" }],
};

export function portalFor(role: Role): PortalConfig {
  switch (role) {
    case "ops":
      return OPS;
    case "admin":
      return ADMIN;
    case "finance":
      return FINANCE;
    case "merchant":
      return MERCHANT;
    case "rider":
    case "transport":
      return FIELD;
  }
}

/**
 * Admins run operations too, so their sidebar carries both portals. Ops staff
 * get a read-only look at the admin lists (the server refuses their writes).
 */
export function navFor(role: Role): { title: string; items: NavItem[] }[] {
  if (role === "admin") {
    return [
      { title: "Operations", items: OPS.nav },
      { title: "Transport", items: TRANSPORT_NAV },
      { title: "Administration", items: ADMIN.nav },
      { title: "Finance", items: FINANCE.nav },
    ];
  }
  if (role === "ops") {
    return [
      { title: "Operations", items: OPS.nav },
      { title: "Transport", items: TRANSPORT_NAV },
      { title: "Reference", items: ADMIN.nav.filter((item) => OPS_REFERENCE_PATHS.includes(item.to)) },
    ];
  }
  if (role === "transport") {
    // A transport clerk's real tool is the mobile app; the web sidebar gives
    // them the desk-side view of the same custody screens.
    return [
      { title: "Transport", items: TRANSPORT_NAV },
      { title: "Field staff", items: FIELD.nav },
    ];
  }
  const config = portalFor(role);
  return [{ title: config.name, items: config.nav }];
}

export const ROLE_LABEL: Record<Role, string> = {
  rider: "Rider",
  transport: "Transport",
  ops: "Operations",
  finance: "Finance",
  admin: "Administrator",
  merchant: "Merchant",
};

/** Roles that may reach a given path prefix in the UI. */
export function mayVisit(role: Role, path: string): boolean {
  if (path.startsWith("/ops")) {
    if (role === "ops" || role === "admin") return true;
    // Transport staff reach the custody screens only, matching the server gate.
    return role === "transport" && TRANSPORT_PATHS.some((prefix) => path.startsWith(prefix));
  }
  if (path.startsWith("/admin")) {
    // Ops may read the admin reference lists; only admin sees the write
    // controls, and the audit log and job monitor are admin-only reads.
    if (role === "admin") return true;
    return role === "ops" && !ADMIN_ONLY_PATHS.some((prefix) => path.startsWith(prefix));
  }
  if (path.startsWith("/finance")) return role === "finance" || role === "admin";
  if (path.startsWith("/merchant")) return role === "merchant";
  if (path.startsWith("/field")) return role === "rider" || role === "transport";
  return true;
}
