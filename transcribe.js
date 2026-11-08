// Main-thread side of offline transcription: model choice, audio decoding and a
// one-at-a-time job queue that talks to transcriber.worker.js.
// "_timestamped" exports include the attention outputs Whisper needs to time every word.
export const MODELS = {
  'onnx-community/whisper-tiny.en_timestamped': {
    label: 'Tiny', size: '~65 MB', note: 'Fastest, least accurate',
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
  },
  'onnx-community/whisper-base.en_timestamped': {
    label: 'Base', size: '~80 MB', note: 'Good balance',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
  },
  'onnx-community/whisper-small.en_timestamped': {
    label: 'Small', size: '~250 MB', note: 'Most accurate, slow, needs a recent phone',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
  },
};
export const DEFAULT_MODEL = 'onnx-community/whisper-base.en_timestamped';

// Bigger models used by the "Improve" button. Turbo is Whisper's best model; it is only
// fast enough on a phone's graphics chip (WebGPU), so it runs there or not at all.
export const IMPROVE_MODELS = {
  small: {
    id: 'onnx-community/whisper-small.en_timestamped', label: 'Small', size: '~250 MB',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, device: 'wasm',
  },
  turbo: {
    id: 'onnx-community/whisper-large-v3-turbo_timestamped', label: 'Turbo', size: '~760 MB',
    dtype: { encoder_model: 'q4', decoder_model_merged: 'q4' }, device: 'webgpu', multilingual: true,
  },
};
const EXTRA = Object.fromEntries(Object.values(IMPROVE_MODELS).map((m) => [m.id, m]));

// Models used by earlier versions of the app, mapped to their word-timing equivalents.
// They still work (with sentence timing only), so a phone that has one can transcribe offline.
export const LEGACY_MODELS = {
  'Xenova/whisper-tiny.en': 'onnx-community/whisper-tiny.en_timestamped',
  'Xenova/whisper-base.en': 'onnx-community/whisper-base.en_timestamped',
  'Xenova/whisper-small.en': 'onnx-community/whisper-small.en_timestamped',
};

const ALL_MODELS = [...new Set([...Object.keys(MODELS), ...Object.keys(EXTRA), ...Object.keys(LEGACY_MODELS)])];

/** The current model a (possibly old) model id corresponds to. */
export const currentModelFor = (id) => (MODELS[id] ? id : LEGACY_MODELS[id] || DEFAULT_MODEL);
const infoFor = (id) => EXTRA[id] || MODELS[currentModelFor(id)];
const dtypeFor = (id) => infoFor(id).dtype;
const deviceFor = (id) => (EXTRA[id]?.device) || 'wasm';
const hasWordTiming = (id) => !!MODELS[id] || !!EXTRA[id];

/**
 * Can this phone run models on its graphics chip (WebGPU)? Checks for a GPU adapter
 * with enough memory for Turbo. The real test is the first Turbo transcription.
 */
export async function gpuSupport() {
  if (!('gpu' in navigator)) return { ok: false, reason: 'This browser has no WebGPU (needs Chrome 121+ on Android 12+).' };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: 'WebGPU is present, but no usable graphics chip was found on this phone.' };
    const maxBuffer = adapter.limits.maxBufferSize;
    if (maxBuffer < 256 * 1024 * 1024) return { ok: false, reason: 'The graphics chip has too little memory for Turbo.' };
    const info = adapter.info || {};
    return { ok: true, reason: `Graphics chip found${info.vendor ? ` (${info.vendor})` : ''}. Turbo should run on it.` };
  } catch (err) {
    return { ok: false, reason: `WebGPU check failed: ${err.message || err}` };
  }
}

/** Models whose files are already saved on this device (usable offline). */
export async function downloadedModels() {
  try {
    if (!(await caches.has('transformers-cache'))) return [];
    const urls = (await (await caches.open('transformers-cache')).keys()).map((r) => r.url);
    return ALL_MODELS.filter((id) => {
      const mine = urls.filter((u) => u.includes(`/${id}/resolve/`));
      return mine.some((u) => u.includes('/encoder_model')) && mine.some((u) => u.includes('/decoder_model_merged'));
    });
  } catch {
    return [];
  }
}

let worker = null;
let nextReq = 1;
const pending = new Map(); // reqId -> { resolve, reject, onProgress }

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./transcriber.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      for (const job of pending.values()) job.onProgress?.(data);
      return;
    }
    const job = pending.get(data.reqId);
    if (!job) return;
    pending.delete(data.reqId);
    if (data.type === 'done') job.resolve(data.result);
    else job.reject(new Error(data.message));
  };
  worker.onerror = (ev) => {
    const err = new Error(ev.message || 'Transcription worker crashed');
    for (const job of pending.values()) job.reject(err);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function call(msg, transfer = [], onProgress) {
  return new Promise((resolve, reject) => {
    const reqId = nextReq++;
    pending.set(reqId, { resolve, reject, onProgress });
    getWorker().postMessage({ ...msg, reqId }, transfer);
  });
}

/** Download (or load from cache) a model. onProgress(fraction 0..1). */
export function loadModel(model, onProgress) {
  const files = new Map();
  return call({ type: 'load', model, dtype: dtypeFor(model), device: deviceFor(model) }, [], (p) => {
    if (!p.total) return;
    files.set(p.file, p);
    let loaded = 0; let total = 0;
    for (const f of files.values()) { loaded += f.loaded; total += f.total; }
    onProgress?.(total ? loaded / total : 0);
  });
}

/** Decode any recorded audio into 16 kHz mono samples, which Whisper expects. */
async function decodeTo16kMono(arrayBuffer) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(1, 1, 16000);
  const buf = await ctx.decodeAudioData(arrayBuffer.slice(0));
  if (buf.numberOfChannels === 1) return buf.getChannelData(0).slice();
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i] / buf.numberOfChannels;
  }
  return out;
}

export async function transcribe(model, audioArrayBuffer) {
  const audio = await decodeTo16kMono(audioArrayBuffer);
  const timestamps = hasWordTiming(model) ? 'word' : true;
  const language = EXTRA[model]?.multilingual ? 'english' : undefined;
  return call({ type: 'transcribe', model, dtype: dtypeFor(model), device: deviceFor(model), language, timestamps, audio }, [audio.buffer]);
  // resolves to { text, words: [{ w, s, e }] | null, segments: [{ t, s, e }] | null } (seconds)
}
