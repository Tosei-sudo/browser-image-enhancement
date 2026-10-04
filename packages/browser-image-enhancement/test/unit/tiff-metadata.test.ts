import { describe, expect, it } from 'vitest';
import { bandNamesFromGdalMetadata, parseGdalMetadata, readBandNames } from '../../src/openlayers/tiff-metadata.js';

const xml = `<GDALMetadata>
  <Item name="AREA_OR_POINT">Area</Item>
  <Item name="DESCRIPTION" sample="0" role="description">Coastal &amp; aerosol</Item>
  <Item name="DESCRIPTION" sample="3" role="description">NIR</Item>
  <Item name="STATISTICS_MEAN" sample="3">8123.5</Item>
  <Item name="BAND_NAME" sample="1">Blue</Item>
  <Item name="SCALE" sample="1" role="scale">2.75e-05</Item>
  <Item name="LINE_OFF" domain="RPC">5000</Item>
  <Item name="EMPTY" sample="2"/>
</GDALMetadata>`;

describe('GDAL metadata', () => {
  it('parses items with their band, role and domain', () => {
    const items = parseGdalMetadata(xml);
    expect(items).toHaveLength(8);
    expect(items[0]).toEqual({ name: 'AREA_OR_POINT', value: 'Area' });
    expect(items[1]).toEqual({ name: 'DESCRIPTION', value: 'Coastal & aerosol', sample: 0, role: 'description' });
    expect(items[6]).toEqual({ name: 'LINE_OFF', value: '5000', domain: 'RPC' });
    expect(items[7]).toEqual({ name: 'EMPTY', value: '', sample: 2 });
  });

  it('names bands from DESCRIPTION, else BAND_NAME', () => {
    expect(bandNamesFromGdalMetadata(parseGdalMetadata(xml), 5)).toEqual(['Coastal & aerosol', 'Blue', null, 'NIR', null]);
  });

  it('reads the names of a geotiff.js 3 image, loading the tag', async () => {
    const image = {
      getSamplesPerPixel: () => 4,
      fileDirectory: { hasTag: (t: string) => t === 'GDAL_METADATA', loadValue: async () => `${xml}\0` },
    };
    expect(await readBandNames(image)).toEqual(['Coastal & aerosol', 'Blue', null, 'NIR']);
    expect(await readBandNames({ getSamplesPerPixel: () => 2, fileDirectory: { hasTag: () => false, loadValue: async () => undefined } })).toEqual([null, null]);
  });

  it('reads a geotiff.js 2 directory (a plain object)', async () => {
    expect(await readBandNames({ getSamplesPerPixel: () => 1, fileDirectory: { GDAL_METADATA: xml } })).toEqual(['Coastal & aerosol']);
  });
});
