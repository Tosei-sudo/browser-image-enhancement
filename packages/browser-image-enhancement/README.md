# browser-image-enhancement

ブラウザだけで動く画像補正ライブラリです。画像をサーバーに送らず、明るさ・コントラスト・露出・ガンマ・彩度・色温度・レベル補正、シャープ（アンシャープマスク）と、画素の分布からダイナミックレンジを自動で決める DRA（自動ストレッチ）をかけられます。

- 依存ライブラリなし、ESM + TypeScript 型定義付き
- 重い処理は Web Worker で実行し、メインスレッドを止めない（使えない環境では自動でメインスレッド実行）
- 計算はリニア RGB で行い、8bit への丸めは最後の 1 回だけ
- モノクロ画像を自動判定し、輝度 1 チャンネルで処理（結果も R=G=B のまま）

設計の背景は [docs/design.md](docs/design.md) にあります。すべての関数・型の説明は [API リファレンス](https://tosei-sudo.github.io/browser-image-enhancement/modules/browser-image-enhancement.html) にあります。

## インストール

```sh
npm install browser-image-enhancement
```

### CDN から使う

ビルド不要で、jsDelivr や unpkg から直接読み込めます。Web Worker はライブラリのファイル内に同梱しているので、1 ファイルを読み込むだけで Worker 実行まで動きます。

ES モジュール:

```html
<script type="module">
  import { pipeline } from 'https://cdn.jsdelivr.net/npm/browser-image-enhancement@0.1.0/dist/cdn/browser-image-enhancement.min.js';

  const out = await pipeline().brightness(0.1).contrast(0.2).run(document.querySelector('img'));
</script>
```

`<script>` タグ（グローバル変数 `BrowserImageEnhancement`）:

```html
<script src="https://cdn.jsdelivr.net/npm/browser-image-enhancement@0.1.0/dist/cdn/browser-image-enhancement.iife.min.js"></script>
<script>
  const { pipeline } = BrowserImageEnhancement;
</script>
```

- unpkg も同じパスで使えます（`https://unpkg.com/browser-image-enhancement@0.1.0/dist/cdn/...`）
- ビルド済みの `dist/` はリポジトリにも入っているので、GitHub のタグからも配信できます（`https://cdn.jsdelivr.net/gh/Tosei-sudo/browser-image-enhancement@<タグ>/packages/browser-image-enhancement/dist/cdn/browser-image-enhancement.min.js`）。モノレポ化より前のコミットに打ったタグでは、パスは `/dist/cdn/...` です
- バージョンは固定して読み込んでください
- 同梱の Worker は `blob:` URL から起動します。CSP の `worker-src` で `blob:` を許可していない場合はメインスレッドで処理します
- npm 版の `dist/index.js` を CDN から直接読み込んだ場合も、別オリジンでは Worker を自動で同一オリジンの `blob:` 経由で起動します

## 使い方

### パイプライン（複数の補正・プレビュー向け）

```ts
import { pipeline } from 'browser-image-enhancement';

const p = pipeline()
  .exposure(0.3)
  .contrast(0.2)
  .saturation(-0.1)
  .levels({ inBlack: 0.02, inWhite: 0.98 });

const imageData = await p.run(img);                       // ImageData（既定）
const canvas = await p.run(img, { output: 'canvas' });
const blob = await p.run(img, { output: 'blob', type: 'image/webp', quality: 0.9 });
const gray = await p.run(img, { output: 'gray' });        // { data: 輝度のみの Uint8ClampedArray, width, height }
```

- `run` の入力には `ImageData`、`HTMLImageElement`、`HTMLCanvasElement`、`OffscreenCanvas`、`ImageBitmap`、`HTMLVideoElement`、`Blob`（`File`）を渡せます。Blob は EXIF の回転情報を反映して読み込みます
- 補正はまとめて 1 パスで計算し、途中で 8bit に丸めません
- パイプラインは不変です。`.brightness()` などは新しいパイプラインを返します
- `p.runSync(imageData)` でメインスレッド上の同期実行もできます

### 関数（単発の補正）

```ts
import { brightness, contrast } from 'browser-image-enhancement';

const out = contrast(brightness(imageData, 0.1), 0.2);
```

各関数は新しい `ImageData` を返し、入力は変更しません。メインスレッドで同期的に動きます。続けて呼ぶと補正ごとに 8bit に丸められるので、複数の補正を重ねるときはパイプラインを使ってください。

### スライダーでのプレビュー

```ts
import { createPreviewRunner, pipeline } from 'browser-image-enhancement';

const preview = createPreviewRunner({ output: 'canvas' });

slider.oninput = async () => {
  const result = await preview.run(pipeline().brightness(Number(slider.value)), img);
  if (result) show(result); // 新しい要求に追い越された結果は null
};
```

新しい要求が来ると古い要求の結果は捨てられ、最新の結果だけが返ります。同じ入力を続けて渡したときはデコード結果を使い回します。

大きな画像では `maxSize` を指定すると、長辺がその大きさになるよう 1 回だけ縮小したコピーでプレビューします（シャープの半径も縮小率に合わせます）。スライダーを動かしている間は縮小版、離したときだけ原寸で処理すると、操作に追従します。

```ts
const preview = createPreviewRunner({ maxSize: 1280 });
slider.oninput = async () => show(await preview.run(current(), img));  // 縮小版
slider.onchange = async () => show(await current().run(img));         // 原寸
```

参考値（1200 万画素の写真、ヘッドレス Chromium・4 コア、Worker 使用、スライダー 1 回あたり）:

| プレビューの長辺 | 点処理 5 個 | ＋彩度 | ＋DRA・シャープ |
| --- | --- | --- | --- |
| 800 px | 5 ms | 16 ms | 57 ms |
| 1280 px | 9 ms | 27 ms | 89 ms |
| 1920 px | 17 ms | 59 ms | 180 ms |
| 原寸（4000 px） | 86 ms | 246 ms | 888 ms |

縮小版は `pipeline.scaled(縮小率)` を縮小した画像に掛けたものと同じです。

### GPU（WebGL2）で原寸のままプレビュー

WebGL2 が使えるブラウザでは、`createGpuRenderer` で原寸の画像をスライダーに合わせて GPU で補正し、canvas に直接描けます。画像は最初に 1 回だけ GPU に送り、以降は補正の値が変わるたびに描き直すだけです。

```ts
import { createGpuRenderer, pipeline } from 'browser-image-enhancement';

const gpu = createGpuRenderer({ canvas: view }); // WebGL2 が使えなければ null
if (gpu) {
  gpu.setImage(img);                               // ImageData など（1 回だけ）
  slider.oninput = () => gpu.render(current());   // 原寸で描画
  save.onclick = async () => download(await current().run(img, { output: 'blob' })); // 保存は JS 版
} else {
  // 縮小プレビュー（createPreviewRunner の maxSize）にフォールバック
}
```

- すべての補正（DRA・シャープ・モノクロ画像・透明画素を含む）が使えます。`autoStretch` の統計は `setImage` に渡した画像から取ります
- GPU は float32 で計算するため、JS 版（float64）と 1 階調ずれる画素がまれにあります（テストでは 0.01% 未満）。保存や後続処理に使う最終結果は `run` / `runSync` で作ってください
- 結果の画素が必要なときは `gpu.read()`（GPU からの読み戻しなので `render` より遅い）
- 一辺が `gpu.maxSize`（GPU の上限、多くは 8192〜16384 px）を超える画像は `setImage` が `RangeError` を投げます
- `setImage` には別の canvas（2D・WebGL）、`ImageBitmap`、読み込み済みの `<img>`、`<video>` も渡せます。画素をメモリに読み出さず GPU の中でコピーするので、毎フレーム描き直される canvas（WebGL の地図など）の補正に向きます。この場合 `colorMode: 'auto'` は `rgb` 扱いで、`autoStretch` は画素を読めないので `pipeline.resolve(stats)` で先に範囲を決めておきます
- シャープを使うと作業用に float のテクスチャを確保します（12MP で 1 枚 100〜200 MB 程度）

### 設定の保存と復元

```ts
const json = JSON.stringify(p);            // { "version": 1, "ops": [...] }
const restored = pipeline.fromJSON(json);
```

## 補正の一覧

| 補正 | パラメータ | 0（無変化）からの動き |
| --- | --- | --- |
| `brightness(amount)` | -1〜1 | 正で白に、負で黒に近づける。1 で真っ白、-1 で真っ黒 |
| `contrast(amount)` | -1〜1 | sRGB の 50% グレーを支点に強める／弱める。-1 で全面グレー、1 で 2 値化 |
| `exposure(ev)` | -10〜10（EV） | +1 で光量 2 倍 |
| `gamma(value)` | 0.1〜10（1 で無変化） | 1 より大きいと中間調が明るくなる |
| `saturation(amount)` | -1〜1 | -1 でグレースケール、1 で彩度 2 倍 |
| `temperature(amount)` | -1〜1 | 正で暖色（黄〜橙）、負で寒色（青） |
| `levels({ inBlack, inWhite, gamma, outBlack, outWhite })` | 黒点・白点は 0〜1、`gamma` は 0.1〜10 | 0〜255 の目盛りなら値を 255 で割って指定。`gamma` が 1 より大きいと中間調が明るくなる |
| `stretch({ black, white })` | 0〜1（sRGB の符号化値）。1 つの数か `[R, G, B]` | `black`〜`white` を 0〜255 いっぱいに引き伸ばし、外側は切り捨てる |
| `autoStretch({ method, lowPercent, highPercent, stdDevs, linked })` | 下の「DRA」を参照 | 画素の分布から `stretch` の範囲を自動で決める |
| `sharpen({ amount, radius, threshold })` | 下の「シャープ」を参照 | 輪郭を強調する。`amount` が 0 で無変化 |

範囲外の値は例外にせず範囲内に丸め、開発ビルドでのみ `console.warn` で警告します（`process.env.NODE_ENV === 'production'` のビルドでは警告を出しません）。

## DRA（ダイナミックレンジの自動調整）

`autoStretch` は画素の分布から黒点・白点を決めて、その範囲を 0〜255 いっぱいに引き伸ばします（ArcGIS の DRA やパーセントクリップと同じ考え方）。透明な画素（α = 0、地図の nodata など）は数えません。

```ts
import { pipeline, histogram, mergeHistograms } from 'browser-image-enhancement';

// 1 枚の画像: run のときにその画像の統計を取る
await pipeline().autoStretch().contrast(0.1).run(img);

// タイル・表示範囲: 見えている部分の統計を集めてから範囲を確定し、全タイルに同じ範囲を掛ける
const stats = mergeHistograms(tiles.map((t) => histogram(t.image, { rect: t.visibleRect })));
const fixed = pipeline().autoStretch().resolve(stats);
```

| オプション | 既定 | 意味 |
| --- | --- | --- |
| `method` | `'percentClip'` | `'percentClip'`（両端から指定割合を切り捨て）、`'minMax'`（最小〜最大）、`'standardDeviation'`（平均 ± `stdDevs`σ） |
| `lowPercent` / `highPercent` | `0.5` / `0.5` | `percentClip` で暗い側・明るい側から切り捨てる画素の割合（%） |
| `stdDevs` | `2` | `standardDeviation` の幅 |
| `linked` | `false` | `false` は R・G・B を別々に引き伸ばす（色かぶりも取れる）。`true` は 3 チャンネル共通の範囲で色のバランスを保つ |

- 統計は「その位置に届いた画像」のものです。前に露出などがあれば、それを掛けた後の分布で決めます（彩度より後ろに置いた場合だけは彩度を無視した統計になり、警告が出ます）
- Worker で横帯に分けて処理するときも、全体の統計で 1 つの範囲を決めてから処理します
- `resolve(stats)` は `autoStretch` を具体的な `stretch` に置き換えたパイプラインを返します。`toJSON()` は `autoStretch` のまま保存します
- 真っ平らな画像やチャンネル（黒点 ≥ 白点）は変えません

設計は [docs/dra.md](docs/dra.md) にあります。

## シャープ（アンシャープマスク）

```ts
import { pipeline, sharpen } from 'browser-image-enhancement';

const out = sharpen(imageData, { amount: 0.8, radius: 1.2 });
await pipeline().autoStretch().contrast(0.1).sharpen({ amount: 0.6, radius: 1, threshold: 0.02 }).run(img);
```

| オプション | 既定 | 意味 |
| --- | --- | --- |
| `amount` | `0.5` | 強さ（0〜5）。元画像とぼかした画像の差をこの倍率で足す |
| `radius` | `1` | ガウスぼかしの半径（標準偏差、0.1〜50 px）。各画素は `ceil(3 × radius)` px 先まで参照するので、大きいほど遅くなる |
| `threshold` | `0` | 差がこれより小さい所は変えない（sRGB 符号化値で 0〜1、255 倍すると階調）。平坦な部分やノイズを強調しないために使う |

- 輪郭は sRGB 符号化値の輝度で検出し、同じ量を R・G・B に足します。色がにじまず、モノクロ画像は R=G=B のままです
- 透明な画素（α = 0、地図の nodata など）は変えず、周りの画素のぼかしにも数えません。画像の外側も透明として扱います
- パイプラインの途中に置いても 1 パスで計算し、前後の補正との間で 8bit に丸めません
- Worker で横帯に分けるときは、帯の上下に `margin` 行の重なりを付けて送るので、結果はメインスレッドで全体を処理したときと 1 ビットも違いません

### タイル画像でのシャープ

隣の画素を見る補正なので、タイルを 1 枚ずつ処理すると境目が見えます。`pipeline.margin` px だけ周りのタイルの画素を付けて処理し、結果から中央を切り出すと、全体を一度に処理したときと同じ画素になります。隣のタイルがない所（画像の外側）は透明（α = 0）で埋めてください。

```ts
const p = pipeline().sharpen({ amount: 0.8 });
const m = p.margin; // 例: radius 1 なら 3
const padded = await p.run({ data: tileWithNeighbours, width: w + 2 * m, height: h + 2 * m }, { colorMode: 'rgb' });
// padded の (m, m) から w × h を切り出す
```

## モノクロ画像

- 既定（`colorMode: 'auto'`）では、全画素が R=G=B の画像をモノクロと判定し、輝度 1 チャンネルで計算します。結果も R=G=B のままです
- 彩度と色温度はモノクロ画像には何もしません。色を付けたいときは `colorMode: 'rgb'` を指定してください
- `colorMode: 'gray'` を指定すると、カラー画像も輝度（Rec. 709）に変換してから補正します
- アルファチャンネルは補正せずそのまま返します

```ts
await pipeline().temperature(0.5).run(grayImg, { colorMode: 'rgb' }); // モノクロ画像に色を付ける
```

## Web Worker

- `run` は既定で Web Worker を使います。大きな画像は横帯に分けて複数の Worker（既定の上限は `navigator.hardwareConcurrency`）で並列処理します
- Worker が作れない環境（CSP の `worker-src` で禁止されている、Worker ファイルが読み込めないなど）では自動でメインスレッドで処理します
- `run(img, { worker: false })` でメインスレッドに固定できます
- `run(img, { signal })` に `AbortSignal` を渡すと中断できます（`AbortError` で reject）
- Worker のファイルは `new URL('./worker.js', import.meta.url)` で参照しているので、Vite や webpack 5 などのバンドラでそのまま動きます（CDN 用ファイルは Worker を同梱しています）。別の場所に置いた Worker を使う場合や並列数を変える場合は `configureWorkers` を使います

```ts
import { configureWorkers, terminateWorkers } from 'browser-image-enhancement';

configureWorkers({
  maxWorkers: 2,
  createWorker: () => new Worker('/static/bie-worker.js', { type: 'module' }),
});

terminateWorkers(); // 使い終わったら Worker を止める（次の run で再起動する）
```

## 色空間と制約

- 入出力は sRGB です。Display P3 などの画像や `ImageData` は、パイプラインがブラウザの機能で sRGB に変換してから処理します（関数 API は sRGB の `ImageData` のみ受け付けます）
- 16bit PNG も Canvas 経由で読み込むため 8bit になります
- 対応ブラウザは Chrome / Edge / Firefox / Safari の最新 2 バージョンです

## 地図（OpenLayers + COG）での利用

[examples/openlayers-cog](https://github.com/Tosei-sudo/browser-image-enhancement/tree/HEAD/packages/browser-image-enhancement/examples/openlayers-cog) に、クラウド最適化 GeoTIFF を OpenLayers で読み、タイルごとに補正して背景地図に重ねる例があります。地図の表示範囲の統計で引き伸ばす DRA と、隣のタイルを余白にしてタイル境界が出ないシャープも入っています。

## 開発

```sh
npm install            # リポジトリのルートで（npm workspaces）
npm run lint           # ルートで実行
cd packages/browser-image-enhancement
npm run typecheck
npm test               # Vitest（ユニットテスト）
npm run test:browser   # Playwright（実ブラウザで Worker・Canvas・Blob を確認）
npm run demo           # スライダーで補正を試せるデモ
npm run example:ol     # OpenLayers + COG（GeoTIFF）に補正をかけて地図に重ねる例
```

このパッケージはモノレポの一部です。Worker プールなどの共通部分は [packages/workers](https://github.com/Tosei-sudo/browser-image-enhancement/tree/HEAD/packages/workers)（非公開）にあり、ビルド時に `dist/` に取り込まれます。

`dist/` はコミットしています（GitHub から CDN 配信するため）。`src/` や `packages/workers/src/` を変えたら `npm run build` して `dist/` も一緒にコミットしてください。CI でずれを検出します。

Playwright のブラウザを別の場所に入れている場合は `CHROMIUM_PATH` に実行ファイルのパスを指定してください。

## ライセンス

MIT
