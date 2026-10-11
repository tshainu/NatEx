import { db } from "./__client";

/** Callback executor type for the configured libSQL/Drizzle transaction. */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
