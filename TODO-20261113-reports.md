# NatEx Reporting Suite — 13 November 2026

## Parcel Status & Aging — complete

- [x] Add a read-only report for parcel status and aging. Show the current status and elapsed time in that status, with filters for status, date range, branch/hub, tracking number, and an optional minimum age. Use Asia/Colombo date boundaries and DD/MM/YYYY display. Do not imply an SLA or overdue threshold unless the user provides one. Provide CSV export using the same filters as the table.
- [x] Enforce scope on the server: Admin can view the network; Operations can view only the assigned branch, or the assigned hub and its direct child branches. A client-supplied branch filter may narrow this scope but must never widen it.
- [x] Enrich rows with latest accepted scan time/location and active in-transit ETA, without returning precise GPS or scan actor identity.

## Delivery & Failed Attempts — complete

- [x] Add a read-only Delivery & Failed Attempts report with date-range and branch/hub filters, using append-only attempt outcomes, failure reasons, timestamps, and operational assignment details. Exclude receiver phone/NIC/POD media and precise coordinates. Provide CSV export using the same filters as the report view. Enforce Admin network-wide access and the assigned-branch / hub-plus-direct-children Operations scope on the server.

## Hub & Bag Movement — complete

- [x] Add a read-only Hub & Bag Movement report with date-range and branch/hub filters, using audited bag, scan, and transport movement records. Provide CSV export using the same filters as the report view. Enforce Admin network-wide access and the assigned-branch / hub-plus-direct-children Operations scope on the server. Do not expose GPS coordinates or actor identity.

## COD Reconciliation — complete

- [x] Add a read-only COD Reconciliation report comparing expected parcel COD with actual live COD collection ledger entries. Show tracking number, accountable branch/hub, booking date, expected amount, collected amount, difference, collection date and parcel status. Exclude reversed collection entries; do not label uncollected parcels overdue or apply an unprovided SLA. Filter by booking date range and branch/hub. Export the same filtered rows to CSV. Enforce Admin network-wide access and the assigned-branch / hub-plus-direct-children Operations scope on the server. Keep amounts in integer cents in the service.

## Release boundary

- [x] Preserve the VPS `schema-hold` policy. The reporting suite is read-only and uses the existing schema; no schema changes, push/deploy, or schema-enabled commands were run.

## Verification status

Web TypeScript check and production build pass. The four report scratch-SQLite suites and the identity branch hierarchy suite pass when run separately; the Delivery suite also covers Admin's branch-filtered off-runsheet case. The production build reports a large-bundle warning. Repository-wide lint has three remaining violations outside the report files: two `no-control-regex` findings in `src/api/shared/sms-policy.ts` and one `prefer-string-starts-ends-with` finding in `src/api/modules/notifications/service.test.ts`. No database schema or migration file was changed, and the reporting work has not been pushed or deployed.
