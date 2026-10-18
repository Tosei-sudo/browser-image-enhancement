// Stand-ins for server-side processing, for the browser test (test/gp.spec.ts):
// an ArcGIS GPServer under /svc/gp/arcgis/rest/services/Tools/GPServer with a
// synchronous task (Buffer: squares around the points it is sent) and an
// asynchronous one (Slow: submitJob, polled jobs, results; it needs a token),
// and an OGC API – Processes endpoint under /svc/gp/ogc/ (a landing page,
// /processes, an asynchronous "centroid" process with jobs and results).

import { Buffer } from 'node:buffer';
import { URL, URLSearchParams } from 'node:url';

const GP = '/svc/gp/arcgis/rest/services/Tools/GPServer';
const OGC = '/svc/gp/ogc';
const TOKEN = 'secret';

/** Jobs by id: how many times each was polled, and whether it was cancelled. */
const jobs = new Map();
let nextJob = 1;

function body(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const json = (res, value, status = 200, headers = {}) =>
  res
    .writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Location', ...headers })
    .end(JSON.stringify(value));

const input = (name, dataType, extra = {}) => ({ name, dataType, displayName: name, direction: 'esriGPParameterDirectionInput', parameterType: 'esriGPParameterTypeRequired', ...extra });
const output = (name, dataType, displayName = name) => ({ name, dataType, displayName, direction: 'esriGPParameterDirectionOutput', parameterType: 'esriGPParameterTypeRequired' });

const tasks = {
  Buffer: {
    name: 'Buffer',
    displayName: 'バッファ',
    description: '点の周りに正方形を作ります',
    executionType: 'esriExecutionTypeSynchronous',
    parameters: [
      input('Input_Features', 'GPFeatureRecordSetLayer', { displayName: '入力', defaultValue: { geometryType: 'esriGeometryPoint', fields: [{ name: 'name', type: 'esriFieldTypeString' }] } }),
      input('Distance', 'GPLinearUnit', { displayName: '距離', defaultValue: { distance: 100, units: 'esriMeters' } }),
      input('Shape', 'GPString', { displayName: '形', parameterType: 'esriGPParameterTypeOptional', choiceList: ['square', 'diamond'], defaultValue: 'square' }),
      output('Output', 'GPFeatureRecordSetLayer', 'バッファ結果'),
      output('Count', 'GPLong', '件数'),
    ],
  },
  Slow: {
    name: 'Slow',
    displayName: '時間のかかる処理',
    executionType: 'esriExecutionTypeAsynchronous',
    parameters: [
      input('Name', 'GPString', { displayName: '名前' }),
      input('Seconds', 'GPLong', { displayName: '秒数', parameterType: 'esriGPParameterTypeOptional', defaultValue: 1 }),
      output('Out', 'GPFeatureRecordSetLayer', '地点'),
      output('Report', 'GPDataFile', 'レポート'),
    ],
  },
};

/** Squares of `distance` metres around each point (Web Mercator in, Web Mercator out). */
function buffer(params) {
  const set = JSON.parse(params.get('Input_Features') ?? '{"features":[]}');
  const { distance, units } = JSON.parse(params.get('Distance') ?? '{"distance":100}');
  const d = distance * (units === 'esriKilometers' ? 1000 : 1);
  const features = set.features.map((f) => {
    const { x, y } = f.geometry;
    return { geometry: { rings: [[[x - d, y - d], [x - d, y + d], [x + d, y + d], [x + d, y - d], [x - d, y - d]]] }, attributes: { ...f.attributes, BUFF_DIST: d } };
  });
  return {
    results: [
      {
        paramName: 'Output',
        dataType: 'GPFeatureRecordSetLayer',
        value: {
          geometryType: 'esriGeometryPolygon',
          spatialReference: { wkid: 102100, latestWkid: 3857 },
          fields: [{ name: 'name', type: 'esriFieldTypeString', alias: '名前' }, { name: 'BUFF_DIST', type: 'esriFieldTypeDouble' }],
          features,
        },
      },
      { paramName: 'Count', dataType: 'GPLong', value: features.length },
    ],
    messages: [{ type: 'esriJobMessageTypeInformative', description: `${features.length} features buffered` }],
  };
}

async function serveEsri(req, res, path) {
  const params = new URLSearchParams(req.method === 'POST' ? await body(req) : new URL(req.url, 'http://x').search);
  if (path === GP) return json(res, { tasks: Object.keys(tasks), executionType: 'esriExecutionTypeSynchronous' });
  const m = /^\/(Buffer|Slow)(?:\/(execute|submitJob|jobs\/(\w+)(?:\/(cancel|results\/(\w+)))?))?$/.exec(path.slice(GP.length));
  if (!m) return json(res, { error: { code: 400, message: 'Invalid URL' } });
  const [, task, action, jobId, sub, result] = m;
  if (!action) return json(res, tasks[task]);
  if (task === 'Slow' && params.get('token') !== TOKEN) return json(res, { error: { code: 499, message: 'Token Required' } });
  if (action === 'execute' && task === 'Buffer') return json(res, buffer(params));
  if (action === 'submitJob' && task === 'Slow') {
    const id = `j${nextJob++}`;
    jobs.set(id, { polls: 0, seconds: Number(params.get('Seconds') ?? 1), name: params.get('Name'), cancelled: false });
    return json(res, { jobId: id, jobStatus: 'esriJobSubmitted' });
  }
  const job = jobs.get(jobId);
  if (!job) return json(res, { error: { code: 400, message: 'No such job' } });
  if (sub === 'cancel') {
    job.cancelled = true;
    return json(res, { jobId, jobStatus: 'esriJobCancelled' });
  }
  if (result === 'Out') {
    return json(res, {
      paramName: 'Out',
      dataType: 'GPFeatureRecordSetLayer',
      // In WGS 84, to be reprojected by the viewer.
      value: { geometryType: 'esriGeometryPoint', spatialReference: { wkid: 4326 }, fields: [{ name: 'NAME', type: 'esriFieldTypeString' }], features: [{ geometry: { x: 139.76, y: 35.68 }, attributes: { NAME: job.name } }] },
    });
  }
  if (result === 'Report') return json(res, { paramName: 'Report', dataType: 'GPDataFile', value: { url: 'https://example.com/report.pdf' } });
  if (result) return json(res, { error: { code: 400, message: 'No such result' } });
  job.polls++;
  const done = !job.cancelled && job.seconds < 100 && job.polls >= 2;
  return json(res, {
    jobId,
    jobStatus: job.cancelled ? 'esriJobCancelled' : done ? 'esriJobSucceeded' : 'esriJobExecuting',
    messages: [{ type: 'esriJobMessageTypeInformative', description: 'Submitted.' }, { type: 'esriJobMessageTypeInformative', description: `Step ${job.polls}` }],
    results: done ? { Out: { paramUrl: 'results/Out' }, Report: { paramUrl: 'results/Report' } } : {},
  });
}

const centroidProcess = {
  id: 'centroid',
  title: '重心',
  description: 'GeoJSON の図形の重心を返します',
  jobControlOptions: ['async-execute'],
  inputs: {
    geom: { title: '図形', schema: { $ref: 'http://schemas.opengis.net/ogcapi/features/part1/1.0/openapi/schemas/geometryGeoJSON.yaml' } },
    label: { title: 'ラベル', schema: { type: 'string', enum: ['A', 'B'], default: 'A' }, minOccurs: 0 },
  },
  outputs: { result: { title: '重心点' }, area: { title: '頂点数' } },
};

async function serveOgc(req, res, path) {
  const rest = path.slice(OGC.length).replace(/\/+$/, '');
  if (rest === '') return json(res, { title: 'Test processes', links: [{ rel: 'http://www.opengis.net/def/rel/ogc/1.0/processes', href: `${OGC}/processes`, type: 'application/json' }] });
  if (rest === '/processes') return json(res, { processes: [{ id: 'centroid', title: '重心' }] });
  if (rest === '/processes/centroid') return json(res, centroidProcess);
  if (rest === '/processes/centroid/execution' && req.method === 'POST') {
    const { inputs } = JSON.parse(await body(req));
    const ring = inputs.geom.type === 'Polygon' ? inputs.geom.coordinates[0].slice(0, -1) : [inputs.geom.coordinates];
    const id = `o${nextJob++}`;
    jobs.set(id, { polls: 0, ring, label: inputs.label ?? null });
    if (req.headers.prefer !== 'respond-async') return json(res, { type: 'no-async', title: 'Prefer: respond-async expected' }, 400);
    return json(res, { jobID: id, status: 'accepted', type: 'process' }, 201, { location: `${OGC}/jobs/${id}` });
  }
  const m = /^\/jobs\/(\w+)(\/results)?$/.exec(rest);
  const job = m && jobs.get(m[1]);
  if (!job) return json(res, { type: 'not-found', title: 'Not found' }, 404);
  if (req.method === 'DELETE') return json(res, { jobID: m[1], status: 'dismissed' });
  if (m[2]) {
    const [lon, lat] = job.ring.reduce(([a, b], [x, y]) => [a + x / job.ring.length, b + y / job.ring.length], [0, 0]);
    return json(res, {
      result: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { label: job.label, vertices: job.ring.length } }] },
      area: { value: job.ring.length, mediaType: 'application/json' },
    });
  }
  job.polls++;
  const done = job.polls >= 2;
  return json(res, { jobID: m[1], status: done ? 'successful' : 'running', message: done ? '完了' : '計算中', progress: done ? 100 : 50, links: done ? [{ rel: 'http://www.opengis.net/def/rel/ogc/1.0/results', href: `${OGC}/jobs/${m[1]}/results` }] : [] });
}

/** Answers the processing stand-ins; false for other paths. */
export async function serveGp(req, res, url) {
  const path = url.pathname;
  if (path === GP || path.startsWith(`${GP}/`)) return (await serveEsri(req, res, path), true);
  if (path === OGC || path.startsWith(`${OGC}/`)) return (await serveOgc(req, res, path), true);
  return false;
}
