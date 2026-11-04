import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, CheckCircle2, Clock3, MessageSquareText } from "lucide-react";
import { orpc, apiMessage } from "@/lib/api";
import { dateTime, humanise } from "@/lib/format";
import { Field } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Drawer } from "@/components/ui/drawer";
import { DataTable, type Column } from "@/components/natex/data-table";
import { ErrorNote, KeyValue, KeyValueGrid } from "@/components/natex/page";
import type { MerchantRegistrationRequest } from "./merchant-registration";

type RequestStatus = "new" | "converted";

const PAGE_SIZE = 25;

export function RegistrationRequests({
  onOnboard,
  onViewMerchant,
}: {
  onOnboard: (request: MerchantRegistrationRequest) => void;
  onViewMerchant: (merchantId: string) => void;
}) {
  const [status, setStatus] = React.useState<RequestStatus>("new");
  const [page, setPage] = React.useState(1);
  const [openId, setOpenId] = React.useState<string | null>(null);

  React.useEffect(() => setPage(1), [status]);

  const requests = useQuery({
    ...orpc.merchants.registrationRequests.queryOptions({
      input: { page, pageSize: PAGE_SIZE, status },
    }),
    refetchInterval: 30_000,
  });

  const rows = (requests.data?.rows ?? []) as MerchantRegistrationRequest[];
  const columns: Column<MerchantRegistrationRequest>[] = [
    {
      key: "business",
      header: "Business / contact",
      width: "w-[280px]",
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.businessName}</p>
          <p className="truncate text-[12px] text-muted-foreground">
            {row.contactName} · <span className="font-mono">{row.phone}</span>
          </p>
        </div>
      ),
    },
    { key: "district", header: "District", width: "w-[150px]", cell: (row) => row.district },
    { key: "type", header: "Business type", width: "w-[160px]", cell: (row) => row.businessType },
    { key: "volume", header: "Monthly volume", width: "w-[150px]", cell: (row) => row.monthlyVolume },
    {
      key: "received",
      header: "Received",
      width: "w-[150px]",
      className: "font-mono text-[12px] text-muted-foreground",
      cell: (row) => dateTime(row.createdAt),
    },
    {
      key: "status",
      header: "Status",
      width: "w-[120px]",
      cell: (row) => (
        <Badge variant={row.status === "converted" ? "good" : "warn"}>
          {row.status === "converted" ? "Converted" : "New"}
        </Badge>
      ),
    },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        loading={requests.isLoading}
        error={requests.error ? apiMessage(requests.error, "Merchant registration requests are unavailable.") : null}
        onRowClick={(row) => setOpenId(row.id)}
        emptyTitle={status === "new" ? "No new merchant requests" : "No converted requests"}
        emptyDescription={status === "new"
          ? "New applications submitted through merchant enrollment will appear here."
          : "Requests remain available here after they are converted into merchants."}
        filters={
          <>
            <Field label="Request status" className="w-52">
              <Select value={status} onChange={(event) => setStatus(event.target.value as RequestStatus)}>
                <option value="new">New requests</option>
                <option value="converted">Converted requests</option>
              </Select>
            </Field>
            <p className="pb-2 text-[12px] text-muted-foreground">
              Select a row to review the complete application.
            </p>
          </>
        }
        pagination={{
          page: requests.data?.page ?? page,
          pageSize: requests.data?.pageSize ?? PAGE_SIZE,
          total: requests.data?.total ?? 0,
          onPageChange: setPage,
        }}
        className="min-h-0 flex-1"
      />

      <RegistrationRequestDrawer
        id={openId}
        onOpenChange={(open) => !open && setOpenId(null)}
        onOnboard={(request) => {
          setOpenId(null);
          onOnboard(request);
        }}
        onViewMerchant={(merchantId) => {
          setOpenId(null);
          onViewMerchant(merchantId);
        }}
      />
    </>
  );
}

function RegistrationRequestDrawer({
  id,
  onOpenChange,
  onOnboard,
  onViewMerchant,
}: {
  id: string | null;
  onOpenChange: (open: boolean) => void;
  onOnboard: (request: MerchantRegistrationRequest) => void;
  onViewMerchant: (merchantId: string) => void;
}) {
  const detail = useQuery({
    ...orpc.merchants.registrationRequest.queryOptions({ input: { id: id ?? "" } }),
    enabled: Boolean(id),
    refetchInterval: id ? 15_000 : false,
  });
  const request = detail.data as MerchantRegistrationRequest | undefined;
  const converted = request?.status === "converted";

  return (
    <Drawer
      open={Boolean(id)}
      onOpenChange={onOpenChange}
      title={request?.businessName ?? "Merchant application"}
      subtitle={request ? `Submitted ${dateTime(request.createdAt)}` : undefined}
      footer={request ? (
        converted && request.merchantId ? (
          <Button className="w-full" onClick={() => onViewMerchant(request.merchantId!)}>
            <ArrowUpRight aria-hidden /> View merchant
          </Button>
        ) : !converted ? (
          <Button className="w-full" onClick={() => onOnboard(request)}>
            Onboard as merchant
          </Button>
        ) : null
      ) : null}
    >
      {detail.isLoading ? (
        <p className="text-[13px] text-muted-foreground">Loading application…</p>
      ) : detail.error ? (
        <ErrorNote>{apiMessage(detail.error, "This application is unavailable.")}</ErrorNote>
      ) : request ? (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={converted ? "good" : "warn"}>{converted ? "Converted" : "New request"}</Badge>
            {converted && request.merchantId ? <Badge variant="outline">Merchant linked</Badge> : null}
          </div>

          <section aria-labelledby="registration-contact-heading" className="flex flex-col gap-2">
            <h2 id="registration-contact-heading" className="label-xs text-muted-foreground">Applicant</h2>
            <KeyValueGrid>
              <KeyValue label="Business name">{request.businessName}</KeyValue>
              <KeyValue label="Contact name">{request.contactName}</KeyValue>
              <KeyValue label="Phone" mono>{request.phone}</KeyValue>
              <KeyValue label="Email">{request.email}</KeyValue>
              <KeyValue label="District">{request.district}</KeyValue>
              <KeyValue label="SMS consent">{request.smsConsent ? "Granted" : "Not granted"}</KeyValue>
            </KeyValueGrid>
          </section>

          <section aria-labelledby="registration-business-heading" className="flex flex-col gap-2">
            <h2 id="registration-business-heading" className="label-xs text-muted-foreground">Application details</h2>
            <KeyValueGrid>
              <KeyValue label="Business type">{request.businessType}</KeyValue>
              <KeyValue label="Expected monthly volume">{request.monthlyVolume}</KeyValue>
              <KeyValue label="Notes" className="col-span-2">
                <span className="whitespace-pre-wrap">{request.notes.trim() || "No additional notes"}</span>
              </KeyValue>
            </KeyValueGrid>
          </section>

          <section aria-labelledby="registration-sms-heading" className="flex flex-col gap-2 rounded-md border border-border p-3">
            <h2 id="registration-sms-heading" className="flex items-center gap-2 label-xs text-muted-foreground">
              <MessageSquareText className="size-3.5" aria-hidden /> Registration SMS status
            </h2>
            <SmsState label="Receipt message" value={request.receiptSmsState} />
            <SmsState label="Confirmation message" value={request.confirmationSmsState} />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              “Accepted” or “sent” means the SMS gateway accepted the message; it does not confirm delivery to the handset.
            </p>
          </section>

          <KeyValueGrid>
            <KeyValue label="Request ID" mono>{request.id}</KeyValue>
            <KeyValue label="Submitted" mono>{dateTime(request.createdAt)}</KeyValue>
            {converted ? (
              <>
                <KeyValue label="Converted at" mono>{dateTime(request.convertedAt)}</KeyValue>
                <KeyValue label="Linked merchant" mono>{request.merchantId ?? "Unavailable"}</KeyValue>
              </>
            ) : null}
          </KeyValueGrid>

          {converted ? (
            <p className="flex items-center gap-2 rounded-md border border-status-good/30 bg-status-good/10 px-3 py-2 text-[12px] text-status-good">
              <CheckCircle2 className="size-4 shrink-0" aria-hidden /> This application is retained for reference and is read-only.
            </p>
          ) : (
            <p className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
              <Clock3 className="size-4 shrink-0" aria-hidden /> Canceling onboarding leaves this request new and available for review.
            </p>
          )}
        </div>
      ) : null}
    </Drawer>
  );
}

function SmsState({ label, value }: { label: string; value: string }) {
  const normalized = value.toLowerCase();
  const variant = normalized === "sent" || normalized === "accepted" ? "good"
    : normalized.includes("fail") || normalized === "rejected" ? "bad"
    : normalized === "queued" || normalized === "pending" ? "brand" : "outline";
  return (
    <div className="flex items-center justify-between gap-3 text-[12px]">
      <span>{label}</span>
      <Badge variant={variant}>{humanise(value || "unknown")}</Badge>
    </div>
  );
}
