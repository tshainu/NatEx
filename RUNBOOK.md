# NatEx — operations runbook

Who this is for: whoever deploys, monitors and recovers NatEx. References written §n point at `PROJECT.md`;
"section n" means a section of this runbook. Every number here was measured on this
build (2026-10-03) unless it says otherwise.

---

## 1. Deploy

### Environment (root `.env`, never committed — template in `.env.template`)

| Variable | Required | Notes |
| --- | --- | --- |
| `NODE_ENV=production` | **yes** | Anything other than `development` or `test` counts as production (`src/api/shared/env.ts`, fails closed). In production: no `devCode` in OTP or MFA responses, seeded dev MFA factors are refused, and the server will not sign or verify tokens without real secrets. |
| `DATABASE_URL`, `DATABASE_AUTH_TOKEN` | yes | Turso. |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | **yes** | 32+ random bytes each. With either unset outside development the server throws at the first sign-in instead of using the public dev key. Rotating `JWT_ACCESS_SECRET` signs everybody out within 15 minutes (access TTL); that is the emergency "kill all sessions" lever. |
| `MFA_ENCRYPTION_KEY` | **yes** | Encrypts TOTP secrets at rest (AES-256-GCM, key = SHA-256 of this value). **Changing it invalidates every enrolled authenticator**: every ops/admin/finance user must be reset and re-enrol (section 3). Store it with the DB backups' keys, not with the app. |
| `SMS_EXECUTION_URL`, `SMS_SENDER_ID`, `SMS_DLR_WEBHOOK_SECRET` | yes for live SMS | Use the owner-whitelisted sender `NatEx` for OTP, POD, merchant registration, receiver rescheduling, and failed-delivery notices. Other customer booking/status SMS remain disabled. Unset gateway ⇒ messages are logged to `shared_sms_log` and never sent. |
| `SMS_DISABLE_ALL=true` | **yes on Demo** | Suppresses all SMS gateway calls in Demo. Keep enabled even if a gateway URL is configured. Production registration messages are a narrow fixed-copy exception; failed-delivery notices and reschedules are the only parcel-notification SMS exceptions. |
| Tracking links in SMS | — | POD SMS contains no tracking number or link. Failed-delivery and receiver-reschedule SMS may include their tracking number/link and short public reason; generic booking/status messages remain disabled. |
| `NIGHTLY_INVARIANT_HOUR`, `NIGHTLY_TICK_MS` | no | Nightly COD invariant: default hour 23 (Asia/Colombo), tick 300000 ms. |
| `SENTRY_DSN` | no | **Not wired — see section 5.** |

### Release steps

1. `bun install`, then `bun run typecheck`, `bun run lint`, `cd packages/web && bun run test`.
2. Take a backup (section 2) — every release, before the schema push.
3. `bun run db:push` (Drizzle; additive changes only on a live DB — review the diff it prints).
4. `bun run build`, then start (`bun run start`, pm2).
5. Check `GET /api/health/ready` returns 200 `{"status":"ok"}` (section 5).
6. **Never** run `bun run db:seed` against production: it is destructive and creates dev MFA factors.
   A fresh production DB is set up with `scripts/bootstrap-prod.ts` instead. It is idempotent,
   creates reference data and the first admin only, and loads no demo data.

### Production host (VPS, live since 2026-10-04)

- **Host:** InterServer VPS `204.13.236.153`, New Jersey (Ubuntu 26.04, 1 vCPU, 1.6 GB RAM,
  2 GB swap, TZ Asia/Colombo). No domain or Cloudflare yet; the names are sslip.io names with
  Let's Encrypt certs issued by Caddy.
- **Sites on the host:**

  | Site | URL | systemd unit | Port | `NODE_ENV` | Turso DB |
  | --- | --- | --- | --- | --- | --- |
  | Production | `https://204-13-236-153.sslip.io` | `natex` | 4200 | production | `natex-prod-us` |
  | Demo | `https://demo.204-13-236-153.sslip.io` | `natex-demo` | 4201 | development | `natex-demo-us` |
  | Uptime Kuma | `https://status.204-13-236-153.sslip.io` | docker `uptime-kuma` | 127.0.0.1:3001 | — | — |

- **Database region:** both DBs are in Turso group `useast` (`aws-us-east-1`, Virginia), next
  to the VPS. They were first created in Mumbai (`aws-ap-south-1`); from New Jersey that cost
  about 1 s per DB round trip (Virginia: 0.06–0.1 s) and caused timeouts and `ECONNRESET` in the
  test suite. They were recreated in Virginia on 2026-10-04 (the production DB was empty apart
  from the bootstrap). The old Mumbai DBs `natex-prod` / `natex-demo` are unused.
- **The demo site is public and anyone can sign in as any demo user.** It runs in development
  mode, so sign-in OTP and MFA codes are returned to the browser and the login page lists the
  demo accounts. Only dummy data may ever go into `natex-demo-us`. Caddy sends
  `X-Robots-Tag: noindex, nofollow` for it. It shares the S3 bucket with production (open item).
- **Layout** (files kept in `deploy/` in this repo):

  | What | Where |
  | --- | --- |
  | App checkout (user `natex`), shared by both sites | `/opt/natex` |
  | Environment (root:natex 640) | `/etc/natex/natex.env`, `/etc/natex/natex-demo.env` |
  | App services | `natex.service`, `natex-demo.service` (systemd, `Restart=always`) |
  | Edge, TLS, HTML security headers | Caddy, `/etc/caddy/Caddyfile` (= `deploy/Caddyfile`) |
  | Uptime Kuma | docker `uptime-kuma`, image `louislam/uptime-kuma:2` (v1 is unmaintained), volume `uptime-kuma`. Update: `docker pull louislam/uptime-kuma:2`, then recreate the container with the same flags. v1 data backup: `/var/backups/uptime-kuma/`. |
  | Deploy script | `/usr/local/bin/natex-deploy` (= `deploy/natex-deploy.sh`) |
  | Deploy state and log | `/var/lib/natex/{good,held,deploy.log}` |

- **Firewall:** ufw denies all incoming except 22/tcp, 80/tcp, 443/tcp+udp. Ports 4200, 4201
  and 3001 are not reachable from outside (checked 2026-10-04); Caddy is the only way in, so
  the client-IP headers below cannot be forged.
- **Auto-deploy:** `natex-deploy.timer` runs `natex-deploy` 2 minutes after each run finishes.
  It fetches `origin/main` and does nothing if the commit is already live. Otherwise it
  resets the checkout, runs `bun install --frozen-lockfile` (3 tries) and `vite build`, then
  restarts `natex` and, if installed, `natex-demo`. It then polls production
  `/api/health/ready` for 60 s and **rolls back** to the last good commit if readiness fails.
  The repo must stay public, or the VPS needs a read-only deploy key.
- **Schema changes are held:** a commit that touches `src/api/database/schema*` is not
  deployed. The log says `HELD <sha>`. An operator then takes the decision by hand:
  `sudo natex-deploy --with-schema` (backup drill, `drizzle-kit push --force` on production
  and then on the demo DB, build, restart). `sudo natex-deploy --force` redeploys the current
  `main` without a schema push.
- **Watch a deploy:** `journalctl -u natex-deploy -f` or `tail -f /var/lib/natex/deploy.log`.
- **App logs:** `journalctl -u natex -f` (demo: `-u natex-demo`).
- **Backups:** none scheduled yet (section 2).

### Demo data (demo DB only)

Rebuild the demo from scratch, from `packages/web`, with **only** the demo env loaded (check
that `DATABASE_URL` contains `natex-demo` first). Every script below refuses
`NODE_ENV=production`, but none of them knows which database it points at:

1. `bunx drizzle-kit push --force` — schema.
2. `bun src/api/database/seed.ts` — base seed: branches, users with dev MFA, merchants, zones,
   a few live parcels. **Destructive.**
3. `SEED_API=https://demo.204-13-236-153.sslip.io bun scripts/seed-m4.ts` — one merchant's
   money trail (COD, deposits, settlement, invoice, credit notes, disputes).
4. `bun scripts/seed-demo-history.ts` — 30 days of finished parcels for the charts
   (AWB prefix `NX71`, idempotent, no ledger rows).
5. `SEED_API=… bun scripts/seed-demo-live.ts` — today's work in progress through the API:
   bookings, a dispatched run per hub with PODs and open NDRs, an in-transit linehaul.

The smoke, probe and UI scripts write test fixtures (bulk-booking CSVs, "UI Ops Fixture"
parcels) into whatever DB they run against. Run them against the demo only when a rebuild
afterwards is acceptable, and never against production.

### Production pre-live transactional-data cleanup

`packages/web/scripts/purge-production-test-data.ts` is a one-time operator script; its live target
is pinned to the independently verified Production Turso hostname, and `local-test` mode accepts
only `file:` SQLite. It is not exposed through an API and defaults to a read-only plan. First take and
restore-verify a fresh backup, then run `bun scripts/purge-production-test-data.ts --target=production --plan`
from `packages/web`. Review the exact counts, parcel statuses, row-content digests, and plan hash with
the owner. This script has no test marker or date filter: it deletes every row in its allowlist,
including genuine activity if any is present. Stop only `natex` during the approved window, recheck the
plan hash, then use `--apply`
with `--confirm-production-clear`, the independently verified Production database fingerprint,
and the reviewed plan hash. Restart `natex` and confirm readiness afterward. Never point this
script at Demo or use the general seed script for a live reset.

The apply performs the historical parcel-number tombstone backfill and approved transactional
deletions in one write transaction, then verifies before commit. It preserves branches, users, MFA
factors/recovery codes, merchants and merchant payout details, every rate-card version/band/slab/
surcharge, AWB batches/labels/series, HR employee/package/APIT/leave setup, notification templates,
configuration, delivery reason codes, append-only audit history, and authentication OTP SMS logs.
It deletes every row in its explicit COD/finance, parcel/custody/delivery/freight/transport, HR
transaction, sync/session, outbox/replay allowlists, and every SMS log except authentication OTP.
That includes historical POD and legacy notification messages. The plan hash binds
per-table row-content digests for both deleted and preserved data, without printing record contents;
the same digests are written to the reset audit event. Deleting refresh sessions requires staff to
sign in again; a database reset does not erase uploaded files or app-local caches. If any row content,
counts, parcel statuses, or preserved setup differs from the reviewed plan, the script aborts or rolls
back without committing.

### Proxy / edge (required)

- **The app must sit behind the hosting edge (Cloudflare or equivalent).** Per-IP
  rate limits take the client IP from `cf-connecting-ip`, then `x-real-ip`, then
  the **rightmost** `X-Forwarded-For` hop (`middleware/rate-limit.ts`
  `clientIp`). The edge overwrites those headers. A server exposed directly can
  be sent any of them and every per-IP bucket becomes per-request. The per-user
  and per-phone buckets still hold either way.
- **API responses** carry nosniff, `X-Frame-Options: DENY`, `Referrer-Policy:
  no-referrer`, CORP, `Content-Security-Policy: default-src 'none';
  frame-ancestors 'none'`, HSTS and `Cache-Control: no-store`
  (`middleware/security-headers.ts`).
- **HTML pages get no security headers from the app.** The static server
  (`src/__server.ts`) is template-managed and cannot be edited. Set these at
  the edge for `/*`: HSTS; `X-Content-Type-Options: nosniff`;
  `X-Frame-Options: DENY` (or CSP `frame-ancestors 'none'`); `Referrer-Policy:
  strict-origin-when-cross-origin`; a CSP of at least `default-src 'self';
  img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'` (test
  the QR code on `/security` and POD photos after enabling it).
- CORS reflects the request origin with credentials. This is template-managed
  (`__core/app.ts`). It is not exploitable as built, because auth is a bearer
  token in `localStorage`, not a cookie, so a foreign origin has no ambient
  credential to ride. If auth ever moves to cookies, this must change first.

### Merchant registration website and request review

The public website submits to `merchants.submitRegistration` at the Production API origin.
Submission is unauthenticated but validated, throttled by IP and destination phone, and protected
against duplicate retries. It returns only a received acknowledgment, never an applicant's record.
The public form requires consent for the two one-time registration SMS updates.

Administrators review applications under **Merchants → Merchants Requests**; the red bell/count
indicates new requests. Opening a request allows **Onboard as merchant**, which prefills the existing
onboarding dialog. Staff complete the pickup address, branch, rate card and any portal login details.
Saving atomically creates the merchant and links/converts the request. Converted requests cannot
be onboarded a second time, and their original application remains available for reference.

Production registration queues only the owner-approved receipt and acceptance messages from sender `NatEx`.
The acceptance message is queued only after successful onboarding. The SMS uses the submitted
applicant number, not an arbitrary replacement contact number chosen during onboarding. Gateway
acceptance is not proof of handset delivery. Demo must keep `SMS_DISABLE_ALL=true`; never send a
real test SMS as part of a release check. Registration jobs are also independently disabled outside
Production, so Demo applications do not contact applicants.

The standalone website remains a static hosting package; no DB tokens or gateway secrets belong
in it. Its hosting CSP must allow the NatEx API origin in `connect-src`. Upload compiled assets first
and `index.html` last, preserving local media and SPA route support for `/merchant-enrollment`.

### Branch lifecycle, optional GPS and employee numbers

Administrators use **Administration → Branches → Deactivate / Reactivate**. Deactivation retains
the branch code, users and historical operational records. Inactive branches disappear from new
assignment choices, and new bookings, user/merchant assignments, bags, trips and tracking-label
allocations are rejected at inactive locations. Existing history remains readable. Deactivating
a branch does not delete its accounts or silently move existing shipments to another location.

Branch creation and editing do not require latitude or longitude. Unknown values are stored as
NULL; edit omissions retain existing values and clearing the inputs removes the saved coordinates.
GPS lookup excludes unlocated branches. Route ordering with no branch GPS starts at the first
located booked stop, leaves the unknown origin leg NULL, and identifies its partial-distance
estimate as `nearest_neighbour_js_unknown_origin` rather than inventing a coordinate.

New HR employee records receive immutable server-assigned numbers: `N26002`, `N26003`, and so on.
`N26001` is reserved; existing `N26001`, legacy `2055` and historical payroll snapshots are unchanged.
The fixed `N26` sequence uses the unique employee-code constraint to arbitrate concurrent creates.
Creation retry through the normal idempotent mutation returns the original created employee.

### Failed-delivery SMS

When a new failed doorstep attempt uses a reason configured to notify the consignee, the
`parcel.delivery_failed` template follows WhatsApp → SMS → Push. SMS is enabled only for this
template (and POD confirmation); other generic parcel-status templates remain blocked from SMS.
The approved failure copy includes the AWB, attempt number, public reason, the NatEx support
number `0772772708`, and the tracking URL. A failed delivery job is retried by the outbox up to
five times; inspect `notify_message` and `shared_sms_log` before any manual replay to avoid
duplicate messages. Gateway acceptance is not proof of handset delivery.

### Receiver reschedule SMS

On the NDR queue, successfully saving **Reattempt** or **Address change** with a new attempt date
queues the receiver notice in the same transaction as the saved schedule. The message uses the
corrected receiver phone when supplied, the tracking number, the date and a short public delivery
reason label. Internal notes, addresses and names are never copied into SMS. The format is
`NatEx: Tracking {number}. Delivery rescheduled to {YYYY-MM-DD}. Reason: {reason}.`
Messages are ASCII/GSM-7, limited to one SMS, and never contain tracking links.

The persistent schedule key and send state suppress replays; canceled/resolved schedules cannot
send pending notices. Demo and the independent SMS-disable flag suppress gateway calls. A job
interrupted after its one-time send claim is not blindly resent: check the SMS log before any
operator intervention, since gateway acceptance is not proof of handset delivery. No booking,
out-for-delivery, generic status, sender or RTO SMS is enabled by this change.

---

## 2. Backup and restore

`packages/web/scripts/backup-drill.ts` does a full backup and a verified restore in one run:

```bash
cd packages/web && bun --env-file=../../.env scripts/backup-drill.ts            # keep dump + manifest
cd packages/web && bun --env-file=../../.env scripts/backup-drill.ts --discard  # delete dump + manifest
```

The scratch restore uses Python 3's standard SQLite driver, executing complete statements rather
than repeatedly parsing the whole dump. Python 3 is required on the operating host. This affects
only the throwaway local restore database; all existing integrity, foreign-key, content-hash and
tamper checks remain. The 2026-11-05 pre-release drills restored Production's 162,299 rows in
4.8 seconds and Demo's 56,226 rows in 1.1 seconds. Both passed and were checksum-verified off-host.

- **Backup:** every table is dumped inside one libsql read transaction (a
  consistent snapshot) to `/tmp/natex-backups/natex-<stamp>.sql.gz`, plus a
  manifest of per-table row counts and SHA-256 hashes. In production, change
  the output directory to durable storage and copy the file off the host.
- **Restore:** the dump is replayed into `/tmp/natex-restore-<stamp>.db`. Then
  the drill runs `PRAGMA integrity_check`, `PRAGMA foreign_key_check`,
  per-table row counts and hashes against the manifest, and row spot checks.
  It also runs a tamper self-test: it corrupts one row on purpose and checks
  that verification catches it.
- **Measured 2026-10-03 (dev data):** 57 tables, 3 541 rows, 354 KiB gzipped.
  Backup took 9.2 s and restore 2.5 s. Integrity was ok, there were 0 FK
  violations, and 57/57 table hashes matched. Times scale roughly with rows;
  re-measure on production volume.
- **Restoring for real (UNVERIFIED):** the drill has only ever restored into a
  local SQLite file, never into a hosted Turso database. The intended recipe is
  to create a new Turso DB, replay the dump into it (`gunzip` it, then
  `turso db shell <new-db> < natex-<stamp>.sql`), point `DATABASE_URL` at it,
  restart, and check readiness. Rehearse this once on a scratch Turso DB before
  relying on it. Keep the old DB until the nightly COD invariant (section 6
  below) runs clean on the new one.
- Turso's own point-in-time restore is the first resort. The drill is the
  independent copy.
- **Cadence (proposed, not decided):** a nightly dump plus one before every
  release, with a quarterly restore drill.

---

## 3. Accounts, MFA and sessions

- **Sign-in:** phone OTP (5-minute code, 5 wrong attempts burn the challenge).
  Ops, admin and finance then enter a TOTP code (§2). Merchants, riders and
  transport do not use TOTP.
- **Lost phone / locked out of TOTP:** the user first tries one of their 10
  single-use recovery codes. Failing that, **another admin** opens Admin →
  Users → the user → *Reset authenticator*. That revokes all their sessions,
  and they enrol again at next sign-in. An admin cannot reset their own factor,
  by design. With one admin, keep their recovery codes offline.
- **Suspend a user:** Admin → Users → *Suspend*. Effective immediately: the
  live access token is refused on the next request, because every request
  re-reads the user row. Refresh tokens are revoked and new OTPs are refused.
- **Session policy** (Admin → Settings, audited):
  - **Portal idle timeout:** 720 min by default, range 30–10 080. Applies to
    the ops, admin, finance and merchant portals. Riders and transport are
    exempt because their apps are offline-first (§7).
  - **Absolute session lifetime:** 30 days by default, for every role.
  - **MFA enforced:** on by default. Turning it off is a recorded policy
    exception.
- **Kill every session:** rotate `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`
  and restart. Refresh tokens are hashed at rest, so a DB leak does not leak
  them.
- **Rate limits:**
  - OTP request: 5 per IP, refilling 1/min, **and** 5 per destination number,
    refilling 1 per 5 min.
  - OTP verify: 10 per IP.
  - MFA code entry: 5 per user, refilling 2/min.
  - Every authenticated write: per user and per IP (route-specific).
  - A locked bucket refills on its own. To clear one by hand for a stuck user:
    `DELETE FROM shared_rate_limit WHERE bucket LIKE '%<phone-or-user>%'`.

---

## 4. Rate cards

- The rate-card engine is built: weight bands, zones, versions, a draft →
  publish flow, frozen published versions, assignment per merchant, and quote.
- **Owner-approved standard schedule (deployed and active in production and
  demo on 2026-10-11; `NATEX-STANDARD-2026`, v1):** Rs
  400 up to 1 kg; add Rs 250 per started extra kg above 1 through 3 kg; add Rs
  150 per started extra kg above 3 through 10 kg; add Rs 130 per started extra
  kg above 10 through 30 kg. Same prices apply local/outstation and
  COD/non-COD. Existing 500 g rounding and 5,000 cm³/kg volumetric divisor are
  retained; no surcharge was specified. Maximum chargeable weight is 30 kg;
  larger parcels must be rejected. This is one common tariff because every
  supplied category has the same price.
- **Runtime booking ceiling:** Admin → Settings → Business rules → *Maximum
  chargeable parcel weight*. Admin-only, reason-required and audited; accepts
  0.5–30 kg in 0.5 kg steps. It limits the greater of actual and volumetric
  weight for new Merchant, staff and Counter bookings/quotes; existing parcels
  and the approved tariff prices are unchanged. The server remains authoritative.
  Once this feature is deployed with the updated Merchant app, the app refreshes
  the value automatically (about every 30 seconds while open) and retains the
  last-known value for offline display; later value changes do not require a new
  APK. The configured ceiling cannot exceed the tariff's 30 kg coverage.
- **Current live status:** production has one active standard card assigned to
  all 4 current branches and 4 merchants; demo has one assigned to all 3 current
  branches and 3 merchants. The original production (3) and demo (1) placeholder
  card/version records remain unchanged for history; never hard-delete them.
- **To publish a card** (admin): Admin → Rate cards → card → *New draft*, edit
  bands, then *Publish* with a reason. The previous version is superseded,
  never edited. Then assign it to a merchant from Ops → Merchants → merchant.
- **Owner-approved NatEx standard setup:** the initial production/demo apply
  completed on 2026-10-11. The idempotent utility remains available for a
  read-only inspection or safe reconciliation; run
  `bun scripts/apply-standard-rate-card.ts --target=production` in the production
  service environment to inspect the plan (read-only remote queries; no writes).
  Before applying, independently capture the database fingerprint from the exact
  service environment with `--target=production --print-database-fingerprint`.
  Apply only with `--target=production --apply --confirm-production
  --expected-database-sha256=<verified-fingerprint>`; use the demo service and
  `--target=demo --apply --confirm-demo` with demo's separately verified
  fingerprint. Fingerprint-only mode does not query the database. The command
  validates the exact tariff, refuses conflicting non-placeholder assignments,
  batches each mutation with its audit row, and preserves all old cards and
  versions. It requires the target's existing `DATABASE_URL`/
  `DATABASE_AUTH_TOKEN` environment; never print those values.
- **Walk-in Counter pricing:** separately open Admin → Branches → edit each
  branch/hub and assign a published, non-placeholder Counter rate card. Counter
  quotes use the `local` band when origin and destination districts match, and
  `outstation` otherwise. The branch address must include its structured
  district/province. A missing or incomplete card blocks Counter booking;
  booking snapshots the displayed card version and calculated charge. This
  setting does not change Merchant booking prices or COD. Merchant card
  assignment currently supports rate quotes; merchant parcel booking does not
  automatically create a freight charge from that quote.
- **VAT/SSCL (§15 q10 — OPEN):** the tax calculation exists and is seeded off.

---

## 5. Monitoring

### Readiness probe

`GET /api/health/ready` is unauthenticated and returns states only:

```json
{"status":"ok","db":"ok","worker":"ok","nightly":"ok","checkedAt":"…"}
```

- It returns **503** with `"status":"down"` if the DB is unreachable (3 s
  budget), the outbox worker has not ticked in max(3 polls, 60 s), or the
  nightly scheduler is stopped. `db:"slow"` (over 1.5 s) still returns 200.
- `GET /api/health` (template) only proves the process answers.

### Uptime Kuma — running, **monitors not set up yet**

Kuma v2 runs on the VPS at `https://status.204-13-236-153.sslip.io` (section 1). It still
needs its admin account and these monitors:

| Monitor | Type | Target | Settings |
| --- | --- | --- | --- |
| NatEx ready | HTTP(s) – Keyword | `https://204-13-236-153.sslip.io/api/health/ready` | keyword `"status":"ok"`, interval 60 s, retries 2, accepted 200 |
| NatEx web | HTTP(s) | `https://204-13-236-153.sslip.io/` | interval 300 s |
| Nightly invariant | Push | Kuma push URL | heartbeat 26 h. Put the push URL in `KUMA_PUSH_URL` in `/etc/natex/natex.env` and restart `natex`. `jobs/nightly.ts` then pushes `up` after a clean run and `down` after a breach. Unset, nothing is sent. |

Alerting goes to whatever channel Kuma is given (SMS, email, Slack). A
readiness failure means: check DB status at Turso first, then the worker
(section 7 below).

### Sentry — **not wired, blocked on a DSN**

- **One hook point:** `src/api/shared/report-error.ts` `reportError(err,
  {route, requestId})`. It is called from `middleware/request-id.ts` for every
  unhandled (5xx) API error, and currently does `console.error`.
- **To wire it:**
  1. `bun add @sentry/bun` in `packages/web`.
  2. Initialise once with `SENTRY_DSN` and `environment: process.env.NODE_ENV`.
  3. In `reportError`, call `Sentry.captureException(err, { tags: { route },
     extra: { requestId } })`.
  4. Do **not** send request bodies: they carry phone numbers and bank details
     (§9 PDPA). Set `sendDefaultPii: false`.
- **Web client:** use `@sentry/react` in `src/web/main.tsx` with the same
  rule. This is optional for the pilot.
- `src/api` must not import `node:*` (mobile and desktop typecheck it).
  `@sentry/bun` is imported only inside `report-error.ts`. If that breaks the
  mobile typecheck, load it with a dynamic `import()`.

### Job monitor (Admin → System monitor)

- **Health:** DB latency, uptime, worker (running, last tick, last OK, last
  error), nightly scheduler, outbox summary and the last 7 invariant runs.
- **Jobs:** outbox rows by topic and state. A **failed** job can be retried
  (`monitor.retryJob`, audited). Before retrying a job that sends SMS,
  check `notify_message` and `shared_sms_log`: a job that failed *after* the
  gateway accepted the message would send it twice.
- **Invariants:** nightly COD invariant runs and their findings.

---

## 6. Nightly COD invariant (§8)

- An in-process scheduler (`jobs/nightly.ts`) replaces BullMQ's repeatable job.
  It runs once per Colombo day at the first tick on or after
  `NIGHTLY_INVARIANT_HOUR` (default 23). It checks that the ledger,
  rider-cash, deposit and settlement totals agree to the cent, and raises a
  COD alert on any break.
- **Manual run:** Finance → COD ledger → *Invariant* tab → *Run now*.
- **A break is a money incident:** freeze settlement approvals for the affected
  merchants (place a hold), then reconcile from Finance → COD ledger →
  *Reconciliation* tab.
- Because it is in-process, **it only runs while the web server is up**. If the
  server is down at 23:00, the run happens at the next tick after restart
  (same day only). Uptime Kuma's push monitor (section 5) is how a missed night
  becomes visible.

---

## 7. Incidents

1. **Confirm:** check readiness, Admin → System monitor, and the server log (each
   error line carries a `requestId`; the same id is in the client's problem
   response and in `shared_audit_log.request_id`).
2. **DB unreachable or `ECONNRESET` storms:** reads already retry twice on
   transient resets. Writes never auto-retry; clients retry with the same
   Idempotency-Key, so nothing is double-applied. Check Turso status. If an
   outage is prolonged, the rider and transport apps keep working offline and
   sync later (§7).
3. **Worker stalled:** a restart restarts it. Check Monitor → Jobs for a topic
   failing repeatedly, then fix and *Retry*.
4. **Suspected account compromise:** suspend the user (immediate), then
   reset their authenticator. Review Admin → Audit log filtered by actor.
5. **Suspected token-secret leak:** rotate both JWT secrets and restart.
   Everyone signs in again.
6. **Bad data change:** the audit log is append-only and shows before/after
   (bank accounts masked to the last 4). Correct with a new, reasoned change,
   never by editing history.
7. **Restore** only after the above. Follow section 2.

---

## 8. Capacity (load test, 2026-10-03)

`scripts/load-test.ts` (`--stage-seconds`, `--levels`) — authenticated
**read** mix (boards, lists, finance pages, quote), 20 s per stage, against
the Vite dev server and hosted Turso:

| Concurrent users | req/s | p95 | errors |
| --- | --- | --- | --- |
| 5 | 25.4 | 286 ms | 0 |
| 20 | 81.2 | 368 ms | 0 |
| 50 | 83.0 | 937 ms | 0 |
| 100 | 85.4 | 1 858 ms | 0 |

- Throughput levels off at about 85 req/s from 20 users up. Extra users only
  add queueing latency.
- **Probable cause (not confirmed):** the libsql HTTP client's default
  concurrency of 20. Baseline latency (~150–210 ms per call) is Turso
  round-trip from this sandbox.
- **Caveats:** this was the dev server, not the production build. Reads only
  (writes were not load-tested). One sandbox generated the load. Re-run
  against the production deploy before go-live.
- For the pilot (3 branches): the field apps sync in batches, so ~85 req/s is
  well above expected load. That is an estimate, not a measurement.

---

## 9. Security review (2026-10-03)

- `scripts/security-review.ts`: 100 live probes covering tokens (alg:none,
  HS512 header, dev-key forgery, tampered body, expired, no-exp), the
  pending-MFA lockdown, the role matrix, merchant and branch scoping, rate
  limits, idempotency, suspended users, and surface checks (headers,
  readiness body, public tracking body, error bodies, webhook secret).
- `src/api/middleware/route-guards.test.ts` statically lists the guard on
  every one of the 219 procedures. The public surface is allow-listed at 5,
  and pending-MFA tokens at 4.
- Findings and fixes are listed in `task.md` → M5 → Security review.

## 10. Salary contribution display (2026-11-05)

Salary packages show read-only estimates of employee EPF, EPF Company contribution and ETF Company contribution from each component's existing contribution eligibility. Monthly packages estimate a full period before attendance/overtime/APIT adjustments. Daily/hourly packages show per-unit base-only estimates; their fixed recurring components are displayed separately and must not be interpreted as a monthly payroll total. Package estimates do not change the package or create payroll records.

In Salary operations, **Total earnings after staff EPF** means gross earnings minus the stored employee EPF deduction only. APIT and other employee deductions still reduce final **Net pay / take-home pay**. Company EPF and ETF are company-paid statutory costs: they are neither added to employee earnings nor deducted from net pay. The payroll table, run totals and printed payslip explicitly separate these company contributions. The display reuses the existing staff EPF 8%, company EPF 12% and company ETF 3% calculations; it does not change rates or statutory-base rules.

Payslips print the saved payroll line amounts and snapshot, including historical company contributions and final net pay, without recalculating approved records. This release does not alter payroll approval, payment, APIT validation or confidential HR access controls and requires no schema update. The contribution display regression suite is `bun test src/web/pages/hr/package-contributions.test.ts src/web/pages/hr/payroll-presentation.test.ts src/web/pages/hr/payslip.test.tsx src/api/modules/hr/calculations.test.ts src/api/modules/hr/validation.test.ts` from `packages/web`.
## 11. Operations branch board and merchant onboarding approvals (2026-11-05)

The Operations **Live board** shows the authenticated user's allocated/accountable branch and enforces that scope in parcel queries, status totals, throughput, recent custody events and today's runsheet totals. Search or a supplied branch filter cannot widen an Operations user's allocation. Missing allocation produces an empty scope, not network-wide results. Admin/global reads keep their existing network access. Custody events join directly to scoped parcels, so the feed is no longer truncated by a preliminary 500-parcel selection.

In **Book a parcel**, open the Merchant selector and type a merchant name. The searchable picker uses only authorized, active merchant options and preserves the current selection while filtering. COD-disabled labels, native required-field validation and existing server booking checks remain. Arrow keys, Home/End, Enter and Escape navigate the popup; loading, failure and no-result states are explicit. Pricing and tracking-sticker validation are unchanged.

Operations **Merchants → Add merchant → Submit for approval** records an internal onboarding request in `merchants_onboarding_request`, pinned to the authenticated staff member's branch. It does not create an active merchant, portal user or SMS job. Operations can track requests for their branch under **Onboarding approvals**. Admin sees the network-wide pending count, reviews the request, and uses **Approve & onboard** to open the existing onboarding modal with submitted merchant/contact/address/rider details prefilled and the source branch locked. Admin completes the remaining tariff/login details and saves. Canceling does not approve anything.

Final Admin approval creates the merchant, any selected rate-card assignment and portal login, updates the request's approver/status/merchant link, and writes the redacted approval audit in one transaction. Audit failure rolls back all those changes; concurrent/repeated approvals cannot create a second merchant. Operations cannot directly create an active merchant or turn an unapproved legacy status into active by first suspending it. Existing active/suspended merchant management and the separate public website registration/SMS-consent workflow remain unchanged. Staff-created requests introduce no new SMS purpose or automated message.

The initial delivery was Git-only on `feature/operations-branch-merchant-approval-20261105`. On 2026-11-06 the owner authorized main publication and Production + Demo deployment of these features together with the system-icon update, using fresh restore-verified/off-host backups and `--with-schema`. The schema change adds only `merchants_onboarding_request` and its indexes; rehearse it on both restored backups and verify existing table contents before live application. Keep Demo `SMS_DISABLE_ALL=true`. Scoped local validation covers board allocation/tampered filters, request access and approval rollback/replay/audit, public registration regressions, searchable picker interaction and structured-address prefill. All test databases are scratch SQLite files, not deployed databases.

The system browser favicon and Apple shortcut icon reuse the existing public website artwork, with ICO fallback, 16px/32px PNG icons and the 180px Apple icon. HTML icon links use the `20261106` version token to request the new artwork rather than an old cached favicon. The initial title is **NatEx**; the already-matching login/sidebar wordmark and Android APK icons are unchanged. This asset change has no database or authentication effect.

## 12. NatEx green icon refresh (2026-11-10)

The owner-supplied green NatEx mark now replaces the website favicon, site-shell/login/receipt mark, and the official field app's launcher, adaptive, splash, login and web-favicon artwork. Web icons include ICO, 16px/32px PNG and a 180px Apple touch icon; HTML links use the `20261110` cache token. The Android adaptive foreground is transparent and scaled within the safe area over a white background. Merchant-app branding remains separate and unchanged. No database or authentication behavior changes; a new field-app build must be installed for the native launcher/splash icon update to appear on devices.
