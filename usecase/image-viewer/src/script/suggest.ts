/**
 * Suggestions in the script editor: typing `viewer.` or `geo.` (or a few
 * letters of a name, or Ctrl+Space) lists the functions with their
 * arguments and what they do; inside the quotes of a `viewer.…(` call, the
 * open layers' names (or the tools, menus, base maps the function takes). ↑↓ choose, Enter or Tab puts it in, Esc closes.
 */

/** One function or name a script can use. */
export interface ScriptEntry {
  /** As written: `viewer.features`, `print`. */
  name: string;
  /** The arguments, as shown: `(layer, { selected, bbox })`. */
  args: string;
  doc: string;
}

/** Everything a script can call, for the suggestions and the reference. */
export const ENTRIES: readonly ScriptEntry[] = [
  { name: 'viewer.layers', args: '()', doc: 'レイヤーの一覧（id・名前・種類・件数・属性・編集できるか）' },
  { name: 'viewer.layer', args: '(layer)', doc: '1 つのレイヤーの情報' },
  { name: 'viewer.selectedLayer', args: '()', doc: '選択中のレイヤー（なければ null）' },
  { name: 'viewer.selectLayer', args: '(layer)', doc: 'レイヤーを選択' },
  { name: 'viewer.features', args: '(layer, { selected, bbox, limit, fields })', doc: '地物を GeoJSON（経緯度）で。各地物の id で編集を指定' },
  { name: 'viewer.selection', args: '()', doc: '選択中の地物の { layer, ids }' },
  { name: 'viewer.select', args: '(layer, ids)', doc: '地物を選択' },
  { name: 'viewer.addFeatures', args: '(layer, features)', doc: '地物を追加（編集中の状態になり、保存まで未反映）' },
  { name: 'viewer.updateFeatures', args: '(layer, [{ id, properties, geometry }])', doc: '属性・形状を変更（同上）' },
  { name: 'viewer.deleteFeatures', args: '(layer, ids)', doc: '地物を削除（同上。「元に戻す」で復元可）' },
  { name: 'viewer.pendingEdits', args: '()', doc: '未保存の変更の { layer, name, count }' },
  { name: 'viewer.saveEdits', args: '()', doc: '未保存の変更を保存（件数を示して確認後に書き込み）' },
  { name: 'viewer.createLayer', args: '(name, features, { fields })', doc: '一時レイヤーを作る（ブラウザに保存）' },
  { name: 'viewer.runTool', args: "('buffer', layer, { distance, selected, dissolve, addLayer })", doc: 'buffer・centroid・pointsToLine・voronoi。addLayer: "名前" でレイヤーに' },
  { name: 'viewer.imagingPlan', args: '({ target, start, days, maxOffNadir, minIncidence, maxIncidence, pass, side, daylight, satellites, firstOnly, addLayer })', doc: '撮像計画の機会を計算' },
  { name: 'viewer.satellites', args: '()', doc: '撮像計画の衛星の一覧' },
  { name: 'viewer.observations', args: "({ image, object, kind: '船舶', from, to, deleted })", doc: '観測記録の一覧（撮像日時・モノ・種別・活動・確度・位置など）' },
  { name: 'viewer.observedThings', args: "({ kind })", doc: '観測したモノの一覧と流れ（初出・最終・活動の推移・移動距離）' },
  { name: 'viewer.observationImages', args: '()', doc: '観測記録の画像（撮像日時の順。ファイルなしの画像も）' },
  { name: 'viewer.observeImage', args: "('画像 ID')", doc: '観測記録の対象の画像を切り替え' },
  { name: 'viewer.addObservation', args: "({ lon, lat, image, object, kind, activity, confidence, note, present, length, heading })", doc: '観測記録を追加（初回の書き込み前に確認）' },
  { name: 'viewer.updateObservation', args: "(id, { kind, activity, confidence, note, present, lon, lat, length, heading })", doc: '観測記録を変更' },
  { name: 'viewer.renameObservedThing', args: "(objectId, '名前')", doc: 'モノの名前を全記録で変更' },
  { name: 'viewer.deleteObservations', args: '([id, …])', doc: '観測記録を削除（削除日時を入れて保持）' },
  { name: 'viewer.observationCandidates', args: '({ lon, lat, kind, length, heading, image })', doc: 'その地点のモノの同一候補（近さ・分類・長さ・向き）' },
  { name: 'viewer.confidences', args: '()', doc: '確度の段階（確かなものから順）' },
  { name: 'viewer.checkedAreas', args: '({ image })', doc: '確認範囲の一覧' },
  { name: 'viewer.addCheckedArea', args: "({ bbox: [西, 南, 東, 北] か polygon, kind, note, image })", doc: '確認範囲を追加（範囲内の対象は記録がすべて）' },
  { name: 'viewer.deleteCheckedAreas', args: '([id, …])', doc: '確認範囲を削除' },
  { name: 'viewer.observationReport', args: "({ title, from, to, kind, confidence, map, flows, areas, records, save })", doc: '観測の報告書を HTML で保存（save: false で HTML を返す）' },
  { name: 'viewer.rasterInfo', args: '(layer)', doc: '画像の大きさ・バンド数・座標系・範囲' },
  { name: 'viewer.readPixels', args: '(layer, { window, bbox, width, height, bands })', doc: '画素値（バンドごとの配列）。大きな範囲は縮小して読み込み' },
  { name: 'viewer.sample', args: '(layer, [[経度, 緯度], …], { bands })', doc: '地点の画素値' },
  { name: 'viewer.createRaster', args: '(name, { width, height, data, extent, crs, noData })', doc: '新しい GeoTIFF を作成して表示' },
  { name: 'viewer.export', args: "(layer, { format: 'geojson', name, crs, selected })", doc: 'geojson・csv・shapefile・geopackage で保存（GeoJSON の地物も指定可）' },
  { name: 'viewer.saveText', args: "('名前.csv', text)", doc: '.csv・.tsv・.txt・.json・.geojson・.md を保存' },
  { name: 'viewer.zoomTo', args: '(layer か [西, 南, 東, 北] か features)', doc: '地図を移動' },
  { name: 'viewer.view', args: '()', doc: '表示範囲（中心・ズーム・範囲）' },
  { name: 'viewer.setView', args: '({ center: [経度, 緯度], zoom, rotation, bbox, duration })', doc: '地図の中心・ズーム・回転、または範囲を設定' },
  { name: 'viewer.setVisible', args: '(layer, true)', doc: 'レイヤーを表示・非表示' },
  { name: 'viewer.setOpacity', args: '(layer, 0.5)', doc: '不透明度（0〜1）' },
  { name: 'viewer.moveLayer', args: "(layer, 'top')", doc: "重ね順を変える（'top'・'bottom'・'up'・'down'・数）" },
  { name: 'viewer.removeLayer', args: '(layer)', doc: 'レイヤーを閉じる（未保存の変更があるときは閉じない）' },
  { name: 'viewer.enhance', args: '(layer)', doc: '画像の補正（手順の配列）' },
  { name: 'viewer.setEnhance', args: '(layer, { brightness, contrast, exposure, gamma, saturation, autoStretch, sharpen… })', doc: '補正の変更（値 null でその手順を除外。全体を null で初期化）' },
  { name: 'viewer.setBands', args: '(layer, [R, G, B])', doc: 'バンドの割り当て（0 から。null で元のまま）' },
  { name: 'viewer.setNoData', args: '(layer, { auto, values })', doc: 'ノーデータの透明化（null で解除）' },
  { name: 'viewer.colorize', args: "(layer, { scale: 'red', reverse, fade, blend, classes: 5 | 'unique' | [{ value, color }], method: 'equal' | 'quantile' })", doc: '単バンド画像の着色・階調ごとの色分け（null で解除）' },
  { name: 'viewer.style', args: '(layer)', doc: 'ベクターレイヤーのスタイル' },
  { name: 'viewer.setStyle', args: "(layer, { color, mode: 'categorized', field, symbol, label })", doc: 'スタイルを変える（指定した所だけ）' },
  { name: 'viewer.baseMaps', args: '()', doc: '背景地図の一覧' },
  { name: 'viewer.setBaseMap', args: "('id')", doc: "背景地図を切り替え（'' で背景なし）" },
  { name: 'viewer.bookmarks', args: '()', doc: 'ブックマークの一覧' },
  { name: 'viewer.goBookmark', args: "('名前')", doc: 'ブックマークの範囲へ移動' },
  { name: 'viewer.addBookmark', args: "('名前')", doc: '今の範囲をブックマークに' },
  { name: 'viewer.timeline', args: "({ from: '2026-01-01', to: '2026-03-31' })", doc: 'タイムラインの期間（null ですべて。引数なしで現在の期間）' },
  { name: 'viewer.split', args: '(2, [layer, layer])', doc: '並べて比較（1・2・4 画面）' },
  { name: 'viewer.swipe', args: "(layer, { position: 0.5, orientation: 'vertical' })", doc: 'スワイプ比較（null で終了）' },
  { name: 'viewer.globe', args: '(true)', doc: '3D 表示の切り替え' },
  { name: 'viewer.theme', args: "('dark')", doc: "テーマ（'auto'・'light'・'dark'）" },
  { name: 'viewer.tools', args: '()', doc: '実行できるツールの一覧' },
  { name: 'viewer.toolOptions', args: "('band-math')", doc: 'ツールの設定項目と選べる値' },
  { name: 'viewer.tool', args: "('band-math', { image: layer, preset: 'ndvi' })", doc: 'ツールを設定して実行（作成したレイヤーを返却）' },
  { name: 'viewer.commands', args: '()', doc: '押せるメニューの一覧' },
  { name: 'viewer.command', args: "('timeline-open')", doc: 'メニューの実行（パネルやツールを開く）' },
  { name: 'viewer.open', args: "(url, { type: 'cog', layer })", doc: 'URL のレイヤーを開く（cog・file・wms・wmts・wfs・esri。初めてのサーバーは確認あり）' },
  { name: 'viewer.serviceLayers', args: "(url, 'wms')", doc: 'サービスのレイヤーの一覧' },
  { name: 'viewer.openFiles', args: "({ accept: '.tif', message })", doc: 'ユーザーが選んだファイルを開く' },
  { name: 'geo.area', args: '(geometry)', doc: '測地線の面積（m²）' },
  { name: 'geo.length', args: '(geometry)', doc: '測地線の長さ（m）。ポリゴンは周長' },
  { name: 'geo.distance', args: '(a, b)', doc: '距離（m）' },
  { name: 'geo.inverse', args: '([経度, 緯度], [経度, 緯度])', doc: '2 点の距離と方位角' },
  { name: 'geo.direct', args: '([経度, 緯度], 方位角, 距離)', doc: 'その方向・距離の先の点' },
  { name: 'geo.buffer', args: '(geometry, メートル, { segments, cap })', doc: '測地線バッファ' },
  { name: 'geo.centroid', args: '(geometry, { inside })', doc: '重心（inside: true で図形の内側）' },
  { name: 'geo.simplify', args: '(geometry, メートル)', doc: '形を保って単純化' },
  { name: 'geo.bbox', args: '(geometry)', doc: '範囲 [西, 南, 東, 北]' },
  { name: 'geo.union', args: '(a, b, …)', doc: '結合' },
  { name: 'geo.intersection', args: '(a, b)', doc: '重なり' },
  { name: 'geo.difference', args: '(a, b)', doc: 'a から b を除いた部分' },
  { name: 'geo.symDifference', args: '(a, b)', doc: 'どちらか一方だけの部分' },
  { name: 'geo.intersects', args: '(a, b)', doc: '交わるか' },
  { name: 'geo.contains', args: '(a, b)', doc: 'a が b を含むか' },
  { name: 'geo.within', args: '(a, b)', doc: 'a が b の中か' },
  { name: 'geo.touches', args: '(a, b)', doc: '接するか' },
  { name: 'geo.crosses', args: '(a, b)', doc: '横切るか' },
  { name: 'geo.overlaps', args: '(a, b)', doc: '一部が重なるか' },
  { name: 'geo.disjoint', args: '(a, b)', doc: '離れているかの判定' },
  { name: 'geo.equals', args: '(a, b)', doc: '同じ図形か' },
  { name: 'geo.transform', args: "(geometry, 'EPSG:4326', 'EPSG:6677')", doc: '座標を別の座標系に' },
  { name: 'print', args: '(…)', doc: '出力に表示（console.log も同じ）' },
  { name: 'progress', args: '(割合, 文)', doc: '進み具合を表示（0〜1）' },
  { name: 'sleep', args: '(ms)', doc: '待機' },
  { name: 'toCsv', args: '(rows, columns)', doc: 'オブジェクトの配列から CSV の文字列を作成' },
];

interface Item {
  label: string;
  detail: string;
  /** What replaces the word being typed. */
  insert: string;
}

/** What goes in the quotes of a function's first argument: its name and what it is. */
export interface Choice {
  name: string;
  detail: string;
}

/**
 * The word before the caret that suggestions complete, and what to offer
 * for it. `choices` gives what goes in the quotes of `viewer.xxx('…` (by
 * function name); a list of names is taken as layer names for every function.
 */
export function suggestionsAt(text: string, caret: number, choices: readonly string[] | ((fn: string) => readonly Choice[]), forced = false): { from: number; items: Item[] } | null {
  const before = text.slice(0, caret);
  const quoted = /viewer\.(\w+)\(\s*(['"])([^'"\n]*)$/.exec(before);
  if (quoted) {
    const [, fn, quote, typed] = quoted;
    const pool = typeof choices === 'function' ? choices(fn) : choices.map((name) => ({ name, detail: 'レイヤー' }));
    const items = pool
      .filter((c) => c.name.toLowerCase().includes(typed.toLowerCase()))
      .slice(0, 50)
      .map((c) => ({ label: c.name, detail: c.detail, insert: c.name.replaceAll('\\', '\\\\').replaceAll(quote, `\\${quote}`) }));
    return items.length ? { from: caret - typed.length, items } : null;
  }
  const word = /(?:\b(viewer|geo)\.)?([A-Za-z_]\w*)?$/.exec(before);
  if (!word) return null;
  const owner = word[1];
  const typed = word[2] ?? '';
  // In a comment or a string: nothing.
  const line = before.slice(before.lastIndexOf('\n') + 1);
  if (/\/\/|^\s*\*/.test(line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '')) || /(['"`])(?:\\.|(?!\1).)*$/.test(line)) return null;
  if (!owner && !forced && typed.length < 2) return null;
  const pool = ENTRIES.filter((e) => (owner ? e.name.startsWith(`${owner}.`) : true));
  const short = (e: ScriptEntry) => (owner ? e.name.slice(owner.length + 1) : e.name);
  const items: Item[] = pool
    .filter((e) => short(e).toLowerCase().startsWith(typed.toLowerCase()) || (!owner && typed && e.name.toLowerCase().includes(`.${typed.toLowerCase()}`)))
    .map((e) => ({ label: `${e.name}${e.args}`, detail: e.doc, insert: `${owner ? short(e) : e.name}(` }));
  if (!owner) for (const g of ['viewer', 'geo']) if (g.startsWith(typed) && typed !== g) items.unshift({ label: g, detail: g === 'viewer' ? 'ビューアの関数' : 'ジオメトリの関数', insert: `${g}.` });
  // A word already complete and alone: nothing to add.
  if (items.length === 1 && items[0].insert === `${typed}(`) return null;
  return items.length ? { from: caret - typed.length, items: items.slice(0, 60) } : null;
}

/** The caret's position in a textarea, in pixels from its top left (scrolling taken into account). */
function caretXY(area: HTMLTextAreaElement, at: number): { x: number; y: number; height: number } {
  const style = getComputedStyle(area);
  const mirror = document.createElement('div');
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'boxSizing'] as const) {
    mirror.style[p] = style[p];
  }
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', top: '0', left: '-9999px', width: `${area.clientWidth}px` });
  mirror.textContent = area.value.slice(0, at);
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.append(marker);
  document.body.append(mirror);
  const result = { x: marker.offsetLeft - area.scrollLeft, y: marker.offsetTop - area.scrollTop, height: marker.offsetHeight };
  mirror.remove();
  return result;
}

/** The suggestion list of an editor. */
export class Suggest {
  readonly list: HTMLUListElement;
  private items_: Item[] = [];
  private from_ = 0;
  private active_ = 0;

  constructor(
    private readonly area: HTMLTextAreaElement,
    private readonly choices: (fn: string) => readonly Choice[],
  ) {
    const list = (this.list = document.createElement('ul'));
    list.className = 'script-suggest';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', '候補');
    list.hidden = true;
    area.insertAdjacentElement('afterend', list);
    area.setAttribute('aria-autocomplete', 'list');
    area.addEventListener('input', (e) => {
      // Only typing opens it (not text set by a sample or a file).
      if ((e as InputEvent).inputType?.startsWith('insert') || (e as InputEvent).inputType === 'deleteContentBackward') this.update(false);
      else this.close();
    });
    area.addEventListener('keydown', (e) => this.key_(e), true);
    area.addEventListener('blur', () => setTimeout(() => this.close(), 150));
    area.addEventListener('scroll', () => this.close());
    list.addEventListener('mousedown', (e) => {
      const li = (e.target as HTMLElement).closest('li');
      if (!li) return;
      e.preventDefault();
      this.accept(Number(li.dataset.index));
    });
  }

  isOpen(): boolean {
    return !this.list.hidden;
  }

  /** Shows what fits the word at the caret (Ctrl+Space: even before two letters). */
  update(forced: boolean): void {
    const found = this.area.selectionStart === this.area.selectionEnd ? suggestionsAt(this.area.value, this.area.selectionStart, this.choices, forced) : null;
    if (!found) return this.close();
    this.items_ = found.items;
    this.from_ = found.from;
    this.active_ = 0;
    this.list.replaceChildren(
      ...found.items.map((item, i) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.dataset.index = String(i);
        const label = document.createElement('code');
        label.textContent = item.label;
        const detail = document.createElement('span');
        detail.textContent = item.detail;
        li.append(label, detail);
        return li;
      }),
    );
    const { x, y, height } = caretXY(this.area, this.area.selectionStart);
    this.list.style.left = `${Math.max(0, Math.min(this.area.offsetLeft + x, this.area.offsetLeft + this.area.clientWidth - 320))}px`;
    this.list.style.top = `${this.area.offsetTop + y + height + 2}px`;
    this.list.hidden = false;
    this.mark_();
  }

  close(): void {
    this.list.hidden = true;
    this.items_ = [];
  }

  /** Puts in the suggestion `index` in place of the word being typed. */
  accept(index = this.active_): void {
    const item = this.items_[index];
    if (!item) return;
    this.area.setRangeText(item.insert, this.from_, this.area.selectionStart, 'end');
    this.close();
    this.area.dispatchEvent(new Event('input'));
    this.area.focus();
    // After `viewer.` the functions follow at once.
    if (item.insert.endsWith('.')) this.update(true);
  }

  private mark_(): void {
    [...this.list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === this.active_)));
    (this.list.children[this.active_] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }

  private key_(e: KeyboardEvent): void {
    if (e.key === ' ' && e.ctrlKey) {
      e.preventDefault();
      this.update(true);
      return;
    }
    if (!this.isOpen()) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = this.items_.length;
      this.active_ = (this.active_ + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      this.mark_();
    } else if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.accept();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }
}
