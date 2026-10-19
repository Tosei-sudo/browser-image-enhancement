/**
 * Help for those new to the viewer, all of it opt-in, so nothing changes for
 * those who know their way: the 「?」 dialog's 「やりたいこと」 (tasks in
 * plain words, each with the steps and a 「場所を見る」 that points at the
 * button) and 「用語」 (the words of satellite imagery and GIS), and the
 * hints (off unless turned on): a short explanation beside whatever the
 * pointer or keyboard is on, right away instead of the browser's slow
 * tooltip, also for the icon buttons and sliders that have none.
 */

import { score } from './command-palette.js';

export interface HelpTopic {
  id: string;
  title: string;
  /** Other words someone looking for it might type. */
  keywords?: string;
  steps: string[];
  /** The element 「場所を見る」 points at: the first of these selectors that is on the page. */
  target?: string;
  /** Why the target may not be there yet (shown instead of pointing). */
  absent?: string;
}

export const HELP_TOPICS: Array<[group: string, topics: HelpTopic[]]> = [
  [
    'はじめの一歩',
    [
      {
        id: 'open',
        title: '画像やファイルを開く',
        keywords: '読み込む 追加 ファイル geotiff tif shapefile geojson kml csv cog url ドラッグ ドロップ',
        steps: [
          '左上のフォルダのボタンを押して、パソコンの画像・GeoTIFF・Shapefile・GeoJSON などを選びます（キーボードの O でも）。',
          'ファイルを地図の上にドラッグ＆ドロップしても開けます。',
          'インターネット上の画像（COG）は、フォルダの隣の鎖のボタンで URL を入れて開きます。',
          '前に開いたファイルは「最近」から開き直せます（Chrome・Edge）。',
        ],
        target: '#open',
      },
      {
        id: 'navigate',
        title: '地図を動かす・拡大する',
        keywords: 'ズーム 移動 スクロール パン 回転 拡大 縮小',
        steps: [
          '地図をドラッグすると動きます。マウスのホイールで拡大・縮小します。',
          '左上の「＋」「−」でも拡大・縮小できます。',
          'Shift を押しながらドラッグすると、囲んだ範囲へ拡大します。',
          'レイヤーの行の ⤢ を押すと、その画像の場所へ移動します。',
        ],
        target: '.ol-zoom',
      },
      {
        id: 'jump',
        title: '座標や地名の場所へ行く',
        keywords: '緯度 経度 住所 地名 検索 mgrs utm ジャンプ',
        steps: ['上の入力欄に緯度経度（例: 35.681 139.767）・MGRS・UTM・地名・住所を入れて Enter を押します（キーボードの / で入力欄へ）。', '地名は候補から選べます。'],
        target: '#jump input',
      },
      {
        id: 'layers',
        title: 'レイヤーを隠す・順番を変える・透かす',
        keywords: '表示 非表示 重ね順 不透明度 透明 閉じる 削除',
        steps: [
          '左の「レイヤー」の行のチェックで表示・非表示を切り替えます。',
          '↑ ↓ で重なりの順番を変えます。上の行ほど手前に描かれます。',
          '行のスライダーで不透明度（透け具合）を変えます。',
          '× でレイヤーを閉じます（ファイルは消えません）。',
        ],
        target: '#images',
      },
      {
        id: 'basemap',
        title: '背景の地図を変える',
        keywords: '背景地図 ベースマップ 地理院 osm 航空写真',
        steps: ['上の「背景地図」で、画像の下に敷く地図を選びます。「背景なし」にすると画像だけになります。'],
        target: '#basemap select, #basemap',
      },
      {
        id: 'project',
        title: '作業を保存して、あとで続きをする',
        keywords: 'プロジェクト 保存 ivproj 再開 続き',
        steps: [
          '「プロジェクト」→「保存」で、開いているファイル・調整・表示範囲を 1 つのファイル（.ivproj）に保存します（Ctrl + S）。',
          '次回は「プロジェクト」→「開く…」でそのファイルを選ぶと、同じ状態に戻ります。',
          '画像そのものはプロジェクトに入りません。元のファイルを移動しないでください。',
        ],
        target: '#project-menu .menu-button',
      },
      {
        id: 'palette',
        title: '機能を名前で探す',
        keywords: 'コマンド 検索 どこ メニュー ctrl k',
        steps: ['右上の ⌕ を押すか Ctrl + K で、すべての機能を名前で探して実行できます。ひらがなでも探せます（例: きょり）。'],
        target: '#palette-open',
      },
    ],
  ],
  [
    '画像を見やすくする',
    [
      {
        id: 'enhance',
        title: '画像を明るく・くっきりさせる',
        keywords: '明るさ コントラスト 暗い 見にくい 補正 調整 スライダー 露出 ガンマ 彩度 シャープ',
        steps: [
          '左のレイヤーで画像を選び、右上のパネルのスライダーを動かします。',
          '暗いときは「明るさ」か「露出」、ぼんやりしているときは「コントラスト」を上げます。',
          '「DRA」の「オン」にすると、表示している範囲に合わせて自動で明るさの幅を整えます。',
          '調整は画像ごとに残ります。スライダーの名前をダブルクリックするとその値が、「リセット」ですべてが元に戻ります。',
        ],
        target: '.ol-enhance-panel, .ol-enhance',
        absent: '右上のパネルは、画像を開いて選ぶと使えます。',
      },
      {
        id: 'white',
        title: '画像が真っ白・真っ黒・灰色に見える',
        keywords: '白飛び 黒つぶれ 見えない 16bit 衛星 灰色 ストレッチ',
        steps: [
          '衛星画像（16 ビット）は、そのままでは暗すぎたり白すぎたりします。右上のパネルで「DRA」の「オン」にしてみてください。',
          '「方式」を変えると明るさの幅の決め方が変わります。迷ったら「パーセントクリップ」のままで構いません。',
          '画像の縁が黒く出るときは、プロセッシングの「ノーデータの透明化」で透明にできます。',
        ],
        target: '.ol-enhance-panel, .ol-enhance',
        absent: '右上のパネルは、画像を開いて選ぶと使えます。',
      },
      {
        id: 'bands',
        title: '色の組み合わせ（バンド）を変える',
        keywords: 'バンド 割当 赤外 フォールスカラー rgb 波長',
        steps: [
          '右上のパネルの「バンド割当」で、R（赤）・G（緑）・B（青）にどのバンドを使うかを選びます。',
          '例えば R に近赤外のバンドを当てると、植物が赤く見えるフォールスカラーになります。',
        ],
        target: '.ol-enhance-bands, .ol-enhance',
        absent: 'バンドの選択は、3 バンド以上ある画像を選ぶと出ます。',
      },
      {
        id: 'colorize',
        title: '白黒の画像に色を付ける',
        keywords: '着色 カラースケール 疑似カラー 標高 1バンド',
        steps: ['レイヤーの行の ◐ を押し、カラースケール（色の並び）を選びます。'],
        target: '#images [data-action="colorize"]',
        absent: '◐ はレイヤーの行に出ます。先に画像を開いてください。',
      },
      {
        id: 'compare',
        title: '2 枚の画像を見比べる',
        keywords: 'スワイプ 比較 並べる 前後 変化 2画面',
        steps: [
          '「スワイプ比較」: 選んだレイヤーを線の片側だけに出し、線を動かして下の画像と見比べます。',
          '「並べて比較」: 地図を 2 つ（4 つ）に分けて、別々の画像を同じ場所で並べます（キーボードの C）。',
        ],
        target: '#swipe',
      },
      {
        id: 'info',
        title: '画像の情報を見る',
        keywords: '撮影日 解像度 サイズ メタデータ 座標系 バンド数',
        steps: ['左の「情報」に、選んでいるレイヤーの大きさ・座標系などが出ます。', '「メタデータを表示…」で、ファイルに書かれた詳しい情報を見られます。'],
        target: '[data-fold="info"] summary',
      },
    ],
  ],
  [
    '測る・描く',
    [
      {
        id: 'measure',
        title: '距離や面積を測る',
        keywords: '計測 長さ 面積 メートル キロ はかる',
        steps: [
          '「ツール」→「距離を測る」（キーボードの D）を選び、地図をクリックしていきます。ダブルクリックで終わります。',
          '面積は「面積を測る」（A）で、囲みたい形の角を順にクリックします。',
          'もう一度同じボタン（キー）を押すと計測をやめます。「計測を消去」で消せます。',
        ],
        target: '#measure-distance',
      },
      {
        id: 'height',
        title: '建物の高さを影から測る',
        keywords: '高さ 影 建物 太陽',
        steps: ['「ツール」→「影から高さ」（H）を選び、建物の根元、影の先端の順にクリックします。'],
        target: '#shadow-height',
      },
      {
        id: 'points',
        title: '地図に印（ポイント）を付ける',
        keywords: 'ポイント ピン 印 マーク 地点',
        steps: ['「ツール」→「ポイント追加」（P）を選び、地図をクリックします。', '付けた印は左の「ポイント」に並び、「GeoJSON 保存」でファイルにできます。'],
        target: '#add-point',
      },
      {
        id: 'annotate',
        title: '矢印や文字を書き込む',
        keywords: '注記 矢印 文字 メモ 書き込み 作図',
        steps: ['「ツール」→「注記を描く」（N）で、矢印・線・四角・文字を地図に描けます。'],
        target: '#annotate',
      },
      {
        id: 'new-layer',
        title: '自分でレイヤーを作って描く',
        keywords: '新規 レイヤー 作成 描く ポリゴン ライン デジタイズ',
        steps: ['「ツール」→「新規レイヤー…」で、点・線・面のどれを描くかと、持たせる項目（属性）を決めます。', '作るとすぐ描けます。描き終えたらレイヤーの行の ⇩ で保存します。'],
        target: '#new-layer',
      },
    ],
  ],
  [
    'データを重ねる・調べる',
    [
      {
        id: 'service',
        title: 'インターネットの地図を重ねる',
        keywords: 'サービス wms wmts wfs arcgis esri url 追加',
        steps: ['「サービスを追加」を押し、地図サービスの URL を入れます。WMS・WMTS・WFS・ArcGIS のサービスが使えます。'],
        target: '#add-service',
      },
      {
        id: 'table',
        title: '地物の属性（表）を見る',
        keywords: '属性テーブル 表 フィルタ 検索 csv',
        steps: ['Shapefile などのベクターレイヤーを選ぶと、下の「属性テーブル」に一覧が出ます。', '行をクリックするとその地物が地図で選ばれます。地図の地物をクリックしても表の行が選ばれます。'],
        target: '#table',
      },
      {
        id: 'style',
        title: 'ベクターの色やラベルを変える',
        keywords: 'スタイル 色 ラベル 太さ 記号 分類',
        steps: ['レイヤーの行の ◐ を押すと、色・線の太さ・ラベル・属性の値ごとの色分けを決められます。'],
        target: '#images [data-action="style"]',
        absent: '◐ はベクターレイヤーの行に出ます。先に Shapefile や GeoJSON を開いてください。',
      },
      {
        id: 'position',
        title: '画像の位置がずれている・地図に出ない',
        keywords: '幾何補正 ずれ 位置合わせ 座標系 投影 オルソ 出ない',
        steps: [
          '座標系を持たない画像は、レイヤーの行の ⌖ で場所（範囲や四隅）を決めます。',
          '少しずれているときは、左の「幾何補正」で位置をずらしたり、標高データ（DEM）でオルソ補正したりします。',
        ],
        target: '[data-fold="geometry"] summary',
      },
    ],
  ],
  [
    '保存・共有',
    [
      {
        id: 'save-view',
        title: '見えている範囲を画像で保存する',
        keywords: 'スクリーンショット png 保存 書き出し キャプチャ',
        steps: ['「ツール」→「表示範囲を保存」で、今の地図を PNG・GeoTIFF で保存します。', 'クリップボードに入れたいときは「表示範囲の画像をコピー」を使います。'],
        target: '#save-view',
      },
      {
        id: 'print',
        title: '印刷する・PDF にする',
        keywords: '印刷 pdf a4 a3 レイアウト 地図 縮尺 方位',
        steps: ['「ツール」→「印刷レイアウト…」で、タイトル・縮尺バー・方位記号・凡例を付けて PDF・PNG にします。'],
        target: '#print',
      },
      {
        id: 'share',
        title: '今の場所を人に伝える',
        keywords: 'リンク url 共有 ブックマーク 送る',
        steps: ['「ブックマーク」から今の表示のリンクをコピーして送れます。開いたファイルは相手の手元にも必要です。', '「ブックマーク」に名前を付けて残すと、あとでその場所へすぐ戻れます（キーボードの M）。'],
        target: '#bookmark-menu .menu-button',
      },
    ],
  ],
];

/** Words of satellite imagery and GIS, explained for someone meeting them the first time. */
export const GLOSSARY: Array<[term: string, reading: string, text: string]> = [
  ['レイヤー', 'れいやー', '地図に重ねる 1 枚 1 枚の絵や図形。透明なシートを重ねるように、上のものほど手前に描かれます。'],
  ['ラスター・ベクター', 'らすたー べくたー', 'ラスターは写真のように細かい点（ピクセル）の集まり、ベクターは点・線・面の図形の集まりです。'],
  ['GeoTIFF', 'じおてぃふ', '地図上の位置（座標）の情報を持った TIFF 画像。衛星画像や航空写真でよく使われます。'],
  ['COG', 'こぐ くらうど', 'Cloud Optimized GeoTIFF。インターネット上に置いたまま、見ている部分だけを読み込める GeoTIFF です。'],
  ['Shapefile', 'しぇーぷふぁいる', 'ベクターの代表的なファイル形式。.shp・.dbf・.shx などの複数のファイルで 1 組です（まとめて選んでください）。'],
  ['GeoJSON', 'じおじぇいそん', '点・線・面と属性を文字で書いたベクターのファイル形式です。'],
  ['属性', 'ぞくせい', '図形 1 つ 1 つに付いている名前・種類・数値などの情報。「属性テーブル」で表として見られます。'],
  ['バンド', 'ばんど', '画像が持つ色（波長）ごとの層。カラー写真は赤・緑・青の 3 バンド、衛星画像は近赤外なども加えた 4 バンド以上のことがあります。'],
  ['近赤外', 'きんせきがい', '目に見えない、赤より少し長い波長の光。植物がよく反射するので、植生を調べるのに使います。'],
  ['ビット数（8 ビット・16 ビット）', 'びっと', '1 つの点の明るさを何段階で記録しているか。8 ビットは 256 段階、16 ビットは 65536 段階で、16 ビットの画像は表示のときに明るさの幅を整える必要があります。'],
  ['DRA', 'でぃーあーるえー 自動', 'Dynamic Range Adjustment。表示している範囲の明るさの分布から、ちょうどよい明るさの幅を自動で決めます。'],
  ['ストレッチ', 'すとれっち', '画像の明るさの幅を、画面で見やすい幅に引き伸ばすこと。'],
  ['ヒストグラム', 'ひすとぐらむ', '明るさごとの点の数のグラフ。山が左に寄っていれば暗い画像、右なら明るい画像です。'],
  ['ノーデータ', 'のーでーた', '画像の中で「値がない」ことを表す点。撮影範囲の外の黒い縁などで、透明にして隠せます。'],
  ['座標系・投影', 'ざひょうけい とうえい', '地球の丸い表面の位置を、平らな地図の上の数値で表す決まり。緯度経度（WGS 84）や UTM などがあります。'],
  ['緯度経度', 'いどけいど', '地球上の位置を角度で表したもの。緯度は南北（北が正）、経度は東西（東が正）です。'],
  ['MGRS', 'えむじーあーるえす', '軍用格子参照方式。54SUE1234567890 のように、地域・100 km 四方の区画・東西南北の距離で位置を表します。'],
  ['UTM', 'ゆーてぃーえむ', 'ユニバーサル横メルカトル図法。地球を経度 6 度ごとの帯に分け、メートルで位置を表します。'],
  ['幾何補正', 'きかほせい', '画像のゆがみや位置のずれを直して、地図にぴったり重なるようにすること。'],
  ['オルソ補正', 'おるそほせい', '地形の高低や斜めから撮ったことによるずれを、標高データを使って直すこと。真上から見た画像になります。'],
  ['DEM', 'でむ 標高', 'Digital Elevation Model。地面の高さを格子状に並べたデータで、オルソ補正や等高線に使います。'],
  ['RPC', 'あーるぴーしー', '衛星画像に付いている、画像の位置と地上の位置を結ぶ式の係数。オルソ補正に使います。'],
  ['パンシャープン', 'ぱんしゃーぷん', '細かい白黒の画像（パンクロ）と、粗いカラーの画像を合わせて、細かいカラー画像を作ること。'],
  ['NDVI', 'えぬでぃーぶいあい 植生', '正規化植生指標。赤と近赤外のバンドから計算し、植物が多いほど大きな値になります。'],
  ['WMS・WMTS・WFS', 'さーびす', 'インターネットで地図を配る仕組み。WMS・WMTS は地図の絵を、WFS は図形と属性を配ります。'],
  ['SAR', 'さー れーだー', '合成開口レーダー。電波で地表を写すので、夜や雲の下でも撮れます。白黒のざらついた画像になります。'],
];

/** Explanations for controls without a tooltip of their own (or with one only a specialist reads): a selector, or the text of a panel row. */
const CONTROL_HINTS: Array<[match: string, text: string]> = [
  ['#project-menu .menu-button', '開いているファイル・調整・表示範囲を 1 つのファイルに保存したり、保存したものを開いたりします。'],
  ['#add-service', 'インターネット上の地図サービス（WMS・WMTS・WFS・ArcGIS）をレイヤーとして重ねます。'],
  ['#basemap select', '画像の下に敷く地図を選びます。'],
  ['#tools-menu .menu-button', '計測・作図・解析・AI・保存・印刷などの道具をまとめたメニューです。'],
  ['#jump input', '緯度経度（例: 35.681 139.767）・MGRS・UTM・地名・住所を入れて Enter で移動します。'],
  ['#help', '使い方・やりたいことの探し方・用語の説明・ショートカットの一覧です。'],
  ['.recent-button', '前に開いたファイルを開き直します。'],
  ['#add-point', '地図をクリックした場所に印を付けます。'],
  ['#save-points', '付けた印（ポイント）を GeoJSON ファイルに保存します。'],
  ['#measure-clear', '地図に描いた計測をすべて消します。'],
  ['.ol-zoom-in', '拡大します。'],
  ['.ol-zoom-out', '縮小します。'],
  ['row:補正', 'オフにすると、調整する前の画像を表示します。'],
  ['row:リセット', 'この画像の調整をすべて元に戻します。'],
  ['row:不透明度', '画像の透け具合。左ほど透けて下の地図が見えます。'],
  ['row:オン', 'DRA: 表示している範囲の明るさに合わせて、自動で見やすくします。16 ビットの衛星画像で特に効きます。'],
  ['row:方式', 'DRA で明るさの幅を決める方法。迷ったら「パーセントクリップ」で構いません。'],
  ['row:クリップ (%)', '明るすぎる・暗すぎる点を何 % 無視するか。大きいほどコントラストが強くなります。'],
  ['row:RGB 連動', 'オンにすると赤・緑・青を同じ幅で整え、色合いを保ちます。オフだと色ごとに整えます。'],
  ['row:範囲を固定', 'オンにすると、地図を動かしても今の明るさの幅のままにします。'],
  ['row:露出 (EV)', '写真の露出と同じように全体を明るく・暗くします。1 で 2 倍の明るさです。'],
  ['row:明るさ', '全体を明るく・暗くします。'],
  ['row:コントラスト', '明るいところと暗いところの差。上げるとくっきり、下げると柔らかくなります。'],
  ['row:ガンマ', '中間の明るさだけを変えます。1 より大きいと暗い部分が見やすくなります。'],
  ['row:レベル 黒', 'これより暗い部分を真っ黒にします。かすんだ画像を締めるときに上げます。'],
  ['row:レベル 白', 'これより明るい部分を真っ白にします。暗い画像を明るくするときに下げます。'],
  ['row:レベル 中間', '黒と白の間の明るさの配分を変えます。'],
  ['row:色温度', '右で暖かい（黄色い）色、左で冷たい（青い）色に寄せます。'],
  ['row:彩度', '色の鮮やかさ。左端で白黒になります。'],
  ['row:シャープ 量', '輪郭をくっきりさせる強さ。上げすぎると縁取りやノイズが目立ちます。'],
  ['row:シャープ 半径', 'くっきりさせる輪郭の太さ。'],
  ['row:シャープ しきい値', 'これより小さな明るさの違いはくっきりさせません。ノイズを強めないために上げます。'],
  ['row:R（赤）', '画面の赤に使うバンド。'],
  ['row:G（緑）', '画面の緑に使うバンド。'],
  ['row:B（青）', '画面の青に使うバンド。'],
];

const HINTS_KEY = 'image-viewer.hints';

function readFlag(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeFlag(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

/** Topics and glossary words matching `query`, best first. */
export function searchHelp(query: string): { topics: HelpTopic[]; terms: Array<(typeof GLOSSARY)[number]> } {
  const topics = HELP_TOPICS.flatMap(([group, list]) => list.map((t) => ({ t, s: score({ label: t.title, detail: `${group} ${t.keywords ?? ''} ${t.steps.join(' ')}` }, query) })))
    .filter(({ s }) => s >= 0)
    .sort((a, b) => b.s - a.s)
    .map(({ t }) => t);
  const terms = GLOSSARY.map((g) => ({ g, s: score({ label: g[0], detail: `${g[1]} ${g[2]}` }, query) }))
    .filter(({ s }) => s >= 0)
    .sort((a, b) => b.s - a.s)
    .map(({ g }) => g);
  return { topics, terms };
}

/** The name a control goes by: its label, its text, or the text of its panel row. */
function nameOf(el: Element): string {
  const row = el.closest('.ol-enhance-row');
  if (row) return row.querySelector('span')?.textContent?.trim() ?? '';
  const text = el.getAttribute('aria-label') ?? (el instanceof HTMLInputElement ? (el.placeholder ?? '') : (el.textContent ?? ''));
  return text.replace(/\s+/g, ' ').trim();
}

/** An explanation of `el` from {@link CONTROL_HINTS}, if it has one. */
export function controlHint(el: Element): string | undefined {
  const name = nameOf(el);
  for (const [match, text] of CONTROL_HINTS) {
    if (match.startsWith('row:')) {
      if (el.closest('.ol-enhance') && name === match.slice(4)) return text;
    } else if (el.matches(match)) {
      return text;
    }
  }
  return undefined;
}

const HINTED = 'button, input:not([type=hidden]), select, summary, [role=tab], [role=radio], .ol-enhance-row';

/**
 * The hints: while on, the control under the pointer (or with the keyboard
 * focus) gets a bubble with its name, what it does and its key. Off by
 * default; the choice is remembered.
 */
export class Hints {
  readonly bubble: HTMLElement;
  private enabled_ = false;
  private timer_ = 0;
  private current_: HTMLElement | null = null;
  private titleWatch_: MutationObserver | null = null;
  private readonly listeners_ = new Set<(on: boolean) => void>();

  constructor() {
    const bubble = (this.bubble = document.createElement('div'));
    bubble.className = 'hint-bubble';
    bubble.setAttribute('role', 'tooltip');
    bubble.id = 'hint-bubble';
    // A popover sits in the top layer, so it shows over an open dialog too.
    bubble.popover = 'manual';
    document.body.append(bubble);

    document.addEventListener('pointerover', (e) => {
      if (!this.enabled_ || e.pointerType === 'touch') return;
      const el = (e.target as Element).closest<HTMLElement>(HINTED);
      if (el !== this.current_) this.schedule_(el);
    });
    document.addEventListener('focusin', (e) => {
      if (!this.enabled_) return;
      const el = e.target instanceof HTMLElement && e.target.matches(':focus-visible') ? e.target.closest<HTMLElement>(HINTED) : null;
      this.schedule_(el);
    });
    document.addEventListener('focusout', () => this.schedule_(null));
    document.addEventListener('pointerdown', () => this.hide_(), true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide_();
    });
    document.addEventListener('scroll', () => this.hide_(), true);

    this.set(readFlag(HINTS_KEY) === 'on');
  }

  isEnabled(): boolean {
    return this.enabled_;
  }

  set(on: boolean): void {
    this.enabled_ = on;
    writeFlag(HINTS_KEY, on ? 'on' : null);
    document.documentElement.classList.toggle('hints-on', on);
    if (!on) this.hide_();
    for (const listener of this.listeners_) listener(on);
  }

  toggle(): void {
    this.set(!this.enabled_);
  }

  /** Called with the new state whenever the hints are turned on or off. */
  onChange(listener: (on: boolean) => void): void {
    this.listeners_.add(listener);
  }

  /** The bubble's lines for `el`, or null when there is nothing to say beyond its own text. */
  describe(el: HTMLElement): { name: string; text: string; keys: string } | null {
    const name = nameOf(el);
    const title = (el.dataset.hintTitle ?? el.title ?? '').trim();
    let text = controlHint(el) ?? '';
    if (title && title !== name && !text.includes(title)) text = text ? `${text}\n${title}` : title;
    const keys = (el.getAttribute('aria-keyshortcuts') ?? '')
      .split(' ')[0]
      .split('+')
      .filter(Boolean)
      .map((k) => (k === 'Control' ? 'Ctrl' : k))
      .join(' + ');
    if (!text && !keys) return null;
    return { name, text, keys };
  }

  private schedule_(el: HTMLElement | null): void {
    clearTimeout(this.timer_);
    if (!el) {
      this.timer_ = window.setTimeout(() => this.hide_(), 80);
      return;
    }
    this.timer_ = window.setTimeout(() => this.show_(el), this.current_ ? 0 : 250);
  }

  private show_(el: HTMLElement): void {
    this.hide_();
    if (!el.isConnected) return;
    const about = this.describe(el);
    if (!about) return;
    this.current_ = el;
    // The browser's own tooltip would cover the bubble a second later: keep the title aside while it
    // shows, and the newest one if the page changes it meanwhile (a menu naming the tool in use).
    if (el.hasAttribute('title')) {
      el.dataset.hintTitle = el.title;
      el.title = '';
      const watch = (this.titleWatch_ = new MutationObserver(() => {
        el.dataset.hintTitle = el.title;
        if (el.title) {
          el.title = '';
          watch.takeRecords();
        }
      }));
      watch.observe(el, { attributes: true, attributeFilter: ['title'] });
    }
    el.setAttribute('aria-describedby', this.bubble.id);
    const name = document.createElement('strong');
    name.textContent = about.name;
    const parts: Node[] = [];
    if (about.name && about.name.length <= 40) parts.push(name);
    if (about.keys) {
      const kbd = document.createElement('kbd');
      kbd.textContent = about.keys;
      parts.push(kbd);
    }
    const lines = about.text.split('\n').map((line) => {
      const p = document.createElement('p');
      p.textContent = line;
      return p;
    });
    const head = document.createElement('div');
    head.className = 'hint-head';
    head.append(...parts);
    this.bubble.replaceChildren(...(parts.length ? [head] : []), ...lines);
    this.bubble.showPopover();
    this.place_(el);
  }

  private place_(el: HTMLElement): void {
    const r = el.getBoundingClientRect();
    const b = this.bubble.getBoundingClientRect();
    const gap = 8;
    let top = r.bottom + gap;
    if (top + b.height > innerHeight - 4 && r.top - gap - b.height >= 4) top = r.top - gap - b.height;
    const left = Math.min(Math.max(4, r.left + r.width / 2 - b.width / 2), innerWidth - b.width - 4);
    this.bubble.style.left = `${Math.round(left)}px`;
    this.bubble.style.top = `${Math.round(Math.max(4, top))}px`;
  }

  private hide_(): void {
    const el = this.current_;
    this.current_ = null;
    this.titleWatch_?.disconnect();
    this.titleWatch_ = null;
    if (el) {
      if (el.dataset.hintTitle !== undefined) {
        el.title = el.dataset.hintTitle;
        delete el.dataset.hintTitle;
      }
      if (el.getAttribute('aria-describedby') === this.bubble.id) el.removeAttribute('aria-describedby');
    }
    if (this.bubble.matches(':popover-open')) this.bubble.hidePopover();
  }
}

/** Whether `el` takes up room on the page now (not hidden, nor inside something hidden). */
function shown(el: Element): boolean {
  return el.getClientRects().length > 0;
}

/**
 * Points at the element of `topic`: opens the menu or folded section it is
 * in, scrolls to it and rings it for a few seconds with the topic's title.
 * Returns false (and points at nothing) when it is not on the page now.
 */
export function pointAt(topic: HelpTopic, say: (text: string) => void): boolean {
  const selectors = topic.target?.split(',').map((s) => s.trim()) ?? [];
  const els = selectors.map((s) => document.querySelector<HTMLElement>(s)).filter((el): el is HTMLElement => !!el);
  let el = els.find(shown) ?? els[0];
  if (!el) {
    say(topic.absent ?? 'その場所は今は表示されていません。');
    return false;
  }
  // In a closed menu: open it (its own button opens it, so the menu stays in charge of closing).
  const menu = el.closest('.menu');
  const panel = menu?.querySelector<HTMLElement>('.menu-panel');
  if (panel?.hidden && panel.contains(el)) menu!.querySelector<HTMLButtonElement>('.menu-button')?.click();
  const details = el.closest('details');
  if (details && !details.open && !el.matches('summary')) details.open = true;
  if (!shown(el)) {
    const visible = els.find(shown);
    if (!visible) {
      say(topic.absent ?? 'その場所は今は表示されていません。');
      return false;
    }
    el = visible;
  }
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  spotlight(el, topic.title);
  return true;
}

let clearSpot: (() => void) | null = null;

/** A ring around `el` with `caption` beside it, gone after a few seconds, a click or a key. */
export function spotlight(el: HTMLElement, caption: string): void {
  clearSpot?.();
  const ring = document.createElement('div');
  ring.className = 'help-spot';
  ring.setAttribute('aria-hidden', 'true');
  const label = document.createElement('div');
  label.className = 'help-spot-caption';
  label.setAttribute('role', 'status');
  label.textContent = `ここです: ${caption}`;
  for (const node of [ring, label]) {
    node.popover = 'manual';
    document.body.append(node);
    node.showPopover();
  }
  let frame = 0;
  const follow = () => {
    const r = el.getBoundingClientRect();
    const pad = 4;
    Object.assign(ring.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    // Beside it when there is room (so it covers nothing of a menu's next items), else below or above.
    if (r.right + 12 + label.offsetWidth < innerWidth - 4) {
      Object.assign(label.style, { left: `${r.right + 12}px`, top: `${Math.max(4, r.top + r.height / 2 - label.offsetHeight / 2)}px` });
    } else {
      const below = r.bottom + 10 + label.offsetHeight < innerHeight;
      const left = Math.min(Math.max(4, r.left), innerWidth - label.offsetWidth - 4);
      Object.assign(label.style, { left: `${left}px`, top: `${below ? r.bottom + 10 : Math.max(4, r.top - 10 - label.offsetHeight)}px` });
    }
    frame = requestAnimationFrame(follow);
  };
  follow();
  const end = () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    ring.remove();
    label.remove();
    document.removeEventListener('pointerdown', end, true);
    document.removeEventListener('keydown', end, true);
    if (clearSpot === end) clearSpot = null;
  };
  const timer = window.setTimeout(end, 6000);
  // The click that opened it is over by now; the next one (or a key) ends it.
  setTimeout(() => {
    document.addEventListener('pointerdown', end, true);
    document.addEventListener('keydown', end, true);
  });
  clearSpot = end;
}
