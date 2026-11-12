import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc, apiMessage } from "@/lib/api";
import { humanise } from "@/lib/format";
import { Input, Field } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, ConfirmDialog } from "@/components/ui/dialog";
import { ErrorNote, KeyValue, KeyValueGrid } from "@/components/natex/page";
import { AddressFields } from "@/components/natex/address-fields";
import { addressPartsFromLegacy, formatAddress, isCompleteAddress, type AddressParts } from "@/lib/address";
import { useMerchantPortalUsers, useRateCards } from "@/queries/admin";
import { registrationOnboardPrefill, type MerchantRegistrationRequest } from "./merchant-registration";
import { staffOnboardingPrefill, type StaffOnboardingRequest } from "./staff-onboarding-request";

/**
 * Merchant onboarding and maintenance (§10 M5 "merchant onboarding").
 * - Edit details: ops and admin (merchants.update; only admin may move branch).
 * - Onboard (merchant + first portal user + rate card in one write): admin.
 * - Rate-card assignment and the portal-user list: admin.
 * The server enforces every one of these; the page only hides what would be refused.
 */

type Pod = "signature" | "otp" | "photo";

// Central Bank of Sri Lanka licensed-bank lists (as at 31 May 2026).
const COMMERCIAL_BANKS = [
  "Amana Bank PLC",
  "Bank of Ceylon",
  "Bank of China Limited",
  "Cargills Bank PLC",
  "Citibank, N.A.",
  "Commercial Bank of Ceylon PLC",
  "Deutsche Bank AG, Colombo Branch",
  "DFCC Bank PLC",
  "Habib Bank Ltd",
  "Hatton National Bank PLC",
  "Indian Bank",
  "Indian Overseas Bank",
  "MCB Bank Ltd",
  "National Development Bank PLC",
  "Nations Trust Bank PLC",
  "Pan Asia Banking Corporation PLC",
  "People's Bank",
  "Public Bank Berhad",
  "Sampath Bank PLC",
  "Seylan Bank PLC",
  "Standard Chartered Bank",
  "State Bank of India",
  "The Hongkong & Shanghai Banking Corporation Ltd (HSBC)",
  "Union Bank of Colombo PLC",
] as const;

const SPECIALISED_BANKS = [
  "Housing Development Finance Corporation Bank of Sri Lanka (HDFC)",
  "National Savings Bank",
  "Pradeshiya Sanwardhana Bank",
  "Sanasa Development Bank PLC",
  "Sri Lanka Savings Bank Ltd",
  "State Mortgage & Investment Bank",
] as const;

const OTHER_BANK = "__other_bank__";

export interface EditableMerchant {
  id: string;
  branchId: string;
  pickupRiderId: string | null;
  name: string;
  vatNo: string | null;
  address: string;
  contactName: string;
  contactPhone: string;
  rateCardId: string | null;
  codEnabled: boolean;
  podPolicy: string;
}

export interface MerchantForm {
  name: string;
  branchId: string;
  pickupRiderId: string;
  vatNo: string;
  address: AddressParts;
  contactName: string;
  contactPhone: string;
  codEnabled: boolean;
  podPolicy: Pod;
}

export function MerchantFields({
  form,
  set,
  branches,
  branchLocked,
  branchLockedHint,
}: {
  form: MerchantForm;
  set: <K extends keyof MerchantForm>(key: K, value: MerchantForm[K]) => void;
  branches: { id: string; name: string }[];
  branchLocked?: boolean;
  branchLockedHint?: string;
}) {
  const riders = useQuery({
    ...orpc.identity.pickupRiderOptions.queryOptions({ input: { branchId: form.branchId } }),
    enabled: Boolean(form.branchId),
    staleTime: 5 * 60 * 1000,
  });
  return (
    <>
      <Field label="Trading name">
        <Input value={form.name} onChange={(e) => set("name", e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Owning branch" hint={branchLocked ? branchLockedHint ?? "Only an admin may move a merchant." : undefined}>
          <Select
            value={form.branchId}
            disabled={branchLocked}
            onChange={(e) => {
              if (e.target.value !== form.branchId) set("pickupRiderId", "");
              set("branchId", e.target.value);
            }}
          >
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
      <Field label="Preferred pickup Rider" hint="Only active Riders assigned to the selected branch/hub are listed. New bookings create a pickup-manifest entry and send the Rider a text alert. The Rider must still scan and complete handover before custody changes.">
        <Select value={form.pickupRiderId} onChange={(e) => set("pickupRiderId", e.target.value)}>
          <option value="">No preferred Rider — schedule pickups manually</option>
          {(riders.data ?? []).map((rider) => (
            <option key={rider.id} value={rider.id}>{rider.name}</option>
          ))}
        </Select>
        {riders.error ? <span className="text-[12px] text-status-warn">Rider options are unavailable; refresh before saving an assignment.</span> : null}
      </Field>
      <AddressFields title="Pickup address" value={form.address} onChange={(address) => set("address", address)} />
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

export function formValid(f: MerchantForm): boolean {
  return (
    f.name.trim().length >= 2 &&
    Boolean(f.branchId) &&
    isCompleteAddress(f.address) &&
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
    pickupRiderId: merchant.pickupRiderId ?? "",
    vatNo: merchant.vatNo ?? "",
    address: addressPartsFromLegacy(merchant.address),
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
    pickupRiderId?: string | null;
    vatNo?: string | null;
    address?: string;
    contactName?: string;
    contactPhone?: string;
    codEnabled?: boolean;
    podPolicy?: Pod;
  } = { id: merchant.id };
  if (form.name.trim() !== initial.name) patch.name = form.name.trim();
  if (form.branchId !== initial.branchId) patch.branchId = form.branchId;
  if (form.pickupRiderId !== initial.pickupRiderId) patch.pickupRiderId = form.pickupRiderId || null;
  if (form.vatNo.trim() !== initial.vatNo) patch.vatNo = form.vatNo.trim() || null;
  const initialAddress = formatAddress(initial.address);
  const nextAddress = formatAddress(form.address);
  if (nextAddress !== initialAddress) patch.address = nextAddress;
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
  registrationRequest,
  staffRequest,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branches: { id: string; name: string }[];
  defaultBranchId: string;
  registrationRequest?: MerchantRegistrationRequest;
  staffRequest?: StaffOnboardingRequest;
  onDone: (merchantId: string) => void;
}) {
  const queryClient = useQueryClient();
  const cards = useRateCards();
  const trackingBatches = useQuery({
    ...orpc.awbBatches.plannedMerchantBatches.queryOptions(),
    enabled: open,
    staleTime: 30_000,
  });
  const blank = React.useMemo<MerchantForm>(() => ({
    ...(staffRequest
      ? staffOnboardingPrefill(staffRequest)
      : {
          ...registrationOnboardPrefill(defaultBranchId, registrationRequest),
          pickupRiderId: "",
          vatNo: "",
          codEnabled: true,
          podPolicy: "signature" as const,
        }),
  }), [defaultBranchId, registrationRequest, staffRequest]);
  const [form, setForm] = React.useState(blank);
  const [rateCardId, setRateCardId] = React.useState("");
  const [withPortal, setWithPortal] = React.useState(true);
  const [portalName, setPortalName] = React.useState(registrationRequest?.contactName ?? staffRequest?.contactName ?? "");
  const [portalPhone, setPortalPhone] = React.useState(registrationRequest?.phone ?? staffRequest?.contactPhone ?? "");
  const [withPasswordLogin, setWithPasswordLogin] = React.useState(true);
  const [portalUsername, setPortalUsername] = React.useState("");
  const [portalPassword, setPortalPassword] = React.useState("");
  const [trackingBatchId, setTrackingBatchId] = React.useState("");
  const [payoutBeneficiary, setPayoutBeneficiary] = React.useState("");
  const [payoutBank, setPayoutBank] = React.useState("");
  const [otherBank, setOtherBank] = React.useState("");
  const [payoutBranch, setPayoutBranch] = React.useState("");
  const [payoutAccount, setPayoutAccount] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const submitting = React.useRef(false);
  const set = <K extends keyof MerchantForm>(key: K, value: MerchantForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const changeOpen = (next: boolean) => {
    if (!next) {
      if (submitting.current) return;
      setPortalPassword("");
      setPortalUsername("");
      setTrackingBatchId("");
      setPayoutBeneficiary("");
      setPayoutBank("");
      setOtherBank("");
      setPayoutBranch("");
      setPayoutAccount("");
      setProblem(null);
    }
    onOpenChange(next);
  };

  React.useEffect(() => {
    if (!open) return;
    submitting.current = false;
    setForm(blank);
    setRateCardId("");
    setWithPortal(true);
    setPortalName(registrationRequest?.contactName ?? staffRequest?.contactName ?? "");
    setPortalPhone(registrationRequest?.phone ?? staffRequest?.contactPhone ?? "");
    setWithPasswordLogin(true);
    setPortalUsername("");
    setPortalPassword("");
    setTrackingBatchId("");
    setPayoutBeneficiary("");
    setPayoutBank("");
    setOtherBank("");
    setPayoutBranch("");
    setPayoutAccount("");
    setProblem(null);
  }, [open, blank, registrationRequest?.id, registrationRequest?.contactName, registrationRequest?.phone, staffRequest?.id, staffRequest?.contactName, staffRequest?.contactPhone]);

  const finishOnboarding = (merchantId: string) => {
      void queryClient.invalidateQueries();
      void queryClient.invalidateQueries({ queryKey: orpc.merchants.list.key() });
      if (registrationRequest) {
        void queryClient.invalidateQueries({ queryKey: orpc.merchants.registrationRequests.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.merchants.registrationRequestCount.key() });
      }
      if (staffRequest) {
        void queryClient.invalidateQueries({ queryKey: orpc.merchants.onboardingRequests.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.merchants.onboardingRequestCount.key() });
      }
      submitting.current = false;
      setForm(blank);
      setRateCardId("");
      setPortalName("");
      setPortalPhone("");
      setWithPasswordLogin(true);
      setPortalUsername("");
      setPortalPassword("");
      setTrackingBatchId("");
      setPayoutBeneficiary("");
      setPayoutBank("");
      setOtherBank("");
      setPayoutBranch("");
      setPayoutAccount("");
      onDone(merchantId);
  };
  const failOnboarding = (error: unknown) => {
      submitting.current = false;
      setProblem(apiMessage(error, "This merchant could not be onboarded."));
  };

  const onboard = useMutation({
    ...orpc.merchants.onboard.mutationOptions(),
    onSuccess: (result) => finishOnboarding(result.merchant.id),
    onError: failOnboarding,
  });
  const approve = useMutation({
    ...orpc.merchants.approveOnboardingRequest.mutationOptions(),
    onSuccess: (result) => finishOnboarding(result.merchant.id),
    onError: failOnboarding,
  });

  const assignable = (cards.data ?? []).filter((c) => c.activeVersion && !c.placeholder);
  const chosen = assignable.find((c) => c.id === rateCardId);
  const portalOk =
    !withPortal ||
    (portalName.trim().length >= 2 &&
      portalPhone.trim().length >= 9 &&
      (!withPasswordLogin || (portalUsername.trim().length >= 2 && portalPassword.length >= 8)));
  const selectedBank = payoutBank === OTHER_BANK ? otherBank.trim() : payoutBank;
  const payoutTouched = Boolean(
    payoutBeneficiary.trim() || payoutBank || otherBank.trim() || payoutBranch.trim() || payoutAccount.trim(),
  );
  const payoutOk = !payoutTouched || (
    payoutBeneficiary.trim().length >= 2 &&
    selectedBank.length >= 2 &&
    payoutBranch.trim().length >= 2 &&
    /^[0-9][0-9 -]{3,40}$/.test(payoutAccount.trim())
  );
  const saving = onboard.isPending || approve.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={changeOpen}
      title={staffRequest ? "Approve & onboard merchant" : "Onboard a merchant"}
      description={staffRequest
        ? "Review the Operations submission. The allocated branch is pinned; only the final Admin save creates the merchant, rate card and portal login."
        : "Creates the merchant, its first merchant-portal login and its rate card in one audited step. The portal phone and username are checked first, so a clash is reported before creating the merchant."}
      className="w-[560px]"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={saving} onClick={() => changeOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={!formValid(form) || !portalOk || !payoutOk || saving}
            pending={saving}
            onClick={() => {
              if (submitting.current) return;
              if (!payoutOk) {
                setProblem("Complete all bank payout fields or leave them blank.");
                return;
              }
              submitting.current = true;
              setProblem(null);
              const payoutDetails = payoutTouched
                ? {
                    beneficiaryName: payoutBeneficiary.trim(),
                    bankName: selectedBank,
                    branchName: payoutBranch.trim(),
                    accountNumber: payoutAccount.trim(),
                  }
                : undefined;
              const details = {
                name: form.name.trim(),
                pickupRiderId: form.pickupRiderId || null,
                vatNo: form.vatNo.trim() || null,
                address: formatAddress(form.address),
                contactName: form.contactName.trim(),
                contactPhone: form.contactPhone.trim(),
                codEnabled: form.codEnabled,
                podPolicy: form.podPolicy,
                rateCardId: rateCardId || null,
                ...(trackingBatchId ? { trackingBatchId } : {}),
                ...(payoutDetails ? { payoutDetails } : {}),
                portalUser: withPortal
                  ? {
                      name: portalName.trim(),
                      phone: portalPhone.trim(),
                      ...(withPasswordLogin
                        ? { username: portalUsername.trim(), password: portalPassword }
                        : {}),
                    }
                  : null,
              };
              if (staffRequest) {
                approve.mutate({ requestId: staffRequest.id, ...details });
              } else {
                onboard.mutate({
                  ...details,
                  branchId: form.branchId,
                  ...(registrationRequest ? { registrationRequestId: registrationRequest.id } : {}),
                });
              }
            }}
          >
            {staffRequest ? "Approve & onboard" : "Onboard merchant"}
          </Button>
        </div>
      }
    >
      <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto pr-1">
        {registrationRequest ? (
          <section aria-labelledby="application-summary-heading" className="flex flex-col gap-3 rounded-md border border-brand/30 bg-brand/5 p-3">
            <h3 id="application-summary-heading" className="label-xs text-muted-foreground">Applicant’s registration summary</h3>
            <KeyValueGrid>
              <KeyValue label="Email">{registrationRequest.email}</KeyValue>
              <KeyValue label="Business type">{registrationRequest.businessType}</KeyValue>
              <KeyValue label="Expected monthly volume">{registrationRequest.monthlyVolume}</KeyValue>
              <KeyValue label="Notes" className="col-span-2">
                <span className="whitespace-pre-wrap">{registrationRequest.notes.trim() || "No additional notes"}</span>
              </KeyValue>
            </KeyValueGrid>
          </section>
        ) : null}
        {staffRequest ? (
          <section aria-labelledby="operations-request-summary-heading" className="flex flex-col gap-2 rounded-md border border-brand/30 bg-brand/5 p-3">
            <h3 id="operations-request-summary-heading" className="label-xs text-muted-foreground">Operations request review</h3>
            <KeyValueGrid>
              <KeyValue label="Submitted by">{staffRequest.createdByName}</KeyValue>
              <KeyValue label="Submitted">{new Date(staffRequest.createdAt).toLocaleString()}</KeyValue>
              <KeyValue label="Allocated branch">{branches.find((branch) => branch.id === staffRequest.branchId)?.name ?? staffRequest.branchId}</KeyValue>
              <KeyValue label="Request status">{humanise(staffRequest.status)}</KeyValue>
            </KeyValueGrid>
          </section>
        ) : null}
        <MerchantFields
          form={form}
          set={set}
          branches={branches}
          branchLocked={Boolean(staffRequest)}
          branchLockedHint="Pinned to the branch recorded on the Operations request."
        />
        <Field label="Rate card" hint="Only approved cards with a published version can be assigned.">
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
        <section aria-labelledby="merchant-payout-heading" className="flex flex-col gap-3 rounded-md border border-border p-3">
          <div>
            <h3 id="merchant-payout-heading" className="label-xs">Bank payout details <span className="font-normal text-muted-foreground">(optional)</span></h3>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Admin only. Enter these during onboarding if the merchant is ready to receive COD settlements. New details remain unverified until Finance checks a bank document.
            </p>
          </div>
          <Field label="Account holder name (exactly as shown by the bank)">
            <Input value={payoutBeneficiary} onChange={(e) => setPayoutBeneficiary(e.target.value)} autoComplete="off" />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Bank name">
              <Select value={payoutBank} onChange={(e) => setPayoutBank(e.target.value)}>
                <option value="">Select a Sri Lankan bank</option>
                <optgroup label="Licensed commercial banks">
                  {COMMERCIAL_BANKS.map((bank) => <option key={bank} value={bank}>{bank}</option>)}
                </optgroup>
                <optgroup label="Licensed specialised banks">
                  {SPECIALISED_BANKS.map((bank) => <option key={bank} value={bank}>{bank}</option>)}
                </optgroup>
                <option value={OTHER_BANK}>Other — enter bank name</option>
              </Select>
            </Field>
            <Field label="Bank branch">
              <Input value={payoutBranch} onChange={(e) => setPayoutBranch(e.target.value)} autoComplete="off" />
            </Field>
          </div>
          {payoutBank === OTHER_BANK ? (
            <Field label="Other bank name">
              <Input value={otherBank} onChange={(e) => setOtherBank(e.target.value)} autoComplete="off" />
            </Field>
          ) : null}
          <Field label="Bank account number" hint="Digits only, with optional spaces or hyphens. This value is never shown back in full in audit records.">
            <Input
              value={payoutAccount}
              onChange={(e) => setPayoutAccount(e.target.value)}
              className="font-mono"
              inputMode="numeric"
              autoComplete="off"
              aria-invalid={payoutTouched && !/^[0-9][0-9 -]{3,40}$/.test(payoutAccount.trim()) || undefined}
            />
          </Field>
          {payoutTouched && !payoutOk ? (
            <p role="alert" className="text-[12px] text-status-warn">
              Complete the account holder, bank, bank branch and valid account number, or leave all payout fields blank.
            </p>
          ) : null}
        </section>
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
        <Field
          label="Tracking-number allocation"
          hint="Optional. Select an unassigned, planned series to issue to this merchant during onboarding."
        >
          <Select
            value={trackingBatchId}
            disabled={trackingBatches.isLoading || Boolean(trackingBatches.error)}
            onChange={(event) => setTrackingBatchId(event.target.value)}
          >
            <option value="">No tracking series assigned now</option>
            {(trackingBatches.data ?? []).map((batch) => (
              <option key={batch.id} value={batch.id}>
                {batch.awbStart} - {batch.awbEnd} · {batch.labelCount.toLocaleString()} numbers · {batch.batchCode}
              </option>
            ))}
          </Select>
          {trackingBatches.error ? (
            <span role="alert" className="text-[12px] text-status-warn">
              Planned tracking batches could not be loaded. Refresh before selecting an allocation.
            </span>
          ) : null}
          {!trackingBatches.isLoading && !trackingBatches.error && (trackingBatches.data?.length ?? 0) === 0 ? (
            <span className="text-[12px] text-muted-foreground">
              No planned batches are available. Generate a tracking-number batch first if this merchant needs one now.
            </span>
          ) : null}
        </Field>
        {problem ? <ErrorNote>{problem}</ErrorNote> : null}
      </div>
    </Dialog>
  );
}

export function PlaceholderWarning() {
  return (
    <p className="rounded-md border border-status-warn/40 bg-status-warn/10 px-3 py-2 text-[12px] leading-relaxed text-status-warn">
      This card is marked as a placeholder. Its illustrative prices are not approved and cannot be used for live merchant pricing.
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
  const assignable = (cards.data ?? []).filter((c) => c.activeVersion && !c.placeholder);
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
            No portal login. Add one under Administration → Merchant users.
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

export type PortalUserForEdit = {
  id: string;
  name: string;
  phone: string;
  username: string | null;
  status: string;
};

export function EditMerchantPortalLoginDialog({
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
    ...orpc.identity.updateMerchantUser.mutationOptions(),
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
