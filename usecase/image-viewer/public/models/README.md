# サンプルの AI モデル

画像ビューアの「ツール」→「AI」に既定で並ぶモデルです。`config.json` に `aiModels` を書くと、そちらに置き換わります。
ビルドに入るので、閉域網でもそのまま動きます。ライセンス本文は同じフォルダの LICENSE-*.txt にあります。

| ファイル | モデル | ライセンス | 出典 | 変更 |
| --- | --- | --- | --- | --- |
| yolo11s-obb.onnx | YOLO11s-OBB（DOTA v1 の 15 クラスを回転矩形で。入力 1024×1024） | **AGPL-3.0** | [Ultralytics](https://github.com/ultralytics/ultralytics) の yolo11s-obb.pt（assets v8.3.0） | `yolo export format=onnx imgsz=1024 opset=17 simplify=True`（ultralytics 8.4）で ONNX に書き出し |
| yolox_tiny.onnx | YOLOX-Tiny（COCO の 80 クラス、入力 416×416） | Apache-2.0 | [Megvii-BaseDetection/YOLOX](https://github.com/Megvii-BaseDetection/YOLOX) の Release 0.1.1rc0 の ONNX | なし |
| mobile_sam_encoder.onnx, mobile_sam_decoder.onnx | MobileSAM（Segment Anything の軽量版） | Apache-2.0 | [ChaoningZhang/MobileSAM](https://github.com/ChaoningZhang/MobileSAM) の weights/mobile_sam.pt | `scripts/export-mobile-sam.py` で ONNX に書き出し（デコーダーは重みを 8 ビットに量子化） |

- **YOLO11s-OBB** は DOTA（航空写真・衛星画像）で学習したモデルです。クラスは plane・ship・storage tank・baseball diamond・tennis court・basketball court・ground track field・harbor・bridge・large vehicle・small vehicle・helicopter・roundabout・soccer ball field・swimming pool です。
  AGPL-3.0 なので、研究や組織内での利用には問題ありません。このモデルを入れたままビューアを社外に配布したり、社外向けのサービスとして公開したりするときは、AGPL に従ってソースを開示するか、Ultralytics の商用ライセンスを取ってください。
  外すときは、このファイルを消し、`config.json` の `aiModels` に使うモデルだけを書きます。
- **YOLOX-Tiny** は COCO（地上で撮った写真）で学習したモデルなので、衛星画像向けではありません。
