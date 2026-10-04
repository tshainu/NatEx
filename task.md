# NatEx build log — M2 → M5

Source of truth: `/home/user/Attachments/pasted-1_0jWrxs.txt` (PROJECT.md). Section refs below are its §.

## Status

- M1 — Core & Collection: **verified** (smoke 38/38 green, routing NaN bug fixed and re-verified 2026-09-30).
  - Carried-over gaps, tracked, not dropped: no unit tests, no README. (Rider tab: built and proven 2026-10-01, see M3.)
- M2 — Transport & Custody: **verified** (ops web + Expo rider/transport tabs driven end to end in a browser 2026-09-30; see Mobile verification log below).
- M3 — Delivery & Merchant: **verified** 2026-10-01 (`SHIPPED_MILESTONE = 3`). Full regression on the final code listed under "M3 closing regression" below. Caveat: the rider app has only run in Expo web, never on a physical phone.
- M4 — Money: **verified** 2026-10-02 (`SHIPPED_MILESTONE = EXPOSED_MILESTONE = 4`; M4 owns no parcel statuses). Backend plus the finance portal and the merchant statement. Regression on the final code is under "M4 closing regression" below.
- M5 — Admin & Hardening: **verified** 2026-10-03 (`SHIPPED_MILESTONE = EXPOSED_MILESTONE = 5`). Regression on the final code is under "M5 closing regression" below. Blocked on the client: Sentry DSN, Uptime Kuma host, §15 q3 and q10.

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
      `scripts/smoke-m3.ts` (94/94)
- [x] schema `notifications.ts`: template registry + per-message delivery log
      `notify_template` (versioned on admin edit, proven) + `notify_message`
- [x] schema `sync.ts`: client operation journal, conflict register, per-device cursor
- [x] `modules/delivery/service.ts`: runsheet build + route order, dispatch, POD delivery,
      failure with reason code, auto-RTO at 3 attempts (§6), NDR queue, RTO flow
      proven live by `scripts/smoke-m3.ts` (94/94), which walks a whole Kandy day
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
      `scripts/smoke-m3.ts` (94/94) including the role gates (merchant refused 403
      on deliverable stock, runsheet list and delivery OTP) and admin global scope
- [x] merchant booking + bulk upload routes — `parcels.create` (merchant-callable,
      §5 scoped) and `parcels.bulkCreate` (`modules/parcels/bulk.ts`, row limit
      `BULK_ROW_LIMIT`, `dryRun` preview, one Idempotency-Key per chunk).
      `scripts/probe-bulk-booking.ts` 37/37; client-side CSV parsing covered by
      `src/web/lib/bulk-csv.test.ts` (21 tests).
- [x] `delivery.runsheetCancel` (added 2026-10-01): a dispatch that failed mid-way
      left a draft run that locked the rider out for the day, and `cancelled` was
      unreachable. Draft only (dispatched -> 409), pending stops marked `removed`,
      no parcel moves, reason 5–400 chars, audited as `runsheet.cancelled`. Ops
      page has a "Cancel the draft" section behind a ConfirmDialog plus a
      "Cancelled" filter. Proven by `smoke-m3` §12b and the cancel step in
      `ui-ops-delivery` (24/24). Test scripts retire stale runs through it
      (`scripts/lib/retire.ts`).
- [x] routes `sync.ts`: push, pull, conflict queue (list/get/claim/resolve), fleet, journal
- [x] open M3 statuses in the state machine (CURRENT_MILESTONE 2 -> 3)
      `EXPOSED_MILESTONE = 3` in `modules/parcels/state-machine.ts`; every M3
      status (OutForDelivery, Delivered, DeliveryAttempted, RTOInitiated,
      RTOInTransit, RTODelivered) driven live in `scripts/smoke-m3.ts`.
      `SHIPPED_MILESTONE` bumped 2 -> 3 on 2026-10-01 once the ops pages, merchant
      portal, bulk booking and §6 unit tests below were all proven.

Web
- [x] merchant portal: dashboard, booking, bulk upload, pickups, shipments, tracking, NDR
      `pages/merchant/{dashboard,book,book-csv,pickups,parcels,tracking,ndr,account}.tsx`.
      `scripts/probe-merchant-portal.ts` 51/51 (every field each page reads, §5
      cross-merchant 403/404). `scripts/ui-merchant.ts` 36/36 in a real browser:
      dashboard tiles equal the API counts, decimal-precision field errors, lost
      response + retry books ONE parcel on the same key, 152-row CSV with
      client- and server-side rejects and NOTHING booked on dry run, keyboard tab
      strip, and no console errors across merchant/ops/admin screens.
- [x] ops: runsheets, NDR queue
      `pages/ops/runsheets.tsx`, `pages/ops/ndr.tsx`, `components/natex/ndr-panels.tsx`.
      `scripts/probe-ops-delivery.ts` 45/45, `scripts/ui-ops-delivery.ts` 24/24
      (build, add stops, dispatch, force-close, cancel-draft, NDR instruct/close, RTO start -> dispatch -> hand-back, keyboard + CSV export, no console errors).
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
- [x] Bun unit tests: every legal + illegal transition (§6) — carried over from M2
      `modules/parcels/state-machine.test.ts` (pure table) and
      `modules/parcels/transition.db.test.ts` (against the DB). `bun run test`
      count recorded under "M3 closing regression". Idempotency replay is proven
      by `scripts/smoke.ts` (71/71) and `ui-merchant`, not by a unit test.
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

### M3 closing regression (2026-10-01, final code)

Each script run against the live dev server + Turso DB. Failures caused by
Turso `socket hang up` (a 500 in the server log with `ECONNRESET` as the cause)
were rerun; everything else was fixed before counting.

- `smoke-m3` 94/94, `smoke-m4` 75/75, `smoke-sync` 67/67, `smoke` 71/71
- `ui-rider` 51/51, `ui-rider-queue` 31/31, `probe-pod-photo` 25/25
- `ui-ops-delivery` 24/24, `probe-ops-delivery` 45/45
- `ui-merchant` 36/36, `probe-merchant-portal` 51/51, `probe-bulk-booking` 37/37
- `probe-cod-wiring` 35/35, `probe-disputes` 55/55, `probe-sync-conflicts` 47/47, `probe-nightly` 6/6
- `bun run test` 1353 pass / 0 fail (3464 expects); `ui-check` 31/31 routes; `bun run lint` 0 errors; typecheck web, scripts and mobile all clean

Fixed while closing:
- Merchant "Parcel booked" card had lost its live-region role in an a11y lint
  pass (a bare `aria-live` div). Now an `<output>` around the announcement text
  only; caught by `ui-merchant` failing twice in a row on the same check.
- Framework input-validation rejections were logged as `status:500` with an
  `[unhandled]` stack. Now logged as 400 with no stack; the response is still the
  RFC 7807 `validation-failed` problem. Checked by sending a malformed
  `identity.requestOtp` and reading the server log.
- Stale copy on live screens corrected: login and sidebar milestone lines, the
  web field page (said bagging "arrives in Milestone 2"), the POD-policy hint
  ("enforced from Milestone 3"), the finance overview (said "no money moves
  through this system") and the three finance stubs (said the ledger did not exist).

## M4 — Money (§8, §10 M4)

Built
- [x] Finance portal: `/finance` dashboard, `/finance/cod` (ledger browser, four-way
      reconciliation, rider cash/deposits), `/finance/remittances` (settlement runs
      with maker–checker, holds, payout file, bank details), `/finance/invoices`
      (VAT/SSCL invoices, credit notes, AR ageing), `/finance/disputes` (dispute
      queue + claim register), controls (manual invariant run, alerts).
      Proven by `ui-finance.ts` and `probe-finance-pages.ts`.
- [x] Merchant: `/merchant/disputes` and `/merchant/statement` (payable, payouts,
      invoices, outstanding, credit notes, masked bank account). `ui-merchant.ts`.
- [x] Bank details (`finance.setPayoutDetails`): finance-only; the payout file
      refuses a merchant with none (409 `payout-details-missing`) and links to the
      form with the merchant preselected; re-pointing an account needs a reason and
      a destructive confirm.
- [x] Demo seed `scripts/seed-m4.ts` (merchant `mch_m4_demo`, idempotent — run twice).

Hardening found while building M4
- Merchant visibility (§5): a merchant could fetch draft/proposed/rejected
  settlement runs and draft/void invoices directly; the page filter was cosmetic.
  Now enforced in SQL (`merchantView` in `settlement.ts`/`invoicing.ts`,
  applied in every merchant-reachable finance route; hidden by-id → 404).
  `probe-merchant-visibility.ts` 25/25.
- Audit redaction: `mutate()` audits the whole handler result, so
  `cod.payout_details_set` and `cod.payout_csv_exported` rows held the full bank
  account (the CSV body and the `rows[].account` field). `shared/redact.ts` now
  masks account numbers to the last 4, drops tokens/OTP codes and replaces CSV
  bodies with their size, in `writeAudit` for every row. `redact.test.ts` 7/7;
  `ui-finance` asserts no audit row from its run holds the full number.
  KNOWN (2026-10-02): ~31 audit rows written before the fix still held full
  numbers. Superseded 2026-10-03: the dev DB was reseeded that morning (oldest
  audit row 03:24), and a scan of all 321 rows found 0 unmasked account
  numbers (see M5).
- Document codes: DSP/CLM/STL/DEP/INV/CRN/RS/PR/MF codes ended in 4 random digits
  (9 000 per prefix per day) and collided on the UNIQUE index — `disputes.open`
  returned a 500 in a `ui-finance` run. `shared/codes.ts`: 6 Crockford base32
  characters from the CSPRNG plus `insertWithFreshCode`, which re-mints on a
  UNIQUE violation of that table's `code`. `codes.test.ts` 6/6 against a real
  in-memory SQLite. (An earlier `ui-ops-delivery` 500 on a second same-day
  runsheet was likely the same RS collision; its log was lost to a restart, so
  that is not proven.)
- Transient Turso resets (`ECONNRESET` / socket hang up): `withRequestId` retries a
  request at most twice, only if it never reached a write path
  (`shared/request-scope.ts`; `mutate`/`publicMutate` call `markWrite()`).
  `request-id.test.ts` 7/7; server log showed `retry:1 reason:"transient-db"` → 200.
  The scope loads AsyncLocalStorage via `process.getBuiltinModule` so mobile and
  desktop, which type-check the API through `AppRouter`, need no Node types.
- Sign-in 500 on a socket reset: `publicMutate` marked the request as written
  before touching the rate-limit bucket, so an `ECONNRESET` on the bucket insert
  made `identity.requestOtp` a 500 (seen live in a `ui-ops-delivery` run). It
  now marks the write only once the handler starts; a reset on the bucket alone
  is retried (worst case: one extra token spent — stricter, never looser).
  `public-mutate.test.ts` 2/2, and it fails against the old ordering.
- Bag scan rejection reason on a socket reset was the raw SQL statement (seen
  in a `soak-sync` staging step; the write had not committed — the parcel was
  still `AtOriginHub`, so rescanning is correct). It now reads "Connection to the
  database dropped — scan this parcel again." and the detail goes to the log.
- Scripts: `scripts/lib/db-retry.ts` `hardenScriptReads(db)` retries plain SELECTs on a
  transient error (never writes) and `cleanupWithRetry` for idempotent fixture
  sweeps; `db-retry.test.ts` 5/5. Wired into 22 scripts.
- `useTabParam` (`components/natex/tab-strip.tsx`) copied `?tab=` into state on mount,
  so an in-app link to another tab changed the URL but not the tab. Now derived
  from the URL.
- `probe-disputes` picked the first issued invoice even with no credit room left,
  then re-invoiced the current period (409 `invoice-exists`). It now filters for
  room in SQL and otherwise invoices an earlier un-invoiced period.

Count notes
- `smoke-m3` is 93 on a clean DB, 94 when a stale Kandy run is open (the check
  inside `for (const openRun of stale)` only runs then). Both are green.
- `probe-ops-delivery` 45 or 46 for the same reason (fixture-dependent `if` branches).
- `smoke-sync` 66 or 67: "cleared runsheets left open by an earlier run" only
  counts when there were leftovers.

### M4 closing regression (2026-10-02, final code)

Live dev server + Turso DB.
- `bun run test` 1380 pass / 0 fail — 1353 + request-id 7 + db-retry 5 + redact 7 + codes 6 + public-mutate 2
- `smoke` 71/71, `smoke-m3` 94/94, `smoke-m4` 75/75, `smoke-sync` 66/66
- `probe-finance-pages` 41/41, `probe-cod-wiring` 35/35, `probe-disputes` 56/56 (twice),
  `probe-merchant-visibility` 25/25, `probe-merchant-portal` 51/51,
  `probe-bulk-booking` 37/37, `probe-ops-delivery` 46/46, `probe-sync-conflicts` 47/47,
  `probe-pod-photo` 25/25
- `ui-finance` 42/42, `ui-merchant` 46/46, `ui-check` 49/49 routes, `ui-ops-delivery` 24/24,
  `ui-rider` 51/51, `ui-rider-queue` 31/31
- `soak-sync` 34/34 (895 s); `probe-bulk-booking` 37/37 and `smoke` 71/71 rerun after the bag-scan change
- typecheck web, scripts, mobile, desktop clean; `bun run lint` 0 errors
- Not rerun this milestone: `probe-nightly` (needs a server started with
  `NIGHTLY_INVARIANT_HOUR=0 NIGHTLY_TICK_MS=15000`; last 6/6 at the M3 close,
  before the M4 alert edits in `alerts.ts`).

## M5 — Admin & Hardening (§10 M5)

Progress (only what has been run):
- [x] API: `smoke-m5` 115/115 (MFA, session policy, settings, users/branches/sessions,
  rate cards + quotes, merchant onboarding, templates, audit, monitor, zones).
  Unit: `mfa.db.test` 10, `settings/service.test` 2, `totp.test` 7, `pricing.test` 11.
  Bug found: audit-reader stripped `_` from the action filter (fixed).
- [x] Admin UI driven in a browser: `ui-admin` 29/29 (sign-in MFA for admin/finance,
  enrolment + recovery code for a new ops user, security page, users, branches,
  zones, rate cards, merchant onboarding, settings, templates, audit + CSV,
  monitor, role guards). Bugs found and fixed: template editor lost its "Saved"
  note on save (editor remounts on version bump; note lifted to the page);
  `<ul>` nested in ErrorNote's `<p>` (templates + rate-card editor).
- [x] `ui-check` 57/57 routes (8 new: 5 admin screens, 2 monitor tabs, /security).
- [x] Backup/restore drill: `scripts/backup-drill.ts` PASSED. 57 tables, 3 541 rows,
  354 KiB gz; backup 9.2 s, restore 2.5 s; `integrity_check` ok, `foreign_key_check` 0,
  57/57 per-table hashes equal, tamper self-test caught the corrupted row.
  CAVEAT: restored into a local SQLite file, not a hosted Turso DB. The real-Turso
  recipe in RUNBOOK section 2 is marked UNVERIFIED.
- [~] Uptime Kuma / Sentry: config + docs only (RUNBOOK section 5). `shared/report-error.ts`
  is the single Sentry hook (console.error today); `/api/health/ready` is the Kuma
  target. BLOCKED: no Sentry DSN, no Kuma host. Nightly push heartbeat not coded.
- [x] Job monitor: Admin → Monitor (outbox jobs + retry, invariant runs, health);
  readiness `{"status":"ok","db":"ok","worker":"ok","nightly":"ok"}` right after boot
  (fixed a false "stalled" worker on boot, see below).
- [x] Load test: `scripts/load-test.ts`, reads only, 20 s per stage, against the Vite dev
  server + hosted Turso, 0 errors. 5 users 25.4 req/s p95 286 ms; 20 → 81.2 / 368 ms;
  50 → 83.0 / 937 ms; 100 → 85.4 / 1 858 ms. Plateau at ~85 req/s; suspected cause is
  the libsql client's default concurrency of 20 — NOT confirmed. Dev server, no writes.
- [x] Security review: `scripts/security-review.ts` 100/100 live probes;
  `route-guards.test.ts` 8 tests over all 219 procedures (5 public, 4 pending-MFA,
  11 reviewed service-gated). Findings and fixes below.
- [x] RUNBOOK.md (new, sections 1–9) and README.md (rewritten for M1–M5).
- [x] Close-out regression, `SHIPPED_MILESTONE = EXPOSED_MILESTONE = 5` (see below).

### M5 closing regression (2026-10-03, final code)

Live dev server + Turso DB, after the milestone bump and every security edit
(`/tmp/regress.sh`, one pass, then the reruns noted).
- `bun run test` 1423 pass / 0 fail (incl. route-guards 8, rate-limit 4, readiness,
  mfa.db 10, settings 2, totp 7, pricing 11)
- `smoke` 71/71, `smoke-m3` 93/93, `smoke-m4` 75/75, `smoke-sync` 66/66,
  `smoke-m5` 115/115, `security-review` 100/100
- `probe-finance-pages` 41/41, `probe-cod-wiring` 35/35, `probe-merchant-visibility` 25/25,
  `probe-merchant-portal` 51/51, `probe-bulk-booking` 37/37, `probe-ops-delivery` 44/44
  (fixture-gated branches, see above), `probe-sync-conflicts` 47/47
- `probe-disputes` 55/56 first pass → **probe bug, fixed** → 56/56 rerun. The check
  "closed cases leave no live dispute_opened alert" polled only until the three
  alerts existed. For a case withdrawn before the worker ran, the worker inserts
  the alert open and closes it one round trip later ("already withdrawn when this
  alert was raised"); the probe read in that gap. DB afterwards: 0 live alerts on
  closed cases. The probe now waits for the settled state.
- `probe-pod-photo` part A green, part B refused: the Expo server on :4300 was not
  running (`ERR_CONNECTION_REFUSED`). Started it (tmux `mobile_4300`) → 25/25 rerun.
- `ui-finance` 42/42, `ui-merchant` 46/46, `ui-check` 57/57 routes, `ui-ops-delivery` 24/24,
  `ui-rider` 51/51, `ui-rider-queue` 31/31, `ui-admin` 29/29
- `probe-nightly` 6/6 (server restarted with `NIGHTLY_INVARIANT_HOUR=0 NIGHTLY_TICK_MS=15000`,
  then restarted normally)
- typecheck web, scripts, mobile, desktop clean
- `bun run lint` found 6 errors on the final tree: 5 route files did not export their
  feature name (`audit`, `mfa`, `monitor`, `rateCards`, `settings`; module imports
  renamed `*Service`, router keys unchanged) and one regex → `startsWith` in
  `smoke-m5`. Fixed → 0 errors; typechecks rerun clean.
- After the lint rename (server restarted): `bun run test` 1423/0, `smoke-m5` 115/115,
  `security-review` 100/100, `ui-admin` 29/29.
- Not rerun: `soak-sync` (895 s). M5's only sync change is the ops fleet-health read
  (clock-skew threshold now from `settings.clock_skew_alert_minutes`); push, pull and
  conflict paths are untouched and `smoke-sync`/`probe-sync-conflicts` are green. Last
  34/34 at the M4 close.

### M5 security review: findings fixed (2026-10-03)
- **Bank-detail leak.** `finance.payoutDetails` (and 12 other money reads) were
  `readProc`, so riders and transport could read any merchant's full bank account.
  New `moneyReadProc` (ops, admin, finance, merchant; merchant still self-scoped);
  13 routes moved to it, 3 `staffProc` finance routes to `deskProc`.
- **COD desk routes** (`reconciliation`, `riderCashBoard`, `listConfig`, alerts list/
  page/counts/get/acknowledge/resolve) moved `staffProc` → `deskProc`. Rider-facing
  `riderCash`, `myUndeposited`, `declareDeposit` unchanged.
- **Least privilege on admin reads:** templates, rate cards, settings,
  `identity.listUsers` → `deskProc`.
- **Access-token verification:** alg pinned to HS256 (alg:none / HS512 refused),
  constant-time `crypto.subtle.verify`, numeric `exp` and string `sub` required.
- **Idempotency keys** bound to their first user; another user's replay of the same
  key returns 409 `idempotency-key-reused` instead of the first user's response.
- **OTP SMS pumping:** `identity.requestOtp` now also has a per-destination bucket
  (`publicMutate` `subject`, last 9 digits, capacity 5, refill 0.2/min), so rotating
  IPs cannot flood one phone. `consumeToken` retry-after fixed for fractional refill.
- **Spoofable client IP:** `clientIp` prefers `cf-connecting-ip`, then `x-real-ip`,
  then the rightmost XFF entry (was leftmost). Production must sit behind the proxy.
- **Fail-closed env:** `isDevelopment()` is false unless `NODE_ENV=development`;
  `shared/auth.ts` throws outside development when JWT secrets are unset.
- **Readiness false alarm:** `startWorker` seeds the outbox heartbeat at boot.
- **Security headers** on API responses (`middleware/security-headers.ts`). HTML
  headers (CSP etc.) for the SPA must be set at the edge.
- Audit log: 0 of 321 rows hold an unmasked account number (regex over
  `accountNumber|account_number|bankAccount|account|beneficiaryAccount|payee_account|accountNo`
  with 6+ digits on the raw `before_json`/`after_json`; all 6 payout rows show `****NNNN`).
  Caveat: a regex scan, not a schema-aware one.

Open, not invented:
- §15 q3 rate-card structure — engine is configurable, seeded card is PLACEHOLDER.
- §15 q10 VAT/SSCL — arithmetic exists, seeded off.
- Sentry DSN and Uptime Kuma host — not provided; wiring documented only.
- Rider/transport app never run on a physical phone (Expo web in headless Chrome only).
- Real-Turso restore not rehearsed (drill restores to local SQLite).

## Round 6 — client UI requests (2026-10-03)

Asked: (1) Tamil names, English letters, for staff users + consignees (merchant
contacts unchanged); (2) split-screen login; (3) charts on ops board, merchant
dashboard, finance overview + new admin dashboard; (4) theme dark blue + emerald
#10B981 instead of amber; (6) bold menu group titles; (7) linehaul trip: vehicle
type (Bus always asks CTB / Private / AC Bus), vehicle number, contact person,
phone, arrival time, arrival bus station/stop, optional photo per bag.
(5) "Scan place" — dropped by the user.

- [x] theme — emerald #10B981 brand on buttons / active nav / focus / row flash;
      `moving` status amber → sky #0EA5E9; mobile theme.ts matched
- [x] bold nav titles — shell.tsx group headings; seen in admin/ops/finance screenshots
- [x] names (seed + login lists + scripts) — 8 staff + 30 consignees; merchant
      contacts unchanged; reseed wiped the dev audit log / events / probe fixtures
- [x] login redesign — split brand panel (login-hub.jpg) + sign-in; viewed at
      1440×900 and 390×844
- [x] dashboards — ops board, merchant, finance overview, new admin
      /admin/dashboard (company); parcels.trends, cod.dailyFlow, dashboard.company;
      probe-dashboards 44/0; all four viewed in screenshots
- [x] linehaul trip fields + bag photos — vehicle type (Bus → CTB/Private/AC bus),
      number, contact + phone, expected arrival, arrival station; optional bag photo
      (web + mobile); probe-trip-bag 39 pass; web form read back via API
- [x] verify (2026-10-04): lint 0/0; tsc web + scripts + mobile + desktop clean;
      `bun run test` 1426 pass / 0 fail; live: smoke 71, smoke-m3 93, smoke-m4 75,
      smoke-m5 115, smoke-sync 66, security-review 100, probe-sync-conflicts 47,
      probe-cod-wiring 35, probe-pod-photo 25, probe-dashboards 44, probe-trip-bag 39,
      ui-check 58 routes, ui-finance 42, ui-ops-delivery 24, ui-rider 51,
      ui-rider-queue 31. After the last UI polish (metric-tile money size, linehaul
      nowrap cells, humanise): smoke 71, smoke-m5 115, ui-check 58, ui-finance 42,
      ui-admin 29/0, ui-merchant 46/46. Single, non-repeating failures on the way:
      ui-admin settings refresh check once, ui-admin Turso query + goto timeout once,
      ui-merchant one bulk row rejected during a 53 s chunk once — each passed on rerun
      while the sandbox connection was dropping.
- Found + fixed: dev MFA code could be the TOTP step about to expire
  (security-review failed twice) — `devCodeFor` skips a step with <5 s left;
  regression test in mfa.db.test.ts. `humanise("RTOInitiated")` now "RTO Initiated".
- Unexplained: ui-ops-delivery failed 5/24 once in the batch (Dispatch click
  timeout + a console 409); not reproduced in two later runs.

## VPS deployment + demo site (2026-10-04)

Asked: host on VPS 204.13.236.153 (production, login blocked until an SMS gateway
exists), then a demo site with dummy data and demo logins like the dev preview.
Layout, region move and recipes: RUNBOOK §1 "Production host" and "Demo data".

- [x] production: `https://204-13-236-153.sslip.io`, `natex.service` :4200, Caddy,
      ufw, Turso `natex-prod-us`, bootstrap-prod admin "Shainu"; readiness ok
- [x] auto-deploy timer: deployed 70b07cc by itself (`live: 70b07cc`)
- [x] Turso moved Mumbai → Virginia (`useast`): ~1 s → 0.06–0.1 s per round trip;
      the first test pass's ECONNRESET/timeouts cleared after the move
- [x] demo: `https://demo.204-13-236-153.sslip.io`, `natex-demo.service` :4201,
      NODE_ENV=development, Turso `natex-demo-us`, noindex; login page lists the
      demo accounts when the server says `identity.environment().demo`
- [x] demo data scripts: `seed-demo-history.ts` (30 days, 444 parcels),
      `seed-demo-live.ts` (today's live work through the API)
- [x] `ui-ops-delivery` precondition fixed: it raises its own open Kandy NDRs when the
      DB has none (failed identically twice on a fresh DB before the fix; 24/24 after).
      Also fixed a real UI glitch it exposed: the close-run confirm's title/body
      flipped from "Force-close" to "Close" while fading out (refetch emptied the
      pending list) — now frozen when the confirm opens.
- [x] RUNBOOK repaired: commit 70b07cc had truncated §5 (Sentry/Job monitor),
      dropped §6 and duplicated §7–§9; rebuilt from 917d024 + the VPS section
- [ ] Uptime Kuma admin + 3 monitors + `KUMA_PUSH_URL` (user creates the admin)
- [ ] SSH hardening (key only), nightly off-host backups + a Turso restore rehearsal
- [ ] SMS gateway → first real sign-in for Shainu (authenticator + recovery codes)
- [ ] separate S3 bucket for production; mobile/desktop apps still point at the dev preview
- [ ] delete the unused Mumbai DBs `natex-prod` / `natex-demo`
- Preconditions, not bugs: `probe-nightly` needs a server started with
  NIGHTLY_INVARIANT_HOUR=0 (the demo runs the default 23); `probe-sync-conflicts`
  needs `smoke-sync` to have run first.
