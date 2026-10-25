/**
 * Templates for "New layer": ready designs (a name, a geometry type and
 * attributes) the person picks and then changes as they like before the layer
 * is made. Some come built in, an organisation can add its own in config.json
 * (`layerTemplates`), and anyone can keep their own designs in the browser.
 */
import type { DrawableType } from './edit-session.js';
import { geometryNames, type DesignType, type FieldDesign, type LayerDesign } from './temp-layers.js';

/** A design to start a new layer from. */
export interface LayerTemplate extends Omit<LayerDesign, 'crs'> {
  /** What the list shows. */
  name: string;
  /** One line on what it is for. */
  description?: string;
}

/** Where a template comes from: built in, config.json, or saved in this browser. */
export type TemplateSource = 'builtin' | 'config' | 'saved';

const field = (name: string, type: DesignType, alias: string, more: Partial<FieldDesign> = {}): FieldDesign => ({ name, type, alias, ...more });

/** The built-in templates; the first is the blank design the dialog opens with. */
export const builtinTemplates: readonly LayerTemplate[] = [
  { name: '空のレイヤー', description: 'テキスト属性 name のみ', title: '新規レイヤー', geometryType: 'Point', fields: [field('name', 'string', '')] },
  {
    name: '航跡（生存圏計算用）',
    description: '目標ID・時刻・針路・速力の位置報告。「移動目標撮像計画…」で属性を自動対応、存在予測円を計算',
    title: '航跡',
    geometryType: 'Point',
    fields: [
      field('track_id', 'string', '目標ID', { required: true }),
      field('time', 'date', '時刻', { required: true }),
      field('course', 'double', '針路（度）', { min: 0, max: 359.9 }),
      field('speed', 'double', '速力（kn）', { min: 0 }),
      field('name', 'string', '名称'),
      field('source', 'string', '情報源', { codes: '目視, レーダー, AIS, 画像判読, その他' }),
      field('note', 'string', '備考'),
    ],
  },
  {
    name: '調査地点',
    description: '地点名・種別・調査日・備考',
    title: '調査地点',
    geometryType: 'Point',
    fields: [field('name', 'string', '地点名', { required: true }), field('kind', 'string', '種別', { codes: '建物, 道路, 河川, 植生, その他' }), field('surveyed', 'date', '調査日'), field('note', 'string', '備考')],
  },
  {
    name: '目標・物体',
    description: '画像から読み取った物体の種別・数・確度・撮影日時・画像名',
    title: '目標',
    geometryType: 'Point',
    fields: [
      field('kind', 'string', '種別', { required: true }),
      field('count', 'integer', '数', { min: 0, defaultValue: '1' }),
      field('confidence', 'integer', '確度', { codes: '1=確実, 2=可能性大, 3=可能性あり', defaultValue: '2' }),
      field('observed', 'date', '撮影日時'),
      field('image', 'string', '画像名'),
      field('note', 'string', '備考'),
    ],
  },
  {
    name: '関心区域（AOI）',
    description: '区域名・優先度・期間・依頼元',
    title: '関心区域',
    geometryType: 'Polygon',
    fields: [
      field('name', 'string', '区域名', { required: true }),
      field('priority', 'integer', '優先度', { codes: '1=高, 2=中, 3=低', defaultValue: '2' }),
      field('start', 'date', '開始日'),
      field('end', 'date', '終了日'),
      field('requester', 'string', '依頼元'),
      field('note', 'string', '備考'),
    ],
  },
  {
    name: '被害状況',
    description: '被害の種別・程度・確認日（災害の判読向け）',
    title: '被害状況',
    geometryType: 'Polygon',
    fields: [
      field('kind', 'string', '種別', { codes: '倒壊, 浸水, 土砂, 火災, 道路寸断, その他', required: true }),
      field('level', 'integer', '程度', { codes: '1=全壊, 2=半壊, 3=一部損壊, 4=被害なし' }),
      field('checked', 'date', '確認日'),
      field('note', 'string', '備考'),
    ],
  },
  {
    name: '経路・測線',
    description: '経路名・種別・備考',
    title: '経路',
    geometryType: 'LineString',
    fields: [field('name', 'string', '経路名', { required: true }), field('kind', 'string', '種別', { codes: '道路, 航路, 測線, その他' }), field('note', 'string', '備考')],
  },
  {
    name: '注記',
    description: '地図上の文字（ジオメトリは作図ごとに選択）',
    title: '注記',
    geometryType: null,
    fields: [field('label', 'string', '文字', { required: true }), field('category', 'string', '分類'), field('note', 'string', '備考')],
  },
];

const designTypes: readonly DesignType[] = ['string', 'integer', 'double', 'date'];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);
const number = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * A template from JSON (config.json or saved designs); the problems are
 * collected with `at` naming where. Fields are not checked further here: the
 * dialog says what is wrong when the layer is made.
 */
export function templateOf(json: unknown, problems: string[], at: string): LayerTemplate | null {
  if (!isRecord(json) || typeof json.name !== 'string' || !json.name.trim()) {
    problems.push(`${at} の name は文字列で指定`);
    return null;
  }
  const geometry = json.geometryType ?? null;
  if (geometry !== null && !(typeof geometry === 'string' && geometry in geometryNames)) {
    problems.push(`${at} の geometryType は ${Object.keys(geometryNames).join('・')}・null のいずれかで指定`);
    return null;
  }
  if (!Array.isArray(json.fields)) {
    problems.push(`${at} の fields は配列で指定`);
    return null;
  }
  const fields: FieldDesign[] = [];
  json.fields.forEach((f, i) => {
    const type = isRecord(f) ? (f.type ?? 'string') : undefined;
    if (!isRecord(f) || typeof f.name !== 'string' || !designTypes.includes(type as DesignType)) {
      problems.push(`${at}.fields[${i}] は name と type（${designTypes.join('・')}）で指定`);
      return;
    }
    fields.push({
      name: f.name,
      type: type as DesignType,
      alias: text(f.alias) ?? '',
      required: f.required === true,
      length: number(f.length),
      min: number(f.min),
      max: number(f.max),
      codes: Array.isArray(f.codes) ? f.codes.map(String).join(', ') : (text(f.codes) ?? ''),
      defaultValue: text(f.defaultValue) ?? '',
    });
  });
  const name = json.name.trim();
  return {
    name,
    ...(typeof json.description === 'string' && json.description.trim() ? { description: json.description.trim() } : {}),
    title: typeof json.title === 'string' && json.title.trim() ? json.title.trim() : name,
    geometryType: geometry as DrawableType | null,
    fields,
  };
}

const STORE_KEY = 'image-viewer.layer-templates';

/** The designs saved in this browser. */
export function savedTemplates(): LayerTemplate[] {
  try {
    const json: unknown = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
    return Array.isArray(json) ? json.map((t, i) => templateOf(t, [], String(i))).filter((t): t is LayerTemplate => t !== null) : [];
  } catch {
    return [];
  }
}

function store(list: LayerTemplate[]): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(list));
}

/** Saves `template` in this browser, replacing one of the same name. */
export function saveTemplate(template: LayerTemplate): void {
  store([...savedTemplates().filter((t) => t.name !== template.name), template]);
}

/** Removes the saved design named `name`. */
export function removeTemplate(name: string): void {
  store(savedTemplates().filter((t) => t.name !== name));
}
