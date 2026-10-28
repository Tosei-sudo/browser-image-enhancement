/**
 * WFS (2.0.0, 1.1.0 or 1.0.0): the feature types of GetCapabilities, read
 * whole with one GetFeature (up to {@link MAX_FEATURES}), as GeoJSON when the
 * server offers it and GML otherwise. Attribute types come from
 * DescribeFeatureType when the server answers it. Feature types the server
 * lets change (Transaction in GetCapabilities, and a namespace and geometry
 * in DescribeFeatureType) can be edited, saved as one WFS-T Transaction.
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
import { shiftTexts, timeZoneRuleFor } from '../time-zone.js';
import { drawableOf, latitudeFirst, wfsTarget, type WfsOperations, type WfsSchema, type WfsVersion } from './wfs-t.js';

interface FeatureType {
  name: string;
  title: string;
  abstract?: string;
  crs: string[];
  /** Longitude / latitude box. */
  box: Extent | null;
  formats: string[];
  /** What the server lets change on the type (WFS-T), or null. */
  operations: WfsOperations | null;
}

const XLINK = 'http://www.w3.org/1999/xlink';

/**
 * What a capabilities document lets change on each type: the Transaction
 * operation (OWS operations metadata of 1.1 and 2.0, `Request` of 1.0, and
 * 2.0's ImplementsTransactionalWFS constraint), narrowed by a type's own
 * `Operations` (1.0, 1.1) when it lists them. Also where to POST.
 */
export function transactionOf(doc: Document): { endpoint: string | null; forType: (ft: Element) => WfsOperations | null } {
  const transaction = descendants(doc, 'Operation').find((o) => o.getAttribute('name') === 'Transaction') ?? descendants(doc, 'Request').flatMap((r) => children(r, 'Transaction'))[0];
  const constraint = descendants(doc, 'Constraint').find((c) => c.getAttribute('name') === 'ImplementsTransactionalWFS');
  const off = constraint && /^false$/i.test(childText(constraint, 'DefaultValue') ?? '');
  const post = transaction ? descendants(transaction, 'Post')[0] : undefined;
  const endpoint = post ? post.getAttributeNS(XLINK, 'href') || post.getAttribute('onlineResource') : null;
  const all = !!transaction && !off;
  return {
    endpoint,
    forType: (ft) => {
      if (!all) return null;
      const listed = children(ft, 'Operations')[0];
      if (!listed) return { insert: true, update: true, delete: true };
      const names = new Set([...descendants(listed, 'Operation').map((o) => o.textContent?.trim() ?? ''), ...[...listed.children].map((c) => c.localName)].map((n) => n.toLowerCase()));
      const ops = { insert: names.has('insert'), update: names.has('update'), delete: names.has('delete') };
      return ops.insert || ops.update || ops.delete ? ops : null;
    },
  };
}

/** Reads WFS capabilities at `url`. */
export async function readWfs(url: string): Promise<ServiceCatalog> {
  const doc = await requestXml(withParams(url, { SERVICE: 'WFS', REQUEST: 'GetCapabilities', ACCEPTVERSIONS: '2.0.0,1.1.0,1.0.0' }));
  const root = doc.documentElement;
  if (root.localName !== 'WFS_Capabilities') throw new ServiceError('WFS の GetCapabilities 以外');
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

  const transaction = transactionOf(doc);
  const types: FeatureType[] = descendants(doc, 'FeatureType').map((ft) => {
    const crs = ['DefaultCRS', 'DefaultSRS', 'SRS', 'OtherCRS', 'OtherSRS'].flatMap((n) => children(ft, n).map((c) => c.textContent?.trim() ?? ''));
    return {
      name: childText(ft, 'Name') ?? '',
      title: childText(ft, 'Title') ?? childText(ft, 'Name') ?? '',
      abstract: childText(ft, 'Abstract'),
      crs: crs.filter(Boolean),
      box: geographicBox(ft),
      formats: [...descendants(ft, 'Format').map((f) => f.textContent?.trim() ?? ''), ...commonFormats],
      operations: transaction.forType(ft),
    };
  });
  if (types.length === 0) throw new ServiceError('フィーチャータイプなし');

  const choices: LayerChoice[] = types.map((t) => ({ name: t.name, title: t.title, abstract: t.abstract }));
  return {
    kind: 'wfs',
    url,
    title: descendants(doc, 'ServiceIdentification').map((s) => childText(s, 'Title'))[0] ?? descendants(doc, 'Service').map((s) => childText(s, 'Title'))[0] ?? url,
    choices,
    open: async (choice) => openType(types.find((t) => t.name === choice.name)!, { url, endpoint, version, transaction: transaction.endpoint ?? endpoint }),
  };
}

async function openType(type: FeatureType, ep: { url: string; endpoint: string; version: string; transaction: string }): Promise<ServiceLayer> {
  const v2 = ep.version.startsWith('2');
  const crs = type.crs.find((c) => epsgCode(c) === 3857) ?? type.crs[0] ?? 'EPSG:4326';
  const projection = await projectionOf(crs);
  if (!projection) throw new ServiceError(`${crs} に非対応`);
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
  const [text, described] = await Promise.all([
    request(withParams(ep.endpoint, params)).then((r) => r.text()),
    describe(ep.endpoint, type.name, ep.version).catch(() => null),
  ]);
  if (/^\s*</.test(text) && /ExceptionReport/.test(text.slice(0, 500))) {
    throw new ServiceError('GetFeature からエラー応答');
  }
  const read = { dataProjection: projection, featureProjection: projection };
  let features: Feature[];
  try {
    features = (json && /^\s*[{[]/.test(text)
      ? new GeoJSON().readFeatures(text, read)
      : new WFS({ version: ep.version as '1.0.0' | '1.1.0' | '2.0.0' }).readFeatures(text, read)) as Feature[];
  } catch {
    throw new ServiceError('地物の読み込みに失敗');
  }
  const truncated = features.length > MAX_FEATURES;
  if (truncated) features = features.slice(0, MAX_FEATURES);
  toMap(features, projection, type.box, 'EPSG:3857');
  // Dates in another zone than they say (config.json's timeZone).
  const zoneRule = timeZoneRuleFor(ep.url);
  const times = shiftTexts(features, zoneRule?.zone);

  const fields = described?.fields ?? null;
  const found = fieldsOf(features);
  const all: Field[] = fields ? [...fields, ...found.filter((f) => !fields.some((d) => d.name === f.name))] : found;
  const color = nextColor();
  const layer = vectorLayer(features);
  // Editable when the server allows a transaction and the schema says where the features and their geometry go.
  const schema = described?.schema;
  const version = (['2.0.0', '1.1.0', '1.0.0'].includes(ep.version) ? ep.version : null) as WfsVersion | null;
  if (type.operations && schema && version) for (const f of fields ?? []) f.editable = true;
  const editTarget =
    type.operations && schema && version
      ? wfsTarget({
          endpoint: ep.transaction,
          version,
          schema,
          operations: type.operations,
          srsName: crs,
          toLayer: (g) => g.clone().transform('EPSG:3857', projection),
          swap: latitudeFirst(crs, projection.getUnits() === 'degrees'),
          fields: all,
          times,
        })
      : undefined;
  return {
    ref: { kind: 'wfs', url: ep.url, layer: type.name },
    title: type.title,
    layer,
    correction: null,
    vector: { source: layer.getSource()!, fields: all, truncated },
    ...(editTarget ? { editTarget } : {}),
    style: new LayerStyle(layer, singleSpec(color)),
    extent: type.box ? transformExtent([type.box[0], Math.max(type.box[1], -85), type.box[2], Math.min(type.box[3], 85)], 'EPSG:4326', 'EPSG:3857') : null,
    info: [
      ['種類', 'WFS'],
      ['URL', ep.url],
      ['フィーチャータイプ', type.name],
      ['座標系', crs],
      ...(times ? [['日時のタイムゾーン', times.zone.name] as [string, string]] : []),
      ['地物数', `${features.length.toLocaleString()}${truncated ? `（先頭 ${MAX_FEATURES.toLocaleString()} 件）` : ''}`],
      ...(editTarget ? [['編集', `${[editTarget.canCreate && '追加', editTarget.canUpdate && '更新', editTarget.canDelete && '削除'].filter(Boolean).join('・')}（WFS-T）`] as [string, string]] : []),
    ],
  };
}

/** Attribute names and types from DescribeFeatureType (geometry left out), and what a transaction needs. */
async function describe(endpoint: string, name: string, version: string): Promise<{ fields: Field[]; schema: WfsSchema | null }> {
  const v2 = version.startsWith('2');
  const doc = await requestXml(withParams(endpoint, { SERVICE: 'WFS', VERSION: version, REQUEST: 'DescribeFeatureType', [v2 ? 'TYPENAMES' : 'TYPENAME']: name }));
  const fields: Field[] = [];
  const order: string[] = [];
  let geometry: { name: string; type: string } | null = null;
  for (const sequence of descendants(doc, 'sequence')) {
    for (const element of children(sequence, 'element')) {
      const fieldName = element.getAttribute('name');
      const type = (element.getAttribute('type') ?? descendants(element, 'restriction')[0]?.getAttribute('base') ?? '').replace(/^.*:/, '');
      if (fieldName) order.push(fieldName);
      if (fieldName && /PropertyType$|Geometry/i.test(type)) geometry ??= { name: fieldName, type };
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
  const namespace = doc.documentElement.getAttribute('targetNamespace');
  const schema: WfsSchema | null =
    namespace && geometry ? { typeName: name, namespace, geometryName: geometry.name, geometryType: drawableOf(geometry.type), order } : null;
  return { fields, schema };
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
