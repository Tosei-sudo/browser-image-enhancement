/**
 * Printing the map ("印刷レイアウト"): the view laid out on a sheet of A4 or
 * A3 with a title, a scale bar, a north arrow, a legend of the layers shown
 * and a footer (date, sources, a note), saved as a PDF or a PNG. The map is
 * drawn afresh at the sheet's resolution over at least the area shown now
 * (see `drawView`), so it is sharp and holds what is on screen, notes
 * (annotations.ts) included.
 */
import type OlMap from 'ol/Map.js';
import { getPointResolution } from 'ol/proj.js';
import { drawViewInStrips, pixelRatioOf } from './view-export.js';

/** Sheet sizes, millimetres (portrait). */
export const PAPERS = { A4: [210, 297], A3: [297, 420] } as const;
export type Paper = keyof typeof PAPERS;
export type Orientation = 'portrait' | 'landscape';

const MM_PER_INCH = 25.4;

/** A sheet's size in millimetres. */
export function paperSize(paper: Paper, orientation: Orientation): [number, number] {
  const [w, h] = PAPERS[paper];
  return orientation === 'portrait' ? [w, h] : [h, w];
}

/** A round length (1, 2 or 5 × 10ⁿ metres) no longer than `max` metres, and how to write it. */
export function niceLength(max: number): { metres: number; label: string } {
  if (!(max > 0)) return { metres: 0, label: '' };
  const power = 10 ** Math.floor(Math.log10(max));
  const metres = [5, 2, 1].map((k) => k * power).find((v) => v <= max) ?? power;
  return { metres, label: metres >= 1000 ? `${metres / 1000} km` : metres >= 1 ? `${metres} m` : `${Math.round(metres * 100)} cm` };
}

/**
 * A one-page PDF of a JPEG (`jpeg`, `width` × `height` pixels) filling a
 * sheet of `pageWidth` × `pageHeight` points.
 */
export function pdfOfJpeg(jpeg: Uint8Array, width: number, height: number, pageWidth: number, pageHeight: number): Blob {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let at = 0;
  const push = (part: Uint8Array | string) => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part;
    parts.push(bytes);
    at += bytes.length;
  };
  const object = (n: number, body: string, stream?: Uint8Array) => {
    offsets[n] = at;
    push(`${n} 0 obj\n${body}\n`);
    if (stream) {
      push('stream\n');
      push(stream);
      push('\nendstream\n');
    }
    push('endobj\n');
  };
  const w = pageWidth.toFixed(2);
  const h = pageHeight.toFixed(2);
  const content = encoder.encode(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`);
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  object(4, `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg);
  object(5, `<< /Length ${content.length} >>`, content);
  const xref = at;
  push(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: 'application/pdf' });
}

/** One row of the legend. */
export interface LegendEntry {
  name: string;
  /** A filled box (`fill`, `stroke`), a line (`stroke` only), a color ramp, or a picture. */
  swatch: { kind: 'fill'; fill: string; stroke: string } | { kind: 'line'; stroke: string } | { kind: 'ramp'; stops: string[] } | { kind: 'image' };
}

export interface PrintRequest {
  paper: Paper;
  orientation: Orientation;
  /** Dots per inch of the sheet drawn. */
  dpi: number;
  title: string;
  /** A line under the map (an author, a purpose). */
  note: string;
  scaleBar: boolean;
  northArrow: boolean;
  legend: LegendEntry[] | null;
  /** Sources to credit (base maps, services). */
  sources: string[];
}

/** Where the parts of the sheet go, in sheet pixels. */
export interface SheetLayout {
  width: number;
  height: number;
  /** The map's frame: x, y, width, height. */
  frame: [number, number, number, number];
  /** Pixels per millimetre. */
  mm: number;
}

/** The sheet in pixels: margins of 10 mm, a band for the title, a band for the footer. */
export function sheetLayout(request: Pick<PrintRequest, 'paper' | 'orientation' | 'dpi' | 'title'>): SheetLayout {
  const [wmm, hmm] = paperSize(request.paper, request.orientation);
  const mm = request.dpi / MM_PER_INCH;
  const width = Math.round(wmm * mm);
  const height = Math.round(hmm * mm);
  const margin = 10 * mm;
  const top = margin + (request.title.trim() ? 12 * mm : 0);
  const bottom = margin + 9 * mm;
  return { width, height, frame: [Math.round(margin), Math.round(top), Math.round(width - 2 * margin), Math.round(height - top - bottom)], mm };
}

/** Draws the sheet: the view over the frame, then the title, the furniture and the footer. */
export async function drawSheet(map: OlMap, request: PrintRequest): Promise<HTMLCanvasElement> {
  const layout = sheetLayout(request);
  const { width, height, frame, mm } = layout;
  const [fx, fy, fw, fh] = frame;
  const size = map.getSize();
  const view = map.getView();
  const resolution = view.getResolution();
  const center = view.getCenter();
  if (!size || !resolution || !center) throw new Error('地図が非表示');

  // The frame holds at least the area shown now: the larger of the two scales.
  const ratio = pixelRatioOf(map);
  const cssW = fw / ratio;
  const cssH = fh / ratio;
  const scale = Math.min(cssW / size[0], cssH / size[1]);
  const big = [size[0] * scale, size[1] * scale];
  const part: [number, number, number, number] = [(big[0] - cssW) / 2, (big[1] - cssH) / 2, cssW, cssH];
  const drawn = await drawViewInStrips(map, scale, part);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(drawn.canvas, fx, fy, fw, fh);
  drawn.canvas.width = drawn.canvas.height = 0;
  ctx.strokeStyle = '#111827';
  ctx.lineWidth = Math.max(1, 0.3 * mm);
  ctx.strokeRect(fx, fy, fw, fh);

  const font = (sizeMm: number, weight = 'normal') => `${weight} ${Math.round(sizeMm * mm)}px system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif`;
  if (request.title.trim()) {
    ctx.fillStyle = '#111827';
    ctx.font = font(6, 'bold');
    ctx.textBaseline = 'middle';
    ctx.fillText(request.title.trim(), fx, fy - 6 * mm, fw);
  }

  // Metres per sheet pixel at the middle of the map.
  const sheetResolution = resolution / scale / ratio;
  const metresPerPixel = getPointResolution(view.getProjection(), sheetResolution, center, 'm');
  const pad = 4 * mm;
  if (request.scaleBar && metresPerPixel > 0) drawScaleBar(ctx, fx + pad, fy + fh - pad, fw * 0.25, metresPerPixel, mm, font);
  if (request.northArrow) drawNorthArrow(ctx, fx + fw - pad - 6 * mm, fy + pad + 9 * mm, view.getRotation(), mm, font);
  if (request.legend?.length) drawLegend(ctx, fx + fw - pad, fy + fh - pad, request.legend, mm, font);

  // Footer: the scale, the date, the sources and the note.
  ctx.fillStyle = '#374151';
  ctx.font = font(2.6);
  ctx.textBaseline = 'top';
  const denominator = Math.round((metresPerPixel * 1000) / (1 / mm));
  const date = new Date().toLocaleDateString('ja-JP');
  const left = [`縮尺 約 1:${roundScale(denominator).toLocaleString()}（${request.paper} ${request.orientation === 'portrait' ? '縦' : '横'}）`, date, request.note.trim()].filter(Boolean).join('　');
  ctx.fillText(left, fx, fy + fh + 2 * mm, fw);
  if (request.sources.length) {
    ctx.fillStyle = '#6b7280';
    ctx.fillText(`出典: ${request.sources.join('、')}`, fx, fy + fh + 5.5 * mm, fw);
  }
  return canvas;
}

/** A scale denominator rounded to 2 significant figures. */
export function roundScale(denominator: number): number {
  if (!(denominator > 0)) return 0;
  const power = 10 ** Math.max(0, Math.floor(Math.log10(denominator)) - 1);
  return Math.round(denominator / power) * power;
}

type FontOf = (sizeMm: number, weight?: string) => string;

function drawScaleBar(ctx: CanvasRenderingContext2D, x: number, bottom: number, maxWidth: number, metresPerPixel: number, mm: number, font: FontOf): void {
  const { metres, label } = niceLength(maxWidth * metresPerPixel);
  if (!metres) return;
  const w = metres / metresPerPixel;
  const h = 1.6 * mm;
  const y = bottom - h;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.fillRect(x - 2 * mm, y - 6 * mm, w + 4 * mm + 12 * mm, h + 8 * mm);
  // Two halves, black and white.
  ctx.fillStyle = '#111827';
  ctx.fillRect(x, y, w / 2, h);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x + w / 2, y, w / 2, h);
  ctx.strokeStyle = '#111827';
  ctx.lineWidth = Math.max(1, 0.25 * mm);
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = '#111827';
  ctx.font = font(2.8);
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  ctx.fillText('0', x - 0.6 * mm, y - 0.8 * mm);
  ctx.fillText(label, x + w - 1.5 * mm, y - 0.8 * mm);
}

function drawNorthArrow(ctx: CanvasRenderingContext2D, cx: number, cy: number, rotation: number, mm: number, font: FontOf): void {
  const r = 6 * mm;
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.beginPath();
  ctx.arc(cx, cy, r + 2 * mm, 0, 2 * Math.PI);
  ctx.fill();
  ctx.translate(cx, cy);
  // The view turned clockwise by `rotation` turns north the same way.
  ctx.rotate(rotation);
  ctx.fillStyle = '#111827';
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r * 0.45, r * 0.6);
  ctx.lineTo(0, r * 0.25);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#9ca3af';
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(-r * 0.45, r * 0.6);
  ctx.lineTo(0, r * 0.25);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#111827';
  ctx.font = font(3.2, 'bold');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('N', 0, -r - 0.3 * mm);
  ctx.restore();
}

function drawLegend(ctx: CanvasRenderingContext2D, right: number, bottom: number, entries: LegendEntry[], mm: number, font: FontOf): void {
  const shown = entries.slice(0, 24);
  const row = 5 * mm;
  const swatch = 4 * mm;
  ctx.font = font(2.8);
  const textWidth = Math.min(60 * mm, Math.max(...shown.map((e) => ctx.measureText(e.name).width)));
  const w = 3 * mm + swatch + 2 * mm + textWidth + 3 * mm;
  const h = 2 * mm + 5 * mm + shown.length * row + 1 * mm;
  const x = right - w;
  const y = bottom - h;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#9ca3af';
  ctx.lineWidth = Math.max(1, 0.2 * mm);
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = '#111827';
  ctx.font = font(3, 'bold');
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText('凡例', x + 3 * mm, y + 2 * mm);
  ctx.font = font(2.8);
  ctx.textBaseline = 'middle';
  shown.forEach((entry, i) => {
    const sy = y + 7 * mm + i * row;
    const sx = x + 3 * mm;
    const s = entry.swatch;
    if (s.kind === 'fill') {
      ctx.fillStyle = s.fill;
      ctx.fillRect(sx, sy, swatch, swatch * 0.75);
      ctx.strokeStyle = s.stroke;
      ctx.strokeRect(sx, sy, swatch, swatch * 0.75);
    } else if (s.kind === 'line') {
      ctx.strokeStyle = s.stroke;
      ctx.lineWidth = 0.6 * mm;
      ctx.beginPath();
      ctx.moveTo(sx, sy + swatch * 0.4);
      ctx.lineTo(sx + swatch, sy + swatch * 0.4);
      ctx.stroke();
      ctx.lineWidth = Math.max(1, 0.2 * mm);
    } else if (s.kind === 'ramp') {
      const g = ctx.createLinearGradient(sx, 0, sx + swatch, 0);
      s.stops.forEach((c, k) => g.addColorStop(s.stops.length > 1 ? k / (s.stops.length - 1) : 0, c));
      ctx.fillStyle = g;
      ctx.fillRect(sx, sy, swatch, swatch * 0.75);
    } else {
      const g = ctx.createLinearGradient(sx, sy, sx + swatch, sy + swatch);
      g.addColorStop(0, '#94a3b8');
      g.addColorStop(1, '#334155');
      ctx.fillStyle = g;
      ctx.fillRect(sx, sy, swatch, swatch * 0.75);
    }
    ctx.fillStyle = '#111827';
    ctx.fillText(entry.name, sx + swatch + 2 * mm, sy + swatch * 0.38, textWidth);
  });
  if (entries.length > shown.length) {
    ctx.fillStyle = '#6b7280';
    ctx.fillText(`ほか ${entries.length - shown.length} 件`, x + 3 * mm, y + h - 1 * mm);
  }
}

/** The sheet as a PDF (a JPEG of it on one page) or a PNG. */
export async function sheetFile(canvas: HTMLCanvasElement, request: Pick<PrintRequest, 'paper' | 'orientation'>, format: 'pdf' | 'png'): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, format === 'pdf' ? 'image/jpeg' : 'image/png', 0.92));
  if (!blob) throw new Error('画像化に失敗（大きすぎ）');
  if (format === 'png') return blob;
  const [wmm, hmm] = paperSize(request.paper, request.orientation);
  const points = (v: number) => (v / MM_PER_INCH) * 72;
  return pdfOfJpeg(new Uint8Array(await blob.arrayBuffer()), canvas.width, canvas.height, points(wmm), points(hmm));
}
