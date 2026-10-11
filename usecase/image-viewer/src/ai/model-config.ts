/**
 * AI models brought in from outside (trained elsewhere, exported to ONNX):
 * what `config.json`'s `aiModels` says of them, and what an Ultralytics
 * export says of itself in its metadata (class names, input size, task), so
 * a YOLO model chosen as a file needs no settings at all.
 *
 * Two kinds of model:
 * - detection: one ONNX file (YOLOv5 / v8 / v11 and later, end-to-end
 *   exports, rotated boxes (OBB) and instance segmentation, and YOLOX's raw
 *   grid output), run over the view in tiles;
 * - click segmentation: a Segment Anything (SAM, MobileSAM, EfficientSAM…)
 *   image encoder and prompt decoder, as exported by segment-anything's
 *   `export_onnx_model.py`.
 */

/** What a detection model finds. */
export type DetectTask = 'detect' | 'obb' | 'segment';
/** How a detection model's first output is laid out (`auto`: from its shape). */
export type DetectFormat = 'auto' | 'yolov8' | 'yolov5' | 'end2end' | 'yolox';

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
  /** The model's input, width and height (from its metadata, else 640 × 640). */
  inputSize?: [number, number];
  /** Class names by index (from its metadata, else `class 0`, `class 1`…). */
  classes?: string[];
  /** Per channel (R, G, B, in 0–255): the input is (value − mean) / std. Default: 0 and 255 (YOLO's 0–1); YOLOX: 0 and 1. */
  mean?: [number, number, number];
  std?: [number, number, number];
  /** The channel order of the input (default: rgb; YOLOX: bgr). */
  channels?: 'rgb' | 'bgr';
  format?: DetectFormat;
  /** YOLOX: the strides of its output grids (default 8, 16, 32). */
  strides?: number[];
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
    if (['auto', 'yolov8', 'yolov5', 'end2end', 'yolox'].includes(value.format as string)) model.format = value.format as DetectFormat;
    else problems.push(`${at} の format は auto・yolov8・yolov5・end2end・yolox のどれかにしてください`);
  }
  if (value.channels !== undefined) {
    if (value.channels === 'rgb' || value.channels === 'bgr') model.channels = value.channels;
    else problems.push(`${at} の channels は rgb か bgr にしてください`);
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
}

/**
 * The spec of a detection model: what `config.json` says, then what the
 * model's own metadata says (Ultralytics: `task`, `imgsz`, `names`), then
 * YOLO's defaults.
 */
export function detectorSpec(config: Partial<DetectModelConfig>, metadata: Record<string, string>): DetectorSpec {
  const task = config.task ?? (['detect', 'obb', 'segment'].includes(metadata.task) ? (metadata.task as DetectTask) : 'detect');
  const imgsz = parseNumbers(metadata.imgsz);
  // Ultralytics writes imgsz as [height, width].
  const fromMeta: [number, number] | null = imgsz.length === 2 ? [imgsz[1], imgsz[0]] : imgsz.length === 1 ? [imgsz[0], imgsz[0]] : null;
  // YOLOX was trained on 0–255 B, G, R.
  const yolox = config.format === 'yolox';
  return {
    task,
    inputSize: config.inputSize ?? fromMeta ?? [640, 640],
    classes: config.classes ?? pythonNames(metadata.names ?? ''),
    mean: config.mean ?? [0, 0, 0],
    std: config.std ?? (yolox ? [1, 1, 1] : [255, 255, 255]),
    bgr: (config.channels ?? (yolox ? 'bgr' : 'rgb')) === 'bgr',
    format: config.format ?? 'auto',
    strides: config.strides ?? [8, 16, 32],
    score: config.score ?? 0.25,
    iou: config.iou ?? 0.45,
  };
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
