/**
 * ONNX Runtime Web, loaded the first time an AI tool runs (it is large, and
 * most sessions never need it). It runs on the GPU through WebGPU when the
 * browser has it, otherwise on the CPU (WebAssembly). Its WebAssembly file
 * is part of the build, so it works in a closed network like the rest of the
 * site; models come from `config.json` URLs or files chosen on the computer.
 */
import type { InferenceSession, Tensor } from 'onnxruntime-web/webgpu';
import { onnxMetadata } from './model-config.js';

type Ort = typeof import('onnxruntime-web/webgpu');

let ort: Promise<Ort> | null = null;

/** ONNX Runtime, imported once. */
export function loadOrt(): Promise<Ort> {
  return (ort ??= import('onnxruntime-web/webgpu').then((m) => {
    const runtime = ((m as unknown as { default?: Ort }).default ?? m) as Ort;
    runtime.env.logLevel = 'error';
    // Threads need a cross-origin isolated page; elsewhere ONNX Runtime falls back to one.
    runtime.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    return runtime;
  }));
}

/** Where a model runs. */
export type Backend = 'webgpu' | 'wasm';

/** Whether this browser offers a WebGPU adapter (checked once). */
let gpu: Promise<boolean> | null = null;
export function hasWebGpu(): Promise<boolean> {
  return (gpu ??= (async () => {
    try {
      const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } };
      return !!(await nav.gpu?.requestAdapter());
    } catch {
      return false;
    }
  })());
}

/** A model ready to run. */
export interface LoadedModel {
  /** File name or URL, for messages. */
  name: string;
  session: InferenceSession;
  /** The model's own metadata (`metadata_props`). */
  metadata: Record<string, string>;
  backend: Backend;
}

/** Loaded models by URL or file, so a model is read and compiled once. */
const loaded = new Map<string, Promise<LoadedModel>>();

/** The key of a file among loaded models. */
const fileKey = (file: File) => `file:${file.name}:${file.size}:${file.lastModified}`;

/** The bytes of a model at `url`, reporting progress (0–1) when the server gives the length. */
export async function fetchModel(url: string, onProgress?: (done: number) => void): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} を読めませんでした（HTTP ${response.status}）`);
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body || !total || !onProgress) return new Uint8Array(await response.arrayBuffer());
  const out = new Uint8Array(total);
  let at = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (at + value.length > out.length) return new Uint8Array(await new Blob([out.subarray(0, at), value]).arrayBuffer());
    out.set(value, at);
    at += value.length;
    onProgress(at / total);
  }
  return out.subarray(0, at);
}

/** A session for model `bytes`: on WebGPU when there is one (falling back to the CPU if the model cannot run there). */
export async function createModel(bytes: Uint8Array, name: string, useGpu = true): Promise<LoadedModel> {
  const runtime = await loadOrt();
  const metadata = onnxMetadata(bytes);
  if (useGpu && (await hasWebGpu())) {
    try {
      const session = await runtime.InferenceSession.create(bytes, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
      return { name, session, metadata, backend: 'webgpu' };
    } catch {
      // Some models use operators WebGPU does not have: the CPU runs everything.
    }
  }
  const session = await runtime.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  return { name, session, metadata, backend: 'wasm' };
}

/** The model at `url` or in `file`, loaded once per page. */
export function modelFrom(source: string | File, onProgress?: (done: number) => void): Promise<LoadedModel> {
  const key = typeof source === 'string' ? new URL(source, location.href).href : fileKey(source);
  let model = loaded.get(key);
  if (!model) {
    model = (async () => {
      const bytes = typeof source === 'string' ? await fetchModel(key, onProgress) : new Uint8Array(await source.arrayBuffer());
      return createModel(bytes, typeof source === 'string' ? source : source.name);
    })();
    // A failed load is tried again next time.
    model.catch(() => loaded.delete(key));
    loaded.set(key, model);
  }
  return model;
}

/** A float32 tensor. */
export async function tensor(data: Float32Array, dims: number[]): Promise<Tensor> {
  const runtime = await loadOrt();
  return new runtime.Tensor('float32', data, dims);
}

/** The name of `session`'s input or output called `wanted`, else its `index`-th. */
export function nameOf(names: readonly string[], wanted: string, index: number): string {
  return names.includes(wanted) ? wanted : names[index];
}

/** A short name of the backend, for messages. */
export const backendLabel = (backend: Backend): string => (backend === 'webgpu' ? 'GPU（WebGPU）' : 'CPU（WebAssembly）');
