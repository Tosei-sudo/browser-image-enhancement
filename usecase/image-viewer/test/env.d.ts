// playwright.config.ts and vite.config.ts read the environment.
declare const process: { env: Record<string, string | undefined> };

// The unit tests read the geoid grid from disk.
declare module 'node:fs' {
  export function readFileSync(path: URL): Uint8Array;
  // vite.config.ts reads the library's package.json.
  export function readFileSync(path: URL, encoding: 'utf8'): string;
}

// vite.config.ts records the commit being built.
declare module 'node:child_process' {
  export function execSync(command: string, options: { encoding: 'utf8' }): string;
}

// The browser tests read downloaded files.
declare module 'node:fs/promises' {
  export function readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
}
