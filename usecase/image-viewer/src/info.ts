/** The information panel: what the selected layer is and where it lies. */
import { get as getProjection } from 'ol/proj.js';
import type { ViewerLayer } from './images.js';

let shown: ViewerLayer | null = null;

/** Fills `element` with the facts of `image` (cleared for none). */
export async function showInfo(element: HTMLDListElement, image: ViewerLayer | null): Promise<void> {
  shown = image;
  element.replaceChildren();
  if (!image) return;
  if (image.type === 'service') {
    fill(element, image.service.info);
    return;
  }
  const view = await image.source.getView().catch(() => null);
  if (shown !== image || !view) return;

  const projection = view.projection ? getProjection(view.projection) : null;
  const code = projection?.getCode() ?? '不明';
  // The tile grid's finest level is the image's own resolution (the view may zoom in past it).
  const grid = image.source.getTileGrid()?.getResolutions();
  const finest = grid?.length ? Math.min(...grid) : view.resolution;
  const extent = view.extent;
  const rows: Array<[string, string]> = [
    ['名前', image.name],
    ['種類', image.kind === 'geotiff' ? 'GeoTIFF' : '画像'],
  ];
  if (extent && finest) {
    const width = Math.round((extent[2] - extent[0]) / finest);
    const height = Math.round((extent[3] - extent[1]) / finest);
    rows.push(['サイズ', `${width.toLocaleString()} × ${height.toLocaleString()} px`]);
  }
  const bands = image.source.getValueBandCount();
  const mode = image.source.getColorMode();
  rows.push(['バンド数', `${bands}${mode === 'gray' ? '（グレー表示）' : ''}`]);
  if (image.kind === 'geotiff') {
    rows.push(['座標系', code]);
    if (finest) rows.push(['解像度', `${formatNumber(finest)} ${projection?.getUnits() === 'degrees' ? '度' : 'm'}/px`]);
    if (extent) rows.push(['範囲', extent.map(formatNumber).join(', ')]);
  }

  fill(element, rows);
}

function fill(element: HTMLDListElement, rows: Array<[string, string]>): void {
  for (const [term, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    element.append(dt, dd);
  }
}

function formatNumber(n: number): string {
  return Math.abs(n) >= 1000 ? n.toFixed(0) : Number(n.toPrecision(6)).toString();
}
