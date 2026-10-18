import { describe, expect, it } from 'vitest';
import { answer, embedConfigOf, eventMessage, MAX_REQUEST, methodsFor, originAllowed, readRequest, shapeParams, toolAllowed } from '../src/embed-protocol.js';
import { parseConfig } from '../src/config.js';

const request = (method: string, params?: unknown, extra: Record<string, unknown> = {}) => ({ type: 'image-viewer', v: 1, id: 1, method, params, ...extra });
const error = (data: unknown, readOnly = false) => {
  const read = readRequest(data, readOnly);
  if (!read || read.ok) throw new Error(`expected a refusal, got ${JSON.stringify(read)}`);
  return { id: read.id, code: read.error.code, message: read.error.message };
};

describe('embedConfigOf', () => {
  it('takes exact http(s) origins and readOnly', () => {
    const problems: string[] = [];
    expect(embedConfigOf({ allowedOrigins: ['https://app.example.com', 'http://localhost:8080', 'https://app.example.com'], readOnly: true }, problems)).toEqual({
      allowedOrigins: ['https://app.example.com', 'http://localhost:8080'],
      readOnly: true,
    });
    expect(problems).toEqual([]);
  });

  it('refuses wildcards, paths and other schemes', () => {
    const problems: string[] = [];
    const config = embedConfigOf({ allowedOrigins: ['*', 'https://app.example.com/', 'https://app.example.com/page', 'https://*.example.com', 'file://x', 'null', 42, 'javascript:alert(1)'], readOnly: 'yes' }, problems);
    expect(config).toEqual({ allowedOrigins: [], readOnly: false });
    expect(problems).toHaveLength(9);
  });

  it('is off when absent, and parseConfig reads it', () => {
    expect(parseConfig({}).config.embed).toEqual({ allowedOrigins: [], readOnly: false });
    const { config, problems } = parseConfig({ embed: { allowedOrigins: ['https://app.example.com'] } });
    expect(problems).toEqual([]);
    expect(config.embed).toEqual({ allowedOrigins: ['https://app.example.com'], readOnly: false });
    expect(parseConfig({ embed: ['https://app.example.com'] }).problems).toEqual(['embed がオブジェクトではありません']);
  });

  it('allows only listed origins, never the opaque one', () => {
    expect(originAllowed('https://app.example.com', ['https://app.example.com'])).toBe(true);
    expect(originAllowed('https://evil.example.com', ['https://app.example.com'])).toBe(false);
    expect(originAllowed('null', ['null'])).toBe(false);
  });
});

describe('readRequest', () => {
  it('ignores messages that are not for the viewer', () => {
    expect(readRequest(null)).toBeNull();
    expect(readRequest('hello')).toBeNull();
    expect(readRequest({ type: 'other', id: 1, method: 'hello' })).toBeNull();
    expect(readRequest({ type: 'image-viewer', v: 1, event: 'view', data: {} })).toBeNull();
    expect(readRequest(Object.assign(Object.create({ evil: true }), { type: 'image-viewer', v: 1, id: 1, method: 'hello' }))).toBeNull();
  });

  it('reads a request and its parameters', () => {
    expect(readRequest(request('setView', { center: [139.7, 35.6], zoom: 12 }))).toEqual({ ok: true, request: { id: 1, method: 'setView', params: { center: [139.7, 35.6], zoom: 12 } } });
    expect(readRequest(request('hello'))).toEqual({ ok: true, request: { id: 1, method: 'hello', params: {} } });
    expect(readRequest(request('addShapes', { wkt: 'POINT(139 35)' }))).toMatchObject({ ok: true, request: { params: { wkt: ['POINT(139 35)'] } } });
  });

  it('refuses bad envelopes', () => {
    expect(error({ type: 'image-viewer', v: 1, method: 'hello' })).toMatchObject({ id: null, code: 'bad-request' });
    expect(error({ type: 'image-viewer', v: 1, id: 'x'.repeat(101), method: 'hello' })).toMatchObject({ id: null, code: 'bad-request' });
    expect(error(request('hello', undefined, { v: 2 }))).toMatchObject({ id: 1, code: 'bad-request' });
    expect(error(request('saveEdits'))).toMatchObject({ code: 'unknown-method' });
    expect(error(request('constructor'))).toMatchObject({ code: 'unknown-method' });
    expect(error(request('__proto__'))).toMatchObject({ code: 'unknown-method' });
    expect(error(request('getView', [1, 2]))).toMatchObject({ code: 'bad-request' });
  });

  it('checks every parameter strictly', () => {
    expect(error(request('setView', { center: 'Tokyo' }))).toMatchObject({ code: 'bad-request' });
    expect(error(request('setView', { center: [139, 95] }))).toMatchObject({ code: 'bad-request' });
    expect(error(request('setView', { zoom: 99 }))).toMatchObject({ code: 'bad-request' });
    expect(error(request('setView', { zoom: Number.NaN }))).toMatchObject({ code: 'bad-request' });
    expect(error(request('setView', { bbox: [140, 35, 139, 36] }))).toMatchObject({ code: 'bad-request' });
    expect(error(request('setView', { bbox: [139, 35, 140, 36], zoom: 3 }))).toMatchObject({ code: 'bad-request' });
    expect(error(request('setView', { eval: 'alert(1)' })).message).toContain('eval');
    expect(error(request('setVisible', { layer: 'L1' })).message).toContain('visible');
    expect(error(request('setOpacity', { layer: 'L1', opacity: 2 }))).toMatchObject({ code: 'bad-request' });
    expect(error(request('open', { url: 42 }))).toMatchObject({ code: 'bad-request' });
    expect(error(request('open', { url: 'https://x.example/a.tif', type: 'script' }))).toMatchObject({ code: 'bad-request' });
    expect(error(request('addShapes', {}))).toMatchObject({ code: 'bad-request' });
    expect(error(request('addShapes', { wkt: [1] }))).toMatchObject({ code: 'bad-request' });
    expect(error(request('addShapes', { wkt: ['POINT(1 2)'], color: 'red;' }))).toMatchObject({ code: 'bad-request' });
    expect(error(request('hello', { events: ['view', 'keys'] }))).toMatchObject({ code: 'bad-request' });
  });

  it('caps the size of a request', () => {
    expect(error(request('addShapes', { wkt: Array.from({ length: 10 }, () => `POINT(${'1'.repeat(150_000)} 2)`) }))).toMatchObject({ code: 'too-large' });
    const cyclic: Record<string, unknown> = { type: 'Point' };
    cyclic.self = cyclic;
    expect(error(request('addShapes', { geojson: cyclic }))).toMatchObject({ code: 'too-large' });
    expect(MAX_REQUEST).toBeGreaterThan(200_000);
  });

  it('refuses what changes layers when read-only', () => {
    expect(error(request('open', { url: 'https://x.example/a.tif' }), true)).toMatchObject({ code: 'read-only' });
    expect(error(request('addShapes', { wkt: ['POINT(1 2)'] }), true)).toMatchObject({ code: 'read-only' });
    expect(readRequest(request('setView', { zoom: 3 }), true)).toMatchObject({ ok: true });
    expect(methodsFor(true)).not.toContain('runTool');
    expect(methodsFor(true)).toContain('getSelection');
    expect(methodsFor(false)).toContain('runTool');
  });
});

describe('messages', () => {
  it('answers with plain data and caps the size', () => {
    expect(answer(3, { a: 1, f: () => 1, d: new Date(0) })).toEqual({ type: 'image-viewer', v: 1, id: 3, result: { a: 1, d: '1970-01-01T00:00:00.000Z' } });
    expect(answer(3, undefined)).toMatchObject({ result: null });
    expect(answer(3, 'x'.repeat(9_000_000))).toMatchObject({ id: 3, error: { code: 'too-large' } });
    expect(eventMessage('click', { lon: 1, lat: 2 })).toEqual({ type: 'image-viewer', v: 1, event: 'click', data: { lon: 1, lat: 2 } });
  });

  it('turns addShapes into link-shape parameters', () => {
    const params = shapeParams({ wkt: ['POINT(139 35)', '35.68,139.76'], geojson: { type: 'Point', coordinates: [1, 2] }, labels: ['a'], name: 'n', color: '#ff0000' });
    expect([...params]).toEqual([
      ['geom', 'POINT(139 35)'],
      ['geom', '35.68,139.76'],
      ['geojson', '{"type":"Point","coordinates":[1,2]}'],
      ['label', 'a'],
      ['name', 'n'],
      ['color', '#ff0000'],
    ]);
  });

  it('keeps tools that download files out', () => {
    expect(toolAllowed('save-view')).toBe(false);
    expect(toolAllowed('buffer')).toBe(true);
  });
});
