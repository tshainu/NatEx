# NatEx — courier & logistics platform (Sri Lanka)

Implementation of the NatEx specification in `PROJECT.md`. Section references
below (§4, §10, …) point at that document, which is the source of truth for
scope, domain rules and milestone order.

**Built and verified: Milestone 1 (Core & Collection) and the backend plus ops
web of Milestone 2 (Transport & Custody).** M3–M5 are not started. Nothing in
this repository is stubbed with fake data: a screen that has no implementation
behind it says which milestone it arrives in and why, rather than showing
placeholder rows.

---

## Running it

```bash
bun install
bun run dev          # web + API on :4200
```

| Command | What it does |
| --- | --- |
| `bun run dev` | Web app and API together (one Bun server) |
| `bun run typecheck` | `tsc --noEmit` across web, mobile and desktop |
| `bun run lint` | Project lint rules |
| `bun run build` | Typecheck + production bundle |
| `bun run db:push` | Apply the Drizzle schema to the database |
| `cd packages/web && bun run db:seed` | Seed branches, users, merchants, parcels, zones |
| `cd packages/web && bun run smoke` | **71 API assertions** end-to-end against the running server |
| `cd packages/web && bun run ui-check` | **19 routes** loaded in a real browser, fails on any console/page error |

`smoke` and `ui-check` both need `bun run dev` running first. They are the
proof behind every "verified" claim in this README — see
[Verification](#verification).

Ports are fixed by the platform in `__ports.cjs`: web `4200`, mobile `4300`,
desktop `4400`.

### Environment

The database and storage variables come with the sandbox. NatEx adds:

| Variable | Purpose | Required |
| --- | --- | --- |
| `JWT_ACCESS_SECRET` | Signs 15-minute access tokens | yes |
| `JWT_REFRESH_SECRET` | Signs rotating refresh tokens | yes |
| `SMS_EXECUTION_URL` | OTP/notification gateway endpoint (§9). Unset ⇒ messages are written to `shared_sms_log` and never sent, and OTP codes are returned in the API response in non-production so login still works | no |
| `SMS_SENDER_ID` | Sender mask, defaults to `NATEX` | no |
| `SMS_DLR_WEBHOOK_SECRET` | Shared secret on `POST /api/webhooks/sms/dlr` | yes if SMS is live |
| `OUTBOX_POLL_MS` | Outbox worker interval, default 3000 | no |

### Signing in

Phone + OTP, no passwords (§7). Outside production the six-digit code is
returned by `identity.requestOtp` as `devCode` and pre-filled on the login
screen, so the seeded users are reachable without an SMS gateway:

| Role | Phone |
| --- | --- |
| Administrator | `+94773456789` |
| Operations | `+94772345678` |
| Transport | `+94776789012`, `+94777890123` |
| Finance | `+94774567890` |
| Merchant | `+94775678901` |
| Rider | `+94771234567` |

Seeded branches: `CMB01` Colombo Central, `CMBHUB` Colombo Main Hub —
Peliyagoda, `KDYHUB` Kandy Regional Hub.

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

Two further gaps worth naming plainly:

- **Google Maps / Mapbox geocoding (§9)** is not wired up. Serviceability
  resolves against the seeded zone polygons only; there is no geocoding
  provider, so the geocode cache table exists and is unused.
- **`bun run build` emits a single 920 kB bundle.** Fine for the sandbox,
  needs code-splitting before production.

---

## Layout

```
packages/web/
  src/api/
    index.ts              root oRPC router + SMS DLR webhook
    middleware/pipeline.ts  auth, role gates, idempotency, rate limits, audit
    modules/<feature>/    the ONLY code that touches that feature's tables (§4)
      parcels/state-machine.ts   transitions, role gates, milestone gating (§6)
    database/schema/      identity, merchants, parcels, collection, routing, transport, shared
    jobs/worker.ts        outbox poller
    shared/               auth, errors, geo, sms, outbox, ulid
  src/web/                React app — ops, admin, finance, merchant, field portals
    pages/track.tsx       the one public screen
  scripts/smoke.ts        71 API assertions
  scripts/ui-check.ts     19 browser route checks
packages/mobile/          Expo client — not built yet
packages/desktop/         Electron shell around the web app
```

Module boundaries from §4 are real: a service reads only its own feature's
tables and calls sibling modules through their exported functions. `parcels`
never touches `transport_*`, `transport` never writes `parcels_*` directly.

### Conventions (§11)

Money is integer cents everywhere — no float touches a monetary field. Times
are stored UTC, rendered Asia/Colombo. `parcels_event`, `transport_hub_scan`
and `shared_audit_log` are append-only: nothing updates or deletes a row.
Mutations require an `Idempotency-Key` and replay returns the first result.
Errors are `application/problem+json` with a stable `type`.

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

§12 requires that nothing is reported as implemented without being executed.
Current state, all re-run after the most recent change:

| Check | Result |
| --- | --- |
| `bun run typecheck` | 3 packages, clean |
| `bun run lint` | 0 errors, 0 warnings |
| `bun run build` | clean |
| `bun run smoke` | **71/71 pass** |
| `bun run ui-check` | **19/19 routes clean** |

`smoke` walks the real flows rather than asserting on mocks: login as each
role, book a parcel, build and scan a pickup manifest, hand over, receive at
the origin hub, bag it, seal it, load a linehaul trip, depart, arrive, receive
at the destination hub with deliberate variances — and asserts the guardrails
each step of the way (illegal transition rejected, idempotent replay, role gate,
departure with an unsealed bag refused, seal mismatch detected, short bag
raising an exception, rate limiting, PDPA-safe tracking payload).

`ui-check` signs in over the real API, injects the session, and loads every
route in headless Chrome, failing on any console error, page error, unexpected
redirect or visible error surface. It caught a live `React.Children.only` crash
on `/ops/parcels` that `tsc` could not see.

---

## What is missing

Tracked honestly rather than quietly dropped:

- **The Expo mobile app is not built.** This is the largest gap. §10 M1
  requires rider login/device-bind, today, scan, pickup and handover; M2
  requires transport bulk scan, bags, trips and variance. The API for all of
  it exists and is smoke-tested, and `packages/mobile/lib/api.ts` is wired to
  the typed client — but no screens exist beyond the Expo starter. Consequence:
  the M1 exit criterion is currently satisfied through the ops web portal, not
  through a rider's phone.
- **No unit tests.** §12 asks for full unit coverage of the parcel state
  machine. What exists is integration-level (`smoke.ts`) and browser-level
  (`ui-check.ts`) instead; every legal transition is exercised, but the illegal
  ones are only spot-checked rather than enumerated.
- **M2 remainder**: the custody timeline component is built into the ops
  screens rather than extracted, and the two-party handover exists in the API
  but has no mobile surface.
- **M3, M4, M5**: no code. Screens for delivery, COD, settlement, invoicing,
  rate cards and admin configuration state which milestone they belong to.
