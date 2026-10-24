import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { exportStyle, importStyle, readRasterRenderer } from '../src/qgis-style.js';
import { originOf, readQgs, sourceParams, writeQgs } from '../src/qgis-project.js';
import { parseXml, path, XmlError } from '../src/safe-xml.js';
import { StyleNotes, styleQml } from '../src/style-file.js';
import { singleSpec, type VectorStyleSpec } from '../src/vector-style.js';
import { splitXyz, xyzTileUrl, xyzUrl } from '../src/services/xyz.js';
import { matchLayers } from '../src/project-file.js';

const data = (name: string) => readFileSync(new URL(`./data/qgis/${name}`, import.meta.url), 'utf8');

/** A style with something in every part the formats carry. */
function categorized(): VectorStyleSpec {
  const spec = singleSpec('#4363d8');
  spec.mode = 'categorized';
  spec.field = 'use';
  spec.categories = [
    { value: '公園', color: '#33a02c', visible: true },
    { value: 'A&B <商業>', color: '#ff8800', visible: true },
  ];
  spec.symbol = { fill: '#cccccc', fillOpacity: 0.4, stroke: '#222222', strokeWidth: 1.5, strokeOpacity: 0.8, dash: 'dash', shape: 'circle', size: 10 };
  spec.label = { field: 'name', size: 15, color: '#112233', bold: true, halo: '#ffffee', haloWidth: 3, overlap: false, maxScale: 50000 };
  spec.minScale = 200000;
  spec.maxScale = 1000;
  return spec;
}

function graduated(): VectorStyleSpec {
  const spec = singleSpec('#4363d8');
  spec.mode = 'graduated';
  spec.field = 'passengers';
  spec.classes = [
    { min: 0, max: 1000, color: '#fee5d9', visible: true },
    { min: 1000, max: 5000.5, color: '#fb6a4a', visible: true },
    { min: 5000.5, max: 20000, color: '#a50f15', visible: true },
  ];
  spec.classCount = 3;
  spec.symbol = { ...spec.symbol, shape: 'triangle', size: 12, strokeWidth: 1, fill: '#888888' };
  return spec;
}

describe('safe XML', () => {
  it('reads elements, attributes, text and CDATA, and decodes the predefined entities', () => {
    const root = parseXml('<?xml version="1.0"?><!-- c --><a x="1 &amp; 2"><b>t &lt; u</b><c><![CDATA[<raw>]]></c><d/></a>');
    expect(root.attrs.x).toBe('1 & 2');
    expect(path(root, 'b')!.text).toBe('t < u');
    expect(path(root, 'c')!.text).toBe('<raw>');
    expect(root.children.map((c) => c.local)).toEqual(['b', 'c', 'd']);
  });

  it('refuses entity declarations, oversized and broken documents', () => {
    expect(() => parseXml('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>')).toThrow(XmlError);
    expect(() => parseXml('<a>' + 'x'.repeat(100) + '</a>', 50)).toThrow(/大きすぎ/);
    expect(() => parseXml('<a><b></a>')).toThrow(XmlError);
    // Undeclared entities stay as written (never expanded).
    expect(parseXml('<a>&foo;</a>').text).toBe('&foo;');
  });
});

describe('SLD', () => {
  for (const version of ['sld10', 'se11'] as const) {
    it(`writes and reads back a categorized style with labels and scales (${version})`, () => {
      const spec = categorized();
      const text = exportStyle(spec, version, 'polygon', 'landuse');
      expect(text).toContain(version === 'se11' ? 'se:SvgParameter' : 'CssParameter');
      const back = importStyle(text, singleSpec('#000000'));
      expect(back.format).toBe('sld');
      expect(back.unsupported).toEqual([]);
      expect(back.spec.mode).toBe('categorized');
      expect(back.spec.field).toBe('use');
      expect(back.spec.categories).toEqual(spec.categories);
      expect(back.spec.symbol).toEqual(spec.symbol);
      expect(back.spec.label).toEqual(spec.label);
      expect(back.spec.minScale).toBe(200000);
      expect(back.spec.maxScale).toBe(1000);
      expect(back.spec.othersVisible).toBe(true);
    });
  }

  it('writes and reads back graduated points and single lines', () => {
    const spec = graduated();
    const back = importStyle(exportStyle(spec, 'se11', 'point', 'stations'), singleSpec('#000000')).spec;
    expect(back.mode).toBe('graduated');
    expect(back.classes).toEqual(spec.classes);
    expect(back.symbol.shape).toBe('triangle');
    expect(back.symbol.size).toBe(12);
    const line = { ...singleSpec('#ff0000'), symbol: { ...singleSpec('#ff0000').symbol, strokeWidth: 3, dash: 'dashdot' as const } };
    const lineBack = importStyle(exportStyle(line, 'sld10', 'line', 'roads'), singleSpec('#000000')).spec;
    expect(lineBack.mode).toBe('single');
    expect(lineBack.symbol.stroke).toBe('#ff0000');
    expect(lineBack.symbol.strokeWidth).toBe(3);
    expect(lineBack.symbol.dash).toBe('dashdot');
  });

  it('writes and reads back outlines of their own, and colors on the outlines', () => {
    const spec = categorized();
    spec.categories[1] = { ...spec.categories[1], stroke: '#ff0000', strokeWidth: 4, dash: 'dot' };
    for (const version of ['sld10', 'se11'] as const) {
      const back = importStyle(exportStyle(spec, version, 'polygon', 'landuse'), singleSpec('#000000')).spec;
      expect(back.colorTarget).toBe('fill');
      expect(back.categories).toEqual(spec.categories);
    }
    const outlined = { ...categorized(), colorTarget: 'stroke' as const };
    const back = importStyle(exportStyle(outlined, 'se11', 'polygon', 'landuse'), singleSpec('#000000')).spec;
    expect(back.colorTarget).toBe('stroke');
    expect(back.categories).toEqual(outlined.categories);
    expect(back.symbol.fill).toBe('#cccccc');
  });

  it('reads an SLD QGIS wrote, listing what the viewer has no equivalent for', () => {
    const { spec, unsupported } = importStyle(data('landuse-categorized.sld'), singleSpec('#000000'));
    expect(spec.mode).toBe('categorized');
    expect(spec.categories.map((c) => [c.value, c.color])).toEqual([
      ['公園', '#33a02c'],
      ['商業', '#ff8800'],
    ]);
    expect(spec.othersVisible).toBe(false);
    expect(spec.symbol).toMatchObject({ fillOpacity: 0.5, stroke: '#232323', strokeWidth: 1.5, dash: 'dash' });
    expect(spec.minScale).toBe(200000);
    expect(spec.label).toMatchObject({ field: 'name', size: 16, bold: true, color: '#112233', halo: '#ffffee', haloWidth: 3, maxScale: 50000 });
    expect(unsupported).toContain('模様・画像の塗り');
    expect(unsupported).toContain('分類・段階にできない条件（フィルター）');
  });
});

describe('QML', () => {
  it('reads back what it writes, through QGIS’s own parts too', () => {
    for (const spec of [categorized(), graduated()]) {
      const text = exportStyle(spec, 'qml', spec.mode === 'graduated' ? 'point' : 'polygon', 'x');
      expect(importStyle(text, singleSpec('#000000')).spec).toEqual(spec);
      // Without the viewer's own copy: QGIS's renderer and labels.
      const qgisOnly = text.replace(/<customproperties>.*<\/customproperties>/s, '');
      const back = importStyle(qgisOnly, singleSpec('#000000')).spec;
      expect(back.mode).toBe(spec.mode);
      expect(back.field).toBe(spec.field);
      expect(back.categories).toEqual(spec.categories);
      expect(back.classes).toEqual(spec.classes);
      expect(back.label.field).toBe(spec.label.field);
      expect(back.minScale).toBe(spec.minScale);
    }
  });

  it('carries outlines of their own and colors on the outlines through QGIS\'s parts', () => {
    const spec = graduated();
    spec.symbol = { ...spec.symbol, strokeWidth: 1, dash: 'solid' };
    spec.classes[2] = { ...spec.classes[2], stroke: '#00ff00', strokeWidth: 3, dash: 'dash' };
    for (const kind of ['polygon', 'line'] as const) {
      const qgisOnly = exportStyle(spec, 'qml', kind, 'x').replace(/<customproperties>.*<\/customproperties>/s, '');
      const back = importStyle(qgisOnly, singleSpec('#000000')).spec;
      // A line's own color is its color: only the width and pattern are its own.
      expect(back.classes[2]).toEqual(kind === 'line' ? { ...spec.classes[2], color: '#00ff00', stroke: undefined } : spec.classes[2]);
      expect(back.classes[0]).toEqual(spec.classes[0]);
    }
    const both = { ...categorized(), colorTarget: 'both' as const };
    const text = exportStyle(both, 'qml', 'polygon', 'x');
    expect(importStyle(text, singleSpec('#000000')).spec).toEqual(both);
    expect(importStyle(text.replace(/<customproperties>.*<\/customproperties>/s, ''), singleSpec('#000000')).spec.colorTarget).toBe('both');
  });

  it('reads a graduated QML QGIS made, and lists what it leaves out', () => {
    const { spec, unsupported } = importStyle(data('stations-graduated.qml'), singleSpec('#000000'));
    expect(spec.mode).toBe('graduated');
    expect(spec.method).toBe('quantile');
    expect(spec.classes.map((c) => [c.min, c.max, c.color, c.visible])).toEqual([
      [0, 1000, '#fff5f0', true],
      [1000, 5000, '#fb6a4a', true],
      [5000, 20000, '#67000d', false],
    ]);
    expect(spec.symbol.shape).toBe('triangle');
    expect(spec.symbol.size).toBe(15); // 4 mm at 96 dpi
    expect(spec.minScale).toBe(500000);
    expect(spec.maxScale).toBe(1000);
    expect(spec.label).toMatchObject({ field: 'name', maxScale: 25000, size: 16 });
    expect(unsupported).toEqual(['重ねたシンボル（2 層目以降）', 'ラベルの影']);
  });

  it('turns a raster pseudo-color QML into a color scale', () => {
    const renderer = path(parseXml(data('dem-pseudocolor.qml')), 'pipe', 'rasterrenderer')!;
    const notes = new StyleNotes();
    const style = readRasterRenderer(renderer, notes);
    expect(style.bands).toBeUndefined();
    expect(style.colorScale?.scale).toEqual([
      [0, [43, 131, 186, 255]],
      [0.25, [171, 221, 164, 255]],
      [0.5, [255, 255, 191, 255]],
      [1, [215, 25, 28, 128]],
    ]);
    expect(notes.list()[0]).toContain('0 – 2000');
    expect(() => importStyle(data('dem-pseudocolor.qml'), singleSpec('#000000'))).toThrow(/ラスター/);
  });

  it('keeps the classes of discrete and exact pseudo-color, and of a palette', () => {
    const renderer = (xml: string) => readRasterRenderer(path(parseXml(`<qgis><pipe>${xml}</pipe></qgis>`), 'pipe', 'rasterrenderer')!, new StyleNotes());
    const discrete = renderer(`<rasterrenderer type="singlebandpseudocolor" band="1"><rastershader><colorrampshader colorRampType="DISCRETE" minimumValue="0" maximumValue="300">
      <item value="100" color="#0000ff" alpha="255" label="低い"/><item value="200" color="#00ff00" alpha="255" label="中"/><item value="inf" color="#ff0000" alpha="128" label="高い"/>
    </colorrampshader></rastershader></rasterrenderer>`);
    expect(discrete.colorScale?.classes).toEqual({
      kind: 'range',
      method: 'manual',
      min: 0,
      classes: [
        { value: 100, color: [0, 0, 255, 255], label: '低い' },
        { value: 200, color: [0, 255, 0, 255], label: '中' },
        { value: 300, color: [255, 0, 0, 128], label: '高い' },
      ],
    });
    const exact = renderer(`<rasterrenderer type="singlebandpseudocolor" band="1"><rastershader><colorrampshader colorRampType="EXACT" minimumValue="1" maximumValue="3">
      <item value="1" color="#0000ff" label="水"/><item value="3" color="#00ff00" label="森"/></colorrampshader></rastershader></rasterrenderer>`);
    expect(exact.colorScale?.classes?.kind).toBe('exact');
    expect(exact.colorScale?.classes?.classes.map((c) => c.value)).toEqual([1, 3]);
    const palette = renderer(`<rasterrenderer type="paletted" band="2"><colorPalette>
      <paletteEntry value="10" color="#112233" alpha="255" label="市街地"/><paletteEntry value="20" color="#445566" alpha="0" label="なし"/></colorPalette></rasterrenderer>`);
    expect(palette.bands).toEqual([1, 1, 1]);
    expect(palette.colorScale?.classes).toEqual({
      kind: 'exact',
      method: 'manual',
      classes: [
        { value: 10, color: [17, 34, 51, 255], label: '市街地' },
        { value: 20, color: [68, 85, 102, 0], label: 'なし' },
      ],
    });
  });

  it('keeps the writer stable for files QGIS reads', () => {
    expect(styleQml(singleSpec('#ff0000'), 'point')).toContain('<renderer-v2 type="singleSymbol"');
  });
});

describe('QGIS projects', () => {
  it('reads data sources of every provider the viewer opens', () => {
    expect(sourceParams('a=1&layers=x&layers=y&url=http://h/%7Bz%7D').get('layers')).toEqual(['x', 'y']);
    expect(originOf('wms', 'crs=EPSG:3857&format=image/png&layers=a&styles=default&tileMatrixSet=GoogleMapsCompatible&url=https://h/WMTSCapabilities.xml', 'raster')).toEqual({
      kind: 'service',
      ref: { kind: 'wmts', url: 'https://h/WMTSCapabilities.xml', layer: 'a', matrixSet: 'GoogleMapsCompatible', format: 'image/png' },
    });
    expect(originOf('WFS', 'https://h/wfs?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAME=ns:roads&SRSNAME=EPSG:4326', 'vector')).toEqual({ kind: 'service', ref: { kind: 'wfs', url: 'https://h/wfs', layer: 'ns:roads' } });
    expect(originOf('arcgismapserver', "crs='EPSG:3857' format='PNG32' layer='' url='https://h/arcgis/rest/services/X/MapServer'", 'raster')).toEqual({ kind: 'service', ref: { kind: 'esri', url: 'https://h/arcgis/rest/services/X/MapServer', layer: 'map' } });
    expect(originOf('ogr', '/vsizip/C:/x/data.zip/roads.shp', 'vector')).toMatchObject({ kind: 'files', files: ['data.zip'] });
    expect(originOf('delimitedtext', 'file:///home/me/points.csv?type=csv&xField=lon&yField=lat', 'vector')).toMatchObject({ kind: 'files', files: ['points.csv'] });
    expect(originOf('spatialite', "dbname='x.sqlite' table=\"t\"", 'vector')).toEqual({ kind: 'none', why: 'データベース' });
  });

  it('reads a .qgs: layers in tree order, visibility, opacity, sources, styles and extent', () => {
    const read = readQgs(data('sample.qgs'), 'id-1');
    const p = read.project;
    expect(p.layers.map((l) => [l.name, l.type, l.source.kind, l.visible, l.opacity])).toEqual([
      ['駅（WFS）', 'service', 'service', true, 0.9],
      ['東京の地図', 'service', 'service', false, 1],
      ['roads', 'service', 'files', true, 1],
      ['parks', 'service', 'files', false, 1],
      ['標高', 'image', 'files', true, 0.75],
      ['cog', 'image', 'url', true, 1],
      ['検出', 'service', 'service', true, 1],
      ['OpenStreetMap', 'service', 'service', true, 0.6],
    ]);
    const refs = p.layers.map((l) => (l.source.kind === 'service' ? l.source.ref : null));
    expect(refs[0]).toEqual({ kind: 'wfs', url: 'http://localhost:4175/svc/wfs', layer: 'test:stations' });
    expect(refs[1]).toEqual({ kind: 'wms', url: 'http://localhost:4175/svc/wms', layer: 'test:tokyo' });
    expect(refs[6]).toEqual({ kind: 'esri', url: 'http://localhost:4175/svc/arcgis/rest/services/Detections/FeatureServer', layer: '0' });
    expect(refs[7]).toEqual({ kind: 'xyz', url: 'https://tile.example.com/{z}/{x}/{y}.png#name=OpenStreetMap&zmax=18', layer: 'tiles' });
    expect(p.fileSets.map((s) => s.files.map((f) => f.name))).toEqual([['roads.shp', 'roads.shx', 'roads.dbf', 'roads.prj'], ['city.gpkg'], ['dem.tif']]);
    expect(p.layers[3].pick).toBe('parks');
    expect(p.layers[0].style).toMatchObject({ mode: 'single', symbol: { shape: 'star', size: 14, fill: '#e41a1c' }, label: { field: 'name', bold: true } });
    expect(p.layers[2].style).toMatchObject({ mode: 'categorized', field: 'type', othersVisible: false, symbol: { strokeWidth: 3, dash: 'dash' } });
    expect(p.layers[2].style!.categories).toEqual([
      { value: 'main', color: '#ff0000', visible: true },
      { value: 'minor', color: '#0000ff', visible: false },
    ]);
    expect(p.layers[4].bands).toEqual([1, 1, 1]);
    expect(p.layers[4].colorScale?.scale).toEqual([
      [0, [0, 0, 0, 255]],
      [1, [255, 255, 255, 255]],
    ]);
    expect(p.layers[5]).toMatchObject({ source: { url: 'https://example.com/scene.tif' }, bands: [3, 2, 1] });
    expect(read.unsupported).toEqual(['建物（データベース）', 'ベクタータイル（ベクタータイル）']);
    expect(read.notes).toContain('roads: 絞り込み（サブセット）は使わず、すべての地物を表示');
    expect(read.notes).toContain('parks: 表示方法「ルールによる表示」');
    expect(read.extent).toEqual({ crs: 'EPSG:3857', extent: [15545000, 4250000, 15565000, 4265000] });
  });

  it('writes a .qgs QGIS can read, which reads back the same', () => {
    const read = readQgs(data('sample.qgs'), 'id-1');
    const left: string[] = [];
    const kinds = read.project.layers.map((l) => (l.name === 'roads' ? ('line' as const) : l.name === '駅（WFS）' ? ('point' as const) : null));
    const text = writeQgs(read.project, { kinds, extent: [1, 2, 3, 4], title: 'テスト' }, left);
    expect(left).toEqual([]);
    const again = readQgs(text, 'id-2');
    expect(again.project.layers.map((l) => [l.name, l.visible, l.opacity, l.source.kind])).toEqual(read.project.layers.map((l) => [l.name, l.visible, l.opacity, l.source.kind]));
    expect(again.project.layers.map((l) => (l.source.kind === 'service' ? l.source.ref : null))).toEqual(read.project.layers.map((l) => (l.source.kind === 'service' ? l.source.ref : null)));
    expect(again.project.layers[2].style).toEqual(read.project.layers[2].style);
    expect(again.extent).toEqual({ crs: 'EPSG:3857', extent: [1, 2, 3, 4] });
  });

  it('matches the layers opened from a file by the QGIS layer name', () => {
    const opened = [
      { type: 'service', name: 'roads（city.gpkg）' },
      { type: 'service', name: 'parks（city.gpkg）' },
    ];
    expect(matchLayers([{ type: 'service', name: 'Parks', pick: 'parks' }], opened)).toEqual([opened[1]]);
    expect(matchLayers([{ type: 'service', name: 'x', pick: '' }], opened)).toEqual([opened[0]]);
    expect(matchLayers([{ type: 'service', name: 'x' }], opened)).toEqual([null]);
  });
});

describe('XYZ tiles', () => {
  it('fills a template, and keeps a name and zoom range after #', () => {
    expect(xyzTileUrl('https://h/{z}/{x}/{y}.png', 3, 5, 2)).toBe('https://h/3/5/2.png');
    expect(xyzTileUrl('https://h/{z}/{x}/{-y}.png', 3, 5, 2)).toBe('https://h/3/5/5.png');
    expect(xyzTileUrl('https://h/{q}.png', 2, 1, 2)).toBe('https://h/21.png');
    const url = xyzUrl('https://h/{z}/{x}/{y}.png', '航空写真', 2, 17);
    expect(splitXyz(url)).toEqual({ template: 'https://h/{z}/{x}/{y}.png', name: '航空写真', zmin: 2, zmax: 17 });
  });
});
