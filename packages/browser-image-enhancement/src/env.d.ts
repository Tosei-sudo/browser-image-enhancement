// Bundlers replace `process.env.NODE_ENV` at build time; see warn.ts.
declare const process: { env: Record<string, string | undefined> };
