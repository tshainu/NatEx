# M4 — Money (PROJECT.md §8, §10 M4)

Client answers (2026-09-30) that set seeded defaults. All are CONFIG ROWS, not constants.

| Question (§15) | Answer |
|---|---|
| q4 settlement cycle | Weekly, Friday cut-off, payout following Wednesday |
| q3 COD fee model | **Zero** — bundled into the delivery rate. Rate row exists, seeded 0. |
| q10 VAT/SSCL | **No tax lines yet** — modelled, seeded inactive, pending NatEx registration status. STILL OPEN. |
| q9 rider cash ceiling | Rs. 50,000 → further dispatch **blocked**, ops notified |
| q5 credit terms | Net 14, ageing 0-30 / 31-60 / 61-90 / 90+, no hard limit |
| deductions | RTO fee **alterable, seeded 0** for the promo period; weight discrepancy active; no WHT/penalties yet |
| payout file | Bank-agnostic CSV |

Real LK tax rates researched for the (inactive) defaults: VAT 18% (since 2024-01-01),
SSCL 2.5% on liable turnover, WHT 5% on resident service fees.

## Build order

Only tick a box after the code has actually been RUN (§12).

- [x] 1. `schema/cod.ts` — append-only double-entry ledger + deposits, settlements,
      invoices, credit notes, disputes, finance config, invariant runs
      VERIFIED: tsc -b clean, db:push applied, 11 cod_* tables + both idempotency
      unique indexes confirmed present in sqlite_master.
- [x] 2. `modules/cod/accounts.ts` — chart of accounts + balance arithmetic
      VERIFIED: tsc -b clean; `bun scripts/test-cod-accounts.ts` → 76/76 pure unit
      checks pass, incl. signed-variance direction in both directions and (added
      2026-09-30) dedicated ACCRUE / `merchantPayable()` coverage: the accrual's
      legs, why a SETTLE without one drives the payable the wrong way, one COD
      parcel's whole life netting to zero, and the payable agreeing sign-for-sign
      with the MERCHANT_PAYABLE account while staying independent of
      `riderLiability()`.
- [x] 3. `modules/cod/service.ts` — ledger writes, four-way reconciliation, controls
      VERIFIED: tsc -b clean; `bun --env-file=../../.env scripts/tmp/probe-cod.ts`
      → 89/89 live-DB checks pass, twice in a row (idempotent re-run).
      Regression: `bun run smoke` 71/71, `scripts/smoke-m3.ts` 85/85 — no M1–M3 break.
- [x] 4. `modules/cod/settlement.ts` + `modules/cod/holds.ts` — weekly runs (Friday
      cut-off → Wednesday payout), maker–checker, bank-agnostic payout CSV, UTR,
      manual deductions, parcel- and merchant-scoped holds
      VERIFIED: tsc -b clean; `bun --env-file=../../.env scripts/tmp/probe-settlement.ts`
      → 108/108 live-DB checks pass, twice in a row (idempotent re-run), covering
      the cycle maths, payout-details CRUD, collect→deposit→verify→bank→accrue into
      a real run, preview/create/get with a balanced header, maker-checker refusal
      then success with two actors, the CSV's format + re-export refusal + forced
      re-export, `recordPayout()`'s UTR requirement / ledger posting / paid-run
      immutability, holds blocking and releasing, rejection re-opening a period,
      the §15 q10 tax flag toggling a TAX line by config alone, and the finance
      work-queue + merchant-statement reads.
      Regression on one freshly-seeded DB: unit 76/76, probe-cod 89/89,
      `bun run smoke` 71/71, `scripts/smoke-m3.ts` 85/85.
      NOT yet done for this item: neither module is wired into the API router
      (item 9), so nothing is callable over HTTP yet.
      Bugs found and fixed while proving it: (a) `holds.ts` returned `blocking`
      where `settlement.ts` read `blockingHolds`; (b) `raiseHold()` passed a bare
      `"source_key"` to `isUniqueViolationOn`, which needs the table-qualified
      `"cod_hold.source_key"` — this silently defeated the idempotent offline
      replay path; (c) a *paid* settlement blocked any later run for the same
      merchant+period, stranding money banked after a mid-period payout — the
      plain unique index is now a partial one over open statuses only, with a
      `settlement-exists` problem type; (d) `appendEntry()` reported
      `cod-already-collected` for a unique-violation on *any* entry type, so an
      ACCRUE collision lied about its cause — non-COLLECT collisions now raise
      `cod-entry-already-posted`.
- [x] 5. `modules/cod/invoicing.ts` — invoices, VAT/SSCL (inactive), credit notes, AR ageing
      VERIFIED: tsc -b clean; `bun --env-file=../../.env scripts/tmp/probe-invoicing.ts`
      → 200/200 live-DB checks pass, re-confirmed on a freshly-seeded DB.
      NOT yet done for this item: not wired into the API router (item 9).
      CLIENT-DELEGATED, NOW DECIDED: the billed-vs-recovered split, and
      excluding recovered charges from AR ageing, began as *inferences* — §8/§15
      state neither. Both were put to the client, who left the call to us "for
      now". DECISION: keep net receivable. A COD merchant's fees are already
      deducted at settlement, so ageing them would put essentially every
      merchant permanently overdue and make the 61-90/90+ buckets — the ones a
      collections desk works — noise; DSO over recovered charges measures
      nothing. The invoice still shows the recovered amount with a note, so it
      stays a complete tax document and only the chase list is filtered.
      Reversal is two lines (`outstandingCents()` stops subtracting
      `recoveredCents`; the ageing query stops filtering them out), and both
      sides are asserted — probe-invoicing.ts:188 for the outstanding
      arithmetic, :713 for "a fully recovered invoice never ages" — so a
      reversal announces itself in the probe, not in production. Full reasoning
      in `invoicing.ts`'s header. STILL WORTH CONFIRMING at go-live: it changes
      the numbers the client reports, not how the code behaves, so if their
      auditor expects gross AR, flip it before the first invoice is issued.
- [x] 5b. `modules/cod/alerts.ts` + `cod_ops_alert` table + `jobs/worker.ts` wiring
      — NOT in the original build order. A defect found while proving item 5:
      `service.ts` and `settlement.ts` enqueue eight `cod.*` outbox topics and
      `worker.ts` had a handler for NONE of them, so every §8 control that ends
      in "ops notified" / "escalated to finance" retried five times and
      dead-lettered. Confirmed against the live `shared_outbox` before the fix:
      `cod.amount_mismatch`, `cod.ceiling_breached`, `cod.deposit_variance` and
      `cod.stale_collection` all sat in `failed` with "unknown outbox topic".
      In practice nobody was notified of anything.
      Now: a durable `cod_ops_alert` worklist (dedupable on `source_key`,
      acknowledge → resolve-with-mandatory-note, severity/audience routing,
      counts for a dashboard), all eight topics mapped, and an unmapped `cod.*`
      topic throws so the next one added fails loudly instead of vanishing.
      VERIFIED: tsc -b clean; `bun run db:push` applied the table cleanly;
      `bun --env-file=../../.env scripts/tmp/probe-alerts.ts` → 110/110 live-DB
      checks pass, three runs in a row, with the dev server's own outbox drain
      running concurrently. Post-run `shared_outbox` shows every `cod.*` row
      `done` and nothing dead-lettered.
      Regression on one freshly-seeded DB: unit 76/76, `bun run smoke` 71/71,
      `scripts/smoke-m3.ts` 85/85, probe-cod 89/89, probe-settlement 117/117,
      probe-invoicing 200/200. (748 checks in total, re-run green after the
      milestone-flag split and the merchant notification below.)
      Bugs found and fixed while proving it: (a) every handler did
      `JSON.parse(payloadJson) as XPayload` and trusted the cast — a wrong-shaped
      payload wrote an alert reading "undefined: rider collected Rs. NaN" under
      the dedupe key `amount_mismatch:undefined`, which would then swallow the
      REAL escalation as a duplicate forever; payloads are now shape-checked and
      a bad one retries with the reason on the job and nothing in the worklist.
      (b) `awb` was initially required, but it is nullable on `cod_entry`, so a
      parcel booked without one would have had its escalation refused; the
      summary now falls back to the entry/parcel id.
      (c) probe isolation, not product: `db:seed` does not clear `cod_entry`, so
      probe-cod's network-wide stale-collection counts broke whenever a sibling
      probe's backdated fixture was still in the table — both probes now scope
      those assertions to their own riders.
      CLIENT-CONFIRMED: the durable worklist began as an *inference* (§8
      requires notification but names no mechanism; §15 asks nothing about
      routing). The client has since confirmed a worklist is what they want,
      not an SMS/email digest, so `alerts.ts`'s design is settled.
- [x] 5c. merchant payout notification — client-requested, not in the original
      build order. Previously `cod.settlement_approved`/`cod.settlement_paid`
      were recorded as internal finance activity only and the merchant was
      never told their money had moved; the client asked for that to be added.
      Now: a `settlement.paid` notify template (merchant audience, whatsapp →
      sms → push ladder, §9's existing machinery) and a second `notify.dispatch`
      outbox row from `recordPayout()` — deliberately a separate row from
      `cod.settlement_paid`, so a messaging-gateway outage cannot cost finance
      its durable record of the payout.
      Fires on `paid` only, never on `approved`: an approved run has no UTR yet,
      and a merchant told "released" before the bank moves phones the desk the
      same afternoon asking where it is. NOTE: paid-vs-approved was our call,
      not the client's words — worth one line of confirmation.
      VERIFIED: tsc -b clean; template seeds live (9 total) and reads back
      active; `scripts/tmp/probe-settlement.ts` → 117/117 (was 109 — eight new
      checks: the advice is queued exactly once for the run, addressed to a real
      phone, carries the UTR, carries the amount pre-formatted as rupees rather
      than raw cents, the ladder actually ran, every step belongs to one ladder
      group, no unrendered `{{placeholder}}` reached the merchant, and the body
      names both the amount and the bank reference).
      Bug found while proving it: the pre-existing check named "the payout is
      announced (the merchant gets told)" only ever asserted the INTERNAL
      `cod.settlement_paid` outbox row — it had been green the whole time while
      nothing merchant-facing existed. Renamed to what it actually proves.
      Probe isolation, not product: `db:seed` does not clear `shared_outbox` or
      `notify_message`, so counting by template key alone found three rows and,
      worse, read a PREVIOUS run's row that carried the same UTR and amount and
      so passed the next three assertions by coincidence. Both the outbox and
      the logged-step queries are now scoped to the run's settlement code.
      ENVIRONMENT GAP, not a defect: the dispatch job retries and cannot
      complete here because `WHATSAPP_API_URL` / `SMS_EXECUTION_URL` are unset
      in the sandbox — identical to how every M3 consignee notification behaves.
      The message renders correctly and is logged in `notify_message`; it needs
      a real gateway to leave the building.
- [ ] 6. `modules/cod/disputes.ts` — dispute queue + claim register
      (`cod.dispute_opened` is already mapped in `alerts.ts`, ready for it)
- [ ] 7. delivery → cod integration: COLLECT on delivery, ceiling blocks dispatch
- [ ] 8. `jobs/worker.ts` — nightly balance-invariant job
- [x] 9. `routes/cod.ts` + `routes/finance.ts`, wired into the router
      `cod.ts` carries the ledger, deposits, banking, the invariant and the
      alert worklist; `finance.ts` carries payout details, the settlement
      cycle, holds, invoicing and AR. Both wrap the modules without
      reimplementing any arithmetic. Row scoping (§5) is a refusal, not a
      silent re-scope: a merchant naming another merchant's id gets 403.
      VERIFIED: tsc -b clean; `bun run lint` clean (500-line ceiling and the
      route-export rule both pass); every route below exercised over real HTTP
      by `scripts/smoke-m4.ts`, 75/75.
- [ ] 10. seed: finance config, a week of collections, one settled period
- [x] 11. `scripts/smoke-m4.ts` — prove every rule above actually runs
      VERIFIED: `bun --env-file=../../.env scripts/smoke-m4.ts` → 75/75, run
      twice back to back to prove it is re-runnable, and the whole regression
      suite re-run after it: test-cod-accounts 76/76, smoke 71/71, smoke-m3
      85/85, probe-cod 89/89, probe-settlement 117/117, probe-invoicing
      200/200, probe-alerts 110/110.

      Four real findings, all fixed:
      - The fixture wipe deleted its merchant's COLLECT entries but not the
        `merchantId`-NULL DEPOSIT/BANK postings they rolled into, so the
        rider's liability fell by one deposit on every re-run and went
        NEGATIVE — which §8 calls impossible by design. It broke the closing
        invariant assertion in four other probes, several scripts from the
        cause. The wipe now tears down the whole deposit chain, and skips any
        deposit that also carries another merchant's collection rather than
        widening the blast radius. `scripts/tmp/fix-orphan-deposits.ts`
        repaired the rows the earlier runs had already left behind.
      - That negative liability was being printed, not asserted. It is now a
        check (`liabilityCents >= 0`), and the script ends by asserting §8's
        invariant over the whole ledger so a future leak fails here instead of
        in someone else's probe.
      - `invariantRuns` is `financeProc` on purpose — ops learns about a
        breach through the `staffProc` alert worklist, not from finance's run
        history. The test asked as ops; the route was right.
      - Maker–checker refusal is 403 with a `maker-checker` problem type, and
        `errors.badRequest` is 400, not 422. Both test expectations were
        guesses; both now match what the services actually return.
- [ ] 12. Finance portal: dashboard, ledger browser, reconciliation, settlements, disputes
- [ ] 13. README deviations + verification steps

## Invariants to prove in the smoke test

1. Σ COLLECT − Σ DEPOSIT = rider cash liability, per rider, to the cent
2. Every account balance sums to zero across the whole ledger (double-entry)
3. No UPDATE/DELETE path on `cod_entry` — corrections are reversal entries
4. COD collected twice for one parcel → second rejected (§7)
5. Rider over the ceiling → dispatch blocked
6. Collected > 48 h without deposit → ops escalation
7. POD amount ≠ ledger amount → parcel held from settlement
8. Open variance → merchant payout blocked
9. Maker cannot approve their own settlement run
10. Four-way reconciliation: collected vs deposited vs banked vs settled

## Deposit variance — modelling decision (found as a live bug, 2026-09-30)

A deposit carries **three** amounts, not two:

| field | meaning |
|---|---|
| `expectedCents` | Σ of the COLLECT entries named on the deposit — the ledger baseline |
| `declaredCents` | what the rider says is in the bag |
| `countedCents` | what the cashier counts; this is what gets banked |

Two independent variances follow, and conflating them was a real bug that drove
`BRANCH_CASH` negative by the rider's miscount even when every rupee was present:

- **`varianceCents` = counted − expected** — the only one that posts a ledger
  entry. The DEPOSIT postings relieve the rider of exactly the collections
  handed over (§218), so this is the sole gap a double-entry book must absorb.
  Positive = cash missing (debits `CASH_VARIANCE`), negative = surplus.
- **`declaredVarianceCents` = counted − declared** — the rider's own miscount.
  Requires a reason and escalates to finance, but **posts nothing**: no money is
  missing, so posting it would unbalance a balanced book.

`variancePosting(signed)` in `accounts.ts` owns the direction, because a
shortfall and an overage need opposite legs and `posting("VARIANCE", n)` can
only express a shortfall.

## Milestone flags — one number was doing two jobs (resolved 2026-09-30)

`state-machine.ts` exported a single `CURRENT_MILESTONE = 3`, which the client
read as "M3 is shipped". It is not: M3's backend is built and proven (85/85),
but its rider screens and `modules/sync/service.ts` (§7 offline sync) are not,
so nothing M3 is shipped to a user. Dropping the number to 2 to be honest would
have broken the proven M3/M4 backend, because the same constant gates which
statuses the API accepts — `Delivered` would have fallen out of
`ENABLED_STATUSES` and taken COD collection with it.

Split into two, because they are two different facts:

| flag | value | what it means |
|---|---|---|
| `EXPOSED_MILESTONE` | 3 | what the API accepts. Gates `ENABLED_STATUSES`. |
| `SHIPPED_MILESTONE` | 2 | what a user can actually use, UI included. |

`CURRENT_MILESTONE` remains as a `@deprecated` alias of `EXPOSED_MILESTONE` so
no caller breaks; `GET` state-machine now returns both. Behaviour-preserving by
construction — the gate still reads 3.

VERIFIED: tsc -b clean; `bun run smoke` 71/71 on a freshly-seeded DB, including
the state-machine check that now reports both numbers.
