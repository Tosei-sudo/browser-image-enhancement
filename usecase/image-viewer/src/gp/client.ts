/**
 * The requests of server-side geoprocessing: reading a GPServer or an OGC API
 * – Processes endpoint, and running a task — synchronously (`execute`, or an
 * OGC execute that answers at once) or as a job (`submitJob` / `Prefer:
 * respond-async`) polled until it ends, with messages and progress on the
 * way and cancelling on request.
 *
 * Responses are read as text up to a size cap and checked before use. A
 * token goes only to the service's own host (as a POST parameter for Esri,
 * so it stays out of URLs; as a bearer header for OGC), never to a URL a
 * response names on another host.
 */
import { tokenFor as authTokenFor } from '../auth.js';
import { epsgCode, projectionOf, request, ServiceError } from '../services/common.js';
import { crsCodeOfWkt } from '../processing/reproject.js';
import {
  classifyUrl,
  esriJobState,
  esriMessages,
  esriOutput,
  esriParams,
  esriSrs,
  jobStateNames,
  linkOf,
  ogcInputs,
  ogcJobState,
  ogcOutputs,
  ogcProcessesUrl,
  parseEsriService,
  parseEsriTask,
  parseOgcProcess,
  parseOgcProcessList,
  safeUrl,
  type GpOutput,
  type GpService,
  type GpTask,
  type GpValue,
} from './model.js';

/** The largest JSON response read (a feature set of 50,000 polygons fits). */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * The token for a processing service: the one typed in the dialog (or given
 * in config.json), else that of a sign-in (src/auth.ts) covering its host.
 */
export function gpToken(serviceUrl: string, typed?: string): string | undefined {
  // Nothing typed: the sign-in's token when the service is on a signed-in portal or its servers (auth.ts).
  return typed?.trim() || authTokenFor(serviceUrl);
}

/** Whether `url` is on the same host (origin) as `serviceUrl`: only then does a token go with it. */
export function sameOrigin(url: string, serviceUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(serviceUrl).origin;
  } catch {
    return false;
  }
}

/** A response's body as JSON, refusing one over {@link MAX_RESPONSE_BYTES}. */
async function readJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_RESPONSE_BYTES) throw new ServiceError(`応答が大きすぎ（${Math.round(length / 1e6)} MB）`);
  const body = await response.text();
  if (body.length > MAX_RESPONSE_BYTES) throw new ServiceError('応答が大きすぎ');
  try {
    return JSON.parse(body);
  } catch {
    throw new ServiceError('応答が JSON 以外');
  }
}

/** An ArcGIS REST call (always `f=json`); with a token it is a POST, and the token goes only to the service's host. */
async function esriCall(url: string, params: Record<string, string>, serviceUrl: string, token?: string, post = false): Promise<Record<string, unknown>> {
  const safe = safeUrl(url);
  if (!safe) throw new ServiceError('http(s) 以外の URL には接続不可');
  const own = token && sameOrigin(safe, serviceUrl) ? token : undefined;
  const all = new URLSearchParams({ ...params, f: 'json', ...(own ? { token: own } : {}) });
  const response =
    post || own
      ? await request(safe, { method: 'POST', body: all, headers: { 'content-type': 'application/x-www-form-urlencoded' } })
      : await request(`${safe}${safe.includes('?') ? '&' : '?'}${all}`);
  const json = await readJson(response);
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new ServiceError('応答の形式が不正');
  const error = (json as { error?: { code?: number; message?: string; details?: unknown } }).error;
  if (error) {
    if (error.code === 498 || error.code === 499 || error.code === 403) throw new ServiceError(own ? `トークンが無効か、権限なし（${String(error.message ?? '')}）` : 'このサービスにはトークンが必要');
    const details = Array.isArray(error.details) ? error.details.filter((d) => typeof d === 'string') : [];
    throw new ServiceError(`サービスからエラー応答: ${[String(error.message ?? ''), ...details].join(' ').slice(0, 500)}`);
  }
  return json as Record<string, unknown>;
}

/** An OGC API call: JSON in and out, the token as a bearer header to the service's host only. */
async function ogcCall(url: string, serviceUrl: string, token?: string, init: RequestInit = {}): Promise<{ json: unknown; response: Response }> {
  const safe = safeUrl(url);
  if (!safe) throw new ServiceError('http(s) 以外の URL には接続不可');
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (token && sameOrigin(safe, serviceUrl)) headers.set('authorization', `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(safe, { ...init, headers });
  } catch {
    throw new ServiceError('接続失敗（URL、またはサーバーが CORS を許可しているかを確認）');
  }
  if (response.status === 401 || response.status === 403) throw new ServiceError(token ? 'トークンが無効か、権限なし' : 'このサービスには認証が必要（トークンを入力）');
  if (!response.ok) {
    // An OGC exception: { type, title, detail }.
    const json = (await readJson(response).catch(() => null)) as { title?: unknown; detail?: unknown; description?: unknown } | null;
    const detail = [json?.title, json?.detail ?? json?.description].filter((s) => typeof s === 'string').join(': ');
    throw new ServiceError(`サーバーからエラー応答（HTTP ${response.status}）${detail ? `: ${detail.slice(0, 500)}` : ''}`);
  }
  if (response.status === 204) return { json: null, response };
  return { json: await readJson(response), response };
}

/** What a URL holds: a service with tasks to choose from, or one task. */
export type GpRead = { service: GpService } | { task: GpTask };

/**
 * Reads a processing endpoint: a GPServer (its tasks), a GP task, an OGC API
 * landing page or `/processes` (its processes), or one OGC process.
 */
export async function readGp(url: string, token?: string): Promise<GpRead> {
  if (!safeUrl(url)) throw new ServiceError('http(s) の URL を入力');
  const kind = classifyUrl(url);
  if (kind.kind === 'esri-service') return { service: parseEsriService(kind.root, await esriCall(kind.root, {}, kind.root, token)) };
  if (kind.kind === 'esri-task') return { task: await readTask({ kind: 'esri', url: `${kind.root}/${encodeURIComponent(kind.task)}` }, token) };
  const { json } = await ogcCall(kind.url, kind.url, token);
  const record = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  if (Array.isArray(record.processes)) return { service: parseOgcProcessList(kind.url, json) };
  if (typeof record.id === 'string' && ('inputs' in record || 'outputs' in record)) return { task: parseOgcProcess(kind.url, json) };
  const processes = ogcProcessesUrl(kind.url, json);
  if (!processes) throw new ServiceError('GPServer・GP タスク・OGC API – Processes のどれとしても読み込み失敗');
  const list = await ogcCall(processes, kind.url, token);
  return { service: parseOgcProcessList(processes, list.json) };
}

/** Reads one task of a service listed by {@link readGp}. */
export async function readTask(ref: { kind: 'esri' | 'ogc'; url: string }, token?: string): Promise<GpTask> {
  if (ref.kind === 'esri') {
    const root = ref.url.replace(/\/[^/]+\/?$/, '');
    const [task, service] = await Promise.all([esriCall(ref.url, {}, ref.url, token), esriCall(root, {}, root, token).catch(() => null)]);
    return parseEsriTask(ref.url, task, service);
  }
  return parseOgcProcess(ref.url, (await ogcCall(ref.url, ref.url, token)).json);
}

/** What a run reports on the way. */
export interface RunHooks {
  /** A status line, with the percentage done when the server says. */
  onStatus: (text: string, percent?: number) => void;
  /** Cancels a job (a synchronous request is left to finish, and its answer dropped). */
  signal?: AbortSignal;
  /** How long to wait between polls, in ms (tests make it short). */
  pollMs?: number;
}

/** What a run made. */
export interface RunResult {
  outputs: GpOutput[];
  messages: string[];
  /** Esri: the map service drawing the job's results (`…/MapServer/jobs/<id>`). */
  mapServer?: string;
}

/** Cancelled by the person. */
export class GpCancelled extends Error {
  constructor() {
    super('取り消し');
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new GpCancelled());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new GpCancelled());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Runs a task with the form's values. */
export async function runTask(task: GpTask, values: Record<string, GpValue>, token: string | undefined, hooks: RunHooks): Promise<RunResult> {
  return task.kind === 'esri' ? runEsri(task, values, token, hooks) : runOgc(task, values, token, hooks);
}

/** The projection a result's spatial reference names (its EPSG code, or the code of its WKT); the map's when unknown. */
async function resultProjection(srs: string | null): Promise<string> {
  if (!srs) return 'EPSG:3857';
  const code = srs.startsWith('EPSG:') ? srs : crsCodeOfWkt(srs);
  if (!code || epsgCode(code) === null) return 'EPSG:3857';
  return (await projectionOf(code))?.getCode() ?? 'EPSG:3857';
}

/** Reads one Esri result, its features reprojected from the result's own spatial reference. */
async function esriResult(json: unknown, task: GpTask, base: string): Promise<GpOutput | null> {
  const record = typeof json === 'object' && json !== null ? (json as { paramName?: unknown; value?: { spatialReference?: unknown } }) : null;
  if (!record) return null;
  const label = task.outputs.find((o) => o.name === record.paramName)?.label;
  const projection = await resultProjection(esriSrs(record.value?.spatialReference));
  return esriOutput(json, label, projection, base);
}

async function runEsri(task: GpTask, values: Record<string, GpValue>, token: string | undefined, hooks: RunHooks): Promise<RunResult> {
  const params = esriParams(task, values);
  if (!task.async) {
    hooks.onStatus('実行中…');
    const json = await esriCall(`${task.url}/execute`, params, task.url, token, true);
    if (hooks.signal?.aborted) throw new GpCancelled();
    const results = Array.isArray(json.results) ? json.results.slice(0, 200) : [];
    const outputs = (await Promise.all(results.map((r) => esriResult(r, task, task.url)))).filter((o): o is GpOutput => o !== null);
    return { outputs, messages: esriMessages(json.messages) };
  }
  const submitted = await esriCall(`${task.url}/submitJob`, params, task.url, token, true);
  const jobId = submitted.jobId;
  if (typeof jobId !== 'string' || !/^[\w.-]{1,200}$/.test(jobId)) throw new ServiceError('ジョブ ID の返却なし');
  const jobUrl = `${task.url}/jobs/${encodeURIComponent(jobId)}`;
  let job: Record<string, unknown> = submitted;
  let delay = hooks.pollMs ?? 1000;
  try {
    for (;;) {
      const state = esriJobState(job.jobStatus);
      const messages = esriMessages(job.messages);
      const progress = job.progress as { message?: unknown; percent?: unknown } | undefined;
      const percent = typeof progress?.percent === 'number' ? progress.percent : undefined;
      const last = typeof progress?.message === 'string' ? progress.message : messages.at(-1);
      hooks.onStatus(`ジョブ ${jobStateNames[state]}${last ? `: ${last.slice(0, 200)}` : ''}`, percent);
      if (state === 'succeeded') break;
      if (state === 'failed') throw new ServiceError(`ジョブが失敗${messages.length ? `: ${messages.filter((m) => m.startsWith('エラー')).slice(-3).join(' / ') || messages.at(-1)}` : ''}`);
      if (state === 'cancelled') throw new GpCancelled();
      await sleep(delay, hooks.signal);
      delay = Math.min(delay * 1.5, 5000);
      job = await esriCall(jobUrl, {}, task.url, token);
    }
  } catch (error) {
    if (error instanceof GpCancelled) {
      hooks.onStatus('取り消し中…');
      await esriCall(`${jobUrl}/cancel`, {}, task.url, token, true).catch(() => {});
    }
    throw error;
  }
  const results = typeof job.results === 'object' && job.results !== null ? Object.entries(job.results as Record<string, unknown>).slice(0, 200) : [];
  const outputs: GpOutput[] = [];
  for (const [name, ref] of results) {
    hooks.onStatus(`結果「${name}」を読み込み中…`);
    const paramUrl = typeof ref === 'object' && ref !== null && typeof (ref as { paramUrl?: unknown }).paramUrl === 'string' ? (ref as { paramUrl: string }).paramUrl : `results/${name}`;
    // Results live under the job; anything else is not followed.
    const url = safeUrl(paramUrl, `${jobUrl}/`);
    if (!url || !url.startsWith(`${jobUrl}/`)) continue;
    const output = await esriResult(await esriCall(url, { returnType: 'data' }, task.url, token), task, url);
    if (output) outputs.push(output);
  }
  const mapServer = task.resultMapServer ? `${task.url.replace(/\/[^/]+\/GPServer\/[^/]+$/i, '')}/${task.resultMapServer}/MapServer/jobs/${encodeURIComponent(jobId)}` : undefined;
  return { outputs, messages: esriMessages(job.messages), ...(mapServer && safeUrl(mapServer) ? { mapServer } : {}) };
}

async function runOgc(task: GpTask, values: Record<string, GpValue>, token: string | undefined, hooks: RunHooks): Promise<RunResult> {
  const body = JSON.stringify({ inputs: ogcInputs(task, values) });
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(task.async ? { prefer: 'respond-async' } : {}) };
  hooks.onStatus(task.async ? 'ジョブを送信中…' : '実行中…');
  const { json, response } = await ogcCall(`${task.url}/execution`, task.url, token, { method: 'POST', body, headers });
  if (hooks.signal?.aborted && !task.async) throw new GpCancelled();
  const status = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : null;
  const isJob = response.status === 201 || (status !== null && typeof status.jobID === 'string' && typeof status.status === 'string' && !('type' in status));
  if (!isJob) return { outputs: ogcOutputs(task, json, response.url || task.url), messages: [] };

  // The job: Location (when the server exposes it), a monitor link, or …/jobs/{jobID} next to /processes.
  const root = task.url.replace(/\/processes\/[^/]+$/, '');
  const jobId = typeof status?.jobID === 'string' && /^[\w.-]{1,200}$/.test(status.jobID) ? status.jobID : null;
  const jobUrl =
    safeUrl(response.headers.get('location'), task.url) ??
    linkOf(status?.links, ['monitor', 'status', 'self', 'http://www.opengis.net/def/rel/ogc/1.0/job'], task.url) ??
    (jobId ? `${root}/jobs/${encodeURIComponent(jobId)}` : null);
  if (!jobUrl || !sameOrigin(jobUrl, task.url)) throw new ServiceError('ジョブの URL が不明');
  let job = status ?? {};
  let delay = hooks.pollMs ?? 1000;
  try {
    for (;;) {
      const state = ogcJobState(job.status);
      const percent = typeof job.progress === 'number' ? job.progress : undefined;
      const message = typeof job.message === 'string' ? job.message.slice(0, 200) : '';
      hooks.onStatus(`ジョブ ${jobStateNames[state]}${message ? `: ${message}` : ''}`, percent);
      if (state === 'succeeded') break;
      if (state === 'failed') throw new ServiceError(`ジョブが失敗${message ? `: ${message}` : ''}`);
      if (state === 'cancelled') throw new GpCancelled();
      await sleep(delay, hooks.signal);
      delay = Math.min(delay * 1.5, 5000);
      const polled = (await ogcCall(jobUrl, task.url, token)).json;
      job = typeof polled === 'object' && polled !== null ? (polled as Record<string, unknown>) : {};
    }
  } catch (error) {
    if (error instanceof GpCancelled) {
      hooks.onStatus('取り消し中…');
      await ogcCall(jobUrl, task.url, token, { method: 'DELETE' }).catch(() => {});
    }
    throw error;
  }
  const resultsUrl = linkOf(job.links, ['http://www.opengis.net/def/rel/ogc/1.0/results', 'results'], jobUrl) ?? `${jobUrl.replace(/\/+$/, '')}/results`;
  if (!sameOrigin(resultsUrl, task.url)) throw new ServiceError('結果の URL がサービスと別のホスト');
  hooks.onStatus('結果を読み込み中…');
  const results = await ogcCall(resultsUrl, task.url, token);
  return { outputs: ogcOutputs(task, results.json, resultsUrl), messages: typeof job.message === 'string' ? [job.message.slice(0, 500)] : [] };
}
