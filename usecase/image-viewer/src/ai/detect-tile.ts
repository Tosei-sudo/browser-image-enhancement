/**
 * One tile of object detection: the model run over a tile of an RGBA picture
 * and its output decoded into objects in the picture's pixels. Used by the
 * detection workers (detect-worker.ts).
 */
import { decodeDetectron2, decodeYolo, detectron2Outputs, instanceMask, nms, offset, ringArea, tileTensor, type Detection, type Output } from './detect.js';
import { maskOutline } from './mask-outline.js';
import type { DetectorSpec } from './model-config.js';
import { tensor, type LoadedModel } from './runtime.js';

/** How many times a tile that reaches the model's limit of objects is split again into quarters. */
const SPLITS = 2;

/**
 * The objects in the tile at (`x0`, `y0`), in the picture's pixels (instance
 * outlines traced from their masks). When the model gives as many objects as
 * it can (`spec.maxDetections`), more may have been left out: the tile is
 * analysed again as four overlapping quarters, each alone in an input of the
 * same size (the same scale, a quarter of the objects), up to {@link SPLITS}
 * times; the quarters' overlaps are merged with the tiles'.
 */
export async function detectTile(
  model: LoadedModel,
  input: string,
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  x0: number,
  y0: number,
  spec: DetectorSpec,
  depth = 0,
  region: readonly [number, number] = spec.inputSize,
): Promise<Detection[]> {
  const { found, full } = await runTile(model, input, rgba, width, height, x0, y0, spec);
  if (!full || depth >= SPLITS) return found;
  const [tw, th] = spec.inputSize;
  // Each quarter is a bit more than half the part analysed, so an object on the middle lines is whole in one of them.
  const [qw, qh] = [Math.ceil(region[0] * 0.6), Math.ceil(region[1] * 0.6)];
  const out: Detection[] = [];
  for (const sy of [0, region[1] - qh]) {
    for (const sx of [0, region[0] - qw]) {
      // The quarter alone at the corner of an input-size picture, the rest transparent (padding).
      const piece = new Uint8ClampedArray(tw * th * 4);
      for (let y = 0; y < qh; y++) {
        const py = y0 + sy + y;
        if (py < 0 || py >= height) continue;
        for (let x = 0; x < qw; x++) {
          const px = x0 + sx + x;
          if (px < 0 || px >= width) continue;
          for (let c = 0; c < 4; c++) piece[(y * tw + x) * 4 + c] = rgba[(py * width + px) * 4 + c];
        }
      }
      const inPiece = await detectTile(model, input, piece, tw, th, 0, 0, spec, depth + 1, [qw, qh]);
      out.push(...inPiece.map((d) => offset(d, x0 + sx, y0 + sy)));
    }
  }
  return out;
}

/** One run of the model over the tile at (`x0`, `y0`); `full` when it gave as many objects as it can. */
async function runTile(
  model: LoadedModel,
  input: string,
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  x0: number,
  y0: number,
  spec: DetectorSpec,
): Promise<{ found: Detection[]; full: boolean }> {
  const [tw, th] = spec.inputSize;
  const feed = await tensor(tileTensor(rgba, width, height, x0, y0, spec.inputSize, spec.mean, spec.std, spec.bgr), spec.unbatched ? [3, th, tw] : [1, 3, th, tw]);
  const outputs = await model.session.run({ [input]: feed });
  const names = model.session.outputNames;
  const protos = spec.task === 'segment' ? outputs[names.find((n) => outputs[n].dims.length === 4) ?? names[1]] : undefined;
  const read = async (name: string): Promise<Output> => ({ dims: outputs[name].dims, data: (await outputs[name].getData()) as ArrayLike<number> });
  try {
    let found: Detection[];
    let full = false;
    if (spec.format === 'detectron2') {
      // Boxes, scores and classes apart, after the model's own NMS (the tiles' overlaps are merged later).
      const parts = detectron2Outputs(names.map((name) => ({ name, type: outputs[name].type, dims: outputs[name].dims })));
      if (!parts) throw new Error('Detectron2 の出力（boxes [N, 4]・scores [N]・classes [N]）なし');
      found = decodeDetectron2(await read(parts.boxes.name), await read(parts.scores.name), await read(parts.classes.name), spec.score);
      full = spec.maxDetections > 0 && outputs[parts.scores.name].dims[0] >= spec.maxDetections;
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
    found = found
      .filter((d) => {
        const x = Math.floor(d.box[0] + x0);
        const y = Math.floor(d.box[1] + y0);
        return x >= 0 && y >= 0 && x < width && y < height && rgba[(y * width + x) * 4 + 3] !== 0;
      })
      .map((d) => offset(d, x0, y0));
    return { found, full };
  } finally {
    feed.dispose();
    for (const n of names) outputs[n].dispose();
  }
}
