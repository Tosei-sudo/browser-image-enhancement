# OpenLayers + COG の例

クラウド最適化 GeoTIFF（COG）を OpenLayers で読み込み、タイルごとに browser-image-enhancement で補正して、OpenStreetMap の上に重ねて表示します。

```sh
npm install
npm run example:ol
```

既定では Sentinel-2 の可視画像（東京周辺、2024-01-12、8bit RGB、CORS 対応の公開 COG）を読み込みます。URL 欄を空にして「読み込む」を押すと、ページ内で作った小さな GeoTIFF を使います（ネットワークなしで動きます。`?fixture` を付けて開いても同じです）。

## 仕組み

[`enhanced-geotiff.ts`](enhanced-geotiff.ts) の `EnhancedGeoTIFF` は `ol/source/GeoTIFF` を継承したソースです。

- COG の読み込み（Range リクエスト、オーバービュー、nodata とマスク、0〜255 への正規化、投影法の変換）は OpenLayers にそのまま任せる
- 読み込んだタイルを RGBA に並べ替えて `pipeline().run()` に渡し、元のバンド構成（グレー、グレー＋α、RGB、RGB＋α）に戻して返す
- 補正前のタイルをキャッシュしておき、スライダーを動かしたときは COG を読み直さずに補正だけやり直す。表示中のタイルは新しいタイルができるまで残るので、ちらつかない
- 色モードはタイルごとに自動判定せず、ソースのバンド数で決める（1〜2 バンドならグレー、3〜4 バンドならカラー）。タイルごとに判定すると、隣り合うタイルで判定が割れて継ぎ目が出ることがあるため

```ts
import WebGLTileLayer from 'ol/layer/WebGLTile.js';
import { pipeline } from 'browser-image-enhancement';
import EnhancedGeoTIFF from './enhanced-geotiff.js';

const source = new EnhancedGeoTIFF({
  sources: [{ url: 'https://example.com/image.tif' }],
  pipeline: pipeline().exposure(0.5).contrast(0.2),
});
map.addLayer(new WebGLTileLayer({ source, opacity: 0.8 }));

// あとから補正を変える
source.setPipeline(pipeline().exposure(1));
```

## 制約

- 8bit の RGB かグレースケールの COG を想定しています。16bit や浮動小数点の COG（Sentinel-2 の各バンドや DEM など）は OpenLayers の `normalize`（GDAL の統計値、なければデータ型の範囲を 0〜255 に引き伸ばす）を通った後の 8bit 値を補正します。引き伸ばしの範囲を自分で決めたい場合は `sources` の `min` / `max` を指定してください
- 5 バンド以上（マルチスペクトル）のタイルは補正せずにそのまま返します
- 補正はタイル単位なので、すべての補正が 1 画素ごとに閉じている今の機能（明るさ、コントラスト、露出、ガンマ、彩度、色温度、レベル）では継ぎ目は出ません。今後入れるぼかし・シャープ（周辺画素を使う）や自動補正（画像全体のヒストグラムを使う）は、タイルの重なりや全体統計の受け渡しが必要になります
