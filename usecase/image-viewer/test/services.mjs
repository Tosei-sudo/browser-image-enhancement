// Stand-ins for the services the viewer adds as layers, for the browser
// test: a WMS, a WMTS, a WFS and an Esri feature service (editable, with
// applyEdits), plus a secured Esri service that needs a token, and vector
// tiles for base maps (ArcGIS VectorTileServers, one secured, and plain
// {z}/{x}/{y}.pbf tiles). All of them
// allow CORS and live under /svc/.
import { Buffer } from 'node:buffer';
import { URLSearchParams } from 'node:url';
import { deflateSync } from 'node:zlib';

/** A solid PNG of `width` × `height` in the color [r, g, b, a]. */
export function png(width, height, [r, g, b, a = 255]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set([r, g, b, a], y * (width * 4 + 1) + 1 + x * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const tile = png(256, 256, [90, 110, 130]);

/** Web Mercator of a longitude / latitude. */
function mercator(lon, lat) {
  const x = (lon * 20037508.342789244) / 180;
  const y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * 6378137;
  return [x, y];
}

const wmsCapabilities = (base) => `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms" xmlns:xlink="http://www.w3.org/1999/xlink">
  <Service><Name>WMS</Name><Title>テスト WMS</Title></Service>
  <Capability>
    <Request>
      <GetCapabilities><Format>text/xml</Format><DCPType><HTTP><Get><OnlineResource xlink:href="${base}/svc/wms?"/></Get></HTTP></DCPType></GetCapabilities>
      <GetMap><Format>image/png</Format><Format>image/jpeg</Format><DCPType><HTTP><Get><OnlineResource xlink:href="${base}/svc/wms?"/></Get></HTTP></DCPType></GetMap>
      <GetFeatureInfo><Format>text/html</Format><Format>application/json</Format><DCPType><HTTP><Get><OnlineResource xlink:href="${base}/svc/wms?"/></Get></HTTP></DCPType></GetFeatureInfo>
    </Request>
    <Exception><Format>XML</Format></Exception>
    <Layer>
      <Title>ルート</Title>
      <CRS>EPSG:4326</CRS>
      <CRS>EPSG:3857</CRS>
      <Layer queryable="1">
        <Name>test:tokyo</Name>
        <Title>東京の地図</Title>
        <Abstract>テスト用の地図</Abstract>
        <EX_GeographicBoundingBox><westBoundLongitude>139.6</westBoundLongitude><eastBoundLongitude>139.9</eastBoundLongitude><southBoundLatitude>35.6</southBoundLatitude><northBoundLatitude>35.75</northBoundLatitude></EX_GeographicBoundingBox>
      </Layer>
    </Layer>
  </Capability>
</WMS_Capabilities>`;

function wmtsCapabilities(base) {
  const matrices = Array.from({ length: 19 }, (_, z) => {
    const n = 2 ** z;
    return `<TileMatrix><ows:Identifier>${z}</ows:Identifier><ScaleDenominator>${559082264.0287178 / n}</ScaleDenominator><TopLeftCorner>-20037508.3427892 20037508.3427892</TopLeftCorner><TileWidth>256</TileWidth><TileHeight>256</TileHeight><MatrixWidth>${n}</MatrixWidth><MatrixHeight>${n}</MatrixHeight></TileMatrix>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Capabilities xmlns="http://www.opengis.net/wmts/1.0" xmlns:ows="http://www.opengis.net/ows/1.1" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.0.0">
  <ows:ServiceIdentification><ows:Title>テスト WMTS</ows:Title><ows:ServiceType>OGC WMTS</ows:ServiceType><ows:ServiceTypeVersion>1.0.0</ows:ServiceTypeVersion></ows:ServiceIdentification>
  <Contents>
    <Layer>
      <ows:Title>東京のタイル</ows:Title>
      <ows:WGS84BoundingBox><ows:LowerCorner>139.6 35.6</ows:LowerCorner><ows:UpperCorner>139.9 35.75</ows:UpperCorner></ows:WGS84BoundingBox>
      <ows:Identifier>tokyo</ows:Identifier>
      <Style isDefault="true"><ows:Identifier>default</ows:Identifier></Style>
      <Format>image/png</Format>
      <TileMatrixSetLink><TileMatrixSet>GoogleMapsCompatible</TileMatrixSet></TileMatrixSetLink>
      <ResourceURL format="image/png" resourceType="tile" template="${base}/svc/wmts/tile/{TileMatrix}/{TileRow}/{TileCol}.png"/>
    </Layer>
    <TileMatrixSet>
      <ows:Identifier>GoogleMapsCompatible</ows:Identifier>
      <ows:SupportedCRS>urn:ogc:def:crs:EPSG::3857</ows:SupportedCRS>
      ${matrices}
    </TileMatrixSet>
  </Contents>
</Capabilities>`;
}

const wfsCapabilities = (base) => `<?xml version="1.0" encoding="UTF-8"?>
<wfs:WFS_Capabilities version="2.0.0" xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ows="http://www.opengis.net/ows/1.1" xmlns:xlink="http://www.w3.org/1999/xlink">
  <ows:ServiceIdentification><ows:Title>テスト WFS</ows:Title></ows:ServiceIdentification>
  <ows:OperationsMetadata>
    <ows:Operation name="GetFeature">
      <ows:DCP><ows:HTTP><ows:Get xlink:href="${base}/svc/wfs?"/></ows:HTTP></ows:DCP>
      <ows:Parameter name="outputFormat"><ows:AllowedValues><ows:Value>application/gml+xml; version=3.2</ows:Value><ows:Value>application/json</ows:Value></ows:AllowedValues></ows:Parameter>
    </ows:Operation>
  </ows:OperationsMetadata>
  <wfs:FeatureTypeList>
    <wfs:FeatureType>
      <wfs:Name>test:stations</wfs:Name>
      <wfs:Title>駅</wfs:Title>
      <wfs:DefaultCRS>urn:ogc:def:crs:EPSG::4326</wfs:DefaultCRS>
      <ows:WGS84BoundingBox><ows:LowerCorner>139.6 35.6</ows:LowerCorner><ows:UpperCorner>139.9 35.75</ows:UpperCorner></ows:WGS84BoundingBox>
    </wfs:FeatureType>
  </wfs:FeatureTypeList>
</wfs:WFS_Capabilities>`;

const describeStations = `<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:gml="http://www.opengis.net/gml/3.2">
  <xsd:complexType name="stationsType"><xsd:complexContent><xsd:extension base="gml:AbstractFeatureType"><xsd:sequence>
    <xsd:element name="geom" type="gml:PointPropertyType"/>
    <xsd:element name="name" type="xsd:string"/>
    <xsd:element name="passengers" type="xsd:int"/>
  </xsd:sequence></xsd:extension></xsd:complexContent></xsd:complexType>
</xsd:schema>`;

const stations = [
  ['東京', 139.7671, 35.6812, 462589],
  ['新宿', 139.7006, 35.6896, 650602],
  ['品川', 139.7387, 35.6285, 271340],
];

// Lat / lon order, as many servers send urn:ogc:def:crs:EPSG::4326: the viewer must swap it.
const stationsJson = () => ({
  type: 'FeatureCollection',
  features: stations.map(([name, lon, lat, passengers], i) => ({
    type: 'Feature',
    id: `stations.${i + 1}`,
    geometry: { type: 'Point', coordinates: [lat, lon] },
    properties: { name, passengers },
  })),
});

// ---- Esri ----

const parksLayer = {
  id: 0,
  name: '公園',
  type: 'Feature Layer',
  geometryType: 'esriGeometryPoint',
  objectIdField: 'OBJECTID',
  capabilities: 'Create,Delete,Query,Update,Editing',
  maxRecordCount: 2,
  extent: { xmin: 139.6, ymin: 35.6, xmax: 139.9, ymax: 35.75, spatialReference: { wkid: 4326 } },
  editFieldsInfo: { editorField: 'EDITOR' },
  fields: [
    { name: 'OBJECTID', type: 'esriFieldTypeOID', alias: 'OBJECTID', editable: false, nullable: false },
    { name: 'NAME', type: 'esriFieldTypeString', alias: '名称', length: 20, editable: true, nullable: true },
    {
      name: 'KIND',
      type: 'esriFieldTypeSmallInteger',
      alias: '種別',
      editable: true,
      nullable: true,
      domain: { type: 'codedValue', name: 'kinds', codedValues: [{ name: '公園', code: 1 }, { name: '広場', code: 2 }] },
    },
    { name: 'AREA', type: 'esriFieldTypeDouble', alias: '面積', editable: true, nullable: true, domain: { type: 'range', name: 'area', range: [0, 1000] } },
    { name: 'EDITOR', type: 'esriFieldTypeString', alias: '編集者', length: 50, editable: false, nullable: true },
  ],
  templates: [{ name: '公園', prototype: { attributes: { KIND: 1 } } }],
  drawingInfo: {
    renderer: {
      type: 'uniqueValue',
      field1: 'KIND',
      defaultSymbol: { type: 'esriSMS', style: 'esriSMSCircle', color: [128, 128, 128, 255], size: 8 },
      uniqueValueInfos: [
        { value: '1', symbol: { type: 'esriSMS', style: 'esriSMSCircle', color: [34, 139, 34, 255], size: 10, outline: { color: [255, 255, 255, 255], width: 1 } } },
        { value: '2', symbol: { type: 'esriSMS', style: 'esriSMSSquare', color: [30, 144, 255, 255], size: 10 } },
      ],
    },
  },
};

let parks;
let nextId;
export function resetServices() {
  parks = new Map(
    [
      ['日比谷公園', 139.7559, 35.6739, 1, 161.6],
      ['上野恩賜公園', 139.7714, 35.7148, 1, 538.4],
      ['新宿御苑', 139.7101, 35.6852, 1, 583.0],
      ['駅前広場', 139.7666, 35.681, 2, null],
      ['代々木公園', 139.6949, 35.6717, 1, 540.5],
    ].map(([NAME, lon, lat, KIND, AREA], i) => {
      const [x, y] = mercator(lon, lat);
      return [i + 1, { geometry: { x, y }, attributes: { OBJECTID: i + 1, NAME, KIND, AREA, EDITOR: 'initial' } }];
    }),
  );
  nextId = 6;
}
resetServices();

function applyEdits(form) {
  const adds = JSON.parse(form.get('adds') ?? '[]');
  const updates = JSON.parse(form.get('updates') ?? '[]');
  const deletes = (form.get('deletes') ?? '').split(',').filter(Boolean).map(Number);
  const refuse = (a) => a.NAME === 'NG' && { success: false, error: { code: 1000, description: '名前が不正です' } };
  const addResults = adds.map((f) => {
    const failed = refuse(f.attributes);
    if (failed) return failed;
    const id = nextId++;
    parks.set(id, { geometry: { x: f.geometry.x, y: f.geometry.y }, attributes: { NAME: null, KIND: null, AREA: null, ...f.attributes, OBJECTID: id, EDITOR: 'server' } });
    return { objectId: id, success: true };
  });
  const updateResults = updates.map((f) => {
    const id = f.attributes.OBJECTID;
    const park = parks.get(id);
    if (!park) return { objectId: id, success: false, error: { code: 1019, description: 'ありません' } };
    const failed = refuse({ ...park.attributes, ...f.attributes });
    if (failed) return { objectId: id, ...failed };
    Object.assign(park.attributes, f.attributes, { EDITOR: 'server' });
    if (f.geometry) park.geometry = { x: f.geometry.x, y: f.geometry.y };
    return { objectId: id, success: true };
  });
  const deleteResults = deletes.map((id) => ({ objectId: id, success: parks.delete(id) }));
  return { addResults, updateResults, deleteResults };
}

function query(form) {
  if (form.get('returnIdsOnly') === 'true') return { objectIdFieldName: 'OBJECTID', objectIds: [...parks.keys()] };
  const ids = (form.get('objectIds') ?? '').split(',').filter(Boolean).map(Number);
  if (ids.length > parksLayer.maxRecordCount) return { error: { code: 400, message: 'Too many ids' } };
  return {
    objectIdFieldName: 'OBJECTID',
    geometryType: 'esriGeometryPoint',
    spatialReference: { wkid: 102100, latestWkid: 3857 },
    fields: parksLayer.fields,
    features: ids.filter((id) => parks.has(id)).map((id) => parks.get(id)),
  };
}

/**
 * Town/FeatureServer/0: two multipatch buildings (footprints near Tokyo Station), with the
 * multipatch options of the query: `xyFootprint` gives each footprint
 * (Web Mercator), `extent` five points at the lowest and highest height.
 */
const buildings = [
  { id: 1, name: 'タワー', lon: 139.7671, lat: 35.6812, size: 0.0004, z: [0, 150] },
  { id: 2, name: 'ホール', lon: 139.7690, lat: 35.6812, size: 0.0006, z: [0, 30] },
];
export const buildingsLayer = {
  id: 0,
  name: '建物',
  type: 'Feature Layer',
  geometryType: 'esriGeometryMultiPatch',
  objectIdField: 'OBJECTID',
  capabilities: 'Query',
  maxRecordCount: 1000,
  supportedMultipatchOptions: 'xyFootprint,extent',
  fields: [
    { name: 'OBJECTID', type: 'esriFieldTypeOID', alias: 'OBJECTID' },
    { name: 'NAME', type: 'esriFieldTypeString', alias: '名称', length: 20 },
  ],
};

function buildingsQuery(form) {
  if (form.get('returnIdsOnly') === 'true') return { objectIdFieldName: 'OBJECTID', objectIds: buildings.map((b) => b.id) };
  const ids = (form.get('objectIds') ?? '').split(',').filter(Boolean).map(Number);
  const option = form.get('multipatchOption');
  if (form.get('returnGeometry') === 'true' && !option) return { error: { code: 400, message: 'multipatchOption is required' } };
  const square = (b) => [
    [b.lon, b.lat],
    [b.lon, b.lat + b.size],
    [b.lon + b.size, b.lat + b.size],
    [b.lon + b.size, b.lat],
    [b.lon, b.lat],
  ];
  const features = buildings
    .filter((b) => ids.includes(b.id))
    .map((b) => {
      const geometry =
        option === 'extent'
          ? { hasZ: true, rings: [[[b.lon, b.lat, b.z[0]], [b.lon, b.lat + b.size, b.z[0]], [b.lon + b.size, b.lat + b.size, b.z[1]], [b.lon + b.size, b.lat, b.z[0]], [b.lon, b.lat, b.z[0]]]] }
          : { rings: [square(b).map(([lon, lat]) => mercator(lon, lat))] };
      return { attributes: { OBJECTID: b.id, NAME: b.name }, geometry };
    });
  return { objectIdFieldName: 'OBJECTID', geometryType: 'esriGeometryPolygon', spatialReference: option === 'extent' ? { wkid: 4326 } : { wkid: 102100, latestWkid: 3857 }, fields: buildingsLayer.fields, features };
}

/** Protocol buffer pieces, enough to write a Mapbox Vector Tile. */
const varint = (n) => {
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
};
const field = (number, wire, payload) => Buffer.concat([varint((number << 3) | wire), ...(wire === 2 ? [varint(payload.length)] : []), payload]);
const bytes = (number, payload) => field(number, 2, payload);
const packed = (number, values) => bytes(number, Buffer.concat(values.map(varint)));
const zigzag = (n) => (n << 1) ^ (n >> 31);

/**
 * A vector tile with one layer `land`: a square covering the whole tile
 * (tagged `class=land`), so the map shows its fill wherever it is drawn.
 */
export function landTile() {
  const geometry = [9, zigzag(0), zigzag(0), 26, zigzag(4096), zigzag(0), zigzag(0), zigzag(4096), zigzag(-4096), zigzag(0), 15];
  const feature = Buffer.concat([field(1, 0, varint(1)), packed(2, [0, 0]), field(3, 0, varint(3)), packed(4, geometry)]);
  const layer = Buffer.concat([field(15, 0, varint(2)), bytes(1, Buffer.from('land')), bytes(2, feature), bytes(3, Buffer.from('class')), bytes(4, bytes(1, Buffer.from('land'))), field(5, 0, varint(4096))]);
  return bytes(3, layer);
}

/** The TIME of each GetMap of the WMS with a time dimension. */
export const wmsTimeRequests = [];

/** A WMS whose layer has a time dimension: monthly maps of 2024. */
const wmsTimeCapabilities = (base) =>
  wmsCapabilities(base)
    .replaceAll('/svc/wms?', '/svc/wmstime?')
    .replace('<Name>test:tokyo</Name>', '<Name>test:rain</Name>')
    .replace('<Title>東京の地図</Title>', '<Title>月ごとの雨量</Title><Dimension name="time" units="ISO8601" default="2024-12-01">2024-01-01/2024-12-01/P1M</Dimension>');

/** The vector tiles asked for, as paths with their query. */
export const vectorTileRequests = [];

/** The default style of the stand-in VectorTileServers: the land in green, as ArcGIS writes it (the source is the server, `../../`). */
const vtsStyle = {
  version: 8,
  sprite: '../sprites/sprite',
  glyphs: '../fonts/{fontstack}/{range}.pbf',
  sources: { esri: { type: 'vector', url: '../../' } },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#ffffff' } },
    { id: 'land', type: 'fill', source: 'esri', 'source-layer': 'land', paint: { 'fill-color': '#2e7d32' } },
  ],
};

/** Answers a request under /svc/, or returns false. */
export async function serveService(req, res, url, base) {
  const path = url.pathname;
  if (!path.startsWith('/svc/')) return false;
  const cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  const send = (type, body, status = 200) => res.writeHead(status, { ...cors, 'content-type': type }).end(body);
  const json = (body) => send('application/json', JSON.stringify(body));
  const p = Object.fromEntries([...url.searchParams].map(([k, v]) => [k.toUpperCase(), v]));
  let form = url.searchParams;
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    form = new URLSearchParams(body);
  }

  if (path === '/svc/reset') {
    resetServices();
    vectorTileRequests.length = 0;
    wmsTimeRequests.length = 0;
    return json({ ok: true });
  }
  if (path === '/svc/state') return json([...parks.values()]);
  if (path === '/svc/vector-tiles') return json(vectorTileRequests);
  if (path === '/svc/wms-times') return json(wmsTimeRequests);
  if (path === '/svc/wmstime') {
    if (p.REQUEST === 'GetCapabilities') return send('text/xml', wmsTimeCapabilities(base));
    if (p.REQUEST === 'GetMap') {
      wmsTimeRequests.push(p.TIME ?? null);
      return send('image/png', tile);
    }
  }

  const vts = /^\/svc\/arcgis\/rest\/services\/(OSM|SecureOSM)\/VectorTileServer(\/.*)?$/.exec(path);
  if (vts) {
    const [, service, rest = ''] = vts;
    if (service === 'SecureOSM' && url.searchParams.get('token') !== 'secret') {
      return rest.startsWith('/tile/') ? send('text/plain', 'Token Required', 403) : json({ error: { code: 499, message: 'Token Required', details: [] } });
    }
    if ((rest === '' || rest === '/') && url.searchParams.get('f') === 'json') {
      return json({
        currentVersion: 11.1,
        name: service,
        capabilities: 'TilesOnly',
        type: 'indexedVector',
        defaultStyles: 'resources/styles',
        tiles: ['tile/{z}/{y}/{x}.pbf'],
        copyrightText: 'テスト地図',
        tileInfo: { rows: 512, cols: 512, format: 'pbf', spatialReference: { wkid: 102100, latestWkid: 3857 }, lods: Array.from({ length: 23 }, (_, level) => ({ level })) },
        maxzoom: 14,
      });
    }
    if (rest === '' || rest === '/') return send('text/html', '<html><body>VectorTileServer</body></html>');
    if (rest === '/resources/styles/root.json') return json(vtsStyle);
    if (rest.startsWith('/tile/')) {
      vectorTileRequests.push(path + url.search);
      return send('application/x-protobuf', landTile());
    }
  }
  if (path.startsWith('/svc/mvt/')) {
    vectorTileRequests.push(path + url.search);
    return send('application/x-protobuf', landTile());
  }

  if (path === '/svc/wms') {
    if (p.REQUEST === 'GetCapabilities') return send('text/xml', wmsCapabilities(base));
    if (p.REQUEST === 'GetMap') return send('image/png', tile);
    if (p.REQUEST === 'GetFeatureInfo') {
      const [x, y] = mercator(139.7671, 35.6812);
      return json({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 'tokyo.1', geometry: { type: 'Point', coordinates: [x, y] }, properties: { name: '東京駅', id: 1 } }] });
    }
  }
  if (path === '/svc/wmts/WMTSCapabilities.xml') return send('text/xml', wmtsCapabilities(base));
  if (path.startsWith('/svc/wmts/tile/')) return send('image/png', tile);

  if (path === '/svc/wfs') {
    if (p.REQUEST === 'GetCapabilities') return send('text/xml', wfsCapabilities(base));
    if (p.REQUEST === 'DescribeFeatureType') return send('text/xml', describeStations);
    if (p.REQUEST === 'GetFeature') return json(stationsJson());
  }

  const esri = /^\/svc\/arcgis\/rest\/services\/(Test|Secure|Town)\/FeatureServer(?:\/(\d+))?(?:\/(query|applyEdits))?$/.exec(path);
  if (esri) {
    const [, service, layer, op] = esri;
    if (service === 'Secure' && form.get('token') !== 'secret') return json({ error: { code: 499, message: 'Token Required', details: [] } });
    if (service === 'Town') {
      if (layer === undefined) return json({ currentVersion: 11.1, layers: [{ id: 0, name: '建物', type: 'Feature Layer', geometryType: 'esriGeometryMultiPatch' }], tables: [] });
      if (!op) return json(buildingsLayer);
      if (op === 'query') return json(buildingsQuery(form));
    }
    if (layer === undefined) return json({ currentVersion: 11.1, layers: [{ id: 0, name: '公園', type: 'Feature Layer', geometryType: 'esriGeometryPoint' }], tables: [] });
    if (layer !== '0') return json({ error: { code: 400, message: 'Invalid layer' } });
    if (!op) return json(parksLayer);
    if (op === 'query') return json(query(form));
    if (op === 'applyEdits' && req.method === 'POST') return json(applyEdits(form));
  }
  send('text/plain', 'not found', 404);
  return true;
}
