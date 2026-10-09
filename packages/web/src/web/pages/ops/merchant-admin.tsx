import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { orpc, apiMessage } from "@/lib/api";
import { Input, Field, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, ConfirmDialog } from "@/components/ui/dialog";
import { ErrorNote } from "@/components/natex/page";
import { useMerchantPortalUsers, useRateCards } from "@/queries/admin";

/**
 * Merchant onboarding and maintenance (§10 M5 "merchant onboarding").
 * - Edit details: ops and admin (merchants.update; only admin may move branch).
 * - Onboard (merchant + first portal user + rate card in one write): admin.
 * - Rate-card assignment and the portal-user list: admin.
 * The server enforces every one of these; the page only hides what would be refused.
 */

type Pod = "signature" | "otp" | "photo";

export interface EditableMerchant {
  id: string;
  branchId: string;
  name: string;
  vatNo: string | null;
  address: string;
  contactName: string;
  contactPhone: string;
  rateCardId: string | null;
  codEnabled: boolean;
  podPolicy: string;
}

interface MerchantForm {
  name: string;
  branchId: string;
  vatNo: string;
  address: string;
  contactName: string;
  contactPhone: string;
  codEnabled: boolean;
  podPolicy: Pod;
}

function MerchantFields({
  form,
  set,
  branches,
  branchLocked,
}: {
  form: MerchantForm;
  set: <K extends keyof MerchantForm>(key: K, value: MerchantForm[K]) => void;
  branches: { id: string; name: string }[];
  branchLocked?: boolean;
}) {
  return (
    <>
      <Field label="Trading name">
        <Input value={form.name} onChange={(e) => set("name", e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Owning branch" hint={branchLocked ? "Only an admin may move a merchant." : undefined}>
          <Select value={form.branchId} disabled={branchLocked} onChange={(e) => set("branchId", e.target.value)}>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="VAT number" hint="Optional.">
          <Input value={form.vatNo} onChange={(e) => set("vatNo", e.target.value)} className="font-mono" />
        </Field>
      </div>
      <Field label="Pickup address">
        <Textarea value={form.address} onChange={(e) => set("address", e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Contact name">
          <Input value={form.contactName} onChange={(e) => set("contactName", e.target.value)} />
        </Field>
        <Field label="Contact phone">
          <Input value={form.contactPhone} onChange={(e) => set("contactPhone", e.target.value)} className="font-mono" />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="COD">
          <Select value={form.codEnabled ? "yes" : "no"} onChange={(e) => set("codEnabled", e.target.value === "yes")}>
            <option value="yes">Enabled</option>
            <option value="no">Disabled</option>
          </Select>
        </Field>
        <Field label="POD policy">
          <Select value={form.podPolicy} onChange={(e) => set("podPolicy", e.target.value as Pod)}>
            <option value="signature">Signature</option>
            <option value="otp">OTP</option>
            <option value="photo">Photo</option>
          </Select>
        </Field>
      </div>
    </>
  );
}

function formValid(f: MerchantForm): boolean {
  return (
    f.name.trim().length >= 2 &&
    Boolean(f.branchId) &&
    f.address.trim().length >= 4 &&
    f.contactName.trim().length >= 2 &&
    f.contactPhone.trim().length >= 9
  );
}

// ------------------------------------------------------------------- edit

export function EditMerchantDialog({
  merchant,
  isAdmin,
  branches,
  onClose,
}: {
  merchant: EditableMerchant;
  isAdmin: boolean;
  branches: { id: string; name: string }[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const initial: MerchantForm = {
    name: merchant.name,
    branchId: merchant.branchId,
    vatNo: merchant.vatNo ?? "",
    address: merchant.address,
    contactName: merchant.contactName,
    contactPhone: merchant.contactPhone,
    codEnabled: merchant.codEnabled,
    podPolicy: merchant.podPolicy as Pod,
  };
  const [form, setForm] = React.useState(initial);
  const [problem, setProblem] = React.useState<string | null>(null);
  const set = <K extends keyof MerchantForm>(key: K, value: MerchantForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const save = useMutation({
    ...orpc.merchants.update.mutationOptions(),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      onClose();
    },
    onError: (error) => setProblem(apiMessage(error, "This merchant could not be saved.")),
  });

  const patch: {
    id: string;
    name?: string;
    branchId?: string;
    vatNo?: string | null;
    address?: string;
    contactName?: string;
    contactPhone?: string;
    codEnabled?: boolean;
    podPolicy?: Pod;
  } = { id: merchant.id };
  if (form.name.trim() !== initial.name) patch.name = form.name.trim();
  if (form.branchId !== initial.branchId) patch.branchId = form.branchId;
  if (form.vatNo.trim() !== initial.vatNo) patch.vatNo = form.vatNo.trim() || null;
  if (form.address.trim() !== initial.address) patch.address = form.address.trim();
  if (form.contactName.trim() !== initial.contactName) patch.contactName = form.contactName.trim();
  if (form.contactPhone.trim() !== initial.contactPhone) patch.contactPhone = form.contactPhone.trim();
  if (form.codEnabled !== initial.codEnabled) patch.codEnabled = form.codEnabled;
  if (form.podPolicy !== initial.podPolicy) patch.podPolicy = form.podPolicy;
  const changed = Object.keys(patch).length > 1;

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Edit ${merchant.name}`}
      description="Changes apply to new bookings. Parcels already booked keep the COD and POD terms they were booked under."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!changed || !formValid(form)}
            pending={save.isPending}
            onClick={() => {
              setProblem(null);
              save.mutate(patch);
            }}
          >
            Save merchant
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <MerchantFields form={form} set={set} branches={branches} branchLocked={!isAdmin} />
        {problem ? <ErrorNote>{problem}</ErrorNote> : null}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------- onboard

export function OnboardMerchantDialog({
  open,
  onOpenChange,
  branches,
  defaultBranchId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branches: { id: string; name: string }[];
  defaultBranchId: string;
  onDone: (merchantId: string) => void;
}) {
  const queryClient = useQueryClient();
  const cards = useRateCards();
  const blank: MerchantForm = {
    name: "",
    branchId: defaultBranchId,
    vatNo: "",
    address: "",
    contactName: "",
    contactPhone: "",
    codEnabled: true,
    podPolicy: "signature",
  };
  const [form, setForm] = React.useState(blank);
  const [rateCardId, setRateCardId] = React.useState("");
  const [withPortal, setWithPortal] = React.useState(true);
  const [portalName, setPortalName] = React.useState("");
  const [portalPhone, setPortalPhone] = React.useState("");
  const [withPasswordLogin, setWithPasswordLogin] = React.useState(true);
  const [portalUsername, setPortalUsername] = React.useState("");
  const [portalPassword, setPortalPassword] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const set = <K extends keyof MerchantForm>(key: K, value: MerchantForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const changeOpen = (next: boolean) => {
    if (!next) {
      setPortalPassword("");
      setPortalUsername("");
      setProblem(null);
    }
    onOpenChange(next);
  };

  const onboard = useMutation({
    ...orpc.merchants.onboard.mutationOptions(),
    onSuccess: (result) => {
      void queryClient.invalidateQueries();
      setForm(blank);
      setRateCardId("");
      setPortalName("");
      setPortalPhone("");
      setWithPasswordLogin(true);
      setPortalUsername("");
      setPortalPassword("");
      onDone(result.merchant.id);
    },
    onError: (error) => setProblem(apiMessage(error, "This merchant could not be onboarded.")),
  });

  const assignable = (cards.data ?? []).filter((c) => c.activeVersion);
  const chosen = assignable.find((c) => c.id === rateCardId);
  const portalOk =
    !withPortal ||
    (portalName.trim().length >= 2 &&
      portalPhone.trim().length >= 9 &&
      (!withPasswordLogin || (portalUsername.trim().length >= 2 && portalPassword.length >= 8)));

  return (
    <Dialog
      open={open}
      onOpenChange={changeOpen}
      title="Onboard a merchant"
      description="Creates the merchant, its first merchant-portal login and its rate card in one audited step. The portal phone and username are checked first, so a clash is reported before creating the merchant."
      className="w-[560px]"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => changeOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={!formValid(form) || !portalOk}
            pending={onboard.isPending}
            onClick={() => {
              setProblem(null);
              onboard.mutate({
                name: form.name.trim(),
                branchId: form.branchId,
                vatNo: form.vatNo.trim() || null,
                address: form.address.trim(),
                contactName: form.contactName.trim(),
                contactPhone: form.contactPhone.trim(),
                codEnabled: form.codEnabled,
                podPolicy: form.podPolicy,
                rateCardId: rateCardId || null,
                portalUser: withPortal
                  ? {
                      name: portalName.trim(),
                      phone: portalPhone.trim(),
                      ...(withPasswordLogin
                        ? { username: portalUsername.trim(), password: portalPassword }
                        : {}),
                    }
                  : null,
              });
            }}
          >
            Onboard merchant
          </Button>
        </div>
      }
    >
      <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto pr-1">
        <MerchantFields form={form} set={set} branches={branches} />
        <Field label="Rate card" hint="Only cards with a published version can be assigned.">
          <Select value={rateCardId} onChange={(e) => setRateCardId(e.target.value)}>
            <option value="">None yet</option>
            {assignable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} · {c.name}
                {c.placeholder ? " (PLACEHOLDER)" : ""}
              </option>
            ))}
          </Select>
        </Field>
        {chosen?.placeholder ? <PlaceholderWarning /> : null}
        <div className="flex flex-col gap-3 rounded-md border border-border p-3">
          <label className="flex items-center gap-2 text-[13px] font-medium">
            <input
              type="checkbox"
              aria-label="Create a merchant-portal login"
              checked={withPortal}
              onChange={(e) => setWithPortal(e.target.checked)}
            />
            Create a merchant-portal login
          </label>
          {withPortal ? (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-4">
                <Field label="Account holder name">
                  <Input value={portalName} onChange={(e) => setPortalName(e.target.value)} />
                </Field>
                <Field label="Login phone" hint="Can also sign in with a one-time code.">
                  <Input value={portalPhone} onChange={(e) => setPortalPhone(e.target.value)} className="font-mono" />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-[13px] font-medium">
                <input
                  type="checkbox"
                  aria-label="Enable username and password sign-in"
                  checked={withPasswordLogin}
                  onChange={(e) => {
                    setWithPasswordLogin(e.target.checked);
                    if (!e.target.checked) {
                      setPortalUsername("");
                      setPortalPassword("");
                    }
                  }}
                />
                Also enable username and password sign-in
              </label>
              {withPasswordLogin ? (
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Username">
                    <Input
                      value={portalUsername}
                      onChange={(e) => setPortalUsername(e.target.value)}
                      autoCapitalize="none"
                      autoCorrect="off"
                      autoComplete="username"
                      placeholder="e.g. acme-courier"
                    />
                  </Field>
                  <Field label="Temporary password" hint="At least 8 characters. Share it directly with the merchant.">
                    <Input
                      type="password"
                      value={portalPassword}
                      onChange={(e) => setPortalPassword(e.target.value)}
                      autoComplete="new-password"
                      minLength={8}
                    />
                  </Field>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        {problem ? <ErrorNote>{problem}</ErrorNote> : null}
      </div>
    </Dialog>
  );
}

export function PlaceholderWarning() {
  return (
    <p className="rounded-md border border-status-warn/40 bg-status-warn/10 px-3 py-2 text-[12px] leading-relaxed text-status-warn">
      PLACEHOLDER tariff. §15 q3 (zones, weight slabs, surcharges) is not answered and these prices are
      not client-approved. Do not quote them to a merchant as real prices.
    </p>
  );
}

// ------------------------------------------------------------------- drawer sections

export function RateCardSection({ merchant, isAdmin }: { merchant: EditableMerchant; isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const cards = useRateCards();
  const [choice, setChoice] = React.useState(merchant.rateCardId ?? "");
  const [confirming, setConfirming] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  React.useEffect(() => setChoice(merchant.rateCardId ?? ""), [merchant.rateCardId]);

  const assign = useMutation({
    ...orpc.rateCards.assign.mutationOptions(),
    onSuccess: () => {
      setConfirming(false);
      void queryClient.invalidateQueries();
    },
    onError: (error) => {
      setConfirming(false);
      setProblem(apiMessage(error, "The rate card could not be assigned."));
    },
  });

  const current = (cards.data ?? []).find((c) => c.id === merchant.rateCardId);
  const assignable = (cards.data ?? []).filter((c) => c.activeVersion);
  const next = assignable.find((c) => c.id === choice);

  return (
    <section aria-labelledby="rate-card-h" className="flex flex-col gap-2">
      <h3 id="rate-card-h" className="label-xs text-muted-foreground">
        Rate card
      </h3>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        {current ? (
          <>
            <span className="font-mono font-medium">{current.code}</span>
            <span className="text-muted-foreground">{current.name}</span>
            {current.placeholder ? <Badge variant="warn">Placeholder</Badge> : null}
          </>
        ) : merchant.rateCardId ? (
          <span className="font-mono">{merchant.rateCardId}</span>
        ) : (
          <span className="text-muted-foreground">Not assigned — this merchant cannot be priced automatically.</span>
        )}
      </div>
      {isAdmin ? (
        <div className="flex items-end gap-2">
          <Field label="Assign" className="flex-1">
            <Select value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value="">No rate card</option>
              {assignable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} · {c.name}
                  {c.placeholder ? " (PLACEHOLDER)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Button variant="outline" disabled={choice === (merchant.rateCardId ?? "")} onClick={() => setConfirming(true)}>
            Assign
          </Button>
        </div>
      ) : null}
      {problem ? <ErrorNote>{problem}</ErrorNote> : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={choice ? "Assign this rate card?" : "Remove the rate card?"}
        objectName={merchant.name}
        destructive={!choice}
        confirmLabel={choice ? "Assign" : "Remove"}
        pending={assign.isPending}
        body={
          <div className="flex flex-col gap-2">
            <p>
              {choice
                ? `New quotes for this merchant will use ${next?.code ?? choice}'s published version.`
                : "This merchant will have no tariff; automatic quotes will be refused."}
            </p>
            {next?.placeholder ? <PlaceholderWarning /> : null}
          </div>
        }
        onConfirm={() => assign.mutate({ merchantId: merchant.id, rateCardId: choice || null })}
      />
    </section>
  );
}

export function PortalUsersSection({ merchantId }: { merchantId: string }) {
  const users = useMerchantPortalUsers(merchantId, true);
  const [editing, setEditing] = React.useState<PortalUserForEdit | null>(null);
  return (
    <section aria-labelledby="portal-users-h">
      <h3 id="portal-users-h" className="label-xs mb-2 text-muted-foreground">
        Merchant-portal logins ({users.data?.length ?? 0})
      </h3>
      {users.error ? <ErrorNote>{apiMessage(users.error, "Portal logins are unavailable.")}</ErrorNote> : null}
      <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
        {(users.data ?? []).map((u) => (
          <li key={u.id} className="flex items-center gap-3 px-3 py-2 text-[12px]">
            <span className="min-w-0 flex-1 truncate font-medium">{u.name}</span>
            <span className="font-mono text-muted-foreground">{u.username ?? "phone login"}</span>
            <span className="font-mono text-muted-foreground">{u.phone}</span>
            <Badge variant={u.status === "active" ? "good" : "warn"}>{u.status}</Badge>
            <Button variant="outline" size="sm" onClick={() => setEditing(u)}>
              Edit sign-in
            </Button>
          </li>
        ))}
        {users.data && users.data.length === 0 ? (
          <li className="px-3 py-3 text-[13px] text-muted-foreground">
            No portal login. Add one under Administration → Users with the Merchant role.
          </li>
        ) : null}
      </ul>
      {editing ? (
        <EditMerchantPortalLoginDialog
          key={editing.id}
          user={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}

type PortalUserForEdit = {
  id: string;
  name: string;
  phone: string;
  username: string | null;
  status: string;
};

function EditMerchantPortalLoginDialog({
  user,
  onClose,
}: {
  user: PortalUserForEdit;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [username, setUsername] = React.useState(user.username ?? "");
  const [password, setPassword] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const close = () => {
    setPassword("");
    onClose();
  };

  const save = useMutation({
    ...orpc.identity.updateUser.mutationOptions(),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      close();
    },
    onError: (error) => setProblem(apiMessage(error, "The merchant sign-in could not be updated.")),
  });

  const nextUsername = username.trim().toLowerCase();
  const currentUsername = user.username ?? "";
  const removingUsername = !nextUsername && Boolean(currentUsername);
  const usernameValid = !nextUsername || nextUsername.length >= 2;
  const passwordValid = !password || password.length >= 8;
  const needsInitialPassword = Boolean(nextUsername) && !currentUsername;
  const changed = nextUsername !== currentUsername || password.length > 0;
  const ready =
    changed &&
    usernameValid &&
    passwordValid &&
    (!needsInitialPassword || password.length >= 8) &&
    (!password || Boolean(nextUsername));

  const patch: Parameters<typeof save.mutate>[0] = { userId: user.id };
  if (nextUsername !== currentUsername) patch.username = nextUsername || null;
  if (removingUsername) patch.password = "";
  else if (password) patch.password = password;

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && close()}
      title={`Edit sign-in · ${user.name}`}
      description="Update this merchant portal user's username or set a new password. The current password is never displayed."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button disabled={!ready} pending={save.isPending} onClick={() => {
            setProblem(null);
            save.mutate(patch);
          }}>
            Save sign-in
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
          {user.phone} · {user.status}
        </p>
        <Field label="Username" hint="Stored lowercase. Clear it to turn off username/password sign-in.">
          <Input
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              if (!e.target.value.trim()) setPassword("");
            }}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="username"
            className="font-mono"
          />
        </Field>
        <Field
          label="New password"
          hint={currentUsername ? "Leave blank to keep the current password. Enter at least 8 characters to change it." : "Required when adding a username. At least 8 characters."}
        >
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            disabled={!nextUsername}
          />
        </Field>
        <p className="text-[12px] text-muted-foreground">
          Changing a password signs the merchant out on every device. Passwords are hashed; they cannot be recovered or viewed.
        </p>
        {problem ? <ErrorNote>{problem}</ErrorNote> : null}
      </div>
    </Dialog>
  );
}
