# Operations and system-icon release — 2026-11-06

The owner approved deployment on 2026-11-06 after the Git-only delivery of Operations allocated-branch Liveboard scope, searchable merchant booking, Admin-approved staff onboarding and website-matched system icons. This releases those changes together to Production and Demo; it does not alter tariffs, payroll calculations, accounts, SMS messages or APKs.

- [x] Implementation validation: 41 scoped regression tests, all-package TypeScript, lint and Vite web build passed. Independent approval audit review found no remaining blocker; transaction rollback and replay coverage passed. Website icon asset copies, dimensions, built links and initial title verified.
- [x] Fresh Production and Demo backup/restore drills passed on 2026-11-06. Production contained 162,543 rows and Demo 56,315 rows. Logical SQL dumps and manifests were copied off-host and SHA-256 checks matched; private recovery files are stored outside Git.
- [x] Schema push rehearsed on both restored copies: all 78 existing tables retained exact row counts and old-column content hashes, only the empty onboarding-request table and its indexes were added, and integrity/foreign-key checks passed.
- [ ] Publish the reviewed feature release to main and run the approved backup-aware `natex-deploy --with-schema`; restore and verify the auto-deploy timer.
- [ ] Verify both deployed revisions, request schema/indexes, public readiness and website icons, protected tariff/payroll data, Production sender NatEx and Demo `SMS_DISABLE_ALL=true`. No real SMS or production test records will be generated.
