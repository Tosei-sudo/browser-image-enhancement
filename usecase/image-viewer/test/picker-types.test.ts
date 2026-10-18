import { describe, expect, it } from 'vitest';
import { acceptFiles } from '../src/open-files.js';
import { pickerTypes } from '../src/recent-files.js';

describe('pickerTypes', () => {
  it('offers all supported files first, then each kind on its own', () => {
    const types = pickerTypes(acceptFiles);
    expect(types[0].description).toBe('対応ファイルすべて');
    expect(types[0].accept['image/*']).toContain('.png');
    expect(types[0].accept['application/octet-stream']).toContain('.tif');
    expect(types.map((t) => t.description).slice(1)).toEqual([
      'ラスター画像（GeoTIFF・COG・PNG・JPEG など）',
      '衛星画像（NITF・SICD）',
      'ベクター（Shapefile・GeoJSON・GeoPackage・KML・GPX・FlatGeobuf）',
      '表（CSV・TSV）',
      '標高（DTED）',
      'プロジェクト（.ivproj・QGIS）',
      '補助ファイル（RPC・IMD・.ovr・ワールドファイル・.aux.xml）',
    ]);
    // Every extension of the chooser's list is in exactly one kind.
    const listed = types.slice(1).flatMap((t) => Object.values(t.accept).flat());
    const all = Object.values(types[0].accept).flat();
    expect([...listed].sort()).toEqual([...all].sort());
  });

  it('puts unknown extensions under その他 and skips the all entry for a single kind', () => {
    expect(pickerTypes('.csv,.foo').map((t) => t.description)).toEqual(['対応ファイルすべて', '表（CSV・TSV）', 'その他']);
    expect(pickerTypes('.csv,.tsv')).toEqual([{ description: '表（CSV・TSV）', accept: { 'application/octet-stream': ['.csv', '.tsv'] } }]);
  });
});
