# NatEx build log — M2 → M5

Source of truth: `/home/user/Attachments/pasted-1_0jWrxs.txt` (PROJECT.md). Section refs below are its §.

## Status

- M1 — Core & Collection: **verified** (smoke 38/38 green, routing NaN bug fixed and re-verified 2026-09-30).
  - Carried-over gaps, tracked, not dropped: no unit tests, no README. (Rider tab: built and proven 2026-10-01, see M3.)
- M2 — Transport & Custody: **verified** (ops web + Expo rider/transport tabs driven end to end in a browser 2026-09-30; see Mobile verification log below).
- M3 — Delivery & Merchant: **in progress** (started 2026-09-30). Backend + rider app proven; ops runsheets/NDR pages, merchant portal, bulk booking and §6 unit tests remain.
- M4 — Money: not started
- M5 — Hardening: not started

## M2 plan (§10)

Backend
- [ ] state-machine: replace `M1_ENABLED` with per-milestone gate, open Bagged / InTransit / AtDestHub
- [ ] schema `transport.ts`: bag, bag_item, trip, hub_scan, custody_exception
- [ ] `modules/transport/service.ts`: bag CRUD, bulk scan, seal, trip create/assign/depart/arrive,
      hub scan + variance detection, two-party handover, exception queue
- [ ] `routes/transport.ts`
- [ ] public tracking procedure (unauthenticated, PDPA-minimised payload)

Web
- [ ] `/track/:awb` public page
- [ ] ops: bagging, linehaul board, hub scan log, exception queue
- [ ] chain-of-custody timeline upgraded with bag/trip legs

Mobile (Expo, role-based tabs — approved substitution for the two Flutter apps)
- [x] login + device bind
- [x] rider tabs: today, scan, pickup, handover  (closes the M1 gap)
- [x] transport tabs: bags, trips, inbound/receive, me

### Mobile verification log (2026-09-30, live browser against the dev server on :4300)

Exercised by hand, not just typechecked. Every line below was observed on screen
and cross-checked in the database:

- OTP login + device bind for rider, Colombo transport and Kandy transport accounts; sign-out clears the session.
- Rider: today's pickups, manifest detail, scan (4 of 4), two-party handover with a named releaser -> all four parcels `PickedUp`, manifest `handed_over`.
- Rider hand-in: batch of 3 where one AWB does not exist -> "2 received, 1 refused", the refused label stays in the queue with its reason instead of the batch failing.
- Transport: bag detail, queued bulk scan with one unknown label -> "2 accepted, 1 rejected" and an `illegal_scan` exception row.
- Seal -> scanning blocked while sealed; break seal with a reason -> `seal_mismatch` exception recorded with the typed reason.
- Re-seal, load onto a planned trip, depart with a vehicle seal, mark arrived.
- Inbound list at the destination hub shows both in-transit bags; receipt of one with a deliberate three-way variance (1 missing, 1 off-manifest, wrong seal) -> "3 exceptions raised", seal "DID NOT MATCH", and exactly three matching rows in `transport_exception` (`missing_at_destination`, `unexpected_at_destination`, `seal_mismatch`). Nothing was reconciled away.

Bugs found and fixed in the process: `@/*` alias unresolvable by Metro (all mobile
imports rewritten relative), doubled counts from `plural()` being wrapped in its own
count across 7 screens, raw `YYYY-MM-DD` pickup date, an empty state showing on
already-closed manifests, and a raw `AtDestHub` enum rendering in a receipt badge.

Tests
- [ ] Bun unit tests: every legal + illegal transition (§6), idempotency replay
- [ ] smoke script extended with the M2 custody chain

Docs
- [ ] README with run instructions + Known deviations table

## M3 plan (§10 — Delivery & Merchant)

Backend
- [x] schema `delivery.ts`: runsheet, runsheet_item, attempt, pod, otp, ndr, rto, reason_code
      all eight tables live (`delivery_runsheet`, `delivery_runsheet_item`,
      `delivery_attempt`, `delivery_pod`, `delivery_otp`, `delivery_ndr`,
      `delivery_rto`, `delivery_reason_code`), every one written and read back by
      `scripts/smoke-m3.ts` (87/87)
- [x] schema `notifications.ts`: template registry + per-message delivery log
      `notify_template` (versioned on admin edit, proven) + `notify_message`
- [x] schema `sync.ts`: client operation journal, conflict register, per-device cursor
- [x] `modules/delivery/service.ts`: runsheet build + route order, dispatch, POD delivery,
      failure with reason code, auto-RTO at 3 attempts (§6), NDR queue, RTO flow
      proven live by `scripts/smoke-m3.ts` (87/87), which walks a whole Kandy day
      and asserts each guardrail by trying to break it: the §6 role table (rider
      cannot load or dispatch their own van, nor close their own cash), one live
      run per rider per day, a dispatched run refusing new stops, a run with open
      stops refusing to close, reason-code flags (refusal final + auto-RTO, NatEx's
      own failure not burning a consignee attempt), POD policy enforced per
      merchant, delivery refused without a verified OTP, exact-cent COD (one cent
      short refused), offline POD replay dedupe (§7), NDR SLA clock + merchant
      instruction round-trip, forced close writing stops off as TIME_EXHAUSTED
      without burning an attempt, and the RTO leg POD'd back into the merchant's
      hands. `reasons.ts` seeds 18 codes; `ndr.ts` carries the NDR/RTO half.
      Script is now repeatable — it stages its own stops through the real audited
      rail and retires a stale run via the audited forced close.
- [x] `modules/notifications/service.ts`: WhatsApp -> SMS -> Push ladder, templates, log
      9 templates seeded, ladder proven falling whatsapp -> sms -> push with each
      rung's reason recorded verbatim, no unresolved placeholders, COD line
      rendered into the out-for-delivery copy, log merchant-scoped (§5), template
      copy versioned on admin edit and non-admin edits refused 403.
      Known deviation: no WhatsApp/SMS/push provider is configured in the sandbox,
      so every rung records a real `skipped`/`failed` reason rather than sending.
- [x] `modules/sync/service.ts`: delta pull by cursor, idempotent push, §7 conflict policy
      proven live by `scripts/smoke-sync.ts` (67/67) — every row of §7's conflict
      table provoked deliberately, plus device-order-not-clock-order, branch
      scoping and role boundaries. `double_cod` is the one policy not yet
      covered: it needs the delivery->COD wiring that is still open in M4.
- [x] routes `delivery.ts`, `notifications.ts`, `ndr.ts` — every proc exercised by
      `scripts/smoke-m3.ts` (87/87) including the role gates (merchant refused 403
      on deliverable stock, runsheet list and delivery OTP) and admin global scope
- [ ] merchant booking + bulk upload routes — `parcels.create` is `authedProc` and
      merchant-callable, but there is no bulk/CSV booking endpoint yet
- [x] routes `sync.ts`: push, pull, conflict queue (list/get/claim/resolve), fleet, journal
- [x] open M3 statuses in the state machine (CURRENT_MILESTONE 2 -> 3)
      `EXPOSED_MILESTONE = 3` in `modules/parcels/state-machine.ts`; every M3
      status (OutForDelivery, Delivered, DeliveryAttempted, RTOInitiated,
      RTOInTransit, RTODelivered) driven live in `scripts/smoke-m3.ts`.
      `SHIPPED_MILESTONE` stays 2 on purpose — rider app now proven, but ops runsheet/NDR
      pages, merchant portal + bulk booking and §6 unit tests are still outstanding.

Web
- [ ] merchant portal: dashboard, booking, bulk upload, pickups, shipments, tracking
- [ ] ops: runsheets, NDR queue
- [x] ops: sync conflict review — `pages/ops/sync-conflicts.tsx` + `queries/sync.ts`,
      queue + policy tally + fleet health + side-by-side client-claim/server-state
      drawer with claim/resolve. Proven live by `scripts/probe-sync-conflicts.ts`
      (47/47: every field the page reads present on the payload, §7 policy gloss
      parity with `conflictCounts.byPolicy`, transport/merchant 403, §5 cross-branch
      403 with admin allowed, empty-notes 400, missing Idempotency-Key 400, full
      claim -> 409 second claimant -> resolve -> 409 re-resolve cycle with counts
      moving 21/3 -> 20/4) and `scripts/ui-check.ts` (20/20 routes green including
      `/ops/sync-conflicts`); list view and drawer screenshot-verified rendering
      live branch-scoped data.

Mobile (rider) — proven 2026-10-01 in Expo web (:4300) against the live API/DB/bucket.
NOT yet run on a physical phone; camera capture (`launchCameraAsync`) is native-only
and so far exercised only through the web file-picker path.
- [x] runsheet / route screen, delivery detail
      `app/(rider)/deliveries.tsx`, `app/(rider)/stop/[awb].tsx`; run cached on the
      phone for offline use. `scripts/ui-rider.ts` (51/51): all stops in route
      order, COD to the cent, per-merchant POD badge, cash-in-hand total.
- [x] POD capture: OTP, signature, photo
      OTP: request + wrong code refused + right code verified server-side
      (`ui-rider.ts` §4). Signature: SVG pad, stored as SVG data URL, receiver +
      relation recorded; COD one cent short keeps confirm locked (`ui-rider.ts` §2).
      Photo: `delivery.podPhotoUpload` presigned PUT straight to the bucket, POD
      row stores `s3:pod/<AWB>/<ulid>.jpg` (never an expiring URL); server now
      refuses a photo ref not issued for THIS parcel. `scripts/probe-pod-photo.ts`
      (25/25: slot keyed by AWB, PUT 200, HEAD type+size match, merchant 403,
      non-image 400, missing/pasted/borrowed photo 400, sync.push applied, and the
      app's own picker -> upload -> deliver with the object HEAD-verified).
- [x] failure reason codes + NDR entry
      Reasons grouped by category with consequence text, cached so they work
      with no signal; offline failure drains to DeliveryAttempted with the
      reason, raises an open NDR, and the stop shows the NDR outcome.
- [x] offline outbox: local-first write, drain on reconnect, cursor pull (§7)
      `lib/outbox.ts`: per-user AsyncStorage queue, persisted monotonic seq,
      ULID clientOpIds, drains in seq order every 20 s / on foreground / on
      "Sync now", then `sync.pull` for assignment + cursor. Proven: offline
      write shows "saved on phone", is on disk, server unmoved; reconnect drains;
      server attempt carries the device ULID, deviceId and the device clock as
      clientTs (earlier than server ts). §7 conflict: delivered offline while ops
      failed it -> open `offline_delivery_vs_fail` conflict, server state kept,
      rider sees "Conflict — sent to ops" with the policy.
      Device ORDER under a multi-record queue: `scripts/ui-rider-queue.ts` (31/31,
      repeatable). API cut for the whole capture; six interleaved
      deliver/fail taps with the device clock running backwards (-10, -40, -5,
      -50, -15, -45 min); app force-quit after tap 3 and cold-started; queue
      restored from disk and seq continued 4..6 (no reset). All 13 push
      attempts (12 aborted offline + 1 on reconnect) carried ops in ascending
      seq; the reconnect sent 1..6 once, in tap order; server journal holds
      exactly those six phone ULIDs in seq order, all `applied`, clientTs kept
      verbatim; each parcel ended in the state its tap meant; a later drain
      re-sent nothing.

### Fixed 2026-10-01 (found by `ui-rider.ts`)
- Rider save buttons hung on a spinner offline: TanStack mutations default to
  `networkMode: "online"` and pause with no signal. The two outbox writes now
  use `networkMode: "always"` — a local write needs no network.
- The outbox driver lived on the Deliveries tab only, so a stop opened cold
  (deep link / restart) never loaded the queue from disk. Hoisted into
  `app/(rider)/_layout.tsx`.
- §7 classification: a delivery pushed for a parcel that was failed
  (`DeliveryAttempted`) while the phone was offline landed as `illegal_state`
  instead of `offline_delivery_vs_fail`. Added `DeliveryAttempted` to
  `FAILED_STATES` in `modules/sync/service.ts`.
- `sync/service.ts` now forwards the device clock (`op.clientTs`) into
  `recordDelivery` / `recordFailure`; it was being dropped.
- Sync strip sat on "Checking connection…" forever with an empty queue (only a
  push recorded contact); a successful pull now counts. "1 record need ops" ->
  "needs".
- Regression after these server edits: `smoke-m3` 87/87, `smoke-sync` 67/67,
  `probe-sync-conflicts` 47/47, `soak-sync` 34/34 (861 s). Typecheck web +
  mobile and lint clean.
- Dev-server note: restart Vite with `bunx vite --host ::` from `packages/web`.
  Plain `bun run dev` once bound to `[::1]` only and the preview tunnel 502'd.

Tests
- [ ] Bun unit tests: every legal + illegal transition (§6) — carried over from M2
- [x] sync soak: 500 sequential ops, clock skew, force-quit mid-queue (§7)
      `scripts/soak-sync.ts` — 34/34 in 866s: outbox built entirely offline, 500
      ops applied exactly once, 3 force-quit chunk replays all answered
      `duplicate` with the stored result, clientTs jittered +/-30 min and
      non-monotonic, all 100 parcels walked their 5-step chain to Delivered,
      500 journal rows / 500 distinct client op ids / seq 1..500 with no gaps,
      one audit-log row per push.

### Fixed 2026-09-30
- The recurring `unknown outbox topic: custody.exception_raised` worker error was
  stale dead-lettered rows written by a worker running pre-handler code, not a
  missing handler. Requeued the 10 `failed` rows; all drained clean. Verified by
  counting `shared_outbox` by state before and after.
