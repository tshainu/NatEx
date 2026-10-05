import * as React from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { client, apiMessage } from "@/lib/api";
import { deviceId, isPendingMfa, storeApiSession, type ApiSession } from "@/lib/session";
import { portalForRoles, mayVisitAny, rolesOfUser } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { ErrorNote } from "@/components/natex/page";
import { MfaStep } from "@/components/natex/mfa-step";

/**
 * Phone + OTP sign-in (§2). Two steps: request a challenge, then verify the
 * six-digit code. The browser's persistent device id is presented on verify so
 * the server can bind the session to a device and write it into the audit trail.
 *
 * Ops, admin and finance then pass a third step — an authenticator code, or a
 * one-time enrolment on first sign-in (§2, M5). The pending session from the
 * phone step is held in component state only, never in storage.
 */

const DEMO_LOGINS = [
  { role: "Operations", phone: "+94772345678", name: "Priya Shanmugam" },
  { role: "Administrator", phone: "+94773456789", name: "Arjun Rajendran" },
  { role: "Merchant", phone: "+94775678901", name: "Sanjay Kumar" },
  { role: "Finance", phone: "+94774567890", name: "Kavitha Sivakumar" },
  { role: "Rider", phone: "+94771234567", name: "Karthik Selvaraj" },
  { role: "Transport", phone: "+94776789012", name: "Murugan Thevarajah" },
  { role: "Operations (Kandy)", phone: "+94779012345", name: "Lakshmi Nadarajah" },
];

export default function Login() {
  const [, navigate] = useLocation();
  const [phone, setPhone] = React.useState("");
  const [code, setCode] = React.useState("");
  const [method, setMethod] = React.useState<"phone" | "password">("phone");
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [challenge, setChallenge] = React.useState<{
    challengeId: string;
    expiresInSeconds: number;
    smsState: string;
    devCode?: string | null;
  } | null>(null);
  const [pending, setPending] = React.useState<ApiSession | null>(null);

  // Focus management rather than `autoFocus`: this is a two-step form, and
  // moving focus to the field the current step is about is what lets a keyboard
  // or screen-reader user carry on without hunting for it. Keyed on whether a
  // challenge exists, so focus follows the step change, once, in both
  // directions.
  const phoneRef = React.useRef<HTMLInputElement>(null);
  const codeRef = React.useRef<HTMLInputElement>(null);
  const step = challenge ? "code" : "phone";
  React.useEffect(() => {
    const target = step === "code" ? codeRef.current : phoneRef.current;
    target?.focus();
  }, [step]);

  const envInfo = useQuery({
    queryKey: ["identity", "environment"],
    queryFn: () => client.identity.environment(),
    staleTime: Infinity,
  });

  const request = useMutation({
    mutationFn: (value: string) => client.identity.requestOtp({ phone: value }),
    onSuccess: (data) => {
      setChallenge(data);
      setCode(data.devCode ?? "");
    },
  });

  const verify = useMutation({
    mutationFn: (input: { challengeId: string; code: string }) =>
      client.identity.verifyOtp({ ...input, deviceId: deviceId() }),
    onSuccess: (session) => {
      if (isPendingMfa(session as ApiSession)) setPending(session as ApiSession);
      else finish(session as ApiSession);
    },
  });

  const passwordLogin = useMutation({
    mutationFn: (input: { username: string; password: string }) =>
      client.identity.loginPassword({ ...input, deviceId: deviceId() }),
    onSuccess: (session) => {
      if (isPendingMfa(session as ApiSession)) setPending(session as ApiSession);
      else finish(session as ApiSession);
    },
  });

  function startOver() {
    setPending(null);
    setChallenge(null);
    setCode("");
    request.reset();
    verify.reset();
    passwordLogin.reset();
  }

  function finish(session: ApiSession) {
    const stored = storeApiSession(session);
    // Honour the screen the guard bounced us off, but only if this role may
    // actually reach it — otherwise land in the role's own portal.
    const roles = rolesOfUser(stored.user);
    const next = new URLSearchParams(window.location.search).get("next");
    const home = portalForRoles(roles).home;
    const target =
      next && next.startsWith("/") && mayVisitAny(roles, next) ? next : home;
    navigate(target, { replace: true });
  }

  return (
    <div className="dark grid min-h-screen bg-ink-900 text-text-hi lg:grid-cols-[minmax(0,1.15fr)_minmax(420px,1fr)]">
      {/* ── Brand panel ─────────────────────────────────────────────── */}
      <section
        aria-label="NatEx"
        className="relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between"
      >
        <img
          src="/images/login-hub.jpg"
          alt=""
          aria-hidden
          className="absolute inset-0 size-full object-cover"
        />
        <div
          aria-hidden
          className="absolute inset-0 bg-[linear-gradient(180deg,rgba(10,22,38,0.55)_0%,rgba(10,22,38,0.15)_35%,rgba(10,22,38,0.75)_70%,#0a1626_100%)]"
        />
        <div aria-hidden className="absolute inset-y-0 right-0 w-px bg-ink-600" />

        <div className="relative flex items-center gap-2.5 px-12 pt-10">
          <span className="grid size-10 place-items-center rounded-lg bg-brand font-display text-[18px] font-bold text-primary-foreground shadow-[0_0_0_4px_rgba(16,185,129,0.18)]">
            N
          </span>
          <span className="font-display text-[24px] font-bold tracking-tight">NatEx</span>
        </div>

        <div className="relative px-12 pb-12">
          <p className="font-display text-[12px] font-bold uppercase tracking-[0.14em] text-brand">
            Island-wide courier network
          </p>
          <h1 className="mt-3 max-w-xl font-display text-[40px] font-extrabold leading-[1.08] tracking-tight">
            Every parcel, every hand-off, accounted for.
          </h1>
          <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-text-hi/80">
            Booking, pickup, hub-to-hub linehaul, last-mile delivery with proof, COD
            and settlements — one platform for merchants, riders, operations and
            finance across Sri Lanka.
          </p>
          <dl className="mt-8 grid max-w-xl grid-cols-3 gap-px overflow-hidden rounded-lg border border-white/10 bg-white/10 backdrop-blur-sm">
            {[
              ["Custody", "Signed at every hand-off"],
              ["Proof", "OTP, photo, signature"],
              ["Cash", "COD tracked to the cent"],
            ].map(([term, detail]) => (
              <div key={term} className="bg-ink-900/70 px-4 py-3">
                <dt className="font-display text-[14px] font-bold text-text-hi">{term}</dt>
                <dd className="mt-0.5 text-[12px] text-text-lo">{detail}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ── Sign-in panel ───────────────────────────────────────────── */}
      <section className="flex flex-col justify-center px-6 py-10 sm:px-12">
        <div className="mx-auto w-full max-w-[400px]">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span className="grid size-9 place-items-center rounded-md bg-brand font-display text-[16px] font-bold text-primary-foreground">
              N
            </span>
            <span className="font-display text-[22px] font-bold tracking-tight">NatEx</span>
          </div>
          <p className="font-display text-[12px] font-bold uppercase tracking-[0.14em] text-text-lo">
            Welcome back
          </p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-text-lo">
            Sign in with your username and password, or with your registered phone
            number — a six-digit code is sent by SMS. Operations, finance and admin
            also confirm with an authenticator app.
          </p>

          <div className="mt-6 rounded-xl border border-ink-600 bg-ink-800 p-6 shadow-[0_24px_60px_-30px_rgba(0,0,0,0.6)]">
            {pending ? (
              <MfaStep pending={pending} onDone={finish} onCancel={startOver} />
            ) : method === "password" ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (username.trim().length >= 2 && password.length > 0)
                    passwordLogin.mutate({ username: username.trim(), password });
                }}
                className="space-y-4"
              >
                <div>
                  <h2 className="font-display text-[20px] font-bold">Sign in</h2>
                  <p className="mt-1 text-[13px] text-text-lo">
                    Username and password, as set by your administrator.
                  </p>
                </div>
                <Field label="Username">
                  <Input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="e.g. karthik"
                    autoComplete="username"
                    className="border-ink-600 bg-ink-900 font-mono text-text-hi"
                  />
                </Field>
                <Field label="Password">
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    className="border-ink-600 bg-ink-900 font-mono text-text-hi"
                  />
                </Field>
                {passwordLogin.error ? (
                  <ErrorNote>{apiMessage(passwordLogin.error, "Sign-in failed.")}</ErrorNote>
                ) : null}
                <Button
                  type="submit"
                  className="w-full"
                  pending={passwordLogin.isPending}
                  disabled={username.trim().length < 2 || password.length === 0}
                >
                  Sign in
                </Button>
                <Button
                  type="button"
                  variant="dark"
                  className="w-full"
                  onClick={() => {
                    setMethod("phone");
                    passwordLogin.reset();
                  }}
                >
                  <ArrowLeft aria-hidden />
                  Sign in with phone instead
                </Button>
              </form>
            ) : !challenge ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (phone.trim().length >= 9) request.mutate(phone.trim());
                }}
                className="space-y-4"
              >
                <div>
                  <h2 className="font-display text-[20px] font-bold">Sign in</h2>
                  <p className="mt-1 text-[13px] text-text-lo">
                    Enter the phone number on your NatEx account.
                  </p>
                </div>
                <Field label="Phone number">
                  <Input
                    ref={phoneRef}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+9477XXXXXXX"
                    inputMode="tel"
                    autoComplete="tel"
                    className="border-ink-600 bg-ink-900 font-mono text-text-hi"
                  />
                </Field>
                {request.error ? (
                  <ErrorNote>{apiMessage(request.error, "Could not send the code.")}</ErrorNote>
                ) : null}
                <Button
                  type="submit"
                  className="w-full"
                  pending={request.isPending}
                  disabled={phone.trim().length < 9}
                >
                  Send code
                </Button>
                <Button
                  type="button"
                  variant="dark"
                  className="w-full"
                  onClick={() => setMethod("password")}
                >
                  Sign in with username instead
                </Button>
              </form>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (code.trim().length === 6)
                    verify.mutate({ challengeId: challenge.challengeId, code: code.trim() });
                }}
                className="space-y-4"
              >
                <div>
                  <h2 className="font-display text-[18px] font-semibold">Enter your code</h2>
                  <p className="mt-1 text-[13px] text-text-lo">
                    Sent to <span className="font-mono text-text-hi">{phone}</span>. It
                    expires in {Math.round(challenge.expiresInSeconds / 60)} minutes.
                  </p>
                </div>
                <Field label="Six-digit code">
                  <Input
                    ref={codeRef}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="000000"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    className="border-ink-600 bg-ink-900 text-center font-mono text-[20px] tracking-[0.35em] text-text-hi"
                  />
                </Field>
                {challenge.devCode ? (
                  <p className="flex items-start gap-2 rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-[12px] text-text-lo">
                    <ShieldCheck className="mt-[1px] size-4 shrink-0 text-brand" aria-hidden />
                    <span>
                      SMS gateway not configured ({challenge.smsState}) — the code is
                      returned by the API in non-production and pre-filled above.
                    </span>
                  </p>
                ) : null}
                {verify.error ? (
                  <ErrorNote>{apiMessage(verify.error, "That code was not accepted.")}</ErrorNote>
                ) : null}
                <Button
                  type="submit"
                  className="w-full"
                  pending={verify.isPending}
                  disabled={code.trim().length !== 6}
                >
                  Verify and sign in
                </Button>
                <Button
                  type="button"
                  variant="dark"
                  className="w-full"
                  onClick={() => {
                    setChallenge(null);
                    setCode("");
                    verify.reset();
                  }}
                >
                  <ArrowLeft aria-hidden />
                  Use a different number
                </Button>
              </form>
            )}
          </div>

          {/* Demo and dev deployments only: production has no seeded accounts. */}
          {import.meta.env.DEV || envInfo.data?.demo ? (
            <>
              <SeededAccounts
                onPick={(value) => {
                  setPhone(value);
                  startOver();
                }}
              />
              <p className="mt-6 text-center text-[11px] text-text-lo/70">
                Milestones 1–5 · Collection, Custody, Delivery, Money &amp; Admin
              </p>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

/** Dev-only shortcut list. No SMS gateway here, so the code comes back in the response. */
function SeededAccounts({ onPick }: { onPick: (phone: string) => void }) {
  return (
    <div className="mt-5 rounded-xl border border-ink-600/70 bg-ink-900 p-4">
      <p className="label-xs text-text-lo">Seeded accounts</p>
      <p className="mt-1.5 text-[12px] text-text-lo">
        No SMS gateway is configured in this environment, so the code is returned in
        the response and filled in for you.
      </p>
      <ul className="mt-3 space-y-0.5">
        {DEMO_LOGINS.map((account) => (
          <li key={account.phone}>
            <button
              type="button"
              onClick={() => onPick(account.phone)}
              className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left transition-colors duration-120 hover:bg-ink-700 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand/40"
            >
              <span className="text-[13px] font-medium">{account.name}</span>
              <span className="flex items-center gap-2">
                <span className="text-[12px] text-text-lo">{account.role}</span>
                <span className="font-mono text-[12px] text-brand">{account.phone}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
