import type { AppRouterClient } from "../../src/api";

/**
 * Retire a rider's leftover run the way the hub would, before a script opens a
 * fresh one (one live run per rider per day).
 *
 *   - a DISPATCHED run is force-closed: pending stops become TIME_EXHAUSTED
 *     failures and land in the NDR queue (audited)
 *   - a DRAFT run — typically left behind when a dispatch failed halfway, e.g. a
 *     database network flake — cannot be closed (nothing left the hub), so it is
 *     cancelled: its stops are marked removed and the rider is freed
 *
 * `client` must carry an ops (or admin) token and its own Idempotency-Key.
 */
export async function retireRun(
  client: AppRouterClient,
  run: { id: string; status: string; code?: string },
  notes: string,
): Promise<{ status: string; swept: number }> {
  if (run.status === "draft") {
    const res = await client.delivery.runsheetCancel({ runsheetId: run.id, reason: notes });
    return { status: res.runsheet.status, swept: res.released.length };
  }
  const res = await client.delivery.runsheetClose({ runsheetId: run.id, force: true, notes });
  return { status: res.runsheet.status, swept: res.unattempted.length };
}
