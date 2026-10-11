/**
 * One tile of object detection: the model run over a tile of an RGBA picture
 * and its output decoded into objects in the picture's pixels. Used by the
 * detection workers (detect-worker.ts).
 */
import { decodeDetectron2, decodeYolo, detectron2Outputs, instanceMask, nms, offset, ringArea, tileTensor, type Detection, type Output } from './detect.js';
import { maskOutline } from './mask-outline.js';
import type { DetectorSpec } from './model-config.js';
import { tensor, type LoadedModel } from './runtime.js';

/** The objects in the tile at (`x0`, `y0`), in the picture's pixels (instance outlines traced from their masks). */
export async function detectTile(
  model: LoadedModel,
  input: string,
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  x0: number,
  y0: number,
  spec: DetectorSpec,
): Promise<Detection[]> {
  const [tw, th] = spec.inputSize;
  const feed = await tensor(tileTensor(rgba, width, height, x0, y0, spec.inputSize, spec.mean, spec.std, spec.bgr), spec.unbatched ? [3, th, tw] : [1, 3, th, tw]);
  const outputs = await model.session.run({ [input]: feed });
  const names = model.session.outputNames;
  const protos = spec.task === 'segment' ? outputs[names.find((n) => outputs[n].dims.length === 4) ?? names[1]] : undefined;
  const read = async (name: string): Promise<Output> => ({ dims: outputs[name].dims, data: (await outputs[name].getData()) as ArrayLike<number> });
  try {
    let found: Detection[];
    if (spec.format === 'detectron2') {
      // Boxes, scores and classes apart, after the model's own NMS (the tiles' overlaps are merged later).
      const parts = detectron2Outputs(names.map((name) => ({ name, type: outputs[name].type, dims: outputs[name].dims })));
      if (!parts) throw new Error('Detectron2 の出力（boxes [N, 4]・scores [N]・classes [N]）が見つかりません');
      found = decodeDetectron2(await read(parts.boxes.name), await read(parts.scores.name), await read(parts.classes.name), spec.score);
    } else found = nms(decodeYolo(await read(names[0]), spec, spec.score), spec.iou);
    if (protos) {
      const p = { dims: protos.dims, data: (await protos.getData()) as Float32Array };
      found = found.flatMap((d) => {
        const m = instanceMask(d, p, spec.inputSize);
        if (!m) return [];
        const polygons = maskOutline(m.mask, m.width, m.height);
        if (!polygons.length) return [];
        // The largest part is the object; specks around it are left out.
        const largest = polygons.reduce((a, b) => (Math.abs(ringArea(b[0])) > Math.abs(ringArea(a[0])) ? b : a));
        return [{ ...d, coeffs: undefined, outline: largest.map((ring) => ring.map(([x, y]): [number, number] => [x + m.x0, y + m.y0])) }];
      });
    }
    // What is centred outside the picture (the padding, transparent no-data) is dropped; the rest moves into the picture.
    return found
      .filter((d) => {
        const x = Math.floor(d.box[0] + x0);
        const y = Math.floor(d.box[1] + y0);
        return x >= 0 && y >= 0 && x < width && y < height && rgba[(y * width + x) * 4 + 3] !== 0;
      })
      .map((d) => offset(d, x0, y0));
  } finally {
    feed.dispose();
    for (const n of names) outputs[n].dispose();
  }
}
