import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LogOut, ShieldCheck } from "lucide-react";
import { orpc, apiMessage } from "@/lib/api";
import { deviceId } from "@/lib/session";
import { dateTime, humanise, since } from "@/lib/format";
import { Field, Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Page, Card, ErrorNote, KeyValue, KeyValueGrid, SuccessNote } from "@/components/natex/page";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { RecoveryCodes } from "@/components/natex/mfa-step";
import { useAuth } from "@/components/auth-provider";
import { useMfaStatus, useMySessions, type SessionRow } from "@/queries/admin";

/**
 * The signed-in user's own security settings (§2): authenticator state,
 * recovery codes, and the sessions signed in as them. Every web role reaches
 * this page; the authenticator card only appears for the roles §2 puts behind
 * TOTP (ops, admin, finance).
 */

const MFA_ROLES = new Set(["ops", "admin", "finance"]);

export default function SecurityPage() {
  const { session } = useAuth();
  const role = session!.user.role;
  const usesMfa = MFA_ROLES.has(role);

  return (
    <Page title="Security" description="Your sign-in protection and the devices signed in as you.">
      {usesMfa ? <AuthenticatorCard /> : null}
      <SessionsCard />
    </Page>
  );
}

function AuthenticatorCard() {
  const status = useMfaStatus(true);
  const [regenOpen, setRegenOpen] = React.useState(false);
  const s = status.data;

  return (
    <Card
      title="Authenticator app"
      description="Ops, admin and finance accounts sign in with a phone OTP and then a 6-digit code from an authenticator app."
      actions={
        s?.enrolled ? (
          <Button size="sm" variant="outline" onClick={() => setRegenOpen(true)}>
            <KeyRound aria-hidden />
            New recovery codes
          </Button>
        ) : null
      }
    >
      {status.error ? <ErrorNote>{apiMessage(status.error, "Authenticator status is unavailable.")}</ErrorNote> : null}
      {s ? (
        <KeyValueGrid>
          <KeyValue label="Status">
            {s.enrolled ? (
              <Badge variant="good" data-testid="mfa-enrolled">
                <ShieldCheck aria-hidden className="size-3" /> Enrolled
              </Badge>
            ) : (
              <Badge variant="warn">Not enrolled</Badge>
            )}
          </KeyValue>
          <KeyValue label="Enrolled on">{s.confirmedAt ? dateTime(s.confirmedAt) : "—"}</KeyValue>
          <KeyValue label="Recovery codes left">
            <span data-testid="recovery-remaining" className={s.enrolled && s.recoveryCodesRemaining <= 2 ? "font-semibold text-destructive" : undefined}>
              {s.enrolled ? `${s.recoveryCodesRemaining} of 10` : "—"}
            </span>
          </KeyValue>
          <KeyValue label="This session">{humanise(s.sessionLevel)}</KeyValue>
          {s.seeded ? (
            <KeyValue label="Note" className="col-span-2">
              This authenticator was created by the development seed. Ask an administrator to reset it before go-live
              so you enrol your own.
            </KeyValue>
          ) : null}
          {!s.required ? (
            <KeyValue label="Policy" className="col-span-2">
              MFA enforcement is switched off in session settings. Your factor still works when it is switched back on.
            </KeyValue>
          ) : null}
        </KeyValueGrid>
      ) : null}
      {s?.enrolled && s.recoveryCodesRemaining <= 2 ? (
        <p className="mt-3 text-[12px] text-destructive">
          You are nearly out of recovery codes. Generate a new set — it replaces the old ones.
        </p>
      ) : null}
      <RegenerateDialog open={regenOpen} onClose={() => setRegenOpen(false)} />
    </Card>
  );
}

function RegenerateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [code, setCode] = React.useState("");
  const [codes, setCodes] = React.useState<string[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const regen = useMutation({
    ...orpc.mfa.regenerateRecoveryCodes.mutationOptions(),
    onSuccess: (out) => {
      setError(null);
      setCodes(out.recoveryCodes);
      void queryClient.invalidateQueries({ queryKey: orpc.mfa.status.key() });
    },
    onError: (e) => setError(apiMessage(e, "New codes could not be issued.")),
  });
  const close = () => {
    setCode("");
    setCodes(null);
    setError(null);
    onClose();
  };
  const valid = /^\d{6}$/.test(code);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title={codes ? "Your new recovery codes" : "Generate new recovery codes"}
      description={codes ? undefined : "Your old codes stop working the moment the new ones are issued."}
    >
      {codes ? (
        <div className="dark rounded-lg bg-ink-800 p-4 text-text-hi">
          <RecoveryCodes codes={codes} onContinue={close} continueLabel="I've saved them — close" />
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) regen.mutate({ code });
          }}
        >
          <Field label="Current authenticator code" hint="Prove it is you: the 6 digits your app shows now.">
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              className="font-mono tracking-[0.3em]"
              data-testid="regen-code"
            />
          </Field>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid} pending={regen.isPending}>
              Issue new codes
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function SessionsCard() {
  const queryClient = useQueryClient();
  const sessions = useMySessions();
  const mine = deviceId();
  const [target, setTarget] = React.useState<SessionRow | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const revoke = useMutation({
    ...orpc.identity.revokeMySession.mutationOptions(),
    onSuccess: () => {
      setTarget(null);
      setError(null);
      setNote("Session signed out. That device must sign in again.");
      void queryClient.invalidateQueries({ queryKey: orpc.identity.mySessions.key() });
    },
    onError: (e) => {
      setTarget(null);
      setError(apiMessage(e, "The session could not be signed out."));
    },
  });

  const columns: Column<SessionRow>[] = [
    {
      key: "device",
      header: "Device",
      cell: (r) => (
        <span className="flex items-center gap-2">
          <MonoCell>{r.deviceId ? r.deviceId.slice(0, 12) : "unknown"}</MonoCell>
          {r.deviceId === mine ? <Badge variant="brand">This browser</Badge> : null}
        </span>
      ),
    },
    { key: "mfa", header: "Verified with", width: "w-[140px]", cell: (r) => humanise(r.mfaLevel ?? "none") },
    { key: "started", header: "Signed in", width: "w-[170px]", className: "text-[12px]", cell: (r) => dateTime(r.startedAt) },
    { key: "last", header: "Last active", width: "w-[130px]", className: "text-[12px]", cell: (r) => since(r.lastRefreshedAt) },
    { key: "expires", header: "Expires", width: "w-[170px]", className: "text-[12px]", cell: (r) => dateTime(r.expiresAt) },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "w-[110px]",
      cell: (r) => (
        <Button size="sm" variant="ghost" onClick={() => setTarget(r)} aria-label={`Sign out session ${r.id}`}>
          <LogOut aria-hidden />
          Sign out
        </Button>
      ),
    },
  ];

  return (
    <Card title="Signed-in sessions" description="Each device that can refresh a sign-in as you. Sign out any you do not recognise." bodyClassName="p-0">
      {note ? <SuccessNote>{note}</SuccessNote> : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <DataTable
        columns={columns}
        rows={sessions.data ?? []}
        rowKey={(r) => r.id}
        loading={sessions.isPending}
        error={sessions.isError ? "Sessions could not be loaded." : null}
        emptyTitle="No active sessions"
        dense
      />
      <ConfirmDialog
        open={Boolean(target)}
        onOpenChange={(o) => !o && setTarget(null)}
        title="Sign out this session?"
        objectName={target?.deviceId === mine ? "this browser" : `device ${target?.deviceId?.slice(0, 12) ?? "unknown"}`}
        body={
          target?.deviceId === mine
            ? "This is the browser you are using. You will be asked to sign in again when your current access expires."
            : "That device keeps working only until its current access token expires (minutes), then must sign in again."
        }
        confirmLabel="Sign out"
        destructive
        pending={revoke.isPending}
        onConfirm={() => target && revoke.mutate({ sessionId: target.id })}
      />
    </Card>
  );
}
