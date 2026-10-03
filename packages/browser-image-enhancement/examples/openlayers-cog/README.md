# OpenLayers + COG の例

クラウド最適化 GeoTIFF（COG）を OpenLayers で読み込み、タイルごとに browser-image-enhancement で補正して、OpenStreetMap の上に重ねて表示します。

```sh
npm install
npm run example:ol
```

既定では Sentinel-2 の可視画像（東京周辺、2024-01-12、8bit RGB、CORS 対応の公開 COG）を読み込みます。URL 欄を空にして「読み込む」を押すと、ページ内で作った小さな GeoTIFF を使います（ネットワークなしで動きます。`?fixture` を付けて開いても同じです）。

## 仕組み

`browser-image-enhancement/openlayers` の `EnhancedGeoTIFF`（[src/openlayers/enhanced-geotiff.ts](../../src/openlayers/enhanced-geotiff.ts)） は `ol/source/GeoTIFF` を継承したソースです。

- COG の読み込み（Range リクエスト、オーバービュー、nodata とマスク、0〜255 への正規化、投影法の変換）は OpenLayers にそのまま任せる
- 読み込んだタイルを RGBA に並べ替えて `pipeline().run()` に渡し、元のバンド構成（グレー、グレー＋α、RGB、RGB＋α）に戻して返す
- 補正前のタイルをキャッシュしておき、スライダーを動かしたときは COG を読み直さずに補正だけやり直す。表示中のタイルは新しいタイルができるまで残るので、ちらつかない
- 色モードはタイルごとに自動判定せず、ソースのバンド数で決める（1〜2 バンドならグレー、3〜4 バンドならカラー）。タイルごとに判定すると、隣り合うタイルで判定が割れて継ぎ目が出ることがあるため

```ts
import WebGLTileLayer from 'ol/layer/WebGLTile.js';
import { pipeline } from 'browser-image-enhancement';
import { EnhancedGeoTIFF } from 'browser-image-enhancement/openlayers';

const source = new EnhancedGeoTIFF({
  sources: [{ url: 'https://example.com/image.tif' }],
  pipeline: pipeline().exposure(0.5).contrast(0.2),
});
map.addLayer(new WebGLTileLayer({ source, opacity: 0.8 }));

// あとから補正を変える
source.setPipeline(pipeline().exposure(1));
```

## GPU（WebGL2）で補正する

画面の「実行」が既定で「GPU（WebGL2）」になっていて、タイルではなく、OpenLayers が描いた地図に GPU で補正を掛けます。スライダーを動かしてもタイルの読み込み直しや補正し直しは起きず、地図を描き直すだけになります。

```ts
import { pipeline } from 'browser-image-enhancement';
import { EnhancedGeoTIFF, GpuCorrectedTileLayer } from 'browser-image-enhancement/openlayers';

const layer = new GpuCorrectedTileLayer();          // WebGL2 が使えなければ layer.hasGpu() が false
const source = new EnhancedGeoTIFF({
  sources: [{ url }],
  pipeline: pipeline().exposure(0.5),
  correctTiles: !layer.hasGpu(),                    // GPU で補正するときはタイルを読んだまま描く
});
layer.setSource(source);
map.addLayer(layer);
source.setPipeline(pipeline().exposure(1));          // 地図を描き直すだけ
```

- `GpuCorrectedTileLayer`（[src/openlayers/gpu-layer.ts](../../src/openlayers/gpu-layer.ts)） は `ol/layer/WebGLTile` を継承したレイヤーです。OpenLayers が補正前のタイルを WebGL の canvas に描いたあと、その canvas を `createGpuRenderer` に渡して（GPU の中でコピー）補正し、結果の canvas を代わりに表示します
- 補正は画面の画素に掛かります。露出・コントラスト・色温度・レベルなど 1 画素ごとの補正は、タイルを補正した場合と同じ結果になります（再サンプリングの前後の違いで 2 階調以内。ブラウザテストで確認）
- DRA の統計は今までどおりソースが元画像から取り、その範囲で補正するので、継ぎ目は出ません
- シャープは画面の画素に掛かります。半径は画面の px になり、どのズームでも同じ見え方になります。元画像の画素で正確にシャープを掛けたいときは「Worker」を選んでください
- 地図を動かしている間も毎フレーム補正します（画面の大きさ 1 枚分）
- WebGL2 が使えないブラウザでは、Worker（JS）でタイルごとに補正します。途中で GPU のコンテキストが失われた場合も同じです
- 画面下に「変更から表示まで」の時間が出ます。URL に `?engine=worker` を付けると JS で始まるので、比べられます

測定（Sentinel-2 の COG、1024 px のタイル 9 枚、1600×1000 の画面。GPU のないサンドボックスで、WebGL は CPU で動く SwiftShader なので比率だけの目安）：

| 方式 | スライダーを動かしてから表示まで |
| --- | --- |
| タイルごとに Worker で補正 | 約 2.6 秒（うち 9 割以上はタイルの読み込み直し） |
| 描画時に GPU で補正 | 約 0.14 秒（シャープありで約 0.23 秒） |

## DRA（表示範囲でダイナミックレンジを自動調整）

画面の「DRA」をオンにすると、いま見えている範囲の画素の分布から黒点・白点を決めて引き伸ばします。地図を動かし終えるたびに（`moveend`）範囲を取り直します。

```ts
const source = new EnhancedGeoTIFF({
  sources: [{ url }],
  pipeline: pipeline().autoStretch({ method: 'percentClip', lowPercent: 0.5, highPercent: 0.5 }),
});
map.on('moveend', () => source.updateDra(map));
```

- 統計はタイルごとではなく表示範囲全体で 1 回だけ取り、その範囲をすべてのタイルに掛けるので、タイルの継ぎ目は出ません
- 表示範囲がおよそ 1024 画素四方になるオーバービューから読みます（`draSampleSize`、`draMaxTiles` で調整）。広い範囲を見ていても読み込み量は増えません
- 画像の外側と nodata（OpenLayers が透明にした画素）は数えません
- 範囲が前回と変わらなければタイルは補正し直しません。補正前のタイルはキャッシュから使うので、COG を読み直すこともありません
- 統計は OpenLayers が 0〜255 に正規化した後の値で取ります。16bit の COG で実際の値の幅がデータ型の範囲よりずっと狭いと、正規化の段階で階調が粗くなります

## 制約

- 8bit の RGB かグレースケールの COG を想定しています。16bit や浮動小数点の COG（Sentinel-2 の各バンドや DEM など）は OpenLayers の `normalize`（GDAL の統計値、なければデータ型の範囲を 0〜255 に引き伸ばす）を通った後の 8bit 値を補正します。引き伸ばしの範囲を自分で決めたい場合は `sources` の `min` / `max` を指定してください
- 5 バンド以上（マルチスペクトル）のタイルは補正せずにそのまま返します
- 補正はタイル単位です。1 画素ごとに閉じている補正（明るさ、コントラスト、露出、ガンマ、彩度、色温度、レベル）では継ぎ目は出ません。DRA（画像全体の分布を使う）は上のとおり表示範囲全体の統計を先に取ってから全タイルに同じ範囲を掛けます
- シャープは周りの画素を使うので、タイルの周りに `pipeline.margin` px（半径 1 なら 3 px）だけ隣のタイルの画素を付けて補正し、中央を切り出します。隣のタイルは補正前タイルのキャッシュから読み、画像の外側は透明で埋めます。こうするとタイルの境目の画素は、そのズームレベルの画像全体を一度に補正した場合と同じになります（[src/openlayers/margin.ts](../../src/openlayers/margin.ts)、ユニットテストで確認）。そのぶん、シャープを掛けている間は画面外の隣のタイルも読み込みます
