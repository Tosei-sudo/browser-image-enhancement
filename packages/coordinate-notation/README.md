# coordinate-notation

人が書いたままの座標文字列を読んで、WGS 84 の経度・緯度 `[lon, lat]` にするライブラリです。逆に、経度・緯度を緯度経度・MGRS・UTM の文字列に書き出せます。画像ビューワーの「座標へ移動」で使っているパーサーを切り出したものです。

- 10 進度と度分秒: `35.6812, 139.7671`、`35°40'52.3"N 139°46'1.6"E`、`35 40 52.3 139 46 1.6`、`35d40m52s N …`
- 日本語表記: `北緯35度40分52秒 東経139度46分1秒`、`緯度 35.68 経度 139.76`、全角数字や「、」「，」
- 区切りなしの度分秒: `354052N 1394601E`
- ラベル付き: `lat 35.68 lon 139.76`、`Lng: 139.76, Lat: 35.68`
- WKT: `POINT(139.76 35.68)`（経度が先）
- MGRS: `54SUE8843349290`、`54S UE 88433 49290`（桁数は任意の偶数）
- UTM: `54N 386543 3950123`（ゾーン、N/S、東距、北距。`mE`/`mN` 付きも可）

N/S/E/W やラベルがないときは緯度が先です。ただし最初の値だけが経度としてしか読めない場合（`139.76, 35.68`）は経度が先と判断します。どの表記でもなければ `null` を返します。

依存は MGRS 変換の [mgrs](https://www.npmjs.com/package/mgrs) だけです。UTM は自前の横メルカトル（Krüger 級数 6 次、proj4 との差 1 mm 未満）で計算するので proj4 は不要です。npm にはまだ公開していません。

## 使い方

```ts
import { parseCoordinate, formatLatLon, formatMgrs, formatUtm } from 'coordinate-notation';

parseCoordinate('北緯35度40分52.32秒 東経139度46分1.56秒'); // [139.7671, 35.6812]
parseCoordinate('54S UE 88433 49290');                       // [139.767…, 35.681…]
parseCoordinate('hello');                                     // null

formatLatLon([139.7671, 35.6812]); // '35.681200, 139.767100'
formatMgrs([139.7671, 35.6812]);   // '54S UE 88433 49290'
formatUtm([139.7671, 35.6812]);    // '54N 388433 3949290'
```

`utmZone(lonLat)` は点の UTM ゾーン番号（ノルウェー・スバールバルの例外込み）、`utmEpsg(zone, north)` はその EPSG コード（`EPSG:32654` など）を返します。

## CDN から 1 ファイルで使う

`dist/cdn/` に mgrs まで含めた単体ファイル（約 10 KB、gzip 約 5 KB）があります。

```html
<!-- <script> タグ: グローバル CoordinateNotation -->
<script src="https://cdn.jsdelivr.net/gh/Tosei-sudo/browser-image-enhancement@<tag>/packages/coordinate-notation/dist/cdn/coordinate-notation.iife.min.js"></script>
<script>
  CoordinateNotation.parseCoordinate('35°40′52″N 139°46′01″E');
</script>

<!-- ES モジュール -->
<script type="module">
  import { parseCoordinate } from 'https://cdn.jsdelivr.net/gh/Tosei-sudo/browser-image-enhancement@<tag>/packages/coordinate-notation/dist/cdn/coordinate-notation.min.js';
</script>
```

`<tag>` はリポジトリのタグ（またはコミット）です。npm に公開した後は `https://cdn.jsdelivr.net/npm/coordinate-notation` でも同じ IIFE ファイルが返ります。

## ビルド

```sh
npm run build -w coordinate-notation   # dist/index.js（npm 用）と dist/cdn/*（CDN 用）
npm test -w coordinate-notation
```
