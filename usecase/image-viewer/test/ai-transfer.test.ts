import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature.js';
import Polygon from 'ol/geom/Polygon.js';
import { fromLonLat } from 'ol/proj.js';
import { actionOf, detectionOutputOf, fitValue, markOrigin, markSent, measure, missingFields, signatureOf, statusOf, targetGeometry, transferAttributes, type TargetField } from '../src/ai/transfer.js';

/** A 100 m × 40 m box near Tokyo, its long side east–west. */
function box(): Polygon {
  const [x, y] = fromLonLat([139.7, 35.68]);
  const k = 1 / Math.cos((35.68 * Math.PI) / 180);
  return new Polygon([[[x, y], [x + 100 * k, y], [x + 100 * k, y - 40 * k], [x, y - 40 * k], [x, y]]]);
}

const output = detectionOutputOf(
  { label: 'DB', url: 'https://gis.example/arcgis/rest/services/D/FeatureServer/0', fields: { class: 'CLASS', score: 'CONF', status: 'STATUS', area: 'AREA', detectedAt: 'DET', sentAt: 'SENT', length: 'LEN' }, statusValues: { corrected: 9 }, constants: { SRC: 'v' } },
  [],
  0,
)!;
const fields = new Map<string, TargetField>(
  [
    { name: 'CLASS', type: 'esriFieldTypeString', length: 4 },
    { name: 'CONF', type: 'esriFieldTypeDouble' },
    { name: 'STATUS', type: 'esriFieldTypeInteger' },
    { name: 'AREA', type: 'esriFieldTypeDouble' },
    { name: 'DET', type: 'esriFieldTypeDate' },
    { name: 'SENT', type: 'esriFieldTypeDate' },
    { name: 'SRC', type: 'esriFieldTypeString' },
  ].map((f) => [f.name.toLowerCase(), f]),
);

describe('detection outputs', () => {
  it('checks config entries', () => {
    const problems: string[] = [];
    expect(detectionOutputOf({ url: 'https://x/arcgis/rest/services/D/MapServer', fields: { class: 'C' } }, problems, 0)).toBeNull();
    expect(detectionOutputOf({ url: 'https://x/rest/services/D/FeatureServer/1', fields: { colour: 'C', class: 'C-1' } }, problems, 1)).toBeNull();
    expect(problems).toEqual([
      'detectionOutputs[0] の url は …/FeatureServer/0 のようなレイヤーの URL にしてください',
      'detectionOutputs[1] の fields.colour は使えない役割です',
      'detectionOutputs[1] の fields.class は属性名（英数字と _）にしてください',
      'detectionOutputs[1] の fields に書き込む属性がありません',
    ]);
    expect(output.statusValues).toEqual({ ai: 'AI', corrected: 9, manual: '手動' });
    expect(missingFields(output, fields)).toEqual(['LEN']);
  });

  it('tells the model\'s features from corrected and added ones', () => {
    const f = new Feature({ geometry: box(), class: 'car', score: 0.876 });
    markOrigin(f);
    expect(statusOf(f)).toBe('ai');
    f.set('class', 'truck');
    expect(statusOf(f)).toBe('corrected');
    f.set('class', 'car');
    f.getGeometry()!.translate(5, 0);
    expect(statusOf(f)).toBe('corrected');
    expect(statusOf(new Feature({ geometry: box() }))).toBe('manual');
  });

  it('maps roles to the target\'s fields, fitted to their types', () => {
    const f = new Feature({ geometry: box(), class: 'vehicle', score: 0.876, detected_at: '2026-10-10T00:00:00Z' });
    markOrigin(f);
    f.set('class', 'truck');
    const attributes = transferAttributes(f, output, fields, 1000);
    expect(attributes).toMatchObject({ CLASS: 'truc', CONF: 0.876, STATUS: 9, DET: Date.parse('2026-10-10T00:00:00Z'), SENT: 1000, SRC: 'v' });
    expect(Math.abs((attributes.AREA as number) - 4000)).toBeLessThan(40);
    expect(fitValue('12.6', { name: 'N', type: 'esriFieldTypeSmallInteger' })).toBe(13);
    expect(fitValue('', { name: 'N', type: 'esriFieldTypeString' })).toBeNull();
  });

  it('measures a box: area, sides and the bearing of the long side', () => {
    const m = measure(box());
    expect(Math.abs(m.area! - 4000)).toBeLessThan(40);
    expect(m.length!).toBeCloseTo(100, 0);
    expect(m.width!).toBeCloseTo(40, 0);
    expect(m.angle).toBeCloseTo(90, 0);
  });

  it('adds new features, updates changed ones, leaves the rest', () => {
    const f = new Feature({ geometry: box() });
    const sig = signatureOf({ A: 1, SENT: 5 }, {}, 'SENT');
    expect(sig).toBe(signatureOf({ A: 1, SENT: 9 }, {}, 'SENT'));
    expect(actionOf(f, 'u', sig)).toEqual({ kind: 'add' });
    markSent(f, 'u', 7, sig);
    expect(actionOf(f, 'u', sig)).toEqual({ kind: 'same', id: 7 });
    expect(actionOf(f, 'u', signatureOf({ A: 2 }, {}, 'SENT'))).toEqual({ kind: 'update', id: 7 });
    expect(actionOf(f, 'other', sig)).toEqual({ kind: 'add' });
  });

  it('writes a polygon\'s inner point to a point layer', () => {
    expect(targetGeometry(box(), 'esriGeometryPoint')!.getType()).toBe('Point');
    expect(targetGeometry(box(), 'esriGeometryPolyline')).toBeNull();
  });
});
