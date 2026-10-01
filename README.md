# browser-image-enhancement

ブラウザ上で動く画像補正ライブラリ。サーバーに画像を送らず、クライアント側だけで明るさ・色・シャープネスなどの補正を行うことを目指す。

> このドキュメントは実装前の設計メモです。決まっていない点は「未決事項」に残しています。

## 目標と非目標

**目標**

- 依存ライブラリなしで、モダンブラウザ（Chrome / Edge / Firefox / Safari の最新2バージョン）で動く
- `HTMLImageElement` / `HTMLCanvasElement` / `ImageBitmap` / `ImageData` / `Blob` を入力として受け付ける
- 補正を複数つなげても、画質劣化（中間での 8bit 丸め）と処理時間を抑える
- Web Worker 上でも動く（メインスレッドを止めない）
- TypeScript の型定義付き、ESM で配布、tree-shaking 可能

**非目標（当面やらない）**

- レイヤーやマスクを持つ画像編集ソフト的な機能
- RAW 現像、HDR、16bit 以上の出力
- 機械学習ベースの超解像やノイズ除去（将来の拡張候補として未決事項に記載）
- Node.js 単体での実行

## API の形

関数型とパイプライン型の両方を提供し、内部は同じ実装を共有する。

### 1. 関数型（単発の補正向け）

```ts
import { brightness, contrast } from 'browser-image-enhancement';

const out: ImageData = contrast(brightness(imageData, 0.1), 0.2);
```

- 各関数は `ImageData` を受け取り、新しい `ImageData` を返す（入力は変更しない）
- 一番小さな単位で、テストしやすく tree-shaking も効く
- 連続して呼ぶと補正ごとに 8bit へ丸められる点はドキュメントで明示する

### 2. パイプライン型（複数補正・プレビュー向け）

```ts
import { pipeline } from 'browser-image-enhancement';

const p = pipeline()
  .brightness(0.1)
  .contrast(0.2)
  .saturation(-0.1)
  .sharpen({ amount: 0.5, radius: 1 });

const canvas = await p.run(img, { output: 'canvas' });
const blob = await p.run(img, { output: 'blob', type: 'image/webp', quality: 0.9 });
```

- 補正の列を宣言的に保持し、`run` のときにまとめて実行する
- 色補正（点処理）は連続していれば 1 パスに融合し、中間で丸めない
- パラメータだけ変えて再実行できるので、スライダーでのプレビューに向く
- `p.toJSON()` / `pipeline.fromJSON()` で設定を保存・復元できる

### パラメータの規約

- 量を表す値は原則 `-1〜1`（0 で無変化）に正規化する。例外（ガンマ、半径など）は単位を型と JSDoc に書く
- 不正値は例外ではなく範囲内に丸め、開発ビルドでのみ警告する

## 処理方式

| 方式 | 長所 | 短所 | 用途 |
| --- | --- | --- | --- |
| Canvas 2D + JS ループ | どこでも動く、実装が簡単、結果が決定的 | 大きな画像で遅い | 基準実装・フォールバック・テストの正解値 |
| WebGL2 | 速い、点処理もフィルタも得意 | コンテキスト数の制限、精度差、Worker では OffscreenCanvas 必須 | 既定の高速バックエンド |
| WASM (SIMD) | CPU で速い、結果が決定的 | ビルドが複雑、配布サイズ増 | 将来の候補 |
| WebGPU | 最も柔軟で速い | 対応ブラウザがまだ限定的 | 将来の候補 |

**方針**: まず JS 実装を「正解」として作り、その上で WebGL2 バックエンドを追加する。バックエンドは `run(img, { backend: 'auto' | 'js' | 'webgl' })` で選べ、`auto` は WebGL2 が使えれば WebGL2、使えなければ JS。両バックエンドの出力差はテストで許容誤差（各チャンネル ±1 程度）内に収める。

### 色空間

- 色補正はリニア RGB で計算する（sRGB のまま計算すると明るさやぼかしで色が濁るため）。sRGB ↔ リニア変換は 256 要素の LUT で行う
- 内部表現は `Float32Array`（JS）／浮動小数テクスチャ（WebGL2）とし、最後に一度だけ 8bit に戻す
- 入出力は sRGB 前提。Display P3 などの広色域対応は未決事項

## 補正の一覧と優先度

### 第1段階：点処理（ピクセル単位、1パスに融合可能）

- 明るさ（brightness）
- コントラスト（contrast）
- 露出（exposure、EV 単位）
- ガンマ（gamma）
- 彩度（saturation）／自然な彩度（vibrance）
- 色温度・色かぶり（temperature / tint）
- レベル補正（levels: 黒点・白点・中間）
- トーンカーブ（curves: 制御点からスプライン補間して LUT 化）
- グレースケール、セピア、反転

### 第2段階：近傍処理（畳み込み）

- ぼかし（ガウシアン、分離可能フィルタで実装）
- シャープ（アンシャープマスク）
- ノイズ除去（メディアン、バイラテラル）

### 第3段階：画像全体を見る処理

- ヒストグラム取得（UI 表示用にも公開）
- 自動レベル・自動コントラスト（ヒストグラムの両端をクリップ）
- 自動ホワイトバランス（グレーワールド仮定）
- ヒストグラム平坦化／CLAHE

### 範囲外だが関連する補助機能

- リサイズ（補正前の縮小プレビュー用）
- EXIF の回転情報の反映（`createImageBitmap` の `imageOrientation` を使う）

## 性能の目安

- 12MP（4000×3000）画像に第1段階の補正を 5 個かけて、WebGL2 で 50ms 以内、JS で 1 秒以内
- プレビュー用途では縮小画像で処理し、確定時のみ原寸で処理する運用をドキュメントで推奨する

## 開発環境（予定）

- TypeScript、Vite（ライブラリモード）でビルド、ESM + 型定義を出力
- Vitest でユニットテスト（JS バックエンドは jsdom 不要の純粋関数としてテスト）
- WebGL2 バックエンドは Playwright でブラウザ上の結果を JS 実装と比較
- `demo/` にスライダーで補正を試せるデモページ
- GitHub Actions で lint・型チェック・テストを実行

## ディレクトリ構成（予定）

```
src/
  index.ts            公開 API
  pipeline.ts         パイプライン本体と融合処理
  io.ts               入力の正規化（Image/Canvas/Blob → ImageData）と出力
  color/              sRGB↔リニア変換、LUT
  ops/                補正ごとの定義（パラメータ型、JS 実装、GLSL 断片）
  backends/js/
  backends/webgl/
demo/
test/
```

## 進め方（マイルストーン）

1. 雛形（ビルド・テスト・CI）
2. 関数型 API と第1段階の点処理（JS 実装）＋デモ
3. パイプライン API と点処理の融合
4. WebGL2 バックエンド
5. 第2段階（ぼかし・シャープ）
6. 第3段階（ヒストグラム・自動補正）
7. npm 公開

## 未決事項

- パッケージ名（npm 上で空いているか確認が必要）
- 第1段階の補正のうち、最初のリリースに含める範囲
- 広色域（Display P3）への対応
- WASM / WebGPU バックエンドに進むかどうか
- 機械学習ベースの補正（ONNX Runtime Web など）を別パッケージで扱うかどうか
- ライセンス（MIT を想定）
