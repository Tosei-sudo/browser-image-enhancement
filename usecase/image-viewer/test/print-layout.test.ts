import { describe, expect, it } from 'vitest';
import { niceLength, paperSize, pdfOfJpeg, roundScale, sheetLayout } from '../src/print-layout.js';
import { arrowHead, readNotes } from '../src/annotations.js';
import { readProject, writeProject, PROJECT_FORMAT } from '../src/project-file.js';

describe('print layout', () => {
  it('turns the paper for landscape', () => {
    expect(paperSize('A4', 'portrait')).toEqual([210, 297]);
    expect(paperSize('A3', 'landscape')).toEqual([420, 297]);
  });

  it('picks a round scale-bar length no longer than allowed', () => {
    expect(niceLength(740)).toEqual({ metres: 500, label: '500 m' });
    expect(niceLength(3900)).toEqual({ metres: 2000, label: '2 km' });
    expect(niceLength(1)).toEqual({ metres: 1, label: '1 m' });
    expect(niceLength(0.3)).toEqual({ metres: 0.2, label: '20 cm' });
    expect(niceLength(0).metres).toBe(0);
  });

  it('rounds the scale to two figures', () => {
    expect(roundScale(24_731)).toBe(25_000);
    expect(roundScale(1234)).toBe(1200);
    expect(roundScale(57)).toBe(57);
  });

  it('lays an A4 landscape sheet at 150 dpi, with room for a title', () => {
    const plain = sheetLayout({ paper: 'A4', orientation: 'landscape', dpi: 150, title: '' });
    expect([plain.width, plain.height]).toEqual([1754, 1240]);
    const titled = sheetLayout({ paper: 'A4', orientation: 'landscape', dpi: 150, title: '調査範囲' });
    expect(titled.frame[1]).toBeGreaterThan(plain.frame[1]);
    expect(titled.frame[3]).toBeLessThan(plain.frame[3]);
  });

  it('writes a PDF whose cross-reference table points at its objects', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const bytes = new Uint8Array(await pdfOfJpeg(jpeg, 10, 20, 595.28, 841.89).arrayBuffer());
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/MediaBox [0 0 595.28 841.89]');
    expect(text).toContain('/Filter /DCTDecode');
    const xref = Number(/startxref\s+(\d+)/.exec(text)![1]);
    expect(text.slice(xref, xref + 4)).toBe('xref');
    const entries = [...text.slice(xref).matchAll(/^(\d{10}) 00000 n/gm)].map((m) => Number(m[1]));
    expect(entries.length).toBeGreaterThanOrEqual(4);
    entries.forEach((offset, i) => expect(text.slice(offset).startsWith(`${i + 1} 0 obj`)).toBe(true));
  });
});

describe('notes', () => {
  it('puts the arrowhead at the end of the line, pointing along it', () => {
    const head = arrowHead(
      [
        [0, 0],
        [100, 0],
      ],
      2,
      10,
    )!;
    expect(head[0]).toEqual([100, 0]);
    // 10 px at 2 m/px back from the tip, either side of the line.
    expect(head[1][0]).toBeCloseTo(80);
    expect(head[2][0]).toBeCloseTo(80);
    expect(Math.sign(head[1][1])).toBe(-Math.sign(head[2][1]));
    expect(arrowHead([[5, 5]], 1, 10)).toBeNull();
  });

  it('reads saved notes and leaves out what is not one', () => {
    const notes = readNotes({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { kind: 'text', text: 'ここ', color: '#ff0000', size: 'large' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { kind: 'other' } },
        { type: 'Feature', geometry: null, properties: { kind: 'line' } },
      ],
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].get('text')).toBe('ここ');
    expect(readNotes('nonsense')).toEqual([]);
  });

  it('keeps the notes in a project file', () => {
    const annotations = {
      type: 'FeatureCollection' as const,
      features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [10, 10]] }, properties: { kind: 'arrow', color: '#e11d48', size: 'medium' } }],
    };
    const text = writeProject({ format: PROJECT_FORMAT, version: 1, id: 'p', saved: '2026-10-15T00:00:00.000Z', baseMap: '', view: { projection: 'EPSG:3857', center: [0, 0], resolution: 1, rotation: 0 }, fileSets: [], layers: [], selected: -1, annotations });
    expect(readProject(text).project.annotations).toEqual(annotations);
  });
});
