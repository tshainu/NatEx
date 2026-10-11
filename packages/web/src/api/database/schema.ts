/**
 * Drizzle schema root — composition only.
 *
 * One file per module, mirroring PROJECT.md §4's rule that each module owns its
 * own database schema. PostgreSQL schemas (`parcels.*`, `cod.*`, `identity.*`)
 * have no SQLite equivalent, so ownership is expressed as a table-name prefix
 * plus the hard rule that only the owning module's service reads its tables.
 *
 * Apply with `bun run db:push` from packages/web.
 */
export * from "./schema/identity";
export * from "./schema/merchants";
export * from "./schema/parcels";
export * from "./schema/collection";
export * from "./schema/routing";
export * from "./schema/transport";
export * from "./schema/delivery";
export * from "./schema/freight";
export * from "./schema/notifications";
export * from "./schema/sync";
export * from "./schema/cod";
export * from "./schema/settings";
export * from "./schema/hr";
export * from "./schema/shared";
