/**
 * WFS-T: the edits of a WFS layer sent as one Transaction (Insert, Update,
 * Delete) in the WFS version the layer was read with: GML 3.2 and FES 2.0
 * for 2.0.0, GML 3.1.1 and Filter 1.1 for 1.1.0, GML 2 for 1.0.0. The
 * answer's TransactionSummary is reported, the ids of inserted features are
 * set, and an exception refuses every edit (a transaction is all or nothing).
 */
import type Feature from 'ol/Feature.js';
import type Geometry from 'ol/geom/Geometry.js';
import type { Coordinate } from 'ol/coordinate.js';
import { request } from './common.js';
import type { Field } from './common.js';
import type { DrawableType, EditTarget } from '../edit-session.js';

export type WfsVersion = '2.0.0' | '1.1.0' | '1.0.0';

/** What the server allows on a feature type. */
export interface WfsOperations {
  insert: boolean;
  update: boolean;
  delete: boolean;
}

/** What a transaction needs to know of a feature type. */
export interface WfsSchema {
  /** The type name as the server lists it (`prefix:name` or `name`). */
  typeName: string;
  /** The type's namespace (DescribeFeatureType's targetNamespace). */
  namespace: string;
  /** The geometry property and its drawable type (null: any). */
  geometryName: string;
  geometryType: DrawableType | null;
  /** The properties in schema order (geometry included), for inserts. */
  order: string[];
}

const NS: Record<WfsVersion, { wfs: string; filter: string; gml: string; filterPrefix: string }> = {
  '2.0.0': { wfs: 'http://www.opengis.net/wfs/2.0', filter: 'http://www.opengis.net/fes/2.0', gml: 'http://www.opengis.net/gml/3.2', filterPrefix: 'fes' },
  '1.1.0': { wfs: 'http://www.opengis.net/wfs', filter: 'http://www.opengis.net/ogc', gml: 'http://www.opengis.net/gml', filterPrefix: 'ogc' },
  '1.0.0': { wfs: 'http://www.opengis.net/wfs', filter: 'http://www.opengis.net/ogc', gml: 'http://www.opengis.net/gml', filterPrefix: 'ogc' },
};

/** The drawable type of a GML geometry property type (`gml:MultiSurfacePropertyType`…); null for any geometry. */
export function drawableOf(gmlType: string): DrawableType | null {
  const t = gmlType.replace(/^.*:/, '').replace(/PropertyType$/, '');
  const types: Record<string, DrawableType> = {
    Point: 'Point',
    MultiPoint: 'MultiPoint',
    LineString: 'LineString',
    Curve: 'LineString',
    MultiLineString: 'MultiLineString',
    MultiCurve: 'MultiLineString',
    Polygon: 'Polygon',
    Surface: 'Polygon',
    MultiPolygon: 'MultiPolygon',
    MultiSurface: 'MultiPolygon',
  };
  return types[t] ?? null;
}

export function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/** Whether coordinates go latitude first in `srsName`: a geographic CRS named as a URN or URI (not `EPSG:4326`). */
export function latitudeFirst(srsName: string, geographic: boolean): boolean {
  return geographic && /^(urn:ogc:def:crs:EPSG:|https?:\/\/www\.opengis\.net\/def\/crs\/EPSG\/)/i.test(srsName);
}

/**
 * A geometry (in the layer's CRS) as GML of the version's flavour. `swap`
 * writes y before x.
 */
export function gmlGeometry(geometry: Geometry, version: WfsVersion, srsName: string, swap: boolean, ids: { next: number } = { next: 1 }): string {
  const gml2 = version === '1.0.0';
  const gml32 = version === '2.0.0';
  const xy = (c: Coordinate) => (swap ? [c[1], c[0]] : [c[0], c[1]]).map((n) => String(+n.toPrecision(15)));
  const pos = (c: Coordinate) => (gml2 ? `<gml:coordinates decimal="." cs="," ts=" ">${xy(c).join(',')}</gml:coordinates>` : `<gml:pos srsDimension="2">${xy(c).join(' ')}</gml:pos>`);
  const list = (cs: Coordinate[]) => (gml2 ? `<gml:coordinates decimal="." cs="," ts=" ">${cs.map((c) => xy(c).join(',')).join(' ')}</gml:coordinates>` : `<gml:posList srsDimension="2">${cs.map((c) => xy(c).join(' ')).join(' ')}</gml:posList>`);
  // GML 3.2 asks for an id on each geometry.
  const open = (name: string, top: boolean) => `<gml:${name}${top ? ` srsName="${escapeXml(srsName)}"` : ''}${gml32 ? ` gml:id="g${ids.next++}"` : ''}>`;
  const point = (c: Coordinate, top: boolean) => `${open('Point', top)}${pos(c)}</gml:Point>`;
  const line = (cs: Coordinate[], top: boolean) => `${open('LineString', top)}${list(cs)}</gml:LineString>`;
  const ring = (cs: Coordinate[]) => `<gml:LinearRing>${list(cs)}</gml:LinearRing>`;
  const polygon = (rings: Coordinate[][], top: boolean) =>
    `${open('Polygon', top)}${rings
      .map((r, i) => (gml2 ? (i === 0 ? `<gml:outerBoundaryIs>${ring(r)}</gml:outerBoundaryIs>` : `<gml:innerBoundaryIs>${ring(r)}</gml:innerBoundaryIs>`) : i === 0 ? `<gml:exterior>${ring(r)}</gml:exterior>` : `<gml:interior>${ring(r)}</gml:interior>`))
      .join('')}</gml:Polygon>`;
  const multi = (name: string, member: string, parts: string[]) => `${open(name, true)}${parts.map((p) => `<gml:${member}>${p}</gml:${member}>`).join('')}</gml:${name}>`;
  const g = geometry as unknown as { getType(): string; getCoordinates(): unknown };
  switch (g.getType()) {
    case 'Point':
      return point(g.getCoordinates() as Coordinate, true);
    case 'LineString':
      return line(g.getCoordinates() as Coordinate[], true);
    case 'Polygon':
      return polygon(g.getCoordinates() as Coordinate[][], true);
    case 'MultiPoint':
      return multi('MultiPoint', 'pointMember', (g.getCoordinates() as Coordinate[]).map((c) => point(c, false)));
    case 'MultiLineString':
      return gml2
        ? multi('MultiLineString', 'lineStringMember', (g.getCoordinates() as Coordinate[][]).map((c) => line(c, false)))
        : multi('MultiCurve', 'curveMember', (g.getCoordinates() as Coordinate[][]).map((c) => line(c, false)));
    case 'MultiPolygon':
      return gml2
        ? multi('MultiPolygon', 'polygonMember', (g.getCoordinates() as Coordinate[][][]).map((c) => polygon(c, false)))
        : multi('MultiSurface', 'surfaceMember', (g.getCoordinates() as Coordinate[][][]).map((c) => polygon(c, false)));
    default:
      throw new Error(`${g.getType()} は書けません`);
  }
}

/** A property value as text (null and undefined: none). */
function valueText(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export interface TransactionInput {
  version: WfsVersion;
  schema: WfsSchema;
  srsName: string;
  /** Write y before x (see {@link latitudeFirst}). */
  swap: boolean;
  /** Geometries are in the layer's CRS already. */
  inserts: Array<{ properties: Record<string, unknown>; geometry: Geometry | null }>;
  updates: Array<{ id: string; properties: Record<string, unknown>; geometry?: Geometry | null }>;
  deletes: string[];
}

/** The Transaction document of the edits. */
export function transactionXml(input: TransactionInput): string {
  const { version, schema, srsName, swap } = input;
  const ns = NS[version];
  const [prefixPart, localPart] = schema.typeName.includes(':') ? schema.typeName.split(':', 2) : ['feature', schema.typeName];
  const prefix = /^[A-Za-z_][\w.-]*$/.test(prefixPart) ? prefixPart : 'feature';
  const local = escapeXml(localPart);
  const typeName = `${prefix}:${local}`;
  const f = ns.filterPrefix;
  const ids = { next: 1 };
  const property = (name: string) => `${prefix}:${escapeXml(name)}`;
  const filter = (id: string) =>
    version === '2.0.0' ? `<fes:Filter><fes:ResourceId rid="${escapeXml(id)}"/></fes:Filter>` : `<ogc:Filter><ogc:FeatureId fid="${escapeXml(id)}"/></ogc:Filter>`;
  const parts: string[] = [];
  for (const insert of input.inserts) {
    const body: string[] = [];
    const names = [...schema.order, ...Object.keys(insert.properties).filter((n) => !schema.order.includes(n))];
    for (const name of names) {
      if (name === schema.geometryName) {
        if (insert.geometry) body.push(`<${property(name)}>${gmlGeometry(insert.geometry, version, srsName, swap, ids)}</${property(name)}>`);
        continue;
      }
      const text = valueText(insert.properties[name]);
      if (text !== null) body.push(`<${property(name)}>${escapeXml(text)}</${property(name)}>`);
    }
    parts.push(`<wfs:Insert><${typeName}>${body.join('')}</${typeName}></wfs:Insert>`);
  }
  const nameTag = version === '2.0.0' ? 'ValueReference' : 'Name';
  for (const update of input.updates) {
    const props: string[] = [];
    for (const [name, value] of Object.entries(update.properties)) {
      const text = valueText(value);
      props.push(`<wfs:Property><wfs:${nameTag}>${escapeXml(name)}</wfs:${nameTag}>${text === null ? '' : `<wfs:Value>${escapeXml(text)}</wfs:Value>`}</wfs:Property>`);
    }
    if (update.geometry) {
      props.push(`<wfs:Property><wfs:${nameTag}>${escapeXml(schema.geometryName)}</wfs:${nameTag}><wfs:Value>${gmlGeometry(update.geometry, version, srsName, swap, ids)}</wfs:Value></wfs:Property>`);
    }
    if (props.length) parts.push(`<wfs:Update typeName="${typeName}">${props.join('')}${filter(update.id)}</wfs:Update>`);
  }
  for (const id of input.deletes) parts.push(`<wfs:Delete typeName="${typeName}">${filter(id)}</wfs:Delete>`);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<wfs:Transaction service="WFS" version="${version}" xmlns:wfs="${ns.wfs}" xmlns:${f}="${ns.filter}" xmlns:gml="${ns.gml}" xmlns:${prefix}="${escapeXml(schema.namespace)}">` +
    parts.join('') +
    `</wfs:Transaction>`
  );
}

/** What the server answered a transaction. */
export interface TransactionResult {
  ok: boolean;
  inserted: number;
  updated: number;
  deleted: number;
  /** Ids of the inserted features, in order. */
  insertIds: string[];
  /** The exception's text, when the server refused. */
  message?: string;
}

const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Reads a TransactionResponse (2.0, 1.1), WFS_TransactionResponse (1.0) or an exception report. */
export function parseTransactionResponse(text: string): TransactionResult {
  const result: TransactionResult = { ok: false, inserted: 0, updated: 0, deleted: 0, insertIds: [] };
  const exception = /<(?:[\w-]+:)?(ExceptionReport|ServiceExceptionReport)\b/.test(text);
  const failed = /<(?:[\w-]+:)?Status>\s*<(?:[\w-]+:)?FAILED\b/.test(text);
  if (exception || failed) {
    const message = /<(?:[\w-]+:)?(?:ExceptionText|ServiceException|Message)\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?(?:ExceptionText|ServiceException|Message)>/.exec(text)?.[1];
    result.message = message ? unescape(message.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim().replace(/\s+/g, ' ').slice(0, 300) : 'サーバーが拒否しました';
    return result;
  }
  if (!/TransactionResponse\b/.test(text)) {
    result.message = '応答が TransactionResponse ではありません';
    return result;
  }
  const total = (name: string) => Number(new RegExp(`<(?:[\\w-]+:)?${name}>\\s*(\\d+)\\s*<`).exec(text)?.[1] ?? 0);
  result.inserted = total('totalInserted');
  result.updated = total('totalUpdated') + total('totalReplaced');
  result.deleted = total('totalDeleted');
  const inserts = /<(?:[\w-]+:)?(InsertResults|InsertResult)\b[\s\S]*?<\/(?:[\w-]+:)?\1>/.exec(text)?.[0] ?? '';
  for (const m of inserts.matchAll(/\b(?:fid|rid)="([^"]*)"/g)) if (m[1] !== 'none') result.insertIds.push(unescape(m[1]));
  // 1.0: one InsertResult per Insert, its count from the ids.
  if (!/totalInserted/.test(text)) result.inserted = result.insertIds.length;
  result.ok = true;
  return result;
}

/** What a WFS-T edit target needs. */
export interface WfsTargetOptions {
  endpoint: string;
  version: WfsVersion;
  schema: WfsSchema;
  operations: WfsOperations;
  srsName: string;
  /** From the map's features (EPSG:3857) to the layer's CRS. */
  toLayer: (geometry: Geometry) => Geometry;
  swap: boolean;
  fields: Field[];
}

/** An editable WFS layer: the edits go to the server as one Transaction. */
export function wfsTarget(options: WfsTargetOptions): EditTarget {
  const { schema, operations } = options;
  const editable = new Set(options.fields.filter((f) => f.editable).map((f) => f.name));
  const attributes = (f: Feature, names: Iterable<string>) => Object.fromEntries([...names].filter((n) => editable.has(n)).map((n) => [n, f.get(n) ?? null]));
  const geometry = (f: Feature) => {
    const g = f.getGeometry();
    return g ? options.toLayer(g) : null;
  };
  return {
    canCreate: operations.insert,
    canUpdate: operations.update,
    canDelete: operations.delete,
    geometryType: schema.geometryType,
    template: {},
    savedTo: 'サーバー（WFS-T）',
    async save({ adds, updates, deletes }) {
      const refused = new Map<Feature, string>();
      const missing = [...updates.map((u) => u.feature), ...deletes].filter((f) => f.getId() === undefined);
      if (missing.length) {
        for (const f of missing) refused.set(f, 'ID がない地物は変更できません');
        return { refused };
      }
      const xml = transactionXml({
        version: options.version,
        schema,
        srsName: options.srsName,
        swap: options.swap,
        inserts: adds.map((f) => ({ properties: attributes(f, Object.keys(f.getProperties())), geometry: geometry(f) })),
        updates: updates.map(({ feature: f, attributes: names, geometry: moved }) => ({ id: String(f.getId()), properties: attributes(f, names), ...(moved ? { geometry: geometry(f) } : {}) })),
        deletes: deletes.map((f) => String(f.getId())),
      });
      const all = [...adds, ...updates.map((u) => u.feature), ...deletes];
      let text: string;
      try {
        text = await (await request(options.endpoint, { method: 'POST', body: xml, headers: { 'Content-Type': 'text/xml; charset=UTF-8' } })).text();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const f of all) refused.set(f, message);
        return { refused };
      }
      const result = parseTransactionResponse(text);
      if (!result.ok) {
        for (const f of all) refused.set(f, result.message ?? 'サーバーが拒否しました');
        return { refused };
      }
      adds.forEach((f, i) => {
        const id = result.insertIds[i];
        if (id) f.setId(id);
      });
      return { refused, note: `WFS-T: 追加 ${result.inserted}・更新 ${result.updated}・削除 ${result.deleted}` };
    },
  };
}
