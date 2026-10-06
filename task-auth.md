# Username/password auth + multi-role

## Backend
- [ ] schema identity_user: + username (unique, null), passwordHash (null), roles (JSON text, default "")
- [ ] shared/auth.ts: AccessClaims.roles?, Principal.roles?
- [ ] middleware/auth.ts: principal.roles; requireRole checks roles array; MFA via mfaRequiredForAny; rider device check via roles
- [ ] identity/mfa.ts: mfaRequiredForAny(roles)
- [ ] identity/service.ts: roles on IdentityUser, getUserByUsername, loginWithPassword, createUser(roles/username/password), signInLevel any-role, issueSession roles+username, IDLE_EXEMPT every-role, demo account creds
- [ ] identity/admin.ts: updateUser patch roles/username/password; activeAdminCount counts roles containing admin
- [ ] routes/identity.ts: loginPassword route (rate-limited), createUser input, me + roles/username
- [ ] routes/identity-admin.ts: updateUser input roles/username/password
- [ ] routes/mfa.ts role gate -> roles.some
- [ ] merchant-admin.ts createUser call
- [ ] seed.ts: usernames + password natex123 for staff

## Web
- [ ] session.ts: roles/username on SessionUser
- [ ] permissions.ts: portalForRoles, navForRoles
- [ ] shell.tsx, app.tsx, login.tsx (tabs), auth-provider
- [ ] admin/users.tsx + user-drawer.tsx: role checkboxes, username, password

## Mobile
- [ ] login screen: username/password primary

## Deploy
- [ ] check natex-deploy runs db:push; backfill roles on both Turso DBs; verify password login live
