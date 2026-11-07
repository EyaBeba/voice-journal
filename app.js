import * as db from './db.js';
import { createZip, readZip } from './zip.js';
import { PROMPTS } from './prompts.js';
import { MODELS, DEFAULT_MODEL, LEGACY_MODELS, currentModelFor, downloadedModels, loadModel, transcribe } from './transcribe.js';

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
const APP_VERSION = 8;
const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.5"/><rect x="14" y="5" width="4" height="14" rx="1.5"/></svg>';
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
  const active = $('.view.active')?.id.replace('view-', '');
  if (active === 'record') renderRecent();
  if (active === 'journal') renderJournal();
  if (active === 'calendar') renderCalendar();
  if (active === 'settings') renderSettings();
}

/* ---------- prompts ---------- */
function todaysPrompt() {
  const now = new Date();
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86_400_000);
  return PROMPTS[(dayOfYear + state.promptShift) % PROMPTS.length];
}
const renderPrompt = () => { $('#prompt-text').textContent = todaysPrompt(); };

/* ---------- recording ---------- */
const rec = { mr: null, stream: null, chunks: [], start: 0, timer: null, ctx: null, analyser: null, raf: 0, peak: 0, frames: 0 };

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
  rec.mr.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
  rec.mr.onstop = onRecordingStop;
  rec.mr.start(1000);
  rec.start = Date.now();

  const btn = $('#rec-btn');
  btn.classList.add('recording');
  btn.setAttribute('aria-label', 'Stop recording');
  $('#rec-hint').textContent = 'Recording… tap to stop';
  $('#timer').textContent = '0:00';
  rec.timer = setInterval(() => { $('#timer').textContent = fmtDuration(Date.now() - rec.start); }, 250);

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

function cleanupRecorder() {
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
  const durationMs = Date.now() - rec.start;
  const type = rec.mr?.mimeType || 'audio/webm';
  const blob = new Blob(rec.chunks, { type });
  const start = rec.start;
  // Peak is 0..128. Near zero for the whole recording means the mic sent silence.
  const silent = rec.frames > 10 && rec.peak <= 2;
  cleanupRecorder();
  if (!blob.size || durationMs < 500) { toast('Too short, nothing saved.'); return; }

  // Save immediately so nothing is lost; details are added afterwards.
  const entry = {
    id: uid(), createdAt: start, durationMs, mime: type,
    title: '', mood: null, tags: [], prompt: todaysPrompt(),
    transcript: '', transcriptStatus: state.tx.enabled && state.tx.auto ? 'queued' : null,
    audio: await blob.arrayBuffer(),
  };
  try {
    await db.putEntry(entry);
  } catch (err) {
    toast(`Could not save: ${err.message || err}`);
    return;
  }
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
  player.id = id;
  return true;
}

function togglePlay(id) {
  if (player.id === id) {
    if (player.audio.paused) player.audio.play().catch(() => toast("Couldn't play this recording."));
    else player.audio.pause();
    return;
  }
  if (startPlayer(id)) player.audio.play().catch(() => toast("Couldn't play this recording."));
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
        <div class="entry-meta">${fmtTime(e.createdAt)} · ${fmtDuration(e.durationMs)}</div>
        ${transcriptLine(e)}
        ${e.prompt ? `<div class="entry-prompt">“${esc(e.prompt)}”</div>` : ''}
        ${e.tags.length ? `<div class="entry-tags">${e.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : ''}
        <div class="progress"><i></i></div>
      </div>
      <div class="entry-actions">
        <span class="entry-mood" title="${mood ? mood.l : 'No mood'}">${mood ? mood.e : ''}</span>
        <button class="icon-btn" type="button" data-action="edit" aria-label="Edit entry">${EDIT_ICON}</button>
      </div>
    </article>`;
}

function transcriptLine(e) {
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

function renderRecent() {
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
    && (!tag || e.tags.includes(tag))
    && (!q || [e.title, e.prompt, e.transcript, ...e.tags].join(' ').toLowerCase().includes(q)));

  const chip = $('#day-chip');
  chip.hidden = !state.filterDay;
  if (state.filterDay) chip.textContent = `${fmtDayHeading(state.filterDay)} ✕`;

  const empty = state.entries.length
    ? '<div class="empty"><div class="big">🔍</div><p>No entries match these filters.</p></div>'
    : '<div class="empty"><div class="big">🎙️</div><p>No entries yet.<br>Record your first voice note on the Record tab.</p></div>';
  renderList($('#entry-list'), list, empty);
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
  state.editing = { id: entry.id, isNew, prompt: entry.prompt };
  const f = $('#entry-form');
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
    if (state.editing.transcriptDirty) {
      const edited = f.elements.transcript.value.trim();
      if (edited !== entry.transcript) { entry.segments = null; entry.words = null; }
      entry.transcript = edited;
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

async function runQueue() {
  if (state.txBusy) return;
  state.txBusy = true;
  try {
    while (state.txQueue.length && state.tx.enabled) {
      const entry = state.entries.find((e) => e.id === state.txQueue[0]);
      if (entry) {
        entry.transcriptStatus = 'working';
        onTranscriptChange(entry);
        try {
          const { text, words, segments } = await transcribeWithFallback(entry.audio);
          entry.transcript = applyWordFixes(text);
          entry.words = words?.length ? fixWords(words) : null;
          entry.segments = segments?.length ? segments.map((x) => ({ ...x, t: applyWordFixes(x.t) })) : null;
          entry.transcriptStatus = 'done';
          delete entry.transcriptError;
          delete entry.txAttempts;
        } catch (err) {
          console.warn('Transcription failed', err);
          entry.transcriptStatus = 'error';
          entry.txAttempts = (entry.txAttempts || 0) + 1;
          entry.transcriptError = navigator.onLine
            ? (err.message || String(err))
            : 'no transcription model is saved on this phone yet. It will try again when you are online.';
        }
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
function renderCalendar() {
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
  if (await checkPin($('#lock-pin').value)) {
    $('#lock').hidden = true;
    return;
  }
  const card = $('#lock-form');
  $('#lock-error').textContent = 'Wrong PIN, try again.';
  $('#lock-pin').value = '';
  card.classList.remove('shake');
  void card.offsetWidth;
  card.classList.add('shake');
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
  await db.setMeta('pin', { salt, hash: await hashPin(next, salt) });
  state.hasPin = true;
  $('#pin-form').reset();
  toast('PIN saved. The app will lock on open and after a minute away.');
  renderSettings();
}

async function onPinRemove() {
  const err = $('#pin-error');
  if (!(await checkPin($('#pin-current').value))) { err.textContent = 'Enter your current PIN to remove it.'; return; }
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
  const files = [];
  const meta = [];
  for (const e of state.entries) {
    const name = `audio/${dayKey(e.createdAt)}_${e.id}.${extFor(e.mime)}`;
    files.push({ name, data: new Uint8Array(e.audio) });
    const { audio, transcriptStatus, transcriptError, ...rest } = e;
    meta.push({ ...rest, audioFile: name });
  }
  const manifest = { app: 'voice-journal', version: 1, exportedAt: new Date().toISOString(), entries: meta };
  files.unshift({ name: 'journal.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
  download(createZip(files), `voice-journal-${dayKey(Date.now())}.zip`);
  await db.setMeta('lastExport', Date.now());
  renderSettings();
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
        words: Array.isArray(m.words)
          ? m.words.filter((x) => x && typeof x.w === 'string' && typeof x.s === 'number')
            .map((x) => ({ w: x.w, s: x.s, e: typeof x.e === 'number' ? x.e : null }))
          : null,
        segments: Array.isArray(m.segments)
          ? m.segments.filter((x) => x && typeof x.t === 'string' && typeof x.s === 'number')
            .map((x) => ({ t: x.t, s: x.s, e: typeof x.e === 'number' ? x.e : null }))
          : null,
        transcriptStatus: typeof m.transcript === 'string' && m.transcript ? 'done' : null,
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

  const last = await db.getMeta('lastExport');
  $('#backup-status').textContent = last
    ? `Last backup: ${new Date(last).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.`
    : 'No backup yet. Export now and then so a lost phone or cleared browser doesn\'t take your journal with it.';

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

  $('#export-btn').addEventListener('click', exportZip);
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

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) renderGreeting();
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
    if (state.hasPin) lock();
    state.entries = await db.allEntries();
    state.tx = { ...state.tx, ...(await db.getMeta('transcription')) };
    // An older model stays in use until its word-timing replacement has downloaded.
    if (!MODELS[state.tx.model] && !LEGACY_MODELS[state.tx.model]) state.tx.model = DEFAULT_MODEL;
    state.txNeedsUpdate = state.tx.enabled && !!LEGACY_MODELS[state.tx.model];
    state.micId = (await db.getMeta('micId')) || '';
    state.wordFixes = (await db.getMeta('wordFixes')) || [];
  } catch (err) {
    toast(`Storage is unavailable: ${err.message || err}`);
  }
  renderStreakBadge();
  renderRecent();
  if (state.txNeedsUpdate) updateModelInBackground();
  window.addEventListener('online', retryFailedTranscriptions);
  if (state.tx.enabled) {
    state.entries
      .filter((e) => e.transcriptStatus === 'queued' || e.transcriptStatus === 'working')
      .reverse()
      .forEach((e) => queueTranscription(e));
    retryFailedTranscriptions();
  }
}

init();
