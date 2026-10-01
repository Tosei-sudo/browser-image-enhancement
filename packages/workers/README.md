# @browser-image/workers（内部用）

このリポジトリのパッケージが共有する Web Worker の仕組みです。npm には公開せず、各パッケージのビルド（tsdown）で `dist/` に取り込まれます。

- `WorkerPool` / `createSharedPool`: Worker の遅延起動、起動できないときのメインスレッドへのフォールバック、要求と応答の対応付け
- `splitRows` / `stripCount` / `yieldToEventLoop`: 画像を横帯に分けて並列処理するための補助
- `abortError` / `race` / `throwIfAborted`: `AbortSignal` の扱い
- `crossOriginWorkerUrl`: CDN など別オリジンの Worker スクリプトを `blob:` 経由で起動する
- `serveWorker`: Worker 側の起動処理

メッセージの型と Worker の中身は各パッケージが決めます。考え方は [docs/geometry-design.md](../../docs/geometry-design.md) を参照してください。
