import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** Short hash of the commit being built, or '' outside a git checkout. */
function commit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const library = JSON.parse(
  readFileSync(new URL('../../packages/browser-image-enhancement/package.json', import.meta.url), 'utf8'),
) as { version: string };

/** Every file under `dir`, as paths relative to it with `/`. */
function filesOf(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(dir, join(d.parentPath, d.name)).split('\\').join('/'))
    .sort();
}

/**
 * Writes the service worker (sw.js beside this file) into the build, with
 * the list of the build's files to keep offline and a version made of their
 * contents, so every new build installs as a new version.
 */
function serviceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'image-viewer-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = join(config.root, config.build.outDir);
    },
    closeBundle() {
      const files = filesOf(outDir).filter((f) => f !== 'sw.js' && !f.endsWith('.map'));
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const template = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
      writeFileSync(
        join(outDir, 'sw.js'),
        template.replace("'__VERSION__'", JSON.stringify(hash.digest('hex').slice(0, 12))).replace('/* __PRECACHE__ */ []', JSON.stringify(['./', ...files])),
      );
    },
  };
}

/** CesiumJS's workers, WebAssembly and assets (the 3D view loads them at run time from `cesium/`). */
const cesiumBuild = join(dirname(createRequire(import.meta.url).resolve('@cesium/engine/package.json')), 'Build');

const contentTypes: Record<string, string> = {
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
};

/**
 * Puts CesiumJS's run-time files into the build under `cesium/` (and serves
 * them there in development), so the 3D view needs no CDN or network: it
 * works in a closed network and offline like the rest of the site.
 */
function cesiumAssets(): Plugin {
  return {
    name: 'image-viewer-cesium-assets',
    configureServer(server) {
      server.middlewares.use('/cesium/', (req, res, next) => {
        const path = join(cesiumBuild, decodeURIComponent((req.url ?? '').split('?')[0]));
        if (!path.startsWith(cesiumBuild) || !statSync(path, { throwIfNoEntry: false })?.isFile()) return next();
        res.setHeader('Content-Type', contentTypes[extname(path)] ?? 'application/octet-stream');
        res.end(readFileSync(path));
      });
    },
    generateBundle() {
      for (const file of filesOf(cesiumBuild)) {
        if (file.endsWith('.map')) continue;
        this.emitFile({ type: 'asset', fileName: `cesium/${file}`, source: readFileSync(join(cesiumBuild, file)) });
      }
    },
  };
}

export default defineConfig({
  plugins: [cesiumAssets(), serviceWorker()],
  // Shown at the bottom of the side panel (src/build-info.ts).
  define: {
    __BUILD_INFO__: JSON.stringify({
      version: library.version,
      commit: commit(),
      // Set by GitHub Actions: the number of the workflow run that built the site.
      run: process.env.GITHUB_RUN_NUMBER ?? '',
      date: new Date().toISOString(),
    }),
  },
  // OpenLayers makes one large chunk; the site is a single page, so that is fine.
  build: { outDir: 'dist', target: 'es2022', chunkSizeWarningLimit: 1500 },
  // SQLite (GeoPackages) finds its .wasm next to its own module, which pre-bundling would move.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
});
