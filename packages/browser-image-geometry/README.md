# browser-image-geometry

ブラウザだけで動く幾何補正ライブラリです。基準点（GCP）から変換を推定し、画像を変形して地図座標に合わせます。重い処理は Web Worker で並列に行い、メインスレッドを止めません。

- 変換: アフィン、射影（台形補正）、2 次・3 次多項式
- 基準点からの推定: 最小二乗で推定し、RMS 誤差と点ごとの残差を返す
- 再サンプリング: 最近傍、バイリニア、バイキュービック。透明度を考慮して補間し、2 倍を超える縮小ではエイリアシングを抑える
- 地図座標: 出力画像の GeoTransform と範囲（extent）を返す。OpenLayers の `ImageStatic` にそのまま渡せる
- 投影法: proj4 などの変換を渡せる（本体は proj4 に依存しない）
- 依存ライブラリなし。モノクロ画像もそのまま扱える

設計の背景は [docs/geometry-design.md](../../docs/geometry-design.md) にあります。npm にはまだ公開していません。すべての関数・型の説明は [API リファレンス](https://tosei-sudo.github.io/browser-image-enhancement/modules/browser-image-geometry.html) にあります。

## 使い方

### 古地図などを基準点で地図に合わせる

```ts
import { fitTransform, warp } from 'browser-image-geometry';

// 画像上の位置（画素）と、その場所の地図座標（経度・緯度など）の組
const fit = fitTransform(
  [
    { pixel: [120, 80], world: [139.7, 35.69] },
    { pixel: [1830, 95], world: [139.8, 35.69] },
    { pixel: [1810, 1420], world: [139.8, 35.62] },
    { pixel: [140, 1400], world: [139.7, 35.62] },
  ],
  { model: 'projective' }, // 'affine'（3 点以上）| 'projective'（4 点）| 'polynomial2'（6 点）| 'polynomial3'（10 点）
);
console.log(fit.rms, fit.residuals); // 当てはまりの確認

const out = await warp(imageElementOrBlob, fit.transform, { output: 'canvas' });
out.image;        // 北が上になるよう変形した画像
out.extent;       // [minX, minY, maxX, maxY]
out.geoTransform; // [左上x, 画素幅, 0, 左上y, 0, -画素高]（GDAL と同じ並び）
```

OpenLayers に重ねる例:

```ts
import ImageLayer from 'ol/layer/Image';
import Static from 'ol/source/ImageStatic';

const canvas = out.image as HTMLCanvasElement;
map.addLayer(
  new ImageLayer({
    source: new Static({ url: canvas.toDataURL(), imageExtent: out.extent, projection: 'EPSG:4326' }),
  }),
);
```

### 投影法をまたぐ

基準点は経度・緯度で、出力は Web メルカトルにしたい、という場合は `coordinateTransform` に `forward` と `inverse` を持つ変換を渡します。proj4 の変換オブジェクトがそのまま使えます。

```ts
import proj4 from 'proj4';

const out = await warp(img, fit.transform, {
  coordinateTransform: proj4('EPSG:4326', 'EPSG:3857'),
});
// out.extent はメートル（EPSG:3857）
```

変換関数は Worker に送れないので、メインスレッドで出力の上に粗い格子（既定 32 画素間隔）を置いて計算し、格子の中は補間します。誤差が `tolerance`（既定 0.125 画素）を超えるときは格子を自動で細かくします。

### 台形補正（画像座標どうし）

```ts
const fit = fitTransform(
  [
    { pixel: [212, 95], world: [0, 0] },
    { pixel: [988, 120], world: [800, 0] },
    { pixel: [1040, 870], world: [800, 600] },
    { pixel: [160, 840], world: [0, 600] },
  ],
  { model: 'projective', target: 'image' }, // y が下向きの画像座標
);
const { image } = await warp(photo, fit.transform, { extent: [0, 0, 800, 600], width: 800, height: 600 });
```

### 回転・反転・切り抜き・拡大縮小（同期）

`ImageData` を受け取り、新しい `ImageData` を返します。メインスレッドで動きます。

```ts
import { crop, flip, resize, rotate } from 'browser-image-geometry';

rotate(imageData, 15);                        // 時計回り。キャンバスを広げて全体を収める
rotate(imageData, 15, { expand: false });     // 元の大きさのまま
rotate(imageData, 90);                        // 90° 単位は画素がずれない
flip(imageData, 'horizontal');                // 'vertical' | 'both'
crop(imageData, { x: 10, y: 20, width: 300, height: 200 });
resize(imageData, 640, 480, { resample: 'bicubic' });
```

任意の変換を同期で掛けるときは `warpImageData(imageData, transform, options)` を使います（戻り値は `warp` と同じ形で、`image` は `ImageData`）。

## 変換

変換はただのオブジェクトなので、JSON で保存したり Worker に送ったりできます。

```ts
import { affine, applyTransform, composeTransforms, invertTransform, projective, rotation, scaling, translation } from 'browser-image-geometry';

const t = affine([a, b, c, d, e, f]); // X = a·x + b·y + c, Y = d·x + e·y + f
applyTransform(t, [10, 20]);          // 入力画素 → 出力座標
invertTransform(t);
composeTransforms(scaling(2), translation(5, 0)); // 拡大してから平行移動
```

画像の座標は連続値で、画素 `(i, j)` の中心は `(i + 0.5, j + 0.5)` です。

## オプション（`warp` / `warpImageData`）

| オプション | 既定値 | 内容 |
| --- | --- | --- |
| `resample` | `'bilinear'` | `'nearest'` / `'bilinear'` / `'bicubic'` |
| `background` | `[0, 0, 0, 0]` | 入力の外側の色（RGBA、0〜255） |
| `extent` | 入力全体 | 出力する範囲 `[minX, minY, maxX, maxY]`（出力座標） |
| `pixelSize` | 入力と同程度 | 出力の画素サイズ（出力座標の単位）。数値か `[x, y]` |
| `width` / `height` | — | 出力の画素数。指定すると `pixelSize` より優先 |
| `coordinateTransform` | — | 変換先の座標を出力座標に変える `{ forward, inverse }`（proj4 など） |
| `gridStep` / `tolerance` | `32` / `0.125` | `coordinateTransform` の近似格子の間隔と許容誤差（入力の画素） |
| `yUp` | 変換に従う | `true` で y の大きい側を上にする |
| `output` | `'imageData'` | `warp` のみ。`'canvas'` / `'blob'` も可 |
| `type` / `quality` | `'image/png'` | `output: 'blob'` のときの形式と品質 |
| `worker` | `true` | `false` でメインスレッドで処理 |
| `signal` | — | `AbortSignal` で中断 |

## Web Worker

出力を横帯に分けて複数の Worker で処理し、各 Worker には帯が参照する入力の範囲だけを渡します。Worker が使えない環境（CSP で禁止されている、など）では自動でメインスレッドで処理します。結果はどちらでも同じです。

```ts
import { configureWorkers, terminateWorkers } from 'browser-image-geometry';

configureWorkers({ maxWorkers: 2 });
terminateWorkers();
```

## CDN

ビルド済みのファイルは `dist/cdn/` にあります（Worker を同梱した ES モジュールと、グローバル変数 `BrowserImageGeometry` を作る `<script>` 用）。GitHub のタグから jsDelivr で配信できます。

```html
<script type="module">
  import { fitTransform, warp } from 'https://cdn.jsdelivr.net/gh/Tosei-sudo/browser-image-enhancement@<タグ>/packages/browser-image-geometry/dist/cdn/browser-image-geometry.min.js';
</script>
```

## 開発

```sh
npm install            # リポジトリのルートで
cd packages/browser-image-geometry
npm run typecheck
npm test               # Vitest（ユニットテスト）
npm run test:browser   # Playwright（実ブラウザで Worker、CDN 読み込み、CSP を確認）
```

`dist/` はコミットしています。ソースを変えたら `npm run build` して一緒にコミットしてください。

## ライセンス

MIT
