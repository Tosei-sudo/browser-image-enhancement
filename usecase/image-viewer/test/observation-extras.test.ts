import { describe, expect, it } from 'vitest';
import { confidencesOf, matchCandidates, observationsCsv, observationStoreOf, vocabularyOf, type Observation } from '../src/observations.js';
import { areaContains, areaStoreOf, boxRing, coveringAreas, EsriAreaStore, type CheckedArea } from '../src/observation-areas.js';
import { reportFileName, reportHtml, selectForReport, defaultReportOptions } from '../src/observation-report.js';

const day = (d: number) => Date.UTC(2026, 9, d, 1);
let n = 0;
const obs = (o: Partial<Observation>): Observation => ({
  id: `o${++n}`,
  imageId: 'd1',
  imageName: 'd1.tif',
  imageTime: day(1),
  objectId: 'A',
  objectName: 'A',
  kind: '船舶',
  activity: '停泊',
  present: true,
  note: '',
  lon: 139.7,
  lat: 35.6,
  createdAt: day(20),
  updatedAt: day(20),
  deletedAt: null,
  ...o,
});
const area = (a: Partial<CheckedArea>): CheckedArea => ({ id: `a${++n}`, imageId: 'd3', imageName: 'd3.tif', imageTime: day(3), ring: boxRing([139.69, 35.59, 139.71, 35.61]), kind: '', note: '', createdAt: day(20), updatedAt: day(20), deletedAt: null, ...a });

describe('candidates of the same thing', () => {
  // About 111 m per 0.001° of latitude.
  const records = [
    obs({ objectId: 'A', objectName: 'タンカーA', kind: '船舶 > タンカー', lat: 35.6, length: 180, heading: 90 }),
    obs({ objectId: 'B', objectName: '漁船B', kind: '船舶 > 漁船', lat: 35.6005, heading: 270 }),
    obs({ objectId: 'C', objectName: 'F-15', kind: '航空機', lat: 35.6002 }),
    obs({ objectId: 'D', objectName: '遠い船', lat: 35.7 }),
    // Already recorded in this image: not offered.
    obs({ objectId: 'E', objectName: 'もうある', imageId: 'd3', imageTime: day(3) }),
    obs({ objectId: 'E', objectName: 'もうある', lat: 35.6001 }),
  ];
  const image = { id: 'd3', time: day(3) };

  it('offers the near things not in this image, likeliest first, by class, length and heading', () => {
    const list = matchCandidates(records, image, { lon: 139.7, lat: 35.6003, kind: '船舶 > タンカー', length: 175, heading: 92 });
    expect(list.map((c) => c.name)).toEqual(['タンカーA', '漁船B', 'F-15']);
    expect(list[0].reasons).toEqual(['33 m', '同じ分類', '長さ ±3%', '向き差 2°']);
    // Another branch counts against: the aircraft comes last though nearest.
    expect(list[2].score).toBeGreaterThan(1);
  });

  it('keeps to the radius, and judges by the record nearest in time (an earlier one first)', () => {
    const moved = [...records, obs({ objectId: 'D', objectName: '遠い船', imageId: 'd2', imageTime: day(2), lat: 35.60032 })];
    expect(matchCandidates(moved, image, { lon: 139.7, lat: 35.6003 }, { radius: 100 }).map((c) => c.name)).toEqual(['遠い船', 'F-15', '漁船B', 'タンカーA']);
    expect(matchCandidates(records, image, { lon: 139.7, lat: 35.6003 }, { radius: 10 })).toEqual([]);
  });
});

describe('確度 in config.json', () => {
  it('takes levels as words or objects, and says what is wrong', () => {
    const problems: string[] = [];
    expect(confidencesOf(['確定', { label: '可能性大', color: '#d97706', note: '特徴が一致' }, { label: '確定' }, { color: 'red' }, { label: 'x', color: 'url(evil)' }], problems, 'c')).toEqual([
      { label: '確定' },
      { label: '可能性大', color: '#d97706', note: '特徴が一致' },
      { label: 'x' },
    ]);
    expect(problems).toEqual(['c[2] の「確定」は重複', 'c[3] は文字列か { label } で指定', 'c[4] の color は CSS の色で指定']);
  });

  it('is part of the vocabulary and of a store, with the match radius', () => {
    const problems: string[] = [];
    const v = vocabularyOf({ confidences: ['A', 'B', 'C', 'D', 'E'], matchRadius: 5000 }, problems);
    expect(v.confidences.map((c) => c.label)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(v.matchRadius).toBe(5000);
    expect(vocabularyOf({}, problems).confidences.map((c) => c.label)).toEqual(['確定', '推定', '不明']);
    expect(vocabularyOf({ matchRadius: -1 }, problems).matchRadius).toBe(2000);
    expect(problems).toEqual(['observationVocabulary.matchRadius は正の数（m）で指定']);
    const store = observationStoreOf({ url: 'https://x/FeatureServer/0', confidences: ['確実', '推定'], areas: 'https://x/FeatureServer/2/' }, problems, 0)!;
    expect(store.confidences).toEqual([{ label: '確実' }, { label: '推定' }]);
    expect(store.areas).toMatchObject({ url: 'https://x/FeatureServer/2', softDelete: true, fields: { id: 'AREA_ID' } });
  });

  it('goes into the CSV with who recorded it', () => {
    const csv = observationsCsv([obs({ confidence: '推定', recordedBy: 'tanaka', updatedBy: 'sato' })]);
    const [head, row] = csv.slice(1).trim().split('\r\n');
    expect(head).toContain('有無,確度,撮像日時');
    expect(head).toContain('備考,記録者,更新者,登録日時');
    expect(row).toContain(',あり,推定,');
    expect(row).toContain(',tanaka,sato,');
  });
});

describe('checked areas', () => {
  it('holds a place inside its outline, and covers a kind and below', () => {
    const a = area({ kind: '船舶' });
    expect(areaContains(a, 139.7, 35.6)).toBe(true);
    expect(areaContains(a, 139.72, 35.6)).toBe(false);
    expect(coveringAreas([a], 'd3', 139.7, 35.6, '船舶 > タンカー')).toEqual([a]);
    expect(coveringAreas([a], 'd3', 139.7, 35.6, '航空機')).toEqual([]);
    expect(coveringAreas([a], 'd1', 139.7, 35.6, '船舶')).toEqual([]);
    expect(coveringAreas([{ ...a, deletedAt: 1 }], 'd3', 139.7, 35.6, '船舶')).toEqual([]);
    expect(coveringAreas([area({ kind: '' })], 'd3', 139.7, 35.6, '航空機')).toHaveLength(1);
  });

  it('reads its layer from config.json', () => {
    const problems: string[] = [];
    expect(areaStoreOf({ url: 'https://x/FeatureServer/3', fields: { kind: 'TARGET', bad: 'X' }, softDelete: false }, problems, 'a')).toMatchObject({ url: 'https://x/FeatureServer/3', softDelete: false, fields: { kind: 'TARGET', id: 'AREA_ID' } });
    expect(areaStoreOf('https://x/MapServer/3', problems, 'b')).toBeNull();
    expect(problems).toEqual(['a の fields.bad は使用不可の役割', 'b は編集できる …/FeatureServer/1 のようなポリゴンレイヤーの URL で指定']);
  });

  it('is kept in an Esri polygon layer', async () => {
    const calls: Array<{ url: string; params: Record<string, string> }> = [];
    const ask = async (url: string, params: Record<string, string>) => {
      calls.push({ url, params });
      if (url.endsWith('/applyEdits')) return { addResults: JSON.parse(params.adds).map(() => ({ success: true, objectId: 7 })), updateResults: JSON.parse(params.updates).map(() => ({ success: true })) };
      if (url.endsWith('/query')) return { features: [{ attributes: { OBJECTID: 7, AREA_ID: 'z', IMAGE_ID: 'd3', KIND: '船舶', CREATED_AT: day(20) }, geometry: { rings: [boxRing([0, 0, 1, 1])] } }] };
      return { objectIdField: 'OBJECTID', fields: ['AREA_ID', 'IMAGE_ID', 'KIND', 'NOTE', 'CREATED_AT', 'UPDATED_AT', 'DELETED_AT'].map((name) => ({ name, type: name.endsWith('_AT') ? 'esriFieldTypeDate' : 'esriFieldTypeString' })) };
    };
    const store = new EsriAreaStore('確認範囲', areaStoreOf('https://x/FeatureServer/2', [], 'a')!, ask);
    await store.save([area({ id: 'n1', kind: '船舶', note: 'メモ' })]);
    const adds = JSON.parse(calls.find((c) => c.url.endsWith('/applyEdits'))!.params.adds);
    expect(adds[0].attributes).toMatchObject({ AREA_ID: 'n1', IMAGE_ID: 'd3', KIND: '船舶', NOTE: 'メモ' });
    expect(adds[0].attributes.OBSERVER).toBeUndefined();
    expect(adds[0].geometry.rings[0]).toHaveLength(5);
    const [loaded] = await store.load();
    expect(loaded).toMatchObject({ id: 'z', imageId: 'd3', kind: '船舶', deletedAt: null });
    const [marked] = await store.remove([loaded], day(21));
    expect(marked.deletedAt).toBe(day(21));
  });
});

describe('the report', () => {
  const levels = [{ label: '確定' }, { label: '推定' }, { label: '不明' }];
  const records = [
    obs({ objectId: 'A', objectName: 'タンカー<A>', kind: '船舶 > タンカー', confidence: '確定', imageId: 'd1', imageTime: day(1) }),
    obs({ objectId: 'A', objectName: 'タンカー<A>', kind: '船舶 > タンカー', confidence: '推定', imageId: 'd3', imageTime: day(3), activity: '航行', lon: 139.75 }),
    obs({ objectId: 'B', objectName: 'F-15', kind: '航空機', confidence: '不明', activity: '駐機', imageId: 'd3', imageTime: day(3) }),
    obs({ objectId: 'C', objectName: '古い', imageId: 'd0', imageTime: Date.UTC(2026, 8, 1) }),
    obs({ objectId: 'D', objectName: '削除', deletedAt: day(21) }),
  ];

  it('holds the period, class and 確度 asked for', () => {
    const base = { ...defaultReportOptions, from: day(1) - 3600_000, to: day(4) };
    expect(selectForReport(records, [], base, levels).flows.map((f) => f.name).sort()).toEqual(['F-15', 'タンカー<A>']);
    expect(selectForReport(records, [], { ...base, kind: '船舶' }, levels).records).toHaveLength(2);
    // At least 推定: 不明 and records without a level are left out.
    expect(selectForReport(records, [], { ...base, confidence: '推定' }, levels).records.map((o) => o.confidence)).toEqual(['確定', '推定']);
    const s = selectForReport(records, [area({ kind: '船舶' }), area({ kind: '航空機' }), area({ imageTime: day(9) })], { ...base, kind: '船舶 > タンカー' }, levels);
    expect(s.areas.map((a) => a.kind)).toEqual(['船舶']);
    expect(s.images.map((i) => i.id)).toEqual(['d1', 'd3']);
  });

  it('is one page with the summary, counts, flows and areas, its text escaped', () => {
    const options = { ...defaultReportOptions, title: '週報', records: true };
    const s = selectForReport(records, [area({ note: '港内すべて' })], options, levels);
    const html = reportHtml(s, options, { store: 'このブラウザ', author: '田中', made: day(25), levels, map: 'data:image/jpeg;base64,AAAA' });
    expect(html).toContain('<title>週報</title>');
    expect(html).toContain('モノ 3 件（最新で所在 3・不在 0）・記録 4 件・画像 3 枚・確認範囲 1 件');
    expect(html).toContain('<img src="data:image/jpeg;base64,AAAA"');
    expect(html).toContain('タンカー&lt;A&gt;');
    expect(html).not.toContain('タンカー<A>');
    expect(html).toContain('港内すべて');
    expect(html).toContain('<h2>記録一覧</h2>');
    expect(html).toContain('田中');
    expect(reportFileName('週報 10/25', day(25))).toBe('週報_10_25_20261025.html');
  });
});
