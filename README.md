# NatEx — courier & logistics platform (Sri Lanka)

Implementation of the NatEx specification in `PROJECT.md`. Section references
below (§4, §10, …) point at that document, which is the source of truth for
scope, domain rules and milestone order. Operations (deploy, backup, MFA
resets, monitoring, incidents) are in **[RUNBOOK.md](RUNBOOK.md)**; the
build log with every verification run is `task.md`.

**Milestones 1–5 are built and verified** against the live API and database:

| Milestone | Scope (§10) |
| --- | --- |
| M1 Core & Collection | Booking, pickup manifests, two-party handover, origin-hub receipt, the §6 state machine |
| M2 Transport & Custody | Bags, seals, linehaul trips, destination-hub receipt with variances, custody timeline |
| M3 Delivery & Merchant | Runsheets, POD (OTP/photo/signature), failures and NDR, RTO, offline sync (§7), rider + transport app, merchant portal and bulk booking |
| M4 Money | COD ledger, rider cash and deposits, four-way reconciliation, settlements with maker–checker, holds, payout file, invoices and credit notes, AR, disputes and claims, finance portal |
| M5 Admin & Hardening | Admin portal (users, roles, branches, zones, rate cards, merchant onboarding), SLA/business settings, notification template editor, audit viewer, TOTP MFA + session policy, job monitor, readiness probe, backup/restore drill, load test, security review, runbook |

Nothing is stubbed with fake data. Two things are deliberately **not** final
because the client has not answered them — see [Open questions](#open-questions-15).

---

## Running it

```bash
bun install
bun run db:push                       # schema
cd packages/web && bun run db:seed    # DEV ONLY — destructive, creates dev MFA factors
bun run dev                           # web + API on :4200
bun run dev:mobile                    # rider/transport Expo app on :4300
```

| Command (from `packages/web` unless noted) | What it does |
| --- | --- |
| `bun run typecheck` (root) | web, mobile, desktop |
| `bun run lint` (root) | project lint rules |
| `bun run test` | unit + DB tests (1 423 at the M5 close) |
| `bun --env-file=../../.env scripts/<name>.ts` | any regression script below; needs `bun run dev` running |

Ports are fixed by the platform in `__ports.cjs`: web `4200`, mobile `4300`,
desktop `4400`.

### Configuration

Root `.env` (template: `.env.template`). Full table with consequences in
RUNBOOK.md section 1. The ones that matter:

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | **Must be `production` in production.** Only `development`/`test` enable dev conveniences (`shared/env.ts`, fails closed). |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Token signing. Outside development the server refuses to sign or verify without them. |
| `MFA_ENCRYPTION_KEY` | AES-256-GCM key material for TOTP secrets at rest. Changing it invalidates every enrolled authenticator. |
| `SMS_EXECUTION_URL`, `SMS_SENDER_ID`, `SMS_DLR_WEBHOOK_SECRET` | SMS gateway (§9). Unset ⇒ messages logged to `shared_sms_log`, never sent. |
| `NIGHTLY_INVARIANT_HOUR`, `NIGHTLY_TICK_MS` | Nightly COD invariant: default 23 (Asia/Colombo) and 300 000 ms. |
| `OUTBOX_POLL_MS` | Outbox worker interval, default 3000. |
| `SENTRY_DSN` | Reserved — not wired yet. |

### Signing in (development)

Phone + OTP (§7). Ops, admin and finance also enter a TOTP code (§2). In
development only, `identity.requestOtp` returns the SMS code as `devCode`, and
the seeded staff hold a development TOTP factor whose current code is returned
the same way, so every seeded user can sign in without an SMS gateway or an
authenticator app. Both are off whenever `NODE_ENV` is not `development`/`test`,
and a seeded dev factor is refused there.

| Role | Phone |
| --- | --- |
| Administrator | `+94773456789` |
| Finance | `+94774567890` |
| Operations | `+94772345678` (Colombo), `+94779012345` (Kandy) |
| Transport | `+94776789012` (Colombo), `+94777890123` (Kandy) |
| Rider | `+94771234567` (Colombo), `+94778901234` (Kandy) |
| Merchant | `+94775678901` (Ceylon Threads) |

Branches: `CMB01` Colombo Central, `CMBHUB` Colombo Main Hub — Peliyagoda,
`KDYHUB` Kandy Regional Hub.

### Session policy (Admin → Settings)

Access tokens live 15 minutes; refresh tokens rotate on every use with reuse
detection and are hashed at rest. A portal session (ops, admin, finance,
merchant) idle for 720 minutes must sign in again; riders and transport are
exempt because their apps are offline-first. Every session ends 30 days after
sign-in. Both are editable within safe ranges, as is MFA enforcement — every
change is audited with a reason.

---

## Known deviations from PROJECT.md

§2 of the specification names a concrete stack: Fastify 5, Prisma 6,
PostgreSQL 16 + PostGIS, Redis 7 + BullMQ 5, Socket.io, two Flutter apps,
Docker Compose — and explicitly forbids Drizzle and MongoDB. **This build does
not run on that stack.** The Runable sandbox provisions Bun + Hono +
Drizzle/Turso + Expo, and cannot run Postgres, Redis or a Flutter toolchain, so
the platform was substituted with the closest equivalent for each capability,
with the user's approval.

Each row below is a real behavioural difference, not a cosmetic one. Nothing
here is hidden behind an abstraction that pretends the specified component is
present.

| PROJECT.md specifies | Built as | What actually differs |
| --- | --- | --- |
| Fastify 5 + Zod | Hono + oRPC + Zod | End-to-end typed RPC instead of REST routes. Same validation, same RFC 7807 `application/problem+json` error envelope (§11). |
| Prisma 6 + PostgreSQL 16 | Drizzle ORM + Turso (SQLite) | No `CHECK` constraints on enums, no `SERIALIZABLE` transactions, no row-level locking. Invariants that Postgres would enforce are enforced in the module services instead — and are therefore only as good as the code path taken. |
| PostGIS `ST_Contains`, GiST index, `<->` | `shared/geo.ts`: bounding-box pre-filter then ray-casting point-in-polygon; Haversine for distance | Correct for the simple, non-self-intersecting zone polygons in use. Slower on large zone counts (linear scan, no spatial index) and it does not handle polygons with holes or antimeridian crossings. Distances are great-circle, not geodesic. |
| Redis 7 + BullMQ 5 | `shared_outbox` table + interval-polling worker (`jobs/worker.ts`), in-process | Transactional outbox semantics are preserved — a job is committed in the same transaction as the state change, so no event is lost. But: latency is the poll interval, not milliseconds; there is no separate worker process, no concurrency control, no delayed/repeatable jobs, and no dead-letter queue beyond an `attempts` column. |
| Socket.io live board | TanStack Query polling every 5s (`refetchInterval: 5_000`) | The ops board is up to five seconds stale instead of instant, and every client polls whether or not anything changed. |
| Two Flutter apps (rider, transport) | One Expo app with role-based tabs | Approved substitution. Both tab sets are built and were driven end to end in a browser against the live API. Metro in this sandbox does not resolve the `@/*` path alias (TypeScript does, so `tsc` passes while the bundler fails), and `metro.config.js` is template-managed and must not be edited — so every import inside `packages/mobile` is written relative instead of aliased. |
| Docker Compose + CI skeleton | `bun run dev` / `bun run build` | No containers and no CI. The M1 exit criterion "`docker compose up` runs the whole stack" cannot be met as written. |
| argon2id via `@node-rs/argon2` | argon2id via `hash-wasm` | Library swap only — same algorithm, same parameters. Not a behavioural deviation. |
| JWT + rotating refresh | HS256 via Web Crypto, rotating refresh with reuse detection | No deviation. |
| PostGIS-assisted route-order optimisation for delivery runsheets (§5, §10 M3) | JS nearest-neighbour sweep over stored microdegree points, recorded in `delivery_runsheet.route_method` | Greedy, not optimal: it produces a reasonable stop order, not a shortest tour, and it has no road network, no turn restrictions and no traffic. Stops with no stored coordinates are appended at the end in booking order. Distances are the same Haversine great-circle as above, so the `route_distance_metres` figure is a lower bound on real road distance. |
| WhatsApp Business API and push (Expo) as first-class notification channels (§9 ladder: WhatsApp → SMS → push) | Real senders in `modules/notifications/service.ts` that **fail closed** | No WhatsApp or push credentials exist in this sandbox. Each sender checks its env vars (`WHATSAPP_API_URL`, `WHATSAPP_TOKEN`, `EXPO_PUSH_URL`) and, when they are absent, writes a `notify_message` row with `state = "skipped"` naming the missing variable, then lets the ladder fall through to SMS. Nothing is silently dropped and nothing is faked as sent — but in practice every notification in this deployment goes out over SMS. |
| BullMQ repeatable job for the nightly COD invariant (§8) | In-process scheduler `jobs/nightly.ts`: ticks every `NIGHTLY_TICK_MS` (default 5 min), runs once per Colombo day at the first tick on/after `NIGHTLY_INVARIANT_HOUR` (default 23) | Only runs while the web server is up; a server down at 23:00 runs it at the next tick the same day, otherwise the night is missed (visible in Admin → Monitor → Invariants, and to the Kuma push monitor once wired). |
| Redis token bucket (§2) | `shared_rate_limit` SQLite table, same algorithm (`middleware/rate-limit.ts`) | Coarser under concurrency: two simultaneous requests can both read the last token. Buckets are per user, per IP and (OTP) per destination number. |
| Sentry + Uptime Kuma (§10 M5) | Readiness probe `GET /api/health/ready` and one error hook `shared/report-error.ts` | **Not connected** — blocked on a Sentry DSN and a Kuma host. Config and wiring steps in `RUNBOOK.md` section 5. |

Further gaps worth naming plainly:

- **The rider/transport app has not been tested on a physical phone.** It has
  been driven end to end in Expo web in a headless browser (`ui-rider`,
  `ui-rider-queue`, `probe-pod-photo`), not on Android/iOS hardware: camera,
  GPS, background sync and offline storage on a real device are unproven.
- **Google Maps / Mapbox geocoding (§9)** is not wired up. Serviceability
  resolves against the seeded zone polygons only.
- **HTML security headers** are not set by the app (the static server is
  template-managed); the API's are. Set the page headers at the edge — RUNBOOK.md section 1.
- **Load** was measured on the dev server with reads only: ~85 req/s ceiling,
  0 errors up to 100 concurrent users (RUNBOOK.md section 8).

---

## Open questions (§15)

- **q3 — rate card structure: OPEN.** The rate-card engine (bands, zones,
  versions, publish, assignment, quote) is built and configurable, but the
  seeded card `rtc_pilot_placeholder` is labelled PLACEHOLDER and **no
  merchant has a card assigned**. Invoices therefore do not price freight
  automatically. The COD-fee part was answered (2026-09-30): bundled into the
  delivery rate, held at 0 in `cod_finance_config`.
- **q10 — VAT / SSCL: OPEN.** The tax arithmetic on invoices exists and is
  seeded **off**. Rates and registration must come from the client's tax advisor.

---

## Layout

```
packages/web/
  src/api/
    index.ts                 router composition + SMS DLR webhook + readiness + security headers
    routes/<feature>.ts      oRPC procedures, one file per feature
    middleware/pipeline.ts   the §4 chain: request id → auth → idempotency → validation → rate limit → audit
    middleware/auth.ts       JWT + role gates (tagged; route-guards.test.ts inventories them)
    modules/<feature>/       the ONLY code that touches that feature's tables (§4)
    database/schema/         one file per module
    jobs/worker.ts           outbox drain        jobs/nightly.ts   nightly COD invariant
    shared/                  auth, errors, audit + redaction, totp, secret-box, codes, env, report-error
  src/web/                   React portals: ops, admin, finance, merchant, field + public tracking
  scripts/                   regression scripts (smoke-*, probe-*, ui-*), backup-drill, load-test, security-review
packages/mobile/             Expo rider + transport app (offline-first, §7)
packages/desktop/            Electron shell around the web app
```

Module boundaries from §4 are real: a service reads only its own feature's
tables and calls sibling modules through their exported functions.

### Conventions (§11) and hardening

- **Money** is integer cents everywhere; no float touches a monetary field.
  Times are stored UTC, rendered Asia/Colombo.
- **Append-only:** `parcels_event`, `transport_hub_scan`, the COD ledger and
  `shared_audit_log`. Corrections are new rows.
- **Idempotency:** every mutation takes an `Idempotency-Key`; a replay returns
  the stored response; the same key with a different body — or from a
  different user — is a 409.
- **Errors** are `application/problem+json` with a stable `type`.
- **Audit redaction** (`shared/redact.ts`): bank account numbers masked to the
  last 4, tokens/OTP/TOTP material dropped, CSV bodies replaced by their size —
  applied in `writeAudit` to every row.
- **Collision-safe document codes** (`shared/codes.ts`): 6 Crockford base32
  characters from the CSPRNG, re-minted on a UNIQUE violation.
- **Transient DB resets** (Turso `ECONNRESET`): a request is retried at most
  twice, and only if it never reached a write path (`shared/request-scope.ts`).
- **Least privilege:** desk-only reads (staff list, consignee messages, rate
  cards, settings, COD alerts, reconciliation) refuse riders and transport;
  money reads admit desks plus the merchant for its own rows only.

---

## Privacy (§9, PDPA No. 9 of 2022)

Consignee name, phone and address are personal data. The public tracking page
`/track/:awb` is reachable by anyone holding a tracking number, so
`parcels.publicTracking` returns a deliberately minimised payload: coarse
status, destination **locality** only, attempt count and timestamps. No
consignee name, no phone, no street address, no COD amount, no merchant
identity. `ui-check` asserts that page renders from that payload alone.

---

## Verification

§12: nothing is reported as implemented without being executed. The M5
closing regression — every script re-run on the final code — is recorded in
`task.md` ("M5 closing regression"), with counts.

- `smoke`, `smoke-m3`, `smoke-m4`, `smoke-sync`, `smoke-m5` — API end to end per milestone
- `probe-*` — focused API probes (finance pages, COD wiring, disputes, merchant visibility and portal, bulk booking, ops delivery, sync conflicts, POD photo, nightly)
- `ui-*` — real headless Chrome against the running app (finance, merchant, every route, ops delivery, rider, rider queue, admin)
- `security-review` — live attack probes; `route-guards.test.ts` — static guard inventory of all procedures
- `backup-drill` — backup + verified restore; `load-test` — read throughput and latency
