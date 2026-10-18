import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature.js';
import { catalogOf, emptySearch, recordOf, whereOf, type CatalogConfig } from '../src/catalog.js';
import { azimuthDifference, defaultTolerance, rankSimilar, similarSearch } from '../src/catalog-similar.js';

const catalog = catalogOf(
  {
    url: 'https://gis.example.com/arcgis/rest/services/Catalog/FeatureServer/0',
    fields: { id: 'IMG_ID', acquired: 'ACQ', sensor: 'SENSOR', angle: 'OFF_NADIR', azimuth: 'AZIMUTH', source: 'URL' },
  },
  [],
  0,
) as CatalogConfig;
const record = (attrs: Record<string, unknown>) => recordOf(new Feature(attrs), catalog.fields);

describe('similarSearch', () => {
  it('asks for the same sensor and angles within the tolerances', () => {
    const reference = record({ IMG_ID: 'A', SENSOR: 'S1', OFF_NADIR: 12, AZIMUTH: 100, URL: 'https://x/a.tif' });
    const search = similarSearch(catalog, reference, defaultTolerance);
    expect(whereOf(catalog, {}, search)).toBe("SENSOR = 'S1' AND AZIMUTH >= 80 AND AZIMUTH <= 120 AND (OFF_NADIR >= 7 AND OFF_NADIR <= 17)");
  });

  it('goes through north, keeps the dates and SQL of the form, and leaves out what the reference lacks', () => {
    const reference = record({ IMG_ID: 'A', SENSOR: 'S1', AZIMUTH: 350, URL: 'https://x/a.tif' });
    const search = similarSearch(catalog, reference, { ...defaultTolerance, sameSensor: false }, { ...emptySearch, sensor: 'S9', maxAngle: 3, where: 'CLOUD < 20' });
    expect(search.sensor).toBe('');
    expect(search.maxAngle).toBeNull();
    expect(whereOf(catalog, {}, search)).toBe('(AZIMUTH >= 330 OR AZIMUTH <= 10) AND ((CLOUD < 20))');
    // No azimuth limit at ±180° or more, none without a tolerance.
    expect(similarSearch(catalog, reference, { ...defaultTolerance, azimuth: 180 }).azimuthFrom).toBeNull();
    expect(similarSearch(catalog, reference, { ...defaultTolerance, azimuth: null }).azimuthFrom).toBeNull();
  });
});

describe('rankSimilar', () => {
  it('orders the most alike first, leaving out the reference and images not over it', () => {
    const reference = record({ IMG_ID: 'A', SENSOR: 'S1', OFF_NADIR: 10, AZIMUTH: 100, URL: 'https://x/a.tif' });
    const near = record({ IMG_ID: 'B', SENSOR: 'S1', OFF_NADIR: 11, AZIMUTH: 102, URL: 'https://x/b.tif' });
    const far = record({ IMG_ID: 'C', SENSOR: 'S1', OFF_NADIR: 14, AZIMUTH: 115, URL: 'https://x/c.tif' });
    const half = record({ IMG_ID: 'D', SENSOR: 'S1', OFF_NADIR: 10, AZIMUTH: 100, URL: 'https://x/d.tif' });
    const apart = record({ IMG_ID: 'E', SENSOR: 'S1', OFF_NADIR: 10, AZIMUTH: 100, URL: 'https://x/e.tif' });
    const itself = record({ IMG_ID: 'A', SENSOR: 'S1', OFF_NADIR: 10, AZIMUTH: 100, URL: 'https://x/a.tif' });
    const overlaps = new Map([
      [near, 1],
      [far, 1],
      [half, 0.4],
      [apart, 0],
      [itself, 1],
    ]);
    const ranked = rankSimilar(reference, [far, half, apart, itself, near], defaultTolerance, (r) => overlaps.get(r) ?? null);
    expect(ranked.map((s) => s.record.id)).toEqual(['B', 'D', 'C']);
    expect(ranked[1].overlap).toBe(0.4);
    // A least share of the reference.
    expect(rankSimilar(reference, [near, half], { ...defaultTolerance, minOverlap: 0.5 }, (r) => overlaps.get(r) ?? null).map((s) => s.record.id)).toEqual(['B']);
  });

  it('measures azimuths through north', () => {
    expect(azimuthDifference(355, 5)).toBe(10);
    expect(azimuthDifference(10, 190)).toBe(180);
    expect(azimuthDifference(-20, 20)).toBe(40);
  });
});
