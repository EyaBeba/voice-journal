import * as db from './db.js';
import { newEncryptionRecord, unlockKey } from './crypt.js';
import { createZip, readZip } from './zip.js';
import { PROMPTS, PACKS } from './prompts.js';
import { MODELS, DEFAULT_MODEL, LEGACY_MODELS, IMPROVE_MODELS, currentModelFor, downloadedModels, gpuSupport, loadModel, transcribe } from './transcribe.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const MOODS = [
  { v: 1, e: '😞', l: 'Awful' },
  { v: 2, e: '😕', l: 'Low' },
  { v: 3, e: '😐', l: 'Okay' },
  { v: 4, e: '🙂', l: 'Good' },
  { v: 5, e: '😄', l: 'Great' },
];
const moodOf = (v) => MOODS.find((m) => m.v === v);
const AUTO_LOCK_MS = 60_000;
const APP_VERSION = 13;
const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.5"/><rect x="14" y="5" width="4" height="14" rx="1.5"/></svg>';
const STAR_ICON = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>';
const SPEEDS = [1, 1.25, 1.5, 2];
const EDIT_ICON = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>';

const state = {
  entries: [],
  filterDay: null,
  calMonth: startOfMonth(new Date()),
  promptShift: 0,
  editing: null, // { id, isNew, prompt }
  editorUrl: null,
  hasPin: false,
  hiddenAt: 0,
  tx: { enabled: false, auto: true, model: DEFAULT_MODEL }, // saved transcription settings
  txQueue: [], // entry ids waiting to be transcribed
  txBusy: false,
  txDownload: null, // 0..1 while a model is downloading
  txOverride: new Map(), // entry id -> model id for "Improve" runs
  micId: '', // chosen microphone deviceId ('' = automatic)
  wordFixes: [], // [{ from, to }] applied to new transcripts
};

/* ---------- helpers ---------- */
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtTotal(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
function fmtBytes(n) {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
function fmtDayHeading(key) {
  const today = dayKey(Date.now());
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (key === today) return 'Today';
  if (key === dayKey(y)) return 'Yesterday';
  return new Date(`${key}T12:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}
const fmtTime = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parseTags = (s) => [...new Set(s.split(',').map((t) => t.trim().toLowerCase().replace(/^#/, '')).filter(Boolean))];
const blobOf = (e) => new Blob([e.audio], { type: e.mime });
function extFor(mime) {
  if (/mp4|aac|m4a/.test(mime)) return 'm4a';
  if (/ogg/.test(mime)) return 'ogg';
  if (/wav/.test(mime)) return 'wav';
  return 'webm';
}
function allTags() {
  const counts = new Map();
  for (const e of state.entries) for (const t of e.tags) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2800);
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) return await navigator.storage.persist();
    return true;
  } catch { return false; }
}

/* ---------- streaks ---------- */
function streaks(entries) {
  const days = new Set(entries.map((e) => dayKey(e.createdAt)));
  let current = 0;
  const d = new Date();
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1); // today not done yet: streak still alive from yesterday
  while (days.has(dayKey(d))) { current++; d.setDate(d.getDate() - 1); }

  let longest = 0; let run = 0; let prev = null;
  for (const key of [...days].sort()) {
    const t = new Date(`${key}T12:00`);
    run = prev && Math.round((t - prev) / 86_400_000) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = t;
  }
  return { current, longest, days: days.size };
}

function renderStreakBadge() {
  const { current } = streaks(state.entries);
  const badge = $('#streak-badge');
  badge.textContent = current ? `${current}-day streak` : 'Begin today';
  badge.title = `${current}-day streak`;
}

/* ---------- navigation ---------- */
function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.tabs button').forEach((b) => b.setAttribute('aria-current', b.dataset.view === name ? 'page' : 'false'));
  if (name === 'record') renderRecent();
  if (name === 'journal') renderJournal();
  if (name === 'calendar') renderCalendar();
  if (name === 'settings') renderSettings();
  window.scrollTo({ top: 0 });
}

function rerenderActive() {
  renderStreakBadge();
  renderBackupBanner();
  renderRecapBanner();
  const active = $('.view.active')?.id.replace('view-', '');
  if (active === 'record') renderRecent();
  if (active === 'journal') renderJournal();
  if (active === 'calendar') renderCalendar();
  if (active === 'settings') renderSettings();
}

/* ---------- prompts ---------- */
function promptPool() {
  const packs = state.promptPacks || Object.keys(PACKS);
  const pool = [...packs.flatMap((k) => PACKS[k]?.prompts || []), ...(state.customPrompts || [])];
  return pool.length ? pool : PROMPTS;
}

function todaysPrompt() {
  const now = new Date();
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86_400_000);
  const pool = promptPool();
  // Spread through the pool so neighbouring days don't pull from the same pack.
  return pool[((dayOfYear * 7) + state.promptShift) % pool.length];
}

function renderPromptSettings() {
  const packs = state.promptPacks || Object.keys(PACKS);
  $('#prompt-packs').innerHTML = Object.entries(PACKS).map(([key, pack]) => `
    <label class="check pack"><input type="checkbox" data-pack="${key}" ${packs.includes(key) ? 'checked' : ''}>
      <span>${esc(pack.label)} <small class="muted">${pack.prompts.length}</small></span></label>`).join('');
  $('#custom-prompt-list').innerHTML = (state.customPrompts || []).map((text, i) => `
    <li><span>${esc(text)}</span><button class="icon-btn" type="button" data-remove-prompt="${i}" aria-label="Remove prompt">&times;</button></li>`).join('');
}

async function savePromptSettings() {
  await db.setMeta('promptPacks', state.promptPacks);
  await db.setMeta('customPrompts', state.customPrompts);
  state.promptShift = 0;
  renderPrompt();
  renderPromptSettings();
}
const renderPrompt = () => { $('#prompt-text').textContent = todaysPrompt(); };

/* ---------- recording ---------- */
const rec = { mr: null, stream: null, chunks: [], start: 0, timer: null, ctx: null, analyser: null, raf: 0, peak: 0, frames: 0, pausedMs: 0, pauseAt: null };
/** Recorded time so far, not counting pauses. */
const recElapsed = () => (rec.pauseAt ?? Date.now()) - rec.start - rec.pausedMs;

function togglePause() {
  if (!rec.mr) return;
  if (rec.mr.state === 'recording') {
    rec.mr.pause();
    rec.pauseAt = Date.now();
  } else if (rec.mr.state === 'paused') {
    rec.pausedMs += Date.now() - rec.pauseAt;
    rec.pauseAt = null;
    rec.mr.resume();
  }
  const paused = rec.mr.state === 'paused';
  $('#pause-btn').textContent = paused ? 'Resume' : 'Pause';
  $('#rec-btn').classList.toggle('paused', paused);
  $('#rec-hint').textContent = paused ? 'Paused · tap Resume, or the button to finish' : 'Recording… tap to stop';
}

function pickMime() {
  const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];
  return types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast('This browser cannot record audio.');
    return;
  }
  // Echo cancellation switches Android into phone-call audio mode, which hands the
  // microphone to a connected Bluetooth device (watch, earbuds). We don't need it.
  const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: true };
  try {
    try {
      rec.stream = await navigator.mediaDevices.getUserMedia({
        audio: state.micId ? { ...base, deviceId: { exact: state.micId } } : base,
      });
    } catch (err) {
      if (!state.micId || err.name === 'NotAllowedError') throw err;
      toast('The chosen microphone is not available, using the default one.');
      rec.stream = await navigator.mediaDevices.getUserMedia({ audio: base });
    }
  } catch {
    toast('Microphone access was blocked. Allow it in your browser settings.');
    return;
  }
  rec.peak = 0;
  rec.frames = 0;
  const mime = pickMime();
  rec.mr = new MediaRecorder(rec.stream, mime ? { mimeType: mime } : undefined);
  rec.chunks = [];
  // Crash-safe: every second of audio is also written to the phone's storage, so a crash,
  // a call or a dead battery can't lose the note. It is recovered on the next launch.
  rec.draftId = uid();
  rec.seq = 0;
  rec.saveChain = Promise.resolve();
  rec.mr.ondataavailable = (e) => {
    if (!e.data.size) return;
    rec.chunks.push(e.data);
    const { draftId } = rec;
    const seq = rec.seq++;
    rec.saveChain = rec.saveChain
      .then(() => e.data.arrayBuffer())
      .then((buf) => db.putChunk(draftId, seq, buf))
      .catch((err) => console.warn('Could not save audio piece', err));
  };
  rec.mr.onstop = onRecordingStop;
  rec.mr.start(1000);
  rec.start = Date.now();
  rec.pausedMs = 0;
  rec.pauseAt = null;
  $('#pause-btn').hidden = !('pause' in rec.mr);
  $('#pause-btn').textContent = 'Pause';
  db.setMeta('draft', { id: rec.draftId, start: rec.start, mime: rec.mr.mimeType || mime || 'audio/webm', prompt: todaysPrompt() })
    .catch(() => {});
  // If the mic is taken away (a phone call, Bluetooth change), keep what was recorded.
  rec.stream.getAudioTracks().forEach((track) => {
    track.addEventListener('ended', () => {
      if (rec.mr && rec.mr.state !== 'inactive') {
        toast('Recording was interrupted. What you said so far is saved.');
        stopRecording();
      }
    });
  });
  keepScreenOn(true);

  const btn = $('#rec-btn');
  btn.classList.add('recording');
  btn.setAttribute('aria-label', 'Stop recording');
  $('#rec-hint').textContent = 'Recording… tap to stop';
  $('#timer').textContent = '0:00';
  rec.timer = setInterval(() => { $('#timer').textContent = fmtDuration(recElapsed()); }, 250);

  try {
    rec.ctx = new (window.AudioContext || window.webkitAudioContext)();
    rec.ctx.resume?.().catch(() => {});
    rec.analyser = rec.ctx.createAnalyser();
    rec.analyser.fftSize = 1024;
    rec.ctx.createMediaStreamSource(rec.stream).connect(rec.analyser);
    drawLiveWave();
  } catch { /* visualiser is optional */ }
}

function stopRecording() {
  if (rec.mr && rec.mr.state !== 'inactive') rec.mr.stop();
}

/* Keep the screen awake while recording, so the phone doesn't sleep mid-sentence. */
let wakeLock = null;
async function keepScreenOn(on) {
  try {
    if (on && navigator.wakeLock && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not supported or not allowed right now */ }
}

/** Turn audio saved during an interrupted recording back into a journal entry. */
async function recoverDraft() {
  const draft = await db.getMeta('draft');
  if (!draft || rec.mr) return;
  try {
    if (!state.entries.some((e) => e.id === draft.id)) {
      const pieces = await db.getChunks(draft.id);
      if (pieces.length) {
        const entry = {
          id: draft.id, createdAt: draft.start, durationMs: pieces.length * 1000, mime: draft.mime,
          title: '', mood: null, tags: [], prompt: draft.prompt || null, recovered: true,
          transcript: '', transcriptStatus: state.tx.enabled && state.tx.auto ? 'queued' : null,
          audio: await new Blob(pieces, { type: draft.mime }).arrayBuffer(),
        };
        await db.putEntry(entry);
        state.entries.unshift(entry);
        state.entries.sort((a, b) => b.createdAt - a.createdAt);
        toast('Recovered a recording that was interrupted.');
        if (entry.transcriptStatus === 'queued') queueTranscription(entry);
      }
    }
    await db.deleteChunks(draft.id);
    await db.deleteMeta('draft');
  } catch (err) {
    console.warn('Could not recover recording', err);
  }
}

function cleanupRecorder() {
  keepScreenOn(false);
  $('#pause-btn').hidden = true;
  $('#rec-btn').classList.remove('paused');
  rec.pauseAt = null;
  clearInterval(rec.timer);
  cancelAnimationFrame(rec.raf);
  rec.stream?.getTracks().forEach((t) => t.stop());
  rec.ctx?.close().catch(() => {});
  Object.assign(rec, { stream: null, ctx: null, analyser: null, mr: null });
  const btn = $('#rec-btn');
  btn.classList.remove('recording');
  btn.setAttribute('aria-label', 'Start recording');
  $('#rec-hint').textContent = 'Tap to start recording';
  $('#timer').textContent = '0:00';
  drawIdleWave();
}

async function onRecordingStop() {
  const durationMs = recElapsed();
  const type = rec.mr?.mimeType || 'audio/webm';
  const blob = new Blob(rec.chunks, { type });
  const start = rec.start;
  const draftId = rec.draftId;
  const saved = rec.saveChain;
  // Peak is 0..128. Near zero for the whole recording means the mic sent silence.
  const silent = rec.frames > 10 && rec.peak <= 2;
  cleanupRecorder();
  const clearDraft = () => saved.then(() => db.deleteChunks(draftId)).then(() => db.deleteMeta('draft')).catch(() => {});
  if (!blob.size || durationMs < 500) { toast('Too short, nothing saved.'); clearDraft(); return; }

  // Save immediately so nothing is lost; details are added afterwards.
  const entry = {
    id: draftId, createdAt: start, durationMs, mime: type,
    title: '', mood: null, tags: [], prompt: todaysPrompt(),
    transcript: '', transcriptStatus: state.tx.enabled && state.tx.auto ? 'queued' : null,
    audio: await blob.arrayBuffer(),
  };
  try {
    await db.putEntry(entry);
  } catch (err) {
    // The audio pieces stay saved and will be recovered next time the app opens.
    toast(`Could not save: ${err.message || err}`);
    return;
  }
  clearDraft();
  state.entries.unshift(entry);
  requestPersistence();
  rerenderActive();
  openEditor(entry, true);
  if (silent) {
    $('#silence-warning').hidden = false;
    refreshMics();
  }
  if (entry.transcriptStatus === 'queued') queueTranscription(entry);
}

/* ---------- waveform ---------- */
function sizeCanvas() {
  const c = $('#wave');
  const dpr = window.devicePixelRatio || 1;
  c.width = c.clientWidth * dpr;
  c.height = c.clientHeight * dpr;
  return c;
}
const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();

function drawIdleWave() {
  const c = sizeCanvas();
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  g.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--border').trim();
  g.lineWidth = 1 * (window.devicePixelRatio || 1);
  g.beginPath();
  g.moveTo(0, c.height / 2);
  g.lineTo(c.width, c.height / 2);
  g.stroke();
}

function drawLiveWave() {
  const c = sizeCanvas();
  const g = c.getContext('2d');
  const data = new Uint8Array(rec.analyser.fftSize);
  const color = accent();
  const dpr = window.devicePixelRatio || 1;
  const frame = () => {
    if (!rec.analyser) return;
    rec.analyser.getByteTimeDomainData(data);
    if (rec.ctx.state === 'running') {
      rec.frames++;
      for (let i = 0; i < data.length; i++) rec.peak = Math.max(rec.peak, Math.abs(data[i] - 128));
    }
    g.clearRect(0, 0, c.width, c.height);
    g.strokeStyle = color;
    g.lineWidth = 2.5 * dpr;
    g.lineJoin = 'round';
    g.beginPath();
    const step = c.width / data.length;
    for (let i = 0; i < data.length; i++) {
      const y = (data[i] / 255) * c.height;
      if (i === 0) g.moveTo(0, y); else g.lineTo(i * step, y);
    }
    g.stroke();
    rec.raf = requestAnimationFrame(frame);
  };
  frame();
}

/* ---------- playback ---------- */
const player = { audio: new Audio(), id: null, url: null, pendingSeek: null, fixingDuration: false };

function stopPlayer() {
  player.audio.pause();
  if (player.url) URL.revokeObjectURL(player.url);
  Object.assign(player, { id: null, url: null, pendingSeek: null, fixingDuration: false });
  syncPlayerUI();
}

function startPlayer(id) {
  stopPlayer();
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) return false;
  player.url = URL.createObjectURL(blobOf(entry));
  player.audio.src = player.url;
  player.audio.playbackRate = readSpeed();
  player.audio.defaultPlaybackRate = player.audio.playbackRate;
  player.id = id;
  return true;
}

function togglePlay(id) {
  const entry = state.entries.find((e) => e.id === id);
  const start = entry?.trimStart || 0;
  if (player.id === id) {
    if (player.audio.paused) {
      // finished (or past the trimmed end): start again from the beginning
      if (player.audio.ended || (entry?.trimEnd && player.audio.currentTime >= entry.trimEnd - 0.05)) player.audio.currentTime = start;
      player.audio.play().catch(() => toast("Couldn't play this recording."));
    } else {
      player.audio.pause();
    }
    return;
  }
  if (start > 0) { seekTo(id, start); return; }
  if (startPlayer(id)) player.audio.play().catch(() => toast("Couldn't play this recording."));
}

function readSpeed() {
  try { return Number(localStorage.getItem('vj-speed')) || 1; } catch { return 1; }
}

function cycleSpeed() {
  const next = SPEEDS[(SPEEDS.indexOf(player.audio.playbackRate) + 1) % SPEEDS.length] || 1;
  player.audio.playbackRate = next;
  player.audio.defaultPlaybackRate = next;
  try { localStorage.setItem('vj-speed', String(next)); } catch { /* fine */ }
  $$('.speed-btn').forEach((b) => { b.textContent = `${next}×`; });
}

/** Seconds of a note that actually play, after trimming. */
function playLength(e) {
  const end = e.trimEnd ?? e.durationMs / 1000;
  return Math.max(0, end - (e.trimStart || 0));
}

/** Jump to a moment in a note (seconds) and play from there. */
function seekTo(id, seconds) {
  if (player.id !== id && !startPlayer(id)) return;
  syncPlayerUI();
  if (player.fixingDuration || !Number.isFinite(player.audio.duration)) {
    player.pendingSeek = seconds; // applied once the browser knows the length
  } else {
    player.audio.currentTime = seconds;
  }
  player.audio.play().catch(() => toast("Couldn't play this recording."));
}

// Recordings from MediaRecorder often have no length in their header, which breaks
// seeking. Asking for a far-away time makes the browser work out the real length.
player.audio.addEventListener('loadedmetadata', () => {
  if (player.audio.duration === Infinity) {
    player.fixingDuration = true;
    player.audio.currentTime = 1e101;
  }
});
player.audio.addEventListener('durationchange', () => {
  if (player.fixingDuration && Number.isFinite(player.audio.duration)) {
    player.fixingDuration = false;
    player.audio.currentTime = player.pendingSeek ?? 0;
    player.pendingSeek = null;
  }
});
player.audio.addEventListener('seeked', () => {
  if (!player.fixingDuration && player.pendingSeek !== null && Number.isFinite(player.audio.duration)) {
    const t = player.pendingSeek;
    player.pendingSeek = null;
    player.audio.currentTime = t;
  }
});

function syncPlayerUI() {
  $$('.entry').forEach((card) => {
    const active = card.dataset.id === player.id;
    const playing = active && !player.audio.paused;
    card.classList.toggle('playing', playing);
    card.classList.toggle('open', active);
    const btn = $('.play', card);
    const icon = playing ? 'pause' : 'play';
    if (btn.dataset.icon !== icon) { btn.innerHTML = playing ? PAUSE_ICON : PLAY_ICON; btn.dataset.icon = icon; }
    btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if (!active) $('.progress i', card).style.width = '0';

    const reader = $('.reader', card);
    if (active && !reader) {
      const entry = state.entries.find((e) => e.id === player.id);
      const html = readerHtml(entry);
      if (html) $('.entry-main .entry-meta', card).insertAdjacentHTML('afterend', html);
      follow.lastId = null; // transcript may have changed
    } else if (!active && reader) {
      reader.remove();
    }
  });
  highlightNow();
}

/* ---------- follow-along transcript ---------- */
/** Timed pieces of a transcript: exact from Whisper, or estimated from sentence length. */
function segmentsFor(entry) {
  if (!entry?.transcript?.trim()) return [];
  const dur = (Number.isFinite(player.audio.duration) && player.id === entry.id ? player.audio.duration : entry.durationMs / 1000) || 0;
  if (Array.isArray(entry.segments) && entry.segments.length) {
    return entry.segments.map((seg, i, all) => ({
      t: seg.t,
      s: seg.s ?? 0,
      e: seg.e ?? all[i + 1]?.s ?? dur,
    }));
  }
  const parts = entry.transcript.trim().match(/[^.!?]+[.!?]*["”']?\s*/g)?.map((p) => p.trim()).filter(Boolean)
    || [entry.transcript.trim()];
  const total = parts.reduce((n, p) => n + p.length, 0);
  let acc = 0;
  return parts.map((p) => {
    const seg = { t: p, s: (acc / total) * dur };
    acc += p.length;
    seg.e = (acc / total) * dur;
    return seg;
  });
}

/** Timed words: exact from Whisper, or spread across each sentence by length. */
function wordsFor(entry) {
  if (!entry?.transcript?.trim()) return [];
  if (Array.isArray(entry.words) && entry.words.length) {
    return entry.words.map((x, i, all) => ({ w: x.w.trim(), s: x.s, e: x.e ?? all[i + 1]?.s ?? x.s + 0.3 }));
  }
  const out = [];
  for (const seg of segmentsFor(entry)) {
    const ws = seg.t.split(/\s+/).filter(Boolean);
    const total = ws.reduce((n, w) => n + w.length + 1, 0);
    let acc = 0;
    for (const w of ws) {
      const s = seg.s + (acc / total) * (seg.e - seg.s);
      acc += w.length + 1;
      out.push({ w, s, e: seg.s + (acc / total) * (seg.e - seg.s) });
    }
  }
  return out;
}

function readerHtml(entry) {
  const words = wordsFor(entry);
  if (!words.length) {
    if (entry?.transcriptStatus === 'queued' || entry?.transcriptStatus === 'working') {
      return '<div class="reader empty-reader">Transcribing… the text appears here when it’s ready.</div>';
    }
    return '';
  }
  return `<div class="reader" aria-label="Transcript">${words.map((x, i) =>
    `<span class="seg" data-i="${i}" data-s="${x.s.toFixed(2)}" role="button" tabindex="0">${esc(x.w)}</span>`).join(' ')}</div>`;
}

const follow = { raf: 0, lastId: null, lastIndex: -2, words: [] };

function highlightNow() {
  if (!player.id) return;
  // The same note can appear on the Record and Journal screens; update every copy.
  const readers = $$(`.entry[data-id="${CSS.escape(player.id)}"] .reader`);
  if (!readers.length) return;
  if (follow.lastId !== player.id) {
    follow.words = wordsFor(state.entries.find((e) => e.id === player.id));
    follow.lastId = player.id;
    follow.lastIndex = -2;
  }
  const t = player.fixingDuration ? 0 : player.audio.currentTime;
  let now = -1;
  // The word being spoken is the last one whose start time has passed.
  for (let i = 0; i < follow.words.length && follow.words[i].s <= t + 0.02; i++) now = i;
  if (player.audio.ended) now = -1;
  const fresh = readers.some((r) => !r.dataset.painted);
  if (now === follow.lastIndex && !fresh) return;
  follow.lastIndex = now;
  for (const reader of readers) {
    reader.dataset.painted = '1';
    $$('.seg', reader).forEach((el, i) => {
      el.classList.toggle('now', i === now);
      el.classList.toggle('past', i < now);
    });
    const active = $('.seg.now', reader);
    if (active && !player.audio.paused && reader.offsetParent) {
      const r = active.getBoundingClientRect();
      if (r.bottom > window.innerHeight - 110 || r.top < 120) active.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

// Smooth word-by-word tracking: check every frame while audio plays.
function followLoop() {
  cancelAnimationFrame(follow.raf);
  const tick = () => {
    highlightNow();
    if (!player.audio.paused && !player.audio.ended) follow.raf = requestAnimationFrame(tick);
  };
  tick();
}
player.audio.addEventListener('playing', followLoop);
player.audio.addEventListener('seeked', () => { follow.lastIndex = -2; highlightNow(); });
player.audio.addEventListener('emptied', () => { follow.lastId = null; });

player.audio.addEventListener('play', syncPlayerUI);
player.audio.addEventListener('pause', syncPlayerUI);
player.audio.addEventListener('ended', () => { syncPlayerUI(); });
player.audio.addEventListener('timeupdate', () => {
  if (player.fixingDuration) return;
  const entry = state.entries.find((e) => e.id === player.id);
  // stop at the trimmed end
  if (entry?.trimEnd && player.audio.currentTime >= entry.trimEnd && !player.audio.paused) player.audio.pause();
  if (!entry) return;
  // Recorded webm can report duration=Infinity, so fall back to the duration we measured.
  const total = Number.isFinite(player.audio.duration) ? player.audio.duration * 1000 : entry.durationMs;
  const width = `${Math.min(100, (player.audio.currentTime * 1000 / total) * 100)}%`;
  $$(`.entry[data-id="${CSS.escape(player.id)}"] .progress i`).forEach((bar) => { bar.style.width = width; });
  highlightNow();
});

/* ---------- entry list ---------- */
function entryCard(e) {
  const mood = moodOf(e.mood);
  return `
    <article class="entry" data-id="${esc(e.id)}">
      <button class="play" type="button" data-action="play" aria-label="Play" data-icon="play">${PLAY_ICON}</button>
      <div class="entry-main">
        <div class="entry-title">${esc(e.title || 'Untitled entry')}</div>
        <div class="entry-meta">${fmtTime(e.createdAt)} · ${fmtDuration(playLength(e) * 1000)}${e.recovered ? ' · recovered' : ''}</div>
        ${transcriptLine(e)}
        ${e.prompt ? `<div class="entry-prompt">“${esc(e.prompt)}”</div>` : ''}
        ${e.tags.length ? `<div class="entry-tags">${e.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : ''}
        ${e.photos?.length ? `<div class="entry-photos">${e.photos.slice(0, 4).map((p, i) =>
          `<button type="button" class="thumb" data-action="photo" data-photo="${i}" aria-label="Open photo ${i + 1}"><img src="${photoUrl(p)}" alt="" loading="lazy"></button>`).join('')}${e.photos.length > 4 ? `<span class="more-photos">+${e.photos.length - 4}</span>` : ''}</div>` : ''}
        <div class="progress"><i></i></div>
      </div>
      <div class="entry-actions">
        <span class="entry-mood" title="${mood ? mood.l : 'No mood'}">${mood ? mood.e : ''}</span>
        <button class="icon-btn star-btn${e.starred ? ' on' : ''}" type="button" data-action="star" aria-pressed="${!!e.starred}" aria-label="${e.starred ? 'Remove from favorites' : 'Add to favorites'}">${STAR_ICON}</button>
        <button class="icon-btn" type="button" data-action="edit" aria-label="Edit entry">${EDIT_ICON}</button>
        <button class="speed-btn" type="button" data-action="speed" aria-label="Playback speed">${readSpeed()}×</button>
      </div>
    </article>`;
}

function transcriptLine(e) {
  if (e.summary) return `<div class="entry-transcript entry-summary">${esc(e.summary)}</div>`;
  if (e.transcript) return `<div class="entry-transcript">${esc(e.transcript)}</div>`;
  if (e.transcriptStatus === 'working') return '<div class="entry-status">✍️ Transcribing…</div>';
  if (e.transcriptStatus === 'queued') return '<div class="entry-status">✍️ Waiting to transcribe…</div>';
  if (e.transcriptStatus === 'error') return '<div class="entry-status error">Transcription failed. Open the entry to retry.</div>';
  return '';
}

function renderList(container, entries, emptyHtml) {
  if (!entries.length) { container.innerHTML = emptyHtml; return; }
  let html = '';
  let lastDay = null;
  for (const e of entries) {
    const key = dayKey(e.createdAt);
    if (key !== lastDay) { html += `<h3 class="day-heading">${fmtDayHeading(key)}</h3>`; lastDay = key; }
    html += entryCard(e);
  }
  container.innerHTML = html;
  syncPlayerUI();
}

/** "On this day": a note from a week, a month or a year ago today. */
function renderOnThisDay() {
  const box = $('#on-this-day');
  const now = new Date();
  const back = [
    ['One year ago today', new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())],
    ['One month ago today', new Date(now.getFullYear(), now.getMonth() - 1, now.getDate())],
    ['One week ago today', new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7)],
  ];
  for (const [label, date] of back) {
    const key = dayKey(date);
    const e = state.entries.find((x) => dayKey(x.createdAt) === key);
    if (e) {
      box.innerHTML = `<div class="otd"><span class="eyebrow">${label}</span>${entryCard(e)}</div>`;
      box.hidden = false;
      syncPlayerUI();
      return;
    }
  }
  box.hidden = true;
  box.innerHTML = '';
}

function renderRecent() {
  renderOnThisDay();
  const today = dayKey(Date.now());
  const list = state.entries.filter((e) => dayKey(e.createdAt) === today);
  renderList($('#recent'), list, '');
}

function renderJournal() {
  const moodSel = $('#filter-mood');
  if (!moodSel.options.length) {
    moodSel.innerHTML = `<option value="">All moods</option>${MOODS.map((m) => `<option value="${m.v}">${m.e} ${m.l}</option>`).join('')}`;
  }
  const tagSel = $('#filter-tag');
  const tags = allTags();
  const currentTag = tagSel.value;
  tagSel.innerHTML = `<option value="">All tags</option>${tags.map((t) => `<option value="${esc(t)}">#${esc(t)}</option>`).join('')}`;
  tagSel.value = tags.includes(currentTag) ? currentTag : '';

  const q = $('#search').value.trim().toLowerCase();
  const mood = Number(moodSel.value) || null;
  const tag = tagSel.value;
  const list = state.entries.filter((e) =>
    (!state.filterDay || dayKey(e.createdAt) === state.filterDay)
    && (!mood || e.mood === mood)
    && (!state.filterStarred || e.starred)
    && (!tag || e.tags.includes(tag))
    && (!q || [e.title, e.prompt, e.transcript, e.summary, ...e.tags].join(' ').toLowerCase().includes(q)));

  const chip = $('#day-chip');
  chip.hidden = !state.filterDay;
  if (state.filterDay) chip.textContent = `${fmtDayHeading(state.filterDay)} ✕`;

  const empty = state.entries.length
    ? '<div class="empty"><div class="big">🔍</div><p>No entries match these filters.</p></div>'
    : '<div class="empty"><div class="big">🎙️</div><p>No entries yet.<br>Record your first voice note on the Record tab.</p></div>';
  renderList($('#entry-list'), list, empty);
}

async function toggleStar(id) {
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) return;
  entry.starred = !entry.starred;
  await db.putEntry(entry);
  toast(entry.starred ? 'Added to favorites' : 'Removed from favorites');
  rerenderActive();
}

/* Photos: stored as JPEG bytes in the entry; object URLs are cached per photo. */
const photoUrls = new WeakMap();
function photoUrl(p) {
  if (!photoUrls.has(p.data)) photoUrls.set(p.data, URL.createObjectURL(new Blob([p.data], { type: p.type || 'image/jpeg' })));
  return photoUrls.get(p.data);
}

function openPhoto(p) {
  $('#photo-view img').src = photoUrl(p);
  $('#photo-view').showModal();
}

/** Shrink a picked image (max 1600px, JPEG) so photos don't eat the phone's storage. */
async function preparePhoto(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.82));
  return { type: 'image/jpeg', data: await blob.arrayBuffer() };
}

function renderEditorPhotos() {
  const photos = state.editing?.photos || [];
  $('#editor-photos').innerHTML = photos.map((p, i) => `
    <div class="thumb"><img src="${photoUrl(p)}" alt="">
      <button type="button" class="thumb-remove" data-remove-photo="${i}" aria-label="Remove photo">&times;</button></div>`).join('');
}

/* Trim (non-destructive: the full recording is kept, playback skips the trimmed parts). */
function setupTrim(entry) {
  const total = Math.max(0.5, entry.durationMs / 1000);
  const start = $('#trim-start');
  const end = $('#trim-end');
  for (const r of [start, end]) { r.max = total.toFixed(1); r.step = '0.1'; }
  start.value = entry.trimStart || 0;
  end.value = entry.trimEnd ?? total;
  updateTrimLabels();
}

function updateTrimLabels(changed) {
  const start = $('#trim-start');
  const end = $('#trim-end');
  if (Number(start.value) > Number(end.value) - 0.5) {
    if (changed === 'end') end.value = Math.min(Number(end.max), Number(start.value) + 0.5);
    else start.value = Math.max(0, Number(end.value) - 0.5);
  }
  $('#trim-start-label').textContent = fmtClock(Number(start.value));
  $('#trim-end-label').textContent = fmtClock(Number(end.value));
  $('#trim-length').textContent = `Plays ${fmtClock(Number(end.value) - Number(start.value))}`;
}

const fmtClock = (sec) => `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, '0')}`;

/** Find where speech starts and ends, so silence at either end can be trimmed. */
async function autoTrimSilence() {
  const entry = state.entries.find((e) => e.id === state.editing?.id);
  if (!entry) return;
  try {
    const ctx = new OfflineAudioContext(1, 1, 16000);
    const buf = await ctx.decodeAudioData(entry.audio.slice(0));
    const data = buf.getChannelData(0);
    const win = 800; // 50 ms at 16 kHz
    const levels = [];
    for (let i = 0; i < data.length; i += win) {
      let sum = 0;
      for (let j = i; j < Math.min(i + win, data.length); j++) sum += data[j] * data[j];
      levels.push(Math.sqrt(sum / win));
    }
    const peak = Math.max(...levels);
    const threshold = Math.max(0.01, peak * 0.12);
    const first = levels.findIndex((l) => l > threshold);
    const last = levels.length - 1 - [...levels].reverse().findIndex((l) => l > threshold);
    if (first < 0) { toast('No speech found to trim around.'); return; }
    const total = buf.duration;
    $('#trim-end').max = total.toFixed(1);
    $('#trim-start').max = total.toFixed(1);
    $('#trim-start').value = Math.max(0, first * 0.05 - 0.25).toFixed(1);
    $('#trim-end').value = Math.min(total, (last + 1) * 0.05 + 0.35).toFixed(1);
    updateTrimLabels();
    toast('Silence at the start and end marked. Save to keep it.');
  } catch (err) {
    toast(`Couldn't analyse this recording: ${err.message || err}`);
  }
}

function previewTrim() {
  const a = $('#editor-audio');
  const start = Number($('#trim-start').value);
  const end = Number($('#trim-end').value);
  a.currentTime = start;
  a.play().catch(() => {});
  const stop = () => { if (a.currentTime >= end) { a.pause(); a.removeEventListener('timeupdate', stop); } };
  a.addEventListener('timeupdate', stop);
}

function onListClick(ev) {
  const seg = ev.target.closest('.seg');
  if (seg) {
    seekTo(seg.closest('.entry').dataset.id, Number(seg.dataset.s));
    return;
  }
  const btn = ev.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.closest('.entry')?.dataset.id;
  if (btn.dataset.action === 'play') togglePlay(id);
  if (btn.dataset.action === 'speed') cycleSpeed();
  if (btn.dataset.action === 'star') toggleStar(id);
  if (btn.dataset.action === 'photo') {
    const entry = state.entries.find((e) => e.id === id);
    if (entry?.photos?.[btn.dataset.photo]) openPhoto(entry.photos[btn.dataset.photo]);
  }
  if (btn.dataset.action === 'edit') {
    const entry = state.entries.find((e) => e.id === id);
    if (entry) openEditor(entry, false);
  }
}

/* ---------- editor ---------- */
function renderMoodPicker() {
  $('#mood-picker').innerHTML = MOODS.map((m) => `
    <label><input type="radio" name="mood" value="${m.v}"><span>${m.e}<small>${m.l}</small></span></label>`).join('');
}

function renderTagSuggestions() {
  const input = $('#entry-form').elements.tags;
  const chosen = new Set(parseTags(input.value));
  const suggestions = allTags().filter((t) => !chosen.has(t)).slice(0, 12);
  $('#tag-suggestions').innerHTML = suggestions.map((t) => `<button class="chip" type="button" data-tag="${esc(t)}">#${esc(t)}</button>`).join('');
}

function openEditor(entry, isNew) {
  state.editing = { id: entry.id, isNew, prompt: entry.prompt, photos: [...(entry.photos || [])] };
  const f = $('#entry-form');
  renderEditorPhotos();
  setupTrim(entry);
  $('#trim-details').open = !!(entry.trimStart || entry.trimEnd);
  f.elements.entryTitle.value = entry.title || '';
  f.elements.tags.value = entry.tags.join(', ');
  $$('input[name="mood"]', f).forEach((r) => { r.checked = Number(r.value) === entry.mood; });
  $('#editor-prompt').hidden = !entry.prompt;
  $('#editor-prompt-text').textContent = entry.prompt || '';
  f.elements.usePrompt.checked = !!entry.prompt;
  f.elements.transcript.value = entry.transcript || '';
  state.editing.transcriptDirty = false;
  renderEditorTranscript(entry);

  if (state.editorUrl) URL.revokeObjectURL(state.editorUrl);
  state.editorUrl = URL.createObjectURL(blobOf(entry));
  $('#editor-audio').src = state.editorUrl;

  $('#silence-warning').hidden = true;
  $('#editor-heading').textContent = isNew ? 'Saved. Add some details?' : 'Edit entry';
  $('#editor-date').textContent = `${new Date(entry.createdAt).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })} · ${fmtDuration(entry.durationMs)}`;
  $('#discard-btn').textContent = isNew ? 'Discard recording' : 'Delete entry';
  renderTagSuggestions();
  $('#editor').showModal();
}

/* ---------- learn from your corrections ----------
   When you fix words in a transcript, find what changed and offer to fix it automatically. */
function wordDiff(before, after) {
  const tok = (x) => x.split(/\s+/).filter(Boolean);
  const norm = (w) => w.toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
  const a = tok(before).slice(0, 800);
  const b = tok(after).slice(0, 800);
  const na = a.map(norm);
  const nb = b.map(norm);
  // longest common subsequence of words
  const L = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) L[i][j] = na[i] === nb[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const pairs = [];
  let i = 0; let j = 0; let del = []; let ins = [];
  const flush = () => {
    if (del.length && ins.length && del.length <= 3 && ins.length <= 3) {
      const from = del.map(norm).join(' ').trim();
      const to = ins.map((w) => w.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '')).join(' ').trim();
      const meaningful = (x) => x.split(' ').some((w) => w.length > 2 && !STOPWORDS.has(w.toLowerCase()));
      const lowTo = to.toLowerCase();
      // skip grammar edits like "want" -> "wanted" (same word, different ending)
      const inflection = lowTo.startsWith(from) || from.startsWith(lowTo);
      if (from && to && from !== lowTo && from.length > 2 && meaningful(from) && !inflection) pairs.push({ from, to });
    }
    del = []; ins = [];
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && na[i] === nb[j]) { flush(); i++; j++; }
    else if (j < b.length && (i >= a.length || L[i][j + 1] >= L[i + 1][j])) ins.push(b[j++]);
    else del.push(a[i++]);
  }
  flush();
  return pairs;
}

async function offerCorrections(pairs) {
  const known = new Set(state.wordFixes.map((f) => f.from.toLowerCase()));
  const declined = new Set(state.fixesDeclined || []);
  const fresh = pairs.filter((p) => !known.has(p.from) && !declined.has(`${p.from}→${p.to.toLowerCase()}`)).slice(0, 3);
  for (const p of fresh) {
    const answer = await askLearn(p);
    if (answer === 'always') {
      state.wordFixes = [...state.wordFixes.filter((f) => f.from.toLowerCase() !== p.from), { from: p.from, to: p.to }];
      await db.setMeta('wordFixes', state.wordFixes);
      const n = await fixExistingQuietly();
      toast(`“${p.from}” will be written “${p.to}” from now on${n ? `, and was fixed in ${n} other note${n === 1 ? '' : 's'}` : ''}.`);
    } else if (answer === 'never') {
      state.fixesDeclined = [...(state.fixesDeclined || []), `${p.from}→${p.to.toLowerCase()}`];
      await db.setMeta('fixesDeclined', state.fixesDeclined);
    }
  }
}

function askLearn({ from, to }) {
  return new Promise((resolve) => {
    const dlg = $('#learn-dialog');
    $('#learn-from').textContent = from;
    $('#learn-to').textContent = to;
    const done = (answer) => { dlg.close(); resolve(answer); };
    $('#learn-always').onclick = () => done('always');
    $('#learn-skip').onclick = () => done('skip');
    $('#learn-never').onclick = () => done('never');
    dlg.oncancel = () => resolve('skip');
    dlg.showModal();
  });
}

async function fixExistingQuietly() {
  let changed = 0;
  for (const e of state.entries) {
    if (!e.transcript) continue;
    const fixed = applyWordFixes(e.transcript);
    if (fixed !== e.transcript) {
      e.transcript = fixed;
      if (Array.isArray(e.words)) e.words = fixWords(e.words);
      if (Array.isArray(e.segments)) e.segments = e.segments.map((seg) => ({ ...seg, t: applyWordFixes(seg.t) }));
      e.summary = autoSummary(e.transcript);
      await db.putEntry(e);
      changed++;
    }
  }
  rerenderActive();
  return changed;
}

async function saveEditor(ev) {
  ev.preventDefault();
  const f = ev.target;
  const entry = state.entries.find((e) => e.id === state.editing?.id);
  if (entry) {
    entry.title = f.elements.entryTitle.value.trim();
    const mood = f.querySelector('input[name="mood"]:checked');
    entry.mood = mood ? Number(mood.value) : null;
    entry.tags = parseTags(f.elements.tags.value);
    entry.prompt = f.elements.usePrompt.checked ? state.editing.prompt : null;
    entry.photos = state.editing.photos;
    const total = entry.durationMs / 1000;
    const tStart = Number($('#trim-start').value);
    const tEnd = Number($('#trim-end').value);
    entry.trimStart = tStart > 0.05 ? tStart : null;
    entry.trimEnd = tEnd < Number($('#trim-end').max) - 0.05 && tEnd < total ? tEnd : null;
    if (player.id === entry.id) stopPlayer();
    if (state.editing.transcriptDirty) {
      const edited = f.elements.transcript.value.trim();
      if (entry.transcript && edited && edited !== entry.transcript) state.learnFrom = wordDiff(entry.transcript, edited);
      if (edited !== entry.transcript) { entry.segments = null; entry.words = null; entry.transcriptEdited = true; }
      entry.transcript = edited;
      entry.summary = autoSummary(edited);
      if (entry.transcript) entry.transcriptStatus = 'done';
    }
    try {
      await db.putEntry(entry);
      toast('Entry saved');
    } catch (err) {
      toast(`Could not save: ${err.message || err}`);
    }
  }
  $('#editor').close();
  rerenderActive();
  if (state.learnFrom?.length) {
    const pairs = state.learnFrom;
    state.learnFrom = null;
    offerCorrections(pairs);
  }
}

function renderEditorTranscript(entry) {
  const status = $('#editor-transcript-status');
  const btn = $('#editor-transcribe');
  const busy = entry.transcriptStatus === 'queued' || entry.transcriptStatus === 'working';
  if (!state.tx.enabled) {
    status.textContent = entry.transcript ? '' : 'Turn on transcription in Settings to get this as text, or type it yourself.';
    btn.hidden = true;
    return;
  }
  status.textContent = busy
    ? (entry.transcriptStatus === 'working' ? 'Transcribing… you can save and close, it keeps going.' : 'Waiting to transcribe…')
    : entry.transcriptStatus === 'error' ? `Transcription failed: ${entry.transcriptError || 'unknown error'}` : '';
  btn.hidden = busy;
  btn.textContent = entry.transcript ? 'Transcribe again' : 'Transcribe';
  const improve = $('#editor-improve');
  const m = improveModel();
  improve.hidden = busy || !entry.transcript || entry.improvedWith === m.label;
  improve.textContent = `Improve with ${m.label}`;
  if (!busy && entry.improvedWith && !status.textContent) status.textContent = `Improved with ${entry.improvedWith}.`;
  if (busy && state.txOverride.has(entry.id)) status.textContent = `Improving with ${m.label}… you can close this, it keeps going.`;
}

function improveModel() {
  return IMPROVE_MODELS[state.tx.improveWith] || IMPROVE_MODELS.small;
}

/** Re-transcribe one note with a bigger, smarter model (downloaded once on first use). */
async function improveEntry(entry) {
  const m = improveModel();
  if (entry.transcriptEdited && !confirm('You edited this transcript by hand. Replace it with a new one from the larger model?')) return;
  const status = $('#editor-transcript-status');
  if (!(await downloadedModels()).includes(m.id)) {
    if (!navigator.onLine) { toast(`The ${m.label} model downloads once (${m.size}); connect to the internet first.`); return; }
    if (!confirm(`Improving uses the ${m.label} model, a one-time download of ${m.size}. Download it now?`)) return;
    $('#editor-improve').disabled = true;
    try {
      await loadModel(m.id, (f) => {
        const text = `Downloading ${m.label} model… ${Math.round(f * 100)}%`;
        if (state.editing?.id === entry.id) status.textContent = text;
        else toast(text);
      });
    } catch (err) {
      toast(m.device === 'webgpu'
        ? `Turbo couldn't start on this phone's graphics chip (${err.message || err}). Try Small instead in Settings.`
        : `Download failed: ${err.message || err}`);
      return;
    } finally {
      $('#editor-improve').disabled = false;
    }
  }
  state.txOverride.set(entry.id, m.id);
  entry.txAttempts = 0;
  queueTranscription(entry);
}

/* ---------- transcription ---------- */
async function queueTranscription(entry) {
  if (!state.tx.enabled) return;
  if (!state.txQueue.includes(entry.id)) state.txQueue.push(entry.id);
  if (entry.transcriptStatus !== 'queued') {
    entry.transcriptStatus = 'queued';
    await db.putEntry(entry);
  }
  onTranscriptChange(entry);
  runQueue();
}

/**
 * Use the chosen model if it's on the phone (or we can download it). Otherwise, or if it
 * fails, use any model that is already saved, so transcription keeps working offline.
 */
async function transcribeWithFallback(audio) {
  const downloaded = await downloadedModels();
  const want = state.tx.model;
  const sameSize = Object.keys(LEGACY_MODELS).filter((id) => currentModelFor(id) === currentModelFor(want));
  const alternatives = [currentModelFor(want), ...sameSize, ...downloaded]
    .filter((id, i, all) => id !== want && all.indexOf(id) === i && downloaded.includes(id));
  const first = downloaded.includes(want) || navigator.onLine ? want : alternatives.shift();
  if (!first) throw new Error('no model downloaded');
  try {
    return await transcribe(first, audio);
  } catch (err) {
    const next = alternatives.find((id) => id !== first);
    if (!next) throw err;
    console.warn(`Model ${first} failed, using ${next}`, err);
    return transcribe(next, audio);
  }
}

/** Try failed transcriptions again (on launch, when back online, after a model download). */
function retryFailedTranscriptions() {
  if (!state.tx.enabled) return;
  state.entries
    .filter((e) => e.transcriptStatus === 'error' && (e.txAttempts || 0) < 5)
    .reverse()
    .forEach((e) => queueTranscription(e));
}

/* ---------- automatic titles & summaries (simple, on-device, no AI service) ---------- */
const STOPWORDS = new Set(('a an and are as at be been but by did do does for from had has have he her his i if in into is it '
  + 'its just me my myself of on or our so some than that the their them then there these they this to too um uh us very '
  + 'was we were what when which who will with would you your really like also about am can could get got going go want '
  + 'today yeah okay ok well because more much one out up all how know think thing things lot '
  + 'went again long felt feel feeling made make day days time back still even said going being doing done need maybe').split(' '));
const FILLER_START = /^(?:(?:so|um+|uh+|well|okay|ok|like|yeah|right|and|hmm+|alright|hi|hello)[,.!]?\s+)+/i;

function sentencesOf(text) {
  return (text.match(/[^.!?]+[.!?]*["”']?/g) || []).map((x) => x.trim()).filter(Boolean);
}

/** A short title from the first thing you said. */
function autoTitle(text) {
  const clean = (x) => x.replace(FILLER_START, '').replace(/[.!?,;:…]+$/, '').trim();
  // Skip openers like "Okay." or "So, um." and use the first real sentence.
  const first = sentencesOf(text || '').map(clean).find((x) => x.split(/\s+/).length >= 2)
    || clean(text || '');
  const words = first.split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  let cut = words.slice(0, 7);
  if (words.length > 7) {
    // don't end on a dangling small word ("…day at…")
    while (cut.length > 3 && STOPWORDS.has(cut[cut.length - 1].toLowerCase().replace(/[^\p{L}']/gu, ''))) cut.pop();
  }
  let title = cut.join(' ').replace(/[,;:]$/, '');
  if (words.length > cut.length) title += '…';
  if (!title.replace(FILLER_START, '').trim() || !(title + ' ').replace(FILLER_START, '').trim()) return ''; // only filler words
  return title[0].toUpperCase() + title.slice(1);
}

/** For longer notes: the one or two sentences that best cover what the note is about. */
function autoSummary(text) {
  const sentences = sentencesOf(text || '');
  if (sentences.length < 3 || text.split(/\s+/).length < 35) return '';
  const words = (x) => x.toLowerCase().match(/[\p{L}']+/gu)?.filter((w) => w.length > 2 && !STOPWORDS.has(w)) || [];
  const freq = new Map();
  for (const w of words(text)) freq.set(w, (freq.get(w) || 0) + 1);
  const scored = sentences.map((sen, i) => {
    const ws = words(sen);
    const score = ws.reduce((n, w) => n + (freq.get(w) - 1), 0) / Math.sqrt(ws.length + 1) + (i === 0 ? 0.3 : 0);
    return { sen, i, score };
  });
  const top = scored.sort((a, b) => b.score - a.score).slice(0, 2).sort((a, b) => a.i - b.i);
  let summary = top.map((x) => x.sen).join(' ');
  if (summary.length > 180) summary = top.sort((a, b) => b.score - a.score)[0].sen;
  return summary.length > 200 ? `${summary.slice(0, 197).trimEnd()}…` : summary;
}

function addAutoText(entry) {
  if (!entry.transcript) return;
  if (!entry.title) { entry.title = autoTitle(entry.transcript); entry.titleAuto = !!entry.title; }
  entry.summary = autoSummary(entry.transcript);
}

async function runQueue() {
  if (state.txBusy) return;
  state.txBusy = true;
  try {
    while (state.txQueue.length && state.tx.enabled) {
      const entry = state.entries.find((e) => e.id === state.txQueue[0]);
      if (entry) {
        entry.transcriptStatus = 'working';
        onTranscriptChange(entry);
        const override = state.txOverride.get(entry.id);
        const before = { transcript: entry.transcript, words: entry.words, segments: entry.segments, summary: entry.summary };
        try {
          const { text, words, segments } = override ? await transcribe(override, entry.audio) : await transcribeWithFallback(entry.audio);
          entry.transcript = applyWordFixes(text);
          entry.words = words?.length ? fixWords(words) : null;
          entry.segments = segments?.length ? segments.map((x) => ({ ...x, t: applyWordFixes(x.t) })) : null;
          entry.transcriptStatus = 'done';
          delete entry.transcriptError;
          delete entry.txAttempts;
          if (override) {
            entry.improvedWith = Object.values(IMPROVE_MODELS).find((m) => m.id === override)?.label || 'a larger model';
            entry.transcriptEdited = false;
            toast(`Transcript improved with ${entry.improvedWith}.`);
          }
          addAutoText(entry);
        } catch (err) {
          if (override && before.transcript) {
            // An improve run failed: keep the transcript the note already had.
            Object.assign(entry, before, { transcriptStatus: 'done' });
            toast(`Couldn't improve this note: ${err.message || err}`);
            state.txOverride.delete(entry.id);
            if (state.entries.includes(entry)) await db.putEntry(entry);
            onTranscriptChange(entry, true);
            state.txQueue.shift();
            continue;
          }
          console.warn('Transcription failed', err);
          entry.transcriptStatus = 'error';
          entry.txAttempts = (entry.txAttempts || 0) + 1;
          entry.transcriptError = navigator.onLine
            ? (err.message || String(err))
            : 'no transcription model is saved on this phone yet. It will try again when you are online.';
        }
        state.txOverride.delete(entry.id);
        if (state.entries.includes(entry)) await db.putEntry(entry);
        onTranscriptChange(entry, true);
      }
      state.txQueue.shift();
    }
  } finally {
    state.txBusy = false;
    if ($('#view-settings').classList.contains('active')) renderSettings();
  }
}

function onTranscriptChange(entry, finished = false) {
  if (player.id === entry.id) $(`.entry[data-id="${CSS.escape(entry.id)}"] .reader`)?.remove();
  if (state.editing?.id === entry.id && $('#editor').open) {
    if (finished && !state.editing.transcriptDirty) $('#entry-form').elements.transcript.value = entry.transcript || '';
    const titleInput = $('#entry-form').elements.entryTitle;
    if (finished && !titleInput.value.trim() && entry.title) titleInput.value = entry.title;
    renderEditorTranscript(entry);
  }
  rerenderActive();
}

/* ---------- word fixes ---------- */
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function applyWordFixes(text) {
  let out = text || '';
  for (const { from, to } of state.wordFixes) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}'])(${escapeRegex(from)})(?=$|[^\\p{L}\\p{N}'])`, 'giu');
    out = out.replace(re, (m, pre, word, offset, whole) => {
      // Capitalize only at the start of a sentence; otherwise keep the spelling as typed.
      const before = whole.slice(0, offset + pre.length).trimEnd();
      const sentenceStart = before === '' || /[.!?]$/.test(before);
      return pre + (sentenceStart ? to[0].toUpperCase() + to.slice(1) : to);
    });
  }
  return out;
}

function fixWords(words) {
  return words.map((x, i) => {
    const fixed = applyWordFixes(x.w.trim());
    if (fixed === x.w.trim()) return { ...x };
    const prev = i ? words[i - 1].w.trim() : '';
    const sentenceStart = !prev || /[.!?]$/.test(prev);
    const word = sentenceStart ? fixed[0].toUpperCase() + fixed.slice(1) : fixed[0].toLowerCase() + fixed.slice(1);
    // keep the user's spelling when it isn't a plain lowercase word (e.g. names)
    const fix = state.wordFixes.find((f) => f.to.toLowerCase() === fixed.toLowerCase());
    return { ...x, w: sentenceStart || !fix ? word : fix.to };
  });
}

function renderWordFixes() {
  $('#fix-list').innerHTML = state.wordFixes.map((f, i) => `
    <li><span><span class="from">${esc(f.from)}</span><span class="sep">&rarr;</span><span class="to">${esc(f.to)}</span></span>
      <button class="icon-btn" type="button" data-fix="${i}" aria-label="Remove fix for ${esc(f.from)}">&times;</button></li>`).join('');
  $('#fix-apply').hidden = !state.wordFixes.length || !state.entries.some((e) => e.transcript);
}

async function saveWordFixes() {
  await db.setMeta('wordFixes', state.wordFixes);
  renderWordFixes();
}

async function onAddFix(ev) {
  ev.preventDefault();
  const from = $('#fix-from').value.trim();
  const to = $('#fix-to').value.trim();
  if (!from || !to) return;
  state.wordFixes = state.wordFixes.filter((f) => f.from.toLowerCase() !== from.toLowerCase());
  state.wordFixes.push({ from, to });
  $('#fix-form').reset();
  await saveWordFixes();
  toast(`“${from}” will now be written as “${to}”.`);
}

async function applyFixesToExisting() {
  let changed = 0;
  for (const e of state.entries) {
    if (!e.transcript) continue;
    const fixed = applyWordFixes(e.transcript);
    if (fixed !== e.transcript) {
      e.transcript = fixed;
      if (Array.isArray(e.segments)) e.segments = e.segments.map((seg) => ({ ...seg, t: applyWordFixes(seg.t) }));
      if (Array.isArray(e.words)) e.words = fixWords(e.words);
      await db.putEntry(e);
      changed++;
    }
  }
  toast(changed ? `Fixed ${changed} transcript${changed === 1 ? '' : 's'}.` : 'Nothing to fix in your transcripts.');
  rerenderActive();
}

async function saveTxSettings() {
  await db.setMeta('transcription', state.tx);
}

async function enableTranscription() {
  const model = $('#tx-model').value;
  state.txDownload = 0;
  renderSettings();
  try {
    await loadModel(model, (fraction) => {
      state.txDownload = fraction;
      const bar = $('#tx-progress i');
      if (bar) bar.style.width = `${Math.round(fraction * 100)}%`;
      $('#tx-status').textContent = `Downloading ${MODELS[model].label} model… ${Math.round(fraction * 100)}%`;
    });
    state.tx = { ...state.tx, enabled: true, model };
    state.txReady = true;
    state.txNeedsUpdate = false;
    await saveTxSettings();
    retryFailedTranscriptions();
    requestPersistence();
    toast('Transcription is on and works offline.');
  } catch (err) {
    toast(navigator.onLine ? `Download failed: ${err.message || err}` : 'You are offline. Connect to the internet to download the model.');
  } finally {
    state.txDownload = null;
    renderSettings();
    rerenderActive();
  }
}

/** After an app update that changes the model, fetch the new one quietly (needs internet once). */
async function updateModelInBackground() {
  if (!navigator.onLine) {
    window.addEventListener('online', updateModelInBackground, { once: true });
    return;
  }
  const model = currentModelFor(state.tx.model);
  state.txDownload = 0;
  state.txUpdating = true;
  renderTxSettings();
  try {
    await loadModel(model, (fraction) => {
      state.txDownload = fraction;
      const bar = $('#tx-progress i');
      if (bar) bar.style.width = `${Math.round(fraction * 100)}%`;
      if ($('#view-settings').classList.contains('active')) {
        $('#tx-status').textContent = `Updating to word-by-word timing… ${Math.round(fraction * 100)}%`;
      }
    });
    state.txNeedsUpdate = false;
    state.tx = { ...state.tx, model };
    await saveTxSettings();
    toast('Transcription updated: new notes now highlight word by word.');
    retryFailedTranscriptions();
  } catch (err) {
    console.warn('Model update failed', err);
  } finally {
    state.txDownload = null;
    state.txUpdating = false;
    if ($('#view-settings').classList.contains('active')) renderSettings();
  }
}

/* ---------- daily reminder ----------
   Uses Periodic Background Sync (installed app, Chrome on Android). The browser decides the
   exact moment, so the reminder arrives around your chosen time rather than on the minute. */
async function reminderSupport() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return 'none';
  const reg = await navigator.serviceWorker.ready;
  return 'periodicSync' in reg ? 'periodic' : 'none';
}

async function renderReminder() {
  const r = state.reminder;
  $('#reminder-on').checked = !!r.on;
  $('#reminder-time').value = r.time || '20:00';
  $('#reminder-time-row').hidden = !r.on;
  const support = await reminderSupport();
  let note = '';
  if (support === 'none') note = 'This browser can’t send reminders while the app is closed. Set a daily alarm in your Clock app instead.';
  else if (r.on && Notification.permission === 'denied') note = 'Notifications are blocked for this app. Allow them in your phone’s app settings.';
  else if (r.on) note = 'You’ll get a nudge around this time on days you haven’t recorded yet. Android decides the exact moment, and it needs the app to be installed.';
  $('#reminder-note').textContent = note;
}

async function setReminder(on) {
  const reg = await navigator.serviceWorker?.ready;
  if (on) {
    if (!('Notification' in window)) { toast('Notifications aren’t supported here.'); on = false; }
    else if ((await Notification.requestPermission()) !== 'granted') { toast('Notifications were not allowed.'); on = false; }
  }
  state.reminder = { ...state.reminder, on, time: $('#reminder-time').value || '20:00' };
  await db.setMeta('reminder', state.reminder);
  try {
    if (on && reg?.periodicSync) {
      const perm = await navigator.permissions.query({ name: 'periodic-background-sync' }).catch(() => null);
      if (perm && perm.state !== 'granted') toast('Install the app (Add to Home screen) so reminders can run in the background.');
      await reg.periodicSync.register('daily-reminder', { minInterval: 6 * 60 * 60 * 1000 });
    } else if (!on && reg?.periodicSync) {
      await reg.periodicSync.unregister('daily-reminder');
    }
  } catch (err) {
    console.warn('Reminder registration failed', err);
    if (on) toast('Couldn’t schedule background reminders on this device.');
  }
  renderReminder();
}

async function disableTranscription() {
  state.tx = { ...state.tx, enabled: false };
  state.txQueue = [];
  for (const e of state.entries) {
    if (e.transcriptStatus === 'queued' || e.transcriptStatus === 'working') {
      e.transcriptStatus = null;
      await db.putEntry(e);
    }
  }
  await saveTxSettings();
  toast('Transcription turned off. Existing transcripts are kept.');
  renderSettings();
  rerenderActive();
}

async function deleteModels() {
  if (!confirm('Delete downloaded transcription models to free up space? You can download them again later.')) return;
  if (state.tx.enabled) await disableTranscription();
  await caches.delete('transformers-cache');
  toast('Downloaded models deleted.');
  renderSettings();
}

function untranscribed() {
  return state.entries.filter((e) => !e.transcript && e.transcriptStatus !== 'queued' && e.transcriptStatus !== 'working');
}

function renderTxSettings() {
  const sel = $('#tx-model');
  if (!sel.options.length) {
    sel.innerHTML = Object.entries(MODELS)
      .map(([id, m]) => `<option value="${id}">${m.label} (${m.size}): ${m.note}</option>`).join('');
    sel.value = currentModelFor(state.tx.model);
  }
  const downloading = state.txDownload !== null;
  const chosen = sel.value;
  const queued = state.txQueue.length;
  $('#tx-progress').hidden = !downloading;
  sel.disabled = downloading;

  if (downloading) {
    $('#tx-status').textContent = state.txUpdating
      ? `Updating to word-by-word timing… ${Math.round(state.txDownload * 100)}%`
      : `Downloading ${MODELS[chosen].label} model… ${Math.round(state.txDownload * 100)}%`;
  } else if (state.tx.enabled) {
    const label = MODELS[currentModelFor(state.tx.model)].label;
    const ready = state.txReady;
    const offlineNote = ready === false
      ? ' Not saved on this phone yet: connect to the internet once to download it.'
      : LEGACY_MODELS[state.tx.model] ? ' Works offline. A word-by-word update downloads next time you are online.' : ' Saved on this phone, works offline.';
    $('#tx-status').textContent = `On, using the ${label} model.${offlineNote}${queued ? ` Transcribing ${queued} note${queued === 1 ? '' : 's'}…` : ''}`;
  } else {
    $('#tx-status').textContent = 'Off. Turn it on to get a text version of each voice note.';
  }

  const needsDownload = !state.tx.enabled || chosen !== currentModelFor(state.tx.model);
  const enableBtn = $('#tx-enable');
  enableBtn.hidden = !needsDownload;
  enableBtn.disabled = downloading;
  enableBtn.textContent = state.tx.enabled ? `Switch to ${MODELS[chosen].label} (${MODELS[chosen].size})` : `Download and turn on (${MODELS[chosen].size})`;
  $('#tx-disable').hidden = !state.tx.enabled || downloading;
  $('#tx-auto-row').hidden = !state.tx.enabled;
  $('#tx-auto').checked = state.tx.auto;

  $('#improve-row').hidden = !state.tx.enabled;
  $('#improve-with').value = state.tx.improveWith === 'turbo' ? 'turbo' : 'small';

  const backlog = state.tx.enabled ? untranscribed().length : 0;
  const backlogBtn = $('#tx-backlog');
  backlogBtn.hidden = !backlog || downloading;
  backlogBtn.textContent = `Transcribe ${backlog} older note${backlog === 1 ? '' : 's'}`;
}

async function discardEditor() {
  const { id, isNew } = state.editing || {};
  if (!id) return;
  if (!isNew && !confirm('Delete this entry? This cannot be undone.')) return;
  if (player.id === id) stopPlayer();
  await db.deleteEntry(id);
  state.entries = state.entries.filter((e) => e.id !== id);
  $('#editor').close();
  toast(isNew ? 'Recording discarded' : 'Entry deleted');
  rerenderActive();
}

/* ---------- calendar ---------- */
const weekStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const moodFace = (v) => (v == null ? '–' : moodOf(Math.round(v)).e);

/** Most-used meaningful words in transcripts (and titles) of the given notes. */
function topWords(entries, n = 18) {
  const freq = new Map();
  for (const e of entries) {
    const text = `${e.transcript || ''} ${e.title || ''}`.toLowerCase();
    for (const w of text.match(/[\p{L}']+/gu) || []) {
      const word = w.replace(/^'+|'+$/g, '');
      if (word.length > 3 && !STOPWORDS.has(word)) freq.set(word, (freq.get(word) || 0) + 1);
    }
  }
  return [...freq.entries()].filter(([, c]) => c > 1 || entries.length < 4).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function weekSummary(from, to) {
  const list = state.entries.filter((e) => e.createdAt >= from && e.createdAt < to);
  const moods = list.filter((e) => e.mood).map((e) => e.mood);
  const tags = new Map();
  for (const e of list) for (const t of e.tags) tags.set(t, (tags.get(t) || 0) + 1);
  const longest = list.reduce((m, e) => (!m || e.durationMs > m.durationMs ? e : m), null);
  return {
    list, days: new Set(list.map((e) => dayKey(e.createdAt))).size,
    time: list.reduce((n, e) => n + e.durationMs, 0), mood: avg(moods),
    tags: [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t),
    words: topWords(list, 5).map(([w]) => w), longest,
  };
}

function renderRecap() {
  const thisWeek = weekStart(new Date());
  const lastWeek = new Date(thisWeek); lastWeek.setDate(lastWeek.getDate() - 7);
  const cols = [['This week', weekSummary(+thisWeek, Date.now() + 1)], ['Last week', weekSummary(+lastWeek, +thisWeek)]];
  $('#recap').innerHTML = cols.map(([label, w]) => `
    <div class="recap-col">
      <span class="eyebrow">${label}</span>
      ${w.list.length ? `
      <div class="recap-big">${w.list.length}<small> note${w.list.length === 1 ? '' : 's'}</small></div>
      <ul class="recap-list">
        <li><span>Days journaled</span><b>${w.days} / 7</b></li>
        <li><span>Time recorded</span><b>${fmtTotal(w.time)}</b></li>
        <li><span>Average mood</span><b>${moodFace(w.mood)}</b></li>
        ${w.tags.length ? `<li><span>Top tags</span><b>${w.tags.map((t) => `#${esc(t)}`).join(' ')}</b></li>` : ''}
        ${w.words.length ? `<li><span>You talked about</span><b>${w.words.map(esc).join(', ')}</b></li>` : ''}
        ${w.longest ? `<li><span>Longest note</span><b>${esc(w.longest.title || 'Untitled')} · ${fmtDuration(w.longest.durationMs)}</b></li>` : ''}
      </ul>` : '<p class="muted">No notes.</p>'}
    </div>`).join('');
}

function renderThemes() {
  const since = Date.now() - 30 * 86_400_000;
  const words = topWords(state.entries.filter((e) => e.createdAt >= since));
  if (!words.length) {
    $('#themes').innerHTML = '<p class="muted">Themes appear once your notes are transcribed.</p>';
    return;
  }
  const max = words[0][1];
  const min = words[words.length - 1][1];
  // shuffle-free but not strictly sorted, so it reads like a cloud
  const ordered = words.map((w, i) => [w, i]).sort((a, b) => (a[1] % 3) - (b[1] % 3) || a[1] - b[1]).map(([w]) => w);
  $('#themes').innerHTML = ordered.map(([w, c]) => {
    const size = max === min ? 1.3 : 0.95 + ((c - min) / (max - min)) * 1.25;
    return `<button type="button" class="theme-word" data-word="${esc(w)}" style="font-size:${size.toFixed(2)}rem" title="${c} times">${esc(w)}</button>`;
  }).join(' ');
}

function moodRows(groups) {
  const rows = groups.filter(([, xs]) => xs.length);
  if (!rows.length) return '';
  return rows.map(([label, xs]) => {
    const a = avg(xs);
    return `<div class="mood-bar insight"><span class="label-cell">${esc(label)}</span>
      <div class="track"><i style="width:${((a - 1) / 4) * 100}%"></i></div><span class="n">${moodOf(Math.round(a)).e}</span></div>`;
  }).join('');
}

function renderMoodInsights() {
  const withMood = state.entries.filter((e) => e.mood);
  const box = $('#mood-insights');
  if (withMood.length < 3) {
    box.innerHTML = '<p class="muted">Add a mood to at least 3 notes to see patterns.</p>';
    return;
  }
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const byDay = days.map((d, i) => [d, withMood.filter((e) => (new Date(e.createdAt).getDay() + 6) % 7 === i).map((e) => e.mood)]);
  const part = (h) => (h < 5 ? 'Night' : h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : h < 22 ? 'Evening' : 'Night');
  const parts = ['Morning', 'Afternoon', 'Evening', 'Night'];
  const byTime = parts.map((p) => [p, withMood.filter((e) => part(new Date(e.createdAt).getHours()) === p).map((e) => e.mood)]);
  const tagMap = new Map();
  for (const e of withMood) for (const t of e.tags) tagMap.set(t, [...(tagMap.get(t) || []), e.mood]);
  const byTag = [...tagMap.entries()].filter(([, xs]) => xs.length >= 2)
    .sort((a, b) => avg(b[1]) - avg(a[1])).slice(0, 6).map(([t, xs]) => [`#${t}`, xs]);
  const best = byDay.filter(([, xs]) => xs.length).sort((a, b) => avg(b[1]) - avg(a[1]))[0];
  box.innerHTML = `
    ${best ? `<p class="insight-line">Your best days tend to be <b>${{ Mon: 'Mondays', Tue: 'Tuesdays', Wed: 'Wednesdays', Thu: 'Thursdays', Fri: 'Fridays', Sat: 'Saturdays', Sun: 'Sundays' }[best[0]]}</b>.</p>` : ''}
    <h4>By day of week</h4>${moodRows(byDay)}
    <h4>By time of day</h4>${moodRows(byTime)}
    ${byTag.length ? `<h4>By tag</h4>${moodRows(byTag)}` : ''}`;
}

function renderCalendar() {
  renderRecap();
  renderThemes();
  renderMoodInsights();
  const { current, longest } = streaks(state.entries);
  const totalMs = state.entries.reduce((s, e) => s + e.durationMs, 0);
  $('#stats').innerHTML = [
    [current, 'Day streak'],
    [longest, 'Longest streak'],
    [state.entries.length, 'Entries'],
    [fmtTotal(totalMs), 'Time recorded'],
  ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');

  const month = state.calMonth;
  const now = new Date();
  $('#cal-title').textContent = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  $('#cal-next').disabled = month >= startOfMonth(now);

  const byDay = new Map();
  for (const e of state.entries) {
    const k = dayKey(e.createdAt);
    const d = byDay.get(k) || { n: 0, moodSum: 0, moodN: 0 };
    d.n++;
    if (e.mood) { d.moodSum += e.mood; d.moodN++; }
    byDay.set(k, d);
  }

  // Monday-first week
  const dows = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  let html = dows.map((d) => `<div class="cal-dow">${d}</div>`).join('');
  const lead = (month.getDay() + 6) % 7;
  html += '<div class="cal-day blank"></div>'.repeat(lead);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const todayKey = dayKey(now);
  for (let day = 1; day <= daysInMonth; day++) {
    const key = dayKey(new Date(month.getFullYear(), month.getMonth(), day));
    const info = byDay.get(key);
    const level = info ? Math.min(4, info.n) : 0;
    const mood = info?.moodN ? moodOf(Math.round(info.moodSum / info.moodN)) : null;
    const label = info ? `${key}: ${info.n} entr${info.n === 1 ? 'y' : 'ies'}` : key;
    html += `<button type="button" class="cal-day l${level}${info ? ' has' : ''}${key === todayKey ? ' today' : ''}"
      data-day="${key}" aria-label="${label}" ${info ? '' : 'disabled'}>${day}${mood ? `<small>${mood.e}</small>` : ''}</button>`;
  }
  $('#cal-grid').innerHTML = html;

  const since = Date.now() - 30 * 86_400_000;
  const recent = state.entries.filter((e) => e.createdAt >= since && e.mood);
  const counts = MOODS.map((m) => recent.filter((e) => e.mood === m.v).length);
  const max = Math.max(1, ...counts);
  $('#mood-bars').innerHTML = recent.length
    ? MOODS.slice().reverse().map((m) => {
      const n = counts[m.v - 1];
      return `<div class="mood-bar" title="${m.l}"><span>${m.e}</span><div class="track"><i style="width:${(n / max) * 100}%"></i></div><span class="n">${n}</span></div>`;
    }).join('')
    : '<p class="muted">Add a mood to your entries to see trends here.</p>';
}

/* ---------- PIN lock ---------- */
async function hashPin(pin, salt) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${pin}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function checkPin(pin) {
  const saved = await db.getMeta('pin');
  if (!saved) return true;
  return (await hashPin(pin, saved.salt)) === saved.hash;
}

function lock() {
  if (!state.hasPin) return;
  if (player.id) player.audio.pause();
  if ($('#editor').open) $('#editor').close();
  $('#lock').hidden = false;
  $('#lock-pin').value = '';
  $('#lock-error').textContent = '';
  setTimeout(() => $('#lock-pin').focus(), 50);
}

async function onUnlock(ev) {
  ev.preventDefault();
  const pin = $('#lock-pin').value;
  if (await checkPin(pin)) {
    if (state.encryption && !state.loaded) {
      const btn = $('#lock-form .btn');
      btn.disabled = true;
      btn.textContent = 'Unlocking…';
      const key = await unlockKey(pin, state.encryption);
      btn.disabled = false;
      btn.textContent = 'Unlock';
      if (!key) { $('#lock-error').textContent = 'This PIN can’t open the encrypted journal.'; return; }
      db.setKey(key);
      await loadJournal();
    }
    $('#lock').hidden = true;
    if (state.pendingRecord) { state.pendingRecord = false; startRecording(); }
    return;
  }
  const card = $('#lock-form');
  $('#lock-error').textContent = 'Wrong PIN, try again.';
  $('#lock-pin').value = '';
  card.classList.remove('shake');
  void card.offsetWidth;
  card.classList.add('shake');
}

/** Re-save every note (sealed or plain, depending on the current key). */
async function rewriteAllEntries(label) {
  let n = 0;
  for (const e of state.entries) {
    await db.putEntry(e);
    n++;
    if (n % 5 === 0) $('#pin-status').textContent = `${label} ${n} of ${state.entries.length}…`;
  }
  // audio saved during a recording in progress is left as is; it's deleted once the note is saved
}

async function enableEncryption() {
  const err = $('#pin-error');
  const pin = $('#pin-current').value;
  if (!(await checkPin(pin))) { err.textContent = 'Enter your current PIN to turn on encryption.'; return; }
  if (!confirm('Encrypt your journal with your PIN?\n\nIf you forget the PIN, your notes cannot be recovered by anyone. Keep a backup somewhere safe.')) return;
  const { key, record } = await newEncryptionRecord(pin);
  db.setKey(key);
  await rewriteAllEntries('Encrypting');
  await db.setMeta('encryption', record);
  state.encryption = record;
  $('#pin-form').reset();
  err.textContent = '';
  toast('Your journal is now encrypted with your PIN.');
  renderSettings();
}

async function disableEncryption(pin, quiet = false) {
  if (!(await checkPin(pin))) { $('#pin-error').textContent = 'Enter your current PIN to turn off encryption.'; return false; }
  db.setKey(null);
  await rewriteAllEntries('Decrypting');
  await db.deleteMeta('encryption');
  state.encryption = null;
  if (!quiet) { $('#pin-form').reset(); toast('Encryption turned off.'); renderSettings(); }
  return true;
}

async function onPinSave(ev) {
  ev.preventDefault();
  const err = $('#pin-error');
  err.textContent = '';
  if (!crypto.subtle) { err.textContent = 'PIN lock needs the app to be served over HTTPS or localhost.'; return; }
  const cur = $('#pin-current').value;
  const next = $('#pin-new').value;
  const confirmPin = $('#pin-confirm').value;
  if (state.hasPin && !(await checkPin(cur))) { err.textContent = 'Current PIN is wrong.'; return; }
  if (!/^\d{4,8}$/.test(next)) { err.textContent = 'Use 4 to 8 digits.'; return; }
  if (next !== confirmPin) { err.textContent = "The new PINs don't match."; return; }
  const salt = uid();
  if (state.encryption) {
    // New PIN, new key: re-encrypt everything with it before switching.
    const { key, record } = await newEncryptionRecord(next);
    db.setKey(key);
    await rewriteAllEntries('Re-encrypting');
    await db.setMeta('encryption', record);
    state.encryption = record;
  }
  await db.setMeta('pin', { salt, hash: await hashPin(next, salt) });
  state.hasPin = true;
  $('#pin-form').reset();
  toast('PIN saved. The app will lock on open and after a minute away.');
  renderSettings();
}

async function onPinRemove() {
  const err = $('#pin-error');
  if (!(await checkPin($('#pin-current').value))) { err.textContent = 'Enter your current PIN to remove it.'; return; }
  if (state.encryption && !(await disableEncryption($('#pin-current').value, true))) return;
  await db.deleteMeta('pin');
  state.hasPin = false;
  $('#pin-form').reset();
  err.textContent = '';
  toast('PIN removed');
  renderSettings();
}

/* ---------- backup ---------- */
async function exportZip() {
  if (!state.entries.length) { toast('Nothing to export yet.'); return; }
  download(buildBackup(), `voice-journal-${dayKey(Date.now())}.zip`);
  await markBackedUp();
}

/** All notes as one readable Markdown document, oldest first. */
function buildMarkdown() {
  const lines = ['# Voice Journal', '', `_Exported ${new Date().toLocaleString()}_`, ''];
  let day = null;
  for (const e of [...state.entries].sort((a, b) => a.createdAt - b.createdAt)) {
    const key = dayKey(e.createdAt);
    if (key !== day) {
      day = key;
      lines.push(`## ${new Date(e.createdAt).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`, '');
    }
    const mood = moodOf(e.mood);
    lines.push(`### ${fmtTime(e.createdAt)} · ${e.title || 'Untitled'}${e.starred ? ' ★' : ''}`);
    const meta = [fmtDuration(playLength(e) * 1000), mood ? `${mood.e} ${mood.l}` : null, e.tags.length ? e.tags.map((t) => `#${t}`).join(' ') : null]
      .filter(Boolean).join(' · ');
    lines.push(`_${meta}_`, '');
    if (e.prompt) lines.push(`> ${e.prompt}`, '');
    lines.push(e.transcript ? e.transcript : '_(no transcript)_', '');
    if (e.photos?.length) lines.push(`_${e.photos.length} photo${e.photos.length === 1 ? '' : 's'} in the app_`, '');
  }
  return new Blob([lines.join('\n')], { type: 'text/markdown' });
}

async function exportText() {
  if (!state.entries.length) { toast('Nothing to export yet.'); return; }
  const blob = buildMarkdown();
  const name = `voice-journal-${dayKey(Date.now())}.md`;
  const file = new File([blob], name, { type: 'text/markdown' });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: 'Voice Journal' }); return; }
  } catch (err) {
    if (err.name === 'AbortError') return;
  }
  download(blob, name);
}

function buildBackup() {
  const files = [];
  const meta = [];
  for (const e of state.entries) {
    const name = `audio/${dayKey(e.createdAt)}_${e.id}.${extFor(e.mime)}`;
    files.push({ name, data: new Uint8Array(e.audio) });
    const { audio, transcriptStatus, transcriptError, txAttempts, photos, ...rest } = e;
    const photoFiles = (photos || []).map((p, i) => {
      const file = `photos/${dayKey(e.createdAt)}_${e.id}_${i + 1}.jpg`;
      files.push({ name: file, data: new Uint8Array(p.data) });
      return { file, type: p.type };
    });
    meta.push({ ...rest, audioFile: name, photos: photoFiles });
  }
  const manifest = { app: 'voice-journal', version: 1, exportedAt: new Date().toISOString(), entries: meta };
  files.unshift({ name: 'journal.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });

  return createZip(files);
}

function canShareFiles() {
  try {
    return !!navigator.canShare?.({ files: [new File([''], 'x.zip', { type: 'application/zip' })] });
  } catch { return false; }
}

/** Save the backup somewhere else via the phone's share sheet (e.g. Google Drive). */
async function shareZip() {
  if (!state.entries.length) { toast('Nothing to back up yet.'); return; }
  const blob = buildBackup();
  const file = new File([blob], `voice-journal-${dayKey(Date.now())}.zip`, { type: 'application/zip' });
  try {
    await navigator.share({ files: [file], title: 'Voice Journal backup' });
    await markBackedUp();
  } catch (err) {
    if (err.name !== 'AbortError') { download(blob, file.name); await markBackedUp(); }
  }
}

async function markBackedUp() {
  state.lastExport = Date.now();
  await db.setMeta('lastExport', state.lastExport);
  renderBackupBanner();
  renderSettings();
}

const notBackedUp = () => state.entries.filter((e) => e.createdAt > (state.lastExport || 0)).length;

/** On Sunday and Monday, point to last week's recap once. */
function renderRecapBanner() {
  const banner = $('#recap-banner');
  const today = new Date().getDay();
  const thisWeek = weekStart(new Date());
  const key = dayKey(today === 0 ? thisWeek : new Date(+thisWeek - 7 * 86_400_000));
  const from = today === 0 ? +thisWeek : +thisWeek - 7 * 86_400_000;
  const to = today === 0 ? Date.now() : +thisWeek;
  const count = state.entries.filter((e) => e.createdAt >= from && e.createdAt < to).length;
  banner.hidden = !((today === 0 || today === 1) && count && state.recapSeen !== key);
  banner.dataset.week = key;
  if (!banner.hidden) $('#recap-banner-text').textContent = `Your weekly recap is ready: ${count} note${count === 1 ? '' : 's'} ${today === 0 ? 'this' : 'last'} week.`;
}

/** A gentle reminder on the Record screen when notes exist only on this phone. */
function renderBackupBanner() {
  const banner = $('#backup-banner');
  const pending = notBackedUp();
  const week = 7 * 86_400_000;
  const due = state.lastExport ? Date.now() - state.lastExport > week : state.entries.length >= 3;
  const snoozed = (state.backupSnoozeUntil || 0) > Date.now();
  banner.hidden = !(pending && due && !snoozed);
  if (!banner.hidden) {
    $('#backup-banner-text').textContent = `${pending} note${pending === 1 ? ' isn’t' : 's aren’t'} backed up yet. `
      + 'Your journal lives only on this phone.';
  }
}

async function importZip(file) {
  try {
    const files = await readZip(file);
    if (!files['journal.json']) throw new Error('journal.json not found in the zip');
    const data = JSON.parse(new TextDecoder().decode(files['journal.json']));
    if (!Array.isArray(data.entries)) throw new Error('journal.json has no entries list');
    const existing = new Set(state.entries.map((e) => e.id));
    let added = 0; let skipped = 0;
    for (const m of data.entries) {
      const audio = files[m.audioFile];
      if (typeof m.id !== 'string' || typeof m.createdAt !== 'number' || existing.has(m.id) || !audio) { skipped++; continue; }
      await db.putEntry({
        id: m.id,
        createdAt: m.createdAt,
        durationMs: Number(m.durationMs) || 0,
        mime: typeof m.mime === 'string' ? m.mime : 'audio/webm',
        title: typeof m.title === 'string' ? m.title : '',
        mood: MOODS.some((x) => x.v === m.mood) ? m.mood : null,
        tags: Array.isArray(m.tags) ? m.tags.filter((t) => typeof t === 'string') : [],
        prompt: typeof m.prompt === 'string' ? m.prompt : null,
        transcript: typeof m.transcript === 'string' ? m.transcript : '',
        summary: typeof m.summary === 'string' ? m.summary : '',
        words: Array.isArray(m.words)
          ? m.words.filter((x) => x && typeof x.w === 'string' && typeof x.s === 'number')
            .map((x) => ({ w: x.w, s: x.s, e: typeof x.e === 'number' ? x.e : null }))
          : null,
        segments: Array.isArray(m.segments)
          ? m.segments.filter((x) => x && typeof x.t === 'string' && typeof x.s === 'number')
            .map((x) => ({ t: x.t, s: x.s, e: typeof x.e === 'number' ? x.e : null }))
          : null,
        transcriptStatus: typeof m.transcript === 'string' && m.transcript ? 'done' : null,
        starred: m.starred === true,
        trimStart: typeof m.trimStart === 'number' ? m.trimStart : null,
        trimEnd: typeof m.trimEnd === 'number' ? m.trimEnd : null,
        photos: Array.isArray(m.photos)
          ? m.photos.filter((p) => p && files[p.file]).map((p) => ({ type: typeof p.type === 'string' ? p.type : 'image/jpeg', data: files[p.file].slice().buffer }))
          : [],
        audio: audio.slice().buffer,
      });
      added++;
    }
    state.entries = await db.allEntries();
    toast(`Imported ${added} entr${added === 1 ? 'y' : 'ies'}${skipped ? `, skipped ${skipped}` : ''}.`);
    renderSettings();
    renderStreakBadge();
  } catch (err) {
    toast(`Import failed: ${err.message || err}`);
  }
}

/* ---------- settings ---------- */
async function refreshMics() {
  const sel = $('#mic-select');
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    const named = devices.filter((d) => d.label);
    sel.innerHTML = '<option value="">Automatic (phone default)</option>'
      + named.map((d) => `<option value="${esc(d.deviceId)}">${esc(d.label)}</option>`).join('');
    sel.value = named.some((d) => d.deviceId === state.micId) ? state.micId : '';
    $('#mic-hint').textContent = named.length
      ? 'If recordings come out silent while a watch or earbuds are connected, pick the phone\'s own microphone here, or turn off Bluetooth while recording.'
      : 'Record once and allow the microphone to see the list of microphones.';
  } catch {
    $('#mic-hint').textContent = 'This browser cannot list microphones.';
  }
}

async function renderSettings() {
  renderPromptSettings();
  renderReminder();
  if (state.tx.enabled) {
    downloadedModels().then((list) => {
      const ready = list.includes(state.tx.model) || list.includes(currentModelFor(state.tx.model));
      if (ready !== state.txReady) { state.txReady = ready; renderTxSettings(); }
    });
  }
  refreshMics();
  $('#app-version').textContent = `Version ${APP_VERSION}`;
  renderTxSettings();
  renderWordFixes();
  $('#pin-status').textContent = state.hasPin ? 'A PIN is set. The app locks on open and after 1 minute in the background.' : 'No PIN set.';
  $('#pin-current').hidden = !state.hasPin;
  $('#pin-remove').hidden = !state.hasPin;
  $('#lock-now').hidden = !state.hasPin;
  $('#pin-save').textContent = state.hasPin ? 'Change PIN' : 'Set PIN';
  $('#encrypt-on').hidden = !state.hasPin || !!state.encryption;
  $('#encrypt-off').hidden = !state.encryption;
  $('#pin-note').textContent = state.encryption
    ? 'Your notes, recordings and photos are encrypted with your PIN. Forgetting the PIN means losing them, so keep a backup. Backups themselves are not encrypted.'
    : state.hasPin
      ? 'The PIN keeps people out of the app. Turn on encryption to also protect the stored notes themselves.'
      : 'Set a PIN to lock the app, then you can encrypt your notes with it.';
  if (state.encryption) $('#pin-status').textContent = 'PIN set · notes encrypted.';
  try { $('#privacy-on').checked = localStorage.getItem('vj-privacy') !== '0'; } catch { /* default on */ }

  const last = state.lastExport;
  const pending = notBackedUp();
  $('#backup-status').textContent = (last
    ? `Last backup: ${new Date(last).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.`
    : 'No backup yet. Your notes live only on this phone, so back up now and then.')
    + (pending ? ` ${pending} note${pending === 1 ? '' : 's'} not backed up.` : ' Everything is backed up.');
  $('#share-btn').hidden = !canShareFiles();

  const bytes = state.entries.reduce((s, e) => s + e.audio.byteLength, 0);
  let text = `${state.entries.length} entries using ${fmtBytes(bytes)}.`;
  try {
    const persisted = await navigator.storage?.persisted?.();
    text += persisted ? ' Storage is protected from automatic clean-up.' : ' The browser may clear this data if the device runs low on space.';
    $('#persist-btn').hidden = !!persisted || !navigator.storage?.persist;
  } catch { $('#persist-btn').hidden = true; }
  $('#storage-status').textContent = text;
}

/* ---------- init ---------- */
let installPrompt = null;

/* ---------- header ---------- */
function renderGreeting() {
  const now = new Date();
  const h = now.getHours();
  const part = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 22 ? 'Good evening' : 'Good night';
  $('#greeting').textContent = part;
  const weekday = now.toLocaleDateString(undefined, { weekday: 'long' });
  const date = now.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  $('#today-label').textContent = `${weekday} · ${date}`;
}

/* ---------- privacy screen ----------
   Cover the journal when the app goes to the background, so the app switcher
   preview shows a plain screen instead of your notes. */
function privacyOn() {
  try { return localStorage.getItem('vj-privacy') !== '0'; } catch { return true; }
}
function coverScreen(show) {
  $('#privacy-cover').hidden = !(show && privacyOn());
}

/* ---------- theme ---------- */
function readTheme() {
  try { return localStorage.getItem('vj-theme') || 'dark'; } catch { return 'dark'; }
}

function applyTheme(choice) {
  document.documentElement.dataset.theme = choice;
  try { localStorage.setItem('vj-theme', choice); } catch { /* private mode: still applies for this visit */ }
  $$('[data-theme-choice]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice)));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (!rec.mr) drawIdleWave();
}

function bindEvents() {
  $$('[data-theme-choice]').forEach((b) => b.addEventListener('click', () => applyTheme(b.dataset.themeChoice)));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (readTheme() === 'system') applyTheme('system');
  });
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $('#rec-btn').addEventListener('click', () => (rec.mr ? stopRecording() : startRecording()));
  $('#pause-btn').addEventListener('click', togglePause);
  $('#starred-chip').addEventListener('click', () => {
    state.filterStarred = !state.filterStarred;
    $('#starred-chip').classList.toggle('active', state.filterStarred);
    $('#starred-chip').setAttribute('aria-pressed', String(state.filterStarred));
    renderJournal();
  });
  $('#photo-input').addEventListener('change', async (ev) => {
    const picked = [...ev.target.files];
    ev.target.value = '';
    for (const file of picked) {
      try { state.editing?.photos.push(await preparePhoto(file)); } catch { toast('Could not add that photo.'); }
    }
    renderEditorPhotos();
  });
  $('#editor-photos').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-remove-photo]');
    if (!btn || !state.editing) return;
    state.editing.photos.splice(Number(btn.dataset.removePhoto), 1);
    renderEditorPhotos();
  });
  $('#trim-start').addEventListener('input', () => updateTrimLabels('start'));
  $('#trim-end').addEventListener('input', () => updateTrimLabels('end'));
  $('#trim-auto').addEventListener('click', autoTrimSilence);
  $('#trim-preview').addEventListener('click', previewTrim);
  $('#photo-view').addEventListener('click', () => $('#photo-view').close());
  $('#prompt-shuffle').addEventListener('click', () => { state.promptShift++; renderPrompt(); });

  $('#recent').addEventListener('click', onListClick);
  $('#entry-list').addEventListener('click', onListClick);
  for (const list of [$('#recent'), $('#entry-list')]) {
    list.addEventListener('keydown', (ev) => {
      if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.classList.contains('seg')) { ev.preventDefault(); onListClick(ev); }
    });
  }
  $('#search').addEventListener('input', renderJournal);
  $('#filter-mood').addEventListener('change', renderJournal);
  $('#filter-tag').addEventListener('change', renderJournal);
  $('#day-chip').addEventListener('click', () => { state.filterDay = null; renderJournal(); });

  $('#cal-prev').addEventListener('click', () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1); renderCalendar(); });
  $('#cal-next').addEventListener('click', () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1); renderCalendar(); });
  $('#cal-grid').addEventListener('click', (ev) => {
    const cell = ev.target.closest('.cal-day.has');
    if (!cell) return;
    state.filterDay = cell.dataset.day;
    showView('journal');
  });

  $('#entry-form').addEventListener('submit', saveEditor);
  $('#entry-form').elements.tags.addEventListener('input', renderTagSuggestions);
  $('#tag-suggestions').addEventListener('click', (ev) => {
    const chip = ev.target.closest('[data-tag]');
    if (!chip) return;
    const input = $('#entry-form').elements.tags;
    input.value = [...parseTags(input.value), chip.dataset.tag].join(', ');
    renderTagSuggestions();
  });
  $('#discard-btn').addEventListener('click', discardEditor);
  $('#entry-form').elements.transcript.addEventListener('input', () => { if (state.editing) state.editing.transcriptDirty = true; });
  $('#editor-transcribe').addEventListener('click', () => {
    const entry = state.entries.find((e) => e.id === state.editing?.id);
    if (entry) { entry.txAttempts = 0; queueTranscription(entry); }
  });

  $('#tx-model').addEventListener('change', renderTxSettings);
  $('#improve-with').addEventListener('change', async (ev) => {
    if (ev.target.value === 'turbo') {
      const gpu = await gpuSupport();
      $('#gpu-result').textContent = gpu.reason;
      if (!gpu.ok) { ev.target.value = 'small'; toast('Turbo needs a supported graphics chip. Staying with Small.'); return; }
    }
    state.tx = { ...state.tx, improveWith: ev.target.value };
    await saveTxSettings();
  });
  $('#gpu-test').addEventListener('click', async () => {
    $('#gpu-result').textContent = 'Checking…';
    const gpu = await gpuSupport();
    $('#gpu-result').textContent = gpu.reason;
  });
  $('#editor-improve').addEventListener('click', () => {
    const entry = state.entries.find((e) => e.id === state.editing?.id);
    if (entry) improveEntry(entry);
  });
  $('#fix-form').addEventListener('submit', onAddFix);
  $('#fix-apply').addEventListener('click', applyFixesToExisting);
  $('#fix-list').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-fix]');
    if (!btn) return;
    state.wordFixes.splice(Number(btn.dataset.fix), 1);
    await saveWordFixes();
  });
  $('#mic-select').addEventListener('change', async (ev) => {
    state.micId = ev.target.value;
    await db.setMeta('micId', state.micId);
    toast('Microphone saved. Record a short test to check it.');
  });
  $('#silence-open-settings').addEventListener('click', () => { $('#editor').close(); showView('settings'); });
  $('#tx-enable').addEventListener('click', enableTranscription);
  $('#tx-disable').addEventListener('click', disableTranscription);
  $('#tx-delete').addEventListener('click', deleteModels);
  $('#tx-auto').addEventListener('change', async (ev) => { state.tx.auto = ev.target.checked; await saveTxSettings(); });
  $('#tx-backlog').addEventListener('click', () => { untranscribed().forEach((e) => queueTranscription(e)); });
  $('#editor').addEventListener('close', () => {
    $('#editor-audio').pause();
    if (state.editorUrl) URL.revokeObjectURL(state.editorUrl);
    state.editorUrl = null;
    state.editing = null;
  });

  $('#lock-form').addEventListener('submit', onUnlock);
  $('#pin-form').addEventListener('submit', onPinSave);
  $('#pin-remove').addEventListener('click', onPinRemove);
  $('#lock-now').addEventListener('click', lock);
  $('#encrypt-on').addEventListener('click', enableEncryption);
  $('#encrypt-off').addEventListener('click', () => disableEncryption($('#pin-current').value));
  $('#privacy-on').addEventListener('change', (ev) => {
    try { localStorage.setItem('vj-privacy', ev.target.checked ? '1' : '0'); } catch { /* fine */ }
  });

  $('#export-btn').addEventListener('click', exportZip);
  $('#export-text').addEventListener('click', exportText);
  $('#prompt-packs').addEventListener('change', async (ev) => {
    const key = ev.target.dataset.pack;
    if (!key) return;
    const packs = new Set(state.promptPacks || Object.keys(PACKS));
    if (ev.target.checked) packs.add(key); else packs.delete(key);
    state.promptPacks = Object.keys(PACKS).filter((k) => packs.has(k));
    await savePromptSettings();
  });
  $('#custom-prompt-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = $('#custom-prompt').value.trim();
    if (!text) return;
    state.customPrompts = [...(state.customPrompts || []), text];
    $('#custom-prompt').value = '';
    await savePromptSettings();
    toast('Prompt added.');
  });
  $('#custom-prompt-list').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-remove-prompt]');
    if (!btn) return;
    state.customPrompts.splice(Number(btn.dataset.removePrompt), 1);
    await savePromptSettings();
  });
  $('#reminder-on').addEventListener('change', (ev) => setReminder(ev.target.checked));
  $('#reminder-time').addEventListener('change', () => setReminder(state.reminder.on));
  $('#on-this-day').addEventListener('click', onListClick);
  $('#themes').addEventListener('click', (ev) => {
    const w = ev.target.closest('[data-word]');
    if (!w) return;
    state.filterDay = null;
    showView('journal');
    $('#search').value = w.dataset.word;
    renderJournal();
  });
  $('#recap-open').addEventListener('click', async () => {
    state.recapSeen = $('#recap-banner').dataset.week;
    await db.setMeta('recapSeen', state.recapSeen);
    $('#recap-banner').hidden = true;
    showView('calendar');
  });
  $('#share-btn').addEventListener('click', shareZip);
  $('#backup-now').addEventListener('click', () => (canShareFiles() ? shareZip() : exportZip()));
  $('#backup-later').addEventListener('click', async () => {
    state.backupSnoozeUntil = Date.now() + 3 * 86_400_000;
    await db.setMeta('backupSnoozeUntil', state.backupSnoozeUntil);
    renderBackupBanner();
  });
  $('#import-file').addEventListener('change', (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (file) importZip(file);
  });
  $('#persist-btn').addEventListener('click', async () => {
    toast((await requestPersistence()) ? 'Storage is now protected.' : 'The browser declined. Installing the app usually helps.');
    renderSettings();
  });

  window.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault();
    installPrompt = ev;
    $('#install-btn').hidden = false;
  });
  $('#install-btn').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $('#install-btn').hidden = true;
  });

  const syncOnline = () => { $('#offline-pill').hidden = navigator.onLine; };
  window.addEventListener('online', syncOnline);
  window.addEventListener('offline', syncOnline);
  syncOnline();

  window.addEventListener('blur', () => coverScreen(true));
  window.addEventListener('focus', () => coverScreen(false));
  window.addEventListener('pagehide', () => coverScreen(true));
  window.addEventListener('pageshow', () => coverScreen(false));
  document.addEventListener('visibilitychange', () => {
    coverScreen(document.hidden);
    if (!document.hidden) renderGreeting();
    if (!document.hidden && rec.mr) keepScreenOn(true); // the lock is dropped when the app is hidden
    if (document.hidden) state.hiddenAt = Date.now();
    else if (state.hiddenAt && Date.now() - state.hiddenAt > AUTO_LOCK_MS && !rec.mr) lock();
  });
  window.addEventListener('resize', () => { if (!rec.mr) drawIdleWave(); });
  window.addEventListener('beforeunload', (ev) => { if (rec.mr) ev.preventDefault(); });
}

async function init() {
  if ('serviceWorker' in navigator) {
    // When a new version is published, the new service worker takes over and we reload
    // once so you get it right away instead of on the next launch.
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading || rec.mr) return;
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
      })
      .catch((err) => console.warn('Service worker failed', err));
  }
  applyTheme(readTheme());
  renderGreeting();
  renderMoodPicker();
  bindEvents();
  renderPrompt();
  drawIdleWave();
  try {
    state.hasPin = !!(await db.getMeta('pin'));
    state.encryption = (await db.getMeta('encryption')) || null;
    if (state.hasPin) lock();
    state.tx = { ...state.tx, ...(await db.getMeta('transcription')) };
    // An older model stays in use until its word-timing replacement has downloaded.
    if (!MODELS[state.tx.model] && !LEGACY_MODELS[state.tx.model]) state.tx.model = DEFAULT_MODEL;
    state.txNeedsUpdate = state.tx.enabled && !!LEGACY_MODELS[state.tx.model];
    state.micId = (await db.getMeta('micId')) || '';
    state.wordFixes = (await db.getMeta('wordFixes')) || [];
    state.lastExport = (await db.getMeta('lastExport')) || 0;
    state.backupSnoozeUntil = (await db.getMeta('backupSnoozeUntil')) || 0;
    state.promptPacks = (await db.getMeta('promptPacks')) || null;
    state.customPrompts = (await db.getMeta('customPrompts')) || [];
    state.reminder = (await db.getMeta('reminder')) || { on: false, time: '20:00' };
    state.recapSeen = (await db.getMeta('recapSeen')) || null;
    state.fixesDeclined = (await db.getMeta('fixesDeclined')) || [];
    renderPrompt();
  } catch (err) {
    toast(`Storage is unavailable: ${err.message || err}`);
  }
  // Opened from the "Record now" home-screen shortcut: start recording straight away.
  const params = new URLSearchParams(location.search);
  if (params.get('action') === 'record') {
    history.replaceState(null, '', location.pathname);
    if (state.hasPin) state.pendingRecord = true;
  }
  if (state.txNeedsUpdate) updateModelInBackground();
  window.addEventListener('online', retryFailedTranscriptions);
  // An encrypted journal can only be read once the PIN has unlocked the key.
  if (!state.encryption) await loadJournal();
  if (params.get('action') === 'record' && !state.hasPin) startRecording();
}

/** Read the notes and bring the screens up to date. */
async function loadJournal() {
  try {
    state.entries = await db.allEntries();
    await recoverDraft();
    // Give older transcribed notes a title and summary once.
    for (const e of state.entries) {
      if (e.transcript && !e.title && e.summary === undefined) { addAutoText(e); await db.putEntry(e); }
    }
  } catch (err) {
    toast(`Couldn't read your notes: ${err.message || err}`);
  }
  state.loaded = true;
  renderStreakBadge();
  renderRecent();
  renderBackupBanner();
  renderRecapBanner();
  rerenderActive();
  if (state.tx.enabled) {
    state.entries
      .filter((e) => e.transcriptStatus === 'queued' || e.transcriptStatus === 'working')
      .reverse()
      .forEach((e) => queueTranscription(e));
    retryFailedTranscriptions();
  }
}

init();
