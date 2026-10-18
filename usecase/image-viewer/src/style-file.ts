/**
 * Styles in files, as QGIS keeps them: a QML document, written next to a
 * Shapefile (`roads.qml`) or into a GeoPackage's `layer_styles` table. QGIS
 * draws the layer with it when it opens the file, and the viewer reads it
 * back: its own style exactly (kept in the QML as a custom property), or the
 * main parts of a style QGIS made (one symbol, categories or ranges, their
 * colors, labels and scales).
 */
import { attr, descendants, kid, kids, parseXml, path, type XmlElement } from './safe-xml.js';
import { normalizeSpec, type GradClass, type LineDash, type PointShape, type SymbolSpec, type VectorStyleSpec } from './vector-style.js';

/** The kind of geometry a QML symbol is for. */
export type SymbolKind = 'point' | 'line' | 'polygon';

/** The custom property the viewer's own style is kept in. */
const PROPERTY = 'browser-image-viewer/style';

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

/** `#rrggbb` and an opacity as a QGIS color: `r,g,b,a`. */
function qColor(hex: string, opacity = 1): string {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16) || 0;
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.round(Math.max(0, Math.min(1, opacity)) * 255)}`;
}

const qgisDash: Record<LineDash, string> = { solid: 'solid', dash: 'dash', dot: 'dot', dashdot: 'dash dot' };
const qgisShape: Record<PointShape, string> = { circle: 'circle', square: 'square', triangle: 'triangle', diamond: 'diamond', star: 'star', cross: 'cross', x: 'cross2' };

const options = (entries: Record<string, string | number>) =>
  `<Option type="Map">${Object.entries(entries)
    .map(([k, v]) => `<Option name="${esc(k)}" type="QString" value="${esc(String(v))}"/>`)
    .join('')}</Option>`;

/** One QGIS symbol of `kind` in `color` (the symbol's own colors when null), like the viewer draws it. */
function symbolXml(name: string, kind: SymbolKind, s: SymbolSpec, color: string | null): string {
  const strokeWidth = s.strokeOpacity > 0 ? s.strokeWidth : 0;
  let layer: string;
  if (kind === 'line') {
    // A categorized or graduated line takes its color, at least 1 pixel wide.
    layer = `<layer class="SimpleLine" enabled="1" locked="0" pass="0">${options({
      line_color: qColor(color ?? s.stroke, s.strokeOpacity),
      line_width: color ? Math.max(1, s.strokeWidth) : strokeWidth,
      line_width_unit: 'Pixel',
      line_style: color || strokeWidth > 0 ? qgisDash[s.dash] : 'no',
      capstyle: s.dash === 'dot' ? 'round' : 'square',
      joinstyle: 'round',
    })}</layer>`;
  } else if (kind === 'point') {
    const lines = s.shape === 'cross' || s.shape === 'x';
    layer = `<layer class="SimpleMarker" enabled="1" locked="0" pass="0">${options({
      name: qgisShape[s.shape],
      color: qColor(color ?? s.fill, 1),
      // Crosses are lines in the fill color.
      outline_color: lines ? qColor(color ?? s.fill, 1) : qColor(s.stroke, s.strokeOpacity),
      outline_style: lines || strokeWidth > 0 ? 'solid' : 'no',
      outline_width: lines ? Math.max(2, s.size / 5) : Math.min(strokeWidth, Math.max(1, s.size / 5)),
      outline_width_unit: 'Pixel',
      size: s.size,
      size_unit: 'Pixel',
    })}</layer>`;
  } else {
    layer = `<layer class="SimpleFill" enabled="1" locked="0" pass="0">${options({
      color: qColor(color ?? s.fill, s.fillOpacity),
      style: s.fillOpacity > 0 ? 'solid' : 'no',
      outline_color: qColor(s.stroke, s.strokeOpacity),
      outline_style: strokeWidth > 0 ? qgisDash[s.dash] : 'no',
      outline_width: strokeWidth,
      outline_width_unit: 'Pixel',
      joinstyle: 'round',
    })}</layer>`;
  }
  const type = kind === 'polygon' ? 'fill' : kind === 'line' ? 'line' : 'marker';
  return `<symbol type="${type}" name="${name}" alpha="1" clip_to_extent="1" force_rhr="0">${layer}</symbol>`;
}

/** A number as QML writes range bounds. */
const bound = (n: number) => (Number.isInteger(n) ? n.toFixed(6) : String(n));

export function rendererXml(spec: VectorStyleSpec, kind: SymbolKind): string {
  const s = spec.symbol;
  if (spec.mode === 'categorized' && spec.field) {
    const cats = spec.categories.map((c, i) => `<category symbol="${i}" value="${esc(c.value)}" label="${esc(c.value)}" render="${c.visible}" type="string"/>`);
    const symbols = spec.categories.map((c, i) => symbolXml(String(i), kind, s, c.color));
    // QGIS's 「すべての他の値」: an empty value.
    const n = spec.categories.length;
    if (!spec.categories.some((c) => c.value === '')) {
      cats.push(`<category symbol="${n}" value="" label="" render="${spec.othersVisible}" type="string"/>`);
      symbols.push(symbolXml(String(n), kind, s, null));
    }
    return `<renderer-v2 type="categorizedSymbol" attr="${esc(spec.field)}" symbollevels="0" forceraster="0" enableorderby="0"><categories>${cats.join('')}</categories><symbols>${symbols.join('')}</symbols></renderer-v2>`;
  }
  if (spec.mode === 'graduated' && spec.field) {
    const ranges = spec.classes.map((c, i) => `<range symbol="${i}" lower="${bound(c.min)}" upper="${bound(c.max)}" label="${esc(`${c.min} - ${c.max}`)}" render="${c.visible}"/>`);
    const symbols = spec.classes.map((c, i) => symbolXml(String(i), kind, s, c.color));
    const method = { equal: 'EqualInterval', quantile: 'Quantile', jenks: 'Jenks' }[spec.method];
    return `<renderer-v2 type="graduatedSymbol" attr="${esc(spec.field)}" graduatedMethod="GraduatedColor" symbollevels="0" forceraster="0" enableorderby="0"><ranges>${ranges.join('')}</ranges><symbols>${symbols.join('')}</symbols><classificationMethod id="${method}"/></renderer-v2>`;
  }
  return `<renderer-v2 type="singleSymbol" symbollevels="0" forceraster="0" enableorderby="0"><symbols>${symbolXml('0', kind, s, null)}</symbols></renderer-v2>`;
}

export function labelingXml(spec: VectorStyleSpec, kind: SymbolKind): string {
  const l = spec.label;
  if (!l.field) return '';
  const placement = kind === 'line' ? 2 : kind === 'polygon' ? 1 : 0; // QGIS: around a point, over (in) a polygon, along a line
  return `<labeling type="simple"><settings calloutType="simple"><text-style fieldName="${esc(l.field)}" isExpression="0" fontFamily="sans-serif" fontSize="${l.size}" fontSizeUnit="Pixel" fontWeight="${l.bold ? 75 : 50}" textColor="${qColor(l.color)}" textOpacity="1"><text-buffer bufferDraw="${l.haloWidth > 0 ? 1 : 0}" bufferSize="${l.haloWidth / 2}" bufferSizeUnits="Pixel" bufferColor="${qColor(l.halo)}" bufferOpacity="1"/></text-style><placement placement="${placement}" dist="${kind === 'point' ? Math.round(spec.symbol.size / 2 + 2) : 0}" distUnits="Pixel"/><rendering scaleVisibility="${l.maxScale ? 1 : 0}" scaleMin="0" scaleMax="${l.maxScale ?? 0}" displayAll="${l.overlap ? 1 : 0}" obstacle="1"/></settings></labeling>`;
}

/**
 * The QML of a style, for a layer of `kind`. `rename` gives the column a
 * field was written as (Shapefile names are cut to 10 bytes).
 */
export function styleQml(spec: VectorStyleSpec, kind: SymbolKind, rename: ReadonlyMap<string, string> = new Map()): string {
  const name = (field: string | null) => (field === null ? null : (rename.get(field) ?? field));
  const written: VectorStyleSpec = { ...spec, field: name(spec.field), label: { ...spec.label, field: name(spec.label.field) } };
  const scaled = written.minScale || written.maxScale;
  return `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.34.0" styleCategories="Symbology|Labeling|Rendering|CustomProperties" hasScaleBasedVisibilityFlag="${scaled ? 1 : 0}" minScale="${written.minScale ?? 0}" maxScale="${written.maxScale ?? 0}" labelsEnabled="${written.label.field ? 1 : 0}">
${rendererXml(written, kind)}
${labelingXml(written, kind)}
<customproperties>${options({ [PROPERTY]: JSON.stringify(written) })}</customproperties>
</qgis>
`;
}

/** The kind of symbol for an OpenLayers geometry type; null when it is a mixture (or unknown). */
export function symbolKindOf(type: string | null | undefined): SymbolKind | null {
  if (!type) return null;
  if (/point/i.test(type)) return 'point';
  if (/line|curve/i.test(type)) return 'line';
  if (/polygon|surface/i.test(type)) return 'polygon';
  return null;
}

// ---------------------------------------------------------------- reading

/** `r,g,b,a` (or `#rrggbb`) as `#rrggbb` and an opacity. */
export function hexOf(color: string | null | undefined): { hex: string; opacity: number } | null {
  if (!color) return null;
  if (/^#[0-9a-f]{6}/i.test(color)) return { hex: color.slice(0, 7).toLowerCase(), opacity: 1 };
  const parts = color.split(',').map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
  const hex = `#${parts
    .slice(0, 3)
    .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'))
    .join('')}`;
  return { hex, opacity: Number.isFinite(parts[3]) ? parts[3] / 255 : 1 };
}

/** The properties of a symbol layer: `<Option>`s (QGIS 3.26 and later) or `<prop>`s (older). */
export function propsOf(layer: XmlElement): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of kids(layer, 'prop')) out.set(attr(p, 'k') ?? '', attr(p, 'v') ?? '');
  for (const o of kids(kid(layer, 'Option'), 'Option')) if (attr(o, 'name')) out.set(attr(o, 'name')!, attr(o, 'value') ?? '');
  return out;
}

/** Pixels of a QGIS length in `unit` (millimeters by default, at 96 dpi). */
function pixels(value: string | null | undefined, unit: string | null | undefined): number | null {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return null;
  switch (unit) {
    case 'Pixel':
      return n;
    case 'Point':
      return (n * 96) / 72;
    case 'Inch':
      return n * 96;
    case 'MapUnit':
    case 'RenderMetersInMapUnits':
      return null;
    default:
      return (n * 96) / 25.4;
  }
}

const fromQgisDash = (style: string | undefined): LineDash | null => {
  const found = (Object.entries(qgisDash) as Array<[LineDash, string]>).find(([, q]) => q === style);
  return found ? found[0] : null;
};

/** What could not be carried over from a style, in words for a message (each said once). */
export class StyleNotes {
  private readonly all_ = new Set<string>();
  add(note: string): void {
    this.all_.add(note);
  }
  list(): string[] {
    return [...this.all_];
  }
}

/** What a QGIS symbol says about the viewer's symbol, and its main color. */
function readSymbol(symbol: XmlElement | undefined, base: SymbolSpec, notes?: StyleNotes): { symbol: SymbolSpec; color: string | null } {
  const out: SymbolSpec = { ...base };
  const layers = kids(symbol, 'layer').filter((l) => attr(l, 'enabled') !== '0');
  const layer = layers[0];
  if (!symbol || !layer) return { symbol: out, color: null };
  if (layers.length > 1) notes?.add('重ねたシンボル（2 層目以降）');
  const p = propsOf(layer);
  const kind = attr(layer, 'class') ?? '';
  if (kind !== 'SimpleLine' && kind !== 'SimpleMarker' && kind !== 'SimpleFill') notes?.add(`シンボルの種類「${kind}」（単純な点・線・塗りとして読みます）`);
  for (const [k, v] of p) if (/_unit$/.test(k) && (v === 'MapUnit' || v === 'RenderMetersInMapUnits')) notes?.add('マップ単位の大きさ');
  const defined = kid(layer, 'data_defined_properties');
  if ((defined && descendants(defined, 'Option').some((o) => attr(o, 'name') === 'active' && attr(o, 'value') === 'true')) || [...p].some(([k, v]) => k.endsWith('_dd_active') && v === '1')) notes?.add('データ定義の値');
  const alpha = Number(attr(symbol, 'alpha') ?? 1);
  let color: string | null = null;
  if (kind === 'SimpleLine') {
    const c = hexOf(p.get('line_color') ?? p.get('color'));
    if (c) {
      color = out.stroke = c.hex;
      out.strokeOpacity = c.opacity * alpha;
    }
    const w = pixels(p.get('line_width'), p.get('line_width_unit'));
    if (w !== null) out.strokeWidth = Math.max(w, 0.5);
    if (p.get('line_style') === 'no') out.strokeWidth = 0;
    out.dash = fromQgisDash(p.get('line_style')) ?? out.dash;
  } else {
    const c = hexOf(p.get('color'));
    if (c) {
      color = out.fill = c.hex;
      if (kind !== 'SimpleMarker') out.fillOpacity = c.opacity * alpha;
    }
    if (p.get('style') === 'no') out.fillOpacity = 0;
    else if (p.get('style') && p.get('style') !== 'solid') notes?.add(`塗りの模様「${p.get('style')}」`);
    const o = hexOf(p.get('outline_color'));
    if (o) {
      out.stroke = o.hex;
      out.strokeOpacity = o.opacity * alpha;
    }
    const w = pixels(p.get('outline_width'), p.get('outline_width_unit'));
    if (w !== null) out.strokeWidth = Math.max(w, 0.5);
    if (p.get('outline_style') === 'no') out.strokeWidth = 0;
    out.dash = fromQgisDash(p.get('outline_style')) ?? out.dash;
    if (kind === 'SimpleMarker') {
      const name = p.get('name');
      const shape = (Object.entries(qgisShape) as Array<[PointShape, string]>).find(([, q]) => q === name)?.[0];
      if (shape) out.shape = shape;
      else if (name) notes?.add(`点の形「${name}」`);
      const size = pixels(p.get('size'), p.get('size_unit'));
      if (size !== null) out.size = Math.max(2, Math.round(size));
      if (Number(p.get('angle') ?? 0)) notes?.add('点の回転');
    }
  }
  return { symbol: out, color };
}

const scaleAttr = (value: string | null | undefined) => {
  const n = Number(value);
  return value && Number.isFinite(n) && n > 0 && n < 1e8 ? n : null;
};

/** The renderer types the viewer reads, and names for the others. */
const otherRenderers: Record<string, string> = {
  RuleRenderer: 'ルールによる表示',
  heatmapRenderer: 'ヒートマップ',
  pointCluster: '点のクラスター',
  pointDisplacement: '点の変位',
  invertedPolygonRenderer: '反転ポリゴン',
  '25dRenderer': '2.5D',
  nullSymbol: 'シンボルなし',
  embeddedSymbol: '埋め込みシンボル',
};

/**
 * What can be made of a QGIS layer's `<renderer-v2>`, `<labeling>` and
 * scale attributes (the `<qgis>` root of a QML, or a project's `<maplayer>`).
 * The viewer's own style, when it wrote it, is read exactly.
 */
export function readQgisLayerStyle(root: XmlElement, base: VectorStyleSpec, notes = new StyleNotes()): VectorStyleSpec {
  const props = [...kids(kid(kid(root, 'customproperties'), 'Option'), 'Option'), ...kids(kid(root, 'customproperties'), 'property')];
  const own = props.find((o) => (attr(o, 'name') ?? attr(o, 'key')) === PROPERTY);
  if (own) {
    try {
      return normalizeSpec(JSON.parse(attr(own, 'value') ?? ''), base);
    } catch {
      // not ours after all: read it as QGIS's
    }
  }
  const spec: VectorStyleSpec = structuredClone(base);
  if (attr(root, 'hasScaleBasedVisibilityFlag') === '1') {
    spec.minScale = scaleAttr(attr(root, 'minScale'));
    spec.maxScale = scaleAttr(attr(root, 'maxScale'));
  }
  const renderer = kid(root, 'renderer-v2');
  const symbols = new Map<string, XmlElement>();
  for (const s of kids(kid(renderer, 'symbols'), 'symbol')) symbols.set(attr(s, 'name') ?? '', s);
  const type = attr(renderer, 'type');
  const field = attr(renderer, 'attr');
  // An expression rather than a field name: `"name"` is a field still; anything else is not.
  const attrName = field && /^"[^"]+"$/.test(field) ? field.slice(1, -1) : field;
  if (attrName && !/^[\p{L}\p{N}_ .-]+$/u.test(attrName)) notes.add('式による分類');
  if (type === 'categorizedSymbol' && attrName) {
    const cats = kids(kid(renderer, 'categories'), 'category');
    const first = readSymbol(symbols.get(attr(cats[0], 'symbol') ?? ''), spec.symbol, notes);
    spec.symbol = first.symbol;
    spec.mode = 'categorized';
    spec.field = attrName;
    spec.categories = [];
    for (const c of cats) {
      const value = attr(c, 'value') ?? '';
      const symbol = symbols.get(attr(c, 'symbol') ?? '');
      const { color } = readSymbol(symbol, spec.symbol, notes);
      const visible = attr(c, 'render') !== 'false';
      if (kid(c, 'value') || kid(c, 'Option')) notes.add('複数の値をまとめた分類');
      // The empty value is QGIS's 「すべての他の値」.
      if (value === '') {
        spec.othersVisible = visible;
        // A line's color is its stroke, which the symbol has already.
        if (color && attr(symbol, 'type') !== 'line') spec.symbol = { ...spec.symbol, fill: color };
      } else {
        spec.categories.push({ value, color: color ?? spec.symbol.fill, visible });
      }
    }
    if (!cats.some((c) => (attr(c, 'value') ?? '') === '')) spec.othersVisible = false;
  } else if (type === 'graduatedSymbol' && attrName) {
    const ranges = kids(kid(renderer, 'ranges'), 'range');
    spec.symbol = readSymbol(symbols.get(attr(ranges[0], 'symbol') ?? ''), spec.symbol, notes).symbol;
    spec.mode = 'graduated';
    spec.field = attrName;
    spec.classes = ranges
      .map((r): GradClass => ({
        min: Number(attr(r, 'lower')),
        max: Number(attr(r, 'upper')),
        color: readSymbol(symbols.get(attr(r, 'symbol') ?? ''), spec.symbol, notes).color ?? spec.symbol.fill,
        visible: attr(r, 'render') !== 'false',
      }))
      .filter((c) => Number.isFinite(c.min) && Number.isFinite(c.max))
      .sort((a, b) => a.min - b.min);
    spec.classCount = Math.max(1, spec.classes.length);
    const method = (attr(kid(renderer, 'classificationMethod'), 'id') ?? attr(kid(renderer, 'mode'), 'name') ?? '').toLowerCase();
    spec.method = method.includes('quantile') ? 'quantile' : method.includes('equal') ? 'equal' : 'jenks';
    if (attr(renderer, 'graduatedMethod') === 'GraduatedSize') notes.add('大きさによる段階（色の段階として読みます）');
  } else if (type === 'singleSymbol') {
    spec.mode = 'single';
    spec.symbol = readSymbol(symbols.get('0') ?? [...symbols.values()][0], spec.symbol, notes).symbol;
  } else if (type) {
    notes.add(`表示方法「${otherRenderers[type] ?? type}」`);
    const first = [...symbols.values()][0] ?? kids(kid(kid(renderer, 'rules'), 'rule'), 'symbol')[0];
    if (first) spec.symbol = readSymbol(first, spec.symbol).symbol;
    if (spec.mode !== 'own') spec.mode = 'single';
  }
  const labeling = kid(root, 'labeling');
  const labelType = attr(labeling, 'type');
  if (labeling && labelType !== 'simple') notes.add(labelType === 'rule-based' ? 'ルールによるラベル' : `ラベル「${labelType}」`);
  const settings = kid(labeling, 'settings');
  const textStyle = kid(settings, 'text-style');
  if (labelType === 'simple' && textStyle && attr(root, 'labelsEnabled') !== '0') {
    const name = attr(textStyle, 'fieldName');
    if (attr(textStyle, 'isExpression') === '1') {
      // `"field"` as an expression is the field still.
      if (name && /^"[^"]+"$/.test(name.trim())) spec.label.field = name.trim().slice(1, -1);
      else notes.add('式によるラベル');
    } else if (name) spec.label.field = name;
    if (spec.label.field) {
      const l = spec.label;
      const unit = attr(textStyle, 'fontSizeUnit');
      const size = pixels(attr(textStyle, 'fontSize'), unit === 'Pixel' ? 'Pixel' : unit === 'MM' ? 'MM' : 'Point');
      if (size !== null) l.size = Math.max(6, Math.round(size));
      l.bold = Number(attr(textStyle, 'fontWeight') ?? 50) >= 63 || attr(textStyle, 'fontBold') === '1';
      l.color = hexOf(attr(textStyle, 'textColor'))?.hex ?? l.color;
      const buffer = kid(textStyle, 'text-buffer');
      if (buffer) {
        const draw = attr(buffer, 'bufferDraw') === '1';
        const units = attr(buffer, 'bufferSizeUnits');
        const width = pixels(attr(buffer, 'bufferSize'), units === 'Pixel' ? 'Pixel' : (units ?? 'MM'));
        l.haloWidth = draw && width !== null ? Math.round(width * 2 * 2) / 2 : 0;
        l.halo = hexOf(attr(buffer, 'bufferColor'))?.hex ?? l.halo;
      }
      if (attr(kid(textStyle, 'background'), 'shapeDraw') === '1') notes.add('ラベルの背景');
      if (attr(kid(textStyle, 'shadow'), 'shadowDraw') === '1') notes.add('ラベルの影');
      const rendering = kid(settings, 'rendering');
      if (attr(rendering, 'scaleVisibility') === '1') {
        l.maxScale = scaleAttr(attr(rendering, 'scaleMax'));
        if (scaleAttr(attr(rendering, 'scaleMin'))) notes.add('拡大したらラベルを隠す縮尺');
      }
      l.overlap = attr(rendering, 'displayAll') === '1' || attr(kid(settings, 'placement'), 'displayAll') === '1';
    }
  }
  return normalizeSpec(spec, base);
}

/**
 * A style read from QML: the viewer's own when it wrote it, else what can be
 * made of a QGIS style. Null when it cannot be read. `base` fills the rest;
 * what is left out is added to `notes`.
 */
export function readStyleQml(text: string, base: VectorStyleSpec, notes?: StyleNotes): VectorStyleSpec | null {
  let root: XmlElement;
  try {
    root = parseXml(text);
  } catch {
    return null;
  }
  if (root.name !== 'qgis') return null;
  if (!kid(root, 'renderer-v2') && path(root, 'pipe', 'rasterrenderer')) return null;
  return readQgisLayerStyle(root, base, notes);
}
