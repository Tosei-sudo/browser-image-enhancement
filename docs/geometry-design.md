# モノレポ構成と幾何補正パッケージ 設計メモ

色補正（`browser-image-enhancement`）とは別に、幾何補正のパッケージを同じリポジトリに追加する。このメモはリポジトリの構成と、幾何補正パッケージの範囲・API を決めるためのもの。

## なぜ別パッケージか

- **処理の性質が違う**: 色補正は画素ごとの処理で、出力の大きさは入力と同じ。幾何補正は座標変換と再サンプリングが中心で、出力の大きさも範囲も変わる
- **軽さを保つ**: 色補正は CDN で gzip 約 8 kB。幾何補正の推定処理や地理座標の扱いを入れて大きくしたくない
- **共有できる部分はある**: Worker プール、画像を横帯に分けて並列処理する仕組み、CDN から読み込まれたときの Worker 起動は両方で同じ。これを共通パッケージにする

## リポジトリ構成

npm workspaces を使う（pnpm などは導入しない）。

```
packages/
  browser-image-enhancement/   色補正（公開中の名前・API・dist の構成は変えない）
  browser-image-geometry/      幾何補正（新規、このメモの後半）
  workers/                     共通部分 @browser-image/workers（非公開）
docs/                          リポジトリ全体の設計メモ
```

- 各パッケージは自分の `src/`、`test/`、`dist/`、README を持つ。lint はルートで一括、型チェックとテストはパッケージごと
- 両方のパッケージを使う例（地図の上で色補正と幾何補正を両方かける、など）はルートの `examples/` に置く。今の OpenLayers + COG の例は色補正だけを使うので、当面 `packages/browser-image-enhancement/examples/` に置いたままにする

### 共通パッケージ `@browser-image/workers`

置くもの:

- `WorkerPool`: 遅延起動、`ready` 待ち、起動失敗時にメインスレッドへ戻す判定、要求と応答の対応付け。メッセージの型はパッケージごとに型引数で決める
- `createSharedPool`: パッケージごとの共有プールと `configureWorkers` / `terminateWorkers`
- `splitRows`、`stripCount`、`yieldToEventLoop`: 横帯の分割と、帯のコピーの合間にメインスレッドを空ける処理
- `abortError`、`race`、`throwIfAborted`: `AbortSignal` の扱い
- `crossOriginWorkerUrl`: 別オリジン（CDN）の Worker スクリプトを同一オリジンの `blob:` から起動する
- `serveWorker`: Worker 側の起動処理（`ready` の送信とメッセージの受け渡し）

置かないもの: 各パッケージのメッセージ定義、Worker の中身（ハンドラ）、実行の組み立て（帯の送り方や結果の結合）。これらは処理ごとに違う。

**公開しない理由**: 公開して依存関係にすると、`dist/index.js` を CDN から直接読み込んだときに `@browser-image/workers` という名前を解決できず動かなくなる。また 2 つのパッケージとバージョンを揃える手間も増える。そこで非公開にして、各パッケージのビルド（`tsdown`）で `dist/` の中に取り込む。型定義も取り込むので、利用者からは見えない。

**Worker プールはパッケージごとに別**。両方を使うと Worker は最大でコア数の 2 倍になるが、どちらも使わない間は起動しないので実害は小さい。問題になったら共有プールを検討する。

### バージョンと配信

- バージョンはパッケージごとに独立して上げる
- npm からの CDN 配信（`/npm/<パッケージ名>@<版>/dist/cdn/...`）はパスが変わらない
- GitHub のタグからの配信（`/gh/`）は、モノレポ化以降のタグでは `packages/<ディレクトリ>/dist/cdn/...` になる。モノレポ化より前に打ったタグ（v0.1.0 など）は `/dist/cdn/...` のまま
- タグはパッケージ名を前に付ける（`enhancement-v0.2.0`、`geometry-v0.1.0`）

## 幾何補正パッケージ `browser-image-geometry`

### 使う場面

- 地理参照のない画像（スキャンした古地図、ドローンや斜め写真）に基準点（GCP）を打って、地図に重なるよう変形する
- 回転、反転、拡大縮小、切り抜き、台形補正といった画像としての変形
- 変形した画像を書き出す（`Blob` や `canvas`）

地理参照済みの COG を OpenLayers で表示するだけなら、再投影は OpenLayers に任せればよく、このパッケージは要らない。

### 最初のリリースの範囲

| 項目 | 内容 |
| --- | --- |
| 変換モデル | アフィン（2×3）、射影変換（3×3、台形補正）、2 次・3 次多項式 |
| 基準点からの推定 | 最小二乗で推定し、RMS 誤差と点ごとの残差を返す。必要な点の数はアフィン 3、射影 4、2 次 6、3 次 10 |
| 簡易関数 | `rotate`、`flip`、`resize`、`crop`（中身はアフィン変換） |
| 再サンプリング | 最近傍、バイリニア、バイキュービック。透明度はプリマルチプライして補間し、縁が黒ずまないようにする。2 倍を超える縮小では、先に半分への縮小を繰り返してエイリアシングを抑える |
| 出力範囲 | `'auto'`（入力の四隅と辺上の点を変換した外接矩形）、または幅・高さと変換の明示。範囲外は透明（`background` で色を指定可） |
| 地理参照 | 基準点の座標が地図座標なら、出力画像の左上座標と画素サイズ（GeoTransform）と範囲（extent）を返す。OpenLayers の `ImageStatic` にそのまま渡せる |
| 投影法 | proj4 は本体に入れない。座標変換の関数を受け取る口を用意する（下記） |
| 画素形式 | 8bit RGBA。モノクロ画像も色に触れないのでそのまま保たれる |

見送るもの: Thin Plate Spline、DEM を使うオルソ補正、レンズ歪み補正、特徴点の自動対応付け、GeoTIFF の読み書き（geotiff.js に任せる）、16bit・浮動小数のバンド。

### 投影法の扱い

proj4 などの変換関数は Worker に送れない（関数は postMessage できない）。そこで GDAL の近似変換と同じ方法を取る。

1. メインスレッドで、出力画像の上に粗い格子（既定 32 画素間隔）を置き、各格子点について利用者の変換関数で入力画像上の座標を求める
2. 格子点の座標（数値の配列）だけを Worker に送る
3. Worker は格子の中を双線形補間して各画素の入力座標を求め、再サンプリングする

格子の中点で実際の変換との差を測り、許容誤差（既定 0.125 画素）を超える区画は格子を細かくする。

### API

色補正と同じく、同期の関数と非同期の処理の 2 本立て。変換はただのオブジェクトなので、保存したり Worker に送ったりできる。

```ts
import { fitTransform, warp, warpImageData, rotate } from 'browser-image-geometry';

// 基準点から変換を推定する（座標は 画像の画素 → 地図座標）
const fit = fitTransform(
  [
    { pixel: [120, 80], world: [139.70, 35.69] },
    { pixel: [1830, 95], world: [139.80, 35.69] },
    { pixel: [1810, 1420], world: [139.80, 35.62] },
    { pixel: [140, 1400], world: [139.70, 35.62] },
  ],
  { model: 'projective' },
);
fit.rms;        // 誤差の二乗平均（地図座標の単位）
fit.residuals;  // 点ごとの残差
fit.transform;  // { type: 'projective', matrix: [...] }（入力画素 → 地図座標）

// 非同期: Worker で並列に変形する（入力は色補正の pipeline.run と同じ種類を受け付ける）
const out = await warp(img, fit.transform, {
  pixelSize: 0.0001,        // 出力の画素サイズ（地図座標の単位）。省略時は入力に近い大きさ
  resample: 'bilinear',
  output: 'canvas',         // 'imageData' | 'canvas' | 'blob'
  signal,
});
out.image;         // 変形後の画像
out.geoTransform;  // [左上x, 画素幅, 0, 左上y, 0, -画素高]
out.extent;        // [minX, minY, maxX, maxY]（OpenLayers の ImageStatic にそのまま渡せる）

// 投影法をまたぐ場合は、変換関数を渡す（proj4 は利用者が用意する）
const toWebMercator = proj4('EPSG:4326', 'EPSG:3857');
await warp(img, fit.transform, { coordinateTransform: (x, y) => toWebMercator.forward([x, y]) });

// 同期: ImageData を受け取り、新しい ImageData を返す（メインスレッドで動く）
const rotated = rotate(imageData, 15, { resample: 'bicubic', expand: true });
const flat = warpImageData(imageData, { type: 'affine', matrix: [1, 0.2, 0, 0, 1, 0] });
```

Worker の設定は色補正と同じ `configureWorkers` / `terminateWorkers` を、このパッケージからも出す。

### 処理方式

- **逆写像**: 出力の各画素について入力画像上の座標を求め、そこを補間して色を取る（順写像だと穴があく）。多項式は逆関数が式で求まらないので、基準点から逆方向の多項式も別に推定する（GDAL と同じ）
- **並列化**: 出力を横帯に分けて Worker に割り当てる（共通パッケージの `splitRows`、`stripCount`）。各帯が参照する入力の範囲（帯の外周を逆写像した外接矩形に、補間に必要な周辺の画素を足したもの）だけをコピーして transfer する。回転などで入力全体が必要になる帯でも、入力全体の 1 コピーで済む
- **色空間**: 補間は sRGB の値のまま行う（地図や写真の変形では一般的で、色補正の結果と組み合わせても差は目立たない）。リニア空間での補間はオプションとして後から足せるようにしておく
- **色補正との組み合わせ**: パッケージ同士は依存しない。色補正してから変形するのが基本（変形後は範囲外の透明部分ができるため）

### マイルストーン

1. 変換モデルと推定（`fitTransform`）、ユニットテスト（既知の変換に対する復元精度、点が足りない・一直線に並ぶ場合のエラー）
2. 同期の再サンプリング（最近傍・バイリニア・バイキュービック）と簡易関数
3. Worker での並列実行（共通パッケージを使用）と、非同期の `warp`
4. 地理参照の出力と、投影法をまたぐ近似格子
5. ルートの `examples/` に、古地図に基準点を打って OpenLayers に重ねる例
6. CDN 用ビルドと npm 公開

## 未決事項（おすすめ）

1. パッケージ名: `browser-image-geometry`（おすすめ、npm で未使用を確認済み、2026-10-01）
2. 最初のリリースの範囲: 上の表のとおり（おすすめ）。Thin Plate Spline は次以降
3. 投影法: proj4 は本体に入れず、座標変換の関数を受け取る（おすすめ）
4. タグの形式: `enhancement-v0.2.0` / `geometry-v0.1.0` のようにパッケージ名を前に付ける（おすすめ）
