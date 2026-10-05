import { describe, expect, it } from 'vitest';
import ReprojDataTile from 'ol/reproj/DataTile.js';
import TileGrid from 'ol/tilegrid/TileGrid.js';
import { createXYZ } from 'ol/tilegrid.js';
import { get as getProjection, transform } from 'ol/proj.js';
import { reprojectTile } from '../../src/openlayers/cpu-reproject.js';

/*
 * The CPU reprojection, on OpenLayers' own reprojection tile: a 4326 image
 * whose pixels hold their own column and row, drawn on a Web Mercator tile.
 * The browser test compares it with OpenLayers' WebGL reprojection.
 */

const LOADED = 2;
const SIZE = 64; // source tile size
const PX = 1 / 256; // degrees per source pixel
const EXTENT = [139, 35, 140, 36]; // 256 × 256 px

const sourceGrid = new TileGrid({ extent: EXTENT, origin: [EXTENT[0], EXTENT[3]], resolutions: [PX], tileSize: SIZE });
const targetGrid = createXYZ({ extent: getProjection('EPSG:3857')!.getExtent(), tileSize: SIZE });

/** A loaded source tile: band 0 its column, band 1 its row (in the whole image), optionally alpha. */
function sourceTile(x: number, y: number, alpha: boolean) {
  const bands = alpha ? 3 : 2;
  const data = new Float32Array(SIZE * SIZE * bands);
  for (let j = 0; j < SIZE; j++) {
    for (let i = 0; i < SIZE; i++) {
      const o = (j * SIZE + i) * bands;
      data[o] = x * SIZE + i;
      data[o + 1] = y * SIZE + j;
      if (alpha) data[o + 2] = 1;
    }
  }
  return { tileCoord: [0, x, y], getState: () => LOADED, getSize: () => [SIZE, SIZE], getData: () => data, load: () => {} };
}

/** The Web Mercator tile at zoom `z` holding `lonLat`, reprojected from the image. */
function reprojected(lonLat: [number, number], z: number, { interpolate = false, alpha = false } = {}) {
  const [x, y] = transform(lonLat, 'EPSG:4326', 'EPSG:3857');
  const coord = targetGrid.getTileCoordForCoordAndZ([x, y], z);
  const tile = new ReprojDataTile({
    sourceProj: getProjection('EPSG:4326')!,
    sourceTileGrid: sourceGrid,
    targetProj: getProjection('EPSG:3857')!,
    targetTileGrid: targetGrid,
    tileCoord: coord,
    wrappedTileCoord: coord,
    pixelRatio: 1,
    gutter: 0,
    hasAlpha: alpha,
    interpolate,
    getTileFunction: (_z: number, tx: number, ty: number) => sourceTile(tx, ty, alpha) as never,
  });
  expect(reprojectTile(tile as never)).toBe(true);
  expect(tile.getState()).toBe(LOADED);
  return { tile, extent: targetGrid.getTileCoordExtent(coord), data: tile.getData() as Float32Array, size: tile.getSize() };
}

/** The source pixel (column, row) under target pixel (i, j) of the tile, through the exact projection. */
function expected(extent: number[], size: number[], i: number, j: number) {
  const x = extent[0] + ((i + 0.5) / size[0]) * (extent[2] - extent[0]);
  const y = extent[3] - ((j + 0.5) / size[1]) * (extent[3] - extent[1]);
  const [lon, lat] = transform([x, y], 'EPSG:3857', 'EPSG:4326');
  return [(lon - EXTENT[0]) / PX, (EXTENT[3] - lat) / PX];
}

describe('CPU reprojection', () => {
  it('samples each target pixel from the source pixel the projection puts under it (nearest)', () => {
    const { data, size, extent } = reprojected([139.5, 35.5], 9);
    const bands = 3; // column, row, coverage
    let checked = 0;
    for (let j = 0; j < size[1]; j++) {
      for (let i = 0; i < size[0]; i++) {
        const [col, row] = expected(extent, size, i, j);
        const o = (j * size[0] + i) * bands;
        if (col < 0.5 || col > 255.5 || row < 0.5 || row > 255.5) continue; // too close to the edge to tell
        // Within the triangulation's error (half a source pixel) of the exact position.
        expect(Math.abs(data[o] - Math.floor(col))).toBeLessThanOrEqual(1);
        expect(Math.abs(data[o + 1] - Math.floor(row))).toBeLessThanOrEqual(1);
        expect(data[o + 2]).toBe(1);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(size[0] * size[1] * 0.9);
  });

  it('interpolates bilinearly between source pixel centers', () => {
    // Zoomed in past the image's resolution: the target pixels fall between source pixels.
    const { data, size, extent } = reprojected([139.5, 35.5], 13, { interpolate: true });
    for (let j = 0; j < size[1]; j += 7) {
      for (let i = 0; i < size[0]; i += 7) {
        const [col, row] = expected(extent, size, i, j);
        const o = (j * size[0] + i) * 3;
        // A linear ramp is reproduced exactly by bilinear sampling (centers at +0.5).
        expect(data[o]).toBeCloseTo(col - 0.5, 1);
        expect(data[o + 1]).toBeCloseTo(row - 0.5, 1);
      }
    }
  });

  it('marks the target pixels outside the image transparent', () => {
    // A tile across the image's western edge.
    const { data, size, extent } = reprojected([139.0, 35.5], 9);
    let inside = 0;
    let outside = 0;
    for (let j = 0; j < size[1]; j++) {
      for (let i = 0; i < size[0]; i++) {
        const [col, row] = expected(extent, size, i, j);
        const coverage = data[(j * size[0] + i) * 3 + 2];
        if (col < -1 || row < -1 || col > 257 || row > 257) {
          expect(coverage).toBe(0);
          outside++;
        } else if (col > 1 && row > 1 && col < 255 && row < 255) {
          expect(coverage).toBe(1);
          inside++;
        }
      }
    }
    expect(inside).toBeGreaterThan(100);
    expect(outside).toBeGreaterThan(100);
  });

  it('keeps the source’s own alpha band instead of adding one', () => {
    const { data, size } = reprojected([139.5, 35.5], 9, { alpha: true });
    expect(data.length).toBe(size[0] * size[1] * 3);
  });
});
