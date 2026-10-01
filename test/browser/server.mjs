// Minimal static server for browser tests: serves the repository root so pages
// can import the built package from /dist exactly as published.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.map': 'application/json', '.png': 'image/png', '.css': 'text/css' };
const port = Number(process.env.PORT ?? 4173);

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  // Lets a test simulate a Content-Security-Policy that forbids workers.
  const headers = { 'content-type': types[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' };
  if (path.endsWith('csp.html')) headers['content-security-policy'] = "worker-src 'none'";
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, headers).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
