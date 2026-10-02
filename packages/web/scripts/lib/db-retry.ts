/**
 * Proof scripts talk to Turso directly, outside the server's request scope, so
 * they miss the server's transient-read retry (middleware/request-id.ts). Turso
 * resets idle sockets; a long UI run that reads the DB between browser steps
 * would then fail a check on a network blip rather than on the product — and
 * every later step that depends on it cascades.
 *
 * `hardenScriptReads(db)` retries a plain SELECT on a transient network error.
 * Writes are never replayed: a lost response to an INSERT may still have landed.
 * Import it once per script, right after importing `db`.
 */
import { isTransientDbError } from "../../src/api/shared/request-scope";

type Stmt = string | { sql: string; args?: unknown };
type Executor = { execute: (stmt: Stmt, args?: unknown) => Promise<unknown> };

const isRead = (stmt: Stmt): boolean => {
  const sql = (typeof stmt === "string" ? stmt : stmt.sql).trimStart().toLowerCase();
  return sql.startsWith("select") || sql.startsWith("with");
};

export function hardenScriptReads(db: { $client: unknown }, attempts = 4): void {
  const client = db.$client as Executor & { __hardened?: boolean };
  if (client.__hardened) return;
  const original = client.execute.bind(client);
  client.execute = async (stmt: Stmt, args?: unknown) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await original(stmt, args);
      } catch (error) {
        if (attempt >= attempts || !isRead(stmt) || !isTransientDbError(error)) throw error;
        console.log(`        (transient DB read, retry ${attempt}: ${(error as Error).message.slice(0, 60)})`);
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
  };
  client.__hardened = true;
}

/**
 * Fixture cleanup for a script's `finally` block. Only for idempotent writes
 * (delete-by-id-prefix): replaying one is harmless, while a fixture left behind
 * would sit in the books. Lives here so the retry loop is not inside `finally`.
 */
export async function cleanupWithRetry(fn: () => Promise<unknown>, attempts = 4): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fn();
      return;
    } catch (e) {
      if (attempt >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
}
