import * as React from "react";
import { Landmark, ShieldCheck, ShieldAlert } from "lucide-react";
import { dateTime } from "@/lib/format";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Card, ErrorNote, KeyValue, KeyValueGrid, SuccessNote } from "@/components/natex/page";
import { Skeleton } from "@/components/ui/skeleton";
import { usePayoutDetails, useSetPayoutDetails, type FinanceOut } from "@/queries/finance";
import { MerchantSelect, useCanWriteMoney, useMerchantName } from "./shared";

/**
 * Merchant payout bank details (§8). The payout file is built from these, so
 * without them `exportPayoutCsv` refuses with `payout-details-missing`.
 *
 * Writes are finance-only on the server (a merchant can never re-point its own
 * payouts). Here every save goes through a confirm that names the merchant and
 * shows the masked destination, the account number is typed twice, and a save
 * is unverified unless finance ticks that it was checked against a bank
 * document — a changed account is the classic payout-fraud move.
 */

type Payout = NonNullable<FinanceOut<"payoutDetails">>;

export function maskAccount(n: string): string {
  const digits = n.replace(/\s+/g, "");
  if (digits.length <= 4) return digits;
  return `•••• ${digits.slice(-4)}`;
}

/** `?merchant=` pre-selects one, so a "details missing" payout error can link here. */
function merchantFromUrl(): string {
  return new URLSearchParams(window.location.search).get("merchant") ?? "";
}

export function BankDetailsTab() {
  const [merchantId, setMerchantId] = React.useState(merchantFromUrl);
  const merchantName = useMerchantName();
  const canWrite = useCanWriteMoney();
  const details = usePayoutDetails(merchantId || null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Merchant" className="w-[300px]">
          <MerchantSelect value={merchantId} onChange={setMerchantId} label="Merchant for bank details" />
        </Field>
      </div>
      {!merchantId ? (
        <Card>
          <p className="text-[13px] text-muted-foreground">
            Choose a merchant to see where its settlements are paid. A merchant with no bank details on file cannot be
            put on a payout file.
          </p>
        </Card>
      ) : details.isPending ? (
        <Card>
          <Skeleton className="h-24 w-full" />
        </Card>
      ) : details.isError ? (
        <ErrorNote>Bank details could not be loaded.</ErrorNote>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <CurrentDetails payout={details.data ?? null} merchant={merchantName(merchantId)} />
          {canWrite ? (
            <DetailsForm
              key={merchantId}
              merchantId={merchantId}
              merchant={merchantName(merchantId)}
              current={details.data ?? null}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function CurrentDetails({ payout, merchant }: { payout: Payout | null; merchant: string }) {
  return (
    <Card
      title="On file"
      description={merchant}
      actions={
        payout ? (
          payout.verified ? (
            <Badge variant="good">
              <ShieldCheck aria-hidden className="size-3" /> Verified
            </Badge>
          ) : (
            <Badge variant="warn">
              <ShieldAlert aria-hidden className="size-3" /> Not verified
            </Badge>
          )
        ) : null
      }
    >
      {payout ? (
        <KeyValueGrid>
          <KeyValue label="Beneficiary" className="col-span-2">
            {payout.beneficiaryName}
          </KeyValue>
          <KeyValue label="Bank">{payout.bankName}</KeyValue>
          <KeyValue label="Branch">{payout.branchName}</KeyValue>
          <KeyValue label="Account" mono>
            {maskAccount(payout.accountNumber)}
          </KeyValue>
          <KeyValue label="Last changed" mono>
            {dateTime(payout.updatedAt)}
          </KeyValue>
          <KeyValue label="Changed by">{payout.updatedByName ?? "—"}</KeyValue>
          {payout.note ? (
            <KeyValue label="Note" className="col-span-2">
              {payout.note}
            </KeyValue>
          ) : null}
        </KeyValueGrid>
      ) : (
        <div className="flex items-start gap-3">
          <Landmark aria-hidden className="mt-0.5 size-4 text-status-warn" />
          <p className="text-[13px]">
            No bank details on file. Settlements for this merchant can be approved but not exported to a payout file
            until they are added.
          </p>
        </div>
      )}
    </Card>
  );
}

function DetailsForm({ merchantId, merchant, current }: { merchantId: string; merchant: string; current: Payout | null }) {
  const [beneficiaryName, setBeneficiary] = React.useState(current?.beneficiaryName ?? "");
  const [bankName, setBank] = React.useState(current?.bankName ?? "");
  const [branchName, setBranch] = React.useState(current?.branchName ?? "");
  const [accountNumber, setAccount] = React.useState("");
  const [accountAgain, setAccountAgain] = React.useState("");
  const [verified, setVerified] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [confirm, setConfirm] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  const save = useSetPayoutDetails({
    onSuccess: (r) => {
      setConfirm(false);
      setError(null);
      setDone(`Saved. Payouts for ${merchant} now go to ${r.bankName} ${maskAccount(r.accountNumber)}.`);
    },
    onError: (m) => {
      setConfirm(false);
      setError(m);
    },
  });

  const acct = accountNumber.trim();
  const mismatch = accountAgain.length > 0 && accountAgain.trim() !== acct;
  const changingAccount = current !== null && acct !== "" && acct !== current.accountNumber;
  const valid =
    beneficiaryName.trim() &&
    bankName.trim() &&
    branchName.trim() &&
    /^[0-9][0-9 -]{3,40}$/.test(acct) &&
    accountAgain.trim() === acct &&
    (!changingAccount || note.trim().length >= 5);

  return (
    <Card title={current ? "Correct the details" : "Add bank details"} description="Finance only. Every save is audited.">
      <div className="space-y-4">
        <Field label="Beneficiary name, exactly as the bank has it">
          <Input value={beneficiaryName} onChange={(e) => setBeneficiary(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Bank">
            <Input value={bankName} onChange={(e) => setBank(e.target.value)} placeholder="Hatton National Bank" />
          </Field>
          <Field label="Branch">
            <Input value={branchName} onChange={(e) => setBranch(e.target.value)} placeholder="Maradana" />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Account number" hint={current ? `On file: ${maskAccount(current.accountNumber)}` : undefined}>
            <Input
              value={accountNumber}
              onChange={(e) => setAccount(e.target.value)}
              className="font-mono"
              inputMode="numeric"
              autoComplete="off"
            />
          </Field>
          <Field label="Account number again" error={mismatch ? "The two account numbers differ." : null}>
            <Input
              value={accountAgain}
              onChange={(e) => setAccountAgain(e.target.value)}
              className="font-mono"
              inputMode="numeric"
              autoComplete="off"
              aria-invalid={mismatch || undefined}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={verified}
            onChange={(e) => setVerified(e.target.checked)}
            aria-label="Checked against a bank document"
            className="size-4 accent-[var(--brand)]"
          />
          Checked against a bank document (letter, statement or cancelled cheque)
        </label>
        <Field label={changingAccount ? "Why is the account changing? (required)" : "Note (optional)"}>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder={changingAccount ? "Merchant moved banks; letter on HNB letterhead received 02/10" : undefined}
          />
        </Field>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {done ? <SuccessNote>{done}</SuccessNote> : null}
        <Button disabled={!valid || save.isPending} onClick={() => setConfirm(true)}>
          <Landmark aria-hidden />
          {current ? "Save corrected details" : "Save bank details"}
        </Button>
        <ConfirmDialog
          open={confirm}
          onOpenChange={(o) => !o && setConfirm(false)}
          title={changingAccount ? "Re-point this merchant's payouts?" : "Save these bank details?"}
          objectName={merchant}
          confirmLabel="Save details"
          destructive={changingAccount}
          pending={save.isPending}
          body={
            <span>
              Future payout files for {merchant} will pay {beneficiaryName.trim()} at {bankName.trim()},{" "}
              {branchName.trim()}, account {maskAccount(acct)}
              {verified ? "" : " — marked not verified"}. Your name is recorded.
            </span>
          }
          onConfirm={() =>
            save.mutate({
              merchantId,
              beneficiaryName: beneficiaryName.trim(),
              bankName: bankName.trim(),
              branchName: branchName.trim(),
              accountNumber: acct,
              verified,
              note: note.trim() || null,
            })
          }
        />
      </div>
    </Card>
  );
}
