/**
 * Round 6 linehaul fields and the optional bag photo — live probe.
 *
 * Nothing mocked: real API, real database, real bucket, real Expo app.
 *
 *   A. Trip fields (transport.tripCreate)
 *      - a bus without its operator, an operator on a van, a bad contact phone
 *        and an arrival in the past are each refused with 400 + the field
 *      - a complete bus trip is stored and read back exactly; the phone is
 *        normalised to +94…
 *      - an old client sending none of the new fields still works
 *   B. Bag photo (transport.bagPhoto*)
 *      - upload slot keyed under the bag's code; the JPEG PUTs to the bucket
 *      - a pasted URL and another bag's upload are refused on attach
 *      - merchant and rider are refused the upload (403); a merchant is
 *        refused the view (403); a bag with no photo is 404 on view
 *      - attach stores the REF and who took it; view returns a link whose
 *        bytes are the bytes uploaded
 *   C. Transport app on :4300 — the Bus path of "New trip" asks for the
 *      operator and the arrival stop, and a bag takes a photo through the real
 *      expo-image-picker web input.
 *
 * Every trip and bag it creates is removed at the end (they hold no parcels).
 *
 *   bun --env-file=../../.env scripts/probe-trip-bag.ts
 */

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { inArray, like, or } from "drizzle-orm";
import type { AppRouterClient } from "../src/api";
import { finishMfa } from "./lib/mfa";

const API = process.env.UI_RIDER_API ?? "http://localhost:4200";
const APP = process.env.UI_RIDER_APP ?? "http://localhost:4300";
const KDY_HUB = "brn_kdy_hub";
const JPEG = "/tmp/trip-bag-probe.jpg";
const RUN = Date.now().toString(36).toUpperCase();

const { db } = await import("../src/api/database");
const { hardenScriptReads, cleanupWithRetry } = await import("./lib/db-retry");
hardenScriptReads(db);
const { rateLimit } = await import("../src/api/database/schema/shared");
const transportTables = await import("../src/api/database/schema/transport");

let pass = 0;
const failures: string[] = [];
function check(cond: boolean, label: string, detail = ""): void {
  if (cond) pass += 1;
  else failures.push(`${label}${detail ? `: ${detail}` : ""}`);
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
async function expectFail(label: string, status: number, fn: () => Promise<unknown>, field?: string) {
  try {
    await fn();
    check(false, label, "expected a rejection, got success");
  } catch (err) {
    const data = (err as { data?: { status?: number; field?: string } })?.data;
    const ok = data?.status === status && (!field || data?.field === field);
    check(ok, label, `status ${data?.status}${data?.field ? `, field ${data.field}` : ""}`);
  }
}

let keySeq = 0;
function clientFor(token?: string): AppRouterClient {
  return createORPCClient(
    new RPCLink({
      url: `${API}/api/rpc`,
      headers: () => ({
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "idempotency-key": `trip-bag-${RUN}-${++keySeq}`,
      }),
    }),
  );
}
const anon = clientFor();
async function login(phone: string) {
  await db.delete(rateLimit).where(like(rateLimit.bucket, "%identity.%Otp"));
  await db.delete(rateLimit).where(like(rateLimit.bucket, "%mfa.%"));
  const c = await anon.identity.requestOtp({ phone });
  if (!c.devCode) throw new Error(`no dev OTP for ${phone}`);
  return finishMfa(API, await anon.identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode, deviceId: null }));
}

const created = { trips: [] as string[], bags: [] as string[] };
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);

execFileSync("convert", ["-size", "640x480", "gradient:#0f172a-#10b981", "-quality", "85", JPEG]);
const bytes = readFileSync(JPEG);

console.log(`\nNatEx Round 6 trip fields + bag photo probe (${RUN}) → ${API}\n`);
const tSession = await login("+94776789012");
const transport = clientFor(tSession.accessToken);
const merchant = clientFor((await login("+94775678901")).accessToken);
const rider = clientFor((await login("+94771234567")).accessToken);
const ops = clientFor((await login("+94772345678")).accessToken);

try {
  // ── A. Trip fields ────────────────────────────────────────────────────────
  console.log("A. Trip fields");
  const base = { vehicleRegistration: `PRB-${RUN.slice(-4)}`, destHubId: KDY_HUB };
  const busFull = {
    ...base,
    vehicleType: "bus" as const,
    busOperator: "ctb" as const,
    contactName: "Kumaran (conductor)",
    contactPhone: "077 123 4567",
    expectedArrivalAt: inHours(4),
    arrivalStation: "Kandy Goods Shed bus stand",
  };
  await expectFail("a bus without its operator is refused", 400, () => transport.transport.tripCreate({ ...busFull, busOperator: null }), "busOperator");
  await expectFail("an operator on a van is refused", 400, () => transport.transport.tripCreate({ ...busFull, vehicleType: "van" }), "busOperator");
  await expectFail("a non-Sri-Lankan contact phone is refused", 400, () => transport.transport.tripCreate({ ...busFull, contactPhone: "+4420 7946 0000" }), "contactPhone");
  await expectFail("an arrival an hour ago is refused", 400, () => transport.transport.tripCreate({ ...busFull, expectedArrivalAt: inHours(-1) }), "expectedArrivalAt");
  await expectFail("an unknown vehicle type is refused", 400, () => transport.transport.tripCreate({ ...busFull, vehicleType: "boat" as never }));
  await expectFail("a merchant cannot create a trip (403)", 403, () => merchant.transport.tripCreate(busFull));

  const trip = await transport.transport.tripCreate(busFull);
  created.trips.push(trip.id);
  const got = (await ops.transport.tripGet({ tripId: trip.id })).trip;
  check(got.vehicleType === "bus" && got.busOperator === "ctb", "bus + CTB stored", `${got.vehicleType} / ${got.busOperator}`);
  check(got.contactName === "Kumaran (conductor)" && got.contactPhone === "+94771234567", "contact stored, phone normalised to +94", `${got.contactName}, ${got.contactPhone}`);
  check(
    got.expectedArrivalAt !== null && Math.abs(new Date(got.expectedArrivalAt).getTime() - busFull.expectedArrivalAt.getTime()) < 1000,
    "expected arrival stored to the second",
    String(got.expectedArrivalAt),
  );
  check(got.arrivalStation === "Kandy Goods Shed bus stand", "arrival stop stored", String(got.arrivalStation));

  const lorry = await transport.transport.tripCreate({ ...base, vehicleType: "lorry", contactName: "Driver Selvam", contactPhone: "0712345678", expectedArrivalAt: inHours(6) });
  created.trips.push(lorry.id);
  check(lorry.vehicleType === "lorry" && lorry.busOperator === null && lorry.arrivalStation === null, "a lorry trip needs no operator or stop");
  const legacy = await transport.transport.tripCreate(base);
  created.trips.push(legacy.id);
  check(legacy.vehicleType === null && legacy.contactPhone === null, "an older client sending none of the new fields still works");

  // ── B. Bag photo ──────────────────────────────────────────────────────────
  console.log("\nB. Bag photo");
  const bagA = await transport.transport.bagCreate({ destHubId: KDY_HUB });
  const bagB = await transport.transport.bagCreate({ destHubId: KDY_HUB });
  created.bags.push(bagA.id, bagB.id);

  await expectFail("a bag with no photo is 404 on view", 404, () => ops.transport.bagPhotoView({ bagId: bagA.id }));
  await expectFail("a merchant cannot get an upload slot (403)", 403, () => merchant.transport.bagPhotoUpload({ bagId: bagA.id, contentType: "image/jpeg" }));
  await expectFail("a rider cannot get an upload slot (403)", 403, () => rider.transport.bagPhotoUpload({ bagId: bagA.id, contentType: "image/jpeg" }));
  await expectFail("a non-image type is refused (400)", 400, () => transport.transport.bagPhotoUpload({ bagId: bagA.id, contentType: "application/pdf" as never }));

  const slot = await transport.transport.bagPhotoUpload({ bagId: bagA.id, contentType: "image/jpeg" });
  check(slot.storageRef.startsWith(`s3:bag/${bagA.code}/`) && slot.storageRef.endsWith(".jpg"), "slot is keyed under the bag's code", slot.storageRef);
  const put = await fetch(slot.uploadUrl, { method: "PUT", body: bytes, headers: { "content-type": "image/jpeg" } });
  check(put.ok, "JPEG PUT straight to the bucket", `${put.status}`);

  await expectFail("attach refuses a pasted URL", 400, () => transport.transport.bagPhotoAttach({ bagId: bagA.id, storageRef: "https://example.com/x.jpg" }), "storageRef");
  const slotB = await transport.transport.bagPhotoUpload({ bagId: bagB.id, contentType: "image/jpeg" });
  await expectFail("attach refuses another bag's upload", 400, () => transport.transport.bagPhotoAttach({ bagId: bagA.id, storageRef: slotB.storageRef }), "storageRef");
  await expectFail("a merchant cannot attach (403)", 403, () => merchant.transport.bagPhotoAttach({ bagId: bagA.id, storageRef: slot.storageRef }));

  const attached = await transport.transport.bagPhotoAttach({ bagId: bagA.id, storageRef: slot.storageRef });
  check(attached.photoRef === slot.storageRef, "the bag stores the object ref, not a link", String(attached.photoRef));
  check(attached.photoByName === tSession.user.name && attached.photoAt !== null, "who took it and when are recorded", `${attached.photoByName}`);

  const view = await ops.transport.bagPhotoView({ bagId: bagA.id });
  const fetched = Buffer.from(await (await fetch(view.url)).arrayBuffer());
  check(fetched.equals(bytes), "the view link returns exactly the uploaded bytes", `${fetched.length} bytes`);
  check(view.expiresInSeconds === 300, "the view link is short-lived (5 min)", `${view.expiresInSeconds}s`);
  await expectFail("a merchant cannot view a bag photo (403)", 403, () => merchant.transport.bagPhotoView({ bagId: bagA.id }));
  const detail = await ops.transport.bagGet({ bagId: bagA.id });
  check(detail.bag.photoRef === slot.storageRef, "bagGet carries the photo for the web drawer");

  // ── C. Transport app ──────────────────────────────────────────────────────
  console.log("\nC. Transport app on :4300");
  const browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({ viewport: { width: 400, height: 860 } });
  await context.addInitScript(
    (s: string) => {
      if (!localStorage.getItem("natex.session")) localStorage.setItem("natex.session", s);
    },
    JSON.stringify({
      accessToken: tSession.accessToken,
      refreshToken: tSession.refreshToken,
      expiresAt: Date.now() + tSession.expiresIn * 1000,
      user: tSession.user,
    }),
  );
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon|DevTools|onedollarstats/i.test(m.text())) consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  const visible = async (text: string | RegExp, timeout = 15_000) => {
    try {
      await page.getByText(text).first().waitFor({ state: "visible", timeout });
      return true;
    } catch {
      return false;
    }
  };

  await page.goto(`${APP}/trips`);
  check(await visible("Linehaul", 30_000), "the linehaul tab opens");
  await page.getByRole("button", { name: "New trip" }).click();
  await page.getByLabel("Vehicle Bus").click();
  check(await visible("CTB"), "choosing Bus asks for the operator");
  check(await visible("Bus arrival station / stop"), "choosing Bus asks for the arrival stop");
  const createBtn = page.getByRole("button", { name: "Create trip" });
  check(await createBtn.isDisabled(), "Create trip is locked until the form is complete");
  await page.getByLabel("Operator AC bus").click();
  await page.getByLabel("Vehicle number").fill(`PRB-UI${RUN.slice(-3)}`);
  await page.getByLabel("Contact person").fill("Conductor Ravi");
  await page.getByLabel("Contact phone").fill("0779012345");
  const hhmm = new Date(Date.now() + 19_800_000 + 3 * 3_600_000).toISOString().slice(11, 16);
  await page.getByLabel("Arrival time (HH:MM)").fill(hhmm);
  await page.getByLabel("Bus arrival station / stop").fill("Kandy Clock Tower stand");
  await page.getByLabel(/^Destination Kandy/).click();
  await page.screenshot({ path: "/tmp/m-trip-form.png", fullPage: true });
  check(!(await createBtn.isDisabled()), "Create trip unlocks once every field is filled");
  await createBtn.click();
  await page.waitForURL(/\/trip\//, { timeout: 20_000 });
  const uiTripId = page.url().split("/trip/")[1]!.split(/[?#]/)[0]!;
  created.trips.push(uiTripId);
  const uiTrip = (await ops.transport.tripGet({ tripId: uiTripId })).trip;
  check(
    uiTrip.vehicleType === "bus" && uiTrip.busOperator === "ac_bus" && uiTrip.arrivalStation === "Kandy Clock Tower stand" && uiTrip.contactPhone === "+94779012345",
    "server: the app's bus trip has operator, stop and contact",
    `${uiTrip.vehicleType}/${uiTrip.busOperator}, ${uiTrip.arrivalStation}, ${uiTrip.contactPhone}`,
  );
  const due = uiTrip.expectedArrivalAt ? new Date(uiTrip.expectedArrivalAt) : null;
  check(
    due !== null && new Date(due.getTime() + 19_800_000).toISOString().slice(11, 16) === hhmm && due.getTime() > Date.now(),
    "server: arrival is the next HH:MM in Colombo",
    due?.toISOString() ?? "none",
  );
  await page.screenshot({ path: "/tmp/m-trip-detail.png", fullPage: true });

  await page.goto(`${APP}/bag/${bagB.id}`);
  check(await visible(bagB.code, 30_000), "the bag opens in the app");
  const chooser = page.waitForEvent("filechooser", { timeout: 15_000 });
  await page.getByRole("button", { name: "Add bag photo (optional)" }).click();
  (await chooser).setFiles(JPEG);
  check(await visible("Replace bag photo", 30_000), "the photo saves and the button becomes Replace");
  const loaded = await page
    .waitForFunction(
      (label: string) => {
        const img = document.querySelector(`[aria-label="${label}"] img`) as HTMLImageElement | null;
        return Boolean(img?.complete && img.naturalWidth > 0) && img!.naturalWidth;
      },
      `Photo of bag ${bagB.code}`,
      { timeout: 15_000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => 0);
  check(Number(loaded) === 640, "the photo actually loads on the bag screen (decoded, 640 px wide)", String(loaded));
  await page.screenshot({ path: "/tmp/m-bag-photo.png", fullPage: true });
  const bAfter = (await ops.transport.bagGet({ bagId: bagB.id })).bag;
  check(!!bAfter.photoRef?.startsWith(`s3:bag/${bagB.code}/`), "server: the app's photo is attached to the bag", String(bAfter.photoRef));
  check(consoleErrors.length === 0, "no console or page errors", consoleErrors.slice(0, 4).join(" | "));
  await browser.close();
} finally {
  await cleanupWithRetry(async () => {
    const { trip, bag, hubScan, custodyException } = transportTables;
    if (created.bags.length) {
      await db.delete(hubScan).where(inArray(hubScan.bagId, created.bags));
      await db.delete(custodyException).where(inArray(custodyException.bagId, created.bags));
      await db.delete(bag).where(inArray(bag.id, created.bags));
    }
    if (created.trips.length) {
      await db.delete(hubScan).where(inArray(hubScan.tripId, created.trips));
      await db.delete(custodyException).where(or(inArray(custodyException.tripId, created.trips)));
      await db.delete(trip).where(inArray(trip.id, created.trips));
    }
  });
  console.log(`\n  cleanup: removed ${created.trips.length} trips, ${created.bags.length} bags`);
}

console.log(
  failures.length === 0
    ? `\nALL GREEN — ${pass} trip/bag checks passed.\n`
    : `\n${failures.length} FAILED, ${pass} passed:\n  - ${failures.join("\n  - ")}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
