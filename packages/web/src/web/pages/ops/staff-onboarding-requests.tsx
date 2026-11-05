import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { orpc, apiMessage } from "@/lib/api";
import { dateTime, humanise } from "@/lib/format";
import { Field } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/natex/data-table";
import type { StaffOnboardingRequest } from "./staff-onboarding-request";

const PAGE_SIZE = 25;
type RequestStatus = "pending" | "approved";

export function StaffOnboardingRequests({
  branchName,
  canApprove,
  onApprove,
  onViewMerchant,
}: {
  branchName: (branchId: string) => string;
  canApprove: boolean;
  onApprove: (request: StaffOnboardingRequest) => void;
  onViewMerchant: (merchantId: string) => void;
}) {
  const [status, setStatus] = React.useState<RequestStatus>("pending");
  const [page, setPage] = React.useState(1);
  React.useEffect(() => setPage(1), [status]);

  const requests = useQuery({
    ...orpc.merchants.onboardingRequests.queryOptions({
      input: { page, pageSize: PAGE_SIZE, status },
    }),
    refetchInterval: 30_000,
  });
  const rows = (requests.data?.rows ?? []) as unknown as StaffOnboardingRequest[];

  const columns: Column<StaffOnboardingRequest>[] = [
    {
      key: "merchant",
      header: "Merchant / contact",
      width: "w-[260px]",
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.name}</p>
          <p className="truncate text-[12px] text-muted-foreground">
            {row.contactName} · <span className="font-mono">{row.contactPhone}</span>
          </p>
        </div>
      ),
    },
    { key: "branch", header: "Allocated branch", width: "w-[160px]", cell: (row) => branchName(row.branchId) },
    {
      key: "creator",
      header: "Submitted by",
      width: "w-[160px]",
      cell: (row) => <span>{row.createdByName}</span>,
    },
    {
      key: "created",
      header: "Submitted",
      width: "w-[160px]",
      className: "font-mono text-[12px] text-muted-foreground",
      cell: (row) => dateTime(row.createdAt),
    },
    {
      key: "status",
      header: "Status",
      width: "w-[110px]",
      cell: (row) => <Badge variant={row.status === "approved" ? "good" : "warn"}>{humanise(row.status)}</Badge>,
    },
    {
      key: "decision",
      header: "Admin decision",
      width: "w-[180px]",
      cell: (row) => row.status === "approved"
        ? <span className="text-[12px] text-muted-foreground">{row.approvedByName ?? "Admin"} · {row.approvedAt ? dateTime(row.approvedAt) : "—"}</span>
        : <span className="text-[12px] text-muted-foreground">Awaiting Admin review</span>,
    },
    {
      key: "action",
      header: "",
      align: "right",
      width: "w-[170px]",
      cell: (row) => row.status === "pending" && canApprove ? (
        <Button
          size="sm"
          variant="outline"
          onClick={(event) => {
            event.stopPropagation();
            onApprove(row);
          }}
        >
          Approve & onboard
        </Button>
      ) : row.approvedMerchantId ? (
        <Button
          size="sm"
          variant="outline"
          onClick={(event) => {
            event.stopPropagation();
            onViewMerchant(row.approvedMerchantId!);
          }}
        >
          Merchant <ArrowUpRight aria-hidden />
        </Button>
      ) : <span className="text-[12px] text-muted-foreground">No linked merchant</span>,
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      loading={requests.isLoading}
      error={requests.error ? apiMessage(requests.error, "Onboarding approvals are unavailable.") : null}
      emptyTitle={status === "pending" ? "No onboarding approvals pending" : "No approved Operations requests"}
      emptyDescription={status === "pending"
        ? "Operations submissions stay out of the merchant register until an Admin completes approval."
        : "Approved requests remain here with the linked merchant and reviewer details."}
      filters={(
        <Field label="Approval status" className="w-52">
          <Select value={status} onChange={(event) => setStatus(event.target.value as RequestStatus)}>
            <option value="pending">Pending approval</option>
            <option value="approved">Approved</option>
          </Select>
        </Field>
      )}
      pagination={{
        page: requests.data?.page ?? page,
        pageSize: requests.data?.pageSize ?? PAGE_SIZE,
        total: requests.data?.total ?? 0,
        onPageChange: setPage,
      }}
      className="min-h-0 flex-1"
    />
  );
}
