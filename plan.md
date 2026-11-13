# NatEx Reporting Suite — Implementation Plan

## Product scope and decisions

Build the four requested read-only reports: Parcel Status & Aging, Delivery & Failed Attempts, Hub & Bag Movement, and COD Reconciliation. Every report must offer date and branch/hub filters and CSV export. Admin receives network-wide data; Operations is restricted server-side to its assigned branch, or its assigned hub and direct child branches through the identity hierarchy. A branch filter may narrow, never widen, the caller's authorized scope.

Do not invent SLA thresholds. All date filters and display use Asia/Colombo. Use existing records only; do not introduce schema migrations. The COD Reconciliation report compares the expected parcel COD with live COLLECT ledger entries, excluding reversed collection/reversal pairs. Preserve accounting and data-module ownership: parcel rows are selected by the parcels service, then those already-authorized parcel IDs are passed to the COD service for collection facts.

Keep work read-only and respect the VPS `schema-hold` policy. Do not run schema commands or deploy the reporting changes unless separately authorized.

## Implementation approach

- Expose report queries through read-only, role-gated API procedures. Resolve authorized branch IDs from identity data and enforce them server-side regardless of client filters.
- Generalize the existing identity hub-plus-children helper and retain the COD helper's contract as a wrapper.
- Parcel Status & Aging uses current-state transitions in the append-only parcel event log, Colombo date boundaries, optional status/age/branch/AWB filters, last accepted scan location, and active in-transit trip ETA.
- Delivery & Failed Attempts uses append-only delivery attempt facts with server pagination, date/branch filters, and PII-minimized output.
- Hub & Bag Movement uses transport scan facts with server pagination, Colombo date/branch filters, and no precise GPS or actor data in the report output.
- COD Reconciliation starts with COD-positive parcels in the booking date range and authorized branch scope, then matches their expected COD with the COD module's live collection ledger data. Present per-parcel variance and a nonjudgmental “Not collected” state; do not imply that every uncollected parcel is overdue.
- Reuse NatEx `Page`, `DataTable`, `StatusPill` where appropriate, `ExportCsvButton`, and Colombo formatting helpers. Export pages with the active table filters. The shared export collector currently caps at 5,000 rows and discloses when narrowed filters are needed.

## Project structure

- `packages/web/src/api/modules/identity/service.ts`: authorized branch hierarchy shared by scoped reports.
- `packages/web/src/api/modules/parcels/service.ts`, `modules/delivery/service.ts`, `modules/transport/service.ts`, and `modules/cod/service.ts`: read-only report data within each module's table ownership.
- `packages/web/src/api/routes/*-report.ts` and existing `routes/parcels.ts`: role-gated report endpoints.
- `packages/web/src/web/pages/ops/reports/`: Operations report filters, tables, and CSV exports.
- `packages/web/src/web/lib/permissions.ts` and `packages/web/src/web/app.tsx`: Reports navigation visibility and route registration.
- Existing schemas remain unchanged; no report writes or migration are needed.

## Design

Reuse the established NatEx airline-operations-console design in `design.md`: compact, high-contrast operational tables; semantic parcel status colors; IBM Plex Sans body text and IBM Plex Mono for AWBs; Colombo-local DD/MM/YYYY timestamps; sticky table headers and server-side pagination. Reports remain read-only and avoid unnecessary personal or precise location data.
