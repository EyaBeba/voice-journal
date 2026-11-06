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

// Models used by earlier versions of the app, mapped to their word-timing equivalents.
export const LEGACY_MODELS = {
  'Xenova/whisper-tiny.en': 'onnx-community/whisper-tiny.en_timestamped',
  'Xenova/whisper-base.en': 'onnx-community/whisper-base.en_timestamped',
  'Xenova/whisper-small.en': 'onnx-community/whisper-small.en_timestamped',
};

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
  return call({ type: 'load', model, dtype: MODELS[model].dtype }, [], (p) => {
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
  return call({ type: 'transcribe', model, dtype: MODELS[model].dtype, audio }, [audio.buffer]);
  // resolves to { text, words: [{ w, s, e }] } (times in seconds)
}
