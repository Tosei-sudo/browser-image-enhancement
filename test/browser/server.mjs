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
  const url = new URL(req.url, 'http://x');
  const path = normalize(decodeURIComponent(url.pathname));
  // CORS lets pages on another origin (127.0.0.1 vs localhost) load the package the way they would from a CDN.
  const headers = {
    'content-type': types[extname(path)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  };
  // Lets a test simulate a Content-Security-Policy that forbids workers.
  if (path.endsWith('csp.html')) headers['content-security-policy'] = "worker-src 'none'";
  if (url.searchParams.has('csp')) headers['content-security-policy'] = url.searchParams.get('csp');
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, headers).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
