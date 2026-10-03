import { createEditor, createGpuRenderer, pipeline, type ColorMode, type Editor, type ImageDataLike } from '../src/index.js';

const sliders = [
  { key: 'brightness', label: '明るさ', min: -1, max: 1, step: 0.01, value: 0 },
  { key: 'contrast', label: 'コントラスト', min: -1, max: 1, step: 0.01, value: 0 },
  { key: 'exposure', label: '露出 (EV)', min: -3, max: 3, step: 0.05, value: 0 },
  { key: 'gamma', label: 'ガンマ', min: 0.2, max: 3, step: 0.01, value: 1 },
  { key: 'saturation', label: '彩度', min: -1, max: 1, step: 0.01, value: 0 },
  { key: 'temperature', label: '色温度', min: -1, max: 1, step: 0.01, value: 0 },
  { key: 'inBlack', label: 'レベル 黒', min: 0, max: 0.5, step: 0.005, value: 0 },
  { key: 'inWhite', label: 'レベル 白', min: 0.5, max: 1, step: 0.005, value: 1 },
  { key: 'midGamma', label: 'レベル 中間', min: 0.2, max: 3, step: 0.01, value: 1 },
  { key: 'sharpen', label: 'シャープ 量', min: 0, max: 3, step: 0.05, value: 0 },
  { key: 'sharpenRadius', label: 'シャープ 半径', min: 0.3, max: 5, step: 0.1, value: 1 },
  { key: 'sharpenThreshold', label: 'シャープ しきい値', min: 0, max: 0.1, step: 0.002, value: 0 },
] as const;

type Key = (typeof sliders)[number]['key'];
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
/** Whether this browser can correct on the GPU at all. */
const hasGpu = (() => {
  const gpu = createGpuRenderer();
  gpu?.dispose();
  return gpu !== null;
})();
if (!hasGpu) {
  $<HTMLInputElement>('gpu').checked = false;
  $<HTMLInputElement>('gpu').disabled = true;
}
const status = $<HTMLParagraphElement>('status');
const inputs = {} as Record<Key, HTMLInputElement>;

for (const s of sliders) {
  const label = document.createElement('label');
  label.innerHTML = `<span>${s.label}</span><input type="range" min="${s.min}" max="${s.max}" step="${s.step}" value="${s.value}"><output>${s.value}</output>`;
  const input = label.querySelector('input')!;
  const out = label.querySelector('output')!;
  input.addEventListener('input', () => {
    out.textContent = input.value;
    void render();
  });
  inputs[s.key] = input;
  $('sliders').append(label);
}

const v = (k: Key) => Number(inputs[k].value);
const current = () =>
  pipeline()
    .exposure(v('exposure'))
    .brightness(v('brightness'))
    .contrast(v('contrast'))
    .gamma(v('gamma'))
    .levels({ inBlack: v('inBlack'), inWhite: v('inWhite'), gamma: v('midGamma') })
    .temperature(v('temperature'))
    .saturation(v('saturation'))
    .sharpen({ amount: v('sharpen'), radius: v('sharpenRadius'), threshold: v('sharpenThreshold') });

let source: ImageDataLike = sampleImage();

// The editor shows the full-size image on the GPU (WebGL2) when it can, else a
// shrunk preview in workers that the full size replaces once the sliders stop.
let editor = makeEditor();

function makeEditor(): Editor {
  // A canvas keeps the kind of context it first got, so each editor gets a new one.
  const canvas = document.createElement('canvas');
  canvas.id = 'view';
  $('view').replaceWith(canvas);
  const e = createEditor({
    canvas,
    engine: $<HTMLInputElement>('gpu').checked ? 'auto' : 'cpu',
    colorMode: $<HTMLSelectElement>('colorMode').value as ColorMode,
    worker: $<HTMLInputElement>('worker').checked,
    onRender: ({ engine, width, height, ms }) => {
      status.textContent = `${width}×${height} · ${engine === 'gpu' ? 'GPU' : 'JS'} ${Math.round(ms)} ms`;
    },
  });
  return e;
}

async function render() {
  await editor.render(current());
}
function sampleImage(): ImageData {
  const w = 640;
  const h = 400;
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, w, 0);
  ['#e63946', '#f4a261', '#e9c46a', '#2a9d8f', '#264653', '#7b2cbf'].forEach((col, i, a) => g.addColorStop(i / (a.length - 1), col));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h * 0.6);
  const k = ctx.createLinearGradient(0, 0, w, 0);
  k.addColorStop(0, '#000');
  k.addColorStop(1, '#fff');
  ctx.fillStyle = k;
  ctx.fillRect(0, h * 0.6, w, h * 0.4);
  return ctx.getImageData(0, 0, w, h);
}

$<HTMLInputElement>('file').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  await editor.setImage(file); // decodes once (applies EXIF orientation, converts to sRGB) and redraws
  source = editor.image!;
});
for (const id of ['colorMode', 'worker', 'gpu']) {
  $(id).addEventListener('change', () => {
    editor.dispose();
    editor = makeEditor();
    void editor.setImage(source).then(render);
  });
}
$('reset').addEventListener('click', () => {
  for (const s of sliders) {
    inputs[s.key].value = String(s.value);
    inputs[s.key].nextElementSibling!.textContent = String(s.value);
  }
  void render();
});
$('download').addEventListener('click', async () => {
  const blob = await editor.export(current(), { output: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'enhanced.png';
  a.click();
  URL.revokeObjectURL(a.href);
});

void editor.setImage(source).then(render);
