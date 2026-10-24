import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';
import {
  checkValues,
  classifyUrl,
  esriField,
  esriJobState,
  esriMessages,
  esriOutput,
  esriParams,
  esriSrs,
  ogcField,
  ogcInputs,
  ogcJobState,
  ogcOutputs,
  ogcProcessesUrl,
  parseEsriService,
  parseEsriTask,
  parseOgcProcess,
  parseOgcProcessList,
  safeUrl,
  type GpTask,
} from '../src/gp/model.js';
import { sameOrigin } from '../src/gp/client.js';

const p = (extra: Record<string, unknown>) => ({ direction: 'esriGPParameterDirectionInput', parameterType: 'esriGPParameterTypeRequired', ...extra });

describe('urls', () => {
  it('keeps only http(s) URLs', () => {
    expect(safeUrl('https://a.example/x')).toBe('https://a.example/x');
    expect(safeUrl('results/out', 'https://a.example/jobs/1/')).toBe('https://a.example/jobs/1/results/out');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('file:///etc/passwd')).toBeNull();
    expect(safeUrl('data:text/html,x')).toBeNull();
    expect(safeUrl(42)).toBeNull();
  });

  it('tells GPServers, tasks and OGC endpoints apart', () => {
    expect(classifyUrl('https://h/arcgis/rest/services/Tools/GPServer/')).toEqual({ kind: 'esri-service', root: 'https://h/arcgis/rest/services/Tools/GPServer' });
    expect(classifyUrl('https://h/arcgis/rest/services/Tools/GPServer/Buffer%20Points?f=json')).toEqual({ kind: 'esri-task', root: 'https://h/arcgis/rest/services/Tools/GPServer', task: 'Buffer Points' });
    expect(classifyUrl('https://h/ogc/processes')).toEqual({ kind: 'ogc', url: 'https://h/ogc/processes' });
  });

  it('sends tokens to the same origin only', () => {
    expect(sameOrigin('https://h/a/jobs/1', 'https://h/a')).toBe(true);
    expect(sameOrigin('https://evil.example/a', 'https://h/a')).toBe(false);
    expect(sameOrigin('http://h/a', 'https://h/a')).toBe(false);
  });
});

describe('Esri parameters → form', () => {
  it('maps every data type', () => {
    expect(esriField(p({ name: 's', dataType: 'GPString', defaultValue: 'x' }))).toMatchObject({ type: 'string', required: true, default: 'x' });
    expect(esriField(p({ name: 'c', dataType: 'GPString', choiceList: ['a', 'b'], defaultValue: 'b' }))).toMatchObject({ type: 'choice', choices: ['a', 'b'], default: 'b' });
    expect(esriField(p({ name: 'l', dataType: 'GPLong', defaultValue: 3 }))).toMatchObject({ type: 'integer', default: 3 });
    expect(esriField(p({ name: 'd', dataType: 'GPDouble' }))).toMatchObject({ type: 'number' });
    expect(esriField(p({ name: 'b', dataType: 'GPBoolean', defaultValue: true }))).toMatchObject({ type: 'boolean', default: true });
    expect(esriField(p({ name: 't', dataType: 'GPDate', defaultValue: 0 }))).toMatchObject({ type: 'date', default: '1970-01-01T00:00:00.000Z' });
    expect(esriField(p({ name: 'u', dataType: 'GPLinearUnit', defaultValue: { distance: 5, units: 'esriKilometers' } }))).toMatchObject({ type: 'linear-unit', default: 5, units: 'esriKilometers' });
    expect(esriField(p({ name: 'f', dataType: 'GPFeatureRecordSetLayer', defaultValue: { geometryType: 'esriGeometryPolygon', fields: [{ name: 'A', type: 'esriFieldTypeString' }] } }))).toMatchObject({
      type: 'features',
      geometry: 'Polygon',
      fields: [{ name: 'A', type: 'esriFieldTypeString' }],
    });
    expect(esriField(p({ name: 'r', dataType: 'GPRecordSet' }))).toMatchObject({ type: 'table' });
    expect(esriField(p({ name: 'img', dataType: 'GPRasterDataLayer', defaultValue: { url: 'javascript:x' } }))).toEqual(expect.objectContaining({ type: 'raster' }));
    expect(esriField(p({ name: 'img', dataType: 'GPRasterDataLayer', defaultValue: { url: 'javascript:x' } }))!.default).toBeUndefined();
    expect(esriField(p({ name: 'file', dataType: 'GPDataFile' }))).toMatchObject({ type: 'file' });
    expect(esriField(p({ name: 'm', dataType: 'GPMultiValue:GPString', defaultValue: ['a', 'b'] }))).toMatchObject({ type: 'multi', default: 'a, b' });
    expect(esriField(p({ name: 'o', dataType: 'GPString', parameterType: 'esriGPParameterTypeOptional' }))!.required).toBe(false);
  });

  it('skips outputs and derived parameters', () => {
    expect(esriField({ name: 'out', dataType: 'GPFeatureRecordSetLayer', direction: 'esriGPParameterDirectionOutput' })).toBeNull();
    expect(esriField(p({ name: 'x', dataType: 'GPString', parameterType: 'esriGPParameterTypeDerived' }))).toBeNull();
    expect(esriField('nonsense')).toBeNull();
  });

  it('reads a task and its service', () => {
    const task = parseEsriTask(
      'https://h/s/Folder/Tools/GPServer/Viewshed',
      {
        name: 'Viewshed',
        displayName: '可視領域',
        executionType: 'esriExecutionTypeAsynchronous',
        parameters: [p({ name: 'Point', dataType: 'GPFeatureRecordSetLayer' }), { name: 'Out', dataType: 'GPFeatureRecordSetLayer', displayName: '結果', direction: 'esriGPParameterDirectionOutput' }],
      },
      { tasks: ['Viewshed'], resultMapServerName: 'Tools' },
    );
    expect(task).toMatchObject({ kind: 'esri', id: 'Viewshed', title: '可視領域', async: true, resultMapServer: 'Tools', outputs: [{ name: 'Out', label: '結果' }] });
    expect(task.inputs).toHaveLength(1);
    expect(parseEsriService('https://h/s/Tools/GPServer', { tasks: ['Buffer', 'A B'] }).tasks).toEqual([
      { id: 'Buffer', title: 'Buffer', url: 'https://h/s/Tools/GPServer/Buffer' },
      { id: 'A B', title: 'A B', url: 'https://h/s/Tools/GPServer/A%20B' },
    ]);
    expect(() => parseEsriService('https://h', {})).toThrow();
    expect(() => parseEsriTask('https://h', { name: 'x' })).toThrow();
  });
});

describe('OGC inputs → form', () => {
  it('maps schemas', () => {
    expect(ogcField('s', { title: '名前', schema: { type: 'string' } })).toMatchObject({ type: 'string', label: '名前', required: true });
    expect(ogcField('e', { schema: { type: 'string', enum: ['a', 'b'], default: 'a' }, minOccurs: 0 })).toMatchObject({ type: 'choice', choices: ['a', 'b'], default: 'a', required: false });
    expect(ogcField('n', { schema: { type: 'number', minimum: 0, maximum: 10 } })).toMatchObject({ type: 'number', min: 0, max: 10 });
    expect(ogcField('i', { schema: { type: 'integer', default: 2 } })).toMatchObject({ type: 'integer', default: 2, required: false });
    expect(ogcField('b', { schema: { type: 'boolean' } })).toMatchObject({ type: 'boolean' });
    expect(ogcField('d', { schema: { type: 'string', format: 'date-time' } })).toMatchObject({ type: 'date' });
    expect(ogcField('g', { schema: { $ref: 'http://schemas.opengis.net/ogcapi/features/part1/1.0/openapi/schemas/geometryGeoJSON.yaml' } })).toMatchObject({ type: 'features', shape: 'geometry' });
    expect(ogcField('fc', { schema: { format: 'geojson-feature-collection' } })).toMatchObject({ type: 'features', shape: 'collection' });
    expect(ogcField('f', { schema: { oneOf: [{ type: 'string' }, { $ref: 'featureGeoJSON.yaml' }] } })).toMatchObject({ type: 'features', shape: 'feature' });
    expect(ogcField('x', { schema: { type: 'object' } })).toMatchObject({ type: 'json' });
  });

  it('reads a process list, a process and a landing page', () => {
    const list = parseOgcProcessList('https://h/ogc/processes', { processes: [{ id: 'buffer', title: 'Buffer' }, { title: 'no id' }] });
    expect(list.tasks).toEqual([{ id: 'buffer', title: 'Buffer', url: 'https://h/ogc/processes/buffer' }]);
    expect(ogcProcessesUrl('https://h/ogc/', { links: [{ rel: 'http://www.opengis.net/def/rel/ogc/1.0/processes', href: 'processes' }] })).toBe('https://h/ogc/processes');
    expect(ogcProcessesUrl('https://h/ogc/', { links: [{ rel: 'processes', href: 'javascript:x' }] })).toBeNull();
    const process = parseOgcProcess('https://h/ogc/processes/buffer', {
      id: 'buffer',
      jobControlOptions: ['sync-execute', 'async-execute'],
      inputs: { distance: { schema: { type: 'number' } } },
      outputs: { result: { title: '結果' } },
    });
    expect(process).toMatchObject({ kind: 'ogc', async: true, outputs: [{ name: 'result', label: '結果' }] });
  });
});

const square = () => new Feature({ geometry: new Polygon([[fromLonLat([139, 35]), fromLonLat([140, 35]), fromLonLat([140, 36]), fromLonLat([139, 35])]]), name: 'a', n: 1 });

describe('input serialisation', () => {
  const esriTask: GpTask = {
    kind: 'esri',
    url: 'https://h/GPServer/T',
    id: 'T',
    title: 'T',
    outputs: [],
    async: false,
    inputs: [
      esriField(p({ name: 'In', dataType: 'GPFeatureRecordSetLayer' }))!,
      esriField(p({ name: 'Dist', dataType: 'GPLinearUnit' }))!,
      esriField(p({ name: 'Flag', dataType: 'GPBoolean' }))!,
      esriField(p({ name: 'When', dataType: 'GPDate', parameterType: 'esriGPParameterTypeOptional' }))!,
      esriField(p({ name: 'Img', dataType: 'GPRasterDataLayer', parameterType: 'esriGPParameterTypeOptional' }))!,
      esriField(p({ name: 'Tags', dataType: 'GPMultiValue:GPString', parameterType: 'esriGPParameterTypeOptional' }))!,
    ],
  };

  it('writes Esri parameters', () => {
    const params = esriParams(esriTask, {
      In: { features: [square()], fields: [{ name: 'name', alias: 'name', type: 'string', editable: true, nullable: true }] },
      Dist: { distance: 100, units: 'esriMeters' },
      Flag: false,
      When: '2024-01-01T00:00:00.000Z',
      Img: 'https://h/img.tif',
      Tags: 'a, b',
    });
    expect(params['env:outSR']).toBe('102100');
    const set = JSON.parse(params.In);
    expect(set.geometryType).toBe('esriGeometryPolygon');
    expect(set.spatialReference.wkid).toBe(102100);
    expect(set.fields).toEqual([{ name: 'name', type: 'esriFieldTypeString', alias: 'name' }]);
    // Only listed attributes are sent.
    expect(set.features[0].attributes).toEqual({ name: 'a' });
    expect(set.features[0].geometry.rings[0]).toHaveLength(4);
    expect(JSON.parse(params.Dist)).toEqual({ distance: 100, units: 'esriMeters' });
    expect(params.Flag).toBe('false');
    expect(params.When).toBe(String(Date.UTC(2024, 0, 1)));
    expect(JSON.parse(params.Img)).toEqual({ url: 'https://h/img.tif' });
    expect(JSON.parse(params.Tags)).toEqual(['a', 'b']);
  });

  it('refuses missing required values and bad URLs', () => {
    expect(() => esriParams(esriTask, { In: null, Dist: null, Flag: false })).toThrow(/「In」/);
    expect(checkValues(esriTask, { In: { features: [square()], fields: [] }, Dist: { distance: 1, units: 'esriMeters' }, Flag: true, Img: 'javascript:alert(1)' })).toEqual(['「Img」は http(s) の URL で指定']);
  });

  it('writes OGC inputs', () => {
    const task: GpTask = {
      kind: 'ogc',
      url: 'https://h/processes/p',
      id: 'p',
      title: 'p',
      outputs: [],
      async: false,
      inputs: [ogcField('geom', { schema: { format: 'geojson-geometry' } }), ogcField('fc', { schema: { format: 'geojson-feature-collection' } }), ogcField('mode', { schema: { type: 'integer', enum: [1, 2] } }), ogcField('href', { schema: { type: 'string', format: 'uri' }, minOccurs: 0 })],
    };
    const inputs = ogcInputs(task, { geom: { features: [square()], fields: [] }, fc: { features: [square()], fields: [] }, mode: '2', href: 'https://h/a.tif' });
    expect((inputs.geom as { type: string }).type).toBe('Polygon');
    const ring = (inputs.geom as { coordinates: number[][][] }).coordinates[0];
    expect(ring[1][0]).toBeCloseTo(140, 6);
    expect(ring[2][1]).toBeCloseTo(36, 6);
    expect((inputs.fc as { type: string; features: unknown[] }).type).toBe('FeatureCollection');
    expect(inputs.mode).toBe(2);
    expect(inputs.href).toEqual({ href: 'https://h/a.tif' });
  });
});

describe('result parsing', () => {
  it('reads Esri feature sets in their spatial reference', () => {
    const out = esriOutput(
      {
        paramName: 'Out',
        dataType: 'GPFeatureRecordSetLayer',
        value: {
          geometryType: 'esriGeometryPoint',
          spatialReference: { wkid: 4326 },
          fields: [{ name: 'OBJECTID', type: 'esriFieldTypeOID' }, { name: 'NAME', type: 'esriFieldTypeString', alias: '名前' }, { name: 'Shape', type: 'esriFieldTypeGeometry' }],
          features: [{ geometry: { x: 139.7, y: 35.6 }, attributes: { OBJECTID: 1, NAME: '東京' } }],
        },
      },
      '結果',
      'EPSG:4326',
    )!;
    expect(out.kind).toBe('features');
    if (out.kind !== 'features') return;
    expect(out.label).toBe('結果');
    expect(out.srs).toBe('EPSG:4326');
    expect(out.fields.map((f) => [f.name, f.type, f.alias])).toEqual([
      ['OBJECTID', 'integer', 'OBJECTID'],
      ['NAME', 'string', '名前'],
    ]);
    const [lon, lat] = toLonLat((out.features[0].getGeometry() as Point).getCoordinates());
    expect(lon).toBeCloseTo(139.7, 6);
    expect(lat).toBeCloseTo(35.6, 6);
    expect(out.features[0].get('NAME')).toBe('東京');
  });

  it('caps the features read', () => {
    const features = Array.from({ length: 50_005 }, (_, i) => ({ geometry: { x: i, y: 0 }, attributes: {} }));
    const out = esriOutput({ paramName: 'Out', dataType: 'GPFeatureRecordSetLayer', value: { features } })!;
    expect(out.kind === 'features' && out.features.length).toBe(50_000);
    expect(out.kind === 'features' && out.truncated).toBe(true);
  });

  it('reads rasters, files and values', () => {
    expect(esriOutput({ paramName: 'R', dataType: 'GPRasterDataLayer', value: { url: 'https://h/out.tif' } })).toMatchObject({ kind: 'image', url: 'https://h/out.tif' });
    expect(esriOutput({ paramName: 'F', dataType: 'GPDataFile', value: { url: 'https://h/out.zip' } })).toMatchObject({ kind: 'link' });
    expect(esriOutput({ paramName: 'F', dataType: 'GPDataFile', value: { url: 'javascript:alert(1)' } })).toMatchObject({ kind: 'value' });
    expect(esriOutput({ paramName: 'N', dataType: 'GPDouble', value: 1.5 })).toMatchObject({ kind: 'value', text: '1.5' });
    expect(esriOutput({ paramName: 'U', dataType: 'GPLinearUnit', value: { distance: 3, units: 'esriKilometers' } })).toMatchObject({ text: '3 km' });
    expect(esriOutput({ paramName: 'S', dataType: 'GPString', value: 'x'.repeat(5000) })).toMatchObject({ kind: 'value' });
    expect((esriOutput({ paramName: 'S', dataType: 'GPString', value: 'x'.repeat(5000) }) as { text: string }).text.length).toBeLessThan(2100);
    expect(esriOutput('x')).toBeNull();
  });

  it('reads spatial references', () => {
    expect(esriSrs({ wkid: 102100, latestWkid: 3857 })).toBe('EPSG:3857');
    expect(esriSrs({ wkid: 6677 })).toBe('EPSG:6677');
    expect(esriSrs({ wkt: 'PROJCS["x"]' })).toBe('PROJCS["x"]');
    expect(esriSrs(null)).toBeNull();
  });

  it('reads OGC outputs', () => {
    const task = { outputs: [{ name: 'buffered', label: 'バッファ' }] } as GpTask;
    const [features] = ogcOutputs(task, { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [139, 35] }, properties: { a: 1, b: 'x', c: 1.5 } }] });
    expect(features).toMatchObject({ kind: 'features', name: 'buffered', label: 'バッファ' });
    if (features.kind === 'features') expect(features.fields.map((f) => [f.name, f.type])).toEqual([['a', 'integer'], ['b', 'string'], ['c', 'double']]);
    const outputs = ogcOutputs(task, { area: { value: 12, mediaType: 'application/json' }, image: { href: 'https://h/r.tif', type: 'image/tiff; application=geotiff' }, doc: { href: 'https://h/r.pdf' }, bad: { href: 'javascript:alert(1)' }, links: [] }, 'https://h/jobs/1/results');
    expect(outputs.map((o) => [o.name, o.kind])).toEqual([
      ['area', 'value'],
      ['image', 'image'],
      ['doc', 'link'],
      ['bad', 'value'],
    ]);
    expect(ogcOutputs(task, { outputs: [{ id: 'buffered', value: 3 }] })).toMatchObject([{ kind: 'value', text: '3', label: 'バッファ' }]);
  });

  it('reads job states and messages', () => {
    expect(esriJobState('esriJobSucceeded')).toBe('succeeded');
    expect(esriJobState('esriJobTimedOut')).toBe('failed');
    expect(esriJobState('esriJobExecuting')).toBe('running');
    expect(esriJobState('esriJobSubmitted')).toBe('waiting');
    expect(ogcJobState('successful')).toBe('succeeded');
    expect(ogcJobState('dismissed')).toBe('cancelled');
    expect(ogcJobState('accepted')).toBe('waiting');
    expect(esriMessages([{ type: 'esriJobMessageTypeError', description: 'bad' }, { type: 'esriJobMessageTypeInformative', description: 'ok' }, 'junk'])).toEqual(['エラー: bad', 'ok']);
  });
});
