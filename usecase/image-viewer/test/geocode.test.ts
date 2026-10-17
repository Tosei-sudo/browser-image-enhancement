import { describe, expect, it } from 'vitest';
import { foldName, parseArcgis, parseFeatures, parseGsi, parseNominatim, PlaceSearch, readGazetteer, searchGazetteer } from '../src/geocode.js';

describe('parsers', () => {
  it('reads 国土地理院 AddressSearch', () => {
    const json = [{ geometry: { coordinates: [138.727363, 35.360626], type: 'Point' }, type: 'Feature', properties: { addressCode: '', title: '富士山' } }];
    expect(parseGsi(json, '地理院')).toEqual([{ name: '富士山', lonLat: [138.727363, 35.360626], source: '地理院' }]);
    expect(parseGsi({ error: 1 }, '地理院')).toEqual([]);
  });

  it('reads Nominatim with its bounding box as west, south, east, north', () => {
    const json = [{ lat: '35.6812', lon: '139.7671', display_name: '東京駅, 丸の内, 千代田区', type: 'station', boundingbox: ['35.67', '35.69', '139.76', '139.77'] }];
    expect(parseNominatim(json, 'OSM')).toEqual([{ name: '東京駅', detail: 'station、丸の内、千代田区', lonLat: [139.7671, 35.6812], extent: [139.76, 35.67, 139.77, 35.69], source: 'OSM' }]);
  });

  it('reads ArcGIS candidates', () => {
    const json = { candidates: [{ address: '横浜駅', location: { x: 139.62, y: 35.46 }, attributes: { Type: 'Train Station' }, extent: { xmin: 139.61, ymin: 35.45, xmax: 139.63, ymax: 35.47 } }] };
    expect(parseArcgis(json, 'Esri')).toEqual([{ name: '横浜駅', detail: 'Train Station', lonLat: [139.62, 35.46], extent: [139.61, 35.45, 139.63, 35.47], source: 'Esri' }]);
  });

  it('reads an Esri layer’s points, centroids and polygons', () => {
    const json = {
      features: [
        { attributes: { NAME: 'A港' }, geometry: { x: 135.1, y: 34.6 } },
        { attributes: { NAME: 'B地区' }, centroid: { x: 135.5, y: 34.7 }, geometry: { rings: [[[135, 34], [136, 34], [136, 35], [135, 34]]] } },
        { attributes: { NAME: 'C' }, geometry: { paths: [[[130, 30], [132, 32]]] } },
        { attributes: { NAME: null }, geometry: { x: 1, y: 1 } },
      ],
    };
    expect(parseFeatures(json, 'NAME', '社内')).toEqual([
      { name: 'A港', lonLat: [135.1, 34.6], source: '社内' },
      { name: 'B地区', lonLat: [135.5, 34.7], extent: [135, 34, 136, 35], source: '社内' },
      { name: 'C', lonLat: [131, 31], extent: [130, 30, 132, 32], source: '社内' },
    ]);
  });
});

describe('CSV gazetteer', () => {
  const csv = '名称,種別,緯度,経度\n横須賀港,港,35.28,139.67\n横浜港,港,35.45,139.65\nヨコハマ駅,駅,35.46,139.62\n壊れた行,,abc,1\n';
  const gazetteer = readGazetteer(csv, '社内');

  it('finds the name, latitude and longitude columns and keeps the rest as detail', () => {
    expect(gazetteer.rows).toHaveLength(3);
    expect(gazetteer.rows[0].place).toEqual({ name: '横須賀港', detail: '港', lonLat: [139.67, 35.28], source: '社内' });
  });

  it('matches names however they are typed, names starting with it first', () => {
    expect(searchGazetteer(gazetteer, '港').map((p) => p.name)).toEqual(['横浜港', '横須賀港']);
    expect(searchGazetteer(gazetteer, 'よこはま').map((p) => p.name)).toEqual(['ヨコハマ駅']);
    expect(searchGazetteer(gazetteer, '横').map((p) => p.name)).toEqual(['横浜港', '横須賀港']);
    expect(foldName('ＡＢＣ ｶﾀｶﾅ')).toBe('abcかたかな');
  });

  it('says which columns are missing', () => {
    expect(() => readGazetteer('a,b\n1,2\n', '社内')).toThrow('緯度');
  });
});

describe('PlaceSearch', () => {
  it('asks every geocoder, keeps their order, and reports the ones that fail', async () => {
    const fake = (async (url: string) => {
      if (url.startsWith('https://gsi.test')) return new Response(JSON.stringify([{ geometry: { coordinates: [139, 35] }, properties: { title: '地理院の場所' } }]));
      if (url === 'https://csv.test/places.csv') return new Response('name,lat,lon\n社内の場所,36,140\n');
      return new Response('', { status: 500 });
    }) as typeof fetch;
    const search = new PlaceSearch(
      [
        { type: 'csv', label: '社内', url: 'https://csv.test/places.csv' },
        { type: 'gsi', label: '地理院', url: 'https://gsi.test/AddressSearch' },
        { type: 'nominatim', label: 'OSM', url: 'https://osm.test' },
      ],
      fake,
    );
    const { places, errors } = await search.search('場所');
    expect(places.map((p) => [p.name, p.source])).toEqual([
      ['社内の場所', '社内'],
      ['地理院の場所', '地理院'],
    ]);
    expect(errors).toEqual(['OSM: HTTP 500']);
    expect(new PlaceSearch([]).enabled).toBe(false);
  });
});
