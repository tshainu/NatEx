import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const path = join(tmpdir(), `natex-branches-${process.pid}-${Date.now()}.sqlite`);
process.env.DATABASE_URL = `file:${path}`;
delete process.env.DATABASE_AUTH_TOKEN;
process.env.NODE_ENV = "test";
process.env.SMS_DISABLE_ALL = "true";
delete process.env.SMS_EXECUTION_URL;
const { createClient } = await import("@libsql/client");
const setup = createClient({ url: process.env.DATABASE_URL });
await setup.execute(`CREATE TABLE identity_branch (
 id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, address TEXT NOT NULL, phone TEXT,
 lat_e6 INTEGER, lng_e6 INTEGER, type TEXT NOT NULL, parent_hub_id TEXT REFERENCES identity_branch(id), status TEXT NOT NULL DEFAULT 'active',
 counter_rate_card_id TEXT, created_at INTEGER NOT NULL
)`);
await setup.execute(`CREATE TABLE identity_user (id TEXT PRIMARY KEY, branch_id TEXT, role TEXT, roles TEXT, username TEXT, password_hash TEXT, name TEXT, phone TEXT, device_id TEXT, status TEXT, merchant_id TEXT, created_at INTEGER)`);
await setup.execute(`CREATE TABLE merchants_merchant (id TEXT PRIMARY KEY, branch_id TEXT, pickup_rider_id TEXT, name TEXT, vat_no TEXT, address TEXT, lat_e6 INTEGER, lng_e6 INTEGER, contact_name TEXT, contact_phone TEXT, rate_card_id TEXT, cod_enabled INTEGER, pod_policy TEXT, status TEXT, created_at INTEGER)`);
await setup.execute(`CREATE TABLE routing_zone (id TEXT PRIMARY KEY, name TEXT, branch_id TEXT, min_lat_e6 INTEGER, min_lng_e6 INTEGER, max_lat_e6 INTEGER, max_lng_e6 INTEGER, ring TEXT, serviceable INTEGER, created_at INTEGER)`);
const identity = await import("./service");
const admin = await import("./admin");
const transport = await import("../transport/service");
const merchants = await import("../merchants/service");
const pickups = await import("../collection/pickups");
const delivery = await import("../delivery/service");
const routing = await import("../routing/service");
const actor = { userId: "test-admin", name: "Test admin", role: "admin" as const, roles: ["admin" as const], branchId: "unused", merchantId: null };
let branchId = "";
let geocodedId = "";

afterAll(() => { setup.close(); rmSync(path, { force: true }); });

describe("branch status and optional coordinates (isolated SQLite)", () => {
  test("creates a branch without latitude or longitude and stores null, not zero", async () => {
    const row = await identity.createBranch({ code: "B01", name: "No GPS branch", address: "Main Street, Colombo", type: "branch" });
    branchId = row!.id;
    expect(row!.lat).toBeNull(); expect(row!.lng).toBeNull(); expect(row!.status).toBe("active");
  });
  test("Admin-managed hub assignments resolve exact scope and reject invalid parent links", async () => {
    const hub = await identity.createBranch({ code: "SCOPEH", name: "Scope hub", address: "Hub Road, Colombo", type: "hub" });
    const child = await identity.createBranch({ code: "SCOPEC", name: "Scope child", address: "Child Road, Colombo", type: "branch", parentHubId: hub!.id });
    const otherHub = await identity.createBranch({ code: "SCOPEH2", name: "Other scope hub", address: "Other Road, Jaffna", type: "hub" });
    const otherChild = await identity.createBranch({ code: "SCOPEC2", name: "Other scope child", address: "Other Child Road, Jaffna", type: "branch", parentHubId: otherHub!.id });

    const hubScope = await identity.codLedgerBranchScope(hub!.id);
    expect(hubScope).toContain(hub!.id);
    expect(hubScope).toContain(child!.id);
    expect(hubScope).not.toContain(otherChild!.id);
    expect(await identity.codLedgerBranchScope(child!.id)).toEqual([child!.id]);
    await expect(identity.createBranch({ code: "SCOPEBAD", name: "Invalid child", address: "Bad Road", type: "branch", parentHubId: "missing-hub" })).rejects.toThrow("does not exist");
    await expect(identity.createBranch({ code: "SCOPEBAD2", name: "Invalid child", address: "Bad Road", type: "branch", parentHubId: child!.id })).rejects.toThrow("marked as a hub");
    await expect(identity.createBranch({ code: "SCOPEBAD3", name: "Invalid hub", address: "Bad Road", type: "hub", parentHubId: hub!.id })).rejects.toThrow("cannot be assigned");
    await expect(admin.updateBranch(hub!.id, { type: "branch" })).rejects.toThrow("child branch");

    await admin.updateBranch(child!.id, { parentHubId: null });
    expect(await identity.codLedgerBranchScope(hub!.id)).toEqual([hub!.id]);
    await admin.updateBranch(hub!.id, { type: "branch" });
    await setup.execute({ sql: "DELETE FROM identity_branch WHERE id IN (?, ?)", args: [child!.id, otherChild!.id] });
    await setup.execute({ sql: "DELETE FROM identity_branch WHERE id IN (?, ?)", args: [hub!.id, otherHub!.id] });
  });
  test("stores an optional branch telephone and validates edits without inventing one", async () => {
    const withPhone = await identity.createBranch({ code: "P01", name: "Receipt phone branch", address: "Phone Street, Colombo", phone: "011 234 5678", type: "branch" });
    expect(withPhone!.phone).toBe("011 234 5678");
    await expect(identity.createBranch({ code: "P02", name: "Bad phone branch", address: "Phone Street, Colombo", phone: "not-a-phone", type: "branch" })).rejects.toThrow("Branch telephone");
    const edited = await admin.updateBranch(withPhone!.id, { phone: "+94 11 234 5678" });
    expect(edited.after.phone).toBe("+94 11 234 5678");
    expect((await identity.getBranch(withPhone!.id))?.phone).toBe("+94 11 234 5678");
    expect((await identity.listBranches()).find((row) => row.id === withPhone!.id)?.phone).toBe("+94 11 234 5678");
    const cleared = await admin.updateBranch(withPhone!.id, { phone: null });
    expect(cleared.after.phone).toBeNull();
  });
  test("editing unrelated fields preserves GPS; explicit clearing stores null", async () => {
    await admin.updateBranch(branchId, { latE6: 6_927_100, lngE6: 79_861_200 });
    const edited = await admin.updateBranch(branchId, { name: "Renamed branch" });
    expect(edited.after.lat).toBe(6_927_100); expect(edited.after.lng).toBe(79_861_200);
    const cleared = await admin.updateBranch(branchId, { latE6: null, lngE6: null });
    expect(cleared.after.lat).toBeNull(); expect(cleared.after.lng).toBeNull();
  });
  test("nearest-branch routing ignores unknown coordinates", async () => {
    expect(await identity.nearestBranch(6_900_000, 79_900_000)).toBeNull();
    const row = await identity.createBranch({ code: "H01", name: "Known GPS hub", address: "Other Street, Colombo", type: "hub", latE6: 6_927_100, lngE6: 79_861_200 });
    geocodedId = row!.id;
    expect((await identity.nearestBranch(6_900_000, 79_900_000))!.branch.id).toBe(geocodedId);
  });
  test("deactivation hides new-work options but preserves history and identifiers", async () => {
    await admin.changeBranchStatus(branchId, "inactive");
    expect((await identity.listBranches()).some(b => b.id === branchId)).toBe(false);
    expect((await identity.listBranches({ includeInactive: true })).some(b => b.id === branchId)).toBe(true);
    expect((await identity.getBranch(branchId))!.name).toBe("Renamed branch");
    await expect(identity.requireActiveBranch(branchId)).rejects.toThrow("inactive");
  });
  test("new bags and trips reject inactive branches without deleting historical branch data", async () => {
    await expect(transport.createBag({ originHubId: branchId, destHubId: geocodedId }, actor)).rejects.toThrow("inactive");
    await expect(transport.createTrip({ originHubId: branchId, destHubId: geocodedId, vehicleRegistration: "TEST-001" }, actor)).rejects.toThrow("inactive");
    expect(Number((await setup.execute("SELECT count(*) AS n FROM identity_branch")).rows[0].n)).toBe(3);
  });
  test("pickup, direct merchant creation and new runsheets cannot bypass inactive branch restrictions", async () => {
    await setup.execute({ sql: "INSERT INTO merchants_merchant(id,branch_id,name,status) VALUES(?,?,?,?)", args: ["inactive-merchant", branchId, "Inactive branch merchant", "active"] });
    await setup.execute({ sql: "INSERT INTO identity_user(id,branch_id,role,roles,name,phone,status,created_at) VALUES(?,?,?, ?,?,?,?,?)", args: ["inactive-rider", branchId, "rider", '["rider"]', "Test rider", "+94770000009", "active", Date.now()] });
    await expect(pickups.requestPickup({ merchantId: "inactive-merchant", pickupDate: "2026-11-06", window: "morning", awbs: ["NX8000000000"] }, actor)).rejects.toThrow("inactive");
    await expect(merchants.createMerchant({ branchId, name: "New merchant", address: "Test address", contactName: "Contact", contactPhone: "+94770000001", codEnabled: true, podPolicy: "signature" }, actor)).rejects.toThrow("inactive");
    await expect(delivery.createRunsheet({ riderId: "inactive-rider", hubId: branchId }, actor)).rejects.toThrow("inactive");
    await expect(delivery.createRunsheet({ riderId: "inactive-rider", hubId: geocodedId }, actor)).rejects.toThrow("inactive");
  });
  test("inactive branch zones remain historical but cannot be created, reassigned or advertised as serviceable", async () => {
    const zoneInput = { name: "Test zone", branchId, minLat: 6, minLng: 79, maxLat: 7, maxLng: 80, serviceable: true };
    await expect(routing.createZone(zoneInput)).rejects.toThrow("inactive");
    await setup.execute({ sql: "INSERT INTO routing_zone(id,name,branch_id,min_lat_e6,min_lng_e6,max_lat_e6,max_lng_e6,serviceable,created_at) VALUES(?,?,?,?,?,?,?,?,?)", args: ["old-zone", "Historical zone", branchId, 6_000_000, 79_000_000, 7_000_000, 80_000_000, 1, Date.now()] });
    expect((await routing.checkServiceability({ lat: 6.5, lng: 79.5 })).serviceable).toBe(false);
    const activeZone = await routing.createZone({ ...zoneInput, branchId: geocodedId });
    await expect(routing.updateZone(activeZone.id, { branchId })).rejects.toThrow("inactive");
    expect((await routing.listZones(branchId)).length).toBe(1);
  });
  test("reactivation restores new-work selection and GPS routing excludes inactive hubs", async () => {
    await admin.changeBranchStatus(branchId, "active");
    expect((await identity.requireActiveBranch(branchId)).id).toBe(branchId);
    await admin.changeBranchStatus(geocodedId, "inactive");
    expect(await identity.nearestBranch(6_900_000, 79_900_000)).toBeNull();
  });
});
