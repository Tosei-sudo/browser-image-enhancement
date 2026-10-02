# browser-image-enhancement

ブラウザだけで動く画像補正ライブラリです。画像をサーバーに送らず、明るさ・コントラスト・露出・ガンマ・彩度・色温度・レベル補正と、画素の分布からダイナミックレンジを自動で決める DRA（自動ストレッチ）をかけられます。

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

新しい要求が来ると古い要求の結果は捨てられ、最新の結果だけが返ります。同じ入力を続けて渡したときはデコード結果を使い回します。大きな画像は縮小してからプレビューし、確定時だけ原寸で処理するのがおすすめです。

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

[examples/openlayers-cog](https://github.com/Tosei-sudo/browser-image-enhancement/tree/HEAD/packages/browser-image-enhancement/examples/openlayers-cog) に、クラウド最適化 GeoTIFF を OpenLayers で読み、タイルごとに補正して背景地図に重ねる例があります。地図の表示範囲の統計で引き伸ばす DRA も入っています。

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
