// Runs Whisper in a background thread so the UI stays responsive.
// The library and its WebAssembly engine are bundled in ./vendor; model weights are
// downloaded once from Hugging Face and kept in the browser's Cache Storage for offline use.
import { pipeline, env } from './vendor/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', self.location.href).href;
env.backends.onnx.wasm.proxy = false;

let asr = null;
let loadedModel = null;
let loading = null;

async function load(model, dtype) {
  if (asr && loadedModel === model) return asr;
  if (loading?.model === model) return loading.promise;
  const promise = (async () => {
    if (asr) { await asr.dispose?.(); asr = null; loadedModel = null; }
    const p = await pipeline('automatic-speech-recognition', model, {
      dtype,
      device: 'wasm',
      progress_callback: (info) => {
        if (info.status === 'progress') {
          self.postMessage({ type: 'progress', file: info.file, loaded: info.loaded, total: info.total });
        }
      },
    });
    asr = p;
    loadedModel = model;
    return p;
  })();
  loading = { model, promise };
  try {
    return await promise;
  } finally {
    loading = null;
  }
}

self.onmessage = async ({ data }) => {
  const { type, reqId } = data;
  try {
    if (type === 'load') {
      await load(data.model, data.dtype);
      self.postMessage({ type: 'done', reqId });
    } else if (type === 'transcribe') {
      const p = await load(data.model, data.dtype);
      const out = await p(data.audio, { chunk_length_s: 30, stride_length_s: 5 });
      const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text || '').trim();
      self.postMessage({ type: 'done', reqId, text });
    }
  } catch (err) {
    self.postMessage({ type: 'error', reqId, message: err?.message || String(err) });
  }
};
