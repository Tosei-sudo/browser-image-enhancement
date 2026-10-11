"""
Exports MobileSAM (https://github.com/ChaoningZhang/MobileSAM, Apache-2.0) to
the two ONNX files the image viewer's 「クリックで抽出」 runs
(public/models/mobile_sam_encoder.onnx and mobile_sam_decoder.onnx).

- encoder: the TinyViT image encoder. Input `images` [1, 3, 1024, 1024], the
  picture scaled so its longer side is 1024, normalized with SAM's mean and
  std, padded at the right and bottom; output `image_embeddings` [1, 256, 64, 64].
- decoder: segment-anything's prompt decoder as its `export_onnx_model.py`
  writes it (point_coords, point_labels, mask_input, has_mask_input,
  orig_im_size → masks, iou_predictions, low_res_masks), single mask, its
  weights quantized to 8 bits (16 MB → 5 MB, the same masks).

Usage (needs torch, timm, onnx and onnxruntime):
  python3 export-mobile-sam.py <MobileSAM checkout> <mobile_sam.pt> <out dir>
"""

import os
import sys
import warnings

import torch

repo, weights, out = sys.argv[1:4]
sys.path.insert(0, repo)
from mobile_sam import sam_model_registry  # noqa: E402
from mobile_sam.utils.onnx import SamOnnxModel  # noqa: E402

sam = sam_model_registry["vit_t"](checkpoint=weights).eval()
warnings.filterwarnings("ignore")


class Encoder(torch.nn.Module):
    def __init__(self, sam):
        super().__init__()
        self.encoder = sam.image_encoder

    def forward(self, images):
        return self.encoder(images)


with torch.no_grad():
    torch.onnx.export(
        Encoder(sam),
        torch.randn(1, 3, 1024, 1024),
        f"{out}/mobile_sam_encoder.onnx",
        input_names=["images"],
        output_names=["image_embeddings"],
        opset_version=17,
        do_constant_folding=True,
        dynamo=False,
    )

    decoder = SamOnnxModel(sam, return_single_mask=True)
    embed_dim = sam.prompt_encoder.embed_dim
    embed_size = sam.prompt_encoder.image_embedding_size
    inputs = {
        "image_embeddings": torch.randn(1, embed_dim, *embed_size),
        "point_coords": torch.randint(0, 1024, (1, 5, 2), dtype=torch.float),
        "point_labels": torch.randint(0, 4, (1, 5), dtype=torch.float),
        "mask_input": torch.randn(1, 1, 4 * embed_size[0], 4 * embed_size[1]),
        "has_mask_input": torch.tensor([1], dtype=torch.float),
        "orig_im_size": torch.tensor([1500, 2250], dtype=torch.float),
    }
    torch.onnx.export(
        decoder,
        tuple(inputs.values()),
        f"{out}/mobile_sam_decoder.onnx",
        input_names=list(inputs.keys()),
        output_names=["masks", "iou_predictions", "low_res_masks"],
        dynamic_axes={"point_coords": {1: "num_points"}, "point_labels": {1: "num_points"}},
        opset_version=17,
        do_constant_folding=True,
        dynamo=False,
    )
from onnxruntime.quantization import QuantType, quantize_dynamic  # noqa: E402

quantize_dynamic(f"{out}/mobile_sam_decoder.onnx", f"{out}/mobile_sam_decoder.q.onnx", weight_type=QuantType.QUInt8)
os.replace(f"{out}/mobile_sam_decoder.q.onnx", f"{out}/mobile_sam_decoder.onnx")
print("exported to", out)
