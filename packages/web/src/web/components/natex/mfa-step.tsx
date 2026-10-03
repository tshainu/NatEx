import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { ArrowLeft, KeyRound, ShieldCheck } from "lucide-react";
import { apiMessage, pendingClient } from "@/lib/api";
import type { ApiSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { ErrorNote } from "@/components/natex/page";

/**
 * The authenticator step of sign-in (§2 "TOTP MFA for ops/admin/finance").
 *
 * The phone OTP produced a PENDING session. This component never stores it: it
 * talks to the `mfa.*` routes with the pending token and hands the FULL session
 * to `onDone` once the code (or a recovery code) is accepted.
 *
 *   challenge — enter the 6-digit code, or switch to a recovery code
 *   enrol     — first sign-in: scan the QR, confirm one code, save the
 *               recovery codes (shown once), then continue
 */
export function MfaStep({
  pending,
  onDone,
  onCancel,
}: {
  pending: ApiSession;
  onDone: (session: ApiSession) => void;
  onCancel: () => void;
}) {
  const api = React.useMemo(() => pendingClient(pending.accessToken), [pending.accessToken]);
  return pending.mfa?.state === "enrol" ? (
    <EnrolStep api={api} name={pending.user.name} onDone={onDone} onCancel={onCancel} />
  ) : (
    <ChallengeStep api={api} devCode={pending.mfa?.devCode} onDone={onDone} onCancel={onCancel} />
  );
}

type Api = ReturnType<typeof pendingClient>;

const codeInputClass =
  "border-ink-600 bg-ink-900 text-center font-mono text-[20px] tracking-[0.35em] text-text-hi";

function useFocusOnMount<T extends HTMLElement>(dep: unknown) {
  const ref = React.useRef<T>(null);
  React.useEffect(() => {
    ref.current?.focus();
  }, [dep]);
  return ref;
}

function ChallengeStep({
  api,
  devCode,
  onDone,
  onCancel,
}: {
  api: Api;
  devCode?: string;
  onDone: (s: ApiSession) => void;
  onCancel: () => void;
}) {
  const [useRecovery, setUseRecovery] = React.useState(false);
  const [code, setCode] = React.useState(devCode ?? "");
  const inputRef = useFocusOnMount<HTMLInputElement>(useRecovery);
  const verify = useMutation({
    mutationFn: (value: string) => api.mfa.verify({ code: value }),
    onSuccess: (result) => onDone(result.session as ApiSession),
  });
  const ready = useRecovery ? code.replace(/[^0-9a-z]/gi, "").length === 10 : code.length === 6;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) verify.mutate(code.trim());
      }}
      className="space-y-4"
    >
      <div>
        <h2 className="font-display text-[18px] font-semibold">Authenticator code</h2>
        <p className="mt-1 text-[13px] text-text-lo">
          {useRecovery
            ? "Enter one of the recovery codes you saved when you set up the authenticator. Each works once."
            : "Open your authenticator app and enter the six-digit code shown for NatEx."}
        </p>
      </div>
      <Field label={useRecovery ? "Recovery code" : "Six-digit code"}>
        <Input
          ref={inputRef}
          value={code}
          onChange={(e) =>
            setCode(
              useRecovery
                ? e.target.value.toUpperCase().replace(/[^0-9A-Z-]/g, "").slice(0, 11)
                : e.target.value.replace(/\D/g, "").slice(0, 6),
            )
          }
          placeholder={useRecovery ? "XXXXX-XXXXX" : "000000"}
          inputMode={useRecovery ? "text" : "numeric"}
          autoComplete="one-time-code"
          className={codeInputClass}
        />
      </Field>
      {devCode && !useRecovery ? (
        <p className="flex items-start gap-2 rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-[12px] text-text-lo">
          <ShieldCheck className="mt-[1px] size-4 shrink-0 text-brand" aria-hidden />
          <span>
            Development seed account — the API supplied the current code and it is pre-filled. Real
            accounts and production never get this.
          </span>
        </p>
      ) : null}
      {verify.error ? <ErrorNote>{apiMessage(verify.error, "That code was not accepted.")}</ErrorNote> : null}
      <Button type="submit" className="w-full" pending={verify.isPending} disabled={!ready}>
        Verify and sign in
      </Button>
      <Button
        type="button"
        variant="dark"
        className="w-full"
        onClick={() => {
          setUseRecovery((v) => !v);
          setCode("");
          verify.reset();
        }}
      >
        <KeyRound aria-hidden />
        {useRecovery ? "Use the authenticator app instead" : "Lost your phone? Use a recovery code"}
      </Button>
      <Button type="button" variant="dark" className="w-full" onClick={onCancel}>
        <ArrowLeft aria-hidden />
        Start again
      </Button>
    </form>
  );
}

function EnrolStep({
  api,
  name,
  onDone,
  onCancel,
}: {
  api: Api;
  name: string;
  onDone: (s: ApiSession) => void;
  onCancel: () => void;
}) {
  const [code, setCode] = React.useState("");
  const [saved, setSaved] = React.useState<{ codes: string[]; session: ApiSession } | null>(null);
  const start = useMutation({ mutationFn: () => api.mfa.enrolStart() });
  const confirm = useMutation({
    mutationFn: (value: string) => api.mfa.enrolConfirm({ code: value }),
    onSuccess: (result) => {
      if (result.session) setSaved({ codes: result.recoveryCodes, session: result.session as ApiSession });
    },
  });
  const uri = start.data?.otpauthUri;
  const qr = useQuery({
    queryKey: ["mfa-qr", uri],
    queryFn: () => QRCode.toDataURL(uri!, { margin: 1, width: 200, errorCorrectionLevel: "M" }),
    enabled: Boolean(uri),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const codeRef = useFocusOnMount<HTMLInputElement>(uri);

  if (saved) {
    return <RecoveryCodes codes={saved.codes} onContinue={() => onDone(saved.session)} />;
  }

  if (!start.data) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="font-display text-[18px] font-semibold">Set up your authenticator</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-text-lo">
            {name}, your role signs in with a phone code <em>and</em> an authenticator app (Google
            Authenticator, Microsoft Authenticator, Authy or similar). This is a one-time setup.
          </p>
        </div>
        {start.error ? <ErrorNote>{apiMessage(start.error, "Could not start the setup.")}</ErrorNote> : null}
        <Button type="button" className="w-full" pending={start.isPending} onClick={() => start.mutate()}>
          <ShieldCheck aria-hidden />
          Set up authenticator
        </Button>
        <Button type="button" variant="dark" className="w-full" onClick={onCancel}>
          <ArrowLeft aria-hidden />
          Start again
        </Button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (code.length === 6) confirm.mutate(code);
      }}
      className="space-y-4"
    >
      <div>
        <h2 className="font-display text-[18px] font-semibold">Scan this code</h2>
        <p className="mt-1 text-[13px] text-text-lo">
          Add an account in your authenticator app and scan the QR, then enter the code it shows.
        </p>
      </div>
      <div className="grid place-items-center rounded-md bg-white p-3">
        {qr.data ? (
          <img src={qr.data} alt="QR code for adding NatEx to an authenticator app" width={200} height={200} />
        ) : (
          <div className="size-[200px]" aria-hidden />
        )}
      </div>
      <div className="rounded-md border border-ink-600 bg-ink-900 px-3 py-2">
        <p className="label-xs text-text-lo">Can't scan? Enter this key</p>
        <p className="mt-1 break-all font-mono text-[13px] text-text-hi" data-testid="mfa-secret">
          {start.data.secret.replace(/(.{4})/g, "$1 ").trim()}
        </p>
      </div>
      <Field label="Code from the app">
        <Input
          ref={codeRef}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="000000"
          inputMode="numeric"
          autoComplete="one-time-code"
          className={codeInputClass}
        />
      </Field>
      {confirm.error ? <ErrorNote>{apiMessage(confirm.error, "That code was not accepted.")}</ErrorNote> : null}
      <Button type="submit" className="w-full" pending={confirm.isPending} disabled={code.length !== 6}>
        Confirm authenticator
      </Button>
      <Button type="button" variant="dark" className="w-full" onClick={onCancel}>
        <ArrowLeft aria-hidden />
        Start again
      </Button>
    </form>
  );
}

/** Shown exactly once — the server keeps only hashes. Used by sign-in and the Security page. */
export function RecoveryCodes({ codes, onContinue, continueLabel = "I've saved them — continue" }: {
  codes: string[];
  onContinue: () => void;
  continueLabel?: string;
}) {
  const [acknowledged, setAcknowledged] = React.useState(false);
  const text = `NatEx recovery codes\nEach code works once. Keep them somewhere safe.\n\n${codes.join("\n")}\n`;
  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-[18px] font-semibold">Save your recovery codes</h2>
        <p className="mt-1 text-[13px] text-text-lo">
          If you lose your phone, each of these signs you in once. They are shown only now — NatEx stores
          only a fingerprint of each.
        </p>
      </div>
      <ol className="grid grid-cols-2 gap-1.5 rounded-md border border-ink-600 bg-ink-900 p-3" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c} className="font-mono text-[13px] text-text-hi" data-testid="recovery-code">
            {c}
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="dark"
          className="flex-1"
          onClick={() => void navigator.clipboard?.writeText(text)}
        >
          Copy
        </Button>
        <Button
          type="button"
          variant="dark"
          className="flex-1"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = "natex-recovery-codes.txt";
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Download
        </Button>
      </div>
      <label className="flex items-center gap-2 text-[13px] text-text-lo">
        <input
          type="checkbox"
          aria-label="I have saved my recovery codes"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
        />
        I have saved these codes somewhere safe
      </label>
      <Button type="button" className="w-full" disabled={!acknowledged} onClick={onContinue}>
        {continueLabel}
      </Button>
    </div>
  );
}
