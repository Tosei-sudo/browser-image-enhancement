import { describe, expect, it } from 'vitest';
import { CellSet, clipToBox, hilbert, PackedRTree, simplify } from '../src/spatial.js';

describe('PackedRTree', () => {
  it('finds the same boxes as a scan', () => {
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 1000;
    const n = 5000;
    const boxes = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const x = random();
      const y = random();
      boxes.set([x, y, x + random() / 50, y + random() / 50], i * 4);
    }
    const tree = new PackedRTree(boxes, Uint32Array.from({ length: n }, (_, i) => i));
    for (const q of [
      [0, 0, 1000, 1000],
      [100, 100, 150, 180],
      [999, 999, 1200, 1200],
      [-10, -10, -1, -1],
    ]) {
      const scan = [];
      for (let i = 0; i < n; i++) if (!(boxes[i * 4] > q[2] || boxes[i * 4 + 1] > q[3] || boxes[i * 4 + 2] < q[0] || boxes[i * 4 + 3] < q[1])) scan.push(i);
      expect(tree.search(q[0], q[1], q[2], q[3]).sort((a, b) => a - b)).toEqual(scan);
    }
    expect(new PackedRTree(new Float32Array(0), new Uint32Array(0)).search(0, 0, 1, 1)).toEqual([]);
    expect(new PackedRTree(Float32Array.of(1, 1, 2, 2), Uint32Array.of(7)).search(0, 0, 1, 1)).toEqual([7]);
  });

  it('orders a Hilbert curve so neighbors stay together', () => {
    expect([hilbert(0, 0, 1), hilbert(0, 1, 1), hilbert(1, 1, 1), hilbert(1, 0, 1)]).toEqual([0, 1, 2, 3]);
  });
});

describe('simplify', () => {
  const zigzag = new Float64Array(Array.from({ length: 1001 }, (_, i) => [i, i % 2 ? 0.1 : 0]).flat());

  it('drops points closer than the tolerance and keeps the ends', () => {
    const line = simplify(2, { coords: zigzag, ends: [zigzag.length] }, 1);
    expect(Array.from(line.coords)).toEqual([0, 0, 1000, 0]);
    expect(simplify(2, { coords: zigzag, ends: [zigzag.length] }, 0.01).coords.length).toBe(zigzag.length);
  });

  it('keeps rings closed, leaves out small islands and holes, but never every polygon', () => {
    const square = (x: number, y: number, s: number, cw = true) => (cw ? [x, y, x, y + s, x + s, y + s, x + s, y, x, y] : [x, y, x + s, y, x + s, y + s, x, y + s, x, y]);
    const coords = new Float64Array([...square(0, 0, 100), ...square(10, 10, 1, false), ...square(200, 0, 2)]);
    const out = simplify(3, { coords, ends: [10, 20, 30], polygons: [2, 1] }, 5);
    expect(out.polygons).toEqual([1]);
    expect(out.ends).toEqual([10]);
    const tiny = simplify(3, { coords: new Float64Array(square(0, 0, 1)), ends: [10], polygons: [1] }, 5);
    expect(tiny.polygons).toEqual([1]);
    expect(tiny.coords.length).toBeGreaterThanOrEqual(8);
  });
});

describe('clipToBox', () => {
  it('cuts lines into the parts inside', () => {
    const line = clipToBox(2, { coords: new Float64Array([-5, 5, 5, 5, 15, 5, 15, 8, 5, 8]), ends: [10] }, [0, 0, 10, 10])!;
    expect(Array.from(line.coords)).toEqual([0, 5, 5, 5, 10, 5, 10, 8, 5, 8]);
    expect(line.ends).toEqual([6, 10]);
    expect(clipToBox(2, { coords: new Float64Array([20, 20, 30, 30]), ends: [4] }, [0, 0, 10, 10])).toBeNull();
  });

  it('cuts rings to the box, a box inside a polygon too', () => {
    const big = new Float64Array([-50, -50, -50, 50, 50, 50, 50, -50, -50, -50]);
    const out = clipToBox(3, { coords: big, ends: [10], polygons: [1] }, [0, 0, 10, 10])!;
    expect(out.polygons).toEqual([1]);
    const xs = Array.from(out.coords).filter((_, i) => i % 2 === 0);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(10);
    expect(out.coords.slice(0, 2)).toEqual(out.coords.slice(-2));
  });
});

describe('CellSet', () => {
  it('takes each cell once, exact or hashed', () => {
    for (const cells of [new CellSet(100), new CellSet(1 << 20, 1 << 16)]) {
      expect(cells.take(3, 4)).toBe(true);
      expect(cells.take(3, 4)).toBe(false);
      expect(cells.take(4, 3)).toBe(true);
    }
  });
});
