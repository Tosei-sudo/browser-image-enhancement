import { createGpuRenderer, createPreviewRunner, pipeline, type ColorMode, type ImageDataLike } from '../src/index.js';

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
const view = $<HTMLCanvasElement>('view');
const status = $<HTMLParagraphElement>('status');
const inputs = {} as Record<Key, HTMLInputElement>;

for (const s of sliders) {
  const label = document.createElement('label');
  label.innerHTML = `<span>${s.label}</span><input type="range" min="${s.min}" max="${s.max}" step="${s.step}" value="${s.value}"><output>${s.value}</output>`;
  const input = label.querySelector('input')!;
  const out = label.querySelector('output')!;
  input.addEventListener('input', () => {
    out.textContent = input.value;
    render();
  });
  // While dragging the preview works on a shrunk copy; the full-size result follows on release.
  input.addEventListener('change', () => render(true));
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

// With WebGL2 the full-size image follows every slider move on the GPU; without it, a shrunk preview in workers.
const gpuView = $<HTMLCanvasElement>('gpuView');
const gpu = createGpuRenderer({ canvas: gpuView });
const gpuBox = $<HTMLInputElement>('gpu');
if (!gpu) {
  gpuBox.checked = false;
  gpuBox.disabled = true;
}
let gpuImage: { source: ImageDataLike; colorMode: string } | null = null;
let frame = 0;

function useGpu(): boolean {
  return !!gpu && gpuBox.checked && Math.max(source.width, source.height) <= gpu.maxSize;
}

function renderGpu() {
  const colorMode = $<HTMLSelectElement>('colorMode').value as ColorMode;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    if (!gpu) return;
    const t0 = performance.now();
    if (gpuImage?.source !== source || gpuImage.colorMode !== colorMode) {
      gpu.setImage(source, { colorMode });
      gpuImage = { source, colorMode };
    }
    gpu.render(current());
    // Reading one pixel waits for the GPU, so the time shown is the real one.
    const gl = gpuView.getContext('webgl2')!;
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    view.hidden = true;
    gpuView.hidden = false;
    status.textContent = `${source.width}×${source.height} · GPU ${Math.round(performance.now() - t0)} ms`;
  });
}
let preview = makeRunner(1280);
let full = makeRunner();

function makeRunner(maxSize?: number) {
  return createPreviewRunner({
    colorMode: $<HTMLSelectElement>('colorMode').value as ColorMode,
    worker: $<HTMLInputElement>('worker').checked,
    maxSize,
  });
}

async function render(fullSize = false) {
  if (useGpu()) {
    renderGpu();
    return;
  }
  const t0 = performance.now();
  (fullSize ? preview : full).cancel();
  const result = await (fullSize ? full : preview).run(current(), source);
  if (!result) return; // superseded by a newer slider value
  view.width = result.width;
  view.height = result.height;
  view.getContext('2d')!.putImageData(result, 0, 0);
  view.hidden = false;
  gpuView.hidden = true;
  status.textContent = `${result.width}×${result.height} · ${Math.round(performance.now() - t0)} ms`;
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
  source = await pipeline().run(file); // decode once (applies EXIF orientation, converts to sRGB)
  render(true);
});
for (const id of ['colorMode', 'worker', 'gpu']) {
  $(id).addEventListener('change', () => {
    preview.cancel();
    full.cancel();
    preview = makeRunner(1280);
    full = makeRunner();
    render(true);
  });
}
$('reset').addEventListener('click', () => {
  for (const s of sliders) {
    inputs[s.key].value = String(s.value);
    inputs[s.key].nextElementSibling!.textContent = String(s.value);
  }
  render(true);
});
$('download').addEventListener('click', async () => {
  const blob = await current().run(source, { output: 'blob', colorMode: $<HTMLSelectElement>('colorMode').value as ColorMode });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'enhanced.png';
  a.click();
  URL.revokeObjectURL(a.href);
});

render(true);
