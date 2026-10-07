// Packs the built site (dist/) into one zip to carry into a closed network:
// release/image-viewer-<YYYYMMDD>-<commit>.zip, holding an image-viewer/ folder
// with the site and a README.txt on how to serve it there. Run after `npm run build`.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const here = fileURLToPath(new URL('..', import.meta.url));
const dist = join(here, 'dist');
if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/ がありません。先に npm run build してください');
  process.exit(1);
}

const commit = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
})();
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
const name = `image-viewer-${day}${commit ? `-${commit}` : ''}`;

const readme = `画像ビューア（閉域持ち込み用）
ビルド: ${now.toISOString()}${commit ? ` / コミット ${commit}` : ''}

■ 置き方
image-viewer フォルダの中身を、閉域内の Web サーバー（IIS・nginx・Apache など）の
公開フォルダにそのままコピーし、ブラウザ（Chrome・Edge）で index.html の URL を開きます。
すべて相対パスなので、どの階層に置いても動きます。外部の CDN は使っていません。
※ index.html をダブルクリックして file:// で開くと動きません（Worker と config.json の
  読み込みに Web サーバーが必要です）。サーバーが無いときは、Node.js があれば
  このフォルダで「npx serve」、Python があれば「python -m http.server」でも動きます。

■ 設定（config.json）
背景地図と座標系の検索先は初期設定ではインターネット上のサービスを指しています。
閉域では config.json を編集してください（再ビルド不要）。
  - baseMaps: 閉域内のタイルサーバーの URL に変えるか、[] にして背景なしにする
  - projectionLookup: "" にする（UTM・日本の平面直角座標系などは組み込みで使えます）
  - projections: 使う座標系の proj4 定義を追加できます

■ アプリとしてのインストール（任意）
HTTPS（または localhost）で配信すると、アプリとしてインストールでき、
.ivproj（プロジェクトファイル）をダブルクリックで開けるようになります。
HTTP では通常の Web ページとして動きます（プロジェクトの保存・読み込みは使えます）。
`;

/** Every file under `dir`, as paths with `/`. */
function filesOf(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(dir, join(d.parentPath, d.name)).split('\\').join('/'))
    .sort();
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip of `entries` (deflated; names in UTF-8). */
function zip(entries) {
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { path, data } of entries) {
    const nameBytes = Buffer.from(path, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // names are UTF-8
    head.writeUInt16LE(stored ? 0 : 8, 8);
    head.writeUInt16LE(dosTime, 10);
    head.writeUInt16LE(dosDate, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    locals.push(head, nameBytes, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += head.length + nameBytes.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const entries = [
  { path: 'image-viewer/README.txt', data: Buffer.from(readme.replace(/\n/g, '\r\n'), 'utf8') },
  ...filesOf(dist).map((f) => ({ path: `image-viewer/${f}`, data: readFileSync(join(dist, f)) })),
];
const out = join(here, 'release');
mkdirSync(out, { recursive: true });
const file = join(out, `${name}.zip`);
writeFileSync(file, zip(entries));
console.log(`${relative(process.cwd(), file)}（${(statSync(file).size / 1e6).toFixed(1)} MB, ${entries.length} ファイル）`);
// For the workflow: the zip's path, to upload it.
if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `zip=${file}\nname=${name}\n`, { flag: 'a' });
