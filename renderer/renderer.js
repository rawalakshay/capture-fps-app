'use strict';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';

const state = {
  queue: [],          // this session's recordings: { path, name, stem, info, size, defaultOutDir, status, result, opts, error, note }
  library: [],        // every recording ever added, persisted; see upsertLibrary()
  current: null,      // the queue item open in the Workspace
  runningItem: null,  // the queue item a job is working on
  run: { done: 0 },   // finished items of the current queue run
  outBase: null,      // a folder the user chose; null = next to each video
  toolsOk: false,
  running: false,
  cancelled: false,
  result: null,       // state.current's result, for the actions that read it
  opts: null,
  lastAnalysed: null, // video path the main process can render or preview again
  previewAt: 0,       // seconds into the analysed span
  range: null,        // timeline selection [start, end] in clip seconds, mirrored in the In and Out fields
  gpu: false,
  gpuReady: Promise.resolve(),
};
const fileName = (p) => p.split(/[\\/]/).pop();

// ---------- helpers ----------

function fmtDuration(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtStamp(s) {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}

function fmtSize(bytes) {
  if (!bytes) return null;
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

function fmtAgo(ts) {
  if (!ts) return '';
  const d = (Date.now() - ts) / 1000;
  if (d < 90) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  if (d < 6 * 86400) return new Date(ts).toLocaleDateString(undefined, { weekday: 'short' });
  return new Date(ts).toLocaleDateString();
}

const fmtFormat = (info) => `${info.height}p${Math.round(info.hz)}`;

function level(fps, target) {
  if (fps >= 0.95 * target) return 'ok';
  if (fps >= 0.8 * target) return 'warn';
  return 'bad';
}

const VIEWS = ['view-library', 'view-work', 'view-compare', 'view-error'];
function show(view) {
  for (const id of VIEWS) $(id).hidden = id !== view;
  $('inspector').hidden = view !== 'view-work';
  $('nav-library').classList.toggle('on', view === 'view-library');
  $('nav-compare').classList.toggle('on', view === 'view-compare');
  $('rail-dot').hidden = !state.running || view === 'view-library';
  // The charts had no size while hidden.
  if (view === 'view-work') { drawChart(); fitFrame(); }
  if (view === 'view-compare') drawCompareChart();
}
const viewIs = (id) => !$(id).hidden;

function el(tag, attrs = {}, text) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** The items the next Analyse would run: everything waiting, plus the open recording. */
function todoItems() {
  return state.queue.filter((q) => q.status === 'waiting' || q === state.current);
}

function updateRunButton() {
  const todo = todoItems();
  const ready = state.toolsOk && todo.length > 0;
  $('run').disabled = !ready || state.running;
  $('run').hidden = state.running;
  $('cancel').hidden = !state.running;
  $('run').textContent = todo.length > 1 ? `Analyse ${todo.length} recordings` : state.range ? 'Analyse selection' : 'Analyse';
  $('analyse-sel').disabled = $('run').disabled;
  $('out-change').disabled = !state.queue.length || state.running;
  $('run-banner').hidden = !state.running;
  $('prog-line').hidden = !state.running;
  $('queue-run').hidden = state.running || !state.toolsOk || !state.queue.some((q) => q.status === 'waiting');
  $('queue-stop').hidden = !state.running;
  $('rail-dot').hidden = !state.running || viewIs('view-library');
  const out = state.current ? (state.outBase || state.current.defaultOutDir) : 'Next to the video';
  $('out-path').textContent = out;
  $('out-path').title = out;
  // Render and preview need the analysis the main process still holds: the last one.
  const current = state.result && state.result.video === state.lastAnalysed;
  for (const id of ['render-again', 'preview']) {
    $(id).disabled = state.running || !current;
    $(id).title = current || !state.result ? $(id).dataset.title || ($(id).dataset.title = $(id).title) : 'Analyse this recording again to render or preview it';
  }
  $('copy-summary').disabled = !state.result;
  const hint = $('run-hint');
  hint.classList.remove('lv-bad');
  if (!state.toolsOk) hint.textContent = 'ffmpeg is not ready';
  else if (state.running) hint.textContent = 'Working…';
  else if (!todo.length) hint.textContent = 'Choose a recording first';
  else { // measuring takes about the clip's length, rendering about as much again
    const a = parseTime($('opt-start').value) || 0, b = parseTime($('opt-end').value) || Infinity;
    const secs = todo.reduce((t, q) => t + Math.max(0, Math.min(b, q.info.duration) - a), 0) * ($('opt-render').checked ? 2 : 1);
    hint.textContent = `Ctrl+Enter · about ${fmtDuration(secs)}`;
  }
}

// Remember a radio group's choice between sessions (a convenience only).
function remember(name, key) {
  try {
    const saved = localStorage.getItem(key);
    const radio = saved && document.querySelector(`input[name="${name}"][value="${saved}"]`);
    if (radio && !radio.disabled) radio.checked = true;
  } catch (_) { /* storage unavailable: keep the default */ }
  for (const r of document.querySelectorAll(`input[name="${name}"]`)) {
    r.addEventListener('change', () => {
      try { localStorage.setItem(key, r.value); } catch (_) { /* ignore */ }
    });
  }
}

function radioValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`).value;
}

// ---------- tools ----------

async function checkTools() {
  window.api.version().then((v) => { $('version').textContent = $('version-main').textContent = `v${v}`; });
  const t = await window.api.tools();
  state.toolsOk = t.ok;
  const n = $('tools');
  if (t.ok) {
    n.textContent = 'ffmpeg ready';
    n.className = 'tools mono ok';
  } else {
    n.textContent = t.reason;
    n.className = 'tools mono bad';
    n.title = 'Install it with: winget install Gyan.FFmpeg, then restart the app.';
  }
  updateRunButton();
  state.gpuReady = checkGpu();
}

async function checkGpu() {
  const g = await window.api.gpu();
  state.gpu = g.nvenc;
  if (g.nvenc) {
    $('enc-gpu-sub').textContent = 'NVENC is about 5× faster than x264.';
    $('enc-gpu').checked = true; // the default when the GPU can do it
    $('tools').textContent = 'ffmpeg ready · NVENC';
  } else {
    $('enc-gpu-sub').textContent = `No NVIDIA GPU here: ${g.reason || 'x264 only'}.`;
    $('enc-gpu').disabled = true;
    document.querySelector('label[for="enc-gpu"]').title = g.reason || 'No NVIDIA GPU found';
    $('enc-cpu').checked = true;
  }
  remember('opt-enc', 'encoder');
  syncSummaries();
  const v = await window.api.vulkan();
  if (!v.ok) {
    const o = $('opt-upscaler').querySelector('option[value="fsrcnnx"]');
    o.disabled = true;
    o.textContent = 'FSRCNNX (no Vulkan GPU here)';
    o.title = v.reason || 'No Vulkan device';
    if ($('opt-upscaler').value === 'fsrcnnx') $('opt-upscaler').value = 'lanczos';
  }
}

// ---------- library ----------

function loadLibrary() {
  try { return JSON.parse(localStorage.getItem('library') || '[]') || []; } catch (_) { return []; }
}
function saveLibrary() {
  try { localStorage.setItem('library', JSON.stringify(state.library)); } catch (_) { /* ignore: the session list still works */ }
}
const libEntry = (path) => state.library.find((e) => e.path === path);

/** One library entry per path, newest first; a queue item's result adds the score fields the cards show. */
function upsertLibrary(item, extra = {}) {
  let e = libEntry(item.path);
  if (!e) {
    e = { path: item.path, name: item.name, addedAt: Date.now() };
    state.library.unshift(e);
  }
  Object.assign(e, { name: item.name, info: item.info || e.info, size: item.size || e.size, error: null }, extra);
  const r = item.result;
  if (r) {
    const s = r.summary;
    Object.assign(e, {
      analysedAt: Date.now(), held: Math.max(0, Math.min(100, Math.round(100 - s.frames_missing_target_pct))), target: s.target_fps,
      avg: s.avg_fps, low1: s.low_1pct_fps, hitches: s.hitches.count, seconds: s.capture.seconds,
      outDir: r.outDir, overlayVideo: r.overlayVideo, start: (item.opts && item.opts.start) || null, end: (item.opts && item.opts.end) || null,
    });
  }
  saveLibrary();
}

const libNodes = new Map(); // path -> the card parts a progress event updates

function renderLibrary() {
  const grid = $('lib-grid');
  grid.replaceChildren();
  libNodes.clear();
  const list = state.library;
  $('lib-empty').hidden = list.length > 0;
  const running = state.queue.filter((q) => q.status === 'measuring' || q.status === 'waiting').length;
  $('lib-count').textContent = !list.length ? 'No recordings yet'
    : `${list.length} recording${list.length === 1 ? '' : 's'}` + (running ? ` · ${running} in queue` : '');
  for (const e of list) grid.appendChild(cardFor(e));
  updateQueueBar();
}

const STEP_NAME = { measure: 'Measuring', analyse: 'Analysing', render: 'Rendering' };

function cardFor(e) {
  const q = state.queue.find((x) => x.path === e.path);
  const status = q ? q.status : e.error ? 'error' : e.analysedAt ? 'done' : 'idle';
  const card = node('article', `card${status === 'measuring' ? ' running' : status === 'error' ? ' failed' : ''}`);
  const main = node('button', 'card-main');
  main.type = 'button';
  main.title = e.path;
  const thumb = node('div', 'thumb');
  if (e.thumb) {
    const img = node('img');
    img.src = e.thumb;
    img.alt = '';
    thumb.appendChild(img);
  } else if (e.held != null) {
    const hero = node('div', 'hero');
    hero.append(node('b', 'mono', String(Math.round(e.avg))), node('span', '', `1% LOW ${Math.round(e.low1)}`));
    thumb.appendChild(hero);
  }
  const badge = node('span', 'badge');
  if (status === 'measuring') { badge.className = 'badge lv-ok'; badge.append(node('span', 'dot dot-run'), 'Measuring'); }
  else if (status === 'error') { badge.className = 'badge lv-bad'; badge.textContent = 'Failed'; }
  else if (e.held != null) { badge.className = `badge lv-${e.held >= 95 ? 'ok' : e.held >= 80 ? 'warn' : 'bad'}`; badge.textContent = `${e.held}% on ${e.target}`; }
  else badge.hidden = true;
  const bar = node('div', 'thumb-bar');
  bar.hidden = status !== 'measuring';
  const fill = node('i');
  bar.appendChild(fill);
  thumb.append(badge, bar, node('span', 'dur mono', e.info ? fmtDuration(e.info.duration) : '—'));
  const text = node('div', 'card-text');
  text.append(node('div', 'card-name', e.name));
  const meta = [e.info ? fmtFormat(e.info) : 'unknown', fmtSize(e.size), fmtAgo(e.analysedAt || e.addedAt)].filter(Boolean).join(' · ');
  text.append(node('div', 'card-meta mono', meta));
  main.append(thumb, text);
  main.addEventListener('click', () => openEntry(e));
  const st = node('div', 'card-st');
  const stText = node('span');
  const words = {
    waiting: 'Waiting in queue', measuring: 'Measuring…', cancelled: 'Cancelled', idle: 'Not analysed yet',
    error: `Failed: ${(q && q.error) || e.error || 'unknown error'}`,
    done: e.overlayVideo ? `Rendered · ${e.hitches ? `${e.hitches} hitch${e.hitches === 1 ? '' : 'es'}` : 'no hitches'}` : 'Analysed · not rendered',
  };
  if (status === 'done' && e.overlayVideo) {
    const ok = el('svg', { class: 'ico', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    ok.appendChild(el('path', { d: 'M5 12l5 5L20 7' }));
    st.appendChild(ok);
  }
  stText.textContent = words[status];
  stText.title = words[status];
  st.appendChild(stText);
  if (status === 'error' || status === 'cancelled') {
    const retry = node('button', 'btn btn-xs', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', () => retryEntry(e));
    st.appendChild(retry);
  }
  card.append(main, st);
  libNodes.set(e.path, { status: stText, badge, fill });
  return card;
}

function updateQueueBar() {
  const waiting = state.queue.filter((q) => q.status === 'waiting').length;
  $('queue-bar').hidden = !state.running && !waiting;
  $('queue-dot').hidden = !state.running;
  $('queue-head').textContent = state.running ? 'Running queue' : 'Queue';
  if (!state.running) {
    $('queue-text').textContent = `${waiting} waiting · open one and press Analyse, or run them all with the current options`;
    $('queue-fill').style.width = '0';
  }
}

/** Re-probe a failed or cancelled recording and run it. */
async function retryEntry(e) {
  const q = state.queue.find((x) => x.path === e.path);
  if (q) { q.status = 'waiting'; q.error = null; } else await addVideos([e.path], { open: false });
  if (!state.queue.some((x) => x.path === e.path)) return; // the probe failed again; the card says why
  renderLibrary();
  if (!state.running) $('run').click();
}

/** Open a card: this session's item, or an earlier run read back from its output folder. */
async function openEntry(e) {
  let q = state.queue.find((x) => x.path === e.path);
  if (!q) {
    await addVideos([e.path], { open: false });
    q = state.queue.find((x) => x.path === e.path);
    if (!q) return;
    if (e.outDir) {
      const r = await window.api.loadResult(e.outDir);
      if (r.ok) {
        q.result = { video: e.path, outDir: e.outDir, info: q.info, summary: r.result.summary, perSecond: r.result.perSecond, overlayVideo: e.overlayVideo || null };
        q.opts = { start: e.start || null, end: e.end || null };
        q.status = 'done';
      }
    }
  }
  openItem(q);
}

// ---------- choosing a video ----------

/** Where an item's files go: the chosen folder (a subfolder each when there are several), or next to the video. */
function itemOutDir(item) {
  if (!state.outBase) return item.defaultOutDir;
  return state.queue.length > 1 ? `${state.outBase}\\${item.stem}_fps` : state.outBase;
}

/** Probe each file; files already queued are skipped, unreadable ones get a failed card. The first new one opens. */
async function addVideos(paths, { open = true } = {}) {
  paths = (paths || []).filter((p) => p && !state.queue.some((q) => q.path === p));
  if (!paths.length) return;
  const added = [];
  for (const p of paths) {
    const r = await window.api.probe(p);
    if (!r.ok) {
      upsertLibrary({ path: p, name: fileName(p) }, { error: r.error });
      continue;
    }
    const item = { path: p, name: r.name, stem: r.name.replace(/\.[^.]+$/, ''), info: r.info, size: r.size, targets: r.targets, defaultOutDir: r.outDir, status: 'waiting', result: null };
    state.queue.push(item);
    upsertLibrary(item);
    added.push(item);
  }
  renderLibrary();
  updateRunButton();
  if (open && added.length) openItem(added[0]);
}

async function pickVideo() {
  const paths = await window.api.pickVideo();
  if (paths.length) addVideos(paths);
}

$('pick').addEventListener('click', pickVideo);
$('pick2').addEventListener('click', pickVideo);

$('out-change').addEventListener('click', async () => {
  const p = await window.api.pickFolder(state.outBase || (state.current && state.current.defaultOutDir));
  if (p) {
    state.outBase = p;
    updateRunButton();
  }
});

// Drag and drop anywhere on the window.
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth += 1;
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const files = e.dataTransfer ? [...e.dataTransfer.files] : [];
  if (files.length) addVideos(files.map((f) => window.api.pathForFile(f)));
});

$('opt-render').addEventListener('change', () => {
  const on = $('opt-render').checked;
  $('sec-overlay').hidden = $('sec-export').hidden = !on;
  updateRunButton();
});

// ---------- navigation ----------

$('nav-library').addEventListener('click', () => { if (viewIs('view-work') || viewIs('view-compare') || viewIs('view-error')) show('view-library'); renderLibrary(); });
$('back').addEventListener('click', () => { renderLibrary(); show('view-library'); });
$('nav-compare').addEventListener('click', openCompare);
$('compare-open').addEventListener('click', openCompare);
$('queue-run').addEventListener('click', () => $('run').click());
$('queue-stop').addEventListener('click', () => { state.cancelled = true; window.api.cancelJob(); });

// ---------- options ----------

remember('opt-pos', 'overlayPosition');
remember('opt-theme', 'overlayTheme');

// Remember a select's choice between sessions (a convenience only).
function rememberSelect(id, key) {
  const sel = $(id);
  try {
    const v = localStorage.getItem(key);
    if (v && sel.querySelector(`option[value="${v}"]`)) sel.value = v;
  } catch (_) { /* keep the default */ }
  sel.addEventListener('change', () => {
    try { localStorage.setItem(key, sel.value); } catch (_) { /* ignore */ }
  });
}
rememberSelect('opt-quality', 'quality');
rememberSelect('opt-res', 'resolution');
rememberSelect('opt-caption-pos', 'captionPosition');
rememberSelect('opt-upscaler', 'upscaler');
remember('opt-style', 'overlayStyle');

// The theme is a token set on the root element; the chart's bar colours are fixed and read in every theme.
function applyTheme() { document.documentElement.dataset.theme = $('theme').value; }
rememberSelect('theme', 'theme');
$('theme').addEventListener('change', applyTheme);
applyTheme();

// The upscaler only applies when the output is taller than the recording.
function syncUpscaler() {
  const h = Number($('opt-res').value) || 0, src = state.current ? state.current.info.height : 0;
  $('row-upscaler').hidden = !h || (src > 0 && h <= src);
}
$('opt-res').addEventListener('change', syncUpscaler);
syncUpscaler();

// The long graph: remember the toggle and the opacity; the slider follows the toggle.
try {
  const on = localStorage.getItem('longGraph'), op = localStorage.getItem('longGraphOpacity');
  if (on !== null) $('opt-long').checked = on === '1';
  if (op !== null && Number.isFinite(Number(op))) $('opt-long-opacity').value = op;
} catch (_) { /* keep the defaults */ }
function syncLongGraph() {
  const on = $('opt-long').checked;
  $('opt-long-opacity').disabled = !on;
  $('opt-long-opacity-val').textContent = `${$('opt-long-opacity').value}%`;
  try {
    localStorage.setItem('longGraph', on ? '1' : '0');
    localStorage.setItem('longGraphOpacity', $('opt-long-opacity').value);
  } catch (_) { /* ignore */ }
}
$('opt-long').addEventListener('change', syncLongGraph);
$('opt-long-opacity').addEventListener('input', syncLongGraph);
syncLongGraph();

// Remember the watermark between sessions; the text field follows the toggle.
try {
  const v = localStorage.getItem('watermark');
  if (v !== null) { $('opt-watermark').value = v; $('opt-watermark-on').checked = v !== ''; }
} catch (_) { /* keep the default */ }
function syncWatermark() {
  $('opt-watermark').disabled = !$('opt-watermark-on').checked;
  try { localStorage.setItem('watermark', $('opt-watermark-on').checked ? $('opt-watermark').value.trim() : ''); } catch (_) { /* ignore */ }
}
$('opt-watermark-on').addEventListener('change', syncWatermark);
$('opt-watermark').addEventListener('change', syncWatermark);
syncWatermark();

// Position, title and pills only exist for looks that draw them.
function syncStyle() {
  const st = radioValue('opt-style');
  $('row-pos').hidden = st === 'strip' || st === 'none';
  $('row-title').hidden = $('row-pills').hidden = st === 'none';
  syncGhosts();
}
for (const r of document.querySelectorAll('input[name="opt-style"]')) r.addEventListener('change', syncStyle);
syncStyle();

const THEME_NAME = { mono: 'Mono', aurora: 'Aurora', vice: 'Vice', classic: 'Classic' };
const STYLE_NAME = { panel: 'Panel', strip: 'Strip', glass: 'Glass', none: 'No overlay' };
const RES_NAME = { source: 'source size', 1080: '1080p', 1440: '1440p', 2160: '4K' };

// The pill chips show what they would draw; the section headers sum up their settings.
function syncSummaries() {
  const q = state.current;
  document.querySelector('label[for="opt-target-pill"]').textContent = `TARGET ${$('opt-target').value || 'auto'}`;
  document.querySelector('label[for="opt-format-pill"]').textContent = q ? fmtFormat(q.info).toUpperCase() : 'FORMAT';
  const a = $('opt-start').value.trim(), b = $('opt-end').value.trim();
  $('sum-measure').textContent = `${a || b ? `${a || '0:00'}–${b || 'end'}` : 'whole'} · target ${$('opt-target').value || 'auto'} · threshold ${$('opt-threshold').value || 'auto'}`;
  const st = radioValue('opt-style');
  $('sum-overlay').textContent = [THEME_NAME[radioValue('opt-theme')], STYLE_NAME[st], st === 'panel' || st === 'glass' ? radioValue('opt-pos') : null].filter(Boolean).join(' · ');
  $('sum-export').textContent = `${radioValue('opt-enc') === 'gpu' ? 'NVENC' : 'x264'} · ${RES_NAME[$('opt-res').value]} · ${$('opt-quality').value}`;
  syncGhosts();
  syncCaption();
}
$('inspector').addEventListener('input', syncSummaries);
$('inspector').addEventListener('change', syncSummaries);
syncSummaries();

// Typed In and Out points move the timeline handles too.
for (const id of ['opt-start', 'opt-end']) {
  $(id).addEventListener('change', () => {
    const a = parseTime($('opt-start').value), b = parseTime($('opt-end').value);
    const dur = state.current ? state.current.info.duration : 0;
    state.range = Number.isFinite(a) || Number.isFinite(b) ? [Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : dur] : null;
    drawChart();
    updateRangeReadout();
    updateRunButton();
  });
}

// ⋯ menus and the Settings popover close on a choice or a click elsewhere.
document.addEventListener('click', (e) => {
  for (const m of document.querySelectorAll('details.menu[open]')) {
    if (!m.contains(e.target) || e.target.closest('.menu-list button')) m.open = false;
  }
});
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Enter' && !$('run').disabled) $('run').click();
  if (!viewIs('view-work') || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || !state.result) return;
  const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
  if (step) { e.preventDefault(); stepScrub(step); }
  else if (e.key === '[') $('set-in').click();
  else if (e.key === ']') $('set-out').click();
  else if (e.key === 'h') $('next-hitch').click();
  else if (e.key === 'H') $('prev-hitch').click();
});

// The preview follows the overlay and export options while results are up (debounced).
let previewTimer = 0, previewDirty = false;
function schedulePreview() {
  if (!viewIs('view-work') || !state.result || state.result.video !== state.lastAnalysed) return;
  if (state.running) { previewDirty = true; return; } // drawn again once the current one is done
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 600);
}
for (const id of ['pane-look', 'opt-res', 'opt-upscaler']) $(id).addEventListener('input', schedulePreview); // encoder and quality do not change the picture

// ---------- running ----------

function readOptions() {
  const num = (id) => {
    const n = $(id);
    n.classList.remove('invalid');
    if (n.value.trim() === '') return null;
    const v = Number(n.value);
    if (!Number.isFinite(v) || v < 0) {
      n.classList.add('invalid');
      throw new Error(`${n.labels[0].textContent} must be a positive number`);
    }
    return v;
  };
  const time = (id, name) => {
    const n = $(id);
    n.classList.remove('invalid');
    if (n.value.trim() === '') return null;
    const v = parseTime(n.value);
    if (!Number.isFinite(v)) {
      n.classList.add('invalid');
      throw new Error(`${name} must be seconds or m:ss, like 112 or 1:52`);
    }
    return v;
  };
  const start = time('opt-start', 'Start');
  const end = time('opt-end', 'End');
  if (start !== null && end !== null && end <= start) {
    $('opt-end').classList.add('invalid');
    throw new Error('End must be after start');
  }
  return {
    start,
    end,
    target: $('opt-target').value ? Number($('opt-target').value) : null,
    threshold: num('opt-threshold'),
    renderVideo: $('opt-render').checked,
    ...renderOptions(),
  };
}

/** The settings that only affect the overlay video. */
function renderOptions() {
  return {
    title: todoItems().length > 1 ? null : $('opt-title').value.trim() || null,
    position: radioValue('opt-pos'),
    showTarget: $('opt-target-pill').checked,
    showFormat: $('opt-format-pill').checked,
    caption: $('opt-caption').value.trim() || null,
    captionPosition: $('opt-caption-pos').value,
    watermark: $('opt-watermark-on').checked ? $('opt-watermark').value.trim() : '',
    style: radioValue('opt-style'),
    theme: radioValue('opt-theme'),
    longGraph: $('opt-long').checked,
    longGraphOpacity: Number($('opt-long-opacity').value) / 100,
    endCard: $('opt-end-card').checked,
    encoder: radioValue('opt-enc'),
    quality: $('opt-quality').value,
    resolution: $('opt-res').value,
    upscaler: $('opt-upscaler').value,
  };
}

const STEP_OF = { measure: 'measure', analyse: 'analyse', overlay: 'render', render: 'render' };
const ORDER = ['measure', 'analyse', 'render'];

function resetSteps(renderVideo, renderOnly = false) {
  for (const li of document.querySelectorAll('.steps li')) {
    li.className = '';
    li.hidden = renderOnly ? li.dataset.step !== 'render' : li.dataset.step === 'render' && !renderVideo;
    li.querySelector('.bar-fill').style.width = '0';
    li.querySelector('.step-pct').textContent = '—';
  }
}

let phaseStart = 0;
let currentStep = null;
let chartApi = null; // setters the last drawChart() left behind: playhead, sweep

/** The Workspace while a job runs on its recording: busy scorecard, step card over the viewer, sweeping timeline. */
function renderBusy(item) {
  const renderOnly = Boolean(item.result && state.running && item.renderOnly);
  $('verdict').className = 'panel scorecard busy lv-ok';
  $('verdict-ring').style.setProperty('--pct', '0%');
  $('verdict-pct').textContent = '…';
  $('verdict-title').textContent = renderOnly ? 'Rendering video' : 'Starting…';
  $('verdict-sub').textContent = `${item.name} · ${fmtFormat(item.info)} · ${fmtDuration(item.info.duration)}`;
  $('verdict-chips').replaceChildren();
  $('run-card').hidden = false;
  $('preview-empty').hidden = true;
  $('ghosts').hidden = true;
  $('now-pill').hidden = true;
  $('viewer-hint').hidden = true;
  $('range-hint').textContent = 'The per-second numbers arrive when measuring finishes; the marker shows how far the run has got.';
  $('transport-hint').textContent = '';
  drawChart();
}

function onProgress({ phase, fraction }) {
  if (phase === 'done') return;
  if (phase === 'compare') { $('compare-status').textContent = `Exporting… ${Math.round(fraction * 100)}%`; return; }
  const step = STEP_OF[phase];
  if (step !== currentStep) {
    currentStep = step;
    phaseStart = performance.now();
  }
  const idx = ORDER.indexOf(step);
  for (const li of document.querySelectorAll('.steps li')) {
    const i = ORDER.indexOf(li.dataset.step);
    li.classList.toggle('done', i < idx);
    li.classList.toggle('active', i === idx);
    if (i < idx) {
      li.classList.remove('indeterminate');
      li.querySelector('.bar-fill').style.width = '100%';
      li.querySelector('.step-pct').textContent = 'done';
    }
  }
  const li = document.querySelector(`.steps li[data-step="${step}"]`);
  const pct = li.querySelector('.step-pct');
  const item = state.runningItem;
  const card = item && libNodes.get(item.path);
  let text;
  if (phase === 'analyse' || phase === 'overlay') {
    li.classList.add('indeterminate');
    text = phase === 'overlay' ? 'building overlay…' : '';
    pct.textContent = text;
  } else {
    li.classList.remove('indeterminate');
    li.querySelector('.bar-fill').style.width = `${(fraction * 100).toFixed(1)}%`;
    const elapsed = (performance.now() - phaseStart) / 1000;
    let eta = '';
    if (fraction > 0.03 && elapsed > 2) eta = ` · ${fmtDuration(elapsed / fraction - elapsed)} left`;
    text = `${Math.floor(fraction * 100)}%${eta}`;
    pct.textContent = `${Math.floor(fraction * 100)}%`; // the time left is already in the verdict title and clips the 72 px step cell
    $('prog-line-fill').style.width = `${fraction * 100}%`;
    $('queue-fill').style.width = `${fraction * 100}%`;
    if (card) card.fill.style.width = `${fraction * 100}%`;
  }
  const line = `${STEP_NAME[step]}${text ? ` ${text}` : '…'}`;
  if (item) {
    $('queue-text').textContent = `${state.run.done} of ${state.run.done + state.queue.filter((q) => q.status === 'waiting').length + 1} done · ${item.name} · ${line}`;
    if (card) { card.status.textContent = line; card.badge.textContent = ''; card.badge.append(node('span', 'dot dot-run'), line); }
  }
  if (item && item === state.current) {
    $('verdict-title').textContent = line;
    $('verdict-ring').style.setProperty('--pct', `${phase === 'measure' || phase === 'render' ? Math.round(fraction * 100) : 0}%`);
    $('verdict-pct').textContent = phase === 'measure' || phase === 'render' ? `${Math.floor(fraction * 100)}%` : '…';
    if (chartApi && chartApi.setSweep && phase === 'measure') chartApi.setSweep(fraction);
  }
}

window.api.onProgress(onProgress);

/** A note when the clip is long enough that the overlay file and the render get heavy. */
function longClipNote(opts, items) {
  const longest = Math.max(...items.map((q) => (opts.end || q.info.duration) - (opts.start || 0)));
  if (!opts.renderVideo || longest <= 1800) return null;
  return `This clip is ${Math.round(longest / 60)} minutes long. The overlay file will be about ${Math.round(longest * 0.2)} MB and rendering will take a while. ` +
    'Set a range, or turn off "Also render the video", to go faster.';
}

function startRun() {
  state.running = true;
  state.cancelled = false;
  currentStep = null;
  $('prog-line-fill').style.width = '0';
  updateRunButton();
}

$('run').addEventListener('click', async () => {
  if (state.running) return;
  await state.gpuReady; // the encoder default depends on the GPU check
  let opts;
  try {
    opts = readOptions();
  } catch (e) {
    $('run-hint').textContent = e.message;
    $('run-hint').classList.add('lv-bad');
    return;
  }
  if (state.current) state.current.status = 'waiting';
  const planned = todoItems();
  if (!planned.length) return;
  startRun();
  state.run.done = 0;
  const note = longClipNote(opts, planned);
  $('long-note').textContent = note || '';
  $('long-note').hidden = !note;
  // One after another, picking up files added meanwhile; a cancel stops the current job and skips the rest.
  let item;
  while ((item = state.queue.find((q) => q.status === 'waiting'))) {
    if (state.cancelled) { item.status = 'cancelled'; continue; }
    item.status = 'measuring';
    item.result = null;
    item.error = null;
    item.note = null;
    item.renderOnly = false;
    state.runningItem = item;
    currentStep = null;
    resetSteps(opts.renderVideo);
    renderLibrary();
    if (!viewIs('view-compare')) openItem(item); // the Workspace follows the job, as the run card lives there
    // A range picked on one clip's chart cannot apply to a clip that ends before it.
    const itemOpts = { ...opts, video: item.path, outDir: itemOutDir(item) };
    if (opts.start !== null && opts.start >= item.info.duration) {
      itemOpts.start = null;
      itemOpts.end = null;
      item.note = `Start and End ignored for ${item.name}: the clip is shorter than the start time.`;
    }
    const r = await window.api.startJob(itemOpts);
    item.status = r.ok ? 'done' : r.cancelled ? 'cancelled' : 'error';
    item.result = r.ok ? r.result : null;
    item.opts = itemOpts;
    item.error = r.error || null;
    if (r.ok) { state.lastAnalysed = r.result.video; upsertLibrary(item); } // the resolved path, as results carry it
    if (r.cancelled || (r.result && r.result.renderCancelled)) state.cancelled = true; // Cancel stops the whole queue
    state.run.done += 1;
    if (state.current === item) {
      if (r.ok) openItem(item);
      else if (!r.cancelled) showError(planned.length > 1 ? `${item.name}: the analysis stopped` : 'The analysis stopped', r.error);
      else openItem(item);
    } else if (!r.ok && !r.cancelled) addWarning(`${item.name} failed: ${item.error}`);
  }
  state.running = false;
  state.runningItem = null;
  renderLibrary();
  updateRunButton();
  if (state.current && viewIs('view-work')) openItem(state.current); // clears the busy state when the last job was a different item
});

$('render-again').addEventListener('click', async () => {
  if (!state.result || state.running) return;
  await state.gpuReady;
  const opts = renderOptions();
  const item = state.current;
  item.renderOnly = true;
  state.runningItem = item;
  startRun();
  resetSteps(true, true);
  renderBusy(item);
  const r = await window.api.renderOnly(opts);
  item.renderOnly = false;
  finishJob(r, state.opts, 'Rendering stopped');
});

$('preview').addEventListener('click', () => runPreview());

/** One frame at state.previewAt with the overlay options from the inspector, in the viewer. */
async function runPreview() {
  if (!state.result || state.result.video !== state.lastAnalysed) return; // the main process only holds the last analysis
  if (state.running) { previewDirty = true; return; } // drawn again at the new moment once this one is done
  await state.gpuReady;
  const at = state.previewAt;
  const opts = renderOptions();
  state.running = true;
  updateRunButton();
  $('run').hidden = false; // a preview is not a job the user cancels
  $('cancel').hidden = true;
  $('run-banner').hidden = true;
  $('prog-line').hidden = true;
  const b = $('preview');
  b.textContent = 'Drawing preview…';
  const r = await window.api.preview(opts, state.previewAt);
  state.running = false;
  b.textContent = 'Refresh preview';
  updateRunButton();
  if (previewDirty) { previewDirty = false; schedulePreview(); }
  if (!r.ok) {
    if (!r.cancelled) addWarning(`The preview was not made. ${r.error}`);
    return;
  }
  $('preview-img').src = `data:image/jpeg;base64,${r.jpeg}`;
  $('preview-img').hidden = false;
  $('preview-empty').hidden = true;
  syncCaption();
  if (state.previewAt === at) { state.previewAt = r.at; syncScrub(); } // unless the user moved on meanwhile
}

function finishJob(r, opts, errorTitle) {
  state.running = false;
  state.runningItem = null;
  updateRunButton();
  if (r.ok) {
    const item = state.queue.find((q) => q.result && q.result.video === r.result.video);
    if (item) { item.result = r.result; upsertLibrary(item); }
    state.result = r.result;
    state.opts = opts;
    renderResults(r.result, opts);
    show('view-work');
  } else if (r.cancelled) {
    openItem(state.current);
  } else {
    showError(errorTitle, r.error);
  }
}

// The common failures in plain words; anything else keeps the caller's title and opens the details.
const KNOWN_ERRORS = [
  [/ not found$|no such file|ENOENT/im, 'The file could not be found', 'Check that it still exists, then choose it again.'],
  [/NVENC|h264_nvenc/, 'GPU encoding failed', 'Choose CPU (x264) under Export and render again.'],
  [/libplacebo|vulkan|FSRCNNX/i, 'GPU upscaling failed', 'Choose Lanczos or Lanczos + sharpen under Export and render again.'],
  [/Too few frames|No video stream|could not read the file/i, 'This file could not be measured', 'It is not a video ffmpeg can decode. Export it from OBS again as MP4 or MKV.'],
  [/ENOSPC|No space left/i, 'The disk is full', 'Free some space or change the output folder, then try again.'],
];
function showError(title, raw) {
  const known = KNOWN_ERRORS.find(([re]) => re.test(raw));
  $('error-title').textContent = known ? known[1] : title;
  $('error-fix').textContent = known ? known[2] : 'The details below are what ffmpeg reported.';
  $('error-text').textContent = raw;
  $('error-details').open = !known;
  show('view-error');
}
$('error-copy').addEventListener('click', async () => {
  const b = $('error-copy');
  try {
    await navigator.clipboard.writeText(`${$('error-title').textContent}\n${$('error-text').textContent}`);
    b.textContent = 'Copied';
    setTimeout(() => { b.textContent = 'Copy details'; }, 1500);
  } catch (_) { /* the text is still on screen to select */ }
});

function addWarning(text) {
  const d = node('div', 'warn', text);
  $('warnings').appendChild(d);
}

$('cancel').addEventListener('click', () => window.api.cancelJob());
$('error-back').addEventListener('click', () => { if (state.current) openItem(state.current); else show('view-library'); });

// ---------- workspace ----------

/** A capture that is not 60 or 120 Hz; the console's refresh is what the game is measured against. */
const oddHz = (hz) => Math.abs(hz - 60) > 1 && Math.abs(hz - 120) > 1;

/** The Target list for this recording's refresh rate, keeping the current choice when it is still possible. */
function setTargets(targets) {
  const sel = $('opt-target');
  const cur = sel.value;
  sel.replaceChildren(new Option('Auto', ''), ...(targets || [20, 30, 60]).map((t) => new Option(`${t} fps`, String(t))));
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
  syncSummaries();
}

function setLevel(node, fps, target) {
  node.className = `lv-${level(fps, target)}`;
}

function chip(text) { return node('span', 'chipm', text); }

/** Show one queue item in the Workspace: its results, its pending state, or the running job. */
function openItem(item) {
  state.current = item;
  state.result = item.result;
  state.opts = item.opts || null;
  $('res-name').textContent = item.name;
  $('res-name').title = item.path;
  setTargets(item.targets);
  $('opt-title').placeholder = item.stem;
  syncUpscaler();
  $('warnings').replaceChildren();
  if (item.note) addWarning(item.note);
  if (item.status === 'error' && item.error) addWarning(`The last run failed: ${item.error}`);
  const e = libEntry(item.path);
  if (item.result) renderResults(item.result, item.opts || {}, e);
  else renderPending(item);
  if (item === state.runningItem) renderBusy(item);
  show('view-work');
  updateRunButton();
}

/** A recording that has not been measured yet: the file's facts, placeholders for the numbers. */
function renderPending(item) {
  const i = item.info;
  $('res-chips').replaceChildren(chip(fmtFormat(i)), chip(fmtDuration(i.duration)), chip(`target ${$('opt-target').value || 'auto'}`));
  $('res-meta').textContent = oddHz(i.hz)
    ? `Recorded at ${i.hz.toFixed(2)} fps; record at the console's refresh rate (60 or 120) for best results`
    : 'Not analysed yet';
  $('verdict').className = 'panel scorecard';
  $('verdict-ring').style.setProperty('--pct', '0%');
  $('verdict-pct').textContent = '–';
  $('verdict-title').textContent = 'Not analysed yet';
  $('verdict-sub').textContent = 'Press Analyse to measure every frame. Set In and Out first to measure only a part.';
  $('verdict-chips').replaceChildren();
  for (const id of ['t-avg', 't-low1', 't-low01', 't-longest', 't-pacing', 't-missed']) { $(id).textContent = '–'; $(id).className = ''; }
  for (const id of ['t-avg-sub', 't-missed-sub', 't-longest-sub', 't-pacing-sub']) $(id).textContent = '';
  $('t-pacing-unit').textContent = '% even';
  $('t-missed-row').hidden = true;
  $('preview-img').hidden = true;
  $('preview-img').removeAttribute('src');
  $('preview-empty').hidden = false;
  $('preview-empty').textContent = 'Press Analyse to measure this recording';
  $('run-card').hidden = true;
  $('ghosts').hidden = true;
  $('now-pill').hidden = true;
  $('viewer-hint').hidden = true;
  $('viewer-cap').hidden = true;
  $('scrub').max = Math.max(0, Math.ceil(i.duration) - 1);
  state.previewAt = 0;
  syncScrub();
  updateRangeReadout();
  $('range-hint').textContent = 'The FPS of every second appears here after the analysis.';
  $('transport-hint').textContent = '';
  $('markers').replaceChildren();
  $('sec-details').hidden = true;
  $('open-video').hidden = true;
  $('render-again').hidden = true;
  drawChart();
  fitFrame();
}

function renderResults(r, opts, entry) {
  const s = r.summary;
  const c = s.capture;
  const t = s.target_fps;
  state.previewAt = c.seconds / 2;
  previewDirty = false; // a fresh preview is scheduled below anyway
  // The main process only holds the last analysis, so only that one can be previewed.
  const current = r.video === state.lastAnalysed;
  $('preview-img').hidden = true;
  $('preview-img').removeAttribute('src');
  $('preview-empty').hidden = false;
  $('preview-empty').textContent = current ? 'Drawing the preview…' : 'Analyse again to preview or render';
  if (current) setTimeout(schedulePreview, 0); // after the view is shown
  $('run-card').hidden = true;
  $('ghosts').hidden = !current;
  $('viewer-hint').hidden = !current;
  $('now-pill').hidden = false;
  $('scrub').max = Math.max(0, Math.ceil(c.seconds) - 1);
  syncScrub();
  renderVerdict(s, opts);
  const nH = s.hitches.count, nS = s.static_holds.count, nL = s.loading.count;
  $('t-longest-sub').textContent = [nH && `${nH} hitch${nH === 1 ? '' : 'es'}`, nS && `${nS} still`, nL && `${nL} loading`].filter(Boolean).join(' · ') || 'No hitches';
  $('transport-hint').textContent = `${$('t-longest-sub').textContent} · ← → step · [ ] set In/Out · H next hitch`;
  $('sum-details').textContent = `${s.holds.length}${s.holds.length >= 40 ? '+' : ''} hold${s.holds.length === 1 ? '' : 's'} · threshold ${s.threshold} ${s.threshold_source}`;
  $('t-pacing').textContent = s.pacing.even_pct === null ? '–' : s.pacing.even_pct.toFixed(0);
  $('t-pacing-unit').textContent = s.pacing.even_pct === null ? 'unlocked' : '% even';
  $('t-pacing').className = '';
  if (s.pacing.even_pct !== null) setLevel($('t-pacing'), s.pacing.even_pct, 100);
  $('t-pacing-sub').textContent = `stutter time ${s.stutter_time_pct}%` + (s.tears.count ? ` · ${s.tears.count} tears` : '');
  const span = opts.start || opts.end ? `${fmtDuration(opts.start || 0)}–${opts.end ? fmtDuration(opts.end) : 'end'}` : 'whole recording';
  $('res-chips').replaceChildren(chip(`${c.height}p${Math.round(c.refresh_hz)}`), chip(fmtDuration(c.seconds)), chip(`target ${t}`));
  $('res-meta').textContent = `Analysed ${span}` + (entry && entry.analysedAt ? ` · ${fmtAgo(entry.analysedAt)}` : '');

  $('t-avg').textContent = s.avg_fps.toFixed(1);
  setLevel($('t-avg'), s.avg_fps, t);
  $('t-avg-sub').textContent = `${s.game_frames.toLocaleString()} game frames`;
  $('t-low1').textContent = s.low_1pct_fps.toFixed(1);
  setLevel($('t-low1'), s.low_1pct_fps, t);
  $('t-low01').textContent = s.low_0_1pct_fps.toFixed(1);
  setLevel($('t-low01'), s.low_0_1pct_fps, t);
  $('t-missed-row').hidden = false;
  $('t-missed').textContent = s.frames_missing_target.toLocaleString();
  $('t-missed-sub').textContent = `${s.frames_missing_target_pct}%`;
  $('t-longest').textContent = s.longest_frame_ms.toFixed(1);
  $('t-longest').className = '';

  if (c.dropped_by_recorder) {
    addWarning(`The recording itself is missing ${c.dropped_by_recorder} refresh${c.dropped_by_recorder === 1 ? '' : 'es'} (OBS dropped frames). Results near those points are not reliable.`);
  }
  if (r.renderError) addWarning(`The overlay video was not made. ${r.renderError}`);
  if (oddHz(c.refresh_hz)) {
    addWarning(`Recorded at ${c.refresh_hz} fps. Match OBS to the console's refresh rate (60, or 120 for a 40 fps mode) so every refresh is captured.`);
  }
  if (!$('long-note').hidden) addWarning($('long-note').textContent);

  const stalls = $('stalls');
  stalls.replaceChildren();
  const list = s.holds;
  if (!list.length) stalls.appendChild(node('li', 'empty', 'None. No frame stayed on screen for 2.5 target frames or more.'));
  for (const [at, ms, kind] of list) {
    const li = document.createElement('li');
    const a = node('button', '', fmtStamp((opts.start || 0) + at));
    a.type = 'button';
    a.title = 'Preview this moment';
    a.addEventListener('click', () => seekTo(at));
    const b = node('span', kind !== 'hitch' ? '' : ms >= 500 ? 'lv-bad' : 'lv-warn', `${ms.toFixed(1)} ms`);
    li.append(a, node('span', 'kind', kind === 'static' ? 'still' : kind), b);
    stalls.appendChild(li);
  }

  const dl = $('details');
  dl.replaceChildren();
  const p = s.diff_percentiles;
  const rows = [
    ['Capture', `${c.width}×${c.height} @ ${c.refresh_hz} Hz`],
    ['Refreshes', c.refreshes.toLocaleString()],
    ['Game frames', s.game_frames.toLocaleString()],
    ['1 s range', `${s.min_1s_fps}–${s.max_1s_fps} fps`],
    ['Holds by refreshes', `1× ${s.pacing.holds[1]} · 2× ${s.pacing.holds[2]} · 3× ${s.pacing.holds[3]} · 4×+ ${s.pacing.holds['4+']}`],
    ['Tears', s.tears.count ? `${s.tears.count} (${s.tears.per_minute} per minute)` : 'None'],
    ['Left out', `${s.static_holds.seconds} s still · ${s.loading.seconds} s loading`],
    ['With them', `avg ${s.all_frames.avg_fps} · 1% low ${s.all_frames.low_1pct_fps} · 0.1% low ${s.all_frames.low_0_1pct_fps} fps`],
    ['Threshold', `${s.threshold} (${s.threshold_source})`],
    ['Diff p5 / p50 / p95', `${p.p5} / ${p.p50} / ${p.p95}`],
    ['Dropped by recorder', String(c.dropped_by_recorder)],
    ['Measured in', r.measureSeconds == null ? 'An earlier session' : `${fmtDuration(r.measureSeconds)} (${r.hwDecode ? 'GPU' : 'CPU'} decoding)`],
    ['Rendered in', !r.overlayVideo ? 'Not rendered' : r.renderSeconds == null ? 'An earlier session' : `${fmtDuration(r.renderSeconds)} (${r.encoder === 'gpu' ? 'NVENC' : 'x264'}, ${r.outputWidth}×${r.outputHeight})`],
    ['Output', r.outDir],
  ];
  for (const [k, v] of rows) dl.append(node('dt', '', k), node('dd', '', v));
  $('sec-details').hidden = false;

  $('open-video').hidden = !r.overlayVideo;
  // One primary action: Play once a video exists, else Render.
  $('render-again').hidden = false;
  $('render-again').textContent = r.overlayVideo ? 'Render again' : 'Render video';
  $('render-again').classList.toggle('btn-primary', !r.overlayVideo);
  updateRangeReadout();
  $('range-hint').textContent = state.range
    ? `In and Out set to ${fmtStamp(state.range[0])}–${fmtStamp(state.range[1])}. Press Analyse to measure only that part. Double-click the chart to clear.`
    : 'Click a second to preview the overlay there. Drag to set the range, then press Analyse to measure only that part. Double-click to clear.';
  drawChart();
  fitFrame();
}

/** One sentence above the numbers: how many frames hit the target, and the worst moments as chips that seek the preview. */
function renderVerdict(s, opts) {
  const t = s.target_fps, off = opts.start || 0;
  const held = Math.max(0, Math.min(100, Math.round(100 - s.frames_missing_target_pct)));
  const lv = held >= 95 ? 'ok' : held >= 80 ? 'warn' : 'bad';
  const worst = s.hitches.first.slice().sort((a, b) => b[1] - a[1]);
  $('verdict').className = `panel scorecard lv-${lv}`;
  $('verdict-ring').style.setProperty('--pct', `${held}%`);
  $('verdict-pct').textContent = `${held}%`;
  const capped = s.hitches.count > worst.length; // the list holds the first 20 only
  $('verdict-title').textContent = `${held}% of frames hit ${t} fps` + (worst.length
    ? ` · ${s.hitches.count} hitch${s.hitches.count === 1 ? '' : 'es'}, the ${capped ? 'worst listed' : 'worst'} at ${fmtDuration(off + worst[0][0])}`
    : ' · no hitches');
  $('verdict-sub').textContent = `${s.frames_missing_target.toLocaleString()} of ${s.game_frames.toLocaleString()} frames missed the target in ${fmtDuration(s.seconds)} of play`;
  const chips = $('verdict-chips');
  chips.replaceChildren();
  for (const [at, ms] of worst.slice(0, 3)) {
    const b = node('button', ms >= 500 ? 'lv-bad' : 'lv-warn', `${fmtDuration(off + at)} · ${ms.toFixed(0)} ms`);
    b.type = 'button';
    b.title = 'Preview this moment';
    b.addEventListener('click', () => seekTo(at));
    chips.appendChild(b);
  }
}

/** Move the playhead to a moment of the analysed span and preview it. */
function seekTo(at) {
  state.previewAt = at;
  syncScrub();
  runPreview();
}

/** The slider, its label, the playhead and the now-playing pill follow state.previewAt. */
function syncScrub() {
  const off = (state.opts && state.opts.start) || 0;
  $('scrub').value = Math.floor(state.previewAt);
  $('scrub-val').textContent = fmtDuration(off + state.previewAt);
  if (chartApi && chartApi.setPlayhead) chartApi.setPlayhead(state.previewAt);
  const r = state.result;
  const pill = $('now-pill');
  pill.replaceChildren();
  if (!r) return;
  const sec = Math.floor(state.previewAt);
  const row = r.perSecond[sec];
  pill.append(fmtDuration(off + state.previewAt));
  if (row) {
    const b = node('b', `lv-${level(row[1], r.summary.target_fps)}`, `${row[1]} fps`);
    pill.appendChild(b);
  }
  const hold = r.summary.holds.find(([at, ms]) => state.previewAt >= at - 0.5 && state.previewAt <= at + ms / 1000 + 0.5);
  if (hold) pill.appendChild(node('span', '', `longest frame ${hold[1].toFixed(0)} ms · ${hold[2] === 'static' ? 'still' : hold[2]}`));
}
$('scrub').addEventListener('input', () => {
  $('scrub-val').textContent = fmtDuration(((state.opts && state.opts.start) || 0) + Number($('scrub').value));
});
$('scrub').addEventListener('change', () => seekTo(Number($('scrub').value) + 0.5));

function stepScrub(d) {
  const before = $('scrub').value;
  $('scrub').value = Number(before) + d; // the input clamps it to its range
  if ($('scrub').value !== before) $('scrub').dispatchEvent(new Event('change'));
}
$('step-back').addEventListener('click', () => stepScrub(-1));
$('step-fwd').addEventListener('click', () => stepScrub(1));

/** The hitch before or after the playhead, if any. */
function jumpHitch(dir) {
  if (!state.result) return;
  const hitches = state.result.summary.holds.filter((h) => h[2] === 'hitch').map((h) => h[0]).sort((a, b) => a - b);
  const at = dir > 0 ? hitches.find((x) => x > state.previewAt + 0.05) : hitches.filter((x) => x < state.previewAt - 0.05).pop();
  if (at !== undefined) seekTo(at);
}
$('prev-hitch').addEventListener('click', () => jumpHitch(-1));
$('next-hitch').addEventListener('click', () => jumpHitch(1));

$('open-video').addEventListener('click', () => {
  if (state.result && state.result.overlayVideo) window.api.openPath(state.result.overlayVideo);
});
$('open-folder').addEventListener('click', () => {
  if (!state.result) return;
  window.api.showInFolder(state.result.overlayVideo || `${state.result.outDir}\\summary.json`);
});

// The ghost slots over the preview move the overlay; the active one is outlined.
function syncGhosts() {
  const pos = radioValue('opt-pos'), st = radioValue('opt-style');
  for (const g of document.querySelectorAll('.ghost')) g.classList.toggle('on', g.dataset.pos === pos);
  if (state.result && state.result.video === state.lastAnalysed && !state.running) $('ghosts').hidden = st === 'strip' || st === 'none';
}
for (const g of document.querySelectorAll('.ghost')) {
  g.addEventListener('click', () => {
    const r = $(`pos-${g.dataset.pos}`);
    r.checked = true;
    r.dispatchEvent(new Event('change'));
    syncGhosts();
    schedulePreview();
  });
}

// The caption is drawn at its corner while no preview frame is up (the frame itself shows the real one).
function syncCaption() {
  const cap = $('viewer-cap');
  const text = $('opt-caption').value.trim();
  cap.hidden = !text || !state.result || !$('preview-img').hidden;
  cap.textContent = text;
  cap.dataset.pos = $('opt-caption-pos').value;
}

/** Keep the frame at the picture's aspect ratio inside the viewer so the ghost slots land on the picture. */
function fitFrame() {
  const stage = $('viewer-stage'), frame = $('frame'), img = $('preview-img');
  const sw = stage.clientWidth, sh = stage.clientHeight;
  if (!sw || !sh) return;
  const info = state.current && state.current.info;
  const ratio = img.naturalWidth && !img.hidden ? img.naturalWidth / img.naturalHeight : info ? info.width / info.height : 16 / 9;
  const w = Math.min(sw, sh * ratio);
  frame.style.width = `${w}px`;
  frame.style.height = `${w / ratio}px`;
}
new ResizeObserver(() => { if (viewIs('view-work')) fitFrame(); }).observe($('viewer-stage'));
$('preview-img').addEventListener('load', () => { fitFrame(); storeThumb(); });

/** A 320 px JPEG of the preview for the library card. */
function storeThumb() {
  const img = $('preview-img'), e = state.current && libEntry(state.current.path);
  if (!e || !img.naturalWidth) return;
  try {
    const cv = document.createElement('canvas');
    cv.width = 320;
    cv.height = Math.round(320 * img.naturalHeight / img.naturalWidth);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    e.thumb = cv.toDataURL('image/jpeg', 0.7);
    saveLibrary();
  } catch (_) { /* no thumbnail, the card keeps its numbers */ }
}

// ---------- timeline ----------

function updateRangeReadout() {
  const item = state.current;
  if (!item) return;
  const dur = state.result ? state.result.summary.capture.seconds : item.info.duration;
  const off = (state.opts && state.opts.start) || 0;
  $('range-readout').textContent = state.range
    ? `In ${fmtDuration(state.range[0])} · Out ${fmtDuration(state.range[1])} · ${fmtDuration(state.range[1] - state.range[0])} selected`
    : `${off ? `From ${fmtDuration(off)}` : 'Whole recording'} · ${fmtDuration(dur)}`;
}

const BAR_COLORS = { ok: '#4F9CF9', warn: '#F5B544', bad: '#F2555C' };

function drawChart() {
  const host = $('chart');
  host.replaceChildren();
  $('markers').replaceChildren();
  $('chart-tip').hidden = true;
  chartApi = null;
  const item = state.current;
  if (!item) return;
  const r = item.result;
  const busy = item === state.runningItem && !item.renderOnly;
  const data = r && !busy ? r.perSecond : [];
  const target = r ? r.summary.target_fps : Number($('opt-target').value) || 60;
  const W = host.clientWidth, H = host.clientHeight;
  if (!W) return;
  const L = 34, R = 8, T = 10, B = 24;
  const pw = W - L - R, ph = H - T - B;
  const n = data.length || Math.max(1, Math.floor(item.info.duration));
  const maxY = Math.max(target * 1.25, ...data.map((d) => d[1]));
  const y = (v) => T + ph - (v / maxY) * ph;
  const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Frames per second for each second of the recording, target ${target}` });

  for (const v of [0, target / 2, target]) {
    svg.appendChild(el('line', { class: 'grid', x1: L, x2: W - R, y1: y(v), y2: y(v) }));
    svg.appendChild(el('text', { class: 'axis', x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, String(Math.round(v))));
  }

  const slot = pw / n;
  const gap = slot > 4 ? 1 : 0;
  const offset = (data.length && state.opts && state.opts.start) || 0;
  for (const [sec, fps] of data) {
    const h = Math.max(1.5, (fps / maxY) * ph);
    svg.appendChild(el('rect', {
      x: (L + sec * slot).toFixed(2), y: (T + ph - h).toFixed(2),
      width: Math.max(0.6, slot - gap).toFixed(2), height: h.toFixed(2),
      fill: BAR_COLORS[level(fps, target)],
    }));
  }
  svg.appendChild(el('line', { class: 'target', x1: L, x2: W - R, y1: y(target), y2: y(target) }));

  // About eight time labels.
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
  const every = steps.find((s) => n / s <= 8) || 3600;
  for (let sec = 0; sec <= n; sec += every) {
    const x = L + sec * slot;
    const anchor = sec === 0 ? 'start' : x > W - R - 24 ? 'end' : 'middle';
    svg.appendChild(el('text', { class: 'axis', x, y: H - 6, 'text-anchor': anchor }, fmtDuration(offset + sec)));
  }

  if (!data.length) {
    // No per-second numbers yet: an empty axis, and a sweep that follows the measuring progress.
    svg.appendChild(el('text', { class: 'empty', x: L + pw / 2, y: T + ph / 2, 'text-anchor': 'middle' },
      busy ? 'Measuring… the per-second numbers arrive when it finishes' : 'No analysis yet'));
    if (busy) {
      const line = el('line', { class: 'sweep', x1: L, x2: L, y1: T - 4, y2: T + ph });
      const bg = el('rect', { class: 'sweep-bg', x: L + 6, y: T - 8, width: 40, height: 14, rx: 3 });
      const tag = el('text', { class: 'sweep-tag', x: L + 26, y: T + 3, 'text-anchor': 'middle' }, '0:00');
      svg.append(line, bg, tag);
      chartApi = { setSweep(f) {
        const x = L + f * pw;
        line.setAttribute('x1', x); line.setAttribute('x2', x);
        bg.setAttribute('x', Math.min(x + 6, W - R - 40)); tag.setAttribute('x', Math.min(x + 26, W - R - 20));
        tag.textContent = fmtDuration(f * item.info.duration);
      } };
    }
    host.appendChild(svg);
    return;
  }

  // Hold markers above the chart, one tick per hold, coloured by kind.
  for (const [at, ms, kind] of r.summary.holds) {
    const i = document.createElement('i');
    i.className = kind === 'hitch' ? `hitch${ms >= 500 ? ' bad' : ''}` : '';
    i.style.left = `${(L + at * slot).toFixed(1)}px`;
    i.title = `${fmtStamp(offset + at)} · ${ms.toFixed(0)} ms · ${kind === 'static' ? 'still' : kind}`;
    $('markers').appendChild(i);
  }

  // The selection: the part outside it dimmed, two handles with their times.
  const dimL = el('rect', { class: 'dim', x: L, y: T, width: 0, height: ph });
  const dimR = el('rect', { class: 'dim', x: L, y: T, width: 0, height: ph });
  const hA = el('line', { class: 'handle', y1: T, y2: T + ph }), hB = el('line', { class: 'handle', y1: T, y2: T + ph });
  const tagA = el('text', { class: 'handle-tag', y: T + 1, 'text-anchor': 'end' }), tagB = el('text', { class: 'handle-tag', y: T + 1, 'text-anchor': 'start' });
  const bgA = el('rect', { class: 'handle-bg', y: T - 9, width: 34, height: 13, rx: 2 }), bgB = el('rect', { class: 'handle-bg', y: T - 9, width: 34, height: 13, rx: 2 });
  const selG = el('g', { visibility: 'hidden' });
  selG.append(dimL, dimR, hA, hB, bgA, tagA, bgB, tagB);
  const showSel = (a, b) => {
    const xa = L + a * slot, xb = L + b * slot;
    dimL.setAttribute('width', Math.max(0, xa - L));
    dimR.setAttribute('x', xb); dimR.setAttribute('width', Math.max(0, L + pw - xb));
    hA.setAttribute('x1', xa); hA.setAttribute('x2', xa); hB.setAttribute('x1', xb); hB.setAttribute('x2', xb);
    bgA.setAttribute('x', xa - 36); tagA.setAttribute('x', xa - 4); tagA.textContent = fmtDuration(offset + a);
    bgB.setAttribute('x', xb + 2); tagB.setAttribute('x', xb + 4); tagB.textContent = fmtDuration(offset + b);
    selG.setAttribute('visibility', 'visible');
  };
  const playhead = el('line', { class: 'playhead', y1: T - 4, y2: T + ph });
  const cap = el('polygon', { class: 'playhead-cap' });
  const setPlayhead = (sec) => {
    const x = L + Math.min(n, Math.max(0, sec)) * slot;
    playhead.setAttribute('x1', x); playhead.setAttribute('x2', x);
    cap.setAttribute('points', `${x - 5},${T - 4} ${x + 5},${T - 4} ${x},${T + 2}`);
  };
  setPlayhead(state.previewAt);

  // Click a second to preview there; drag to set In and Out; double-click to clear; hover reads the value.
  const hit = el('rect', { class: 'hit', x: L, y: T, width: pw, height: ph });
  svg.append(selG, playhead, cap, hit);
  const secAt = (e) => Math.min(n, Math.max(0, Math.round((e.clientX - svg.getBoundingClientRect().left - L) / slot)));
  const tip = $('chart-tip');
  let s0 = null;
  hit.addEventListener('pointerdown', (e) => { s0 = secAt(e); hit.setPointerCapture(e.pointerId); });
  hit.addEventListener('pointermove', (e) => {
    if (s0 !== null) { showSel(Math.min(s0, secAt(e)), Math.max(s0, secAt(e))); return; }
    const sec = Math.min(n - 1, secAt(e));
    const row = data[sec];
    const hold = r.summary.holds.find(([at, ms]) => sec + 0.5 >= at - 0.5 && sec + 0.5 <= at + ms / 1000 + 0.5);
    tip.textContent = `${fmtDuration(offset + sec)} · ${row ? row[1] : '–'} fps` + (hold ? ` · ${hold[1].toFixed(0)} ms ${hold[2] === 'static' ? 'still' : hold[2]}` : '');
    tip.hidden = false;
    const x = L + sec * slot;
    tip.style.left = `${x + 150 > W ? x - 10 - tip.offsetWidth : x + 10}px`;
  });
  hit.addEventListener('pointerleave', () => { tip.hidden = true; });
  hit.addEventListener('pointerup', (e) => {
    if (s0 === null) return;
    const s1 = secAt(e), a = Math.min(s0, s1), b = Math.max(s0, s1);
    s0 = null;
    if (b - a >= 1) setRange(offset + a, offset + b);
    else seekTo(Math.min(a, Math.max(0, n - 1)) + 0.5);
  });
  hit.addEventListener('dblclick', () => setRange(null, null));
  if (state.range) {
    const [a, b] = state.range;
    if (a >= offset && b <= offset + n) showSel(a - offset, b - offset);
  }
  host.appendChild(svg);
  chartApi = { setPlayhead };
}

/** Write a timeline selection into the In and Out fields (null clears both), then redraw the handles. */
function setRange(a, b) {
  state.range = a === null ? null : [a, b];
  for (const [id, v] of [['opt-start', a], ['opt-end', b]]) {
    const n = $(id);
    n.value = v === null ? '' : Number.isInteger(v) ? fmtDuration(v) : String(v);
    n.classList.remove('invalid');
    n.classList.add('picked');
    setTimeout(() => n.classList.remove('picked'), 1200);
  }
  $('range-hint').textContent = a === null
    ? 'Click a second to preview the overlay there. Drag across the chart to set In and Out, then press Analyse to measure only that part. Double-click to clear.'
    : `In and Out set to ${fmtStamp(a)}–${fmtStamp(b)}. Press Analyse to measure only that part. Double-click the chart to clear.`;
  updateRangeReadout();
  syncSummaries();
  updateRunButton();
  drawChart();
}

// Set In / Set Out take the playhead; the other end keeps its value or the clip's edge.
$('set-in').addEventListener('click', () => {
  if (!state.current) return;
  const off = (state.opts && state.opts.start) || 0, dur = state.current.info.duration;
  const at = off + Math.floor(state.previewAt);
  const end = state.range && state.range[1] > at ? state.range[1] : Math.floor(dur);
  if (end - at >= 1) setRange(at, end);
});
$('set-out').addEventListener('click', () => {
  if (!state.current) return;
  const off = (state.opts && state.opts.start) || 0;
  const at = off + Math.ceil(state.previewAt);
  const start = state.range && state.range[0] < at ? state.range[0] : 0;
  if (at - start >= 1) setRange(start, at);
});
$('range-clear').addEventListener('click', () => setRange(null, null));
$('analyse-sel').addEventListener('click', () => $('run').click());

new ResizeObserver(() => { if (viewIs('view-work')) drawChart(); }).observe($('chart'));

// ---------- compare ----------

const compare = { inputs: [], out: null };
const TRACE_COLORS = ['#4F9CF9', '#C084FC', '#34D399', '#FB923C'];

/** The queue item whose rendered or source video is this compare input, if it was analysed this session. */
const compareItem = (file) => state.queue.find((q) => q.result && (q.result.overlayVideo === file || q.result.video === file));

function renderCompareList() {
  const box = $('compare-list');
  box.replaceChildren();
  compare.inputs.forEach((inp, i) => {
    const col = node('article', 'panel col');
    col.style.setProperty('--tc', TRACE_COLORS[i % TRACE_COLORS.length]);
    const head = node('div', 'col-head');
    const name = node('span', 'col-name', fileName(inp.file));
    name.title = inp.file;
    const rm = node('button', 'btn btn-icon btn-xs');
    rm.type = 'button';
    rm.setAttribute('aria-label', 'Remove');
    rm.title = 'Remove';
    const x = el('svg', { class: 'ico ico-s', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    x.appendChild(el('path', { d: 'M6 6l12 12M18 6L6 18' }));
    rm.appendChild(x);
    rm.addEventListener('click', () => { compare.inputs.splice(i, 1); renderCompareList(); });
    head.append(node('span', 'sw'), name, node('span', 'col-letter', String.fromCharCode(65 + i)), rm);
    const fields = node('div', 'col-fields');
    const lf = node('div', 'field'), of = node('div', 'field');
    const label = node('input', 'input');
    label.type = 'text'; label.placeholder = 'Label'; label.value = inp.label; label.id = `compare-label-${i}`;
    label.addEventListener('input', () => { inp.label = label.value; });
    const off = node('input', 'input mono');
    off.type = 'text'; off.inputMode = 'decimal'; off.placeholder = '0:00'; off.value = inp.offset || ''; off.id = `compare-offset-${i}`;
    off.title = 'Start this video this many seconds in (seconds or m:ss)';
    off.addEventListener('input', () => { inp.offset = off.value; drawCompareChart(); });
    const ll = node('label', 'fl', 'Pane label'), ol = node('label', 'fl', 'Start at');
    ll.htmlFor = label.id; ol.htmlFor = off.id;
    lf.append(ll, label); of.append(ol, off);
    fields.append(lf, of);
    col.append(head, fields);
    const q = compareItem(inp.file);
    if (q) {
      const s = q.result.summary, held = Math.round(100 - s.frames_missing_target_pct);
      const kv = node('div');
      for (const [k, v, cls] of [['On target', `${held}%`, `lv-${held >= 95 ? 'ok' : held >= 80 ? 'warn' : 'bad'}`], ['Average', `${s.avg_fps.toFixed(1)} fps`], ['1% low', `${s.low_1pct_fps.toFixed(1)} fps`], ['Hitches', String(s.hitches.count)]]) {
        const row = node('div', 'kv');
        row.append(node('span', '', k), node('b', cls || '', v));
        kv.appendChild(row);
      }
      col.appendChild(kv);
    }
    box.appendChild(col);
  });
  $('compare-run').disabled = compare.inputs.length < 2 || compare.inputs.length > 4 || state.running;
  $('compare-status').textContent = compare.inputs.length < 2 ? 'Add at least two rendered videos.' : compare.inputs.length > 4 ? 'At most four videos.' : '';
  drawCompareChart();
}

/** The aligned FPS traces of the inputs analysed this session; hidden when none are known. */
function drawCompareChart() {
  const host = $('compare-chart'), panel = $('compare-chart-panel');
  host.replaceChildren();
  $('compare-legend').replaceChildren();
  const traces = compare.inputs.map((inp, i) => ({ inp, i, q: compareItem(inp.file), off: parseTime(String(inp.offset || '0')) || 0 })).filter((t) => t.q);
  panel.hidden = !traces.length;
  if (!traces.length || !viewIs('view-compare')) return;
  const W = host.clientWidth, H = host.clientHeight;
  if (!W) return;
  const L = 34, R = 8, T = 10, B = 24, pw = W - L - R, ph = H - T - B;
  const n = Math.max(1, ...traces.map((t) => t.q.result.perSecond.length - Math.floor(t.off)));
  const target = Math.max(...traces.map((t) => t.q.result.summary.target_fps));
  const maxY = Math.max(target * 1.25, ...traces.flatMap((t) => t.q.result.perSecond.map((d) => d[1])));
  const y = (v) => T + ph - (v / maxY) * ph;
  const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Frames per second of the compared recordings over the same timeline' });
  for (const v of [0, target / 2, target]) {
    svg.appendChild(el('line', { class: 'grid', x1: L, x2: W - R, y1: y(v), y2: y(v) }));
    svg.appendChild(el('text', { class: 'axis', x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, String(Math.round(v))));
  }
  const slot = pw / n;
  for (const t of traces) {
    const color = TRACE_COLORS[t.i % TRACE_COLORS.length];
    const pts = t.q.result.perSecond.filter(([sec]) => sec >= t.off).map(([sec, fps]) => `${(L + (sec - t.off) * slot).toFixed(1)},${y(fps).toFixed(1)}`);
    svg.appendChild(el('polyline', { class: 'trace', stroke: color, points: pts.join(' ') }));
    const leg = node('span');
    const sw = node('i', 'sw');
    sw.style.background = color;
    leg.append(sw, `${String.fromCharCode(65 + t.i)} · ${t.inp.label || fileName(t.inp.file)}`);
    $('compare-legend').appendChild(leg);
  }
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
  const every = steps.find((s) => n / s <= 8) || 3600;
  for (let sec = 0; sec <= n; sec += every) {
    const x = L + sec * slot;
    svg.appendChild(el('text', { class: 'axis', x, y: H - 6, 'text-anchor': sec === 0 ? 'start' : x > W - R - 24 ? 'end' : 'middle' }, fmtDuration(sec)));
  }
  host.appendChild(svg);
}
new ResizeObserver(() => drawCompareChart()).observe($('compare-chart'));

function openCompare() {
  // The videos rendered this session are the natural picks.
  if (!compare.inputs.length) {
    for (const q of state.queue) {
      if (q.result && q.result.overlayVideo) compare.inputs.push({ file: q.result.overlayVideo, offset: '', label: q.stem });
    }
  }
  $('compare-play').hidden = $('compare-show').hidden = !compare.out;
  show('view-compare');
  renderCompareList();
}
$('compare-add').addEventListener('click', async () => {
  for (const p of await window.api.pickVideo()) {
    if (!compare.inputs.some((i) => i.file === p)) compare.inputs.push({ file: p, offset: '', label: fileName(p).replace(/\.[^.]+$/, '').replace(/_fps$/, '') });
  }
  renderCompareList();
});
$('compare-run').addEventListener('click', async () => {
  if (state.running) return;
  await state.gpuReady;
  const inputs = compare.inputs.map((i) => ({ file: i.file, offset: parseTime(String(i.offset || '0')) || 0, label: i.label }));
  const o = renderOptions();
  state.running = true;
  updateRunButton();
  $('compare-run').disabled = true;
  $('compare-play').hidden = $('compare-show').hidden = true;
  $('compare-status').textContent = 'Exporting… 0%';
  const r = await window.api.compare({ inputs, layout: $('compare-layout').value, encoder: o.encoder, quality: o.quality });
  state.running = false;
  updateRunButton();
  $('compare-run').disabled = false;
  if (!r.ok) {
    $('compare-status').textContent = r.cancelled ? 'Cancelled.' : `The export failed. ${r.error}`;
    return;
  }
  compare.out = r.result.path;
  $('compare-status').textContent = `Done in ${fmtDuration(r.result.seconds)}: ${r.result.width}×${r.result.height} · ${fileName(r.result.path)}`;
  $('compare-play').hidden = $('compare-show').hidden = false;
});
$('compare-play').addEventListener('click', () => compare.out && window.api.openPath(compare.out));
$('compare-show').addEventListener('click', () => compare.out && window.api.showInFolder(compare.out));

// ---------- copy summary ----------

$('copy-summary').addEventListener('click', async () => {
  const r = state.result;
  if (!r) return;
  const s = r.summary, c = s.capture, off = (state.opts && state.opts.start) || 0;
  const lines = [
    fileName(r.video),
    `${c.width}×${c.height} @ ${c.refresh_hz} Hz · ${fmtDuration(c.seconds)} analysed · target ${s.target_fps} fps`,
    `Average ${s.avg_fps.toFixed(1)} fps · 1% low ${s.low_1pct_fps.toFixed(1)} · 0.1% low ${s.low_0_1pct_fps.toFixed(1)} · ` +
      `Missed target ${s.frames_missing_target_pct}% · Longest frame ${s.longest_frame_ms.toFixed(1)} ms`,
  ];
  lines.push((s.pacing.even_pct === null ? '' : `Pacing ${s.pacing.even_pct}% even · `) + `Stutter time ${s.stutter_time_pct}% · ` +
    `${s.hitches.count} hitches` + (s.tears.count ? ` · ${s.tears.count} tears` : ''));
  const hitches = s.hitches.first;
  if (hitches.length) lines.push(`Hitches: ${hitches.slice(0, 8).map(([at, ms]) => `${fmtStamp(off + at)} (${ms.toFixed(0)} ms)`).join(', ')}`);
  if (s.static_holds.count || s.loading.count) lines.push(`Left out: ${s.static_holds.seconds} s still, ${s.loading.seconds} s loading`);
  if (c.dropped_by_recorder) lines.push(`Recorder dropped ${c.dropped_by_recorder} refreshes`);
  const b = $('copy-summary');
  const label = b.lastChild;
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    label.textContent = 'Copied';
    setTimeout(() => { label.textContent = 'Copy summary'; }, 1500);
  } catch (e) {
    addWarning(`Could not copy: ${e.message}`);
  }
});

// ---------- presets ----------

// Every option a preset holds: control id (or radio group name) and how to read it.
const PRESET_CONTROLS = {
  position: ['opt-pos', 'radio'], style: ['opt-style', 'radio'], theme: ['opt-theme', 'radio'], encoder: ['opt-enc', 'radio'],
  showTarget: ['opt-target-pill', 'checked'], showFormat: ['opt-format-pill', 'checked'],
  caption: ['opt-caption', 'value'], captionPosition: ['opt-caption-pos', 'value'],
  watermarkOn: ['opt-watermark-on', 'checked'], watermark: ['opt-watermark', 'value'],
  longGraph: ['opt-long', 'checked'], longGraphOpacity: ['opt-long-opacity', 'value'], endCard: ['opt-end-card', 'checked'],
  quality: ['opt-quality', 'value'], resolution: ['opt-res', 'value'], upscaler: ['opt-upscaler', 'value'],
  target: ['opt-target', 'value'], threshold: ['opt-threshold', 'value'],
};

function loadPresets() {
  try { return JSON.parse(localStorage.getItem('presets') || '{}') || {}; } catch (_) { return {}; }
}
function savePresets(p) {
  try { localStorage.setItem('presets', JSON.stringify(p)); } catch (_) { /* ignore */ }
}
function collectPreset() {
  const p = {};
  for (const [k, [id, kind]] of Object.entries(PRESET_CONTROLS)) p[k] = kind === 'radio' ? radioValue(id) : $(id)[kind];
  return p;
}
/** Set each control and fire its event so the sync and remember handlers run. */
function applyPreset(p) {
  for (const [k, [id, kind]] of Object.entries(PRESET_CONTROLS)) {
    if (!(k in p)) continue;
    if (kind === 'radio') {
      const r = document.querySelector(`input[name="${id}"][value="${p[k]}"]`);
      if (r && !r.disabled) { r.checked = true; r.dispatchEvent(new Event('change')); }
    } else {
      const n = $(id);
      n[kind] = p[k];
      n.dispatchEvent(new Event(n.type === 'range' ? 'input' : 'change'));
    }
  }
  syncStyle();
  syncSummaries();
  schedulePreview();
}
function refreshPresetList(selected = '') {
  const sel = $('preset');
  sel.replaceChildren(new Option('No preset', ''));
  for (const name of Object.keys(loadPresets()).sort()) sel.appendChild(new Option(name, name));
  sel.value = selected;
  $('preset-delete').disabled = !sel.value;
}
$('preset').addEventListener('change', () => {
  const p = loadPresets()[$('preset').value];
  if (p) applyPreset(p);
  $('preset-delete').disabled = !$('preset').value;
});
$('preset-save').addEventListener('click', () => {
  $('preset-name-row').hidden = false;
  $('preset-name').value = $('preset').value;
  $('preset-name').focus();
});
$('preset-cancel').addEventListener('click', () => { $('preset-name-row').hidden = true; });
$('preset-ok').addEventListener('click', () => {
  const name = $('preset-name').value.trim();
  if (!name) return;
  const all = loadPresets();
  all[name] = collectPreset();
  savePresets(all);
  refreshPresetList(name);
  $('preset-name-row').hidden = true;
});
$('preset-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('preset-ok').click(); });
$('preset-delete').addEventListener('click', () => {
  const all = loadPresets();
  delete all[$('preset').value];
  savePresets(all);
  refreshPresetList();
});
refreshPresetList();

state.library = loadLibrary();
renderLibrary();
show('view-library');
checkTools();
