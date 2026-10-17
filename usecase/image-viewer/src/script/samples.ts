/** Sample scripts offered in the script dialog: each runs as it is, on the selected layer. */
export interface ScriptSample {
  name: string;
  code: string;
}

export const SAMPLES: readonly ScriptSample[] = [
  {
    name: 'レイヤーの一覧',
    code: `// 開いているレイヤーの id・種類・名前・件数を表示します。
const layers = await viewer.layers();
for (const l of layers) {
  print(l.id, l.kind, l.name, l.count ?? '', l.editable ? '（編集可）' : '');
}
`,
  },
  {
    name: '面積を計算して一時レイヤーに',
    code: `// 選択中のポリゴンレイヤーの地物ごとに測地線（WGS 84 楕円体）の面積を求め、
// 面積の属性を足した一時レイヤーを作ります。
const layer = await viewer.selectedLayer();
if (!layer || layer.kind !== 'vector') throw new Error('ポリゴンのレイヤーを選んでから実行してください');
const fc = await viewer.features(layer.id);
const out = [];
for (const [i, f] of fc.features.entries()) {
  const area = await geo.area(f.geometry);
  out.push({ ...f, properties: { ...f.properties, area_m2: Math.round(area), area_ha: Math.round(area / 100) / 100 } });
  if (i % 200 === 0) progress(i / fc.features.length, \`\${i} 件\`);
}
await viewer.createLayer(\`\${layer.name}（面積）\`, out);
print(\`\${out.length} 件の面積を計算しました\`);
`,
  },
  {
    name: '選んだ地物の属性を書き換える（編集）',
    code: `// 選択中のレイヤーで、地図や属性テーブルで選んだ地物の属性を書き換えます。
// 変更は編集中の扱いになり、編集バーの「保存」を押すまでサーバーやファイルには書き込まれません。
const FIELD = 'note';      // 書き換える属性の名前
const VALUE = '確認済み';  // 入れる値

const layer = await viewer.selectedLayer();
if (!layer?.editable) throw new Error('編集できるレイヤーを選んでください');
if (!layer.fields.some((f) => f.name === FIELD)) throw new Error(\`属性 \${FIELD} がありません: \${layer.fields.map((f) => f.name).join(', ')}\`);
const fc = await viewer.features(layer.id, { selected: true });
if (!fc.features.length) throw new Error('地物を選んでから実行してください');
const r = await viewer.updateFeatures(layer.id, fc.features.map((f) => ({ id: f.id, properties: { [FIELD]: VALUE } })));
print(\`\${r.updated} 件を変更しました。属性テーブルで確かめて「保存」を押してください（「元に戻す」1 回で取り消せます）\`);
`,
  },
  {
    name: '点がいくつ入っているかを数える',
    code: `// ポリゴンのレイヤーと点のレイヤーを 1 つずつ探し、ポリゴンごとに中の点を数えて一時レイヤーにします。
const layers = await viewer.layers();
const polygons = layers.find((l) => l.kind === 'vector' && /Polygon/.test(l.geometryType ?? ''));
const points = layers.find((l) => l.kind === 'vector' && /Point/.test(l.geometryType ?? ''));
if (!polygons || !points) throw new Error('ポリゴンのレイヤーと点のレイヤーを開いてください');
const areas = (await viewer.features(polygons.id)).features;
const pts = (await viewer.features(points.id)).features;
const out = [];
for (const [i, a] of areas.entries()) {
  const box = await geo.bbox(a.geometry);
  let n = 0;
  for (const p of pts) {
    const [x, y] = p.geometry.coordinates;
    if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) continue;
    if (await geo.contains(a.geometry, p.geometry)) n++;
  }
  out.push({ ...a, properties: { ...a.properties, count: n } });
  progress((i + 1) / areas.length);
}
await viewer.createLayer(\`\${polygons.name}（\${points.name} の件数）\`, out);
print('完了');
`,
  },
  {
    name: '選んだ地物から 100 m のバッファ',
    code: `// 選択中のレイヤーの選んだ地物（選んでいなければすべて）から測地線バッファを作り、一時レイヤーにします。
const layer = await viewer.selectedLayer();
const selected = (await viewer.selection()).ids.length > 0;
const result = await viewer.runTool('buffer', layer.id, { distance: 100, selected, dissolve: false, addLayer: \`\${layer.name} 100 m バッファ\` });
print(\`\${result.features.length} 件のバッファを作りました\`);
`,
  },
  {
    name: '撮像計画を CSV に保存',
    code: `// 選択中のレイヤーの地物について、7 日間の撮像機会を計算して CSV に保存します。
const layer = await viewer.selectedLayer();
if (!layer || layer.kind !== 'vector') throw new Error('対象のレイヤーを選んでください');
print('使える衛星:', (await viewer.satellites()).map((s) => s.name).join(', '));
const plan = await viewer.imagingPlan({ target: layer.id, days: 7, maxOffNadir: 30, firstOnly: true, addLayer: '撮像計画（スクリプト）' });
print(\`\${plan.opportunities.length} 回の機会がありました\`);
const rows = plan.opportunities.map((o) => ({
  日時: o.time, 衛星: o.satellite, 対象: o.target, オフナディア角: o.offNadir, 方向: o.side, 太陽高度: o.sunElevation, 被覆率: o.coverage,
}));
await viewer.saveText('imaging-plan.csv', toCsv(rows));
`,
  },
  {
    name: 'GeoJSON と CSV に書き出す',
    code: `// 選択中のレイヤーを GeoJSON（WGS 84）と CSV に書き出します。
const layer = await viewer.selectedLayer();
if (!layer || layer.kind === 'raster' || layer.kind === 'picture') throw new Error('ベクターレイヤーを選んでください');
await viewer.export(layer.id, { format: 'geojson' });
await viewer.export(layer.id, { format: 'csv' });
print('書き出しました');
`,
  },
  {
    name: '画像の統計（最小・最大・平均）',
    code: `// 選択中の画像のバンドごとの最小・最大・平均を、縮小した画素から求めます。
const layer = await viewer.selectedLayer();
if (layer?.kind !== 'raster') throw new Error('画像を選んでください');
const px = await viewer.readPixels(layer.id, { width: 1024 });
for (let b = 0; b < px.bands; b++) {
  let min = Infinity, max = -Infinity, sum = 0, n = 0;
  for (const v of px.data[b]) {
    if (v === px.noData || Number.isNaN(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    n++;
  }
  print(\`バンド \${b + 1}: 最小 \${min} 最大 \${max} 平均 \${(sum / n).toFixed(2)}\`);
}
`,
  },
  {
    name: '2 バンドの正規化差を新しい画像に',
    code: `// 選択中の画像の 2 つのバンドから (B - A) / (B + A) を計算し、新しい GeoTIFF として開きます。
const A = 0, B = 1;  // バンド番号（0 から）
const layer = await viewer.selectedLayer();
if (layer?.kind !== 'raster' || layer.bands < 2) throw new Error('2 バンド以上の画像を選んでください');
const px = await viewer.readPixels(layer.id, { bands: [A, B], width: 2048 });
const [a, b] = px.data;
const out = new Float32Array(a.length);
for (let i = 0; i < out.length; i++) out[i] = a[i] + b[i] === 0 ? NaN : (b[i] - a[i]) / (b[i] + a[i]);
await viewer.createRaster(\`\${layer.name} 正規化差\`, { width: px.width, height: px.height, data: out, extent: px.extent, crs: px.crs });
print('作成しました');
`,
  },
];
