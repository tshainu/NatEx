/**
 * Delivery → COD ledger wiring — live probe (PROJECT.md §8 checkpoint 1, the
 * cash-ceiling control, §7 offline replay, and the finance config edit path).
 *
 * Nothing mocked: real API on :4200, real database.
 *
 *   1. a COD delivery posts exactly one COLLECT entry with the right legs,
 *      rider, branch and merchant, and to the cent
 *   2. a replay of the same delivery (same clientId) posts nothing more —
 *      both through delivery.recordDelivery and through sync.push
 *   3. a prepaid delivery posts nothing; a COD delivery with the cash missing
 *      is refused and posts nothing
 *   4. the rider's liability equals what they collected; dispatch is refused
 *      once finance lowers the ceiling under it, and the parcels stay put
 *   5. the rider hands the cash over (declare → verify → bank) and the same
 *      dispatch then goes out
 *   6. the config edit is finance-only, range-checked and reason-bearing
 *   7. the nightly invariant still balances the book
 *
 *   bun --env-file=../../.env scripts/probe-cod-wiring.ts
 */

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { and, eq, inArray, like } from "drizzle-orm";
import type { AppRouterClient } from "../src/api";
import { finishMfa } from "./lib/mfa";
import { CMB_BRANCH, KDY_HUB, railToKandyHub } from "./lib/rail";
import { bankRiderCash } from "./lib/cash";
import { retireRun } from "./lib/retire";

const API = process.env.PROBE_API ?? "http://localhost:4200";
const DEVICE = "cod-wiring-probe-device";
const MERCHANT = "mch_ceylon_threads"; // POD policy: signature

const { db } = await import("../src/api/database");
const { hardenScriptReads } = await import("./lib/db-retry");
hardenScriptReads(db);
const { rateLimit } = await import("../src/api/database/schema/shared");
const { codEntry } = await import("../src/api/database/schema/cod");
await db.delete(rateLimit);

const RUN = `CW${Date.now().toString(36).toUpperCase().slice(-5)}`;
let keySeq = 0;
const key = (l: string) => `cod-wiring-${RUN}-${l}-${++keySeq}`;
function clientFor(token?: string, idem?: string, device?: string): AppRouterClient {
  return createORPCClient(
    new RPCLink({
      url: `${API}/api/rpc`,
      headers: () => ({
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(idem ? { "idempotency-key": idem } : {}),
        ...(device ? { "x-device-id": device } : {}),
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
    failures.push(`${label}: ${detail || "assertion failed"}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
async function refusal(p: Promise<unknown>): Promise<{ status: number; type: string; detail: string }> {
  try {
    await p;
    return { status: 200, type: "", detail: "accepted" };
  } catch (e) {
    const err = e as { status?: number; data?: { detail?: string; type?: string }; message?: string };
    return {
      status: err.status ?? 0,
      type: (err.data?.type ?? "").split("/").pop() ?? "",
      detail: err.data?.detail ?? err.message ?? String(e),
    };
  }
}
async function login(phone: string, deviceId?: string) {
  await db.delete(rateLimit).where(like(rateLimit.bucket, "%identity.requestOtp"));
  const c = await anon.identity.requestOtp({ phone });
  if (!c.devCode) throw new Error(`no dev OTP for ${phone}`);
  return finishMfa(API, await anon.identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode, deviceId: deviceId ?? null }));
}
const collectsFor = (parcelIds: string[]) =>
  db
    .select()
    .from(codEntry)
    .where(and(inArray(codEntry.parcelId, parcelIds), eq(codEntry.type, "COLLECT")));

console.log(`\nNatEx delivery → COD ledger probe (${RUN}) → ${API}\n`);
console.log("0. Staging");
const admin = await login("+94773456789");
const transport = await login("+94777890123");
const ops = await login("+94779012345");
const finance = await login("+94774567890");
const rider = await login("+94778901234", DEVICE);
const riderApi = (l: string) => clientFor(rider.accessToken, key(l), DEVICE);

for (const r of await clientFor(transport.accessToken).delivery.runsheetList({
  riderId: rider.user.id,
  status: ["draft", "dispatched"],
})) {
  await retireRun(clientFor(ops.accessToken, key(`retire-${r.id}`)), r, `retired by COD wiring probe ${RUN}`);
}
const cleared = await bankRiderCash({
  clientFor,
  login: (p) => login(p),
  riderToken: rider.accessToken,
  branchId: KDY_HUB,
  key,
  label: `${RUN}-pre`,
});
const ceilingRow = (await clientFor(finance.accessToken).cod.listConfig({})).find(
  (r) => r.key === "rider_cash_ceiling_cents",
)!;
const originalCeiling = ceilingRow.value;
const start = await clientFor(finance.accessToken).cod.cashCeiling({ riderId: rider.user.id });
check(
  start.liabilityCents === 0,
  "rider starts the probe holding no cash",
  `banked ${cleared.depositedCents}c from ${cleared.entries} earlier collection(s); ceiling ${originalCeiling}c`,
);

const COD = { A: 125_050, B: 99_999, C: 300_000, D: 0, E: 45_000 } as const;
type Slot = keyof typeof COD;
const parcels: Record<Slot, { awb: string; id: string }> = {} as never;
for (const slot of Object.keys(COD) as Slot[]) {
  const created = await clientFor(admin.accessToken, key(`book-${slot}`)).parcels.create({
    merchantId: MERCHANT,
    branchId: CMB_BRANCH,
    weightGrams: 750,
    declaredValueCents: 200_000,
    codAmountCents: COD[slot],
    originAddress: "12 Galle Road, Colombo 03",
    consigneeName: `${RUN} ${slot}`,
    consigneePhone: "+94761112233",
    destAddress: `${10 + slot.charCodeAt(0)} Peradeniya Road, Kandy`,
  });
  parcels[slot] = { awb: created.parcel.awb, id: created.parcel.id };
}
await railToKandyHub({
  clientFor,
  login: (p) => login(p),
  adminToken: admin.accessToken,
  awbs: Object.values(parcels).map((p) => p.awb),
  key,
  label: RUN,
});
const sheet = await clientFor(transport.accessToken, key("create")).delivery.runsheetCreate({ riderId: rider.user.id });
await clientFor(transport.accessToken, key("add")).delivery.runsheetAdd({
  runsheetId: sheet.id,
  awbs: (["A", "B", "C", "D"] as const).map((s) => parcels[s].awb),
});
const out = await clientFor(transport.accessToken, key("dispatch")).delivery.runsheetDispatch({ runsheetId: sheet.id });
check(out.movedOut.length === 4, "run 1 dispatched under the ceiling", `${sheet.code}: ${out.movedOut.join(", ")}`);

// ── 1. one COLLECT, to the cent ─────────────────────────────────────────────
console.log("\n1. A COD delivery posts exactly one COLLECT");
const sig = "data:image/png;base64,iVBORw0KGgo=";
const clientA = `cw-${RUN}-A-01`;
const delA = await riderApi("deliver-A").delivery.recordDelivery({
  awb: parcels.A.awb,
  receivedByName: "Kamala Wijesinghe",
  method: "signature",
  signatureData: sig,
  codCollectedCents: COD.A,
  clientId: clientA,
});
check(delA.parcel.status === "Delivered" && !delA.deduped, "parcel A delivered", delA.parcel.awb);
let rowsA = await collectsFor([parcels.A.id]);
const eA = rowsA[0];
check(rowsA.length === 1, "exactly one COLLECT entry for A", `${rowsA.length} row(s)`);
check(eA?.amountCents === COD.A, "entry amount equals the COD to the cent", `${eA?.amountCents}c`);
check(
  eA?.debitAccount === "rider_cash" && eA?.creditAccount === "consignee_due",
  "legs: Dr rider_cash / Cr consignee_due",
  `${eA?.debitAccount} / ${eA?.creditAccount}`,
);
check(
  eA?.riderId === rider.user.id && eA?.branchId === KDY_HUB && eA?.merchantId === MERCHANT && eA?.awb === parcels.A.awb,
  "entry names the rider, the delivering hub, the merchant and the AWB",
  `${eA?.riderId} · ${eA?.branchId} · ${eA?.merchantId}`,
);
check(delA.codEntryId === eA?.id, "the delivery response carries the ledger entry id", String(delA.codEntryId));
check(eA?.clientId === `dlv:${clientA}`, "entry carries the device's id, namespaced", String(eA?.clientId));
check(
  delA.cashCeiling?.liabilityCents === COD.A && delA.cashCeiling.blocked === false,
  "the response tells the rider where they stand against the ceiling",
  JSON.stringify(delA.cashCeiling),
);

// ── 2. replays post nothing ────────────────────────────────────────────────
console.log("\n2. Replays never post a second COLLECT");
const replayA = await riderApi("deliver-A-replay").delivery.recordDelivery({
  awb: parcels.A.awb,
  receivedByName: "Kamala Wijesinghe",
  method: "signature",
  signatureData: sig,
  codCollectedCents: COD.A,
  clientId: clientA,
});
rowsA = await collectsFor([parcels.A.id]);
check(replayA.deduped && rowsA.length === 1, "same clientId, fresh Idempotency-Key → deduped, still one entry", `${rowsA.length}`);
const second = await refusal(
  riderApi("deliver-A-again").delivery.recordDelivery({
    awb: parcels.A.awb,
    receivedByName: "Someone Else",
    method: "signature",
    signatureData: sig,
    codCollectedCents: COD.A,
    clientId: `cw-${RUN}-A-02`,
  }),
);
rowsA = await collectsFor([parcels.A.id]);
check(
  second.status === 409 && rowsA.length === 1,
  "a second delivery from another device is refused; the ledger is unchanged",
  `${second.status} ${second.detail}`,
);

const opB = `cw-${RUN}-B-op1`;
const pushB = () =>
  clientFor(rider.accessToken, key("push-B"), DEVICE).sync.push({
    deviceId: DEVICE,
    operations: [
      {
        clientOpId: opB,
        kind: "delivery.deliver",
        seq: 1,
        clientTs: Date.now(),
        payload: {
          awb: parcels.B.awb,
          receivedByName: "Ruwan Perera",
          method: "signature",
          signatureData: sig,
          codCollectedCents: COD.B,
        },
      },
    ],
  });
const p1 = await pushB();
const p2 = await pushB();
const rowsB = await collectsFor([parcels.B.id]);
check(p1.applied === 1, "offline delivery of B applied through sync.push", p1.verdicts[0]?.state ?? "");
check(p2.duplicates === 1, "the same operation pushed again is a duplicate", p2.verdicts[0]?.state ?? "");
check(
  rowsB.length === 1 && rowsB[0]!.amountCents === COD.B && rowsB[0]!.clientId === `dlv:${opB}`,
  "B: exactly one COLLECT, to the cent, keyed to the device's operation",
  `${rowsB.length} row(s), ${rowsB[0]?.amountCents}c`,
);

// ── 3. prepaid and missing cash ────────────────────────────────────────────
console.log("\n3. Prepaid posts nothing; missing cash is refused");
const noCash = await refusal(
  riderApi("deliver-C-nocash").delivery.recordDelivery({
    awb: parcels.C.awb,
    receivedByName: "Sivakumar Rajan",
    method: "signature",
    signatureData: sig,
    codCollectedCents: 0,
  }),
);
check(
  noCash.status === 400 && (await collectsFor([parcels.C.id])).length === 0,
  "C delivered with no cash is refused, nothing posted",
  `${noCash.status} ${noCash.detail}`,
);
await riderApi("deliver-C").delivery.recordDelivery({
  awb: parcels.C.awb,
  receivedByName: "Sivakumar Rajan",
  method: "signature",
  signatureData: sig,
  codCollectedCents: COD.C,
});
const delD = await riderApi("deliver-D").delivery.recordDelivery({
  awb: parcels.D.awb,
  receivedByName: "Prepaid Person",
  method: "signature",
  signatureData: sig,
});
const rowsD = await db.select().from(codEntry).where(eq(codEntry.parcelId, parcels.D.id));
check(
  delD.parcel.status === "Delivered" && delD.codEntryId === null && rowsD.length === 0,
  "prepaid D delivered with no ledger entry at all",
  `${rowsD.length} row(s)`,
);

// ── 4. liability and the ceiling gate ──────────────────────────────────────
console.log("\n4. Liability and the dispatch gate");
const held = COD.A + COD.B + COD.C;
const now = await clientFor(finance.accessToken).cod.cashCeiling({ riderId: rider.user.id });
check(now.liabilityCents === held, "rider liability = Σ collected, to the cent", `${now.liabilityCents}c = ${held}c`);
const mine = await clientFor(rider.accessToken).cod.myUndeposited({});
check(
  mine.length === 3 && mine.reduce((s, e) => s + e.amountCents, 0) === held,
  "the rider's own undeposited list shows the three collections",
  mine.map((e) => e.awb).join(", "),
);
const closed1 = await clientFor(ops.accessToken, key("close-1")).delivery.runsheetClose({ runsheetId: sheet.id });
check(
  closed1.cash.collectedCents === held && closed1.cash.varianceCents === 0,
  "run 1 closes with cash collected = expected",
  `${closed1.cash.collectedCents}c, variance ${closed1.cash.varianceCents}`,
);

const byOps = await refusal(
  clientFor(ops.accessToken, key("cfg-ops")).cod.setConfig({
    key: "rider_cash_ceiling_cents",
    value: 1,
    reason: "ops trying to move a money rule",
  }),
);
check(byOps.status === 403, "ops cannot change a money rule (403)", byOps.detail);
const badBp = await refusal(
  clientFor(finance.accessToken, key("cfg-bad-bp")).cod.setConfig({ key: "vat_bp", value: 12_000, reason: "typo check" }),
);
check(badBp.status === 400, "basis points over 10,000 refused (400)", badBp.detail);
const badBool = await refusal(
  clientFor(finance.accessToken, key("cfg-bad-bool")).cod.setConfig({ key: "vat_active", value: 2, reason: "typo check" }),
);
check(badBool.status === 400, "a switch other than 0/1 refused (400)", badBool.detail);
const noReason = await refusal(
  clientFor(finance.accessToken, key("cfg-no-reason")).cod.setConfig({ key: "rider_cash_ceiling_cents", value: 1, reason: "x" }),
);
check(noReason.status === 400, "a change without a reason is refused (400)", noReason.detail);

const lowered = await clientFor(finance.accessToken, key("cfg-lower")).cod.setConfig({
  key: "rider_cash_ceiling_cents",
  value: held - 1,
  reason: `probe ${RUN}: one cent under the rider's cash`,
});
check(lowered.before === originalCeiling && lowered.after === held - 1, "finance lowers the ceiling", `${lowered.before} → ${lowered.after}`);
const gate = await clientFor(transport.accessToken).cod.cashCeiling({ riderId: rider.user.id });
check(gate.blocked && gate.headroomCents === -1, "the ceiling check now reports blocked", `headroom ${gate.headroomCents}c`);

const sheet2 = await clientFor(transport.accessToken, key("create-2")).delivery.runsheetCreate({ riderId: rider.user.id });
await clientFor(transport.accessToken, key("add-2")).delivery.runsheetAdd({ runsheetId: sheet2.id, awbs: [parcels.E.awb] });
const blocked = await refusal(
  clientFor(transport.accessToken, key("dispatch-2-blocked")).delivery.runsheetDispatch({ runsheetId: sheet2.id }),
);
check(
  blocked.status === 403 && blocked.type === "cash-ceiling-exceeded",
  "dispatch refused over the ceiling (403 cash-ceiling-exceeded)",
  blocked.detail,
);
const eStill = await clientFor(admin.accessToken).parcels.get({ awbOrId: parcels.E.awb });
const s2 = await clientFor(transport.accessToken).delivery.runsheetGet({ runsheetId: sheet2.id });
check(
  eStill.parcel.status === "AtDestHub" && s2.runsheet.status === "draft",
  "a refused dispatch moves nothing: E still AtDestHub, run still draft",
  `${eStill.parcel.status}, ${s2.runsheet.status}`,
);

// ── 5. hand the cash over, then dispatch ───────────────────────────────────
console.log("\n5. Cash handed over → dispatch allowed");
const handed = await bankRiderCash({
  clientFor,
  login: (p) => login(p),
  riderToken: rider.accessToken,
  branchId: KDY_HUB,
  key,
  label: `${RUN}-post`,
});
check(handed.depositedCents === held && handed.entries === 3, "declare → verify → bank the three collections", `${handed.depositedCents}c`);
const after = await clientFor(finance.accessToken).cod.cashCeiling({ riderId: rider.user.id });
check(after.liabilityCents === 0 && !after.blocked, "liability back to zero", `${after.liabilityCents}c`);
const deposits = await db.select().from(codEntry).where(
  and(inArray(codEntry.parcelId, [parcels.A.id, parcels.B.id, parcels.C.id]), eq(codEntry.type, "DEPOSIT")),
);
check(
  deposits.length === 3 && deposits.reduce((s, e) => s + e.amountCents, 0) === held,
  "one DEPOSIT per collection, summing to the cash collected",
  `${deposits.length} row(s)`,
);
const out2 = await clientFor(transport.accessToken, key("dispatch-2")).delivery.runsheetDispatch({ runsheetId: sheet2.id });
check(out2.movedOut.length === 1, "the same run now dispatches", out2.movedOut.join(", "));

const restored = await clientFor(finance.accessToken, key("cfg-restore")).cod.setConfig({
  key: "rider_cash_ceiling_cents",
  value: originalCeiling,
  reason: `probe ${RUN}: restore the ceiling`,
});
check(restored.after === originalCeiling, "ceiling restored", `${restored.after}c`);
await clientFor(ops.accessToken, key("close-2")).delivery.runsheetClose({
  runsheetId: sheet2.id,
  force: true,
  notes: `COD wiring probe ${RUN}: E written off`,
});

// ── 7. the book still balances ─────────────────────────────────────────────
console.log("\n7. Nightly invariant");
const inv = await clientFor(finance.accessToken, key("invariant")).cod.runInvariant({});
const riderBreach = inv.breaches.filter((b) => b.riderId === rider.user.id);
check(inv.ledgerSumCents === 0, "the whole ledger sums to zero", `${inv.ledgerSumCents}c`);
check(riderBreach.length === 0, "no breach for this rider", `${inv.result}, ${inv.breaches.length} breach(es) network-wide`);

console.log(`\n${"─".repeat(60)}`);
if (failures.length) {
  console.log(`COD wiring probe: ${failures.length} FAILED, ${pass} passed`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`COD wiring probe: ${pass}/${pass} checks passed`);
process.exit(0);
