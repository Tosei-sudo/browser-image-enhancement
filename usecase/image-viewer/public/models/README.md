# サンプルの AI モデル

画像ビューアの「ツール」→「AI」に既定で並ぶモデルです。`config.json` に `aiModels` を書くと、そちらに置き換わります。
どちらも Apache License 2.0 で、商用でも使えます（ライセンス本文は同じフォルダの LICENSE-*.txt）。
ビルドに入るので、閉域網でもそのまま動きます。

| ファイル | モデル | 出典 | 変更 |
| --- | --- | --- | --- |
| yolox_tiny.onnx | YOLOX-Tiny（COCO の 80 クラス、入力 416×416） | [Megvii-BaseDetection/YOLOX](https://github.com/Megvii-BaseDetection/YOLOX) の Release 0.1.1rc0 の ONNX | なし |
| mobile_sam_encoder.onnx, mobile_sam_decoder.onnx | MobileSAM（Segment Anything の軽量版） | [ChaoningZhang/MobileSAM](https://github.com/ChaoningZhang/MobileSAM) の weights/mobile_sam.pt | `scripts/export-mobile-sam.py` で ONNX に書き出し（デコーダーは重みを 8 ビットに量子化） |

YOLOX-Tiny は COCO（地上で撮った写真）で学習したモデルです。車・トラック・船・飛行機などは航空写真でも拾えることがありますが、
衛星画像向けではありません。目的に合わせて学習したモデルを `aiModels` に登録してください。

Ultralytics の YOLOv5・v8・v11 などの公式の重みは AGPL-3.0 のため、ここには入れていません。
