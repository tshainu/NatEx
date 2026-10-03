import { useQuery } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";

/**
 * Admin portal reads (PROJECT.md §10 M5): users, sessions and MFA state, rate
 * cards, settings, templates, the audit log and the job monitor. Every write on
 * these screens is admin-only on the server (adminProc) — the pages hide write
 * controls from ops, but hiding is UI shaping, not security.
 */

type Out<T extends (...args: never[]) => unknown> = Awaited<ReturnType<T>>;

export type RateCardListRow = Out<typeof client.rateCards.list>[number];
export type RateCardDetail = Out<typeof client.rateCards.get>;
export type RateCardVersionDoc = Out<typeof client.rateCards.version>;
export type QuoteResult = Out<typeof client.rateCards.quote>;
export type SettingRow = Out<typeof client.settings.list>[number];
export type TemplateRow = Out<typeof client.notifications.templates>[number];
export type AuditRow = Out<typeof client.audit.list>["rows"][number];
export type JobRow = Out<typeof client.monitor.jobs>["rows"][number];
export type SessionRow = Out<typeof client.identity.mySessions>[number];
export type AuditFilter = Omit<NonNullable<Parameters<typeof client.audit.list>[0]>, "limit" | "offset">;
export type JobFilter = Omit<NonNullable<Parameters<typeof client.monitor.jobs>[0]>, "limit" | "offset">;

const STATIC = 5 * 60_000;

export function useMfaFactors(enabled: boolean) {
  return useQuery({ ...orpc.mfa.factors.queryOptions(), enabled, staleTime: 30_000 });
}

export function useUserSessions(userId: string | null) {
  return useQuery({
    ...orpc.identity.userSessions.queryOptions({ input: { userId: userId ?? "" } }),
    enabled: Boolean(userId),
  });
}

export function useMySessions() {
  return useQuery({ ...orpc.identity.mySessions.queryOptions(), refetchInterval: 60_000 });
}

export function useMfaStatus(enabled: boolean) {
  return useQuery({ ...orpc.mfa.status.queryOptions(), enabled });
}

export function useRateCards() {
  return useQuery(orpc.rateCards.list.queryOptions());
}

export function useRateCard(id: string | null) {
  return useQuery({ ...orpc.rateCards.get.queryOptions({ input: { id: id ?? "" } }), enabled: Boolean(id) });
}

export function useRateCardVersion(versionId: string | null) {
  return useQuery({
    ...orpc.rateCards.version.queryOptions({ input: { versionId: versionId ?? "" } }),
    enabled: Boolean(versionId),
  });
}

export function useSettings() {
  return useQuery(orpc.settings.list.queryOptions());
}

export function useTemplates() {
  return useQuery({ ...orpc.notifications.templates.queryOptions({ input: {} }), staleTime: STATIC });
}

export function useAuditPage(filter: AuditFilter, page: number, pageSize: number) {
  return useQuery({
    ...orpc.audit.list.queryOptions({ input: { ...filter, limit: pageSize, offset: (page - 1) * pageSize } }),
    placeholderData: (previous) => previous,
  });
}

export function useAuditEntities() {
  return useQuery({ ...orpc.audit.entities.queryOptions(), staleTime: STATIC });
}

export function useMonitorHealth() {
  return useQuery({ ...orpc.monitor.health.queryOptions(), refetchInterval: 15_000 });
}

export function useJobsPage(filter: JobFilter, page: number, pageSize: number) {
  return useQuery({
    ...orpc.monitor.jobs.queryOptions({ input: { ...filter, limit: pageSize, offset: (page - 1) * pageSize } }),
    placeholderData: (previous) => previous,
    refetchInterval: 15_000,
  });
}

export function useInvariantRuns() {
  return useQuery({ ...orpc.monitor.invariantRuns.queryOptions({ input: { limit: 30 } }), refetchInterval: 60_000 });
}

export function useMerchantPortalUsers(merchantId: string | null, enabled: boolean) {
  return useQuery({
    ...orpc.merchants.portalUsers.queryOptions({ input: { merchantId: merchantId ?? "" } }),
    enabled: enabled && Boolean(merchantId),
  });
}

/** Asia/Colombo wall-clock "YYYY-MM-DD" → the UTC instant it starts at (+05:30, no DST). */
export function colomboDayStartIso(day: string): string {
  return new Date(`${day}T00:00:00+05:30`).toISOString();
}
