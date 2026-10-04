// playwright.config.ts reads the environment.
declare const process: { env: Record<string, string | undefined> };

// The unit tests read the geoid grid from disk.
declare module 'node:fs' {
  export function readFileSync(path: URL): Uint8Array;
}

// The browser tests read downloaded files.
declare module 'node:fs/promises' {
  export function readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
}
