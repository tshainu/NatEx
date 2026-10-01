import * as React from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { client, apiMessage } from "@/lib/api";
import { deviceId, storeApiSession, type ApiSession } from "@/lib/session";
import { portalFor, mayVisit } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { ErrorNote } from "@/components/natex/page";
import { Badge } from "@/components/ui/badge";

/**
 * Phone + OTP sign-in (§2). Two steps: request a challenge, then verify the
 * six-digit code. The browser's persistent device id is presented on verify so
 * the server can bind the session to a device and write it into the audit trail.
 */

const DEMO_LOGINS = [
  { role: "Operations", phone: "+94772345678", name: "Nimali Perera" },
  { role: "Administrator", phone: "+94773456789", name: "Rajitha Silva" },
  { role: "Merchant", phone: "+94775678901", name: "Sanjay Kumar" },
  { role: "Finance", phone: "+94774567890", name: "Dilani Jayawardena" },
  { role: "Rider", phone: "+94771234567", name: "Pradeep Fernando" },
];

export default function Login() {
  const [, navigate] = useLocation();
  const [phone, setPhone] = React.useState("");
  const [code, setCode] = React.useState("");
  const [challenge, setChallenge] = React.useState<{
    challengeId: string;
    expiresInSeconds: number;
    smsState: string;
    devCode?: string | null;
  } | null>(null);

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
      const stored = storeApiSession(session as ApiSession);
      // Honour the screen the guard bounced us off, but only if this role may
      // actually reach it — otherwise land in the role's own portal.
      const next = new URLSearchParams(window.location.search).get("next");
      const home = portalFor(stored.user.role).home;
      const target =
        next && next.startsWith("/") && mayVisit(stored.user.role, next) ? next : home;
      navigate(target, { replace: true });
    },
  });

  return (
    <div className="dark flex min-h-screen items-center bg-ink-900 text-text-hi">
      <div className="mx-auto grid w-full max-w-5xl gap-10 px-6 py-12 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col justify-center">
          <div className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-md bg-brand font-display text-[16px] font-bold text-brand-ink">
              N
            </span>
            <span className="font-display text-[22px] font-bold tracking-tight">NatEx</span>
          </div>
          <h1 className="mt-7 max-w-lg font-display text-[30px] font-bold leading-[1.15]">
            Courier &amp; logistics operations, Sri Lanka
          </h1>
          <p className="mt-3 max-w-md text-[14px] leading-relaxed text-text-lo">
            Parcel booking with the full state machine, pickup collection,
            hub-to-hub custody, last-mile runsheets with proof of delivery, NDR and
            returns, and a merchant portal with bulk booking. Sign in with your
            registered phone number — a six-digit code is sent by SMS.
          </p>
          <Badge variant="dark" className="mt-6 w-fit">
            Milestones 1–3 · Collection, Custody &amp; Delivery
          </Badge>

          <div className="mt-8 max-w-md rounded-lg border border-ink-600 bg-ink-800 p-4">
            <p className="label-xs text-text-lo">Seeded accounts</p>
            <p className="mt-1.5 text-[12px] text-text-lo">
              No SMS gateway is configured in this environment, so the code is returned
              in the response and filled in for you.
            </p>
            <ul className="mt-3 space-y-1">
              {DEMO_LOGINS.map((account) => (
                <li key={account.phone}>
                  <button
                    type="button"
                    onClick={() => {
                      setPhone(account.phone);
                      setChallenge(null);
                      request.reset();
                      verify.reset();
                    }}
                    className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left transition-colors duration-120 hover:bg-ink-700"
                  >
                    <span className="text-[13px]">{account.name}</span>
                    <span className="flex items-center gap-2">
                      <span className="text-[12px] text-text-lo">{account.role}</span>
                      <span className="font-mono text-[12px] text-brand">{account.phone}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="flex items-center">
          <div className="w-full rounded-lg border border-ink-600 bg-ink-800 p-6">
            {!challenge ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (phone.trim().length >= 9) request.mutate(phone.trim());
                }}
                className="space-y-4"
              >
                <div>
                  <h2 className="font-display text-[18px] font-semibold">Sign in</h2>
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
        </div>
      </div>
    </div>
  );
}
