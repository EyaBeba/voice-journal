import * as db from './db.js';
import { createZip, readZip } from './zip.js';
import { PROMPTS } from './prompts.js';

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

const state = {
  entries: [],
  filterDay: null,
  calMonth: startOfMonth(new Date()),
  promptShift: 0,
  editing: null, // { id, isNew, prompt }
  editorUrl: null,
  hasPin: false,
  hiddenAt: 0,
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
  badge.textContent = `🔥 ${current}`;
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
}

/* ---------- prompts ---------- */
function todaysPrompt() {
  const now = new Date();
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86_400_000);
  return PROMPTS[(dayOfYear + state.promptShift) % PROMPTS.length];
}
const renderPrompt = () => { $('#prompt-text').textContent = todaysPrompt(); };

/* ---------- recording ---------- */
const rec = { mr: null, stream: null, chunks: [], start: 0, timer: null, ctx: null, analyser: null, raf: 0 };

function pickMime() {
  const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];
  return types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast('This browser cannot record audio.');
    return;
  }
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    toast('Microphone access was blocked. Allow it in your browser settings.');
    return;
  }
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
  cleanupRecorder();
  if (!blob.size || durationMs < 500) { toast('Too short, nothing saved.'); return; }

  // Save immediately so nothing is lost; details are added afterwards.
  const entry = {
    id: uid(), createdAt: start, durationMs, mime: type,
    title: '', mood: null, tags: [], prompt: todaysPrompt(),
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
  g.lineWidth = 2 * (window.devicePixelRatio || 1);
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
const player = { audio: new Audio(), id: null, url: null };

function stopPlayer() {
  player.audio.pause();
  if (player.url) URL.revokeObjectURL(player.url);
  Object.assign(player, { id: null, url: null });
  syncPlayerUI();
}

function togglePlay(id) {
  if (player.id === id) {
    if (player.audio.paused) player.audio.play().catch(() => toast("Couldn't play this recording."));
    else player.audio.pause();
    return;
  }
  stopPlayer();
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) return;
  player.url = URL.createObjectURL(blobOf(entry));
  player.audio.src = player.url;
  player.id = id;
  player.audio.play().catch(() => toast("Couldn't play this recording."));
}

function syncPlayerUI() {
  $$('.entry').forEach((card) => {
    const active = card.dataset.id === player.id;
    const playing = active && !player.audio.paused;
    card.classList.toggle('playing', playing);
    const btn = $('.play', card);
    btn.textContent = playing ? '❚❚' : '▶';
    btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if (!active) $('.progress i', card).style.width = '0';
  });
}

player.audio.addEventListener('play', syncPlayerUI);
player.audio.addEventListener('pause', syncPlayerUI);
player.audio.addEventListener('ended', () => { player.audio.currentTime = 0; syncPlayerUI(); });
player.audio.addEventListener('timeupdate', () => {
  const entry = state.entries.find((e) => e.id === player.id);
  const bar = $(`.entry[data-id="${CSS.escape(player.id || '')}"] .progress i`);
  if (!entry || !bar) return;
  // Recorded webm often reports duration=Infinity, so use the duration we measured.
  const total = Number.isFinite(player.audio.duration) ? player.audio.duration * 1000 : entry.durationMs;
  bar.style.width = `${Math.min(100, (player.audio.currentTime * 1000 / total) * 100)}%`;
});

/* ---------- entry list ---------- */
function entryCard(e) {
  const mood = moodOf(e.mood);
  return `
    <article class="entry" data-id="${esc(e.id)}">
      <button class="play" type="button" data-action="play" aria-label="Play">▶</button>
      <div class="entry-main">
        <div class="entry-title">${esc(e.title || 'Untitled entry')}</div>
        <div class="entry-meta">${fmtTime(e.createdAt)} · ${fmtDuration(e.durationMs)}</div>
        ${e.prompt ? `<div class="entry-prompt">“${esc(e.prompt)}”</div>` : ''}
        ${e.tags.length ? `<div class="entry-tags">${e.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : ''}
        <div class="progress"><i></i></div>
      </div>
      <div class="entry-actions">
        <span class="entry-mood" title="${mood ? mood.l : 'No mood'}">${mood ? mood.e : ''}</span>
        <button class="icon-btn" type="button" data-action="edit" aria-label="Edit entry">✎</button>
      </div>
    </article>`;
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
    && (!q || [e.title, e.prompt, ...e.tags].join(' ').toLowerCase().includes(q)));

  const chip = $('#day-chip');
  chip.hidden = !state.filterDay;
  if (state.filterDay) chip.textContent = `${fmtDayHeading(state.filterDay)} ✕`;

  const empty = state.entries.length
    ? '<div class="empty"><div class="big">🔍</div><p>No entries match these filters.</p></div>'
    : '<div class="empty"><div class="big">🎙️</div><p>No entries yet.<br>Record your first voice note on the Record tab.</p></div>';
  renderList($('#entry-list'), list, empty);
}

function onListClick(ev) {
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

  if (state.editorUrl) URL.revokeObjectURL(state.editorUrl);
  state.editorUrl = URL.createObjectURL(blobOf(entry));
  $('#editor-audio').src = state.editorUrl;

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
    [`🔥 ${current}`, 'Current streak (days)'],
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
    const { audio, ...rest } = e;
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
async function renderSettings() {
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

function bindEvents() {
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $('#rec-btn').addEventListener('click', () => (rec.mr ? stopRecording() : startRecording()));
  $('#prompt-shuffle').addEventListener('click', () => { state.promptShift++; renderPrompt(); });

  $('#recent').addEventListener('click', onListClick);
  $('#entry-list').addEventListener('click', onListClick);
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
    if (document.hidden) state.hiddenAt = Date.now();
    else if (state.hiddenAt && Date.now() - state.hiddenAt > AUTO_LOCK_MS && !rec.mr) lock();
  });
  window.addEventListener('resize', () => { if (!rec.mr) drawIdleWave(); });
  window.addEventListener('beforeunload', (ev) => { if (rec.mr) ev.preventDefault(); });
}

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service worker failed', err));
  }
  renderMoodPicker();
  bindEvents();
  renderPrompt();
  drawIdleWave();
  try {
    state.hasPin = !!(await db.getMeta('pin'));
    if (state.hasPin) lock();
    state.entries = await db.allEntries();
  } catch (err) {
    toast(`Storage is unavailable: ${err.message || err}`);
  }
  renderStreakBadge();
  renderRecent();
}

init();
