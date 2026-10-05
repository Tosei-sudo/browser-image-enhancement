/**
 * WFS (2.0.0, 1.1.0 or 1.0.0): the feature types of GetCapabilities, read
 * whole with one GetFeature (up to {@link MAX_FEATURES}), as GeoJSON when the
 * server offers it and GML otherwise. Attribute types come from
 * DescribeFeatureType when the server answers it.
 */
import type Feature from 'ol/Feature.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import WFS from 'ol/format/WFS.js';
import { transformExtent } from 'ol/proj.js';
import type { Extent } from 'ol/extent.js';
import {
  childText,
  children,
  descendants,
  epsgCode,
  MAX_FEATURES,
  nextColor,
  projectionOf,
  request,
  requestXml,
  ServiceError,
  withParams,
  type Field,
  type LayerChoice,
  type ServiceCatalog,
  type ServiceLayer,
} from './common.js';
import { toMap, vectorLayer } from './vector.js';
import { LayerStyle, singleSpec } from '../vector-style.js';
import { fieldsOf } from './wms.js';

interface FeatureType {
  name: string;
  title: string;
  abstract?: string;
  crs: string[];
  /** Longitude / latitude box. */
  box: Extent | null;
  formats: string[];
}

/** Reads WFS capabilities at `url`. */
export async function readWfs(url: string): Promise<ServiceCatalog> {
  const doc = await requestXml(withParams(url, { SERVICE: 'WFS', REQUEST: 'GetCapabilities', ACCEPTVERSIONS: '2.0.0,1.1.0,1.0.0' }));
  const root = doc.documentElement;
  if (root.localName !== 'WFS_Capabilities') throw new ServiceError('WFS の GetCapabilities ではありません');
  const version = root.getAttribute('version') ?? '2.0.0';

  const operation = (name: string) => descendants(doc, 'Operation').find((o) => o.getAttribute('name') === name);
  const getFeature = operation('GetFeature');
  const href = getFeature ? descendants(getFeature, 'Get')[0]?.getAttributeNS('http://www.w3.org/1999/xlink', 'href') : null;
  const endpoint = href || descendants(doc, 'GetFeature').flatMap((g) => descendants(g, 'Get'))[0]?.getAttribute('onlineResource') || url;
  // Output formats offered for every feature type.
  const commonFormats = [
    ...(getFeature ? descendants(getFeature, 'Parameter').filter((p) => /outputFormat/i.test(p.getAttribute('name') ?? '')) : []).flatMap((p) =>
      descendants(p, 'Value').map((v) => v.textContent?.trim() ?? ''),
    ),
    ...descendants(doc, 'ResultFormat').flatMap((r) => [...r.children].map((c) => c.localName)),
  ];

  const types: FeatureType[] = descendants(doc, 'FeatureType').map((ft) => {
    const crs = ['DefaultCRS', 'DefaultSRS', 'SRS', 'OtherCRS', 'OtherSRS'].flatMap((n) => children(ft, n).map((c) => c.textContent?.trim() ?? ''));
    return {
      name: childText(ft, 'Name') ?? '',
      title: childText(ft, 'Title') ?? childText(ft, 'Name') ?? '',
      abstract: childText(ft, 'Abstract'),
      crs: crs.filter(Boolean),
      box: geographicBox(ft),
      formats: [...descendants(ft, 'Format').map((f) => f.textContent?.trim() ?? ''), ...commonFormats],
    };
  });
  if (types.length === 0) throw new ServiceError('フィーチャータイプがありません');

  const choices: LayerChoice[] = types.map((t) => ({ name: t.name, title: t.title, abstract: t.abstract }));
  return {
    kind: 'wfs',
    url,
    title: descendants(doc, 'ServiceIdentification').map((s) => childText(s, 'Title'))[0] ?? descendants(doc, 'Service').map((s) => childText(s, 'Title'))[0] ?? url,
    choices,
    open: async (choice) => openType(types.find((t) => t.name === choice.name)!, { url, endpoint, version }),
  };
}

async function openType(type: FeatureType, ep: { url: string; endpoint: string; version: string }): Promise<ServiceLayer> {
  const v2 = ep.version.startsWith('2');
  const crs = type.crs.find((c) => epsgCode(c) === 3857) ?? type.crs[0] ?? 'EPSG:4326';
  const projection = await projectionOf(crs);
  if (!projection) throw new ServiceError(`${crs} に対応していません`);
  const json = type.formats.find((f) => /json/i.test(f));
  const params = {
    SERVICE: 'WFS',
    VERSION: ep.version,
    REQUEST: 'GetFeature',
    [v2 ? 'TYPENAMES' : 'TYPENAME']: type.name,
    [v2 ? 'COUNT' : 'MAXFEATURES']: MAX_FEATURES + 1,
    SRSNAME: crs,
    OUTPUTFORMAT: json,
  };
  const [text, fields] = await Promise.all([
    request(withParams(ep.endpoint, params)).then((r) => r.text()),
    describe(ep.endpoint, type.name, ep.version).catch(() => null),
  ]);
  if (/^\s*</.test(text) && /ExceptionReport/.test(text.slice(0, 500))) {
    throw new ServiceError('GetFeature がエラーを返しました');
  }
  const read = { dataProjection: projection, featureProjection: projection };
  let features: Feature[];
  try {
    features = (json && /^\s*[{[]/.test(text)
      ? new GeoJSON().readFeatures(text, read)
      : new WFS({ version: ep.version as '1.0.0' | '1.1.0' | '2.0.0' }).readFeatures(text, read)) as Feature[];
  } catch {
    throw new ServiceError('地物を読めませんでした');
  }
  const truncated = features.length > MAX_FEATURES;
  if (truncated) features = features.slice(0, MAX_FEATURES);
  toMap(features, projection, type.box, 'EPSG:3857');

  const found = fieldsOf(features);
  const all: Field[] = fields ? [...fields, ...found.filter((f) => !fields.some((d) => d.name === f.name))] : found;
  const color = nextColor();
  const layer = vectorLayer(features);
  return {
    ref: { kind: 'wfs', url: ep.url, layer: type.name },
    title: type.title,
    layer,
    correction: null,
    vector: { source: layer.getSource()!, fields: all, truncated },
    style: new LayerStyle(layer, singleSpec(color)),
    extent: type.box ? transformExtent([type.box[0], Math.max(type.box[1], -85), type.box[2], Math.min(type.box[3], 85)], 'EPSG:4326', 'EPSG:3857') : null,
    info: [
      ['種類', 'WFS'],
      ['URL', ep.url],
      ['フィーチャータイプ', type.name],
      ['座標系', crs],
      ['地物数', `${features.length.toLocaleString()}${truncated ? `（先頭 ${MAX_FEATURES.toLocaleString()} 件）` : ''}`],
    ],
  };
}

/** Attribute names and types from DescribeFeatureType (geometry left out). */
async function describe(endpoint: string, name: string, version: string): Promise<Field[]> {
  const v2 = version.startsWith('2');
  const doc = await requestXml(withParams(endpoint, { SERVICE: 'WFS', VERSION: version, REQUEST: 'DescribeFeatureType', [v2 ? 'TYPENAMES' : 'TYPENAME']: name }));
  const fields: Field[] = [];
  for (const sequence of descendants(doc, 'sequence')) {
    for (const element of children(sequence, 'element')) {
      const fieldName = element.getAttribute('name');
      const type = (element.getAttribute('type') ?? descendants(element, 'restriction')[0]?.getAttribute('base') ?? '').replace(/^.*:/, '');
      if (!fieldName || /PropertyType$|Geometry/i.test(type)) continue;
      fields.push({
        name: fieldName,
        alias: fieldName,
        type: /^(int|integer|long|short|byte)$/i.test(type) ? 'integer' : /^(double|float|decimal)$/i.test(type) ? 'double' : 'string',
        editable: false,
        nullable: element.getAttribute('nillable') !== 'false',
      });
    }
  }
  if (fields.length === 0) throw new Error('no fields');
  return fields;
}

/** WGS84BoundingBox (1.1, 2.0) or LatLongBoundingBox (1.0) as [west, south, east, north]. */
function geographicBox(ft: Element): Extent | null {
  const wgs = children(ft, 'WGS84BoundingBox')[0];
  if (wgs) {
    const lower = childText(wgs, 'LowerCorner')?.split(/\s+/).map(Number);
    const upper = childText(wgs, 'UpperCorner')?.split(/\s+/).map(Number);
    if (lower?.length === 2 && upper?.length === 2) return [lower[0], lower[1], upper[0], upper[1]];
  }
  const ll = children(ft, 'LatLongBoundingBox')[0];
  if (ll) return ['minx', 'miny', 'maxx', 'maxy'].map((k) => Number(ll.getAttribute(k))) as Extent;
  return null;
}
