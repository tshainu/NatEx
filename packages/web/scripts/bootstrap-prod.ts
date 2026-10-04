/**
 * Production bootstrap: the minimum reference data a fresh, empty database
 * needs before the first sign-in. Unlike `db:seed` it is NON-destructive and
 * idempotent: every insert skips what already exists, so it is safe to re-run
 * and safe on a live database. It never creates demo parcels, demo merchants,
 * demo users or dev MFA factors.
 *
 *   NATEX_ADMIN_NAME="…" NATEX_ADMIN_PHONE=07XXXXXXXX \
 *     bun --env-file=../../.env scripts/bootstrap-prod.ts
 *
 * Creates (when missing):
 * - the three pilot locations (Colombo Central branch, Peliyagoda hub, Kandy
 *   hub) — edit or extend them from Admin → Branches;
 * - the four serviceable Colombo pilot zones;
 * - failure reason codes, notification templates, COD finance config defaults,
 *   and the PLACEHOLDER rate card (§15 q3 is open);
 * - one admin user. They enrol an authenticator at first sign-in (§2).
 * Settings are not written: unset keys read their coded defaults.
 */
import { eq } from "drizzle-orm";
import { normaliseLkPhone } from "../src/api/shared/sms";
import { prefixedId } from "../src/api/shared/ulid";

const { db } = await import("../src/api/database");
const { branch, user } = await import("../src/api/database/schema/identity");
const { zone } = await import("../src/api/database/schema/routing");
const { seedReasonCodes } = await import("../src/api/modules/delivery/reasons");
const { seedTemplates } = await import("../src/api/modules/notifications/service");
const { seedFinanceConfig } = await import("../src/api/modules/cod/config");
const { seedPlaceholderRateCard } = await import("../src/api/modules/merchants/rate-cards");

const adminName = process.env.NATEX_ADMIN_NAME?.trim();
const adminPhoneRaw = process.env.NATEX_ADMIN_PHONE?.trim();
if (!adminName || !adminPhoneRaw) throw new Error("Set NATEX_ADMIN_NAME and NATEX_ADMIN_PHONE.");
const adminPhone = normaliseLkPhone(adminPhoneRaw);
if (!/^\+947\d{8}$/.test(adminPhone)) throw new Error(`${adminPhoneRaw} is not a Sri Lankan mobile number.`);

const toE6 = (v: number) => Math.round(v * 1_000_000);
const CMB = "brn_cmb_central";

const branches = [
  { id: CMB, code: "CMB01", name: "Colombo Central", address: "128 Union Place, Colombo 02", lat: toE6(6.9165), lng: toE6(79.8614), type: "branch" as const },
  { id: "brn_cmb_hub", code: "CMBHUB", name: "Colombo Main Hub — Peliyagoda", address: "Hub Access Rd, Peliyagoda", lat: toE6(6.9686), lng: toE6(79.8912), type: "hub" as const },
  { id: "brn_kdy_hub", code: "KDYHUB", name: "Kandy Regional Hub", address: "Katugastota Rd, Kandy", lat: toE6(7.3018), lng: toE6(80.6297), type: "hub" as const },
];
let branchesAdded = 0;
for (const b of branches) {
  const [have] = await db.select({ id: branch.id }).from(branch).where(eq(branch.id, b.id));
  if (have) continue;
  await db.insert(branch).values(b);
  branchesAdded += 1;
}

let zonesAdded = 0;
const existingZones = await db.select({ name: zone.name }).from(zone);
const zoneNames = new Set(existingZones.map((z) => z.name));
const zones = [
  { name: "Colombo 01-05", minLat: 6.88, minLng: 79.83, maxLat: 6.95, maxLng: 79.89 },
  { name: "Colombo 06-10", minLat: 6.85, minLng: 79.85, maxLat: 6.92, maxLng: 79.92 },
  { name: "Dehiwala — Mount Lavinia", minLat: 6.81, minLng: 79.85, maxLat: 6.87, maxLng: 79.9 },
  { name: "Sri Jayawardenepura Kotte", minLat: 6.88, minLng: 79.89, maxLat: 6.94, maxLng: 79.95 },
];
for (const z of zones) {
  if (zoneNames.has(z.name)) continue;
  await db.insert(zone).values({
    id: prefixedId("zon"),
    name: z.name,
    branchId: CMB,
    minLat: toE6(z.minLat),
    minLng: toE6(z.minLng),
    maxLat: toE6(z.maxLat),
    maxLng: toE6(z.maxLng),
    ring: null,
    serviceable: true,
  });
  zonesAdded += 1;
}

const reasonCodes = await seedReasonCodes();
const templates = await seedTemplates();
const financeConfig = await seedFinanceConfig();
const rateCard = await seedPlaceholderRateCard();

let admin: { id: string; created: boolean };
const [existingAdmin] = await db.select().from(user).where(eq(user.phone, adminPhone));
if (existingAdmin) {
  if (existingAdmin.role !== "admin") throw new Error(`${adminPhone} already belongs to a ${existingAdmin.role} user.`);
  admin = { id: existingAdmin.id, created: false };
} else {
  const id = prefixedId("usr");
  await db.insert(user).values({ id, branchId: CMB, role: "admin", name: adminName, phone: adminPhone, status: "active" });
  admin = { id, created: true };
}

console.log(JSON.stringify({ branchesAdded, zonesAdded, reasonCodes, templates, financeConfig, rateCard, admin: { ...admin, phone: adminPhone, name: adminName } }, null, 2));
process.exit(0);
