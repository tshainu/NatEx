import React from "react";
import { AppState } from "react-native";
import { ORPCError } from "@orpc/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";
import { colomboToday } from "../lib/format";
import { readJson, writeJson } from "../lib/local-store";
import {
  drain,
  latestFor,
  loadOutbox,
  outboxSnapshot,
  subscribeOutbox,
  type OutboxEntry,
  type OutboxSnapshot,
} from "../lib/outbox";
import { getSession } from "../lib/session";

/**
 * The rider's run, readable with no signal.
 *
 * §7: "local write first" only works if the screen that takes the write can
 * open offline. So every successful `delivery.myRunsheet` is written to device
 * storage, and when the network is gone the last copy is served instead —
 * flagged as cached, with its age, never passed off as live.
 *
 * Pending outbox records are overlaid on top: a stop the rider has already
 * delivered offline shows as done-on-this-phone, not as still to do.
 */

type Run = NonNullable<Awaited<ReturnType<typeof client.delivery.myRunsheet>>>;
type Reasons = Awaited<ReturnType<typeof client.delivery.reasons>>;
export type RunStop = Run["items"][number];
export type ReasonCode = Reasons[number];

interface Cached<T> {
  savedAt: number;
  runDate: string;
  data: T;
}

export interface RiderRun {
  run: Run | null;
  fromCache: boolean;
  cachedAt: number | null;
}

function key(kind: "run" | "reasons"): string {
  return `natex.rider.${kind}.v1.${getSession()?.user.id ?? "anon"}`;
}

function isNetwork(error: unknown): boolean {
  return !(error instanceof ORPCError);
}

export const riderRunKey = ["rider", "run"] as const;

export function useRiderRun() {
  return useQuery({
    queryKey: [...riderRunKey, getSession()?.user.id ?? null],
    networkMode: "always",
    retry: false,
    queryFn: async (): Promise<RiderRun> => {
      const today = colomboToday();
      try {
        const run = await client.delivery.myRunsheet({});
        await writeJson(key("run"), { savedAt: Date.now(), runDate: today, data: run } satisfies Cached<
          typeof run
        >);
        return { run, fromCache: false, cachedAt: null };
      } catch (error) {
        if (!isNetwork(error)) throw error;
        const cached = await readJson<Cached<Run | null> | null>(key("run"), null);
        // Yesterday's run is not today's work; better an honest "offline,
        // nothing cached" than a list of stops that already closed.
        if (!cached || cached.runDate !== today) throw error;
        return { run: cached.data, fromCache: true, cachedAt: cached.savedAt };
      }
    },
  });
}

/** Reason codes, cached the same way — the failure screen must work offline. */
export function useReasonCodes() {
  return useQuery({
    queryKey: ["rider", "reasons", getSession()?.user.id ?? null],
    networkMode: "always",
    retry: false,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<{ reasons: Reasons; fromCache: boolean }> => {
      try {
        const reasons = await client.delivery.reasons({ includeInactive: false });
        await writeJson(key("reasons"), {
          savedAt: Date.now(),
          runDate: colomboToday(),
          data: reasons,
        } satisfies Cached<Reasons>);
        return { reasons, fromCache: false };
      } catch (error) {
        if (!isNetwork(error)) throw error;
        const cached = await readJson<Cached<Reasons> | null>(key("reasons"), null);
        if (!cached) throw error;
        return { reasons: cached.data, fromCache: true };
      }
    },
  });
}

export function useOutbox(): OutboxSnapshot {
  return React.useSyncExternalStore(subscribeOutbox, outboxSnapshot, outboxSnapshot);
}

/**
 * Mounted once in the rider layout: loads the queue, drains it every 20 s and
 * whenever the app returns to the foreground, and refreshes the run after any
 * drain the server answered. Also honours §7's stale-runsheet rule — if the
 * server's assignment no longer matches the run on screen, the local copy is
 * discarded and re-fetched.
 */
export function useOutboxDriver(currentRun: Run | null | undefined): void {
  const queryClient = useQueryClient();
  const snap = useOutbox();

  React.useEffect(() => {
    void loadOutbox().then(() => drain());
    const timer = setInterval(() => void drain(), 20_000);
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void drain();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, []);

  const lastSuccess = snap.lastSuccessAt;
  React.useEffect(() => {
    if (!lastSuccess) return;
    void queryClient.invalidateQueries({ queryKey: riderRunKey });
    void queryClient.invalidateQueries({ queryKey: orpc.delivery.key() });
  }, [lastSuccess, queryClient]);

  const assigned = snap.assignment;
  const heldId = currentRun?.runsheet.id ?? null;
  React.useEffect(() => {
    if (!assigned && !heldId) return;
    if (assigned?.runsheetId !== heldId) {
      void queryClient.invalidateQueries({ queryKey: riderRunKey });
    }
  }, [assigned, heldId, queryClient]);
}

export type StopView =
  | "todo"
  | "queued_delivered"
  | "queued_failed"
  | "delivered"
  | "failed"
  | "removed"
  | "problem";

/**
 * What the rider should see for one stop: the server's state, unless this
 * phone holds something newer. A rejected/conflicted record wins over both —
 * it needs reading before anything else happens at that door.
 */
export function stopView(stop: RunStop, entries: OutboxEntry[]): {
  view: StopView;
  entry: OutboxEntry | null;
} {
  const entry = latestFor(entries, stop.awb);
  if (entry?.state === "pending") {
    return { view: entry.kind === "delivery.deliver" ? "queued_delivered" : "queued_failed", entry };
  }
  if (entry && (entry.state === "rejected" || entry.state === "conflict")) {
    return { view: "problem", entry };
  }
  if (entry && stop.state === "pending" && (entry.state === "applied" || entry.state === "duplicate")) {
    // The server took it; this copy of the run just predates the refresh.
    return { view: entry.kind === "delivery.deliver" ? "delivered" : "failed", entry };
  }
  if (stop.state === "delivered") return { view: "delivered", entry };
  if (stop.state === "failed") return { view: "failed", entry };
  if (stop.state === "removed") return { view: "removed", entry };
  return { view: "todo", entry };
}
