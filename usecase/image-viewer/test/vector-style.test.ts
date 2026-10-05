import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import { Fill, Style } from 'ol/style.js';
import type { StyleFunction } from 'ol/style/Style.js';
import {
  categoriesFor,
  classBreaks,
  classesFor,
  classIndex,
  LayerStyle,
  memoryStyleStore,
  normalizeSpec,
  ownSpec,
  rampColor,
  resolutionOfScale,
  scaleOfResolution,
  singleSpec,
  styleFunction,
  valuesOf,
  type VectorStyleSpec,
} from '../src/vector-style.js';
import { fromLonLat } from 'ol/proj.js';

const styles = (fn: StyleFunction, f: Feature): Style[] => {
  const s = fn(f, 1);
  return s ? (Array.isArray(s) ? s : [s]) : [];
};

const point = (props: Record<string, unknown>) => new Feature({ geometry: new Point([0, 0]), ...props });

describe('styleFunction', () => {
  it('draws one symbol in the chosen colors', () => {
    const spec = singleSpec('#ff0000');
    spec.symbol.fillOpacity = 0.5;
    const [s] = styles(styleFunction(spec), new Feature(new Polygon([[[0, 0], [1, 0], [1, 1], [0, 0]]])));
    expect(s.getFill()?.getColor()).toEqual([255, 0, 0, 0.5]);
    expect(s.getStroke()?.getWidth()).toBe(2);
  });

  it('colors features by category and hides the ones turned off', () => {
    const spec: VectorStyleSpec = {
      ...singleSpec('#000000'),
      mode: 'categorized',
      field: 'kind',
      categories: [
        { value: 'a', color: '#00ff00', visible: true },
        { value: 'b', color: '#0000ff', visible: false },
      ],
      othersVisible: false,
    };
    const fn = styleFunction(spec);
    const [a] = styles(fn, point({ kind: 'a' }));
    expect((a.getImage() as unknown as { getFill(): Fill }).getFill().getColor()).toEqual([0, 255, 0, 1]);
    expect(styles(fn, point({ kind: 'b' }))).toEqual([]);
    expect(styles(fn, point({ kind: 'c' }))).toEqual([]);
    // A line takes its category's color as its line color.
    const [line] = styles(fn, new Feature({ geometry: new LineString([[0, 0], [1, 1]]), kind: 'a' }));
    expect(line.getStroke()?.getColor()).toEqual([0, 255, 0, 1]);
  });

  it('adds a label from an attribute, and none where the value is empty', () => {
    const spec = singleSpec('#ff0000');
    spec.label.field = 'name';
    const fn = styleFunction(spec);
    const drawn = styles(fn, point({ name: '東京', pop: 1 }));
    expect(drawn).toHaveLength(2);
    expect(drawn[1].getText()?.getText()).toBe('東京');
    expect(styles(fn, point({ name: null }))).toHaveLength(1);
    expect(styles(fn, point({ name: 0 }))[1].getText()?.getText()).toBe('0');
  });

  it('colors features by the range their number is in', () => {
    const spec: VectorStyleSpec = {
      ...singleSpec('#000000'),
      mode: 'graduated',
      field: 'pop',
      classes: [
        { min: 0, max: 10, color: '#00ff00', visible: true },
        { min: 10, max: 20, color: '#0000ff', visible: true },
        { min: 20, max: 30, color: '#ff0000', visible: false },
      ],
      othersVisible: false,
    };
    const fn = styleFunction(spec);
    const fill = (f: Feature) => (styles(fn, f)[0]?.getImage() as unknown as { getFill(): Fill } | undefined)?.getFill().getColor();
    expect(fill(point({ pop: 0 }))).toEqual([0, 255, 0, 1]);
    expect(fill(point({ pop: 10 }))).toEqual([0, 255, 0, 1]);
    expect(fill(point({ pop: '10.5' }))).toEqual([0, 0, 255, 1]);
    expect(styles(fn, point({ pop: 25 }))).toEqual([]);
    expect(styles(fn, point({ pop: null }))).toEqual([]);
    expect(styles(fn, point({ pop: 99 }))).toEqual([]);
    expect(styles(styleFunction({ ...spec, othersVisible: true }), point({ pop: 'n/a' }))).toHaveLength(1);
  });

  it('leaves labels out when zoomed out beyond their scale', () => {
    const spec = singleSpec('#ff0000');
    spec.label.field = 'name';
    spec.label.maxScale = 25000;
    const fn = styleFunction(spec);
    const near = resolutionOfScale(10000, 0);
    const far = resolutionOfScale(50000, 0);
    expect(fn(point({ name: 'a' }), near)).toHaveLength(2);
    expect(fn(point({ name: 'a' }), far)).not.toBeInstanceOf(Array);
    // Labels only (the symbols drawn on the GPU): nothing at all beyond the scale.
    const labelsOnly = styleFunction(spec, undefined, 0, false);
    expect(labelsOnly(point({ name: 'a' }), near)).toBeTruthy();
    expect(labelsOnly(point({ name: 'a' }), far)).toBeUndefined();
  });

  it('keeps a service style in the own mode and adds labels over it', () => {
    const own = new Style({ fill: new Fill({ color: 'red' }) });
    const spec = ownSpec();
    spec.label.field = 'name';
    const drawn = styles(styleFunction(spec, own), point({ name: 'x' }));
    expect(drawn[0]).toBe(own);
    expect(drawn[1].getText()?.getText()).toBe('x');
  });
});

describe('categories', () => {
  it('lists values with counts, and keeps the colors already chosen', () => {
    const features = [point({ k: 'b' }), point({ k: 'a' }), point({ k: 'b' }), point({ k: null })];
    expect(valuesOf(features, 'k')).toEqual([
      { value: 'b', count: 2 },
      { value: '', count: 1 },
      { value: 'a', count: 1 },
    ]);
    const cats = categoriesFor(features, 'k', [{ value: 'b', color: '#123456', visible: false }]);
    expect(cats.map((c) => c.value)).toEqual(['', 'a', 'b']);
    expect(cats[2]).toEqual({ value: 'b', color: '#123456', visible: false });
  });
});

describe('graduated ranges', () => {
  const values = [1, 2, 3, 4, 10, 11, 12, 30, 31, 32];

  it('cuts at equal intervals, quantiles or natural breaks', () => {
    expect(classBreaks([0, 7, 30], 'equal', 3)).toEqual([0, 10, 20, 30]);
    expect(classBreaks([1, 2, 3, 4, 5], 'quantile', 4)).toEqual([1, 2, 3, 4, 5]);
    expect(classBreaks(values, 'jenks', 3)).toEqual([1, 4, 12, 32]);
    // Fewer distinct values than ranges: one range per value.
    expect(classBreaks([5, 5, 7], 'jenks', 5)).toEqual([5, 7]);
    expect(classBreaks([5, 5], 'equal', 3)).toEqual([5, 5]);
    expect(classBreaks([], 'equal', 3)).toEqual([]);
  });

  it('puts a value in its range, the lowest including its minimum', () => {
    const classes = [
      { min: 1, max: 4, color: '', visible: true },
      { min: 4, max: 12, color: '', visible: true },
    ];
    expect([1, 4, 4.1, 12, 13, 0].map((v) => classIndex(classes, v))).toEqual([0, 0, 1, 1, -1, -1]);
  });

  it('colors ranges along a ramp, low to high or reversed', () => {
    const classes = classesFor(values.map((v) => point({ v })), 'v', 'jenks', 3, 'reds');
    expect(classes.map((c) => [c.min, c.max])).toEqual([
      [1, 4],
      [4, 12],
      [12, 32],
    ]);
    expect(classes[0].color).toBe('#fee5d9');
    expect(classes[2].color).toBe('#a50f15');
    expect(rampColor('reds', 0, true)).toBe('#a50f15');
    expect(rampColor('reds', 0.5)).toBe('#fb6a4a');
  });

  it('measures scales on the ground, where the layer is', () => {
    expect(scaleOfResolution(resolutionOfScale(25000, 35), 35)).toBeCloseTo(25000);
    // 1:25,000 at the equator is 7 m per pixel (0.28 mm pixels); farther north a Mercator pixel is longer.
    expect(resolutionOfScale(25000, 0)).toBeCloseTo(7);
    expect(resolutionOfScale(25000, 60)).toBeCloseTo(14);
  });
});

describe('LayerStyle', () => {
  it('shows the layer only between its scales, measured at its latitude', () => {
    const source = new VectorSource({ features: [new Feature(new Point(fromLonLat([139.7, 35.7])))] });
    const layer = new VectorLayer({ source });
    const spec = { ...singleSpec('#ff0000'), minScale: 100000, maxScale: 1000 };
    new LayerStyle(layer, spec, undefined, memoryStyleStore());
    expect(layer.getMaxResolution()).toBeCloseTo(resolutionOfScale(100000, 35.7));
    expect(layer.getMinResolution()).toBeCloseTo(resolutionOfScale(1000, 35.7));
    const plain = new VectorLayer({ source });
    new LayerStyle(plain, singleSpec('#ff0000'), undefined, memoryStyleStore());
    expect(plain.getMaxResolution()).toBe(Infinity);
    expect(plain.getMinResolution()).toBe(0);
  });

  it('measures scales again when the features of a layer arrive', () => {
    const source = new VectorSource();
    const layer = new VectorLayer({ source });
    new LayerStyle(layer, { ...singleSpec('#ff0000'), minScale: 100000 }, undefined, memoryStyleStore());
    expect(layer.getMaxResolution()).toBeCloseTo(resolutionOfScale(100000, 0));
    source.addFeature(new Feature(new Point(fromLonLat([0, 60]))));
    expect(layer.getMaxResolution()).toBeCloseTo(resolutionOfScale(100000, 60));
  });

  it('keeps a style under the layer key and restores it on a new layer', () => {
    const store = memoryStyleStore();
    const first = new LayerStyle(new VectorLayer({ source: new VectorSource() }), singleSpec('#ff0000'), undefined, store);
    first.restore('file:SHP:roads');
    const spec = first.get();
    spec.label.field = 'name';
    spec.symbol.strokeWidth = 5;
    first.set(spec);
    const layer = new VectorLayer({ source: new VectorSource() });
    const second = new LayerStyle(layer, singleSpec('#00ff00'), undefined, store);
    second.restore('file:SHP:roads');
    expect(second.get().label.field).toBe('name');
    expect(second.get().symbol.strokeWidth).toBe(5);
    expect(layer.getDeclutter()).toBeTruthy();
    second.reset();
    expect(store.get('file:SHP:roads')).toBeUndefined();
    expect(second.get().symbol.fill).toBe('#00ff00');
  });

  it('does not keep a preview', () => {
    const store = memoryStyleStore();
    const style = new LayerStyle(new VectorLayer({ source: new VectorSource() }), singleSpec('#ff0000'), undefined, store);
    style.restore('k');
    style.set({ ...style.get(), mode: 'categorized' }, false);
    expect(store.get('k')).toBeUndefined();
  });
});

describe('normalizeSpec', () => {
  it('fills what a stored style lacks, and leaves out the own mode where there is no own style', () => {
    const spec = normalizeSpec({ mode: 'own', symbol: { fill: '#010203', size: 'big', shape: 'blob' }, label: { field: 'n' } }, singleSpec('#ffffff'));
    expect(spec.mode).toBe('single');
    expect(spec.symbol.fill).toBe('#010203');
    expect(spec.symbol.size).toBe(10);
    expect(spec.symbol.shape).toBe('circle');
    expect(spec.label.field).toBe('n');
    expect(spec.classes).toEqual([]);
    expect(spec.minScale).toBeNull();
  });

  it('reads graduated ranges and scales back, and drops ones that are not numbers', () => {
    const spec = normalizeSpec(
      {
        mode: 'graduated',
        field: 'pop',
        classes: [{ min: 0, max: 1, color: '#000000' }, { min: 'x', max: 2, color: '#000000' }],
        method: 'quantile',
        classCount: 99,
        ramp: 'nope',
        minScale: 5000,
        maxScale: -1,
        label: { maxScale: 2000 },
      },
      singleSpec('#ffffff'),
    );
    expect(spec.mode).toBe('graduated');
    expect(spec.classes).toEqual([{ min: 0, max: 1, color: '#000000', visible: true }]);
    expect([spec.method, spec.classCount, spec.ramp]).toEqual(['quantile', 20, 'reds']);
    expect([spec.minScale, spec.maxScale, spec.label.maxScale]).toEqual([5000, null, 2000]);
  });
});
