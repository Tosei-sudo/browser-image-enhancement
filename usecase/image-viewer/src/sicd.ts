/**
 * The parts of a SICD (Sensor Independent Complex Data, NGA.STND.0024) XML
 * the viewer uses: how the complex pixels are stored, where the image's
 * corners are on the ground, and a few facts about the collection for the
 * layer's information. The XML is read with regular expressions, so it also
 * works in workers and tests, where there is no DOMParser.
 */
import { ComplexKind } from './complex-decoder.js';

export interface SicdInfo {
  pixelType: string;
  kind: ComplexKind;
  /** For AMP8I_PHS8I: the amplitude of each of the 256 stored values, when the XML gives a table. */
  ampTable: number[] | null;
  rows: number;
  cols: number;
  /**
   * The image corners (pixel centres) as longitude, latitude: first row
   * first column, first row last column, last row last column, last row
   * first column.
   */
  corners: Array<[number, number]> | null;
  /** Facts for the layer's information, as label and text. */
  facts: Array<[string, string]>;
  /** The same facts by their SICD element names (ASCII, for GDAL metadata). */
  fields: Array<[string, string]>;
}

/** Whether `text` is a SICD XML. */
export function isSicdXml(text: string): boolean {
  return /<(\w+:)?SICD[\s>]/.test(text);
}

/** The first element named `name` (any namespace prefix) inside `xml`: its content, or null. */
function element(xml: string | null, name: string): string | null {
  if (xml === null) return null;
  const m = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml);
  return m ? m[1] : null;
}

/** Every element named `name` inside `xml`, with its attributes and content. */
function elements(xml: string | null, name: string): Array<{ attributes: string; content: string }> {
  if (xml === null) return [];
  return [...xml.matchAll(new RegExp(`<(?:\\w+:)?${name}(\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'g'))].map((m) => ({ attributes: m[1] ?? '', content: m[2] }));
}

/** The text at a path of element names, trimmed; null when it is not there. */
function text(xml: string, ...path: string[]): string | null {
  let at: string | null = xml;
  for (const name of path) at = element(at, name);
  return at?.trim() || null;
}

const KINDS: Record<string, ComplexKind> = {
  RE32F_IM32F: ComplexKind.Float32,
  RE16I_IM16I: ComplexKind.Int16,
  AMP8I_PHS8I: ComplexKind.AmpPhase8,
};

/** Reads a SICD XML. Throws when it has no pixel type the viewer knows. */
export function parseSicd(xml: string): SicdInfo {
  const pixelType = text(xml, 'ImageData', 'PixelType') ?? '';
  const kind = KINDS[pixelType];
  if (!kind) throw new Error(`SICD の画素形式 ${pixelType || '（不明）'} には対応していません`);
  const imageData = element(xml, 'ImageData');
  let ampTable: number[] | null = null;
  const amps = elements(element(imageData, 'AmpTable'), 'Amplitude');
  if (amps.length === 256) {
    ampTable = new Array<number>(256).fill(0);
    for (const a of amps) {
      const i = Number(/index="(\d+)"/.exec(a.attributes)?.[1]);
      if (i >= 0 && i < 256) ampTable[i] = Number(a.content);
    }
  }
  const rows = Number(text(xml, 'ImageData', 'NumRows'));
  const cols = Number(text(xml, 'ImageData', 'NumCols'));

  let corners: SicdInfo['corners'] = null;
  const icps = elements(element(element(xml, 'GeoData'), 'ImageCorners'), 'ICP');
  if (icps.length === 4) {
    const order = ['1:FRFC', '2:FRLC', '3:LRLC', '4:LRFC'];
    const sorted = order.map((index, k) => icps.find((p) => p.attributes.includes(`"${index}"`)) ?? icps[k]);
    corners = sorted.map((p) => [Number(text(p.content, 'Lon')), Number(text(p.content, 'Lat'))] as [number, number]);
    if (!corners.flat().every(Number.isFinite)) corners = null;
  }

  const facts: Array<[string, string]> = [['画素形式', pixelType]];
  const fields: Array<[string, string]> = [['PixelType', pixelType]];
  const add = (label: string, field: string, value: string | null) => {
    if (!value) return;
    facts.push([label, value]);
    fields.push([field, value]);
  };
  add('センサー', 'CollectorName', text(xml, 'CollectionInfo', 'CollectorName'));
  add('収集 ID', 'CoreName', text(xml, 'CollectionInfo', 'CoreName'));
  add('観測モード', 'ModeType', text(xml, 'CollectionInfo', 'RadarMode', 'ModeType'));
  add('観測開始', 'CollectStart', text(xml, 'Timeline', 'CollectStart'));
  add('偏波', 'TxRcvPolarizationProc', text(xml, 'ImageFormation', 'TxRcvPolarizationProc'));
  add('画像形成', 'ImageFormAlgo', text(xml, 'ImageFormation', 'ImageFormAlgo'));
  add('画像面', 'ImagePlane', text(xml, 'Grid', 'ImagePlane'));
  add('観測方向', 'SideOfTrack', text(xml, 'SCPCOA', 'SideOfTrack'));
  const spacing = (axis: string) => {
    const v = Number(text(xml, 'Grid', axis, 'SS'));
    return Number.isFinite(v) && v > 0 ? `${Number(v.toPrecision(4))} m` : null;
  };
  const rowSpacing = spacing('Row');
  const colSpacing = spacing('Col');
  if (rowSpacing || colSpacing) facts.push(['画素間隔（行・列方向）', `${rowSpacing ?? '?'} × ${colSpacing ?? '?'}`]);
  const graze = Number(text(xml, 'SCPCOA', 'GrazeAng'));
  if (Number.isFinite(graze) && text(xml, 'SCPCOA', 'GrazeAng')) facts.push(['入射角（SCP）', `${Number((90 - graze).toFixed(2))}°`]);
  return { pixelType, kind, ampTable, rows, cols, corners, facts, fields };
}
