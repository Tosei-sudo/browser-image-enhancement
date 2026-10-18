/**
 * Styles shared with QGIS and other GIS programs: SLD (1.0, and Symbology
 * Encoding 1.1 as QGIS and GeoServer write it) and QML (style-file.ts),
 * read into the viewer's vector style and written from it, and the raster
 * renderers of a QML (pseudo-color, band assignment) as far as the viewer's
 * correction has the same thing. What cannot be carried over is listed, so
 * the person knows what to set by hand.
 */
import type { LayerColorScale } from 'browser-image-enhancement/openlayers';
import type { ColorClass } from 'browser-image-enhancement';
import { attr, descendants, escapeXml as esc, kid, kids, parseXml, path, textOf, type XmlElement } from './safe-xml.js';
import { hexOf, readQgisLayerStyle, StyleNotes, styleQml, type SymbolKind } from './style-file.js';
import { normalizeSpec, type Category, type GradClass, type LineDash, type PointShape, type SymbolSpec, type VectorStyleSpec } from './vector-style.js';

/** The formats styles are written in. */
export type StyleFormat = 'sld10' | 'se11' | 'qml';
export const styleFormats: Record<StyleFormat, string> = { sld10: 'SLD 1.0', se11: 'SLD 1.1（SE）', qml: 'QML（QGIS）' };
export const styleExtension: Record<StyleFormat, string> = { sld10: '.sld', se11: '.sld', qml: '.qml' };

/** The most characters of a style file read (5 MB). */
export const MAX_STYLE = 5_000_000;

/** A style read from a file, and what of it was left out. */
export interface ImportedStyle {
  spec: VectorStyleSpec;
  format: 'sld' | 'qml';
  unsupported: string[];
}

/** Reads an SLD or a QML; throws with a message for the status line when it is neither. */
export function importStyle(text: string, base: VectorStyleSpec): ImportedStyle {
  const root = parseXml(text, MAX_STYLE);
  const notes = new StyleNotes();
  if (root.name === 'qgis') {
    if (!kid(root, 'renderer-v2')) throw new Error(path(root, 'pipe', 'rasterrenderer') ? 'ラスターの QML です。ベクターのスタイルではありません' : 'QML にシンボルの設定がありません');
    return { spec: readQgisLayerStyle(root, base, notes), format: 'qml', unsupported: notes.list() };
  }
  if (root.local === 'StyledLayerDescriptor' || root.local === 'UserStyle' || root.local === 'FeatureTypeStyle') return { spec: readSld(root, base, notes), format: 'sld', unsupported: notes.list() };
  throw new Error('SLD でも QML でもありません');
}

/** The text of a style in `format`, for a layer of `kind` named `name`. */
export function exportStyle(spec: VectorStyleSpec, format: StyleFormat, kind: SymbolKind, name: string): string {
  return format === 'qml' ? styleQml(spec, kind) : styleSld(spec, kind, format === 'se11' ? '1.1' : '1.0', name);
}

// ---------------------------------------------------------------- SLD writing

const sldDash: Record<LineDash, string | null> = { solid: null, dash: '10 6', dot: '1 5', dashdot: '10 5 1 5' };
const sldShape: Record<PointShape, string> = { circle: 'circle', square: 'square', triangle: 'triangle', diamond: 'diamond', star: 'star', cross: 'cross', x: 'x' };

/** A number as SLD writes it: no more decimals than needed. */
const num = (n: number) => String(Math.round(n * 1e6) / 1e6);

/**
 * The SLD of a style: one rule per category or range (hidden ones left out),
 * an `ElseFilter` rule for the rest, labels in a rule of their own (they
 * have their own scale limit), and the layer's scales on every rule.
 */
export function styleSld(spec: VectorStyleSpec, kind: SymbolKind, version: '1.0' | '1.1', name: string): string {
  const se = version === '1.1';
  const p = se ? 'se:' : '';
  const param = se ? 'se:SvgParameter' : 'CssParameter';
  const params = (entries: Array<[string, string | number | null]>) => entries.filter(([, v]) => v !== null).map(([k, v]) => `<${param} name="${k}">${esc(String(v))}</${param}>`).join('');
  const fill = (color: string, opacity: number) => `<${p}Fill>${params([['fill', color], ['fill-opacity', num(opacity)]])}</${p}Fill>`;
  const stroke = (color: string, s: SymbolSpec, width = s.strokeWidth) =>
    `<${p}Stroke>${params([['stroke', color], ['stroke-opacity', num(s.strokeOpacity)], ['stroke-width', num(width)], ['stroke-linejoin', 'round'], ['stroke-linecap', s.dash === 'dot' ? 'round' : 'square'], ['stroke-dasharray', sldDash[s.dash]]])}</${p}Stroke>`;
  const hasStroke = (s: SymbolSpec) => s.strokeWidth > 0 && s.strokeOpacity > 0;
  const symbolizer = (s: SymbolSpec, color: string | null) => {
    if (kind === 'line') return `<${p}LineSymbolizer>${stroke(color ?? s.stroke, s, color ? Math.max(1, s.strokeWidth) : s.strokeWidth)}</${p}LineSymbolizer>`;
    const c = color ?? s.fill;
    if (kind === 'polygon') return `<${p}PolygonSymbolizer>${s.fillOpacity > 0 ? fill(c, s.fillOpacity) : ''}${hasStroke(s) ? stroke(s.stroke, s) : ''}</${p}PolygonSymbolizer>`;
    const lines = s.shape === 'cross' || s.shape === 'x';
    const mark = `<${p}Mark><${p}WellKnownName>${sldShape[s.shape]}</${p}WellKnownName>${fill(c, 1)}${lines ? stroke(c, { ...s, strokeOpacity: 1, dash: 'solid' }, Math.max(2, s.size / 5)) : hasStroke(s) ? stroke(s.stroke, { ...s, dash: 'solid' }) : ''}</${p}Mark>`;
    return `<${p}PointSymbolizer><${p}Graphic>${mark}<${p}Size>${num(s.size)}</${p}Size></${p}Graphic></${p}PointSymbolizer>`;
  };
  const scales = `${spec.maxScale ? `<${p}MinScaleDenominator>${num(spec.maxScale)}</${p}MinScaleDenominator>` : ''}${spec.minScale ? `<${p}MaxScaleDenominator>${num(spec.minScale)}</${p}MaxScaleDenominator>` : ''}`;
  const prop = (field: string) => `<ogc:PropertyName>${esc(field)}</ogc:PropertyName>`;
  const literal = (value: string | number) => `<ogc:Literal>${esc(typeof value === 'number' ? num(value) : value)}</ogc:Literal>`;
  const rule = (title: string, filter: string, body: string, scaleText = scales) =>
    `<${p}Rule><${p}Name>${esc(title)}</${p}Name>${se ? `<${p}Description><${p}Title>${esc(title)}</${p}Title></${p}Description>` : `<${p}Title>${esc(title)}</${p}Title>`}${filter}${scaleText}${body}</${p}Rule>`;
  const rules: string[] = [];
  const s = spec.symbol;
  if (spec.mode === 'categorized' && spec.field) {
    for (const c of spec.categories.filter((x) => x.visible)) rules.push(rule(c.value, `<ogc:Filter><ogc:PropertyIsEqualTo>${prop(spec.field)}${literal(c.value)}</ogc:PropertyIsEqualTo></ogc:Filter>`, symbolizer(s, c.color)));
    if (spec.othersVisible) rules.push(rule('その他', `<${p}ElseFilter/>`, symbolizer(s, null)));
  } else if (spec.mode === 'graduated' && spec.field) {
    spec.classes.forEach((c, i) => {
      if (!c.visible) return;
      const lower = i === 0 ? 'PropertyIsGreaterThanOrEqualTo' : 'PropertyIsGreaterThan';
      const filter = `<ogc:Filter><ogc:And><ogc:${lower}>${prop(spec.field!)}${literal(c.min)}</ogc:${lower}><ogc:PropertyIsLessThanOrEqualTo>${prop(spec.field!)}${literal(c.max)}</ogc:PropertyIsLessThanOrEqualTo></ogc:And></ogc:Filter>`;
      rules.push(rule(`${num(c.min)} - ${num(c.max)}`, filter, symbolizer(s, c.color)));
    });
    if (spec.othersVisible) rules.push(rule('その他', `<${p}ElseFilter/>`, symbolizer(s, null)));
  } else {
    rules.push(rule('シンボル', '', symbolizer(s, null)));
  }
  const l = spec.label;
  if (l.field) {
    const placement = kind === 'line' ? `<${p}LinePlacement/>` : `<${p}PointPlacement><${p}AnchorPoint><${p}AnchorPointX>0.5</${p}AnchorPointX><${p}AnchorPointY>${kind === 'point' ? 0 : 0.5}</${p}AnchorPointY></${p}AnchorPoint>${kind === 'point' ? `<${p}Displacement><${p}DisplacementX>0</${p}DisplacementX><${p}DisplacementY>${num(s.size / 2 + 2)}</${p}DisplacementY></${p}Displacement>` : ''}</${p}PointPlacement>`;
    const halo = l.haloWidth > 0 ? `<${p}Halo><${p}Radius>${num(l.haloWidth / 2)}</${p}Radius>${fill(l.halo, 1)}</${p}Halo>` : '';
    const text = `<${p}TextSymbolizer><${p}Label>${prop(l.field)}</${p}Label><${p}Font>${params([['font-family', 'sans-serif'], ['font-size', num(l.size)], ['font-weight', l.bold ? 'bold' : 'normal']])}</${p}Font><${p}LabelPlacement>${placement}</${p}LabelPlacement>${halo}${fill(l.color, 1)}</${p}TextSymbolizer>`;
    // Labels hide beyond their own scale, and with the layer.
    const labelMin = spec.maxScale ? `<${p}MinScaleDenominator>${num(spec.maxScale)}</${p}MinScaleDenominator>` : '';
    const labelMax = l.maxScale || spec.minScale ? `<${p}MaxScaleDenominator>${num(Math.min(l.maxScale ?? Infinity, spec.minScale ?? Infinity))}</${p}MaxScaleDenominator>` : '';
    rules.push(rule('ラベル', '', text, labelMin + labelMax));
  }
  const ns = se
    ? 'version="1.1.0" xmlns="http://www.opengis.net/sld" xmlns:se="http://www.opengis.net/se" xmlns:ogc="http://www.opengis.net/ogc" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.opengis.net/sld http://schemas.opengis.net/sld/1.1.0/StyledLayerDescriptor.xsd"'
    : 'version="1.0.0" xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.opengis.net/sld http://schemas.opengis.net/sld/1.0.0/StyledLayerDescriptor.xsd"';
  return `<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor ${ns}>
  <NamedLayer>
    <${p}Name>${esc(name)}</${p}Name>
    <UserStyle>
      <${p}Name>${esc(name)}</${p}Name>
      <${p}FeatureTypeStyle>
        ${rules.join('\n        ')}
      </${p}FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
`;
}

// ---------------------------------------------------------------- SLD reading

/** The `CssParameter`s (SLD 1.0) or `SvgParameter`s (SE 1.1) of an element, by name. */
function sldParams(el: XmlElement | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of el?.children ?? []) if (c.local === 'CssParameter' || c.local === 'SvgParameter') out.set(attr(c, 'name') ?? '', textOf(c));
  return out;
}

const numberOf = (text: string | null | undefined): number | null => {
  if (text === null || text === undefined || text.trim() === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};

/** A dash array as the nearest of the viewer's line patterns. */
function dashOf(text: string | undefined): LineDash {
  const parts = (text ?? '').trim().split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  if (parts.length < 2) return 'solid';
  if (parts.length >= 4) return 'dashdot';
  return parts[0] <= 2 ? 'dot' : 'dash';
}

/** Units of a symbolizer other than pixels (SE `uom`). */
function checkUom(el: XmlElement, notes: StyleNotes): void {
  const uom = attr(el, 'uom') ?? '';
  if (/metre|meter|foot/i.test(uom)) notes.add('地上の長さ（メートルなど）で指定した大きさ');
}

/** Reads the stroke of an SLD element into `out`: false when it has none. */
function readStroke(el: XmlElement | undefined, out: SymbolSpec, notes: StyleNotes): boolean {
  const stroke = kid(el, 'Stroke');
  if (!stroke) return false;
  if (kid(stroke, 'GraphicFill') || kid(stroke, 'GraphicStroke')) notes.add('記号を並べた線');
  const p = sldParams(stroke);
  const color = hexOf(p.get('stroke'));
  if (color) out.stroke = color.hex;
  out.strokeOpacity = numberOf(p.get('stroke-opacity')) ?? 1;
  out.strokeWidth = numberOf(p.get('stroke-width')) ?? 1;
  out.dash = dashOf(p.get('stroke-dasharray'));
  return true;
}

/** Reads a fill: its color, or null when it has none. */
function readFill(el: XmlElement | undefined, notes: StyleNotes): { color: string; opacity: number } | null {
  const fill = kid(el, 'Fill');
  if (!fill) return null;
  if (kid(fill, 'GraphicFill')) notes.add('模様・画像の塗り');
  const p = sldParams(fill);
  const color = hexOf(p.get('fill'));
  return { color: color?.hex ?? '#808080', opacity: numberOf(p.get('fill-opacity')) ?? 1 };
}

const wellKnown: Record<string, PointShape> = { circle: 'circle', square: 'square', triangle: 'triangle', star: 'star', cross: 'cross', x: 'x', diamond: 'diamond' };

/** The symbol of a rule's symbolizers, and its main color (fill, or a line's color). */
function readSymbolizers(rule: XmlElement, base: SymbolSpec, notes: StyleNotes): { symbol: SymbolSpec; color: string | null } | null {
  const out: SymbolSpec = { ...base };
  const polygons = kids(rule, 'PolygonSymbolizer');
  const lines = kids(rule, 'LineSymbolizer');
  const points = kids(rule, 'PointSymbolizer');
  if (!polygons.length && !lines.length && !points.length) return null;
  if (polygons.length + lines.length + points.length > 1) notes.add('一つのルールに重ねたシンボル（最初のものを使います）');
  let color: string | null = null;
  if (polygons[0]) {
    const el = polygons[0];
    checkUom(el, notes);
    const fill = readFill(el, notes);
    if (fill) {
      color = out.fill = fill.color;
      out.fillOpacity = fill.opacity;
    } else out.fillOpacity = 0;
    if (!readStroke(el, out, notes)) out.strokeWidth = 0;
  } else if (lines[0]) {
    const el = lines[0];
    checkUom(el, notes);
    if (readStroke(el, out, notes)) color = out.stroke;
    if (kid(el, 'PerpendicularOffset')) notes.add('線のずらし');
  } else {
    const el = points[0];
    checkUom(el, notes);
    const graphic = kid(el, 'Graphic');
    const mark = kid(graphic, 'Mark');
    if (!mark) notes.add(kid(graphic, 'ExternalGraphic') ? '画像の点記号' : '点記号');
    const name = textOf(kid(mark, 'WellKnownName')).toLowerCase();
    if (mark) {
      const shape = wellKnown[name || 'square'];
      if (shape) out.shape = shape;
      else notes.add(`点の形「${name}」`);
    }
    const fill = readFill(mark, notes);
    const lineMark = out.shape === 'cross' || out.shape === 'x';
    const stroked = readStroke(mark, out, notes);
    if (fill) color = out.fill = fill.color;
    else if (lineMark && stroked) color = out.fill = out.stroke;
    if (!stroked) out.strokeWidth = 0;
    if (lineMark) out.strokeWidth = base.strokeWidth;
    out.dash = base.dash;
    const size = numberOf(textOf(kid(graphic, 'Size')));
    if (size !== null) out.size = Math.max(2, Math.round(size));
    if (numberOf(textOf(kid(graphic, 'Rotation')))) notes.add('点の回転');
  }
  return { symbol: out, color };
}

/** What a rule's filter selects: everything, one value of a field, a range of a number, or something the viewer does not have. */
type RuleFilter = { kind: 'all' } | { kind: 'else' } | { kind: 'value'; field: string; value: string } | { kind: 'range'; field: string; min: number; max: number } | { kind: 'other' };

function comparison(el: XmlElement): { op: string; field: string; value: string } | null {
  const field = textOf(kid(el, 'PropertyName')) || textOf(kid(el, 'ValueReference'));
  const literal = kid(el, 'Literal');
  if (!field || !literal) return null;
  return { op: el.local, field, value: textOf(literal) };
}

function readFilter(rule: XmlElement): RuleFilter {
  if (kid(rule, 'ElseFilter')) return { kind: 'else' };
  const filter = kid(rule, 'Filter');
  if (!filter) return { kind: 'all' };
  const body = filter.children[0];
  if (!body) return { kind: 'all' };
  if (body.local === 'PropertyIsEqualTo') {
    const c = comparison(body);
    return c ? { kind: 'value', field: c.field, value: c.value } : { kind: 'other' };
  }
  if (body.local === 'PropertyIsBetween') {
    const field = textOf(kid(body, 'PropertyName')) || textOf(kid(body, 'ValueReference'));
    const min = numberOf(textOf(kid(body, 'LowerBoundary')));
    const max = numberOf(textOf(kid(body, 'UpperBoundary')));
    return field && min !== null && max !== null ? { kind: 'range', field, min, max } : { kind: 'other' };
  }
  if (body.local === 'And' && body.children.length === 2) {
    const parts = body.children.map(comparison);
    if (parts[0] && parts[1] && parts[0].field === parts[1].field) {
      let min: number | null = null;
      let max: number | null = null;
      for (const c of parts as Array<{ op: string; value: string }>) {
        if (/GreaterThan/.test(c.op)) min = numberOf(c.value);
        else if (/LessThan/.test(c.op)) max = numberOf(c.value);
      }
      if (min !== null && max !== null) return { kind: 'range', field: parts[0].field, min, max };
    }
  }
  return { kind: 'other' };
}

/** Reads the labels of a `TextSymbolizer` into `spec`. */
function readText(text: XmlElement, spec: VectorStyleSpec, notes: StyleNotes): void {
  const label = kid(text, 'Label');
  const props = label ? label.children.filter((c) => c.local === 'PropertyName' || c.local === 'ValueReference') : [];
  if (props.length !== 1 || label!.children.length !== 1 || label!.text.trim()) {
    notes.add('式・文字を組み合わせたラベル');
    if (!props.length) return;
  }
  const l = spec.label;
  l.field = textOf(props[0]);
  const font = sldParams(kid(text, 'Font'));
  const size = numberOf(font.get('font-size'));
  if (size !== null) l.size = Math.max(6, Math.round(size));
  l.bold = /bold|[6-9]00/.test(font.get('font-weight') ?? '');
  const fill = readFill(text, notes);
  if (fill) l.color = fill.color;
  const halo = kid(text, 'Halo');
  if (halo) {
    const radius = numberOf(textOf(kid(halo, 'Radius')));
    l.haloWidth = radius === null ? 2 : Math.round(radius * 2 * 2) / 2;
    l.halo = readFill(halo, notes)?.color ?? '#ffffff';
  } else l.haloWidth = 0;
  if (kid(text, 'Graphic')) notes.add('ラベルの背景');
}

/** A style from an SLD's first user style (all its feature type styles); `base` fills the rest. */
export function readSld(root: XmlElement, base: VectorStyleSpec, notes = new StyleNotes()): VectorStyleSpec {
  const styles = root.local === 'UserStyle' ? [root] : descendants(root, 'UserStyle');
  if (styles.length > 1) notes.add('2 番目以降のスタイル');
  const style = root.local === 'FeatureTypeStyle' ? { children: [root] } : styles[0];
  if (!style) throw new Error('SLD にスタイル（UserStyle）がありません');
  const types = style.children.filter((c) => c.local === 'FeatureTypeStyle' || c.local === 'CoverageStyle');
  if (types.some((t) => t.local === 'CoverageStyle') || descendants(root, 'RasterSymbolizer').length) notes.add('ラスターのスタイル');
  if (types.filter((t) => t.local === 'FeatureTypeStyle').length > 1) notes.add('重ねた FeatureTypeStyle（まとめて読みます）');
  const rules = types.flatMap((t) => kids(t, 'Rule'));
  const spec: VectorStyleSpec = structuredClone(base);
  spec.label = { ...spec.label, field: null };
  const symbolRules: Array<{ rule: XmlElement; filter: RuleFilter; symbol: { symbol: SymbolSpec; color: string | null } }> = [];
  for (const rule of rules) {
    const filter = readFilter(rule);
    const symbol = readSymbolizers(rule, spec.symbol, notes);
    const text = kid(rule, 'TextSymbolizer');
    if (text && !spec.label.field) {
      if (filter.kind !== 'all') notes.add('条件付きのラベル（すべてに付けます）');
      readText(text, spec, notes);
      const max = numberOf(textOf(kid(rule, 'MaxScaleDenominator')));
      if (max !== null && (!symbol || filter.kind === 'all')) spec.label.maxScale = max > 0 && max < 1e8 ? max : null;
    } else if (text) notes.add('2 つ目以降のラベル');
    if (symbol) symbolRules.push({ rule, filter, symbol });
  }
  // The layer's scales: those of the symbol rules (of the first one).
  const first = symbolRules[0]?.rule;
  if (first) {
    const min = numberOf(textOf(kid(first, 'MinScaleDenominator')));
    const max = numberOf(textOf(kid(first, 'MaxScaleDenominator')));
    spec.maxScale = min !== null && min > 0 ? min : null;
    spec.minScale = max !== null && max > 0 && max < 1e8 ? max : null;
    const differ = symbolRules.some(({ rule }) => textOf(kid(rule, 'MinScaleDenominator')) !== textOf(kid(first, 'MinScaleDenominator')) || textOf(kid(rule, 'MaxScaleDenominator')) !== textOf(kid(first, 'MaxScaleDenominator')));
    if (differ) notes.add('ルールごとに違う縮尺（最初のルールの縮尺を使います）');
    // Labels hidden with the layer only: no limit of their own.
    if (spec.label.maxScale !== null && spec.minScale !== null && spec.label.maxScale >= spec.minScale) spec.label.maxScale = null;
  }
  if (symbolRules.some((r) => r.filter.kind === 'other')) notes.add('分類・段階にできない条件（フィルター）');
  const values = symbolRules.filter((r) => r.filter.kind === 'value');
  const ranges = symbolRules.filter((r) => r.filter.kind === 'range');
  const others = symbolRules.find((r) => r.filter.kind === 'else');
  if (values.length) {
    const field = (values[0].filter as { field: string }).field;
    if (ranges.length || values.some((r) => (r.filter as { field: string }).field !== field)) notes.add('複数の属性による分類（最初の属性で分類します）');
    spec.mode = 'categorized';
    spec.field = field;
    spec.symbol = values[0].symbol.symbol;
    const seen = new Set<string>();
    spec.categories = values
      .filter((r) => (r.filter as { field: string }).field === field)
      .flatMap((r): Category[] => {
        const value = (r.filter as { value: string }).value;
        if (seen.has(value)) return [];
        seen.add(value);
        return [{ value, color: r.symbol.color ?? spec.symbol.fill, visible: true }];
      });
    spec.othersVisible = !!others;
    // The rest's color: a fill (a line's color is its stroke, which the symbol has).
    if (others?.symbol.color && !kid(others.rule, 'LineSymbolizer')) spec.symbol = { ...spec.symbol, fill: others.symbol.color };
  } else if (ranges.length) {
    const field = (ranges[0].filter as { field: string }).field;
    if (ranges.some((r) => (r.filter as { field: string }).field !== field)) notes.add('複数の属性による段階（最初の属性で分けます）');
    spec.mode = 'graduated';
    spec.field = field;
    spec.symbol = ranges[0].symbol.symbol;
    spec.classes = ranges
      .filter((r) => (r.filter as { field: string }).field === field)
      .map((r): GradClass => {
        const f = r.filter as { min: number; max: number };
        return { min: f.min, max: f.max, color: r.symbol.color ?? spec.symbol.fill, visible: true };
      })
      .sort((a, b) => a.min - b.min);
    spec.classCount = Math.max(1, spec.classes.length);
    spec.othersVisible = !!others;
  } else if (symbolRules.length) {
    const plain = symbolRules.find((r) => r.filter.kind === 'all') ?? symbolRules[0];
    spec.mode = 'single';
    spec.symbol = plain.symbol.symbol;
    if (symbolRules.length > 1) notes.add('2 つ目以降のルール');
  } else if (!spec.label.field) {
    throw new Error('SLD に点・線・面のシンボルがありません');
  }
  return normalizeSpec(spec, base);
}

// ---------------------------------------------------------------- raster renderers

/** What a QGIS raster renderer becomes in the viewer. */
export interface RasterStyle {
  /** Bands shown as R, G and B (0-based). */
  bands?: [number, number, number];
  /** The color scale of one band. */
  colorScale?: LayerColorScale;
}

/**
 * The viewer's settings for a QGIS `<rasterrenderer>`: pseudo-color becomes
 * a color scale (its stops placed between the shader's minimum and maximum),
 * gray and RGB the bands shown. The minimum and maximum themselves have no
 * equivalent (the viewer stretches the values it sees), nor have palettes.
 */
export function readRasterRenderer(renderer: XmlElement, notes: StyleNotes): RasterStyle {
  const type = attr(renderer, 'type');
  const band = (name: string) => {
    const n = numberOf(attr(renderer, name));
    return n !== null && n >= 1 ? Math.round(n) - 1 : null;
  };
  const out: RasterStyle = {};
  const minMax = (el: XmlElement | undefined) => el && (attr(el, 'minValue') !== null || kid(el, 'minValue'));
  if (type === 'multibandcolor') {
    const [r, g, b] = [band('redBand'), band('greenBand'), band('blueBand')];
    if (r !== null && g !== null && b !== null) out.bands = [r, g, b];
    else notes.add('一部のバンドが空の RGB 表示');
    if (['redContrastEnhancement', 'greenContrastEnhancement', 'blueContrastEnhancement'].some((n) => minMax(kid(renderer, n)))) notes.add('RGB の最小値・最大値（ビューアの自動調整で表示します）');
  } else if (type === 'singlebandgray') {
    const gray = band('grayBand');
    if (gray !== null && gray > 0) out.bands = [gray, gray, gray];
    if (attr(renderer, 'gradient') === 'WhiteToBlack') out.colorScale = { scale: 'gray', reverse: true };
    if (minMax(kid(renderer, 'contrastEnhancement'))) notes.add('グレーの最小値・最大値（ビューアの自動調整で表示します）');
  } else if (type === 'singlebandpseudocolor') {
    const b = band('band');
    if (b !== null && b > 0) out.bands = [b, b, b];
    const shader = path(renderer, 'rastershader', 'colorrampshader');
    const all = kids(shader, 'item').map((i) => ({ text: attr(i, 'value'), value: numberOf(attr(i, 'value')), color: hexOf(attr(i, 'color')), alpha: numberOf(attr(i, 'alpha')), label: attr(i, 'label') }));
    const items = all.filter((i): i is typeof i & { value: number; color: { hex: string; opacity: number } } => i.value !== null && !!i.color);
    const min = numberOf(attr(shader, 'minimumValue')) ?? numberOf(attr(renderer, 'classificationMin')) ?? Math.min(...items.map((i) => i.value));
    const max = numberOf(attr(shader, 'maximumValue')) ?? numberOf(attr(renderer, 'classificationMax')) ?? Math.max(...items.map((i) => i.value));
    if (items.length && Number.isFinite(min) && Number.isFinite(max) && max > min) {
      const rgb = (hex: string) => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
      const stops = items
        .map((i) => [Math.max(0, Math.min(1, (i.value - min) / (max - min))), [...rgb(i.color.hex), Math.round(255 * (i.alpha !== null ? i.alpha / 255 : i.color.opacity))]] as const)
        .sort((a, b) => a[0] - b[0]);
      out.colorScale = { scale: stops };
      const rampType = attr(shader, 'colorRampType');
      if (rampType === 'DISCRETE' || rampType === 'EXACT') {
        // Classes keep the values: a DISCRETE item is an upper bound ("inf" for the last one), an EXACT one a value.
        const open = all.find((i) => i.value === null && /^\+?inf/i.test(i.text ?? '') && i.color);
        const list = items.map((i) => classOf(i.value, i.color, i.alpha, i.label));
        if (rampType === 'DISCRETE' && open) list.push(classOf(Math.max(max, ...items.map((i) => i.value)), open.color!, open.alpha, open.label));
        out.colorScale.classes = { kind: rampType === 'EXACT' ? 'exact' : 'range', method: 'manual', classes: list, ...(rampType === 'DISCRETE' ? { min } : {}) };
      } else notes.add(`擬似カラーの値の範囲（${min} – ${max}）は表示中の明るさの範囲に置き換えます`);
    } else notes.add('擬似カラーの色');
  } else if (type === 'paletted') {
    // A color per value (a classified image): exact classes.
    const b = band('band');
    if (b !== null && b > 0) out.bands = [b, b, b];
    const entries = kids(path(renderer, 'colorPalette'), 'paletteEntry')
      .map((e) => ({ value: numberOf(attr(e, 'value')), color: hexOf(attr(e, 'color')), alpha: numberOf(attr(e, 'alpha')), label: attr(e, 'label') }))
      .filter((e): e is typeof e & { value: number; color: { hex: string; opacity: number } } => e.value !== null && !!e.color);
    if (entries.length) out.colorScale = { scale: 'turbo', classes: { kind: 'exact', method: 'manual', classes: entries.slice(0, 256).map((e) => classOf(e.value, e.color, e.alpha, e.label)) } };
    else notes.add('パレットの色');
  } else if (type) {
    notes.add(`ラスターの表示方法「${type === 'hillshade' ? '陰影' : type}」`);
  }
  return out;
}

/** A color class from a QGIS item: its value, color, alpha (0-255) and label. */
function classOf(value: number, color: { hex: string; opacity: number }, alpha: number | null, label: string | null): ColorClass {
  const rgb = [1, 3, 5].map((k) => parseInt(color.hex.slice(k, k + 2), 16));
  return { value, color: [...rgb, Math.round(alpha !== null ? alpha : 255 * color.opacity)], ...(label ? { label } : {}) };
}

/** The text of a style file chosen by the person: refused when it is too large to be a style. */
export async function readStyleFile(file: File): Promise<string> {
  if (file.size > MAX_STYLE) throw new Error(`${file.name} は大きすぎます（スタイルは 5 MB まで）`);
  return file.text();
}
