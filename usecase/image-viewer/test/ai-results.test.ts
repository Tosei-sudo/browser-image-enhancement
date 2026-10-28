import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';
import { getDistance } from 'ol/sphere.js';
import { aiResultSourceOf, confidenceOf, defaultScoreLevels, fetchResults, importDefaultsOf, importPlan, pointOf, resultProperties, resultWhere } from '../src/ai/results.js';

/** A 100 m × 40 m box near Tokyo, its long side east–west. */
function box(lon = 139.7, lat = 35.68): Polygon {
  const [x, y] = fromLonLat([lon, lat]);
  const k = 1 / Math.cos((lat * Math.PI) / 180);
  return new Polygon([[[x, y], [x + 100 * k, y], [x + 100 * k, y - 40 * k], [x, y - 40 * k], [x, y]]]);
}

describe('aiResultSources', () => {
  it('needs only label, url and the image id; the rest has defaults', () => {
    const problems: string[] = [];
    const source = aiResultSourceOf({ label: '外部AI', url: 'https://gis.example/arcgis/rest/services/AI/FeatureServer/0/', fields: { imageId: 'IMAGE_ID', class: 'CLASS', score: 'SCORE' } }, problems, 0);
    expect(problems).toEqual([]);
    expect(source).toEqual({ label: '外部AI', url: 'https://gis.example/arcgis/rest/services/AI/FeatureServer/0', fields: { imageId: 'IMAGE_ID', class: 'CLASS', score: 'SCORE' }, scoreMax: 1, maxResults: 2000, auto: true });
  });

  it('says what is wrong', () => {
    const problems: string[] = [];
    expect(aiResultSourceOf({ url: 'https://x/FeatureServer/0', fields: { class: 'C' } }, problems, 1)).toBeNull();
    expect(aiResultSourceOf({ url: 'https://x/rest', fields: { imageId: 'I' } }, problems, 2)).toBeNull();
    const source = aiResultSourceOf({ url: 'https://x/FeatureServer/1', fields: { imageId: 'I', colour: 'C' }, classes: { ship: '船舶', car: 3 }, confidences: [{ min: 0.5, label: '推定' }, { min: 0.9, label: '確定' }, { label: 'x' }], scoreMax: 100 }, problems, 3)!;
    expect(problems).toEqual([
      'aiResultSources[1] の fields.imageId（画像 ID の属性名）なし',
      'aiResultSources[2] の url は …/FeatureServer/0 のようなレイヤーの URL で指定',
      'aiResultSources[3] の fields.colour は使用不可の役割',
      'aiResultSources[3].classes.car は種別（文字列）で指定',
      'aiResultSources[3].confidences[2] は { "min": 数, "label": 確度 } で指定',
    ]);
    expect(source.classes).toEqual({ ship: '船舶' });
    // Highest first.
    expect(source.confidences).toEqual([{ min: 0.9, label: '確定' }, { min: 0.5, label: '推定' }]);
    expect(source.scoreMax).toBe(100);
    expect(importDefaultsOf({ classes: { plane: '航空機' }, minScore: 0.3 }, problems)).toEqual({ classes: { plane: '航空機' }, confidences: null, minScore: 0.3, activity: '' });
  });

  it("asks for an image's results by its id, quoted, with the source's own condition", () => {
    const source = aiResultSourceOf({ url: 'https://x/FeatureServer/0', fields: { imageId: 'IMG' }, where: 'STATUS = 1' }, [], 0)!;
    expect(resultWhere(source, "A'1")).toBe("(IMG = 'A''1') AND (STATUS = 1)");
  });

  it('reads page after page up to maxResults', async () => {
    const source = aiResultSourceOf({ url: 'https://x/FeatureServer/0', fields: { imageId: 'IMG' }, maxResults: 3 }, [], 0)!;
    const asked: Array<Record<string, string>> = [];
    const feature = (id: number) => ({ attributes: { OBJECTID: id, IMG: 'A' }, geometry: { x: 15550000, y: 4250000 } });
    const pages = [{ features: [feature(1), feature(2)], exceededTransferLimit: true }, { features: [feature(3)], exceededTransferLimit: true }];
    const { features, truncated } = await fetchResults(source, 'A', async (_url, params) => (asked.push(params), pages[asked.length - 1]));
    expect(features).toHaveLength(3);
    expect(truncated).toBe(true);
    expect(asked[1]).toMatchObject({ resultOffset: '2', resultRecordCount: '1' });
  });
});

describe('results as records', () => {
  const source = aiResultSourceOf({ label: '外部AI', url: 'https://x/FeatureServer/0', fields: { imageId: 'IMAGE_ID', class: 'CLASS', score: 'SCORE', time: 'DET' }, scoreMax: 100 }, [], 0)!;

  it('names attributes as the AI layers do, the score on 0–1', () => {
    const f = new Feature({ geometry: box(), image_id: 'x', CLASS: 'ship', score: 87, DET: '2026-10-01T00:00:00Z' });
    f.set('image_id', 'IMG-1');
    // Attribute names in another case still count.
    f.unset('score');
    f.set('Score', 87);
    expect(resultProperties(f, source, { id: 'IMG-1', name: 'a.tif', time: 5 })).toMatchObject({ class: 'ship', score: 0.87, detected_at: Date.UTC(2026, 9, 1), image: 'a.tif', image_time: 5, source: '外部AI' });
  });

  it('records a polygon at its centroid, a box with its long side', () => {
    const shape = box();
    const [x0, y0, x1, y1] = shape.getExtent();
    // The middle of the box.
    expect(getDistance(toLonLat([(x0 + x1) / 2, (y0 + y1) / 2]), pointOf(shape)!)).toBeLessThan(0.01);
    expect(pointOf(new Point(fromLonLat([139, 35])))![0]).toBeCloseTo(139, 6);
  });

  it('gives kinds by class and 確度 by score; leaves out low scores and what is already recorded', () => {
    const features = [
      new Feature({ geometry: box(), class: 'ship', score: 0.92, model: 'yolo' }),
      new Feature({ geometry: box(139.71), class: 'ship', score: 0.5 }),
      new Feature({ geometry: box(139.72), class: 'car', score: 0.1 }),
      new Feature({ geometry: new Point(fromLonLat([139.73, 35.68])), class: 'plane', score: null, heading: 370 }),
    ];
    const levels = defaultScoreLevels(['確定', '推定', '不明']);
    expect(levels).toEqual([{ min: 0.8, label: '推定' }, { min: 0, label: '不明' }]);
    expect(confidenceOf(0.9, levels)).toBe('推定');
    expect(confidenceOf(null, levels)).toBe('');
    const recorded = [{ lon: 139.73, lat: 35.68 }];
    const plan = importPlan(features, { kinds: { ship: '船舶 > タンカー' }, levels, minScore: 0.3, activity: '停泊' }, recorded);
    expect(plan.low).toBe(1);
    expect(plan.recorded).toBe(1);
    expect(plan.items.map((i) => [i.kind, i.confidence, i.activity, i.length])).toEqual([
      ['船舶 > タンカー', '推定', '停泊', 99.9],
      ['船舶 > タンカー', '不明', '停泊', 99.9],
    ]);
    expect(plan.items[0].note).toBe('AI: ship 0.92（yolo）');
    // Again: what lies on a record too; a class without a kind stays as it is.
    const again = importPlan(features, { kinds: {}, levels, minScore: 0, activity: '' }, recorded, true);
    expect(again.items.map((i) => [i.kind, i.heading])).toEqual([['ship', null], ['ship', null], ['car', null], ['plane', 10]]);
  });
});
