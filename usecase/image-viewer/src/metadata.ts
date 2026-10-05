/**
 * The metadata dialog of a GeoTIFF / COG layer: what the file says about
 * itself, read from the images OpenLayers already opened (no new download):
 * the layout (TIFF or BigTIFF, tiles, compression, RSET levels, whether it
 * is a COG), the bands (data type, name, nodata, GDAL's statistics), the
 * georeferencing (GeoKeys, tie points, pixel size), GDAL's metadata and every
 * TIFF tag of the full-resolution image. It can be copied as text or JSON.
 */
import type { GeoTIFFImage } from 'geotiff';
import { globals } from 'geotiff';
import { parseGdalMetadata, readGdalMetadataXml, type GdalMetadataItem } from 'browser-image-enhancement/openlayers';
import type { ViewerImage } from './images.js';

/** One titled list of facts. */
export interface MetadataSection {
  title: string;
  rows: Array<[string, string]>;
}

const COMPRESSION: Record<number, string> = {
  1: 'なし',
  2: 'CCITT RLE',
  5: 'LZW',
  6: 'JPEG（旧方式）',
  7: 'JPEG',
  8: 'Deflate',
  32773: 'PackBits',
  32946: 'Deflate',
  34712: 'JPEG 2000',
  34887: 'LERC',
  34925: 'LZMA',
  50000: 'ZSTD',
  50001: 'WebP',
  50002: 'JPEG XL',
};
const PHOTOMETRIC: Record<number, string> = {
  0: 'WhiteIsZero（グレー、白が 0）',
  1: 'BlackIsZero（グレー／多バンド）',
  2: 'RGB',
  3: 'パレット',
  4: 'マスク',
  5: 'CMYK',
  6: 'YCbCr',
  8: 'CIELab',
};
const PREDICTOR: Record<number, string> = { 1: 'なし', 2: '水平差分', 3: '浮動小数点' };
const PLANAR: Record<number, string> = { 1: 'ピクセル順（BIP）', 2: 'バンド順（BSQ）' };
const EXTRA_SAMPLES: Record<number, string> = { 0: '指定なし', 1: 'アルファ（乗算済み）', 2: 'アルファ' };
const MODEL_TYPE: Record<number, string> = { 1: '投影座標系', 2: '地理座標系', 3: '地心座標系' };
const RASTER_TYPE: Record<number, string> = { 1: 'PixelIsArea（画素の左上角）', 2: 'PixelIsPoint（画素の中心）' };
const UNITS: Record<number, string> = { 9001: 'メートル', 9002: 'フィート', 9003: '米国測量フィート', 9101: 'ラジアン', 9102: '度' };
/** GeoKeys whose value is an EPSG code (32767: user-defined). */
const EPSG_KEYS = new Set(['ProjectedCSTypeGeoKey', 'GeographicTypeGeoKey', 'VerticalCSTypeGeoKey', 'GeogGeodeticDatumGeoKey', 'GeogEllipsoidGeoKey', 'ProjectionGeoKey', 'VerticalDatumGeoKey']);
/** Arrays longer than twice this are cut to their first values. */
const ARRAY_PREVIEW = 8;

/** The data type of one band: `UInt16`, `Float32`… */
export function sampleType(image: GeoTIFFImage, sample: number): string {
  const bits = image.getBitsPerSample(sample);
  const format = image.getSampleFormat(sample) ?? 1;
  return `${format === 3 ? 'Float' : format === 2 ? 'Int' : format === 1 ? 'UInt' : `形式${format}・`}${bits}`;
}

/** What a TIFF tag holds, as text: numbers joined, long arrays cut, codes named. */
function formatValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.replace(/\0+$/, '');
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (ArrayBuffer.isView(value) || Array.isArray(value)) {
    const list = Array.from(value as ArrayLike<number>);
    if (list.length <= ARRAY_PREVIEW * 2) return list.map(formatNumber).join(', ');
    return `${list.slice(0, ARRAY_PREVIEW).map(formatNumber).join(', ')}, …（全 ${list.length.toLocaleString()} 個）`;
  }
  return JSON.stringify(value);
}

function formatNumber(n: number | bigint): string {
  return typeof n === 'bigint' || Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(12)));
}

function named(table: Record<number, string>, code: number | undefined): string {
  return code === undefined ? '' : table[code] ? `${table[code]}（${code}）` : String(code);
}

/** The TIFF header: byte order, BigTIFF, and GDAL's structural metadata (the "ghost area" a COG starts with). */
interface Header {
  littleEndian: boolean;
  bigTiff: boolean;
  /** `LAYOUT=COG`, `BLOCK_ORDER=ROW_MAJOR`… as GDAL writes them after the header; empty when absent. */
  structural: Record<string, string>;
}

/** Reads the first bytes of the file through the image's own source (a Blob or ranged requests). */
async function readHeader(image: GeoTIFFImage): Promise<Header | null> {
  try {
    const [buffer] = await image.source.fetch([{ offset: 0, length: 1024 }]);
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 8) return null;
    const littleEndian = bytes[0] === 0x49;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bigTiff = view.getUint16(2, littleEndian) === 43;
    const text = new TextDecoder('latin1').decode(bytes.subarray(bigTiff ? 16 : 8));
    const structural: Record<string, string> = {};
    const ghost = /^GDAL_STRUCTURAL_METADATA_SIZE=(\d+) bytes\n/.exec(text);
    if (ghost) {
      const body = text.slice(ghost[0].length, ghost[0].length + Number(ghost[1]));
      for (const line of body.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) structural[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
    }
    return { littleEndian, bigTiff, structural };
  } catch {
    return null;
  }
}

/** Whether the file is a cloud optimized GeoTIFF, and why. */
function cogVerdict(images: readonly GeoTIFFImage[], header: Header | null): string {
  if (header?.structural.LAYOUT === 'COG') return 'はい（GDAL の COG レイアウト）';
  const tiled = images[0].isTiled;
  if (!tiled) return 'いいえ（ストリップ形式。拡大縮小のたびに広い範囲を読みます）';
  const small = Math.max(images[0].getWidth(), images[0].getHeight()) <= images[0].getTileWidth();
  if (images.length > 1 || small) return 'COG 相当（タイル＋RSET。バイト配置は未確認）';
  return 'いいえ（RSET がありません）';
}

/** The tags of an image's directory, by tag number, in order, with their values (big arrays only counted). */
async function tagsOf(image: GeoTIFFImage): Promise<Array<[string, string]>> {
  const dir = image.fileDirectory;
  const numbers = [...new Set([...dir.actualizedFields.keys(), ...dir.deferredFields.keys(), ...dir.deferredArrays.keys()])]
    .map((t) => (typeof t === 'number' ? t : globals.resolveTag(t)))
    .filter((t): t is number => typeof t === 'number')
    .sort((a, b) => a - b);
  const rows: Array<[string, string]> = [];
  for (const tag of numbers) {
    const name = globals.getTag(tag)?.name ?? `タグ ${tag}`;
    let text: string;
    const deferred = dir.deferredArrays.get(tag);
    if (deferred && deferred.length > ARRAY_PREVIEW * 2) {
      // Tile offsets and byte counts: thousands of numbers, not worth reading.
      text = `（全 ${deferred.length.toLocaleString()} 個）`;
    } else {
      try {
        text = formatValue(await dir.loadValue(tag));
      } catch (error) {
        text = `（読めません: ${(error as Error).message}）`;
      }
    }
    rows.push([`${name}（${tag}）`, text]);
  }
  return rows;
}

/**
 * What the dialog shows for a GeoTIFF: `images` are the full-resolution
 * image and its RSET levels (finest first), as `EnhancedGeoTIFF.getTiffImages`
 * gives them for one source.
 */
export async function describeTiff(images: readonly GeoTIFFImage[], options: { name: string; masks?: number }): Promise<MetadataSection[]> {
  const image = images[0];
  const header = await readHeader(image);
  const samples = image.getSamplesPerPixel();
  const fd = image.fileDirectory;
  const xml = await readGdalMetadataXml(image).catch(() => null);
  const items = xml ? parseGdalMetadata(xml) : [];
  const nodata = image.getGDALNoData();
  const compression = fd.getValue('Compression') as number | undefined;
  const types = Array.from({ length: samples }, (_, s) => sampleType(image, s));

  const summary: Array<[string, string]> = [['ファイル', options.name]];
  if (header) summary.push(['形式', `${header.bigTiff ? 'BigTIFF' : 'TIFF'}・${header.littleEndian ? 'リトルエンディアン' : 'ビッグエンディアン'}`]);
  summary.push(['COG', cogVerdict(images, header)]);
  summary.push(['サイズ', `${image.getWidth().toLocaleString()} × ${image.getHeight().toLocaleString()} px`]);
  summary.push(['バンド数', String(samples)]);
  summary.push(['データ型', [...new Set(types)].join(' / ')]);
  summary.push(['配置', image.isTiled ? `タイル ${image.getTileWidth()} × ${image.getTileHeight()} px` : `ストリップ（${fd.getValue('RowsPerStrip') ?? image.getHeight()} 行ずつ）`]);
  summary.push(['圧縮', named(COMPRESSION, compression)]);
  const predictor = (await fd.loadValue('Predictor')) as number | undefined;
  if (predictor !== undefined) summary.push(['予測子', named(PREDICTOR, predictor)]);
  summary.push(['色の解釈', named(PHOTOMETRIC, fd.getValue('PhotometricInterpretation') as number | undefined)]);
  summary.push(['バンドの並び', named(PLANAR, fd.getValue('PlanarConfiguration') as number | undefined)]);
  const extra = fd.getValue('ExtraSamples') as ArrayLike<number> | undefined;
  if (extra?.length) summary.push(['追加サンプル', Array.from(extra, (e) => named(EXTRA_SAMPLES, e)).join(', ')]);
  summary.push(['nodata', nodata === null ? 'なし' : formatNumber(nodata)]);
  summary.push(['RSET', images.length > 1 ? `${images.length - 1} 段` : 'なし']);
  if (options.masks) summary.push(['マスク', `${options.masks} 枚`]);
  if (fd.hasTag(50844)) summary.push(['RPC', 'あり（RPCCoefficientTag）']);
  for (const [key, value] of Object.entries(header?.structural ?? {})) summary.push([`GDAL 構造 ${key}`, value]);

  const levels: Array<[string, string]> = images.map((level, i) => {
    const factor = image.getWidth() / level.getWidth();
    const size = `${level.getWidth().toLocaleString()} × ${level.getHeight().toLocaleString()} px`;
    const layout = level.isTiled ? `タイル ${level.getTileWidth()}×${level.getTileHeight()}` : 'ストリップ';
    const c = named(COMPRESSION, level.fileDirectory.getValue('Compression') as number | undefined);
    return [i === 0 ? '原画像' : `RSET ${i}（1/${Number(factor.toPrecision(3))}）`, `${size}・${layout}・圧縮 ${c}`];
  });

  const bands: Array<[string, string]> = [];
  for (let s = 0; s < samples; s++) {
    const own = items.filter((item) => item.sample === s && !item.domain);
    const parts = [types[s]];
    const description = own.find((item) => item.name === 'DESCRIPTION');
    if (description?.value) parts.unshift(description.value);
    for (const item of own) if (item !== description) parts.push(`${item.name}=${item.value}`);
    bands.push([`バンド ${s + 1}`, parts.join('・')]);
  }

  const geo: Array<[string, string]> = [];
  const keys = image.getGeoKeys() ?? {};
  for (const [key, value] of Object.entries(keys) as Array<[string, unknown]>) {
    let text = formatValue(value);
    if (key === 'GTModelTypeGeoKey') text = named(MODEL_TYPE, value as number);
    else if (key === 'GTRasterTypeGeoKey') text = named(RASTER_TYPE, value as number);
    else if (/UnitsGeoKey$/.test(key)) text = named(UNITS, value as number);
    else if (EPSG_KEYS.has(key) && typeof value === 'number') text = value === 32767 ? 'ユーザー定義（32767）' : `EPSG:${value}`;
    geo.push([key, text]);
  }
  try {
    geo.push(['原点', image.getOrigin().map(formatNumber).join(', ')]);
    geo.push(['画素の大きさ', image.getResolution().map(formatNumber).join(', ')]);
    geo.push(['範囲', image.getBoundingBox().map(formatNumber).join(', ')]);
  } catch {
    geo.push(['地理参照', 'なし（ModelTiepoint・ModelTransformation がありません）']);
  }

  const gdal: Array<[string, string]> = items
    .filter((item) => item.sample === undefined || item.domain)
    .map((item: GdalMetadataItem) => [`${item.domain ? `${item.domain}: ` : ''}${item.sample !== undefined ? `バンド ${item.sample + 1} ` : ''}${item.name}`, item.value]);

  const sections: MetadataSection[] = [
    { title: '概要', rows: summary },
    { title: 'バンド', rows: bands },
    { title: '地理参照（GeoKeys）', rows: geo },
  ];
  if (gdal.length) sections.push({ title: 'GDAL メタデータ', rows: gdal });
  sections.push({ title: 'IFD 構成', rows: levels });
  sections.push({ title: 'TIFF タグ（原画像）', rows: await tagsOf(image) });
  return sections;
}

/** The sections as text: a heading per section, then `name<TAB>value` lines. */
export function sectionsToText(sections: readonly MetadataSection[]): string {
  return sections.map((s) => [`## ${s.title}`, ...s.rows.map(([k, v]) => `${k}\t${v}`)].join('\n')).join('\n\n');
}

/** The sections as JSON: `{ "概要": { "サイズ": "…", … }, … }`. */
export function sectionsToJson(sections: readonly MetadataSection[]): string {
  return JSON.stringify(Object.fromEntries(sections.map((s) => [s.title, Object.fromEntries(s.rows)])), null, 2);
}

export class MetadataDialog {
  readonly dialog: HTMLDialogElement;
  private readonly title_: HTMLElement;
  private readonly body_: HTMLElement;
  private sections_: MetadataSection[] = [];
  private request_ = 0;

  constructor(private readonly options: { say: (message: string) => void }) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service metadata-dialog';
    this.dialog.setAttribute('aria-labelledby', 'metadata-title');
    this.dialog.innerHTML = `
      <h2 id="metadata-title">メタデータ</h2>
      <div class="metadata-body"></div>
      <div class="service-actions">
        <button type="button" value="text">テキストでコピー</button>
        <button type="button" value="json">JSON でコピー</button>
        <button type="button" value="close" class="primary">閉じる</button>
      </div>`;
    document.body.append(this.dialog);
    this.title_ = this.dialog.querySelector('h2')!;
    this.body_ = this.dialog.querySelector('.metadata-body')!;
    this.dialog.querySelector('button[value=close]')!.addEventListener('click', () => this.dialog.close());
    this.dialog.querySelector('button[value=text]')!.addEventListener('click', () => void this.copy_(sectionsToText(this.sections_)));
    this.dialog.querySelector('button[value=json]')!.addEventListener('click', () => void this.copy_(sectionsToJson(this.sections_)));
  }

  /** The sections shown now (for the test). */
  sections(): readonly MetadataSection[] {
    return this.sections_;
  }

  /** Opens the dialog for an image layer and fills it once the tags are read. */
  async open(image: ViewerImage): Promise<void> {
    const request = ++this.request_;
    this.title_.textContent = `メタデータ — ${image.name}`;
    this.sections_ = [];
    this.body_.replaceChildren(Object.assign(document.createElement('p'), { className: 'service-status', textContent: '読み込み中…' }));
    if (!this.dialog.open) this.dialog.showModal();
    let sections: MetadataSection[];
    try {
      const sources = image.source.getTiffImages() as GeoTIFFImage[][];
      const masks = (image.source as unknown as { sourceMasks_?: unknown[][] }).sourceMasks_ ?? [];
      if (!sources.length || !sources[0].length) throw new Error('GeoTIFF の情報がまだ読まれていません');
      const all = await Promise.all(sources.map((levels, i) => describeTiff(levels, { name: image.name, masks: masks[i]?.length ?? 0 })));
      sections = all.length === 1 ? all[0] : all.flatMap((list, i) => list.map((s) => ({ ...s, title: `ソース ${i + 1}: ${s.title}` })));
    } catch (error) {
      sections = [{ title: 'エラー', rows: [['読み込み', (error as Error).message]] }];
    }
    if (request !== this.request_) return;
    this.sections_ = sections;
    this.body_.replaceChildren(...sections.map(renderSection));
  }

  private async copy_(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.options.say('メタデータをコピーしました');
    } catch {
      this.options.say('クリップボードにコピーできませんでした');
    }
  }
}

function renderSection(section: MetadataSection): HTMLElement {
  const details = document.createElement('details');
  details.open = section.title !== 'TIFF タグ（原画像）' || section.rows.length < 40;
  const summary = document.createElement('summary');
  summary.textContent = section.title;
  const list = document.createElement('dl');
  list.className = 'info metadata-list';
  for (const [term, value] of section.rows) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    list.append(dt, dd);
  }
  details.append(summary, list);
  return details;
}
