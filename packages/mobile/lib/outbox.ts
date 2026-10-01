import { ORPCError } from "@orpc/client";
import Constants from "expo-constants";
import { client } from "./api";
import { readJson, writeJson } from "./local-store";
import { deviceId, getSession } from "./session";
import { ulid } from "./ulid";

/**
 * The rider's offline outbox — PROJECT.md §7, client half.
 *
 *   - LOCAL WRITE FIRST. Tapping "Delivered" writes the operation to device
 *     storage and the screen moves on. Whether there is signal is the outbox's
 *     problem, not the rider's.
 *   - DRAIN IN DEVICE ORDER. Every operation gets the next value of a
 *     monotonic, persisted counter (`seq`) and is pushed in that order. The
 *     clock reading travels too, but only as evidence: a phone clock can be
 *     hours off, so nothing is ordered by it.
 *   - ULID CLIENT IDS, IDEMPOTENT BY CONSTRUCTION. The id is minted once, at
 *     enqueue, and survives every retry. A push that times out after the
 *     server applied it is simply pushed again and comes back `duplicate`.
 *   - SERVER AUTHORITY. The server's verdict is final. `rejected` and
 *     `conflict` are kept on the device and shown — the server has already put
 *     every conflict in the ops exception queue; the rider sees the same thing.
 *
 * One outbox per signed-in user, so a shared phone never pushes one rider's
 * doorstep records under another's token.
 */

export type OutboxKind = "delivery.deliver" | "delivery.fail";
export type OutboxState = "pending" | "applied" | "duplicate" | "rejected" | "conflict";

export interface OutboxEntry {
  clientOpId: string;
  kind: OutboxKind;
  awb: string;
  payload: Record<string, unknown>;
  seq: number;
  clientTs: number;
  state: OutboxState;
  /** The server's sentence for a rejection or conflict. */
  error: string | null;
  policy: string | null;
  conflictId: string | null;
  /** What the owning service returned when applied (ndrId, rtoId, …). */
  result: unknown;
  tries: number;
  settledAt: number | null;
}

export interface OutboxSnapshot {
  loaded: boolean;
  entries: OutboxEntry[];
  draining: boolean;
  /** Set when the last drain could not reach the server at all. */
  offline: boolean;
  lastError: string | null;
  lastDrainAt: number | null;
  lastSuccessAt: number | null;
  /** Last time the server answered at all (push OR pull) — what the strip shows. */
  lastContactAt: number | null;
  /** From sync.pull — lets the run screen notice a reassigned runsheet (§7). */
  assignment: { runsheetId: string; revision: string } | null;
  cursor: number;
}

interface Persisted {
  nextSeq: number;
  cursor: number;
  entries: OutboxEntry[];
}

/** Settled entries kept for the rider's own record; older ones are pruned. */
const KEEP_SETTLED = 60;
const BATCH = 100;
const APP_VERSION = Constants.expoConfig?.version ?? "dev";

let snapshot: OutboxSnapshot = {
  loaded: false,
  entries: [],
  draining: false,
  offline: false,
  lastError: null,
  lastDrainAt: null,
  lastSuccessAt: null,
  lastContactAt: null,
  assignment: null,
  cursor: 0,
};
let nextSeq = 1;
let loadedFor: string | null = null;
let loading: Promise<void> | null = null;
let inflight: Promise<DrainOutcome> | null = null;
const listeners = new Set<() => void>();

function storageKey(userId: string): string {
  return `natex.outbox.v1.${userId}`;
}

function currentUserId(): string | null {
  return getSession()?.user.id ?? null;
}

function emit(patch: Partial<OutboxSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const fn of listeners) fn();
}

export function subscribeOutbox(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function outboxSnapshot(): OutboxSnapshot {
  return snapshot;
}

async function persist(): Promise<void> {
  const userId = loadedFor;
  if (!userId) return;
  const settled = snapshot.entries.filter((e) => e.state !== "pending");
  const keepIds = new Set(
    settled
      .sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0))
      .slice(0, KEEP_SETTLED)
      .map((e) => e.clientOpId),
  );
  const entries = snapshot.entries.filter(
    (e) => e.state === "pending" || keepIds.has(e.clientOpId),
  );
  const data: Persisted = { nextSeq, cursor: snapshot.cursor, entries };
  await writeJson(storageKey(userId), data);
}

/** Loads this user's queue from disk. Safe to call repeatedly. */
export async function loadOutbox(): Promise<void> {
  const userId = currentUserId();
  if (!userId) return;
  if (loadedFor === userId && snapshot.loaded) return;
  loading ??= (async () => {
    const data = await readJson<Persisted>(storageKey(userId), {
      nextSeq: 1,
      cursor: 0,
      entries: [],
    });
    loadedFor = userId;
    // Never trust the stored counter below what the entries already used.
    const maxSeq = data.entries.reduce((m, e) => Math.max(m, e.seq), 0);
    nextSeq = Math.max(data.nextSeq, maxSeq + 1);
    emit({
      loaded: true,
      entries: [...data.entries].sort((a, b) => a.seq - b.seq),
      cursor: data.cursor,
      assignment: null,
    });
  })().finally(() => {
    loading = null;
  });
  return loading;
}

/**
 * Record a doorstep outcome. Resolves once it is on disk — NOT once the server
 * has it. The drain is kicked off in the background.
 */
export async function enqueue(
  kind: OutboxKind,
  awb: string,
  payload: Record<string, unknown>,
): Promise<OutboxEntry> {
  await loadOutbox();
  if (!loadedFor) throw new Error("Sign in again before recording a delivery.");

  const live = snapshot.entries.find((e) => e.awb === awb && e.state === "pending");
  if (live) {
    // A second tap on the same stop is a mistake, not a new intent: the first
    // record is already queued and will reach the server.
    throw new Error(`${awb} already has a ${describeKind(live.kind)} waiting to sync.`);
  }

  const entry: OutboxEntry = {
    clientOpId: ulid(),
    kind,
    awb,
    payload: { ...payload, awb },
    seq: nextSeq++,
    clientTs: Date.now(),
    state: "pending",
    error: null,
    policy: null,
    conflictId: null,
    result: null,
    tries: 0,
    settledAt: null,
  };
  emit({ entries: [...snapshot.entries, entry] });
  await persist();
  void drain();
  return entry;
}

export interface DrainOutcome {
  pushed: number;
  applied: number;
  problems: number;
  offline: boolean;
}

function isNetworkError(error: unknown): boolean {
  // An ORPCError means the server answered. Anything else — TypeError from
  // fetch, an abort, DNS — means it did not, and the queue simply waits.
  return !(error instanceof ORPCError);
}

function messageOf(error: unknown): string {
  if (error instanceof ORPCError) {
    const data = error.data as { detail?: string } | undefined;
    return data?.detail ?? error.message;
  }
  return error instanceof Error ? error.message : "Unknown error";
}

/**
 * Push everything pending, in seq order, then pull the authoritative
 * assignment. Single-flight: concurrent callers share one drain.
 */
export function drain(): Promise<DrainOutcome> {
  inflight ??= runDrain().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function runDrain(): Promise<DrainOutcome> {
  await loadOutbox();
  const outcome: DrainOutcome = { pushed: 0, applied: 0, problems: 0, offline: false };
  if (!loadedFor || currentUserId() !== loadedFor) return outcome;

  emit({ draining: true });
  try {
    for (;;) {
      const pending = snapshot.entries
        .filter((e) => e.state === "pending")
        .sort((a, b) => a.seq - b.seq);
      if (pending.length === 0) break;
      const batch = pending.slice(0, BATCH);

      let result: Awaited<ReturnType<typeof client.sync.push>>;
      try {
        result = await client.sync.push({
          deviceId: deviceId(),
          operations: batch.map((e) => ({
            clientOpId: e.clientOpId,
            kind: e.kind,
            payload: e.payload,
            seq: e.seq,
            clientTs: e.clientTs,
          })),
          pendingCount: pending.length,
          appVersion: APP_VERSION,
          clientNow: Date.now(),
        });
      } catch (error) {
        bumpTries(batch);
        await persist();
        const offline = isNetworkError(error);
        outcome.offline = offline;
        emit({
          offline,
          lastError: offline
            ? "No connection — records are safe on this phone and will sync."
            : messageOf(error),
          lastDrainAt: Date.now(),
        });
        return outcome;
      }

      const byId = new Map(result.verdicts.map((v) => [v.clientOpId, v]));
      const now = Date.now();
      const entries = snapshot.entries.map((e) => {
        const v = byId.get(e.clientOpId);
        if (!v) return e;
        return {
          ...e,
          state: v.state,
          error: v.error,
          policy: v.policy,
          conflictId: v.conflictId,
          result: v.result,
          tries: e.tries + 1,
          settledAt: now,
        } satisfies OutboxEntry;
      });
      outcome.pushed += batch.length;
      outcome.applied += result.applied + result.duplicates;
      outcome.problems += result.rejected + result.conflicts;
      emit({
        entries,
        offline: false,
        lastError: null,
        lastDrainAt: now,
        lastSuccessAt: now,
        lastContactAt: now,
      });
      await persist();

      // A batch the server would not give a verdict for must not loop forever.
      if (result.verdicts.length === 0) break;
    }

    await pullAssignment();
    return outcome;
  } finally {
    emit({ draining: false });
  }
}

function bumpTries(batch: OutboxEntry[]): void {
  const ids = new Set(batch.map((e) => e.clientOpId));
  emit({
    entries: snapshot.entries.map((e) => (ids.has(e.clientOpId) ? { ...e, tries: e.tries + 1 } : e)),
  });
}

/**
 * §7 delta pull — used here for the one thing the rider app must act on: is
 * the runsheet this phone holds still the one the server has assigned?
 */
async function pullAssignment(): Promise<void> {
  try {
    const pulled = await client.sync.pull({
      deviceId: deviceId(),
      cursor: snapshot.cursor,
      limit: 200,
      appVersion: APP_VERSION,
      pendingCount: snapshot.entries.filter((e) => e.state === "pending").length,
    });
    const now = Date.now();
    emit({
      offline: false,
      lastDrainAt: now,
      lastContactAt: now,
      cursor: pulled.cursor,
      assignment: pulled.assignment
        ? { runsheetId: pulled.assignment.runsheetId, revision: pulled.assignment.revision }
        : null,
    });
    await persist();
  } catch (error) {
    // Nothing to push and no answer to the pull either: that is offline, and
    // the strip should say so rather than "checking" forever.
    if (isNetworkError(error)) emit({ offline: true, lastDrainAt: Date.now() });
  }
}

/** Remove a settled problem from the phone once the rider has read it. */
export async function dismiss(clientOpId: string): Promise<void> {
  emit({
    entries: snapshot.entries.filter(
      (e) => !(e.clientOpId === clientOpId && e.state !== "pending"),
    ),
  });
  await persist();
}

/** Forget the in-memory queue on sign-out; the disk copy stays with that user. */
export function resetOutboxMemory(): void {
  loadedFor = null;
  nextSeq = 1;
  emit({
    loaded: false,
    entries: [],
    offline: false,
    lastError: null,
    lastSuccessAt: null,
    lastContactAt: null,
    assignment: null,
    cursor: 0,
  });
}

export function describeKind(kind: OutboxKind): string {
  return kind === "delivery.deliver" ? "delivery" : "failed attempt";
}

/** The latest local record for a stop, if any — what the run screen overlays. */
export function latestFor(entries: OutboxEntry[], awb: string): OutboxEntry | null {
  let found: OutboxEntry | null = null;
  for (const e of entries) {
    if (e.awb === awb && (!found || e.seq > found.seq)) found = e;
  }
  return found;
}
