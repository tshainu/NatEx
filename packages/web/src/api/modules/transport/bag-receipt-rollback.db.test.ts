import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";

const databaseUrl = `file:${join(tmpdir(), `natex-bag-receipt-rollback-${process.pid}-${Date.now()}.db`)}`;
process.env.DATABASE_URL = databaseUrl;
delete process.env.DATABASE_AUTH_TOKEN;
process.env.NODE_ENV = "test";
process.env.SMS_DISABLE_ALL = "true";
delete process.env.SMS_EXECUTION_URL;

const { createClient } = await import("@libsql/client");
const setupClient = createClient({ url: databaseUrl });
const ddl = [
  `CREATE TABLE transport_bag (
    id TEXT PRIMARY KEY, code TEXT NOT NULL, seal_number TEXT, origin_hub_id TEXT NOT NULL,
    dest_hub_id TEXT NOT NULL, branch_id TEXT NOT NULL, status TEXT NOT NULL, trip_id TEXT,
    weight_grams INTEGER NOT NULL DEFAULT 0, item_count INTEGER NOT NULL DEFAULT 0,
    sealed_at INTEGER, sealed_by_name TEXT, received_at INTEGER, received_by_name TEXT,
    created_at INTEGER NOT NULL, created_by_name TEXT, photo_ref TEXT, photo_at INTEGER, photo_by_name TEXT
  )`,
  `CREATE TABLE transport_trip (
    id TEXT PRIMARY KEY, code TEXT NOT NULL, vehicle_registration TEXT NOT NULL,
    driver_id TEXT, driver_name TEXT, origin_hub_id TEXT NOT NULL, dest_hub_id TEXT NOT NULL,
    branch_id TEXT NOT NULL, route TEXT, status TEXT NOT NULL, seal TEXT, departed_at INTEGER,
    arrived_at INTEGER, created_at INTEGER NOT NULL, created_by_name TEXT, vehicle_type TEXT,
    bus_operator TEXT, contact_name TEXT, contact_phone TEXT, expected_arrival_at INTEGER, arrival_station TEXT
  )`,
  `CREATE TABLE transport_bag_item (
    id TEXT PRIMARY KEY, bag_id TEXT NOT NULL, parcel_id TEXT NOT NULL, awb TEXT NOT NULL,
    scanned_at INTEGER NOT NULL, scanned_by_id TEXT, scanned_by_name TEXT, device_id TEXT,
    removed_at INTEGER, removed_by_name TEXT
  )`,
  `CREATE TABLE transport_hub_scan (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, awb TEXT, parcel_id TEXT, bag_id TEXT, trip_id TEXT,
    branch_id TEXT NOT NULL, hub_id TEXT, outcome TEXT NOT NULL, reason TEXT, actor_id TEXT,
    actor_name TEXT, actor_role TEXT, device_id TEXT, lat_e6 INTEGER, lng_e6 INTEGER,
    client_id TEXT, ts INTEGER NOT NULL
  )`,
  `CREATE TABLE transport_exception (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, severity TEXT NOT NULL, branch_id TEXT NOT NULL,
    awb TEXT, parcel_id TEXT, bag_id TEXT, trip_id TEXT, detail TEXT NOT NULL, evidence_json TEXT,
    status TEXT NOT NULL, resolution TEXT, resolved_at INTEGER, resolved_by_name TEXT,
    raised_by_id TEXT, raised_by_name TEXT, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE parcels_parcel (
    id TEXT PRIMARY KEY, awb TEXT NOT NULL, merchant_id TEXT, branch_id TEXT NOT NULL, status TEXT NOT NULL,
    weight_grams INTEGER NOT NULL, length_cm INTEGER, width_cm INTEGER, height_cm INTEGER, description TEXT,
    declared_value_cents INTEGER, cod_amount_cents INTEGER NOT NULL DEFAULT 0, cod_locked_at INTEGER,
    origin_address TEXT NOT NULL, origin_lat_e6 INTEGER, origin_lng_e6 INTEGER,
    consignee_name TEXT NOT NULL, consignee_phone TEXT NOT NULL, dest_address TEXT NOT NULL,
    dest_lat_e6 INTEGER, dest_lng_e6 INTEGER, dest_zone_id TEXT,
    delivery_attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE parcels_parcel_event (
    id TEXT PRIMARY KEY, parcel_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
    actor_id TEXT, actor_name TEXT, actor_role TEXT, device_id TEXT, lat_e6 INTEGER, lng_e6 INTEGER,
    notes TEXT, client_id TEXT, ts INTEGER NOT NULL
  )`,
  `CREATE TABLE delivery_runsheet_item (
    id TEXT PRIMARY KEY, runsheet_id TEXT NOT NULL, parcel_id TEXT NOT NULL, awb TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending', attempt_no INTEGER NOT NULL DEFAULT 0,
    consignee_name TEXT NOT NULL, consignee_phone TEXT NOT NULL, dest_address TEXT NOT NULL,
    dest_lat_e6 INTEGER, dest_lng_e6 INTEGER, leg_metres INTEGER, cod_amount_cents INTEGER NOT NULL DEFAULT 0,
    freight_amount_cents INTEGER NOT NULL DEFAULT 0, freight_payer TEXT, settled_at INTEGER,
    client_id TEXT, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE delivery_attempt (
    id TEXT PRIMARY KEY, parcel_id TEXT NOT NULL, ts INTEGER NOT NULL
  )`,
  `CREATE TABLE delivery_pod (
    id TEXT PRIMARY KEY, parcel_id TEXT NOT NULL, ts INTEGER NOT NULL
  )`,
  `CREATE TABLE delivery_ndr (
    id TEXT PRIMARY KEY, parcel_id TEXT NOT NULL, raised_at INTEGER NOT NULL
  )`,
  `CREATE TABLE delivery_rto (
    id TEXT PRIMARY KEY, parcel_id TEXT NOT NULL, initiated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE shared_outbox (
    id TEXT PRIMARY KEY, topic TEXT NOT NULL, payload_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, available_at INTEGER NOT NULL, processed_at INTEGER, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE shared_audit_log (
    id TEXT PRIMARY KEY, entity TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL,
    actor_id TEXT, actor_role TEXT, branch_id TEXT, device_id TEXT, request_id TEXT,
    before_json TEXT, after_json TEXT, ts INTEGER NOT NULL
  )`,
];
for (const statement of ddl) await setupClient.execute(statement);

const { db } = await import("../../database");
const { bag, bagItem, custodyException, hubScan, trip } = await import("../../database/schema/transport");
const { parcel, parcelEvent } = await import("../../database/schema/parcels");
const { auditLog, outbox } = await import("../../database/schema/shared");
const transportService = await import("./service");
const { rollbackBagReceipt } = transportService;
const RUN = randomUUID().replace(/-/g, "").toUpperCase();
const ORIGIN = `origin_${RUN}`;
const DESTINATION = `destination_${RUN}`;
const actor = {
  userId: `admin_${RUN}`,
  name: "Rollback test admin",
  role: "admin" as const,
  roles: ["admin" as const],
  branchId: ORIGIN,
  merchantId: null,
  deviceId: null,
};

interface Fixture {
  bagId: string;
  bagCode: string;
  tripId: string;
  tripCode: string;
  parcelId: string;
  awb: string;
  receivedAt: Date;
}

async function addFixture(suffix: string): Promise<Fixture> {
  const bagId = `bag_${RUN}_${suffix}`;
  const bagCode = `BGROLL${RUN.slice(0, 6)}${suffix.toUpperCase()}`;
  const tripId = `trip_${RUN}_${suffix}`;
  const tripCode = `TRROLL${RUN.slice(0, 6)}${suffix.toUpperCase()}`;
  const parcelId = `parcel_${RUN}_${suffix}`;
  const awb = `NX${RUN.slice(0, 9)}${suffix.toUpperCase()}`;
  const now = new Date();
  const receivedAt = new Date(Math.floor((now.getTime() - 60_000) / 1_000) * 1_000);

  await db.insert(trip).values({
    id: tripId,
    code: tripCode,
    vehicleRegistration: "TEST-ROLLBACK",
    originHubId: ORIGIN,
    destHubId: DESTINATION,
    branchId: ORIGIN,
    status: "arrived",
    createdAt: receivedAt,
  });
  await db.insert(bag).values({
    id: bagId,
    code: bagCode,
    sealNumber: "1020",
    originHubId: ORIGIN,
    destHubId: DESTINATION,
    branchId: DESTINATION,
    status: "received",
    tripId,
    weightGrams: 500,
    itemCount: 1,
    receivedAt,
    receivedByName: "Destination receiver",
    createdAt: receivedAt,
  });
  await db.insert(bagItem).values({
    id: `item_${RUN}_${suffix}`,
    bagId,
    parcelId,
    awb,
    scannedAt: receivedAt,
  });
  await db.insert(parcel).values({
    id: parcelId,
    awb,
    branchId: DESTINATION,
    status: "AtDestHub",
    weightGrams: 500,
    originAddress: "Origin",
    consigneeName: "Test receiver",
    consigneePhone: "+94770000001",
    destAddress: "Destination",
    createdAt: receivedAt,
    updatedAt: receivedAt,
  });
  await db.insert(parcelEvent).values([
    {
      id: `move_${RUN}_${suffix}`,
      parcelId,
      fromStatus: "InTransit",
      toStatus: "InTransit",
      notes: `Scanned in at the destination hub out of bag ${bagCode}. Accountability moved from ${ORIGIN} to ${DESTINATION}.`,
      ts: receivedAt,
    },
    {
      id: `receive_${RUN}_${suffix}`,
      parcelId,
      fromStatus: "InTransit",
      toStatus: "AtDestHub",
      notes: `Received at destination hub out of bag ${bagCode}.`,
      ts: receivedAt,
    },
  ]);
  await db.insert(hubScan).values([
    {
      id: `scan_in_${RUN}_${suffix}`,
      kind: "parcel_in",
      awb,
      parcelId,
      bagId,
      tripId,
      branchId: DESTINATION,
      hubId: DESTINATION,
      outcome: "accepted",
      ts: receivedAt,
    },
    {
      id: `scan_receive_${RUN}_${suffix}`,
      kind: "bag_receive",
      bagId,
      tripId,
      branchId: DESTINATION,
      hubId: DESTINATION,
      outcome: "accepted",
      ts: receivedAt,
    },
  ]);
  return { bagId, bagCode, tripId, tripCode, parcelId, awb, receivedAt };
}

function rollbackInput(fixture: Fixture) {
  return {
    bagId: fixture.bagId,
    expectedBagCode: fixture.bagCode,
    expectedTripCode: fixture.tripCode,
    expectedOriginHubId: ORIGIN,
    expectedDestHubId: DESTINATION,
    expectedSealNumber: "1020",
    expectedAwbs: [fixture.awb],
    reason: "Correct mistaken destination receipt for inbound recovery testing.",
  };
}

async function expectNoMutation(fixture: Fixture) {
  const [currentBag] = await db.select().from(bag).where(eq(bag.id, fixture.bagId));
  const [currentParcel] = await db
    .select({ status: parcel.status, branchId: parcel.branchId })
    .from(parcel)
    .where(eq(parcel.id, fixture.parcelId));
  const events = await db.select().from(parcelEvent).where(eq(parcelEvent.parcelId, fixture.parcelId));
  expect(currentBag?.status).toBe("received");
  expect(currentBag?.branchId).toBe(DESTINATION);
  expect(currentParcel).toEqual({ status: "AtDestHub", branchId: DESTINATION });
  expect(events).toHaveLength(2);
  const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, fixture.bagId));
  const jobs = (await db.select().from(outbox)).filter((job) => job.payloadJson.includes(fixture.awb));
  expect(audits).toHaveLength(0);
  expect(jobs).toHaveLength(0);
}

afterAll(async () => {
  await setupClient.close();
});

describe("audited inbound bag receipt rollback", () => {
  test("reverses only the verified parcel and bag state while preserving trip and receipt evidence", async () => {
    const fixture = await addFixture("success");
    const result = await rollbackBagReceipt(rollbackInput(fixture), actor, `req_${RUN}_success`);

    expect(result.bag.status).toBe("in_transit");
    expect(result.bag.branchId).toBe(ORIGIN);
    expect(result.bag.receivedAt).toEqual(fixture.receivedAt);
    expect(result.bag.receivedByName).toBe("Destination receiver");
    expect(result.trip).toMatchObject({ id: fixture.tripId, code: fixture.tripCode, status: "arrived" });
    expect(result.reversedParcels).toEqual([
      { parcelId: fixture.parcelId, awb: fixture.awb, status: "InTransit", branchId: ORIGIN },
    ]);

    const [currentParcel] = await db
      .select({ status: parcel.status, branchId: parcel.branchId })
      .from(parcel)
      .where(eq(parcel.id, fixture.parcelId));
    const [currentTrip] = await db.select({ status: trip.status }).from(trip).where(eq(trip.id, fixture.tripId));
    const events = await db.select().from(parcelEvent).where(eq(parcelEvent.parcelId, fixture.parcelId));
    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, fixture.bagId));
    const jobs = await db.select().from(outbox);

    expect(currentParcel).toEqual({ status: "InTransit", branchId: ORIGIN });
    expect(currentTrip?.status).toBe("arrived");
    expect(events).toHaveLength(3);
    expect(events.some((event) => event.notes?.includes("Received at destination hub"))).toBe(true);
    expect(events.some((event) => event.notes?.includes("Audited rollback of bag"))).toBe(true);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "bag.receipt_rolled_back", requestId: `req_${RUN}_success` });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.topic).toBe("parcel.status_changed");
    expect(JSON.parse(jobs[0]!.payloadJson)).toMatchObject({
      awb: fixture.awb,
      from: "AtDestHub",
      to: "InTransit",
      reason: "bag.receipt_rolled_back",
    });

    await expect(rollbackBagReceipt(rollbackInput(fixture), actor, `req_${RUN}_replay`)).rejects.toThrow(
      "The bag no longer matches the verified received-state snapshot; nothing was changed.",
    );
  });

  test("refuses an active runsheet stop even when its timestamp predates the bag receipt snapshot", async () => {
    const fixture = await addFixture("assigned");
    await db.insert((await import("../../database/schema/delivery")).runsheetItem).values({
      id: `stop_${RUN}_assigned`,
      runsheetId: `run_${RUN}_assigned`,
      parcelId: fixture.parcelId,
      awb: fixture.awb,
      consigneeName: "Test receiver",
      consigneePhone: "+94770000001",
      destAddress: "Destination",
      createdAt: new Date(fixture.receivedAt.getTime() - 5_000),
    });

    await expect(rollbackBagReceipt(rollbackInput(fixture), actor, `req_${RUN}_assigned`)).rejects.toThrow(
      "A manifest parcel has an active runsheet stop or later delivery activity; nothing was changed.",
    );
    await expectNoMutation(fixture);
  });

  test("refuses an unresolved exception linked only to the arrived trip", async () => {
    const fixture = await addFixture("tripexception");
    await db.insert(custodyException).values({
      id: `exception_${RUN}_trip_only`,
      kind: "count_variance",
      severity: "high",
      branchId: ORIGIN,
      tripId: fixture.tripId,
      detail: "Trip-level count variance without bag or parcel linkage.",
      status: "open",
    });

    await expect(
      rollbackBagReceipt(rollbackInput(fixture), actor, `req_${RUN}_trip_exception`),
    ).rejects.toThrow("Resolve the bag's open custody exceptions before reversing receipt.");
    await expectNoMutation(fixture);
  });

  test("rolls back bag, parcel, outbox, and audit together if the audit write fails", async () => {
    const fixture = await addFixture("auditfail");
    await setupClient.execute(`
      CREATE TRIGGER reject_rollback_audit
      BEFORE INSERT ON shared_audit_log
      WHEN NEW.action = 'bag.receipt_rolled_back'
      BEGIN SELECT RAISE(ABORT, 'forced rollback audit failure'); END
    `);

    await expect(
      rollbackBagReceipt(rollbackInput(fixture), actor, `req_${RUN}_auditfail`),
    ).rejects.toThrow();
    await expectNoMutation(fixture);
    await setupClient.execute("DROP TRIGGER reject_rollback_audit");
  });
});
