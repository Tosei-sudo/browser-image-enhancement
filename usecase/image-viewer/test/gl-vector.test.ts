import { afterEach, describe, expect, it } from 'vitest';
import Feature from 'ol/Feature.js';
import type OlMap from 'ol/Map.js';
import LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import { drawsOnGpu, GlVector, glStyle, glVector, painter } from '../src/gl-vector.js';
import { LayerStyle, memoryStyleStore, ownSpec, singleSpec, type VectorStyleSpec } from '../src/vector-style.js';

const square = (x: number, y: number, d: number) => new Polygon([[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]]);

/** A map at 1 unit per pixel, pixels being coordinates. */
const map = { getView: () => ({ getResolution: () => 1 }), getCoordinateFromPixel: (p: number[]) => p } as unknown as OlMap;

const categorized = (): VectorStyleSpec => ({
  ...singleSpec('#000000'),
  mode: 'categorized',
  field: 'use',
  categories: [
    { value: '公園', color: '#00ff00', visible: true },
    { value: '工場', color: '#ff0000', visible: false },
  ],
  othersVisible: true,
});

afterEach(() => {
  glVector.mode = 'auto';
  glVector.fastGpu = undefined;
});

describe('drawsOnGpu', () => {
  it('draws large layers on the GPU, except in their own (service) style', () => {
    const spec = singleSpec('#ff0000');
    expect(drawsOnGpu(spec, glVector.threshold)).toBe(false);
    glVector.fastGpu = true;
    expect(drawsOnGpu(spec, glVector.threshold + 1)).toBe(true);
    // WebGL drawn in software is slower than the canvas.
    glVector.fastGpu = false;
    expect(drawsOnGpu(spec, glVector.threshold + 1)).toBe(false);
    expect(drawsOnGpu(ownSpec(), 1_000_000)).toBe(false);
    glVector.mode = 'always';
    expect(drawsOnGpu(spec, 1)).toBe(true);
    glVector.mode = 'never';
    expect(drawsOnGpu(spec, 1_000_000)).toBe(false);
  });
});

describe('painter', () => {
  it('paints like the canvas style: polygons, lines and points', () => {
    const spec = singleSpec('#ff0000');
    spec.symbol.fillOpacity = 0.5;
    spec.symbol.stroke = '#0000ff';
    const paint = painter(spec);
    expect(paint(new Feature(square(0, 0, 1)))).toEqual({ fill: [255, 0, 0, 0.5], stroke: [0, 0, 255, 1], width: 2 });
    expect(paint(new Feature(new LineString([[0, 0], [1, 1]])))).toMatchObject({ stroke: [0, 0, 255, 1], width: 2 });
    // Point symbols are filled solid, with an outline no wider than a fifth of their size.
    expect(paint(new Feature(new Point([0, 0])))).toEqual({ fill: [255, 0, 0, 1], stroke: [0, 0, 255, 1], width: 2 });
  });

  it('colors by category and leaves out hidden categories', () => {
    const paint = painter(categorized());
    const f = (use: unknown) => new Feature({ geometry: square(0, 0, 1), use });
    expect(paint(f('公園'))?.fill).toEqual([0, 255, 0, 0.25]);
    expect(paint(f('工場'))).toBeNull();
    // Values not listed are 「その他」, in the symbol's own colors.
    expect(paint(f(42))?.fill).toEqual([0, 0, 0, 0.25]);
    // A line takes its category's color.
    expect(paint(new Feature({ geometry: new LineString([[0, 0], [1, 1]]), use: '公園' }))?.stroke).toEqual([0, 255, 0, 1]);
  });

  it('paints graduated ranges, leaving hidden ranges out', () => {
    const paint = painter({
      ...singleSpec('#000000'),
      mode: 'graduated',
      field: 'pop',
      classes: [
        { min: 0, max: 10, color: '#00ff00', visible: true },
        { min: 10, max: 20, color: '#ff0000', visible: false },
      ],
      othersVisible: false,
    });
    const f = (pop: unknown) => new Feature({ geometry: square(0, 0, 1), pop });
    expect(paint(f(5))?.fill).toEqual([0, 255, 0, 0.25]);
    expect(paint(f(15))).toBeNull();
    expect(paint(f(null))).toBeNull();
  });

  it('gives points their shape', () => {
    const spec = singleSpec('#ff0000');
    expect(glStyle(spec)['circle-radius']).toBe(5);
    spec.symbol.shape = 'star';
    expect(glStyle(spec)).toMatchObject({ 'shape-points': 5, 'shape-radius2': 2.75 });
    spec.symbol.dash = 'dash';
    expect(glStyle(spec)['stroke-line-dash']).toEqual([10, 6]);
  });
});

describe('GlVector', () => {
  const layerOf = (features: Feature[]) => new VectorLayer({ source: new VectorSource<Feature>({ features }) });

  it('finds the feature drawn at a pixel: points first, then lines, then the smallest polygon', () => {
    const big = new Feature({ geometry: square(0, 0, 100), name: 'big' });
    const small = new Feature({ geometry: square(10, 10, 10), name: 'small' });
    const line = new Feature({ geometry: new LineString([[0, 50], [100, 50]]), name: 'line' });
    const point = new Feature({ geometry: new Point([80, 80]), name: 'point' });
    const gl = new GlVector(layerOf([big, small, line, point]), singleSpec('#ff0000'));
    const at = (x: number, y: number) => gl.featureAt(map, [x, y])?.get('name');
    expect(at(15, 15)).toBe('small');
    expect(at(50, 20)).toBe('big');
    expect(at(30, 52)).toBe('line');
    expect(at(84, 82)).toBe('point');
    expect(at(200, 200)).toBeUndefined();
    gl.dispose();
  });

  it('follows the source: added, removed and recategorized features', () => {
    const a = new Feature({ geometry: square(0, 0, 10), use: '公園' });
    const layer = layerOf([a]);
    const source = layer.getSource()!;
    const gl = new GlVector(layer, categorized());
    expect(gl.featureAt(map, [5, 5])).toBe(a);
    // Hidden by its category: not drawn, so not clicked.
    a.set('use', '工場');
    expect(gl.featureAt(map, [5, 5])).toBeUndefined();
    a.set('use', '公園');
    expect(gl.featureAt(map, [5, 5])).toBe(a);
    const b = new Feature({ geometry: square(20, 0, 10), use: '公園' });
    source.addFeature(b);
    expect(gl.featureAt(map, [25, 5])).toBe(b);
    // A geometry reshaped in place.
    (b.getGeometry() as Polygon).setCoordinates(square(40, 0, 10).getCoordinates());
    expect(gl.featureAt(map, [45, 5])).toBe(b);
    source.removeFeature(b);
    expect(gl.featureAt(map, [45, 5])).toBeUndefined();
    gl.dispose();
  });
});

describe('LayerStyle on the GPU', () => {
  it('leaves only the labels to the canvas layer', () => {
    glVector.mode = 'always';
    const feature = new Feature({ geometry: new Point([0, 0]), name: '駅' });
    const layer = new VectorLayer({ source: new VectorSource<Feature>({ features: [feature] }) });
    const style = new LayerStyle(layer, singleSpec('#ff0000'), undefined, memoryStyleStore());
    expect(style.onGpu()).toBe(true);
    expect(layer.getStyleFunction()).toBeUndefined();
    const spec = style.get();
    spec.label.field = 'name';
    style.set(spec);
    const drawn = layer.getStyleFunction()!(feature, 1);
    expect(Array.isArray(drawn)).toBe(false);
    expect((drawn as import('ol/style/Style.js').default).getText()?.getText()).toBe('駅');
    expect(style.featureAt(map, [1, 1])).toBe(feature);
    // Back on the canvas.
    glVector.mode = 'never';
    style.set(spec);
    expect(style.onGpu()).toBe(false);
    expect(style.featureAt(map, [1, 1])).toBeUndefined();
  });
});
