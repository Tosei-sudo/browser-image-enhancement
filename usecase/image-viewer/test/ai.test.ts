import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { aiModelOf, COCO_CLASSES, detectorSpec, onnxMetadata, pythonNames } from '../src/ai/model-config.js';
import { blocksOf, boxCorners, decodeYolo, instanceMask, layoutOf, nms, overlap, PAD, tilesOf, tileStarts, tileTensor, yoloxGrid, type Detection } from '../src/ai/detect.js';
import { maskOutline } from '../src/ai/mask-outline.js';
import { partAt, samMask, samPrompt, samScale, samTensor } from '../src/ai/sam.js';
import { parseConfig } from '../src/config.js';

const spec = (over: Partial<ReturnType<typeof detectorSpec>> = {}) => ({ ...detectorSpec({}, {}), ...over });

describe('model config', () => {
  it('reads Ultralytics metadata from the model bytes', () => {
    const meta = onnxMetadata(readFileSync(new URL('./data/ai/detect.onnx', import.meta.url)));
    expect(meta).toMatchObject({ task: 'detect', imgsz: '[64, 64]', names: "{0: 'bright', 1: 'dark'}" });
    expect(detectorSpec({}, meta)).toMatchObject({ task: 'detect', inputSize: [64, 64], classes: ['bright', 'dark'], mean: [0, 0, 0], std: [255, 255, 255] });
    expect(onnxMetadata(new Uint8Array([0xff, 0xff]))).toEqual({});
  });

  it('parses class names as Python, JSON or a list', () => {
    expect(pythonNames("{0: 'small-vehicle', 1: \"ship\", 3: 'it\\'s'}")).toEqual(['small-vehicle', 'ship', 'class 2', "it's"]);
    expect(pythonNames('{"0": "a", "1": "b"}')).toEqual(['a', 'b']);
    expect(pythonNames("['plane', 'ship']")).toEqual(['plane', 'ship']);
  });

  it('lets config.json override the metadata, which overrides the defaults', () => {
    const meta = { task: 'obb', imgsz: '[1024, 768]', names: "{0: 'plane'}" };
    expect(detectorSpec({}, meta)).toMatchObject({ task: 'obb', inputSize: [768, 1024], classes: ['plane'] });
    expect(detectorSpec({ task: 'detect', inputSize: [320, 320], classes: ['x', 'y'], score: 0.5 }, meta)).toMatchObject({ task: 'detect', inputSize: [320, 320], classes: ['x', 'y'], score: 0.5 });
  });

  it('knows the COCO classes and YOLOX settings', () => {
    const problems: string[] = [];
    const m = aiModelOf({ url: './models/yolox.onnx', format: 'yolox', classes: 'coco', channels: 'bgr', strides: [8, 16, 32] }, problems, 0);
    expect(problems).toEqual([]);
    expect(m).toMatchObject({ format: 'yolox', channels: 'bgr', strides: [8, 16, 32] });
    expect(m && 'classes' in m && m.classes).toEqual(COCO_CLASSES);
    expect(COCO_CLASSES).toHaveLength(80);
    aiModelOf({ url: 'a.onnx', classes: 'voc', channels: 'hsv', strides: [0] }, problems, 1);
    expect(problems).toHaveLength(3);
  });

  it('checks aiModels entries in config.json', () => {
    const { config, problems } = parseConfig({
      aiModels: [
        { label: '車両', url: './models/vehicles.onnx', inputSize: 1024, classes: ['car', 'truck'], score: 0.3 },
        { label: 'SAM', encoder: 'https://models.example/sam-encoder.onnx', decoder: 'https://models.example/sam-decoder.onnx' },
        { label: 'bad', url: 'javascript:alert(1)' },
        { url: './a.onnx', task: 'pose', score: 2 },
      ],
    });
    expect(config.aiModels).toEqual([
      { kind: 'detect', label: '車両', url: './models/vehicles.onnx', inputSize: [1024, 1024], classes: ['car', 'truck'], score: 0.3 },
      { kind: 'sam', label: 'SAM', encoder: 'https://models.example/sam-encoder.onnx', decoder: 'https://models.example/sam-decoder.onnx' },
      { kind: 'detect', label: 'モデル 4', url: './a.onnx' },
    ]);
    expect(problems).toEqual([
      'aiModels[2] の url に ONNX の URL を書いてください',
      'aiModels[3] の task は detect・obb・segment・sam のどれかにしてください',
      'aiModels[3] の score は 0 と 1 の間の数にしてください',
    ]);
    expect(aiModelOf({ url: './m.onnx', std: [0, 1, 1] }, [], 0)).toEqual({ kind: 'detect', label: 'モデル 1', url: './m.onnx' });
  });
});

describe('tiles', () => {
  it('covers a picture with overlapping tiles, the last at the edge', () => {
    expect(tileStarts(500, 640, 0.2)).toEqual([0]);
    expect(tileStarts(1000, 640, 0.2)).toEqual([0, 360]);
    const starts = tileStarts(3000, 640, 0.2);
    expect(starts[0]).toBe(0);
    expect(starts.at(-1)).toBe(3000 - 640);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeLessThanOrEqual(512);
    expect(tilesOf(1000, 500, [640, 640], 0.2)).toEqual([
      [0, 0],
      [360, 0],
    ]);
  });

  it('splits a view drawn 8 or 16 times larger into overlapping blocks', () => {
    // Small enough: one block, the whole larger view.
    expect(blocksOf([1000, 600], 4, 1, 1024)).toEqual([[0, 0, 4000, 2400]]);
    // 16 times 1280 × 800: blocks of 4096, overlapping by a model input, the last ones at the edges.
    const blocks = blocksOf([1280, 800], 16, 1, 1024);
    const xs = [...new Set(blocks.map((b) => b[0]))];
    expect(xs[0]).toBe(0);
    expect(xs.at(-1)).toBe(20480 - 4096);
    expect(xs[1] - xs[0]).toBe(4096 - 1024);
    expect(blocks.every(([x, y, w, h]) => w === 4096 && h === 4096 && x + w <= 20480 && y + h <= 12800)).toBe(true);
    // On a 2× screen the blocks are half as many CSS pixels.
    expect(blocksOf([1280, 800], 8, 2, 1024)[0]).toEqual([0, 0, 2048, 2048]);
  });

  it('makes NCHW input, padding outside the picture and under transparent pixels', () => {
    // 2 × 1 picture: red, then transparent.
    const rgba = [255, 0, 0, 255, 0, 255, 0, 0];
    const t = tileTensor(rgba, 2, 1, 0, 0, [2, 2], [0, 0, 0], [255, 255, 255]);
    const pad = PAD / 255;
    expect([...t].map((v) => Math.round(v * 1000) / 1000)).toEqual([1, pad, pad, pad, 0, pad, pad, pad, 0, pad, pad, pad].map((v) => Math.round(v * 1000) / 1000));
    // B, G, R (YOLOX): red lands in the last plane.
    const bgr = tileTensor(rgba, 2, 1, 0, 0, [2, 2], [0, 0, 0], [1, 1, 1], true);
    expect([bgr[0], bgr[4], bgr[8]]).toEqual([0, 0, 255]);
  });
});

describe('decoding YOLO outputs', () => {
  it('reads YOLOv8 ([1, 4 + classes, N]) and YOLOv5 ([1, N, 5 + classes])', () => {
    // Two candidates, two classes.
    const v8 = { dims: [1, 6, 2], data: [10, 50, 20, 60, 4, 8, 6, 9, 0.9, 0.1, 0.05, 0.2] };
    const s = spec({ classes: ['a', 'b'] });
    expect(layoutOf(v8, s)).toMatchObject({ format: 'yolov8', transposed: true, classes: 2 });
    expect(decodeYolo(v8, s, 0.25)).toEqual([{ cls: 0, score: 0.9, box: [10, 20, 4, 6] }]);
    const v5 = { dims: [1, 2, 7], data: [10, 20, 4, 6, 0.5, 0.2, 0.8, 50, 60, 8, 9, 0.1, 0.9, 0.9] };
    expect(layoutOf(v5, s).format).toBe('yolov5');
    const found = decodeYolo(v5, s, 0.25);
    expect(found).toHaveLength(1);
    expect(found[0].cls).toBe(1);
    expect(found[0].score).toBeCloseTo(0.4);
    // Without class names, the axes tell them apart (there are many more candidates than values).
    expect(layoutOf({ dims: [1, 84, 8400], data: [] }, spec())).toMatchObject({ format: 'yolov8', classes: 80, count: 8400 });
    expect(layoutOf({ dims: [1, 25200, 85], data: [] }, spec())).toMatchObject({ format: 'yolov5', classes: 80, count: 25200 });
  });

  it('reads the raw grid output of YOLOX (cell offsets and log sizes, in strides)', () => {
    const s = detectorSpec({ format: 'yolox', inputSize: [64, 32], classes: ['car', 'ship'] }, {});
    expect(s).toMatchObject({ std: [1, 1, 1], bgr: true, strides: [8, 16, 32] });
    // Grids of 8 × 4, 4 × 2 and 2 × 1 cells.
    const count = 32 + 8 + 2;
    expect([...yoloxGrid(s.inputSize, s.strides, count).slice(3 * 33, 3 * 34)]).toEqual([1, 0, 16]);
    expect(() => yoloxGrid(s.inputSize, s.strides, 40)).toThrow();
    const data = new Float32Array(count * 7);
    // Candidate 33: cell (1, 0) of the stride-16 grid.
    data.set([0.5, 0.25, Math.log(2), 0, 0.9, 0.1, 0.8], 33 * 7);
    const output = { dims: [1, count, 7], data };
    expect(layoutOf(output, s)).toMatchObject({ format: 'yolox', count, classes: 2 });
    const [d] = decodeYolo(output, s, 0.25);
    expect(d.cls).toBe(1);
    expect(d.score).toBeCloseTo(0.72);
    expect(d.box.map((v) => Math.round(v * 1000) / 1000)).toEqual([24, 4, 32, 16]);
  });

  it('reads end-to-end exports ([1, N, 6], corners) and oriented boxes', () => {
    const e2e = { dims: [1, 300, 6], data: new Float32Array(300 * 6) };
    e2e.data.set([10, 20, 30, 60, 0.8, 3]);
    expect(decodeYolo(e2e, spec(), 0.25)).toEqual([{ cls: 3, score: expect.closeTo(0.8, 5), box: [20, 40, 20, 40] }]);
    // OBB: [1, 4 + 1 class + angle, N].
    const obb = { dims: [1, 6, 1], data: [100, 100, 40, 10, 0.7, Math.PI / 2] };
    const [d] = decodeYolo(obb, spec({ task: 'obb', classes: ['ship'] }), 0.25);
    expect(d.angle).toBeCloseTo(Math.PI / 2);
    const corners = boxCorners(d);
    // Turned a quarter: 10 wide, 40 high.
    expect(Math.max(...corners.map((c) => c[0])) - Math.min(...corners.map((c) => c[0]))).toBeCloseTo(10);
    expect(Math.max(...corners.map((c) => c[1])) - Math.min(...corners.map((c) => c[1]))).toBeCloseTo(40);
  });

  it('keeps the best of overlapping boxes per class, and drops pieces inside a box', () => {
    const d = (cls: number, score: number, box: Detection['box'], angle?: number): Detection => ({ cls, score, box, ...(angle === undefined ? {} : { angle }) });
    const kept = nms(
      [
        d(0, 0.9, [50, 50, 20, 20]),
        d(0, 0.8, [52, 50, 20, 20]), // same object
        d(1, 0.7, [52, 50, 20, 20]), // another class
        d(0, 0.6, [56, 50, 8, 20]), // a piece cut at a tile edge
        d(0, 0.5, [100, 100, 20, 20]),
      ],
      0.45,
    );
    expect(kept.map((k) => k.score)).toEqual([0.9, 0.7, 0.5]);
    // Rotated boxes: a box and itself turned a quarter overlap in the middle square.
    const o = overlap(d(0, 1, [0, 0, 40, 10], 0), d(0, 1, [0, 0, 40, 10], Math.PI / 2));
    expect(o.iou).toBeCloseTo(100 / 700);
  });

  it('outlines instance masks from prototypes and coefficients', () => {
    // One prototype, 4 × 4 over an 8 × 8 input: positive in the left half.
    const protos = { dims: [1, 1, 4, 4], data: [1, 1, -1, -1, 1, 1, -1, -1, 1, 1, -1, -1, 1, 1, -1, -1] };
    const m = instanceMask({ cls: 0, score: 1, box: [4, 4, 8, 8], coeffs: Float32Array.of(1) }, protos, [8, 8])!;
    expect(m).toMatchObject({ x0: 0, y0: 0, width: 8, height: 8 });
    expect([...m.mask.slice(0, 8)]).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
  });
});

describe('mask outlines', () => {
  const grid = (rows: string[]) => ({ mask: Uint8Array.from(rows.join(''), (c) => (c === '#' ? 1 : 0)), width: rows[0].length, height: rows.length });

  it('traces a square as one clockwise ring', () => {
    const { mask, width, height } = grid(['....', '.##.', '.##.', '....']);
    expect(maskOutline(mask, width, height, 0, 1)).toEqual([[[[1, 1], [3, 1], [3, 3], [1, 3]]]]);
  });

  it('keeps holes with their polygon, and separate parts apart', () => {
    const { mask, width, height } = grid(['#####...', '#...#.##', '#...#.##', '#####...']);
    const polygons = maskOutline(mask, width, height, 0, 1);
    expect(polygons).toHaveLength(2);
    const ring = polygons.find((p) => p.length === 2)!;
    expect(ring[0]).toEqual([[0, 0], [5, 0], [5, 4], [0, 4]]);
    expect(ring[1]).toHaveLength(4);
    // Pixels touching only at a corner are two rings.
    const diagonal = grid(['##..', '##..', '..##', '..##']);
    expect(maskOutline(diagonal.mask, 4, 4, 0, 1)).toHaveLength(2);
  });

  it('simplifies a staircase into a slanted edge', () => {
    const rows = Array.from({ length: 20 }, (_, y) => '#'.repeat(y + 1) + '.'.repeat(20 - y - 1));
    const { mask, width, height } = grid(rows);
    const [[ring]] = maskOutline(mask, width, height, 1);
    expect(ring.length).toBeLessThanOrEqual(5);
  });
});

describe('Segment Anything', () => {
  it('scales the longer side to the input, and prompts with a padding point', () => {
    expect(samScale(2000, 1000)).toEqual({ scale: 0.512, width: 1024, height: 512 });
    const p = samPrompt([{ x: 100, y: 50, positive: true }, { x: 10, y: 10, positive: false }], 0.5);
    expect([...p.coords]).toEqual([50, 25, 5, 5, 0, 0]);
    expect([...p.labels]).toEqual([1, 0, -1]);
    const t = samTensor([123.675, 116.28, 103.53, 255], 1, 1, 4);
    expect(t.length).toBe(48);
    expect([...t].every((v) => Math.abs(v) < 1e-6)).toBe(true);
  });

  it('takes the best mask, sampling a low-resolution one over the padded input', () => {
    // Two 4 × 4 masks over a 16 × 16 input; the picture is 8 × 4 (scale 2): its top half of the input.
    const masks = { dims: [1, 2, 4, 4], data: new Float32Array(32) };
    for (let i = 0; i < 16; i++) masks.data[i] = -1;
    // The second mask: the left half.
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) masks.data[16 + y * 4 + x] = x < 2 ? 5 : -5;
    const mask = samMask(masks, [0.2, 0.9], 8, 4, 2, 16);
    expect([...mask.slice(0, 8)]).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
    // A mask of the picture's size is used as it is.
    const full = samMask({ dims: [1, 1, 4, 8], data: new Float32Array(32).fill(1) }, null, 8, 4, 2, 16);
    expect(full.every((v) => v === 1)).toBe(true);
  });

  it('keeps the part under the click', () => {
    const mask = Uint8Array.from([1, 1, 0, 1, 1, 0, 0, 0, 1]);
    expect([...partAt(mask, 3, 3, 0, 0)]).toEqual([1, 1, 0, 1, 1, 0, 0, 0, 0]);
    expect([...partAt(mask, 3, 3, 2, 0)]).toEqual([...mask]);
  });
});
