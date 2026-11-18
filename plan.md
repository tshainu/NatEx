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


# Merchant Parcel-Label OCR — Implementation Plan (2026-11-15)

## Product scope and decisions

Add a full-label photo capture to Merchant → Book. On-device OCR reads label text, and image barcode decoding reads the preprinted tracking barcode. Offer extracted AWB and recipient details as suggestions in the existing booking form. If handwriting is too small to read in the full photo, allow a second, close-up image of only the recipient section and merge its OCR suggestions with the first scan. Ask the merchant to hold the camera steady, use bright even light, and keep the full handwritten recipient block in frame. The merchant reviews and can edit values before the existing explicit Create booking action; scanning must never submit a booking. Preserve any fields already entered when applying suggestions to avoid silently overwriting user input.

The From address on a label is informational only. NatEx booking currently stores the Merchant account's registered pickup address as the parcel origin, so OCR must not override that source of truth. Show the detected From address beside the registered pickup address and tell the merchant to contact Operations if it differs. Only the To address and eligible recipient name/phone suggestions may fill booking fields. OCR is best-effort; uncertain/missing fields remain editable/manual.

Use on-device `expo-text-extractor` 2.0.0 for native OCR and Expo Camera's image barcode scan for the full label photo, retaining the existing live barcode scanner. Capture at full image-picker quality and re-read a close-up recipient photo when requested. This can help when handwriting is small or occupies few pixels, but it does not replace a handwriting-trained recognizer and cannot guarantee correct reading of handwriting. Keep every captured image and OCR text on the device; do not upload, persist to an API, or log label contents. Initial Android OCR uses the package's Latin recognizer; non-Latin text may need manual entry. No backend or database change is needed.

Keep the OCR native module out of non-Merchant native builds. Expo's resolver reads `expo.autolinking` from the app package.json, not from the dynamic Expo app config, so `eas-build-pre-install` will add/remove the per-variant exclusions before CNG prebuild; `eas-build-on-complete` restores the source package manifest. Dynamically load the OCR and file-cleanup modules only for the Merchant scan action. Update only Merchant camera permission copy. Use the existing Merchant booking screen cards, inputs, address controls and button styling.

The OCR package is a native Expo module, so the Merchant APK/AAB must be rebuilt before installed phones can use the feature. Its published podspec sets iOS 15.1 and its Android module sets minSdk 24; verify Expo SDK 57 config before any store release. This source change alone does not deliver a build artifact.

## Project structure

- `packages/mobile/app/(merchant)/book.tsx`: capture, recognition, non-destructive review/apply, and registered-origin note.
- `packages/mobile/lib/merchant-label-ocr.ts`: pure text parsing and suggestion-to-form mapping, independent of native OCR.
- `packages/mobile/lib/merchant-label-ocr.test.ts`: deterministic parsing regression coverage.
- `packages/mobile/app.config.js`: Merchant-only app identity and camera permission copy.
- `packages/mobile/configure-autolinking.js`: EAS pre-install variant exclusions and post-build manifest restore.
- `packages/mobile/package.json` and root `bun.lock`: OCR and FileSystem dependencies plus EAS lifecycle hooks.

## Implementation references

- Expo Text Extractor package and SDK guidance: https://github.com/pchalupa/expo-text-extractor
- Published package metadata: https://registry.npmjs.org/expo-text-extractor/latest
- Native module configuration: https://raw.githubusercontent.com/pchalupa/expo-text-extractor/main/expo-module.config.json
- Android ML Kit Latin implementation and min SDK: https://raw.githubusercontent.com/pchalupa/expo-text-extractor/main/android/build.gradle
- iOS Vision podspec and minimum deployment target: https://raw.githubusercontent.com/pchalupa/expo-text-extractor/main/ios/ExpoTextExtractor.podspec
- Expo Autolinking exclusion configuration: https://docs.expo.dev/modules/autolinking/
- Expo Camera image barcode scan API: https://docs.expo.dev/versions/latest/sdk/camera/
- Expo Autolinking options source: https://docs.expo.dev/modules/autolinking/
- EAS Android hook order (pre-install runs before npm install and CNG prebuild): https://docs.expo.dev/build-reference/android-builds/
- Google ML Kit Text Recognition v2 scripts and API: https://developers.google.com/ml-kit/vision/text-recognition/v2
- Apple Vision image-text recognition modes: https://developer.apple.com/documentation/vision/recognizing-text-in-images


### Privacy hardening note

After OCR and barcode decoding complete (or fail), explicitly delete the camera capture from the temporary app cache using the SDK-matched Expo FileSystem package. `expo-file-system` is excluded alongside OCR from non-Merchant native builds; photos never leave the device or persist as booking data.


# Merchant Web Portal Entry, Label OCR & Thermal Address Labels — Plan (2026-11-16)

## Product scope and decisions

- Extend the existing NatEx web application in `packages/web`; its Merchant portal already includes dashboard, parcel booking, bulk CSV, pickups, shipments, tracking, NDR/returns, disputes/claims, statements, and account screens. Reuse those authenticated, merchant-scoped operations rather than creating a second portal or API.
- Add a public `/merchant-login` entry linked from the current sign-in screen. Reuse the current username/password and phone/OTP authentication and session handling. The Merchant entry accepts only accounts with the `merchant` role and sends them to `/merchant`; users with other roles continue using the existing general sign-in. No new credentials or self-registration flow are introduced.
- Extend Merchant booking with a photo/file input that processes a parcel address label entirely in the browser. Use local barcode decoding for the tracking barcode and browser OCR for legible printed text. Extract possible AWB, recipient name/phone and To-address details into editable suggestions; the merchant reviews and corrects them before the existing explicit booking action. The photo and raw OCR output are never sent to NatEx APIs or stored; only the merchant-confirmed structured booking values use the existing API. The From address remains the active Merchant profile's authoritative pickup address; show any OCR From text only as a comparison.
- Pin browser libraries to `tesseract.js@7.0.0`, `@zxing/browser@0.2.1` and `jsbarcode@3.12.3`; use `@tesseract.js-data/eng@1.0.0` as a build-time English model source. Self-host the worker, matching WebAssembly core variants and English language file under `packages/web/public/ocr/`, disable Blob workers and runtime CDN calls, and serve all OCR assets same-origin. The current strict Caddy CSP needs the minimal `'wasm-unsafe-eval'` source added to `script-src` so WebAssembly can compile; include that patch and apply instructions in the host handoff. Browser OCR is best-effort and especially unreliable for handwriting; keep all fields editable and disclose the limitation rather than claiming handwriting accuracy. The initial model is English; labels in other scripts may need manual correction unless separately agreed and tested.
- Add a print-label action after booking and to Merchant shipment rows. The printable label is sized for a 3-inch (76.2 mm) address area centered on an 80 mm thermal roll, uses the Merchant profile pickup address for From and parcel recipient fields for To, and prominently prints the AWB with a scannable Code 128 barcode. Keep all non-label UI out of the browser print output.
- This checkout contains the integrated NatEx portal but not the standalone marketing-site source. The user has supplied the compiled public-site ZIP, which can be updated as a static handoff without claiming to modify its missing source project. No API schema, database migration, VPS deployment, production data write, Git push, or store submission is part of that earlier portal handoff. Include the minimal Caddy CSP patch because browser OCR's WebAssembly needs `wasm-unsafe-eval`; do not apply it to the running server.

## Project structure

- `packages/web/src/web/app.tsx`: public Merchant login route alongside current shared login and existing role-guarded portal routes.
- `packages/web/src/web/pages/login.tsx` and a small Merchant sign-in wrapper/page: accessible Merchant entry CTA, existing password/OTP flow, Merchant-role check, and portal-specific landing.
- `packages/web/src/web/pages/merchant/book.tsx`: local label photo, OCR/barcode review and safe prefill inside the current booking form.
- `packages/web/src/web/lib/merchant-label-ocr.ts`: browser-label text cleanup, AWB and recipient suggestion parsing, with pure regression tests.
- `packages/web/src/web/components/natex/merchant-address-label.tsx`: reusable From/To/Code 128 print-only label view.
- `packages/web/src/web/pages/merchant/parcels.tsx`: print action for existing merchant shipments.
- `packages/web/src/web/styles.css`: isolated thermal `@media print` sizing and page rules; do not alter ordinary portal printing.
- `packages/web/public/ocr/`: same-origin worker, OCR core and English language data copied from locked dependencies for self-hosted browser processing.
- `packages/web/public/manus-routes.json`: keep public and portal routes synchronized with the router.
- `packages/web/dist/`: production build handoff. Package a clean `dist` update folder and concise host-copy instructions; exclude `.env`, credentials, `node_modules`, Git internals and unrelated APK/build artifacts.
- `host-update/`: distributable web `dist` contents, concise host-copy instructions and a minimal Caddy CSP patch for WebAssembly; do not deploy automatically.


# Public NatEx Contact Map & Live Branch Locations — Plan (2026-11-16)

## Product scope and decisions

Add a Sri Lanka location map to the supplied standalone public company's existing Contact section, plus a public Merchant Login link that opens the existing NatEx system route at `https://204-13-236-153.sslip.io/merchant-login`. Reuse the exact `SriLankaNetwork` SVG island silhouette, green card, lime coastline and dashed illustrative routes already on the public website, replacing its decorative location nodes with live branch/hub pins at their Admin → Branches coordinates. Keep the active location list with names and details; entries without complete coordinates stay listed without inferred pins. The company website is static, so its map fetches the read-only locations endpoint on load and refreshes periodically while open; additions, edits and deactivation are reflected without rebuilding the website. Do not geocode or edit production records.

The system API change is code-only and required before the public map can load. Return code, name, branch/hub type, public address and decimal coordinates only; never expose internal IDs, telephone fields, user data or rate-card fields. Use a short cache policy and CORS for public site reads. No credentials are embedded in the site. A read-only Production check on 2026-11-16 returned HTTP 200 from `/api/health/ready` but HTTP 404 from `/api/public/locations`; this is the confirmed reason the uploaded public page has no location data. Production also contains coordinate/address mismatches and a location with null coordinates; the map mirrors saved Admin → Branches values until an authorized administrator corrects those rows.

Respect `schema-hold`: no schema or migration edits/commands. Deliver separate static-site and API-patch archives with instructions. Do not deploy/restart the Production API or upload the public site without the user's explicit approval; apply the API patch before the site bundle.

## Project structure

- `packages/web/src/api/index.ts`: expose `GET /api/public/locations` using existing identity-service branch reads.
- `packages/web/src/api/shared/public-locations.ts`: project safe active branch data for public map consumers.
- `packages/web/src/api/shared/public-locations.test.ts`: verify public projection, inactive filtering and omitted private fields.
- Supplied `NatEx-Website.zip`: preserve existing public site and assets; patch its Contact section with a live map mount and Merchant Login link, adding isolated static JS/CSS assets.
- `NatEx-public-website-handoff/NatEx-Website/` and `NatEx-Website-Contact-Map-Update-v2.zip`: complete static marketing-site folder and ZIP handoff.
- `NatEx-Public-Locations-API-Patch-v2.zip`: only the code files needed for the backend endpoint and regression tests; no database/schema changes.

## Design

Reuse the existing public site's `network-map-card` and `network-map-svg` from `SriLankaNetwork` so the Contact map matches the supplied reference: dark forest-green glass card, detailed lime coastline, subtle glow, orbit line and dotted route treatment. Remove static decorative pins from the cloned Contact map and place active directory locations on that same SVG; keep names and addresses in the accessible list below the map and use an explicit no-pin status for missing/out-of-map coordinates. Do not package sample or hard-coded production branch records.

## Design

Reuse the current NatEx login brand panel, portal shell, local wordmark/logo and merchant form controls. Keep the Merchant entry calm and direct; keep OCR in a clearly labeled review card within Book, with the existing manual form still authoritative. Make the thermal label high-contrast, black-on-white, compact and readable on roll stock; no external stock imagery or changes to NatEx branding.

## Implementation references

- Tesseract.js browser OCR project (Web Worker/WebAssembly and worker lifecycle): https://github.com/naptha/tesseract.js/
- Tesseract.js same-origin worker/core/language asset configuration: https://raw.githubusercontent.com/naptha/tesseract.js/master/docs/local-installation.md
- Tesseract.js OCR limitations and handwriting FAQ: https://raw.githubusercontent.com/naptha/tesseract.js/master/docs/faq.md
- Tesseract.js browser worker selection and Blob-worker behavior: https://raw.githubusercontent.com/naptha/tesseract.js/master/src/worker/browser/spawnWorker.js
- ZXing browser decoding from image elements/URLs: https://github.com/zxing-js/browser
- Pinned Tesseract.js package: https://registry.npmjs.org/tesseract.js/7.0.0
- Pinned ZXing browser package: https://registry.npmjs.org/@zxing/browser/0.2.1
- Pinned JsBarcode package: https://registry.npmjs.org/jsbarcode/3.12.3
- English OCR model source: https://registry.npmjs.org/@tesseract.js-data/eng/1.0.0


# Operations UI Polish — Implementation Plan (2026-11-17)

## Scope and behavior

- `/ops/bagging`: display the destination service-zone owner as a hub/branch label in the ready-to-bag table, never substitute the full recipient address for a hub. Use the existing branch name/type and destination-zone assignment. Keep “Bags at your hub” to open/sealed bags only; style the Open bag action and its label green, add varied gradient outlines to the four summary tiles, and outline the Scan into bag card in green.
- `/merchant/parcels`: add from/to filters for the parcel booking date (`createdAt` in Colombo calendar time), keep the date controls on the right of the filter bar, offer 50/100/500/All page sizes, and display the destination district parsed from the recipient address. Match that district to active Admin → Branches addresses, preferring one unique hub and falling back to one unique branch; if no location or multiple candidates exist, show the district with a clear status rather than guessing. Do not use service zones or the parcel’s current accountable branch as its destination.
- `/ops/book`: rename the two requested cards and apply restrained yellow/green treatments. Add an operations-only, branch-scoped sticker check for the selected Merchant; only show green after the server confirms the label is allocated to that Merchant, unused and not retired. Keep blank optional stickers neutral/yellow and show invalid or failed checks in red.
- `/ops/freight-counter`: add yellow/green card outlines and use the existing branch sticker check result to display yellow (empty/incomplete/pending), green (valid) or red (invalid/failed) input outlines. Preserve validation and booking gates.
- `/ops/parcels`: use the same district-from-recipient-address resolver as the Merchant Parcels table, with explicit no-district/no-location/ambiguous states. New branch records are considered from the active branch directory on the next parcel-list query.

## Constraints

The original UI polish did not change schema or production data. That constraint is superseded only for the separately approved sender-branch follow-up below; all other schema, database and deployment actions remain out of scope. Do not add the local 135 MB Rider APK to GitHub because it exceeds GitHub's per-file size limit.


## District resolver verification note (2026-11-18)

A read-only `GET https://204-13-236-153.sslip.io/api/public/locations` returned HTTP 200 and six active Admin → Branches records. The new parser recognized the stored address districts for Colombo Central/Colombo Main Hub, Jaffna Branch, Mannar Branch, Kilinochi Hub, and Vavuniya Branch; Colombo correctly prefers the unique hub over the same-district branch. No raw address, phone number, or parcel data was copied into this note, and no Production writes were made.

## Sender-branch parcel isolation (explicitly approved 2026-11-18)

- Add one nullable `parcels_parcel.origin_branch_id` column and an index. Keep the existing `branch_id` as the parcel's current accountable branch; never repurpose it. Populate `origin_branch_id` in every new Merchant, Operations, counter and seed/demo parcel insert.
- Scope the Operations Parcels register by the immutable sender branch: an Ops hub sees parcels booked at that hub and its Admin-assigned child branches; an Ops branch sees its own sent parcels; global Admin/Finance/HR roles retain the existing network view; Merchant scope remains its own merchant. An Admin branch filter means “sent from”.
- An origin branch may read/timeline-track its own sent parcel after it leaves, but status changes remain authorized only for the current accountable branch (or existing global/merchant permissions). Show a read-only explanation where appropriate.
- Backfill only legacy rows whose origin is absent. Use the earliest valid append-only `Accountability moved from <branch> to <branch>.` parcel event to recover the sender. If no transfer event exists, use the row's current branch; malformed or conflicting earliest transfer evidence stays NULL and is reported as unresolved. Never overwrite a non-NULL origin value or guess from addresses/zones.
- The one-shot backfill tool defaults to read-only planning; `--apply` requires a pinned DB target, a reviewed plan hash, explicit target confirmation, and is idempotent. Take/verify the pre-migration database backup. Test schema sync and backfill on disposable SQLite first, then use the explicit schema-enabled Production/Demo deploy path; no destructive data operations.


## Approved sender-branch register (2026-11-18)

The owner approved adding a durable `origin_branch_id` to each parcel and a safe migration/backfill. Keep `branch_id` unchanged as the mutable current-accountability branch used by transport, delivery, and all write authorization. Every new booking path (single, counter, bulk, seed) records the original booking branch once; accountability transfers never overwrite it.

The Operations Parcels list is filtered server-side by sender branch, including the operator's assigned hub and Admin-assigned child branches. Global Admin/Finance/HR scope remains network-wide; merchant scope remains merchant-only. A parcel moved to another hub remains visible to its sender branch as read-only tracking. Detail reads may use current-accountable branch or sender-branch scope, but transitions and all operational writes keep the existing current-branch check. A parcel received from another hub is not placed in the receiver hub's sender register.

The one-time backfill uses the earliest append-only `Accountability moved from <source> to <destination>.` event to reconstruct moved parcels. With no movement event, the legacy current branch is used. Malformed, conflicting, or dangling branch evidence is left null and reported, never guessed. The CLI is read-only by default; apply requires the pinned target, exact database fingerprint, exact plan hash, explicit Production/Demo confirmation, and a verified durable backup identifier. Unresolved history is updated only when the operator explicitly permits a partial backfill. No destructive or bulk rewrites are allowed.

Release order after scratch tests: take and restore-verify a durable backup; apply the additive nullable column and index through the documented schema-enabled deploy; run/review the target-specific plan; apply the hash-bound backfill; verify origin counts and sender-scope regression cases; verify API readiness and GitHub refs. This is an approved schema change, not a code-only release.