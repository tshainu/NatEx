// The mobile app imports the API's router type from `@template/web`, which makes
// TypeScript walk the whole server source tree. That server runs on Bun and reads
// `process.env.*` plus `import.meta.main`; the Expo type environment declares a
// closed `ProcessEnv` (see __env.d.ts, template-managed) and no Bun globals, so
// those reads would otherwise fail this package's typecheck.
//
// Interface declarations merge, so widening them here keeps the server source
// compiling from the mobile side without touching template-managed files or
// loosening the web package's own (Bun-typed) checks.

declare namespace NodeJS {
  interface ProcessEnv {
    [key: string]: string | undefined;
  }
}

interface ImportMeta {
  /** Bun: true when this module is the process entrypoint. */
  main?: boolean;
}
