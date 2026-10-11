/**
 * A detection worker: holds one session of the model and runs it over the
 * tiles it is sent, so the page stays responsive while a model works
 * (ONNX Runtime's WebAssembly would otherwise hold the main thread for
 * seconds per tile). See detect-pool.ts.
 */
import { detectTile } from './detect-tile.js';
import type { DetectorSpec } from './model-config.js';
import { createModel, nameOf, type LoadedModel } from './runtime.js';

export type DetectRequest =
  | { type: 'load'; bytes: Uint8Array; name: string; useGpu: boolean }
  | { type: 'run'; id: number; rgba: Uint8ClampedArray; width: number; height: number; spec: DetectorSpec };

let model: LoadedModel | null = null;

self.onmessage = async (event: MessageEvent<DetectRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'load') {
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
