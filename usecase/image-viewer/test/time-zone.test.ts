import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config.js';
import { esriJson } from '../src/services/esri.js';
import { datetimeOf, parseItem } from '../src/stac.js';
import { timeOf } from '../src/moving.js';
import {
  clockOf,
  instantOf,
  parseTimeZone,
  readInstant,
  readTextInstant,
  setTimeZoneRules,
  shiftTexts,
  sourceRule,
  timeZoneRuleFor,
  UTC,
  writeInstant,
  writeText,
} from '../src/time-zone.js';

const H = 3_600_000;
const tokyo = parseTimeZone('Asia/Tokyo')!;

afterEach(() => {
  setTimeZoneRules([]);
  vi.unstubAllGlobals();
});

describe('parseTimeZone', () => {
  it('reads IANA names, offsets and Windows names', () => {
    expect(tokyo.name).toBe('Asia/Tokyo');
    expect(tokyo.offset(Date.UTC(2026, 0, 1))).toBe(9 * H);
    expect(parseTimeZone('+09:00')!.offset(0)).toBe(9 * H);
    expect(parseTimeZone('UTC+9')!.name).toBe('UTC+09:00');
    expect(parseTimeZone('-0530')!.offset(0)).toBe(-5.5 * H);
    expect(parseTimeZone('UTC')).toBe(UTC);
    expect(parseTimeZone('Tokyo Standard Time')!.offset(0)).toBe(9 * H);
    expect(parseTimeZone('Mars/Olympus')).toBeNull();
    expect(parseTimeZone('+15:00')).toBeNull();
    expect(parseTimeZone(9)).toBeNull();
  });

  it('follows daylight saving', () => {
    const ny = parseTimeZone('America/New_York')!;
    expect(ny.offset(Date.UTC(2026, 0, 15))).toBe(-5 * H);
    expect(ny.offset(Date.UTC(2026, 6, 15))).toBe(-4 * H);
    // 2026-07-15 12:00 in New York is 16:00 UTC.
    expect(instantOf(Date.UTC(2026, 6, 15, 12), ny)).toBe(Date.UTC(2026, 6, 15, 16));
    expect(clockOf(Date.UTC(2026, 6, 15, 16), ny)).toBe(Date.UTC(2026, 6, 15, 12));
  });
});

describe('shifts', () => {
  it('reads a service value as clock time in the data zone, and writes it back', () => {
    // Stored 09:00 Tokyo time, the service calls it 09:00 UTC.
    const raw = Date.UTC(2026, 9, 28, 9);
    const shift = { data: tokyo, service: UTC };
    expect(readInstant(raw, shift)).toBe(Date.UTC(2026, 9, 28, 0));
    expect(writeInstant(Date.UTC(2026, 9, 28, 0), shift)).toBe(raw);
    // The service says Tokyo, the data is UTC.
    expect(readInstant(raw, { data: UTC, service: tokyo })).toBe(Date.UTC(2026, 9, 28, 18));
  });

  it('reads text ignoring its own suffix and writes it in the same form', () => {
    expect(readTextInstant('2026-10-28T09:00:00Z', tokyo)).toBe(Date.UTC(2026, 9, 28, 0));
    expect(readTextInstant('2026-10-28 09:00', tokyo)).toBe(Date.UTC(2026, 9, 28, 0));
    expect(readTextInstant('2026-10-28', tokyo)).toBeNull();
    const t = Date.UTC(2026, 9, 28, 0);
    expect(writeText(t, tokyo, '2026-01-01T00:00:00Z')).toBe('2026-10-28T09:00:00Z');
    expect(writeText(t, tokyo, '2026-01-01 00:00:00')).toBe('2026-10-28 09:00:00');
    expect(writeText(t, tokyo, '2026-01-01T00:00:00+00:00')).toBe('2026-10-28T09:00:00+09:00');
  });

  it('rewrites text attributes and writes them back as the source wrote them', () => {
    const values = new Map<string, unknown>([['seen', '2026-10-28T09:00:00Z'], ['name', 'a']]);
    const feature = { getKeys: () => [...values.keys()], get: (k: string) => values.get(k), set: (k: string, v: unknown) => void values.set(k, v) };
    const times = shiftTexts([feature], tokyo)!;
    expect(Date.parse(values.get('seen') as string)).toBe(Date.UTC(2026, 9, 28, 0));
    expect(values.get('name')).toBe('a');
    expect(times.back('seen', values.get('seen'))).toBe('2026-10-28T09:00:00Z');
    expect(times.back('name', 'a')).toBe('a');
    expect(shiftTexts([feature], null)).toBeNull();
  });
});

describe('config.json', () => {
  it('takes timeZone from source entries and timeZones rules', () => {
    const { config, problems } = parseConfig({
      imageCatalogs: [{ label: 'c', url: 'https://gis.example/arcgis/rest/services/Cat/FeatureServer/0', timeZone: 'Asia/Tokyo', fields: { id: 'ID', source: 'PATH' } }],
      layers: [{ type: 'esri', url: 'https://gis.example/arcgis/rest/services/Ships/FeatureServer', timeZone: '+09:00', serviceTimeZone: 'UTC' }],
      timeZones: [{ match: 'legacy\\.example', timeZone: 'Asia/Seoul' }, { match: 'x' }, { match: 'y', timeZone: 'Nowhere/Land' }],
      observationStores: [{ label: 'o', url: 'https://gis.example/arcgis/rest/services/Obs/FeatureServer/0', timeZone: 'bad zone' }],
    });
    expect(problems.filter((p) => /timeZone/.test(p))).toHaveLength(3);
    setTimeZoneRules(config.timeZones);
    expect(timeZoneRuleFor('https://gis.example/arcgis/rest/services/Cat/FeatureServer/0')?.zone.name).toBe('Asia/Tokyo');
    expect(timeZoneRuleFor('https://gis.example/arcgis/rest/services/Cat/FeatureServer/01')).toBeUndefined();
    expect(timeZoneRuleFor('https://gis.example/arcgis/rest/services/Ships/FeatureServer/3')?.service).toBe(UTC);
    expect(timeZoneRuleFor('https://legacy.example/wfs')?.zone.name).toBe('Asia/Seoul');
    expect(timeZoneRuleFor('https://gis.example/arcgis/rest/services/Obs/FeatureServer/0')).toBeUndefined();
  });
});

describe('Esri requests', () => {
  const layer = 'https://gis.example/arcgis/rest/services/Obs/FeatureServer/0';

  function stub(layerJson: object, answer: object) {
    const sent: Array<{ url: string; body: URLSearchParams }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = new URLSearchParams(init?.body ? String(init.body) : String(url).split('?')[1] ?? '');
        sent.push({ url: String(url).split('?')[0], body });
        return Response.json(String(url).split('?')[0] === layer ? layerJson : answer);
      }),
    );
    return sent;
  }

  it('reads date fields in the data zone, converts where and edits back', async () => {
    setTimeZoneRules([sourceRule(layer, tokyo)]);
    const raw = Date.UTC(2026, 9, 28, 9);
    const sent = stub({ fields: [{ name: 'seen', type: 'esriFieldTypeDate' }, { name: 'n', type: 'esriFieldTypeInteger' }] }, { features: [{ attributes: { seen: raw, n: 5 } }] });
    const json = await esriJson<{ features: Array<{ attributes: Record<string, number> }> }>(`${layer}/query`, { where: "seen >= TIMESTAMP '2026-10-28 00:00:00'" }, undefined, true);
    expect(json.features[0].attributes).toEqual({ seen: Date.UTC(2026, 9, 28, 0), n: 5 });
    const query = sent.find((s) => s.url.endsWith('/query'))!;
    expect(query.body.get('where')).toBe("seen >= TIMESTAMP '2026-10-28 09:00:00'");

    await esriJson(`${layer}/applyEdits`, { adds: JSON.stringify([{ attributes: { seen: Date.UTC(2026, 9, 28, 0), n: 1 } }]) }, undefined, true);
    const edit = sent.find((s) => s.url.endsWith('/applyEdits'))!;
    expect(JSON.parse(edit.body.get('adds')!)[0].attributes).toEqual({ seen: raw, n: 1 });
    // The layer's description is asked once.
    expect(sent.filter((s) => s.url === layer)).toHaveLength(1);
  });

  it("uses the layer's own dateFieldsTimeReference as the service zone", async () => {
    setTimeZoneRules([sourceRule(layer, UTC)]);
    stub({ fields: [{ name: 'seen', type: 'esriFieldTypeDate' }], dateFieldsTimeReference: { timeZone: 'Tokyo Standard Time', respectsDaylightSaving: false } }, { features: [{ attributes: { seen: Date.UTC(2026, 9, 28, 0) } }] });
    const json = await esriJson<{ features: Array<{ attributes: Record<string, number> }> }>(`${layer}/query`, { where: '1=1' }, undefined, true);
    expect(json.features[0].attributes.seen).toBe(Date.UTC(2026, 9, 28, 9));
  });

  it('leaves layers without a zone alone', async () => {
    const sent = stub({}, { features: [{ attributes: { seen: 1 } }] });
    const json = await esriJson<{ features: Array<{ attributes: Record<string, number> }> }>(`${layer}/query`, { where: '1=1' }, undefined, true);
    expect(json.features[0].attributes.seen).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

describe('STAC and feeds', () => {
  it('reads item times and search days in the zone', () => {
    setTimeZoneRules([sourceRule('https://stac.example/api', tokyo)]);
    const item = parseItem({ type: 'Feature', id: 'a', properties: { datetime: '2026-10-28T09:00:00Z' }, geometry: null, assets: {} }, 'https://stac.example/api/search');
    expect(item?.time).toBe(Date.UTC(2026, 9, 28, 0));
    expect(datetimeOf('2026-10-28', '', tokyo)).toBe('2026-10-28T09:00:00Z/..');
  });

  it('reads feed times in the zone', () => {
    expect(timeOf('2026-10-28 09:00:00 +0000 UTC', tokyo)).toBe(Date.UTC(2026, 9, 28, 0));
    expect(timeOf(Date.UTC(2026, 9, 28, 9), tokyo)).toBe(Date.UTC(2026, 9, 28, 0));
    expect(timeOf('2026-10-28T09:00:00Z')).toBe(Date.UTC(2026, 9, 28, 9));
  });
});
