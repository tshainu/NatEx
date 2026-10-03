import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc, apiMessage } from "@/lib/api";
import { dateTime, humanise } from "@/lib/format";
import { ROLE_LABEL } from "@/lib/permissions";
import type { Role } from "@/lib/session";
import { Input, Field, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Drawer } from "@/components/ui/drawer";
import { ErrorNote, SuccessNote, KeyValue, KeyValueGrid } from "@/components/natex/page";
import { useUserSessions } from "@/queries/admin";

/**
 * One user, managed (§10 M5 "admin portal: users, roles"): edit identity and
 * role, see live sessions and the MFA state, revoke sessions, reset a lost
 * authenticator. Every write is admin-only on the server; role, branch,
 * merchant or phone changes revoke the user's sessions server-side.
 */

export interface ManagedUser {
  id: string;
  name: string;
  phone: string;
  role: string;
  status: string;
  branchId: string;
  branchName: string | null;
  merchantId?: string | null;
}

const ROLES: Role[] = ["rider", "transport", "ops", "finance", "admin", "merchant"];
const MFA_ROLES = new Set(["ops", "admin", "finance"]);

export function UserDrawer({
  user,
  selfId,
  mfa,
  branches,
  onOpenChange,
}: {
  user: ManagedUser | null;
  selfId: string;
  mfa: { enrolled: boolean; seeded: boolean } | undefined;
  branches: { id: string; name: string }[];
  onOpenChange: (open: boolean) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [reasonFor, setReasonFor] = React.useState<"revoke" | "reset" | null>(null);
  const [note, setNote] = React.useState<{ ok: boolean; text: string } | null>(null);
  const sessions = useUserSessions(user?.id ?? null);
  React.useEffect(() => setNote(null), [user?.id]);

  const isSelf = user?.id === selfId;
  const mfaRole = user ? MFA_ROLES.has(user.role) : false;

  return (
    <>
      <Drawer
        open={Boolean(user)}
        onOpenChange={onOpenChange}
        title={user?.name ?? "User"}
        subtitle={user ? `${ROLE_LABEL[user.role as Role] ?? user.role} · ${user.branchName ?? user.branchId}` : undefined}
        footer={
          user ? (
            <Button className="w-full" onClick={() => setEditing(true)}>
              Edit user
            </Button>
          ) : null
        }
      >
        {user ? (
          <div className="flex flex-col gap-5">
            {note ? note.ok ? <SuccessNote>{note.text}</SuccessNote> : <ErrorNote>{note.text}</ErrorNote> : null}
            <KeyValueGrid>
              <KeyValue label="Phone" mono>
                {user.phone}
              </KeyValue>
              <KeyValue label="Status">{humanise(user.status)}</KeyValue>
              <KeyValue label="User id" mono className="col-span-2">
                {user.id}
              </KeyValue>
            </KeyValueGrid>

            <section aria-labelledby="mfa-h">
              <h3 id="mfa-h" className="label-xs mb-2 text-muted-foreground">
                Authenticator (MFA)
              </h3>
              {mfaRole ? (
                <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                  <div className="flex items-center gap-2">
                    {mfa?.enrolled ? (
                      <Badge variant="good">Enrolled</Badge>
                    ) : mfa ? (
                      <Badge variant="warn">Enrolment started, not confirmed</Badge>
                    ) : (
                      <Badge variant="warn">Not enrolled — sets up at next sign-in</Badge>
                    )}
                    {mfa?.seeded ? <Badge variant="muted">Development seed</Badge> : null}
                  </div>
                  <p className="text-[12px] text-muted-foreground">
                    Required for ops, admin and finance (§2). A reset deletes the authenticator and the
                    recovery codes and signs the user out; they enrol again at next sign-in.
                  </p>
                  {mfa ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-fit"
                      disabled={isSelf}
                      onClick={() => setReasonFor("reset")}
                    >
                      Reset authenticator
                    </Button>
                  ) : null}
                  {isSelf ? (
                    <p className="text-[12px] text-muted-foreground">
                      You cannot reset your own authenticator — another admin does it.
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="text-[13px] text-muted-foreground">
                  Not required for the {ROLE_LABEL[user.role as Role] ?? user.role} role.
                </p>
              )}
            </section>

            <section aria-labelledby="sessions-h">
              <div className="mb-2 flex items-center justify-between">
                <h3 id="sessions-h" className="label-xs text-muted-foreground">
                  Live sessions ({sessions.data?.length ?? 0})
                </h3>
                {(sessions.data?.length ?? 0) > 0 ? (
                  <Button variant="outline" size="sm" onClick={() => setReasonFor("revoke")}>
                    Sign out everywhere
                  </Button>
                ) : null}
              </div>
              {sessions.error ? <ErrorNote>{apiMessage(sessions.error, "Sessions are unavailable.")}</ErrorNote> : null}
              <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
                {(sessions.data ?? []).map((s) => (
                  <li key={s.id} className="px-3 py-2 text-[12px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono">{s.deviceId ?? "no device id"}</span>
                      <Badge variant={s.mfaLevel === "verified" ? "good" : "muted"}>MFA {humanise(s.mfaLevel)}</Badge>
                    </div>
                    <p className="mt-1 text-muted-foreground">
                      Signed in {dateTime(s.startedAt)} · last refresh {dateTime(s.lastRefreshedAt)}
                    </p>
                  </li>
                ))}
                {sessions.data && sessions.data.length === 0 ? (
                  <li className="px-3 py-3 text-[13px] text-muted-foreground">No live session.</li>
                ) : null}
              </ul>
            </section>
          </div>
        ) : null}
      </Drawer>

      {user ? (
        <EditUserDialog
          key={user.id}
          open={editing}
          onOpenChange={setEditing}
          user={user}
          isSelf={isSelf}
          branches={branches}
          onSaved={(text) => {
            setEditing(false);
            setNote({ ok: true, text });
          }}
        />
      ) : null}

      {user && reasonFor ? (
        <ReasonDialog
          kind={reasonFor}
          user={user}
          onClose={() => setReasonFor(null)}
          onDone={(text, ok) => {
            setReasonFor(null);
            setNote({ ok, text });
          }}
        />
      ) : null}
    </>
  );
}

function EditUserDialog({
  open,
  onOpenChange,
  user,
  isSelf,
  branches,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: ManagedUser;
  isSelf: boolean;
  branches: { id: string; name: string }[];
  onSaved: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState(user.name);
  const [phone, setPhone] = React.useState(user.phone);
  const [role, setRole] = React.useState(user.role as Role);
  const [branchId, setBranchId] = React.useState(user.branchId);
  const [merchantId, setMerchantId] = React.useState(user.merchantId ?? "");
  const [problem, setProblem] = React.useState<string | null>(null);

  const merchants = useQuery({
    ...orpc.merchants.options.queryOptions(),
    enabled: open && role === "merchant",
    staleTime: 5 * 60_000,
  });

  const save = useMutation({
    ...orpc.identity.updateUser.mutationOptions(),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      const revokes = role !== user.role || branchId !== user.branchId || phone.trim() !== user.phone || (merchantId || null) !== (user.merchantId ?? null);
      onSaved(revokes ? "Saved. The user's sessions were revoked — they sign in again." : "Saved.");
    },
    onError: (error) => setProblem(apiMessage(error, "This change could not be saved.")),
  });

  const patch: Parameters<typeof save.mutate>[0] = { userId: user.id };
  if (name.trim() !== user.name) patch.name = name.trim();
  if (phone.trim() !== user.phone) patch.phone = phone.trim();
  if (role !== user.role) patch.role = role;
  if (branchId !== user.branchId) patch.branchId = branchId;
  if (role === "merchant" && merchantId && merchantId !== (user.merchantId ?? "")) patch.merchantId = merchantId;
  if (role !== "merchant" && user.merchantId) patch.merchantId = null;
  const changed = Object.keys(patch).length > 1;
  const sensitive = patch.role !== undefined || patch.branchId !== undefined || patch.phone !== undefined || patch.merchantId !== undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Edit ${user.name}`}
      description="A change of role, branch, merchant or phone signs the user out everywhere: their old token carried the old scope."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!changed || name.trim().length < 2 || (role === "merchant" && !merchantId)}
            pending={save.isPending}
            onClick={() => {
              setProblem(null);
              save.mutate(patch);
            }}
          >
            Save changes
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Full name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Phone number" hint="This is the login.">
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} className="font-mono" />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Role" hint={isSelf ? "You cannot change your own role." : undefined}>
            <Select value={role} disabled={isSelf} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Branch">
            <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {role === "merchant" ? (
          <Field label="Merchant account">
            <Select value={merchantId} onChange={(e) => setMerchantId(e.target.value)}>
              <option value="">Choose a merchant</option>
              {(merchants.data ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {sensitive ? (
          <p className="rounded-md border border-status-warn/40 bg-status-warn/10 px-3 py-2 text-[12px] text-status-warn">
            Saving signs this user out on every device.
          </p>
        ) : null}
        {problem ? <ErrorNote>{problem}</ErrorNote> : null}
      </div>
    </Dialog>
  );
}

function ReasonDialog({
  kind,
  user,
  onClose,
  onDone,
}: {
  kind: "revoke" | "reset";
  user: ManagedUser;
  onClose: () => void;
  onDone: (message: string, ok: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = React.useState("");
  const handlers = {
    onSuccess: () => {
      void queryClient.invalidateQueries();
      onDone(kind === "reset" ? "Authenticator reset. The user enrols again at next sign-in." : "Every session was revoked.", true);
    },
    onError: (error: unknown) => onDone(apiMessage(error, "That could not be done."), false),
  };
  const revoke = useMutation({ ...orpc.identity.revokeUserSessions.mutationOptions(), ...handlers });
  const reset = useMutation({ ...orpc.mfa.reset.mutationOptions(), ...handlers });
  const pending = revoke.isPending || reset.isPending;

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={kind === "reset" ? "Reset this user's authenticator?" : "Sign this user out everywhere?"}
      description={
        kind === "reset"
          ? "Use this when a phone is lost or replaced. The authenticator and every recovery code are deleted and all sessions end."
          : "Every refresh token is revoked; open screens stop working within 15 minutes, when their access token expires."
      }
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={reason.trim().length < 5}
            pending={pending}
            onClick={() =>
              kind === "reset"
                ? reset.mutate({ userId: user.id, reason: reason.trim() })
                : revoke.mutate({ userId: user.id, reason: reason.trim() })
            }
          >
            {kind === "reset" ? "Reset authenticator" : "Revoke sessions"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[12px]">
          {user.name} · {user.phone}
        </p>
        <Field label="Reason" hint="Recorded in the audit log. At least 5 characters.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
