# Merchant Parcel-Label OCR

- [x] **Scan a Merchant parcel label and review OCR suggestions.** On Merchant → Book, allow taking a photo of the front label containing the From/To addresses and tracking-number barcode. Decode the barcode and recognize printed label text on-device. Put confidently recognized tracking and recipient/To details into the corresponding booking fields. If handwriting is too small or unclear in the full-label photo, offer a second close-up capture of only the recipient section and merge its OCR suggestions with the first scan. Show short capture guidance for steady focus and bright, even light. This improves the input photo but does not guarantee recognition of handwriting. Show the detected From address for comparison with the Merchant account's registered pickup address; do not let OCR change the authoritative parcel origin. Preserve manually entered fields when applying suggestions. Keep all values editable and require the user to review and press the existing Create booking action; never book automatically. Keep label photos and recognized contents on-device and do not upload or log them. Keep the native OCR module out of non-Merchant builds. Initial Latin/English OCR may require manual entry for other scripts.
- [x] **Build and verify the Merchant app artifact.** Expo EAS Android internal APK build `9b3cddca-c0fd-47a9-90a8-4698ad8f9945` succeeded on commit `cd1029b` using the `merchant-apk` profile. The downloaded APK passed ZIP integrity validation (135,111,718 bytes; SHA-256 `c557895186245cf3a48f5b5b161e969fc54342e76e9a8514660c20fe26706c09`). Existing installed builds need this APK to use OCR; this was not submitted to an app store.

# Merchant Web Portal & Label Tools (2026-11-16)

- [x] **Merchant login and existing operations:** Add a distinct Merchant sign-in route at `/merchant-login`, reuse the existing credentials/session, accept Merchant-role accounts, and enter the existing Merchant portal. No separate credential store or self-registration path was added.
- [x] **Address-label image to editable booking text:** Read label barcode/text and printed From/To details locally in the browser. Suggestions are editable and do not overwrite existing entries; booking still requires explicit submission. The From address on the account remains authoritative. The source photo and raw OCR are not uploaded, persisted, or logged.
- [x] **3-inch address-label printing:** Add a print action after booking and on Merchant shipments. Label includes From/To, the tracking number and Code 128 barcode; print content is 76.2 mm on an 80 mm roll. Page sizing is scoped to Merchant label printing.
- [x] **Host-ready website handoff:** Built and TypeScript-checked the integrated web portal; OCR parser tests pass 4/4; the production preview returned HTTP 200 for `/merchant-login` and the local OCR worker/model/WASM. Packaged `site/dist`, hosting and rollback instructions, the separate Caddy CSP patch, and file checksums in `NatEx-Merchant-Web-Host-Update.zip`. Handoff only: no Git push, VPS update, Caddy reload, schema change, or store submission.

# Public NatEx Contact Map & Live Branch Locations (2026-11-16)

- [ ] **Contact map reads live locations from NatEx.** Add a Sri Lanka map in the public website Contact section. Load active branch/hub names, types, addresses and saved latitude/longitude from a read-only public endpoint. Source records only from Administration → Branches; do not hardcode a snapshot or geocode/modify coordinates. Reflect Admin additions, edits and deactivations on page refresh, with a short polling interval while open. Show records without usable coordinates in the location list but do not invent a map pin. The route and projection are implemented and tested, but the live endpoint returned HTTP 404 on 2026-11-16, so Production does not yet provide locations.
- [x] **Public Merchant Login link.** Add an obvious link from the public company website to the existing NatEx Merchant login at `https://204-13-236-153.sslip.io/merchant-login`. Added a visible header link and a Contact-section CTA.
- [x] **Separate handoff for public site and API patch.** Provide the updated static public-site ZIP and a separately installable, code-only system API patch with ordered application instructions. Keep the `schema-hold` policy: no schema/migration commands, DB writes, production deployment, or production website upload. The updated v2 archives passed ZIP and per-file checksum validation; no Production deployment or upload was performed.

# Contact Map Follow-up (2026-11-16)

- [x] **Match the supplied Contact map reference.** In “Find a nearby NatEx location,” use the same detailed Sri Lanka silhouette, forest-green card, lime coastline glow, and dotted route treatment as the public site's existing connected-journeys map. Replace decorative pins in the contact map with active locations from Admin → Branches; keep hub/branch names visible in the location list and update markers when records change. Verified in the local browser preview: the cloned SVG card matches the reference; mocked live data displayed two coordinate pins plus three directory records, including a null-coordinate hub with no invented pin.
- [ ] **Make live locations appear on the public site.** The live `https://204-13-236-153.sslip.io/api/public/locations` endpoint currently returns HTTP 404 while `/api/health/ready` returns HTTP 200. Install the existing code-only public-locations API patch before expecting the Contact map to show locations. No schema migration or database write is needed; do not restart/deploy Production without explicit approval.


# Operations UI Polish (2026-11-17)

- [x] **Bagging:** In Bagging, show the destination service hub/branch name (for example, “Jaffna hub”) instead of the full destination address. Make the Open bag button green and the Destination hub label green. In “Bags at your hub,” do not show inbounded bags. Put varied gradient-colour borders on the top metric cards. Give “Scan into bag” a green outline.
- [x] **Merchant Parcels:** Add a booking-date filter on the right side. Add a page-size dropdown with 50, 100, 500 and All. Add a destination hub/branch column, derived from the configured destination zone rather than guessing from the delivery address.
- [x] **Staff Book a parcel:** Rename “Merchant & consignment” to “Merchant & Sender” and colour the card yellow. Rename “Consignee & destination” to “Destination & Recipient” and colour the card green. Give the preprinted tracking-number sticker field a yellow outline by default, green when the sticker is accepted for the selected Merchant, and red when it is invalid/unavailable.
- [x] **Customer Counter Booking:** Give the “Branch & parcel” card a yellow outline and the “Recipient & delivery” card a green outline. Give both the preprinted branch tracking-number sticker field and the branch tracking-number sticker field a yellow outline by default, green when accepted for the selected branch/hub, and red when invalid/unavailable.
- [x] **Safe release:** Preserve existing role/branch and sticker-allocation checks, make no database schema or migration changes, run focused checks, and push the completed code to GitHub. Do not deploy to the VPS as part of this task.


# Parcel Destination District Follow-up (2026-11-18)

- [ ] In Operations and Merchant Parcels tables, take the destination district from the recipient address, not the service zone. Match it to active Admin → Branches addresses; prefer one unique hub, otherwise a unique branch. If no matching location or multiple candidates exist, display the parsed district and explain the state rather than showing “Unassigned” or guessing. Keep this distinct from Bagging, which still displays its configured destination hub.
- [ ] Include the resolved destination/district in Merchant CSV export. Add no database schema or migration changes; newly added or updated active locations should be considered on the next parcel-list request.
- [ ] Run the focused address-resolution tests, typecheck/build, push the fix to GitHub, and deploy through the code-only VPS path without schema changes.


# Sender-Branch Parcels Isolation (explicitly approved 2026-11-18)

- [ ] Add nullable `origin_branch_id` plus index; keep `branch_id` as current accountability. Populate origin at all Merchant/Operations/counter and demo-seed parcel insertion paths.
- [ ] Scope Operations Parcels to the logged-in sender branch (hub plus its Admin-assigned children); keep Admin/global access and Merchant ownership behavior intact. Admin branch filter is by sender branch.
- [ ] Allow safe read-only timeline access for the sender after transfer; leave all status mutation gates on the current accountable branch and make the read-only state clear.
- [ ] Add a dry-run-first, idempotent backfill using the first valid accountability-transfer audit event, current branch only when no transfer exists, and NULL for malformed/ambiguous history. Require pinned target, plan hash, explicit apply confirmation, and verified pre-migration backup.
- [ ] Scratch-test schema synchronization, backfill and row scope; run typecheck/build, push to GitHub, then apply the explicit schema-enabled Production/Demo release and verify readiness and sender-only list behavior.


# Sender-Branch Parcel Register — Owner Approved (2026-11-18)

- [ ] Add nullable `origin_branch_id` and index; keep mutable `branch_id` as current accountability for transport/delivery/write checks.
- [ ] Set origin branch at all new single, counter, bulk, and seed booking paths; never alter it on custody transfer.
- [ ] Filter Operations Parcels by origin hub plus Admin-assigned child branches; keep global Admin/Finance/HR and merchant scopes intact. Sender-branch details remain read-only after transfer; receiver hubs do not see parcels they did not send.
- [ ] Safely backfill from the earliest audited accountability-transfer event; use current branch only when no transfer event exists. Leave malformed, conflicting, or dangling references unresolved instead of guessing.
- [ ] Implement read-only-by-default, pinned-target backfill CLI. Live apply requires durable verified backup ID, database fingerprint, reviewed plan hash, explicit confirmation and explicit partial-backfill permission when unresolved rows exist.
- [ ] Run scratch DB tests, typecheck, build, review exact schema diff; then prepare the approved schema-enabled Production/Demo release without running it unless the complete backup/backfill plan is verified.
