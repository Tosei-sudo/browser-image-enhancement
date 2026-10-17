/**
 * The rest of what a person does in the viewer, for scripts: layers shown,
 * hidden, reordered and closed; image correction, bands, no-data and
 * coloring; vector styles; the view, base map, bookmarks, timeline, split
 * and swipe comparison, 3D and theme; the tools of the ツール menu and
 * プロセッシング (their dialogs, driven as a person would fill them); and
 * opening layers from a URL or from files the person picks.
 *
 * Safety: a script still cannot reach the network itself. Opening a URL
 * reaches a server, so a server the viewer does not already use is asked
 * about (confirm) once per run; files are opened only when the person picks
 * them. Closing a layer with unsaved edits is refused.
 */
import { Pipeline, type PipelineJSON } from 'browser-image-enhancement';
import type { LayerBlendMode, LayerColorScale } from 'browser-image-enhancement/openlayers';
import { fromLonLat, toLonLat, transformExtent } from 'ol/proj.js';
import type { ViewerImage, ViewerLayer, ViewerService, ImageList } from '../images.js';
import type { Editor } from '../editor.js';
import type { LayerConfig } from '../config.js';
import type { Bookmarks } from '../bookmarks.js';
import type { Timeline } from '../timeline.js';
import type { SplitView } from '../split-view.js';
import type { SwipeTool } from '../swipe.js';
import type { LayerChoice, ServiceKind } from '../services/common.js';
import { blendChoices, oneColor, scaleChoices } from '../colorize-dialog.js';
import { categoriesFor, classesFor, normalizeSpec, type VectorStyleSpec } from '../vector-style.js';
import { describeControls, setControl, settle, statusOf, type ScriptTool } from './tool-driver.js';
import type { ScriptLayerInfo } from './api.js';
import type OlMap from 'ol/Map.js';

/** What the viewer lends scripts for these functions (main.ts fills it). */
export interface AutomationContext {
  map: OlMap;
  editor: Editor;
  list: ImageList;
  /** Shows a correction in the panel when `layer` is the selected one. */
  setCorrection: (layer: ViewerLayer, pipeline: Pipeline) => void;
  setNoData: (image: ViewerImage, noData: { auto: boolean; values: number[] }) => void;
  setColorScale: (image: ViewerImage, scale: LayerColorScale | null, blend: LayerBlendMode) => void;
  baseMaps: () => ReadonlyArray<{ id: string; label: string }>;
  baseMap: () => string;
  setBaseMap: (id: string) => void;
  bookmarks: () => Bookmarks;
  timeline: () => Timeline;
  split: () => SplitView;
  swipe: () => SwipeTool;
  globe: (open: boolean) => Promise<boolean>;
  setTheme: (theme: 'auto' | 'light' | 'dark') => void;
  /** The tools a script can run (their dialogs). */
  tools: () => ScriptTool[];
  /** Buttons of the menus a script may press, by id. */
  commands: () => ReadonlyArray<{ id: string; label: string; press: () => void }>;
  /** Opens a layer as config.json's `layers` do. */
  open: (layer: LayerConfig) => Promise<void>;
  /** The layers a service offers. */
  serviceChoices: (url: string, kind: ServiceKind | 'auto') => Promise<LayerChoice[]>;
  /** Servers the viewer already uses (config.json, open layers): no question asked for these. */
  knownHosts: () => string[];
  /** Asks the person to pick files (a button in the script panel); resolves with none when they decline. */
  pickFiles: (prompt: string, accept: string, multiple: boolean) => Promise<File[]>;
  openFiles: (files: File[]) => Promise<void>;
}

/** What scriptHandlers shares with these functions. */
export interface AutomationKit {
  layerOf: (ref: unknown) => ViewerLayer;
  imageOf: (ref: unknown) => ViewerImage;
  vectorOf: (ref: unknown) => ViewerService;
  info: (layer: ViewerLayer) => ScriptLayerInfo;
  layerId: (layer: ViewerLayer) => string;
  /** Counts a download against the run's limit (throws past it). */
  download: () => void;
}

/** Kinds of layers `viewer.open` takes. */
const OPEN_TYPES = new Set(['cog', 'file', 'wms', 'wmts', 'wfs', 'esri']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function options(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new TypeError('オプションはオブジェクトで指定してください');
  return value;
}

function number(value: unknown, name: string, min: number, max: number): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new TypeError(`${name} は数値で指定してください`);
  if (n < min || n > max) throw new RangeError(`${name} は ${min}〜${max} で指定してください`);
  return n;
}

function lonLat(value: unknown, name: string): [number, number] {
  if (!Array.isArray(value) || value.length < 2 || !value.slice(0, 2).every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new TypeError(`${name} は [経度, 緯度] で指定してください`);
  }
  const [lon, lat] = value as number[];
  if (lat < -90 || lat > 90) throw new RangeError(`${name} の緯度は -90〜90 です`);
  return [lon, lat];
}

/** The server of a URL a script gives (http or https only). */
function originOf(url: unknown): { url: string; origin: string } {
  if (typeof url !== 'string' || !url.trim()) throw new TypeError('URL を文字列で指定してください');
  let parsed: URL;
  try {
    parsed = new URL(url.trim(), location.href);
  } catch {
    throw new TypeError(`URL として読めません: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new TypeError('http か https の URL を指定してください');
  return { url: parsed.href, origin: parsed.origin };
}

/** The functions of this file, for one run. */
export function automationHandlers(ctx: AutomationContext, kit: AutomationKit): Record<string, (...args: never[]) => unknown> {
  /** Servers the person allowed in this run. */
  const allowed = new Set<string>();
  const allow = (url: unknown): string => {
    const { url: href, origin } = originOf(url);
    const known = new Set([location.origin, ...ctx.knownHosts()]);
    if (known.has(origin) || allowed.has(origin)) return href;
    const ok = confirm(`スクリプトが次のサーバーからデータを読み込もうとしています。\n\n${origin}\n\n許可しますか？（この実行の間だけ有効です）`);
    if (!ok) throw new Error(`${origin} への接続は許可されませんでした`);
    allowed.add(origin);
    return href;
  };
  /** Runs `open` and returns the layers it added. */
  const added = async (open: () => Promise<unknown>): Promise<ScriptLayerInfo[]> => {
    const before = new Set(ctx.list.layers());
    await open();
    await settle();
    return ctx.list.layers().filter((l) => !before.has(l)).map(kit.info);
  };
  /** The name a tool dialog lists a layer by, when `v` names a layer; null otherwise. */
  const layerName = (v: unknown): string | null => {
    const key = isRecord(v) && 'id' in v ? v.id : v;
    if (typeof key !== 'string') return null;
    const layer = ctx.list.layers().find((l) => kit.layerId(l) === key);
    return layer ? layer.name : null;
  };
  const toolOf = (id: unknown): ScriptTool => {
    const tools = ctx.tools();
    const tool = tools.find((t) => t.id === id || t.label === id || t.label.startsWith(`${String(id)}（`));
    if (!tool) throw new Error(`ツール「${String(id)}」はありません。使えるもの: ${tools.map((t) => t.id).join(', ')}`);
    return tool;
  };
  const correctionOf = (layer: ViewerLayer) => (layer.type === 'image' ? layer.source : (layer.service.correction ?? null));

  return {
    // Layers in the list.
    setVisible: (ref: unknown, visible: unknown) => {
      if (typeof visible !== 'boolean') throw new TypeError('表示は true か false で指定してください');
      ctx.list.setVisible(kit.layerOf(ref), visible);
      return true;
    },
    setOpacity: (ref: unknown, opacity: unknown) => {
      ctx.list.setOpacity(kit.layerOf(ref), number(opacity, '不透明度', 0, 1));
      return true;
    },
    moveLayer: (ref: unknown, to: unknown) => {
      const layer = kit.layerOf(ref);
      const list = ctx.list.layers();
      if (to === 'top') ctx.list.arrange([layer]);
      else if (to === 'bottom') ctx.list.arrange(list.filter((l) => l !== layer).concat(layer));
      else if (to === 'up' || to === 'down') ctx.list.move(layer, to === 'up' ? 1 : -1);
      else ctx.list.move(layer, Math.trunc(number(to, '移動する数', -1000, 1000)));
      return ctx.list.layers().map(kit.layerId);
    },
    removeLayer: (ref: unknown) => {
      const layer = kit.layerOf(ref);
      if (ctx.editor.editing() === layer && (ctx.editor.session()?.count() ?? 0) > 0) {
        throw new Error(`${layer.name} には未保存の変更があるので閉じません（保存するか「元に戻す」で戻してから閉じてください）`);
      }
      ctx.list.remove(layer);
      return true;
    },

    // Images: correction, bands, no-data, coloring.
    enhance: (ref: unknown) => {
      const target = correctionOf(kit.layerOf(ref));
      if (!target) throw new Error('このレイヤーは補正できません');
      return target.getPipeline().toJSON().ops;
    },
    setEnhance: (ref: unknown, settings: unknown) => {
      const layer = kit.layerOf(ref);
      const target = correctionOf(layer);
      if (!target) throw new Error(`${layer.name} は補正できません`);
      let p: Pipeline;
      try {
        if (settings === null) p = new Pipeline();
        else if (Array.isArray(settings)) p = Pipeline.fromJSON({ version: 1, ops: settings } as PipelineJSON);
        else if (isRecord(settings)) {
          p = target.getPipeline();
          for (const [name, value] of Object.entries(settings)) {
            if (value !== null && typeof value !== 'number' && !isRecord(value)) throw new TypeError(`${name} は数値、オプションのオブジェクト、または null（外す）です`);
            p = value === null ? p.remove(name as never) : p.set(name as never, value as never);
          }
        } else throw new TypeError('補正は { brightness: 0.2, contrast: 0.1 } のようなオブジェクト、手順の配列、または null（元に戻す）で指定してください');
      } catch (error) {
        throw new TypeError(`補正を設定できません: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      ctx.setCorrection(layer, p);
      return p.toJSON().ops;
    },
    setBands: async (ref: unknown, bands: unknown) => {
      const image = kit.imageOf(ref);
      const n = image.source.getValueBandCount();
      if (bands !== null && (!Array.isArray(bands) || ![1, 3].includes(bands.length) || !bands.every((b) => Number.isInteger(b) && b >= 0 && b < n))) {
        throw new TypeError(`バンドは [R, G, B] か [1 バンド] を 0〜${n - 1} の番号（0 から）で、または null（元のまま）で指定してください`);
      }
      try {
        await image.source.setSelect(bands as [number, number, number] | [number] | null);
      } catch (error) {
        throw new Error(`バンドを割り当てられません: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      // The panel's band choices follow.
      if (ctx.list.selectedLayer() === image) ctx.list.select(image);
      return image.source.getSelect();
    },
    setNoData: (ref: unknown, value: unknown) => {
      const image = kit.imageOf(ref);
      const o = value === null ? { auto: false, values: [] } : options(value);
      const values = o.values === undefined ? [] : o.values;
      if (!Array.isArray(values) || !values.every((v) => typeof v === 'number' && !Number.isNaN(v))) throw new TypeError('values はノーデータにする値の配列です');
      if (values.length > 64) throw new RangeError('values は 64 個までです');
      ctx.setNoData(image, { auto: o.auto === undefined ? values.length === 0 && value !== null : Boolean(o.auto), values });
      return true;
    },
    colorize: (ref: unknown, value: unknown) => {
      const image = kit.imageOf(ref);
      if (value === null) {
        ctx.setColorScale(image, null, 'normal');
        return true;
      }
      const o = options(value);
      const names = scaleChoices.map(([n]) => n as string);
      const blend = o.blend ?? 'normal';
      if (!blendChoices.some(([b]) => b === blend)) throw new TypeError(`blend は ${blendChoices.map(([b]) => b).join(' / ')} のどれかです`);
      let scale: LayerColorScale['scale'];
      if (typeof o.scale === 'string' && names.includes(o.scale)) scale = o.scale as never;
      else if (typeof o.scale === 'string' && /^#[0-9a-f]{6}$/i.test(o.scale)) scale = oneColor(o.scale) as never;
      else throw new TypeError(`scale は ${names.join(' / ')}、または "#ff0000" のような色です`);
      ctx.setColorScale(image, { scale, reverse: Boolean(o.reverse), fade: Boolean(o.fade) }, blend as LayerBlendMode);
      return true;
    },

    // Vector styles.
    style: (ref: unknown) => {
      const style = kit.vectorOf(ref).service.style;
      if (!style) throw new Error('このレイヤーのスタイルは変えられません');
      return style.get();
    },
    setStyle: (ref: unknown, value: unknown) => {
      const layer = kit.vectorOf(ref);
      const style = layer.service.style;
      if (!style) throw new Error(`${layer.name} のスタイルは変えられません`);
      const given = options(value);
      const current = style.get();
      const merged = {
        ...current,
        ...given,
        symbol: { ...current.symbol, ...(isRecord(given.symbol) ? given.symbol : {}) },
        label: { ...current.label, ...(isRecord(given.label) ? given.label : {}) },
      } as Record<string, unknown>;
      // A color alone sets a single symbol.
      if (typeof given.color === 'string') {
        merged.mode = given.mode ?? 'single';
        merged.symbol = { ...(merged.symbol as object), fill: given.color, stroke: given.color };
      }
      let spec: VectorStyleSpec = normalizeSpec(merged, current);
      const features = layer.service.vector!.source.getFeatures();
      const fieldChanged = spec.field !== current.field || spec.mode !== current.mode;
      if (spec.mode === 'categorized' && spec.field && (fieldChanged || !spec.categories.length) && !Array.isArray(given.categories)) {
        spec = { ...spec, categories: categoriesFor(features, spec.field) };
      }
      if (spec.mode === 'graduated' && spec.field && (fieldChanged || !spec.classes.length || 'classCount' in given || 'method' in given || 'ramp' in given) && !Array.isArray(given.classes)) {
        spec = { ...spec, classes: classesFor(features, spec.field, spec.method, spec.classCount, spec.ramp, spec.reversed) };
      }
      if ((spec.mode === 'categorized' || spec.mode === 'graduated') && !spec.field) throw new Error('mode が categorized・graduated のときは field（属性）を指定してください');
      style.set(spec);
      return spec;
    },

    // The view.
    setView: (value: unknown) => {
      const o = options(value);
      const view = ctx.map.getView();
      const projection = view.getProjection();
      const duration = o.duration === undefined ? 0 : number(o.duration, 'duration', 0, 10_000);
      if (o.bbox !== undefined) {
        const box = o.bbox;
        if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new TypeError('bbox は [西, 南, 東, 北]（経緯度）です');
        view.fit(transformExtent(box as number[], 'EPSG:4326', projection), { duration, padding: [20, 20, 20, 20] });
      } else {
        const target: { center?: number[]; zoom?: number; resolution?: number; rotation?: number; duration: number } = { duration };
        if (o.center !== undefined) target.center = fromLonLat(lonLat(o.center, 'center'), projection);
        if (o.zoom !== undefined) target.zoom = number(o.zoom, 'zoom', 0, 30);
        if (o.resolution !== undefined) target.resolution = number(o.resolution, 'resolution', 1e-6, 1e8);
        if (o.rotation !== undefined) target.rotation = (number(o.rotation, 'rotation', -360, 360) * Math.PI) / 180;
        if (duration) view.animate(target);
        else {
          if (target.center) view.setCenter(target.center);
          if (target.resolution !== undefined) view.setResolution(target.resolution);
          if (target.zoom !== undefined) view.setZoom(target.zoom);
          if (target.rotation !== undefined) view.setRotation(target.rotation);
        }
      }
      return { center: toLonLat(view.getCenter()!, projection), zoom: view.getZoom() };
    },
    baseMaps: () => ctx.baseMaps().map((b) => ({ id: b.id, label: b.label, shown: b.id === ctx.baseMap() })),
    setBaseMap: (id: unknown) => {
      const list = ctx.baseMaps();
      const base = id === '' || id === null ? { id: '' } : list.find((b) => b.id === id || b.label === id);
      if (!base) throw new Error(`背景地図「${String(id)}」はありません。使えるもの: ${list.map((b) => `${b.id}（${b.label}）`).join(', ') || '（なし）'}`);
      ctx.setBaseMap(base.id);
      return base.id;
    },
    bookmarks: () => ctx.bookmarks().get().map((b) => ({ id: b.id, name: b.name })),
    goBookmark: (ref: unknown) => {
      const list = ctx.bookmarks().get();
      const mark = list.find((b) => b.id === ref) ?? list.find((b) => b.name === ref);
      if (!mark) throw new Error(`ブックマーク「${String(ref)}」はありません`);
      ctx.bookmarks().go(mark.id);
      return true;
    },
    addBookmark: (name: unknown) => {
      if (name !== undefined && typeof name !== 'string') throw new TypeError('名前は文字列で指定してください');
      const mark = ctx.bookmarks().add(name?.slice(0, 200));
      return mark ? { id: mark.id, name: mark.name } : null;
    },
    timeline: (value: unknown) => {
      const timeline = ctx.timeline();
      if (value !== undefined) {
        if (value === null) timeline.showAll();
        else {
          const o = options(value);
          const ms = (v: unknown, name: string) => {
            const t = typeof v === 'number' ? v : typeof v === 'string' ? new Date(v).getTime() : NaN;
            if (!Number.isFinite(t)) throw new TypeError(`${name} は日時（"2026-10-01" やミリ秒）で指定してください`);
            return t;
          };
          if (!timeline.isOpen()) timeline.setOpen(true);
          const from = ms(o.from, 'from');
          const to = ms(o.to, 'to');
          if (from > to) throw new RangeError('from は to より前にしてください');
          timeline.setWindow(from, to);
        }
      }
      const w = timeline.getWindow();
      return w ? { from: new Date(w[0]).toISOString(), to: new Date(w[1]).toISOString() } : null;
    },
    split: (count: unknown, layers: unknown) => {
      if (count !== 1 && count !== 2 && count !== 4) throw new TypeError('画面の数は 1・2・4 のどれかです');
      if (layers !== undefined && !Array.isArray(layers)) throw new TypeError('layers は各画面のレイヤーの配列です（null で空き）');
      const panes = (layers as unknown[] | undefined)?.map((l) => (l === null ? null : kit.layerOf(l)));
      ctx.split().setCount(count, panes);
      return ctx.split().getCount();
    },
    swipe: (ref: unknown, value: unknown) => {
      const swipe = ctx.swipe();
      if (ref === null) {
        swipe.setActive(false);
        return false;
      }
      const layer = kit.layerOf(ref);
      const o = options(value);
      swipe.setLayer(layer.layer, layer.name);
      if (o.orientation !== undefined) {
        if (o.orientation !== 'vertical' && o.orientation !== 'horizontal') throw new TypeError('orientation は vertical か horizontal です');
        swipe.setOrientation(o.orientation);
      }
      if (o.position !== undefined) swipe.setPosition(number(o.position, 'position', 0, 1));
      swipe.setActive(true);
      return true;
    },
    globe: async (open: unknown) => {
      if (typeof open !== 'boolean') throw new TypeError('3D 表示は true か false で指定してください');
      return ctx.globe(open);
    },
    theme: (theme: unknown) => {
      if (theme !== 'auto' && theme !== 'light' && theme !== 'dark') throw new TypeError('テーマは auto・light・dark のどれかです');
      ctx.setTheme(theme);
      return theme;
    },
    commands: () => ctx.commands().map(({ id, label }) => ({ id, label })),
    command: async (id: unknown) => {
      const list = ctx.commands();
      const command = list.find((c) => c.id === id || c.label === id);
      if (!command) throw new Error(`コマンド「${String(id)}」はありません。使えるもの: ${list.map((c) => c.id).join(', ')}`);
      command.press();
      await settle();
      return true;
    },

    // Opening layers.
    open: async (url: unknown, value: unknown) => {
      const o = options(value);
      const type = o.type ?? 'cog';
      if (typeof type !== 'string' || !OPEN_TYPES.has(type)) throw new TypeError(`type は ${[...OPEN_TYPES].join(' / ')} のどれかです`);
      const href = allow(url);
      if (type !== 'cog' && type !== 'file' && (typeof o.layer !== 'string' || !o.layer)) {
        throw new TypeError('サービスは layer（レイヤー名）も指定してください（viewer.serviceLayers(url, type) で一覧できます）');
      }
      const config = (type === 'cog' || type === 'file' ? { type, url: href } : { type, url: href, layer: o.layer, ...(typeof o.matrixSet === 'string' ? { matrixSet: o.matrixSet } : {}), ...(typeof o.format === 'string' ? { format: o.format } : {}) }) as LayerConfig;
      const layers = await added(() => ctx.open(config));
      if (!layers.length) throw new Error(`${href} を開けませんでした`);
      return layers;
    },
    serviceLayers: async (url: unknown, type: unknown) => {
      const kind = type ?? 'auto';
      if (kind !== 'auto' && kind !== 'wms' && kind !== 'wmts' && kind !== 'wfs' && kind !== 'esri') throw new TypeError('type は wms・wmts・wfs・esri のどれかです');
      const choices = await ctx.serviceChoices(allow(url), kind);
      return choices.map((c) => ({ name: c.name, title: c.title, ...(c.matrixSets ? { matrixSets: c.matrixSets } : {}), ...(c.formats ? { formats: c.formats } : {}) }));
    },
    openFiles: async (value: unknown) => {
      const o = options(value);
      const accept = typeof o.accept === 'string' ? o.accept.slice(0, 500) : '';
      const message = typeof o.message === 'string' && o.message ? o.message.slice(0, 200) : 'スクリプトがファイルを開こうとしています';
      const files = await ctx.pickFiles(message, accept, o.multiple !== false);
      if (!files.length) return [];
      return added(() => ctx.openFiles(files));
    },

    // Tools (their dialogs).
    tools: () => ctx.tools().map(({ id, label }) => ({ id, label })),
    toolOptions: async (id: unknown) => {
      const tool = toolOf(id);
      await tool.open();
      await settle();
      try {
        return describeControls(tool.dialog);
      } finally {
        tool.dialog.close();
      }
    },
    tool: async (id: unknown, params: unknown) => {
      const tool = toolOf(id);
      const given = options(params);
      if (tool.id === 'save-view') kit.download();
      const before = new Set(ctx.list.layers());
      await tool.open();
      await settle();
      try {
        for (const [name, value] of Object.entries(given)) await setControl(tool.dialog, name, value, layerName, tool.label);
        const result = await tool.run();
        await settle();
        const status = statusOf(tool.dialog);
        const layers = ctx.list.layers().filter((l) => !before.has(l));
        if (!layers.length && !result && tool.id !== 'save-view') throw new Error(status || `${tool.label}は何も作りませんでした`);
        return { layers: layers.map(kit.info), ...(status ? { message: status } : {}) };
      } finally {
        if (tool.dialog.open) tool.dialog.close();
      }
    },
  };
}
