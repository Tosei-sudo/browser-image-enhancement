/**
 * A detection worker: holds one session of the model and runs it over the
 * tiles it is sent, so the page stays responsive while a model works
 * (ONNX Runtime's WebAssembly would otherwise hold the main thread for
 * seconds per tile). See detect-pool.ts.
 */
import { detectTile } from './detect-tile.js';
import type { DetectorSpec } from './model-config.js';
import { createModel, loadOrt, nameOf, type LoadedModel } from './runtime.js';

export type DetectRequest =
  | { type: 'load'; bytes: Uint8Array; name: string; useGpu: boolean; threads: number }
  | { type: 'run'; id: number; rgba: Uint8ClampedArray; width: number; height: number; spec: DetectorSpec };

let model: LoadedModel | null = null;

/**
 * On a cross-origin isolated page ONNX Runtime runs a model on several
 * threads, starting each from this same script (it is bundled in), named
 * `em-pthread…`: such a worker only loads ONNX Runtime, which takes its
 * messages over. What arrives before that is kept and handed on.
 */
const thread = self.name.startsWith('em-pthread');
if (thread) {
  const early: MessageEvent[] = [];
  self.onmessage = (event) => early.push(event);
  void loadOrt().then(() => {
    for (const event of early) self.onmessage?.(event);
  });
} else self.onmessage = async (event: MessageEvent<DetectRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'load') {
      (await loadOrt()).env.wasm.numThreads = request.threads;
      model = await createModel(request.bytes, request.name, request.useGpu);
      self.postMessage({ type: 'loaded', backend: model.backend });
    } else {
      if (!model) throw new Error('モデルが読み込まれていません');
      const input = nameOf(model.session.inputNames, 'images', 0);
      const found = await detectTile(model, input, request.rgba, request.width, request.height, 0, 0, request.spec);
      self.postMessage({ type: 'done', id: request.id, found });
    }
  } catch (error) {
    self.postMessage({ type: 'error', id: request.type === 'run' ? request.id : -1, message: error instanceof Error ? error.message : String(error) });
  }
};
