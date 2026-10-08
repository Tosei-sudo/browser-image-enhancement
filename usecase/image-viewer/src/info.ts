/** The information panel: what the selected layer is and where it lies. */
import { get as getProjection } from 'ol/proj.js';
import type { ViewerLayer } from './images.js';
import { sensorPlacement } from './sensor-projection.js';

/** Counts the calls: only the latest fills the panel (one for the same layer, with newer facts, may overtake it). */
let calls = 0;

/** Fills `element` with the facts of `image` (cleared for none). */
export async function showInfo(element: HTMLDListElement, image: ViewerLayer | null, extra: Array<[string, string]> = []): Promise<void> {
  const call = ++calls;
  element.replaceChildren();
  if (!image) return;
  if (image.type === 'service') {
    fill(element, image.service.info);
    return;
  }
  const view = await image.source.getView().catch(() => null);
  if (call !== calls || !view) return;

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
  const names = await image.source.getBandNames().catch(() => []);
  if (call !== calls) return;
  if (names.some((n) => n)) rows.push(['バンド名', names.map((n, i) => n ?? `バンド ${i + 1}`).join(', ')]);
  const sensor = sensorPlacement(projection);
  if (image.kind === 'geotiff' && sensor) {
    // Pixels warped through the sensor model as they are drawn: say how, and the ground size of a pixel.
    rows.push(['座標系', 'WGS 84（センサーモデルで投影）']);
    rows.push([
      '投影',
      sensor.kind === 'rpc'
        ? `RPC・高さ ${formatNumber(sensor.height ?? 0)} m（地形の補正はオルソ補正で）`
        : `GCP ${sensor.points} 点・${sensor.order} 次多項式（残差 ${(sensor.rms ?? 0).toFixed(2)} px）`,
    ]);
    const meters = projection?.getMetersPerUnit();
    if (meters) rows.push(['解像度', `約 ${formatNumber(meters)} m/px`]);
  } else if (image.kind === 'geotiff') {
    rows.push(['座標系', code]);
    if (finest) rows.push(['解像度', `${formatNumber(finest)} ${projection?.getUnits() === 'degrees' ? '度' : 'm'}/px`]);
    if (extent) rows.push(['範囲', extent.map(formatNumber).join(', ')]);
  }

  fill(element, [...rows, ...extra]);
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
