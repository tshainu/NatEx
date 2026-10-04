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
| `SMS_EXECUTION_URL`, `SMS_SENDER_ID`, `SMS_DLR_WEBHOOK_SECRET` | yes for live SMS | Unset gateway ⇒ messages are logged to `shared_sms_log` and never sent. |
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

- **Host:** InterServer VPS `204.13.236.153` (Ubuntu 26.04, 1 vCPU, 1.6 GB RAM, 2 GB swap,
  TZ Asia/Colombo). Public URL `https://204-13-236-153.sslip.io` (sslip.io name, Let's
  Encrypt cert from Caddy). No domain or Cloudflare yet.
- **Database:** Turso `natex-prod` (group `default`, `aws-ap-south-1`), separate from dev.
- **Layout** (files kept in `deploy/` in this repo):

  | What | Where |
  | --- | --- |
  | App checkout (user `natex`) | `/opt/natex` |
  | Environment (root:natex 640) | `/etc/natex/natex.env` |
  | App service, port 4200 | `natex.service` (systemd, `Restart=always`) |
  | Edge, TLS, HTML security headers | Caddy, `/etc/caddy/Caddyfile` (= `deploy/Caddyfile`) |
  | Uptime Kuma | docker `uptime-kuma`, `127.0.0.1:3001`, `https://status.204-13-236-153.sslip.io` |
  | Deploy script | `/usr/local/bin/natex-deploy` (= `deploy/natex-deploy.sh`) |
  | Deploy state and log | `/var/lib/natex/{good,held,deploy.log}` |

- **Firewall:** ufw denies all incoming except 22/tcp, 80/tcp, 443/tcp+udp. Port 4200 listens
  on all interfaces but is not reachable from outside (checked 2026-10-04); Caddy is the only
  way in, so the client-IP headers below cannot be forged.
- **Auto-deploy:** `natex-deploy.timer` runs `natex-deploy` 2 minutes after each run finishes.
  It fetches `origin/main` and does nothing if the commit is already live. Otherwise it
  resets the checkout, runs `bun install --frozen-lockfile` (3 tries) and `vite build`, then
  restarts `natex`. It then polls `/api/health/ready` for 60 s and **rolls back** to the last
  good commit if readiness fails. The repo must stay public, or the VPS needs a read-only
  deploy key.
- **Schema changes are held:** a commit that touches `src/api/database/schema*` is not
  deployed. The log says `HELD <sha>`. An operator then takes the decision by hand:
  `sudo natex-deploy --with-schema` (backup drill, `drizzle-kit push --force`, build, restart).
  `sudo natex-deploy --force` redeploys the current `main` without a schema push.
- **Watch a deploy:** `journalctl -u natex-deploy -f` or `tail -f /var/lib/natex/deploy.log`.
- **App logs:** `journalctl -u natex -f`.

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

---

## 2. Backup and restore

`packages/web/scripts/backup-drill.ts` does a full backup and a verified restore in one run:

```bash
cd packages/web && bun --env-file=../../.env scripts/backup-drill.ts            # keep the restore DB
cd packages/web && bun --env-file=../../.env scripts/backup-drill.ts --discard  # delete it afterwards
```

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

## 4. Rate cards (§15 q3 — OPEN)

- The rate-card engine is built: weight bands, zones, versions, a draft →
  publish flow, frozen published versions, assignment per merchant, and quote.
- **Every seeded rate (`rtc_pilot_placeholder`) is a PLACEHOLDER.** No merchant
  has a card assigned. §15 q3 (rate-card structure) is unanswered, so invoices
  do not price freight automatically. The COD fee is bundled into the delivery
  rate and held at 0 in `cod_finance_config` (answered 2026-09-30).
- **To publish a card** (admin): Admin → Rate cards → card → *New draft*, edit
  bands, then *Publish* with a reason. The previous version is superseded,
  never edited. Then assign it to a merchant from Ops → Merchants → merchant.
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

### Uptime Kuma — config ready, **blocked on a Kuma host**

| Monitor | Type | Target | Settings |
| --- | --- | --- | --- |
| NatEx ready | HTTP(s) – Keyword | `https://<host>/api/health/ready` | keyword `"status":"ok"`, interval 60 s, retries 2, accepted 200 |
| NatEx web | HTTP(s) | `https://<host>/` | interval 300 s |
| Nightly invariant | Push | Kuma push URL | heartbeat 26 h. Needs a one-line `fetch(KUMA_PUSH_URL)` after a completed run in `jobs/nightly.ts` `nightlyTick`. **Not added**, because there is no URL to call yet. |

Alerting goes to whatever channel Kuma is given (SMS, email, Slack). A
readiness failure means: check DB status at Turso first, then the worker
(section 7 below).

### Sentry — **not wired, blocked on a DSN**

- **One hook point:** `src/api/shared/report-error.ts` `reportError(err,
  {route, requns while the web server is up**. If the
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
n-secret leak:** rotate both JWT secrets and restart.
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
