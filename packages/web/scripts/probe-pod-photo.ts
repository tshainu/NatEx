/**
 * Photo POD — live end-to-end probe (PROJECT.md §6 "Delivered requires POD:
 * signature or OTP or photo, configurable per merchant", §7 offline sync).
 *
 * Nothing mocked: real bucket, real API, real database, real Expo app.
 *
 *   A. API half
 *      - a rider gets a presigned upload slot keyed under the parcel's AWB
 *      - the JPEG PUTs straight to the bucket; HEAD proves it landed, with the
 *        right type and size
 *      - a merchant principal is refused (403); a non-image type is refused
 *      - photo POD is refused without a photo, with a pasted URL, and with a
 *        photo uploaded for a DIFFERENT parcel
 *      - the delivery syncs via sync.push with the storage ref, the parcel is
 *        Delivered and the POD row holds the ref (not an expiring URL)
 *   B. UI half — the rider app on :4300 picks a file through the real
 *      expo-image-picker web input, uploads it, and delivers; the server holds
 *      a photo POD whose object exists in the bucket.
 *
 *   bun --env-file=../../.env scripts/probe-pod-photo.ts
 */

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { chromium } from "playwright-core";
import { desc, eq, like } from "drizzle-orm";
import type { AppRouterClient } from "../src/api";
import { finishMfa } from "./lib/mfa";
import { CMB_BRANCH, railToKandyHub } from "./lib/rail";
import { retireRun } from "./lib/retire";

const API = process.env.UI_RIDER_API ?? "http://localhost:4200";
const APP = process.env.UI_RIDER_APP ?? "http://localhost:4300";
const DEVICE = "pod-photo-probe-device";
const PHOTO_MERCHANT = "Kandy Photo Proof Store";
const JPEG = "/tmp/pod-photo-probe.jpg";

const { db } = await import("../src/api/database");
const { hardenScriptReads } = await import("./lib/db-retry");
hardenScriptReads(db);
const { rateLimit } = await import("../src/api/database/schema/shared");
const { merchant } = await import("../src/api/database/schema/merchants");
const { deliveryPod } = await import("../src/api/database/schema/delivery");
await db.delete(rateLimit);

let keySeq = 0;
const key = (l: string) => `pod-photo-${l}-${Date.now()}-${++keySeq}`;
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
async function refusal(p: Promise<unknown>): Promise<{ status: number; detail: string }> {
  try {
    await p;
    return { status: 200, detail: "accepted" };
  } catch (e) {
    const err = e as { status?: number; data?: { detail?: string }; message?: string };
    return { status: err.status ?? 0, detail: err.data?.detail ?? err.message ?? String(e) };
  }
}
async function login(phone: string, deviceId?: string) {
  await db.delete(rateLimit).where(like(rateLimit.bucket, "%identity.requestOtp"));
  const c = await anon.identity.requestOtp({ phone });
  if (!c.devCode) throw new Error(`no dev OTP for ${phone}`);
  return finishMfa(API, await anon.identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode, deviceId: deviceId ?? null }));
}

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
  },
});
async function head(storageRef: string) {
  try {
    const r = await s3.send(
      new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: storageRef.replace(/^s3:/, "") }),
    );
    return { ok: true, type: r.ContentType ?? "", size: r.ContentLength ?? 0 };
  } catch (e) {
    return { ok: false, type: "", size: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

// A real JPEG, not a few magic bytes.
const made = Bun.spawnSync(["convert", "-size", "320x240", "plasma:fractal", "-quality", "70", JPEG]);
if (made.exitCode !== 0) throw new Error(`could not make a test JPEG: ${made.stderr.toString()}`);
const jpegBytes = new Uint8Array(await Bun.file(JPEG).arrayBuffer());

console.log(`\nNatEx photo POD probe → api ${API}, app ${APP}\n`);
console.log("0. Staging");
const admin = await login("+94773456789");
const transport = await login("+94777890123");
const ops = await login("+94779012345");
const rider = await login("+94778901234", DEVICE);
const merchantUser = await login("+94775678901");

let [photoMerchant] = await db.select().from(merchant).where(eq(merchant.name, PHOTO_MERCHANT)).limit(1);
if (!photoMerchant) {
  const created = await clientFor(admin.accessToken, key("merchant")).merchants.create({
    name: PHOTO_MERCHANT,
    branchId: "brn_kdy_hub",
    address: "44 Yatinuwara Veediya, Kandy",
    contactName: "Nadeesha Herath",
    contactPhone: "+94812223344",
    codEnabled: true,
    podPolicy: "photo",
  });
  [photoMerchant] = await db.select().from(merchant).where(eq(merchant.id, created.id)).limit(1);
}
check(photoMerchant?.podPolicy === "photo", "a merchant with a photo POD policy exists", photoMerchant?.id ?? "none");

async function stage(count: number, label: string) {
  const awbs: string[] = [];
  for (let i = 0; i < count; i++) {
    const created = await clientFor(admin.accessToken, key(`stage-${label}-${i}`)).parcels.create({
      merchantId: photoMerchant!.id,
      branchId: CMB_BRANCH,
      weightGrams: 600,
      declaredValueCents: 50_000,
      codAmountCents: 0,
      originAddress: "44 Yatinuwara Veediya, Kandy",
      consigneeName: `Photo ${label} ${i + 1}`,
      consigneePhone: "+94761112233",
      destAddress: `${30 + i} Katugastota Road, Kandy`,
    });
    awbs.push(created.parcel.awb);
  }
  // Real custody chain — Bagged → InTransit needs a sealed bag on a trip (§6).
  await railToKandyHub({ clientFor, login: (p) => login(p), adminToken: admin.accessToken, awbs: awbs, key, label: label });
  return awbs;
}

for (const r of await clientFor(transport.accessToken).delivery.runsheetList({
  riderId: rider.user.id,
  status: ["draft", "dispatched"],
})) {
  await retireRun(clientFor(ops.accessToken, key(`retire-${r.id}`)), r, "retired by photo POD probe before a fresh run");
}
const [apiAwb, otherAwb, uiAwb] = await stage(3, "pod");
const sheet = await clientFor(transport.accessToken, key("create")).delivery.runsheetCreate({ riderId: rider.user.id });
await clientFor(transport.accessToken, key("add")).delivery.runsheetAdd({
  runsheetId: sheet.id,
  awbs: [apiAwb!, otherAwb!, uiAwb!],
});
await clientFor(transport.accessToken, key("dispatch")).delivery.runsheetDispatch({ runsheetId: sheet.id });
check(true, "run dispatched", `${sheet.code}: api ${apiAwb}, other ${otherAwb}, ui ${uiAwb}`);

// ── A. API half ─────────────────────────────────────────────────────────────
console.log("\nA. Upload slot → bucket → POD");
const riderApi = (l: string) => clientFor(rider.accessToken, key(l), DEVICE);
const slot = await riderApi("slot").delivery.podPhotoUpload({ awb: apiAwb!, contentType: "image/jpeg" });
check(
  slot.storageRef.startsWith(`s3:pod/${apiAwb}/`) && slot.storageRef.endsWith(".jpg"),
  "slot is keyed under this parcel's AWB",
  slot.storageRef,
);
check(slot.uploadUrl.startsWith("https://") && /X-Amz-Signature=/.test(slot.uploadUrl), "upload URL is a presigned HTTPS PUT");
check(slot.expiresInSeconds > 0 && slot.expiresInSeconds <= 900, "slot expires", `${slot.expiresInSeconds}s`);

const put = await fetch(slot.uploadUrl, { method: "PUT", body: jpegBytes, headers: { "Content-Type": "image/jpeg" } });
check(put.ok, "JPEG PUT straight to the bucket", `HTTP ${put.status}${put.ok ? "" : ` ${(await put.text()).slice(0, 200)}`}`);
const landed = await head(slot.storageRef);
check(
  landed.ok && landed.type === "image/jpeg" && landed.size === jpegBytes.length,
  "HEAD: object exists with the right type and size",
  landed.ok ? `${landed.type}, ${landed.size} bytes` : (landed as { error?: string }).error ?? "missing",
);

const asMerchant = await refusal(
  clientFor(merchantUser.accessToken, key("m-slot")).delivery.podPhotoUpload({ awb: apiAwb!, contentType: "image/jpeg" }),
);
check(asMerchant.status === 403, "a merchant cannot get an upload slot (403)", `${asMerchant.status} ${asMerchant.detail}`);
const badType = await refusal(
  riderApi("bad-type").delivery.podPhotoUpload({ awb: apiAwb!, contentType: "application/pdf" as "image/jpeg" }),
);
check(badType.status === 400, "a non-image type is refused (400)", `${badType.status}`);

const base = { awb: apiAwb!, receivedByName: "Sunil Perera", receivedByRelation: "self" as const, method: "photo" as const };
const noPhoto = await refusal(riderApi("no-photo").delivery.recordDelivery({ ...base, photoUrl: null }));
check(noPhoto.status === 400, "photo POD refused without a photo", noPhoto.detail);
const pasted = await refusal(
  riderApi("pasted").delivery.recordDelivery({ ...base, photoUrl: "https://example.com/front-door.jpg" }),
);
check(pasted.status === 400, "photo POD refused with a pasted URL", pasted.detail);
const otherSlot = await riderApi("other-slot").delivery.podPhotoUpload({ awb: otherAwb!, contentType: "image/jpeg" });
const borrowed = await refusal(riderApi("borrowed").delivery.recordDelivery({ ...base, photoUrl: otherSlot.storageRef }));
check(borrowed.status === 400, "photo POD refused with another parcel's photo", borrowed.detail);
const stillOut = await clientFor(ops.accessToken).parcels.get({ awbOrId: apiAwb! });
check(stillOut.parcel.status === "OutForDelivery", "none of the refusals moved the parcel", stillOut.parcel.status);

const { ulid } = await import("../src/api/shared/ulid");
const pushed = await riderApi("push").sync.push({
  deviceId: DEVICE,
  pendingCount: 1,
  operations: [
    {
      clientOpId: ulid(),
      kind: "delivery.deliver",
      seq: 1,
      clientTs: Date.now(),
      payload: { ...base, photoUrl: slot.storageRef, codCollectedCents: 0 },
    },
  ],
});
check(pushed.verdicts[0]?.state === "applied", "delivery with the photo ref syncs", `${pushed.verdicts[0]?.state} ${pushed.verdicts[0]?.error ?? ""}`);
const delivered = await clientFor(ops.accessToken).parcels.get({ awbOrId: apiAwb! });
check(delivered.parcel.status === "Delivered", "server: parcel Delivered", delivered.parcel.status);
const [podA] = await db.select().from(deliveryPod).where(eq(deliveryPod.awb, apiAwb!)).orderBy(desc(deliveryPod.ts)).limit(1);
check(
  podA?.method === "photo" && podA.photoUrl === slot.storageRef,
  "server: POD row stores the object ref, not an expiring URL",
  podA?.photoUrl ?? "none",
);

// ── B. UI half ──────────────────────────────────────────────────────────────
console.log("\nB. The rider app takes the photo and delivers");
const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({ viewport: { width: 400, height: 860 } });
await context.addInitScript(
  ([s, d]: string[]) => {
    if (!localStorage.getItem("natex.session")) localStorage.setItem("natex.session", s!);
    localStorage.setItem("natex.deviceId", d!);
  },
  [
    JSON.stringify({
      accessToken: rider.accessToken,
      refreshToken: rider.refreshToken,
      expiresAt: Date.now() + rider.expiresIn * 1000,
      user: rider.user,
    }),
    DEVICE,
  ],
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

await page.goto(`${APP}/stop/${uiAwb}`);
check(await visible("Doorstep photo", 30_000), "stop says the merchant needs a doorstep photo");
await page.getByRole("button", { name: "Deliver", exact: true }).click();
await page.getByLabel("Received by").fill("Chamari Bandara");
const confirm = page.getByRole("button", { name: /Confirm delivery/ });
check(await confirm.isDisabled(), "cannot confirm before the photo");
const chooser = page.waitForEvent("filechooser", { timeout: 15_000 });
await page.getByRole("button", { name: "Take photo" }).click();
(await chooser).setFiles(JPEG);
check(await visible("Photo uploaded", 30_000), "photo uploaded from the app");
check(!(await confirm.isDisabled()), "confirm unlocks with name + photo");
await page.screenshot({ path: "/tmp/pod-photo-form.png", fullPage: true });
await confirm.click();
check(await visible("Today's deliveries"), "back on the run");

let pUi = await clientFor(ops.accessToken).parcels.get({ awbOrId: uiAwb! });
for (let i = 0; i < 20 && pUi.parcel.status !== "Delivered"; i++) {
  await page.waitForTimeout(500);
  pUi = await clientFor(ops.accessToken).parcels.get({ awbOrId: uiAwb! });
}
check(pUi.parcel.status === "Delivered", "server: UI stop Delivered", pUi.parcel.status);
const [podB] = await db.select().from(deliveryPod).where(eq(deliveryPod.awb, uiAwb!)).orderBy(desc(deliveryPod.ts)).limit(1);
check(podB?.method === "photo" && !!podB.photoUrl?.startsWith(`s3:pod/${uiAwb}/`), "server: photo POD recorded", podB?.photoUrl ?? "none");
const landedB = podB?.photoUrl ? await head(podB.photoUrl) : { ok: false, type: "", size: 0 };
check(landedB.ok && landedB.size > 0, "the app's photo is really in the bucket", landedB.ok ? `${landedB.type}, ${landedB.size} bytes` : "missing");
check(consoleErrors.length === 0, "no console or page errors", consoleErrors.slice(0, 4).join(" | "));
await browser.close();

console.log(
  failures.length === 0
    ? `\nALL GREEN — ${pass} photo POD checks passed.\n`
    : `\n${failures.length} FAILED, ${pass} passed:\n  - ${failures.join("\n  - ")}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
