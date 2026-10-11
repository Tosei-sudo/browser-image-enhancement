/**
 * AI models brought in from outside (trained elsewhere, exported to ONNX):
 * what `config.json`'s `aiModels` says of them, and what an Ultralytics
 * export says of itself in its metadata (class names, input size, task), so
 * a YOLO model chosen as a file needs no settings at all.
 *
 * Two kinds of model:
 * - detection: one ONNX file (YOLOv5 / v8 / v11 and later, end-to-end
 *   exports, rotated boxes (OBB) and instance segmentation, YOLOX's raw
 *   grid output, and R-CNN style outputs of boxes, scores and classes apart,
 *   as Detectron2's ONNX export writes them), run over the view in tiles;
 * - click segmentation: a Segment Anything (SAM, MobileSAM, EfficientSAM…)
 *   image encoder and prompt decoder, as exported by segment-anything's
 *   `export_onnx_model.py`.
 */

/** What a detection model finds. */
export type DetectTask = 'detect' | 'obb' | 'segment';
/**
 * How a detection model's outputs are laid out (`auto`: from their shapes).
 * `detectron2`: boxes `[N, 4]` (x1, y1, x2, y2 in input pixels), scores `[N]`
 * and classes `[N]` as separate outputs, after the model's own NMS
 * (Detectron2's `export_model.py --format onnx --export-method tracing`, and
 * torchvision's detection models); its input is one image, `[3, H, W]` or
 * `[1, 3, H, W]`, of 0–255 B, G, R (the model normalizes it itself).
 */
export type DetectFormat = 'auto' | 'yolov8' | 'yolov5' | 'end2end' | 'yolox' | 'detectron2';

/** The formats `config.json` may name. */
export const DETECT_FORMATS: readonly DetectFormat[] = ['auto', 'yolov8', 'yolov5', 'end2end', 'yolox', 'detectron2'];

/** The 80 classes of COCO, which most published detection weights were trained on (`"classes": "coco"`). */
export const COCO_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light',
  'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
  'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
  'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle',
  'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange',
  'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch', 'potted plant', 'bed',
  'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone', 'microwave', 'oven',
  'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush',
];

/** A detection model of `config.json`. */
export interface DetectModelConfig {
  kind: 'detect';
  /** Shown in the model choice. */
  label: string;
  url: string;
  /** Taken from the model's metadata when absent. */
  task?: DetectTask;
  /** The model's input, width and height (from its metadata, else 640 × 640; Detectron2: 800 × 800). */
  inputSize?: [number, number];
  /** Class names by index (from its metadata, else `class 0`, `class 1`…). */
  classes?: string[];
  /** Per channel (R, G, B, in 0–255): the input is (value − mean) / std. Default: 0 and 255 (YOLO's 0–1); YOLOX, Detectron2: 0 and 1. */
  mean?: [number, number, number];
  std?: [number, number, number];
  /** The channel order of the input (default: rgb; YOLOX, Detectron2: bgr). */
  channels?: 'rgb' | 'bgr';
  format?: DetectFormat;
  /** YOLOX: the strides of its output grids (default 8, 16, 32). */
  strides?: number[];
  /**
   * The most objects the model gives for one input (Detectron2: its
   * TEST.DETECTIONS_PER_IMAGE, 100 unless changed at export; 0: no limit).
   * A tile that reaches it is analysed again in quarters, so crowded
   * places are not cut short.
   */
  maxDetections?: number;
  /** Default score threshold (0–1). */
  score?: number;
  /** Default overlap (IoU) above which the weaker of two boxes of a class is dropped. */
  iou?: number;
}

/** A click-segmentation model (encoder and decoder) of `config.json`. */
export interface SamModelConfig {
  kind: 'sam';
  label: string;
  encoder: string;
  decoder: string;
  /** The encoder's input side (default 1024). */
  inputSize?: number;
  mean?: [number, number, number];
  std?: [number, number, number];
}

export type AiModelConfig = DetectModelConfig | SamModelConfig;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isUrl = (url: unknown): url is string => typeof url === 'string' && /^(https?:)?\/\/|^\.{0,2}\/|^[\w-][\w./-]*\.onnx(\?.*)?$/i.test(url);
const isTriple = (value: unknown): value is [number, number, number] =>
  Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' && Number.isFinite(v));
const isFraction = (value: unknown): value is number => typeof value === 'number' && value > 0 && value < 1;

/** One `aiModels` entry; null (with the reason in `problems`) when it cannot be used. */
export function aiModelOf(value: unknown, problems: string[], index: number): AiModelConfig | null {
  const at = `aiModels[${index}]`;
  if (!isRecord(value)) return (problems.push(`${at} がオブジェクトではありません`), null);
  const label = typeof value.label === 'string' && value.label ? value.label : `モデル ${index + 1}`;
  const normalize: Partial<Pick<DetectModelConfig, 'mean' | 'std'>> = {};
  for (const key of ['mean', 'std'] as const) {
    if (value[key] === undefined) continue;
    if (isTriple(value[key]) && (key === 'mean' || (value[key] as number[]).every((v) => v !== 0))) normalize[key] = value[key] as [number, number, number];
    else problems.push(`${at} の ${key} は R・G・B の 3 つの数にしてください`);
  }

  if (value.encoder !== undefined || value.decoder !== undefined || value.task === 'sam') {
    if (!isUrl(value.encoder) || !isUrl(value.decoder)) return (problems.push(`${at} の encoder と decoder に ONNX の URL を書いてください`), null);
    const size = value.inputSize;
    return {
      kind: 'sam',
      label,
      encoder: value.encoder,
      decoder: value.decoder,
      ...(typeof size === 'number' && Number.isInteger(size) && size >= 32 && size <= 4096 ? { inputSize: size } : {}),
      ...normalize,
    };
  }

  if (!isUrl(value.url)) return (problems.push(`${at} の url に ONNX の URL を書いてください`), null);
  const model: DetectModelConfig = { kind: 'detect', label, url: value.url, ...normalize };
  if (value.task !== undefined) {
    if (value.task === 'detect' || value.task === 'obb' || value.task === 'segment') model.task = value.task;
    else problems.push(`${at} の task は detect・obb・segment・sam のどれかにしてください`);
  }
  if (value.inputSize !== undefined) {
    const size = typeof value.inputSize === 'number' ? [value.inputSize, value.inputSize] : value.inputSize;
    if (Array.isArray(size) && size.length === 2 && size.every((s) => Number.isInteger(s) && s >= 16 && s <= 4096)) model.inputSize = [size[0], size[1]];
    else problems.push(`${at} の inputSize は 640 か [幅, 高さ] にしてください`);
  }
  if (value.classes !== undefined) {
    if (value.classes === 'coco') model.classes = [...COCO_CLASSES];
    else if (Array.isArray(value.classes) && value.classes.every((c) => typeof c === 'string')) model.classes = value.classes as string[];
    else problems.push(`${at} の classes はクラス名の配列か "coco" にしてください`);
  }
  if (value.format !== undefined) {
    if (DETECT_FORMATS.includes(value.format as DetectFormat)) model.format = value.format as DetectFormat;
    else problems.push(`${at} の format は ${DETECT_FORMATS.join('・')} のどれかにしてください`);
  }
  if (value.channels !== undefined) {
    if (value.channels === 'rgb' || value.channels === 'bgr') model.channels = value.channels;
    else problems.push(`${at} の channels は rgb か bgr にしてください`);
  }
  if (value.maxDetections !== undefined) {
    if (Number.isInteger(value.maxDetections) && (value.maxDetections as number) >= 0) model.maxDetections = value.maxDetections as number;
    else problems.push(`${at} の maxDetections は 0 以上の整数にしてください（0: 上限なし）`);
  }
  if (value.strides !== undefined) {
    if (Array.isArray(value.strides) && value.strides.length > 0 && value.strides.every((n) => Number.isInteger(n) && n > 0)) model.strides = value.strides as number[];
    else problems.push(`${at} の strides は [8, 16, 32] のような正の整数の配列にしてください`);
  }
  for (const key of ['score', 'iou'] as const) {
    if (value[key] === undefined) continue;
    if (isFraction(value[key])) model[key] = value[key];
    else problems.push(`${at} の ${key} は 0 と 1 の間の数にしてください`);
  }
  return model;
}

/** Everything a detection run needs to know of its model. */
export interface DetectorSpec {
  task: DetectTask;
  /** Width and height of the model's input. */
  inputSize: [number, number];
  /** Class names; may be empty when neither the model nor the config gives them. */
  classes: string[];
  mean: [number, number, number];
  std: [number, number, number];
  /** The input's channels are B, G, R. */
  bgr: boolean;
  format: DetectFormat;
  /** YOLOX's grid strides. */
  strides: number[];
  score: number;
  iou: number;
  /** The input is one image, `[3, H, W]`, not a batch `[1, 3, H, W]`. */
  unbatched: boolean;
  /** The most objects the model gives for one input (0: no limit); a tile that reaches it is split. */
  maxDetections: number;
}

/**
 * The spec of a detection model: what `config.json` says, then what the
 * model's own metadata says (Ultralytics: `task`, `imgsz`, `names`), then
 * YOLO's defaults.
 */
export function detectorSpec(config: Partial<DetectModelConfig>, metadata: Record<string, string>, signature?: OnnxSignature): DetectorSpec {
  const task = config.task ?? (['detect', 'obb', 'segment'].includes(metadata.task) ? (metadata.task as DetectTask) : 'detect');
  const imgsz = parseNumbers(metadata.imgsz);
  // Ultralytics writes imgsz as [height, width].
  const fromMeta: [number, number] | null = imgsz.length === 2 ? [imgsz[1], imgsz[0]] : imgsz.length === 1 ? [imgsz[0], imgsz[0]] : null;
  // A fixed input size (an export traced at one size, as Detectron2's is), else none.
  const input = signature?.inputs[0];
  const [h, w] = input ? input.dims.slice(-2) : [];
  const fixed: [number, number] | null = typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? [w, h] : null;
  const detectron2 = config.format === 'detectron2' || ((config.format ?? 'auto') === 'auto' && !!signature && hasDetectron2Outputs(signature));
  // YOLOX and Detectron2 take 0–255 B, G, R (Detectron2 normalizes inside the model).
  const raw = config.format === 'yolox' || detectron2;
  return {
    task: detectron2 ? 'detect' : task,
    // Detectron2's models are trained with the shorter side about 800.
    inputSize: config.inputSize ?? fromMeta ?? fixed ?? (detectron2 ? [800, 800] : [640, 640]),
    classes: config.classes ?? pythonNames(metadata.names ?? ''),
    mean: config.mean ?? [0, 0, 0],
    std: config.std ?? (raw ? [1, 1, 1] : [255, 255, 255]),
    bgr: (config.channels ?? (raw ? 'bgr' : 'rgb')) === 'bgr',
    format: detectron2 ? 'detectron2' : (config.format ?? 'auto'),
    strides: config.strides ?? [8, 16, 32],
    score: config.score ?? (detectron2 ? 0.5 : 0.25),
    iou: config.iou ?? 0.45,
    unbatched: input?.dims.length === 3,
    // Detectron2 keeps the best 100 of an image unless told otherwise when exported.
    maxDetections: config.maxDetections ?? (detectron2 ? 100 : 0),
  };
}

/** Whether a model's outputs are Detectron2's: boxes `[N, 4]`, and scores and classes `[N]` (float, integer). */
function hasDetectron2Outputs({ outputs }: OnnxSignature): boolean {
  const float = (o: OnnxValue) => o.type === ONNX_FLOAT || o.type === ONNX_FLOAT16 || o.type === ONNX_DOUBLE;
  return (
    // (A traced export may leave the 4 as a free axis.)
    outputs.some((o) => float(o) && o.dims.length === 2 && (o.dims[1] === 4 || typeof o.dims[1] === 'string')) &&
    outputs.some((o) => float(o) && o.dims.length === 1) &&
    outputs.some((o) => !float(o) && o.dims.length === 1)
  );
}

/** The numbers in `[640, 640]` or `640`. */
function parseNumbers(text: string | undefined): number[] {
  return (text?.match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter((n) => n > 0);
}

/**
 * Class names from Ultralytics' metadata: a Python dict as text,
 * `{0: 'person', 1: 'bicycle'}` (or JSON, or a list).
 */
export function pythonNames(text: string): string[] {
  const names: string[] = [];
  const pairs = /["']?(\d+)["']?\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
  let found = false;
  for (const m of text.matchAll(pairs)) {
    found = true;
    names[Number(m[1])] = (m[2] ?? m[3]).replace(/\\(.)/g, '$1');
  }
  if (!found) {
    // A list: ['a', 'b'] or ["a", "b"].
    for (const m of text.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)) names.push((m[1] ?? m[2]).replace(/\\(.)/g, '$1'));
  }
  return Array.from(names, (n, i) => n ?? `class ${i}`);
}

/**
 * The `metadata_props` of an ONNX model (ModelProto field 14, key / value
 * strings), read straight from its protobuf bytes; onnxruntime-web does not
 * expose them. Only the top-level fields are walked, so this is quick even
 * for a large model.
 */
export function onnxMetadata(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const decoder = new TextDecoder();
  try {
    let at = 0;
    const varint = (): number => {
      let value = 0;
      let scale = 1;
      for (;;) {
        if (at >= bytes.length) throw new Error('truncated');
        const b = bytes[at++];
        value += (b & 0x7f) * scale;
        if (b < 0x80) return value;
        scale *= 128;
      }
    };
    const skip = (wire: number): [number, number] | null => {
      if (wire === 0) varint();
      else if (wire === 1) at += 8;
      else if (wire === 5) at += 4;
      else if (wire === 2) {
        const length = varint();
        const start = at;
        at += length;
        return [start, at];
      } else throw new Error(`wire type ${wire}`);
      return null;
    };
    while (at < bytes.length) {
      const key = varint();
      const span = skip(key % 8);
      if (Math.floor(key / 8) !== 14 || !span) continue;
      // StringStringEntryProto: key = 1, value = 2.
      const end = at;
      at = span[0];
      let k = '';
      let v = '';
      while (at < span[1]) {
        const inner = varint();
        const s = skip(inner % 8);
        if (!s) continue;
        const text = decoder.decode(bytes.subarray(s[0], s[1]));
        if (Math.floor(inner / 8) === 1) k = text;
        else if (Math.floor(inner / 8) === 2) v = text;
      }
      at = end;
      if (k) out[k] = v;
    }
  } catch {
    // Not a model we can walk: no metadata.
  }
  return out;
}

/** A graph input or output: its name, element type (ONNX's TensorProto.DataType) and shape (a name for a free axis). */
export interface OnnxValue {
  name: string;
  type: number;
  dims: Array<number | string>;
}

/** The inputs and outputs of an ONNX model's graph. */
export interface OnnxSignature {
  inputs: OnnxValue[];
  outputs: OnnxValue[];
}

const ONNX_FLOAT = 1;
const ONNX_DOUBLE = 11;
const ONNX_FLOAT16 = 10;

/**
 * The inputs and outputs of an ONNX model (ModelProto.graph, field 7: input
 * 11 and output 12, ValueInfoProto → TypeProto.tensor_type → shape), read
 * straight from its protobuf bytes like {@link onnxMetadata}; the graph's
 * weights are stepped over, not read.
 */
export function onnxSignature(bytes: Uint8Array): OnnxSignature {
  const out: OnnxSignature = { inputs: [], outputs: [] };
  const decoder = new TextDecoder();
  let at = 0;
  const varint = (): number => {
    let value = 0;
    let scale = 1;
    for (;;) {
      if (at >= bytes.length) throw new Error('truncated');
      const b = bytes[at++];
      value += (b & 0x7f) * scale;
      if (b < 0x80) return value;
      scale *= 128;
    }
  };
  /** The fields of the message from `at` to `end`: field number, varint value or [start, end] span. */
  const fields = function* (start: number, end: number): Generator<[number, number | [number, number]]> {
    at = start;
    while (at < end) {
      const key = varint();
      const wire = key % 8;
      const field = Math.floor(key / 8);
      if (wire === 0) yield [field, varint()];
      else if (wire === 1) at += 8;
      else if (wire === 5) at += 4;
      else if (wire === 2) {
        const length = varint();
        const span: [number, number] = [at, at + length];
        at += length;
        const resume = at;
        yield [field, span];
        at = resume;
      } else throw new Error(`wire type ${wire}`);
    }
  };
  const text = ([a, b]: [number, number]) => decoder.decode(bytes.subarray(a, b));
  const valueOf = (span: [number, number]): OnnxValue => {
    const value: OnnxValue = { name: '', type: 0, dims: [] };
    for (const [f, v] of [...fields(...span)]) {
      if (f === 1 && Array.isArray(v)) value.name = text(v);
      // TypeProto.tensor_type (1): elem_type (1), shape (2) of dims (1): dim_value (1) or dim_param (2).
      if (f !== 2 || !Array.isArray(v)) continue;
      for (const [tf, tensor] of [...fields(...v)]) {
        if (tf !== 1 || !Array.isArray(tensor)) continue;
        for (const [ef, e] of [...fields(...tensor)]) {
          if (ef === 1 && typeof e === 'number') value.type = e;
          if (ef !== 2 || !Array.isArray(e)) continue;
          for (const [, dim] of [...fields(...e)]) {
            if (!Array.isArray(dim)) continue;
            let size: number | string = '?';
            for (const [df, d] of [...fields(...dim)]) {
              if (df === 1 && typeof d === 'number') size = d;
              if (df === 2 && Array.isArray(d)) size = text(d);
            }
            value.dims.push(size);
          }
        }
      }
    }
    return value;
  };
  try {
    for (const [field, graph] of [...fields(0, bytes.length)]) {
      if (field !== 7 || !Array.isArray(graph)) continue;
      for (const [f, v] of [...fields(...graph)]) {
        if (Array.isArray(v) && (f === 11 || f === 12)) (f === 11 ? out.inputs : out.outputs).push(valueOf(v));
      }
    }
  } catch {
    // Not a model we can walk: no signature.
  }
  return out;
}
