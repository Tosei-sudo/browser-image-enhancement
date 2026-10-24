import { beforeAll, describe, expect, it } from 'vitest';
import { transform } from 'ol/proj.js';
import { setProjectionCodeLookup } from 'ol/proj/proj4.js';
import { registerJapaneseCrs } from '../src/processing/reproject.js';
import {
  cornersTransform,
  crsLabel,
  extentTransform,
  georefPlacement,
  isAuxXmlName,
  isWorldFileName,
  looksLikeDegrees,
  normalizeCrs,
  ownTransform,
  parseAuxXml,
  parseWorldFile,
  sideBaseName,
  transformCorners,
  worldFileText,
} from '../src/georef.js';
import { sensorPlacement } from '../src/sensor-projection.js';
import { readProject } from '../src/project-file.js';

beforeAll(() => {
  registerJapaneseCrs();
  setProjectionCodeLookup(async (code) => {
    throw new Error(`no definition for ${code}`);
  });
});

const close = (a: readonly number[], b: readonly number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

describe('side files', () => {
  it('knows world files, .aux.xml and the image they belong to', () => {
    for (const name of ['a.tfw', 'a.TFW', 'b.jgw', 'c.pgw', 'd.wld', 'e.tifw', 'f.j2w']) expect(isWorldFileName(name)).toBe(true);
    expect(isWorldFileName('a.tif')).toBe(false);
    expect(isAuxXmlName('scan.png.aux.xml')).toBe(true);
    expect(sideBaseName('Scan.png.aux.xml')).toBe('scan');
    expect(sideBaseName('dir/Scan.TFW')).toBe('scan');
    expect(sideBaseName('scan.prj')).toBe('scan');
  });

  it('reads a world file: pixel centres become the corner of the first pixel', () => {
    // 0.5 m pixels, the top-left pixel's centre at (-12000.25, 35000.75).
    const t = parseWorldFile('0.5\r\n0\n0\n-0.5\n-12000.25\n35000.75\n');
    expect(t).toEqual([-12000.5, 0.5, 0, 35001, 0, -0.5]);
    expect(parseWorldFile(worldFileText(t))).toEqual(t);
    expect(() => parseWorldFile('1\n0\n0\n')).toThrow('6 行');
    expect(() => parseWorldFile('0\n0\n0\n0\n1\n1')).toThrow('大きさが 0');
  });

  it('reads the CRS and GeoTransform of a GDAL .aux.xml', () => {
    const aux = parseAuxXml(`<PAMDataset>
  <SRS dataAxisToSRSAxisMapping="1,2">PROJCS[&quot;JGD2011 / Japan Plane Rectangular CS IX&quot;,GEOGCS[&quot;JGD2011&quot;],AUTHORITY[&quot;EPSG&quot;,&quot;6677&quot;]]</SRS>
  <GeoTransform>  1.0000000000000000e+04,  2.0000000000000000e+00,  0.0000000000000000e+00,  3.0000000000000000e+04,  0.0000000000000000e+00, -2.0000000000000000e+00</GeoTransform>
</PAMDataset>`);
    expect(aux.transform).toEqual([10000, 2, 0, 30000, 0, -2]);
    expect(normalizeCrs(aux.crs!)).toBe('EPSG:6677');
    expect(parseAuxXml('<PAMDataset></PAMDataset>')).toEqual({ crs: null, transform: null });
  });
});

describe('CRS', () => {
  it('takes codes, EPSG names and WKT', () => {
    expect(normalizeCrs('6677')).toBe('EPSG:6677');
    expect(normalizeCrs(' epsg:4326 ')).toBe('EPSG:4326');
    expect(normalizeCrs('')).toBeNull();
    expect(normalizeCrs('東京')).toBeNull();
    // ESRI .prj files name no code: known by their names.
    expect(normalizeCrs('PROJCS["JGD_2011_Japan_Zone_9",GEOGCS["GCS_JGD_2011",DATUM["D_JGD_2011",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",139.8333333333333],PARAMETER["Scale_Factor",0.9999],PARAMETER["Latitude_Of_Origin",36.0],UNIT["Meter",1.0]]')).toBe('EPSG:6677');
    expect(normalizeCrs('PROJCS["WGS_1984_UTM_Zone_54N",GEOGCS["GCS_WGS_1984"]]')).toBe('EPSG:32654');
    expect(normalizeCrs('PROJCS["JGD_2000_Japan_Zone_9",GEOGCS["GCS_JGD_2000"]]')).toBe('EPSG:2451');
    expect(normalizeCrs('GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]]]')).toBe('EPSG:4326');
    // Unknown names stay WKT, for proj4.
    const odd = 'PROJCS["Local",GEOGCS["GCS_WGS_1984"],PROJECTION["Transverse_Mercator"]]';
    expect(normalizeCrs(odd)).toBe(odd);
    expect(crsLabel('EPSG:6677')).toBe('JGD2011 平面直角座標系 IX 系（EPSG:6677）');
    expect(crsLabel(odd)).toBe('Local');
  });
});

describe('placements', () => {
  it('puts an image over an extent, north up', () => {
    expect(extentTransform([100, 200, 300, 300], 200, 100)).toEqual([100, 1, 0, 300, 0, -1]);
    expect(() => extentTransform([300, 200, 100, 300], 200, 100)).toThrow('左 < 右');
  });

  it('fits the corners, rotation and all, from three or four of them', () => {
    const t = [1000, 0.8, 0.6, 5000, 0.6, -0.8];
    const corners = transformCorners(t, 100, 50);
    close(cornersTransform(corners, 100, 50), t);
    close(cornersTransform([corners[0], null, corners[2], corners[3]], 100, 50), t);
    expect(() => cornersTransform([corners[0], null, null, corners[3]], 100, 50)).toThrow('3 点以上');
    expect(() => cornersTransform([[0, 0], [1, 1], [2, 2], [3, 3]], 100, 50)).toThrow('一直線');
  });

  it('reads a GeoTIFF’s own transform', () => {
    expect(ownTransform([10, 10, 0], [0, 0, 0, 500000, 4000000, 0], undefined)).toEqual([500000, 10, 0, 4000000, 0, -10]);
    // A tie point at another pixel.
    expect(ownTransform([2, 2, 0], [10, 5, 0, 120, 90, 0], undefined)).toEqual([100, 2, 0, 100, 0, -2]);
    expect(ownTransform(undefined, undefined, [1, 0, 0, 7, 0, -1, 0, 9, 0, 0, 0, 0, 0, 0, 0, 1])).toEqual([7, 1, 0, 9, 0, -1]);
    expect(ownTransform(undefined, undefined, undefined)).toBeNull();
  });

  it('guesses degrees from the coordinates', () => {
    expect(looksLikeDegrees([139, 0.0001, 0, 36, 0, -0.0001], 1000, 1000)).toBe(true);
    expect(looksLikeDegrees([-12000, 0.5, 0, 35000, 0, -0.5], 1000, 1000)).toBe(false);
  });

  it('makes a north-up placement the GeoTIFF’s own georeferencing, with EPSG keys', async () => {
    const { geo, projection } = await georefPlacement({ crs: 'EPSG:6677', transform: [-12000, 0.5, 0, 35000, 0, -0.5], method: 'worldfile' }, 400, 200);
    expect(projection.getCode()).toBe('EPSG:6677');
    expect(geo.modelPixelScale).toEqual([0.5, 0.5, 0]);
    expect(geo.modelTiepoint).toEqual([0, 0, 0, -12000, 35000, 0]);
    expect(geo.geoKeyDirectory?.slice(-4)).toEqual([3072, 0, 1, 6677]);
    const degrees = await georefPlacement({ crs: 'EPSG:4326', transform: [139, 0.001, 0, 36, 0, -0.001], method: 'extent' }, 10, 10);
    expect(degrees.geo.geoKeyDirectory?.slice(-4)).toEqual([2048, 0, 1, 4326]);
  });

  it('warps a rotated placement through a projection of its pixels', async () => {
    const t = [-12000, 0.4, 0.3, 35000, 0.3, -0.4];
    const { geo, projection } = await georefPlacement({ crs: 'EPSG:6677', transform: t, method: 'corners' }, 400, 200);
    expect(geo.modelPixelScale).toEqual([1, 1, 0]);
    const placement = sensorPlacement(projection);
    expect(placement?.kind).toBe('affine');
    expect(placement?.crs).toContain('EPSG:6677');
    // Pixel (100, 50) is y = −50 in the projection; it goes where the transform says.
    const expected = transform([t[0] + t[1] * 100 + t[2] * 50, t[3] + t[4] * 100 + t[5] * 50], 'EPSG:6677', 'EPSG:4326');
    close(transform([100, -50], projection, 'EPSG:4326'), expected, 9);
    close(transform(expected, 'EPSG:4326', projection), [100, -50], 4);
  });

  it('says so when the CRS is not known', async () => {
    await expect(georefPlacement({ crs: 'EPSG:999999', transform: [0, 1, 0, 0, 0, -1], method: 'extent' }, 10, 10)).rejects.toThrow('定義なし');
  });
});

describe('projects', () => {
  it('keep the projection set for an image, and drop a broken one', () => {
    const layer = (georef: unknown) => ({ type: 'image', name: 'scan.png', source: { kind: 'files', set: 0 }, visible: true, opacity: 1, georef });
    const text = JSON.stringify({
      format: 'browser-image-viewer-project',
      version: 1,
      id: 'x',
      saved: '2026-10-17T00:00:00Z',
      baseMap: 'osm',
      view: null,
      fileSets: [{ files: [{ name: 'scan.png', size: 10 }] }],
      layers: [
        layer({ crs: 'EPSG:6677', transform: [1, 2, 0, 3, 0, -2], method: 'worldfile', from: 'scan.pgw' }),
        layer({ crs: 'EPSG:6677', transform: [1, 2, 0], method: 'worldfile' }),
      ],
      selected: null,
    });
    const { project } = readProject(text);
    expect(project.layers[0].georef).toEqual({ crs: 'EPSG:6677', transform: [1, 2, 0, 3, 0, -2], method: 'worldfile', from: 'scan.pgw' });
    expect(project.layers[1].georef).toBeUndefined();
  });
});
