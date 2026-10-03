import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { and, eq, like } from "drizzle-orm";
import type { AppRouterClient } from "../src/api";
import { finishMfa } from "./lib/mfa";

/**
 * Live probe of `parcels.bulkCreate` (§10 M3 "bulk upload") over HTTP against
 * the running dev server.
 *
 * Proves: a mixed good/bad file books the good rows and reports the bad ones
 * by CSV line without failing the batch; dryRun books nothing; exact integer
 * cents survive the round trip; Idempotency-Key replay returns the stored
 * report and books nothing twice; a reused key with a different file is 409;
 * §5 merchant pinning (403, never re-scoped); role and branch refusals; the
 * per-request row cap; one audit row per batch; and the merchant can then see
 * its new AWBs in its own shipments list and nobody else's.
 *
 * Run: bun --env-file=../../.env scripts/probe-bulk-booking.ts
 */

const BASE = process.env.SMOKE_BASE ?? "http://localhost:4200";
const { db } = await import("../src/api/database");
const { hardenScriptReads } = await import("./lib/db-retry");
hardenScriptReads(db);
const { rateLimit, auditLog } = await import("../src/api/database/schema/shared");
const { parcel, parcelEvent } = await import("../src/api/database/schema/parcels");
const { merchant } = await import("../src/api/database/schema/merchants");
await db.delete(rateLimit);

let keySeq = 0;
const key = (l: string) => `bulk-probe-${l}-${Date.now()}-${++keySeq}`;
function clientFor(token?: string, idemKey?: string): AppRouterClient {
  return createORPCClient(
    new RPCLink({
      url: `${BASE}/api/rpc`,
      headers: () => ({
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(idemKey ? { "idempotency-key": idemKey } : {}),
      }),
    }),
  );
}
const anon = clientFor();
let pass = 0;
const failures: string[] = [];
function check(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
async function expectFail(label: string, status: number, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(false, label, "expected a refusal, got success");
  } catch (err) {
    const e = err as { status?: number; data?: { status?: number; type?: string }; message?: string };
    const got = e.data?.status ?? e.status;
    check(got === status, label, `${got} ${e.data?.type ?? ""} ${e.message ?? ""}`.trim());
  }
}
async function login(phone: string) {
  await db.delete(rateLimit).where(like(rateLimit.bucket, "%identity.requestOtp"));
  const c = await anon.identity.requestOtp({ phone });
  if (!c.devCode) throw new Error(`no dev OTP for ${phone}`);
  return finishMfa(BASE, await anon.identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode, deviceId: null }));
}

const MERCHANT = "mch_ceylon_threads";
const OTHER_MERCHANT = "mch_lanka_gadgets";
const RUN = Date.now().toString(36).toUpperCase();
const marker = `Bulk ${RUN}`;
const booked = async () =>
  (await db.select().from(parcel).where(like(parcel.consigneeName, `${marker}%`))).length;

console.log(`\nBulk CSV booking probe → ${BASE}\n`);
const merchantUser = await login("+94775678901");
const admin = await login("+94773456789");
const cmbOps = await login("+94772345678");
const kdyOps = await login("+94779012345");
const rider = await login("+94771234567");
const transport = await login("+94776789012");
check(merchantUser.user.role === "merchant", "merchant signed in", `${merchantUser.user.name}`);

const [owner] = await db.select().from(merchant).where(eq(merchant.id, MERCHANT));

/** The rows a browser would send after parsing the CSV (rupees → cents already). */
const mixed = [
  { line: 2, orderRef: `${RUN}-A`, consigneeName: `${marker} Alpha`, consigneePhone: "077 123 4567", destAddress: "14 Galle Road, Colombo 03", weightGrams: 750, codAmountCents: 1_234_567, declaredValueCents: 2_000_000 },
  { line: 3, orderRef: `${RUN}-B`, consigneeName: `${marker} Bravo`, consigneePhone: "+94712223344", destAddress: "8 Temple Street, Kandy", weightGrams: 1200, codAmountCents: 0, lengthCm: 30, widthCm: 20, heightCm: 10 },
  { line: 4, orderRef: `${RUN}-C`, consigneeName: `${marker} Charlie`, consigneePhone: "12345", destAddress: "22 Main Street, Galle", weightGrams: 400 },
  { line: 5, orderRef: `${RUN}-D`, consigneeName: `${marker} Delta`, consigneePhone: "0771112222", destAddress: "3 Lake Drive, Kurunegala", weightGrams: 400, codAmountCents: 1250.5 },
  { line: 6, orderRef: `${RUN}-E`, consigneeName: `${marker} Echo`, consigneePhone: "0771112222", weightGrams: 0 },
  { line: 7, orderRef: `${RUN}-A`, consigneeName: `${marker} Foxtrot`, consigneePhone: "0771113333", destAddress: "9 Hill Street, Nuwara Eliya", weightGrams: 300 },
];

console.log("1. Dry run (the portal's preview step)");
const before = await booked();
const dry = await clientFor(merchantUser.accessToken, key("dry")).parcels.bulkCreate({
  merchantId: MERCHANT,
  dryRun: true,
  rows: mixed,
});
check(dry.dryRun && dry.total === 6, "dry run reports every row", `total=${dry.total}`);
check(dry.accepted.length === 2 && dry.rejected.length === 4, "2 rows would book, 4 are reported", `accepted=${dry.accepted.map((a) => a.line)} rejected=${dry.rejected.map((r) => r.line)}`);
check(dry.accepted.every((a) => a.awb === null), "a dry run mints no AWBs");
check((await booked()) === before, "a dry run books nothing", `${before} → ${await booked()}`);
const why = (line: number) => dry.rejected.find((r) => r.line === line)?.errors ?? [];
check(why(4).some((e) => e.field === "consigneePhone"), "line 4: bad phone is named", why(4).map((e) => e.message).join("; "));
check(why(5).some((e) => e.field === "codAmountCents" && /whole cents/.test(e.message)), "line 5: fractional cents refused, not rounded", why(5).map((e) => e.message).join("; "));
check(why(6).some((e) => e.field === "destAddress") && why(6).some((e) => e.field === "weightGrams"), "line 6: every problem on the row is listed", why(6).map((e) => `${e.field}`).join(", "));
check(why(7).some((e) => e.field === "orderRef" && /line 2/.test(e.message)), "line 7: duplicate order ref points at line 2", why(7).map((e) => e.message).join("; "));

console.log("\n2. Commit");
const commitKey = key("commit");
const report = await clientFor(merchantUser.accessToken, commitKey).parcels.bulkCreate({
  merchantId: MERCHANT,
  rows: mixed,
});
check(report.accepted.length === 2 && report.rejected.length === 4, "the same file books 2 and rejects 4 — one bad row never fails the batch");
check(report.accepted.every((a) => /^[A-Z0-9]{6,}$/.test(a.awb ?? "")), "each booked row comes back with its AWB", report.accepted.map((a) => `${a.line}:${a.awb}`).join(" "));
check((await booked()) === before + 2, "exactly two parcels exist", `${before} → ${await booked()}`);
check(report.codTotalCents === 1_234_567, "COD total is exact integer cents", `${report.codTotalCents}`);

const alphaAwb = report.accepted.find((a) => a.line === 2)!.awb!;
const [alpha] = await db.select().from(parcel).where(eq(parcel.awb, alphaAwb));
check(alpha?.codAmountCents === 1_234_567, "Rs 12,345.67 stored as 1234567 cents", `${alpha?.codAmountCents}`);
check(alpha?.status === "Booked", "booked rows enter at Booked (§6)", alpha?.status);
check(alpha?.consigneePhone === "+94771234567", "phone normalised to E.164", alpha?.consigneePhone);
check(alpha?.merchantId === MERCHANT && alpha?.branchId === owner!.branchId, "parcel belongs to the merchant and its branch", `${alpha?.merchantId} @ ${alpha?.branchId}`);
check(alpha?.originAddress === owner!.address, "origin is the merchant's pickup address", alpha?.originAddress);
const events = await db.select().from(parcelEvent).where(eq(parcelEvent.parcelId, alpha!.id));
check(events.length === 1 && events[0]!.fromStatus === null && events[0]!.toStatus === "Booked", "one genesis parcel_event, same as a hand booking", `${events.length} event(s), actor ${events[0]?.actorRole}`);
const [bravo] = await db.select().from(parcel).where(eq(parcel.awb, report.accepted.find((a) => a.line === 3)!.awb!));
check(bravo?.lengthCm === 30 && bravo?.widthCm === 20 && bravo?.heightCm === 10, "dimensions carried through", `${bravo?.lengthCm}x${bravo?.widthCm}x${bravo?.heightCm}`);

console.log("\n3. Idempotency (§4)");
const replay = await clientFor(merchantUser.accessToken, commitKey).parcels.bulkCreate({ merchantId: MERCHANT, rows: mixed });
check(JSON.stringify(replay) === JSON.stringify(report), "same key + same file replays the stored report", replay.accepted.map((a) => a.awb).join(" "));
check((await booked()) === before + 2, "the replay booked nothing", `${await booked()}`);
await expectFail("same key with a different file is 409", 409, () =>
  clientFor(merchantUser.accessToken, commitKey).parcels.bulkCreate({ merchantId: MERCHANT, rows: mixed.slice(0, 1) }),
);
await expectFail("no Idempotency-Key is refused", 400, () =>
  clientFor(merchantUser.accessToken).parcels.bulkCreate({ merchantId: MERCHANT, rows: mixed.slice(0, 1) }),
);
const audits = await db
  .select()
  .from(auditLog)
  .where(and(eq(auditLog.action, "parcel.bulk.booked"), eq(auditLog.actorId, merchantUser.user.id), like(auditLog.entityId, `bulk:${MERCHANT}:2/6`)));
check(audits.length >= 1, "the batch wrote an audit row", `${audits.length} row(s) for bulk:${MERCHANT}:2/6`);

console.log("\n4. Scope and roles (§5, §6)");
await expectFail("a merchant booking for another merchant is 403, never re-scoped", 403, () =>
  clientFor(merchantUser.accessToken, key("other")).parcels.bulkCreate({ merchantId: OTHER_MERCHANT, rows: mixed.slice(0, 1) }),
);
check((await booked()) === before + 2, "…and nothing was booked under either merchant");
await expectFail("a rider may not book", 403, () =>
  clientFor(rider.accessToken, key("rider")).parcels.bulkCreate({ merchantId: MERCHANT, rows: mixed.slice(0, 1) }),
);
await expectFail("transport may not book", 403, () =>
  clientFor(transport.accessToken, key("transport")).parcels.bulkCreate({ merchantId: MERCHANT, rows: mixed.slice(0, 1) }),
);
await expectFail("Kandy ops may not book for a Colombo merchant", 403, () =>
  clientFor(kdyOps.accessToken, key("kdy")).parcels.bulkCreate({ merchantId: MERCHANT, rows: mixed.slice(0, 1) }),
);
await expectFail("unknown merchant is 404", 404, () =>
  clientFor(admin.accessToken, key("unknown")).parcels.bulkCreate({ merchantId: "mch_nope", rows: mixed.slice(0, 1) }),
);
const opsBook = await clientFor(cmbOps.accessToken, key("cmb")).parcels.bulkCreate({
  merchantId: MERCHANT,
  rows: [{ ...mixed[1]!, line: 2, orderRef: `${RUN}-OPS`, consigneeName: `${marker} Ops` }],
});
check(opsBook.accepted.length === 1, "Colombo ops may book on the merchant's behalf", opsBook.accepted[0]?.awb ?? "");
await expectFail("single parcels.create also refuses a cross-merchant booking (403)", 403, () =>
  clientFor(merchantUser.accessToken, key("single")).parcels.create({
    merchantId: OTHER_MERCHANT,
    weightGrams: 500,
    originAddress: "x Street, Colombo",
    consigneeName: `${marker} Single`,
    consigneePhone: "+94771234567",
    destAddress: "1 Somewhere Road, Colombo",
  }),
);

console.log("\n5. Limits");
const tooMany = Array.from({ length: 101 }, (_, i) => ({ ...mixed[1]!, line: i + 2, orderRef: `${RUN}-L${i}` }));
await expectFail("101 rows in one request is 400 (client chunks at 100)", 400, () =>
  clientFor(merchantUser.accessToken, key("cap")).parcels.bulkCreate({ merchantId: MERCHANT, dryRun: true, rows: tooMany }),
);
await expectFail("an empty file is 400", 400, () =>
  clientFor(merchantUser.accessToken, key("empty")).parcels.bulkCreate({ merchantId: MERCHANT, rows: [] }),
);

console.log("\n6. The merchant sees its new shipments");
const mine = await clientFor(merchantUser.accessToken).parcels.list({ search: alphaAwb, page: 1, pageSize: 5 });
check(mine.rows.some((r) => r.awb === alphaAwb), "the AWB is in the merchant's own shipments list", alphaAwb);
const theirs = await clientFor((await login("+94773456789")).accessToken).parcels.list({ merchantId: OTHER_MERCHANT, search: alphaAwb, page: 1, pageSize: 5 });
check(theirs.rows.length === 0, "and is not under the other merchant", `${theirs.rows.length} row(s)`);

console.log(`\n${"─".repeat(60)}`);
if (failures.length) {
  console.log(`FAILED — ${failures.length} of ${pass + failures.length}:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`bulk booking probe: ${pass}/${pass} checks passed`);
process.exit(0);
