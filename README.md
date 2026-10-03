# browser-image-enhancement

ブラウザだけで動く画像処理ライブラリのモノレポです。

| パッケージ | 内容 | 状態 |
| --- | --- | --- |
| [browser-image-enhancement](packages/browser-image-enhancement/) | 色補正（明るさ、コントラスト、露出、ガンマ、彩度、色温度、レベル補正）。Web Worker で並列処理 | v0.1.0 |
| [browser-image-geometry](packages/browser-image-geometry/) | 幾何補正（アフィン・射影・多項式変換、基準点からの推定、再サンプリング、地図座標の出力）。Web Worker で並列処理 | v0.1.0（npm 未公開、[設計メモ](docs/geometry-design.md)） |
| [@browser-image/workers](packages/workers/) | 上の 2 つが共有する Worker プール、横帯の並列処理、画像の入出力。非公開で、各パッケージのビルドに取り込まれる | 内部用 |

ライブラリを使って作ったサイトのサンプルは [usecase/](usecase/) にあります（[画像ビューア](usecase/image-viewer/): ローカルファイルと COG の URL を開いて補正しながら閲覧）。

使い方は各パッケージの README を、関数や型の詳細は [API リファレンス](https://tosei-sudo.github.io/browser-image-enhancement/) を見てください。

## 開発

```sh
npm install            # すべてのパッケージの依存を入れる（npm workspaces）
npm run lint
npm run typecheck      # 全パッケージ
npm test               # 全パッケージのユニットテスト
npm run build          # 各パッケージの dist/ を作る
npm run test:browser   # Playwright（ブラウザのパスは CHROMIUM_PATH で指定できます）
npm run docs           # API リファレンスを api-docs/ に生成（TypeDoc）
```

API リファレンスはソースの TSDoc コメントから TypeDoc で生成し、既定ブランチへの push で GitHub Pages に公開します。公開している関数・型・プロパティにはドキュメントコメントが必須で、`npm run docs:check`（CI でも実行）が抜けや壊れた `{@link}` を検出します。

各パッケージの `dist/` はコミットしています（GitHub のタグから CDN 配信するため）。ソースを変えたら `npm run build` して `dist/` も一緒にコミットしてください。CI でずれを検出します。

## ライセンス

MIT
