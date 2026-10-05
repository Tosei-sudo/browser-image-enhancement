import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import { Fill, Style } from 'ol/style.js';
import type { StyleFunction } from 'ol/style/Style.js';
import { categoriesFor, LayerStyle, memoryStyleStore, normalizeSpec, ownSpec, singleSpec, styleFunction, valuesOf, type VectorStyleSpec } from '../src/vector-style.js';

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

describe('LayerStyle', () => {
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
  });
});
