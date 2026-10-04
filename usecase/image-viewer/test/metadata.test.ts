import { describe, expect, it } from 'vitest';
import { fromArrayBuffer, globals, writeArrayBuffer, type GeoTIFFImage } from 'geotiff';
import { imageToGeoTIFF } from 'browser-image-enhancement/openlayers';
import { describeTiff, sectionsToJson, sectionsToText, type MetadataSection } from '../src/metadata.js';

globals.fieldTagTypes[globals.tags.GDAL_METADATA] = 'ASCII';
globals.fieldTagTypes[globals.tags.GDAL_NODATA] = 'ASCII';

async function imagesOf(bytes: ArrayBuffer): Promise<GeoTIFFImage[]> {
  const tiff = await fromArrayBuffer(bytes);
  const count = await tiff.getImageCount();
  return Promise.all(Array.from({ length: count }, (_, i) => tiff.getImage(i)));
}

/** A tiled RGB GeoTIFF with overviews (RSET), as the viewer writes plain pictures. */
const tiledTiff = (width: number, height: number) =>
  imageToGeoTIFF({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(200) }, { extent: [0, 0, width, height] }).arrayBuffer();

const rows = (sections: MetadataSection[], title: string) => Object.fromEntries(sections.find((s) => s.title === title)?.rows ?? []);

describe('describeTiff', () => {
  it('lists bands with their GDAL names, nodata, GeoKeys and GDAL metadata', async () => {
    const bytes = writeArrayBuffer(new Uint16Array(8 * 4 * 2), {
      width: 8,
      height: 4,
      SamplesPerPixel: 2,
      BitsPerSample: [16, 16],
      SampleFormat: [1, 1],
      PhotometricInterpretation: 1,
      GDAL_METADATA:
        '<GDALMetadata><Item name="AREA_OR_POINT">Area</Item><Item name="DESCRIPTION" sample="0" role="description">Red</Item>' +
        '<Item name="DESCRIPTION" sample="1" role="description">NIR</Item><Item name="STATISTICS_MEAN" sample="1">812.5</Item></GDALMetadata>',
      GDAL_NODATA: '0',
      ModelPixelScale: [30, 30, 0],
      ModelTiepoint: [0, 0, 0, 500000, 4000000, 0],
      ProjectedCSTypeGeoKey: 32654,
      GTModelTypeGeoKey: 1,
      GTRasterTypeGeoKey: 1,
    });
    const sections = await describeTiff(await imagesOf(bytes), { name: 'scene.tif' });

    const summary = rows(sections, '概要');
    expect(summary['ファイル']).toBe('scene.tif');
    expect(summary['形式']).toBe('TIFF・ビッグエンディアン'); // as geotiff.js writes it
    expect(summary['サイズ']).toBe('8 × 4 px');
    expect(summary['データ型']).toBe('UInt16');
    expect(summary['nodata']).toBe('0');
    expect(summary['配置']).toMatch(/^ストリップ/);
    expect(summary['COG']).toMatch(/^いいえ（ストリップ形式/);

    expect(rows(sections, 'バンド')).toEqual({ 'バンド 1': 'Red・UInt16', 'バンド 2': 'NIR・UInt16・STATISTICS_MEAN=812.5' });
    const geo = rows(sections, '地理参照（GeoKeys）');
    expect(geo.ProjectedCSTypeGeoKey).toBe('EPSG:32654');
    expect(geo.GTModelTypeGeoKey).toBe('投影座標系（1）');
    expect(geo['画素の大きさ']).toBe('30, -30, 0');
    expect(rows(sections, 'GDAL メタデータ')).toEqual({ AREA_OR_POINT: 'Area' });
    const tags = rows(sections, 'TIFF タグ（原画像）');
    expect(tags['ImageWidth（256）']).toBe('8');
    expect(tags['GDAL_METADATA（42112）']).toContain('NIR');

    expect(sectionsToText(sections)).toContain('## バンド\nバンド 1\tRed・UInt16');
    expect(JSON.parse(sectionsToJson(sections))['概要']['サイズ']).toBe('8 × 4 px');
  });

  it('describes a tiled GeoTIFF with RSET levels as COG-like', async () => {
    const sections = await describeTiff(await imagesOf(await tiledTiff(1100, 700)), { name: 'big.tif' });
    const summary = rows(sections, '概要');
    expect(summary['COG']).toMatch(/^COG 相当/);
    expect(summary['RSET']).toBe('3 段');
    expect(summary['配置']).toBe('タイル 256 × 256 px');
    expect(Object.keys(rows(sections, 'IFD 構成'))).toEqual(['原画像', 'RSET 1（1/2）', 'RSET 2（1/4）', 'RSET 3（1/7.97）']);
  });

  it('reads the layout GDAL writes at the start of a COG', async () => {
    const images = await imagesOf(await tiledTiff(600, 400));
    // A COG's first bytes: a BigTIFF header, then GDAL's structural metadata (the "ghost area").
    const startingWith = (lines: string) => {
      const ghost = `GDAL_STRUCTURAL_METADATA_SIZE=${String(lines.length).padStart(6, '0')} bytes\n${lines}`;
      const head = new Uint8Array(16 + ghost.length + 30);
      head.set([0x49, 0x49, 43, 0, 8, 0, 0, 0]);
      head.set(new TextEncoder().encode(ghost), 16);
      return images.map((image) => Object.assign(Object.create(image) as GeoTIFFImage, { source: { fetch: async () => [head.buffer] } }));
    };

    let summary = rows(await describeTiff(startingWith('LAYOUT=IFDS_BEFORE_DATA\nBLOCK_ORDER=ROW_MAJOR\n'), { name: 'cog.tif' }), '概要');
    expect(summary['形式']).toBe('BigTIFF・リトルエンディアン');
    expect(summary['GDAL 構造 BLOCK_ORDER']).toBe('ROW_MAJOR');
    expect(summary['COG']).toMatch(/^COG 相当/);

    summary = rows(await describeTiff(startingWith('LAYOUT=COG\n'), { name: 'cog.tif' }), '概要');
    expect(summary['COG']).toBe('はい（GDAL の COG レイアウト）');
  });
});
