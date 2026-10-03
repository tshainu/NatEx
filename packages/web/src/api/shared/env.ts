/**
 * Is this a development or test process? (M5 security review.)
 *
 * Every dev affordance — the SMS `devCode` on sign-in, the seeded TOTP factor
 * and its `devCode`, the fallback JWT and MFA keys, the destructive seed — is
 * behind this one check, and it FAILS CLOSED: only an explicit
 * NODE_ENV=development or NODE_ENV=test turns them on. A production deploy that
 * forgets to set NODE_ENV behaves like production, not like a dev box.
 * (Previously each site tested `NODE_ENV === "production"`, so an unset
 * NODE_ENV exposed sign-in codes and signed tokens with a public key.)
 */
export function isDevelopment(): boolean {
  const env = process.env.NODE_ENV;
  return env === "development" || env === "test";
}
