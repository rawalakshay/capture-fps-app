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

/** m:ss with d decimals (2 by default), rounded first so 59.996 reads 1:00.00, not 0:60.00. */
function fmtStamp(s, d = 2) {
  const r = Number(s.toFixed(d)), m = Math.floor(r / 60);
  return `${m}:${(r - m * 60).toFixed(d).padStart(d + 3, '0')}`;
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
  else { pauseAB(); edPause(); }
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
  const q = await itemForEntry(e);
  if (q) openItem(q);
}

/** This session's item for a library entry; an entry from an earlier session is probed and its results read back. */
async function itemForEntry(e) {
  let q = state.queue.find((x) => x.path === e.path);
  // Re-added this session: read the earlier run back, unless it is measuring or queued in a running batch.
  if (q && !q.result && e.outDir && q.status !== 'measuring' && !(state.running && q.status === 'waiting')) await attachResult(q, e.outDir, e);
  if (q) return q;
  await addVideos([e.path], { open: false });
  q = state.queue.find((x) => x.path === e.path);
  if (q && e.outDir) await attachResult(q, e.outDir, e);
  return q || null;
}

/** Read a finished run back from its output folder onto a queue item; false when the folder has none. */
async function attachResult(q, outDir, e = {}) {
  const r = await window.api.loadResult(outDir);
  if (!r.ok) return false;
  q.result = { video: q.path, outDir, info: q.info, summary: r.result.summary, perSecond: r.result.perSecond, overlayVideo: e.overlayVideo || null };
  q.opts = { start: e.start || null, end: e.end || null };
  q.status = 'done';
  return true;
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
  if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return; // a recording dragged inside the window, from Media
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
  $('row-pos').hidden = st === 'strip' || st === 'none' || st === 'bands';
  $('row-title').hidden = st === 'none';
  // Bands draws its own panel: these options do nothing there, so they are not offered.
  $('row-pills').hidden = st === 'none' || st === 'bands';
  $('row-caption').hidden = $('row-long').hidden = $('row-end-card').hidden = st === 'bands';
  $('bands-hint').hidden = st !== 'bands';
  syncFrame();
  syncGhosts();
}

// Bands draws on its own canvas: 16:9, or 21:9 with its own two sizes.
const RES_OPTIONS = {
  normal: [['source', 'Same as recording'], ['1080', '1080p'], ['1440', '1440p'], ['2160', '4K (2160p)']],
  wide: [['1080', '2560×1080'], ['2160', '5120×2160']],
};
function syncFrame() {
  const bands = radioValue('opt-style') === 'bands';
  $('row-frame').hidden = !bands;
  const list = RES_OPTIONS[bands && radioValue('opt-frame') === '21:9' ? 'wide' : 'normal'];
  const sel = $('opt-res'), cur = sel.value;
  if (sel.options.length !== list.length) {
    sel.replaceChildren(...list.map(([v, t]) => new Option(t, v)));
    sel.value = list.some(([v]) => v === cur) ? cur : '1080';
  }
  syncUpscaler();
}
remember('opt-frame', 'frame');
for (const r of document.querySelectorAll('input[name="opt-style"]')) r.addEventListener('change', syncStyle);
for (const r of document.querySelectorAll('input[name="opt-frame"]')) r.addEventListener('change', () => { syncFrame(); schedulePreview(); });
syncStyle();

const THEME_NAME = { mono: 'Mono', aurora: 'Aurora', vice: 'Vice', classic: 'Classic' };
const STYLE_NAME = { panel: 'Panel', strip: 'Strip', glass: 'Glass', none: 'No overlay', bands: 'Bands' };
const RES_NAME = { source: 'source size', 1080: '1080p', 1440: '1440p', 2160: '4K' };

// The pill chips show what they would draw; the section headers sum up their settings.
function syncSummaries() {
  const q = state.current;
  document.querySelector('label[for="opt-target-pill"]').textContent = `TARGET ${$('opt-target').value || 'auto'}`;
  document.querySelector('label[for="opt-format-pill"]').textContent = q ? fmtFormat(q.info).toUpperCase() : 'FORMAT';
  const a = $('opt-start').value.trim(), b = $('opt-end').value.trim();
  $('sum-measure').textContent = `${a || b ? `${a || '0:00'}–${b || 'end'}` : 'whole'} · target ${$('opt-target').value || 'auto'} · threshold ${$('opt-threshold').value || 'auto'}`;
  const st = radioValue('opt-style');
  $('sum-overlay').textContent = [THEME_NAME[radioValue('opt-theme')], STYLE_NAME[st], st === 'panel' || st === 'glass' ? radioValue('opt-pos') : st === 'bands' ? radioValue('opt-frame') : null].filter(Boolean).join(' · ');
  const res = st === 'bands' && radioValue('opt-frame') === '21:9' ? $('opt-res').selectedOptions[0].text : RES_NAME[$('opt-res').value];
  $('sum-export').textContent = `${radioValue('opt-enc') === 'gpu' ? 'NVENC' : 'x264'} · ${res} · ${$('opt-quality').value}`;
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
    frame: radioValue('opt-frame'),
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
  if (phase === 'compare') {
    $('compare-status').textContent = `Exporting… ${Math.round(fraction * 100)}%`;
    $('prog-line-fill').style.width = `${fraction * 100}%`;
    return;
  }
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
  if (state.result && state.result.video === state.lastAnalysed && !state.running) $('ghosts').hidden = st === 'strip' || st === 'none' || st === 'bands';
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
  syncCompareMode();
  abAutoPick();
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
  runCompareExport(() => window.api.compare({ inputs, layout: $('compare-layout').value, encoder: o.encoder, quality: o.quality }));
});

/** One export from the Compare view (stack or A / B): progress, Cancel, then Play and Show in folder. */
async function runCompareExport(call) {
  state.running = true;
  updateRunButton();
  $('compare-run').disabled = $('abx-go').disabled = true;
  $('compare-play').hidden = $('compare-show').hidden = true;
  $('compare-cancel').hidden = false;
  $('prog-line-fill').style.width = '0';
  $('compare-status').textContent = 'Exporting… 0%';
  const r = await call();
  state.running = false;
  updateRunButton();
  $('compare-run').disabled = $('abx-go').disabled = false;
  $('compare-cancel').hidden = true;
  if (!r.ok) {
    $('compare-status').textContent = r.cancelled ? 'Cancelled.' : `The export failed. ${r.error}`;
    return;
  }
  compare.out = r.result.path;
  $('compare-status').textContent = `Done in ${fmtDuration(r.result.seconds)}: ${r.result.width}×${r.result.height}${r.result.codec ? ` · ${r.result.codec === 'hevc' ? 'HEVC' : 'H.264'}` : ''} · ${fileName(r.result.path)}`;
  $('compare-play').hidden = $('compare-show').hidden = false;
}
$('compare-cancel').addEventListener('click', () => window.api.cancelJob());
$('compare-play').addEventListener('click', () => compare.out && window.api.openPath(compare.out));
$('compare-show').addEventListener('click', () => compare.out && window.api.showInFolder(compare.out));

// ---------- compare: A / B ----------

// Two analysed recordings on one clock: B's time = A's time + offset. The shared timeline u starts where both
// have picture, so A shows u + shift('a') and B u + shift('b') of their analysed spans.
const ab = { a: null, b: null, offset: 0, u: 0, playing: false, playSeq: 0, clock: 0, view: null, hitchRows: [] };
const SIDES = ['a', 'b'];
const shift = (k) => Math.max(0, k === 'a' ? -ab.offset : ab.offset);
const abReady = () => Boolean(ab.a && ab.b);
const abSum = (k) => ab[k].data.summary;
const abVideoPath = (k) => ab[k].q.result.video || ab[k].q.path;
/** Seconds into side k's video file at shared time u (an analysis of a range starts at its In point). */
const abTime = (k, u) => ab[k].base + u + shift(k);
const mixedTargets = () => abReady() && abSum('a').target_fps !== abSum('b').target_fps;
const fileUrl = (p) => `file:///${encodeURI(p.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
const fmtOffset = (v) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(3)} s`;

function abSpan() {
  if (!abReady()) return 0;
  // What was analysed, cut to what the file holds after the In point, as the export cuts it.
  const len = (k) => Math.min(abSum(k).capture.seconds, ab[k].q.info && ab[k].q.info.duration ? ab[k].q.info.duration - ab[k].base : Infinity);
  return Math.max(0, Math.min(...SIDES.map((k) => len(k) - shift(k))));
}

function syncCompareMode() {
  const mode = radioValue('compare-mode');
  $('ab-mode').hidden = $('ab-actions').hidden = mode !== 'ab';
  $('edit-mode').hidden = $('ed-actions').hidden = mode !== 'edit';
  $('stack-mode').hidden = $('stack-actions').hidden = mode !== 'stack';
  if (mode !== 'ab') pauseAB();
  if (mode !== 'edit') edPause();
  if (mode === 'stack') renderCompareList();
  else if (mode === 'edit') edOpen();
  else renderAB();
}
remember('compare-mode', 'compareMode');
for (const r of document.querySelectorAll('input[name="compare-mode"]')) {
  r.addEventListener('change', () => { $('compare-status').textContent = ''; $('compare-play').hidden = $('compare-show').hidden = true; syncCompareMode(); });
}

/** Recordings with a finished analysis: this session's first, then earlier ones from the library. */
function abCandidates() {
  const list = state.queue.filter((q) => q.result && q.result.outDir).map((q) => ({ path: q.path, name: q.name, q }));
  for (const e of state.library) if (e.outDir && e.analysedAt && !list.some((c) => c.path === e.path)) list.push({ path: e.path, name: e.name, e });
  return list;
}

/** Fill an empty side with the next analysed recording of this session. */
async function abAutoPick() {
  for (const k of SIDES) {
    if (ab[k]) continue;
    const other = ab[k === 'a' ? 'b' : 'a'];
    const q = state.queue.find((x) => x.result && x.result.outDir && (!other || other.q !== x));
    if (q) await setSide(k, q);
  }
  if (radioValue('compare-mode') === 'ab') renderAB();
}

async function setSide(k, q) {
  const r = await window.api.abData(q.result.outDir);
  if (!r.ok) { $('compare-status').textContent = `${q.name} could not be compared. ${r.error}`; return; }
  // Where the analysis starts in its file: newer folders save it; older ones fall back to the item's In point.
  const start = r.result.summary.capture.start_s;
  ab[k] = { q, data: r.result, title: q.stem, sub: '', base: start != null ? start : (q.opts && q.opts.start) || 0, playable: true, shown: null };
  ab.view = null; // the graph's default follows the targets
  loadAbVideo(k);
  renderAB();
}

/** A recording picked from disk: its analysis is read from its default output folder, or one the user points to. */
async function abPickFile(k) {
  const [p] = await window.api.pickVideo();
  if (!p) return;
  await addVideos([p], { open: false });
  const q = state.queue.find((x) => x.path === p);
  if (!q) return;
  if (!q.result && !(await attachResult(q, q.defaultOutDir))) {
    const dir = await window.api.pickFolder(q.defaultOutDir);
    if (!dir || !(await attachResult(q, dir))) {
      $('compare-status').textContent = `No saved analysis for ${q.name}. Analyse it in the Library first.`;
      return;
    }
  }
  renderLibrary();
  setSide(k, q);
}

function fillPicker(k) {
  const list = $(`ab-list-${k}`);
  list.replaceChildren();
  const cands = abCandidates();
  if (!cands.length) list.appendChild(node('p', 'hint', 'No analysed recordings yet.'));
  for (const c of cands) {
    const b = node('button', '', c.name);
    b.type = 'button';
    b.title = c.path;
    if (ab[k] && ab[k].q.path === c.path) b.setAttribute('aria-current', 'true');
    b.addEventListener('click', async () => {
      const q = c.q || await itemForEntry(c.e);
      if (q && q.result) setSide(k, q);
      else $('compare-status').textContent = `${c.name} could not be read back. Analyse it again.`;
    });
    list.appendChild(b);
  }
  const other = node('button', '', 'Other recording…');
  other.type = 'button';
  other.title = 'A recording whose analysis is saved in its output folder';
  other.addEventListener('click', () => abPickFile(k));
  list.appendChild(other);
}

// ---- playback: the side with the sound leads, the other follows; with neither playable a plain clock leads ----

function loadAbVideo(k) {
  pauseAB();
  const v = $(`ab-video-${k}`);
  ab[k].playable = true;
  $(`ab-still-${k}`).hidden = true;
  $(`ab-still-${k}`).removeAttribute('src'); // the old video's frame must not show if this one also needs stills
  clearTimeout(stillTimers[k]);
  stillSeq[k] = (stillSeq[k] || 0) + 1; // an answer still in flight for the old video is dropped
  v.src = fileUrl(abVideoPath(k));
  v.muted = ab.sound !== k;
}

/** The window cannot decode this one (HEVC, say): show still frames from ffmpeg instead. */
function abUnplayable(k) {
  if (!ab[k] || !ab[k].playable) return;
  ab[k].playable = false;
  $(`ab-video-${k}`).hidden = true;
  $(`ab-still-${k}`).hidden = false;
  refreshStill(k);
}
const stillTimers = {}, stillSeq = {};
function refreshStill(k) {
  if (!ab[k] || ab[k].playable) return;
  clearTimeout(stillTimers[k]);
  stillTimers[k] = setTimeout(async () => {
    const seq = stillSeq[k] = (stillSeq[k] || 0) + 1; // a slower older answer must not land over a newer one
    if (!ab[k] || ab[k].playable) return;
    const r = await window.api.frameAt(abVideoPath(k), abTime(k, ab.u));
    if (seq === stillSeq[k] && r.ok && ab[k] && !ab[k].playable) $(`ab-still-${k}`).src = `data:image/jpeg;base64,${r.jpeg}`;
  }, 250);
}
for (const k of SIDES) {
  const v = $(`ab-video-${k}`);
  v.addEventListener('error', () => { if (v.getAttribute('src')) abUnplayable(k); });
  v.addEventListener('loadedmetadata', () => {
    if (!ab[k]) return;
    if (!v.videoWidth) { abUnplayable(k); return; } // sound only: the picture's codec is not supported
    v.currentTime = abTime(k, ab.u);
  });
}

function setPlayIcon() {
  const b = $('ab-playbtn');
  b.setAttribute('aria-label', ab.playing ? 'Pause both' : 'Play both');
  b.querySelector('path').setAttribute('d', ab.playing ? 'M6 4h4v16H6zM14 4h4v16h-4z' : 'M6 4l14 8-14 8z');
}

function leader() {
  return (ab.sound === 'b' ? ['b', 'a'] : ['a', 'b']).find((k) => ab[k] && ab[k].playable && !$(`ab-video-${k}`).paused) || null;
}

/** Resolves once v has its frame at the new time and can play on (or after 1.5 s, so a stuck file cannot hang Play). */
function settled(v) {
  return new Promise((done) => {
    let timer = null;
    const finish = () => { clearTimeout(timer); v.removeEventListener('seeked', check); v.removeEventListener('canplay', check); done(); };
    const check = () => { if (!v.seeking && v.readyState >= 3) finish(); };
    timer = setTimeout(finish, 1500);
    v.addEventListener('seeked', check);
    v.addEventListener('canplay', check);
    check();
  });
}

async function playAB() {
  if (!abReady()) return;
  if (ab.u >= abSpan() - 0.05) ab.u = 0;
  ab.playing = true;
  const go = ++ab.playSeq;
  setPlayIcon();
  const vids = SIDES.filter((k) => ab[k].playable).map((k) => {
    const v = $(`ab-video-${k}`);
    v.currentTime = abTime(k, ab.u);
    return v;
  });
  // Both start together once both have their frame: started at once, the follower trails by its seek and
  // decoder start-up (~130 ms), which the speed correction then needs seconds to pull in.
  await Promise.all(vids.map(settled));
  if (!ab.playing || go !== ab.playSeq) return;
  ab.clock = performance.now() - ab.u * 1000;
  for (const v of vids) {
    v.play().catch(() => {});
    // rAF stops while the window is covered or minimised; timeupdate (~4 a second) keeps the clock and B's sync going.
    v.ontimeupdate = () => { if (ab.playing && performance.now() - (ab.lastStep || 0) > 250) abStep(); };
  }
  requestAnimationFrame(abFrame);
}

function pauseAB() {
  const was = ab.playing;
  ab.playing = false;
  ab.playSeq++;
  for (const k of SIDES) { $(`ab-video-${k}`).pause(); $(`ab-video-${k}`).playbackRate = 1; }
  if (was) { setPlayIcon(); for (const k of SIDES) refreshStill(k); }
}

function abFrame() {
  if (!ab.playing) return;
  abStep();
  if (ab.playing) requestAnimationFrame(abFrame);
}

/** One step of the shared clock: follow the leader, pull the other side in, redraw. */
function abStep() {
  ab.lastStep = performance.now();
  const span = abSpan(), lead = leader();
  ab.u = lead ? $(`ab-video-${lead}`).currentTime - abTime(lead, 0) : (performance.now() - ab.clock) / 1000;
  ab.clock = performance.now() - ab.u * 1000;
  if (ab.u >= span) {
    ab.u = span;
    pauseAB();
    tickAB();
    return;
  }
  for (const k of SIDES) {
    if (k === lead || !ab[k].playable) continue;
    // Small drift is pulled in by speed, so a hitch lands on the same frame on both sides without seek stalls.
    const v = $(`ab-video-${k}`), drift = v.currentTime - abTime(k, ab.u);
    if (Math.abs(drift) > 0.2) { v.currentTime = abTime(k, ab.u); v.playbackRate = 1; }
    else v.playbackRate = Math.abs(drift) < 0.008 ? 1 : 1 - Math.max(-0.1, Math.min(0.1, drift * 3));
    if (v.paused && lead) v.play().catch(() => {});
  }
  tickAB();
}

function seekAB(u) {
  ab.u = Math.min(abSpan(), Math.max(0, u));
  ab.clock = performance.now() - ab.u * 1000;
  for (const k of SIDES) if (ab[k] && ab[k].playable && $(`ab-video-${k}`).readyState) $(`ab-video-${k}`).currentTime = abTime(k, ab.u);
  if (!ab.playing) for (const k of SIDES) refreshStill(k);
  tickAB();
}

/** Hitch times of both sides on the shared timeline, sorted. */
function abHitchTimes() {
  const span = abSpan();
  return SIDES.flatMap((k) => ab[k].data.hitches.map(([at]) => at - shift(k))).filter((u) => u >= 0 && u <= span).sort((x, y) => x - y);
}
function jumpAbHitch(dir) {
  if (!abReady()) return;
  pauseAB();
  const list = abHitchTimes();
  const at = dir > 0 ? list.find((x) => x > ab.u + 0.05) : list.filter((x) => x < ab.u - 0.05).pop();
  if (at !== undefined) seekAB(at);
}
function stepAbFrame(dir) {
  if (!abReady()) return;
  pauseAB();
  seekAB(ab.u + dir / (abSum('a').capture.refresh_hz || 60));
}

/** Everything that follows the playhead: time, slider, playheads, live pills, HITCH badges, the hitch row. */
function tickAB() {
  if (!abReady()) return;
  const span = abSpan(), u = ab.u;
  $('ab-now').textContent = fmtStamp(u);
  $('ab-scrub').value = u;
  const x = span ? (u / span) * 1000 : 0;
  for (const l of document.querySelectorAll('#ab-mode svg .ph')) { l.setAttribute('x1', x); l.setAttribute('x2', x); }
  for (const p of document.querySelectorAll('#ab-mode .ab-ph')) p.style.left = `${x / 10}%`;
  for (const k of SIDES) liveFor(k);
  for (const row of ab.hitchRows) row.tr.classList.toggle('on', Math.abs(row.u - u) <= 0.5);
}

function liveFor(k) {
  const d = ab[k].data, t = ab.u + shift(k);
  const live = $(`ab-live-${k}`), num = live.firstChild, sub = live.lastChild;
  const held = d.paused.find(([at, ms]) => t >= at && t < at + ms / 1000);
  // A second partly held has no play FPS of its own; the play around it does: the nearest second that has one.
  const p = d.playFps, at = Math.min(p.length - 1, Math.floor(t));
  let row = null;
  for (let r = 0; r < p.length && !row; r++) row = [p[at - r], p[at + r]].find((x) => x && x[1] !== null) || null;
  live.hidden = !held && !row;
  if (held) {
    num.className = 'held';
    num.textContent = held[2] === 'loading' ? 'LOADING' : 'STILL';
    sub.textContent = `${(held[1] / 1000).toFixed(1)} s · not counted`;
  } else if (row) {
    const lv = level(Math.round(row[1]), d.summary.target_fps); // banded as shown
    num.className = lv === 'ok' ? '' : `ab-${lv}`; // not .warn: that is the app's warning banner
    num.textContent = String(Math.round(row[1]));
    sub.textContent = `fps · ${row[1] > 0 ? (1000 / row[1]).toFixed(1) : '–'} ms`;
  }
  const hitch = d.hitches.find(([at]) => t >= at && t < at + 1);
  $(`ab-hitch-${k}`).hidden = !hitch;
  if (hitch) $(`ab-hitch-${k}`).textContent = `HITCH ${hitch[1].toFixed(1)} ms`;
}

// ---- the page ----

function renderAB() {
  for (const k of SIDES) {
    const s = ab[k];
    $(`ab-pane-${k}`).classList.toggle('empty', !s);
    $(`ab-none-${k}`).hidden = Boolean(s);
    $(`ab-video-${k}`).hidden = !s || !s.playable;
    $(`ab-still-${k}`).hidden = !s || s.playable;
    $(`ab-fmt-${k}`).hidden = !s;
    $(`ab-change-${k}`).textContent = s ? 'Change' : 'Choose';
    $(`ab-title-${k}`).value = s ? s.title : '';
    $(`ab-sub-${k}`).value = s ? s.sub : '';
    $(`ab-title-${k}`).disabled = $(`ab-sub-${k}`).disabled = !s;
    if (!s) { $(`ab-live-${k}`).hidden = $(`ab-hitch-${k}`).hidden = true; continue; }
    const c = s.data.summary.capture;
    $(`ab-fmt-${k}`).textContent = `${c.height}P${Math.round(c.refresh_hz)}`;
  }
  const ready = abReady();
  $('ab-verdict').hidden = $('ab-body').hidden = !ready;
  $('ab-swap').disabled = $('ab-copy').disabled = !ready;
  $('ab-export-open').classList.toggle('disabled', !ready); // a <summary> has no disabled state
  $('ab-export-open').setAttribute('aria-disabled', String(!ready));
  if (!ready) $('ab-export-menu').open = false;
  if (!ready) {
    if (abCandidates().length < 2 && radioValue('compare-mode') === 'ab') $('compare-status').textContent = 'Analyse two recordings in the Library, then pick them here as A and B.';
    return;
  }
  $('ab-offset').value = fmtOffset(ab.offset);
  $('ab-off-note').textContent = `${ab.offset < 0 ? '−' : '+'}${Math.abs(ab.offset).toFixed(1)} s vs A`;
  const span = abSpan();
  $('ab-scrub').max = span;
  $('ab-total').textContent = `/ ${fmtDuration(span)}`;
  if (!ab.view) {
    ab.view = mixedTargets() ? 'pct' : 'fps';
    $(`ab-view-${ab.view}`).checked = true;
  }
  drawAB();
  renderAbHitches();
  seekAB(ab.u);
  refreshShown();
}

/** The numbers of the overlap only, as the export prints them, then the verdict and the table from them. */
let shownSeq = 0;
async function refreshShown() {
  const seq = ++shownSeq, span = abSpan();
  const rs = await Promise.all(SIDES.map((k) => window.api.abSummary(ab[k].q.result.outDir, shift(k), span)));
  if (seq !== shownSeq || !abReady()) return;
  SIDES.forEach((k, i) => { ab[k].shown = rs[i].ok ? rs[i].result : null; });
  renderAbVerdict();
  renderAbNumbers();
}
/** Side k's numbers over the overlap; its whole run until those are in. */
const abShown = (k) => ab[k].shown || abSum(k);

/** Which one is smoother: 1% low against its own target, then fewer hitches; null when they are even. */
function smoother(sa, sb) {
  const d = (sa.low_1pct_fps / sa.target_fps - sb.low_1pct_fps / sb.target_fps) * 100;
  if (Math.abs(d) >= 1) return d > 0 ? 'a' : 'b';
  if (sa.hitches.count !== sb.hitches.count) return sa.hitches.count < sb.hitches.count ? 'a' : 'b';
  return null;
}

async function renderAbVerdict() {
  const sa = abShown('a'), sb = abShown('b'), mixed = mixedTargets();
  const lead = $('ab-lead');
  lead.replaceChildren();
  const w = smoother(sa, sb);
  if (mixed) lead.appendChild(chip(`${sa.target_fps} vs ${sb.target_fps}`));
  else if (w) lead.append(node('span', `ab-badge${w === 'b' ? ' b' : ''}`, w.toUpperCase()), 'smoother');
  const chips = mixed
    ? [Object.assign(chip(`A · TARGET ${sa.target_fps}`), { className: 'chipm ca' }), Object.assign(chip(`B · TARGET ${sb.target_fps}`), { className: 'chipm cb' })]
    : [chip(`Same target · ${sa.target_fps}`)];
  $('ab-chips').replaceChildren(...chips, chip(`Overlap ${fmtDuration(abSpan())}`));
  const v = await window.api.abVerdict(sa, sb, [ab.a.title || 'A', ab.b.title || 'B']);
  $('ab-sentence').textContent = typeof v === 'string' ? v : (v && (v.text || v.sentence)) || '';
}

/** FPS, % of target or frame time of both over the shared timeline, the hitch lanes and the A − B strip. */
function drawAB() {
  const view = radioValue('ab-view'), span = abSpan() || 1, mixed = mixedTargets();
  const ta = abSum('a').target_fps, tb = abSum('b').target_fps;
  const H = 160, T = 6, B = 10;
  const X = (u) => Math.min(1000, Math.max(0, (u / span) * 1000));
  // Play FPS, so stills and loads are gaps (drawn as dimmed bands), never a drop; null breaks the line.
  const series = (k) => {
    const d = ab[k].data, t = d.summary.target_fps, sh = shift(k);
    return (view === 'ft' ? d.ftMax : d.playFps)
      .map(([sec, v]) => [sec + 0.5 - sh, v === null ? null : view === 'pct' ? (v / t) * 100 : v]).filter(([u]) => u > -1 && u < span + 1);
  };
  const sa = series('a'), sb = series('b');
  const runs = (pts) => pts.reduce((out, p) => {
    if (p[1] === null) out.push([]);
    else out[out.length - 1].push(p);
    return out;
  }, [[]]).filter((r) => r.length);
  let max, ticks, targets;
  // FPS and % grow to fit a clip running well over its target, so it is never a flat line along the top.
  const top = 1.1 * Math.max(0, ...sa.map((p) => p[1]), ...sb.map((p) => p[1]));
  if (view === 'pct') {
    max = Math.max(134, top);
    ticks = [[100, '100%'], [50, '50%'], [0, '0']];
    if (max > 220) ticks.unshift([200, '200%']);
    else if (max > 165) ticks.unshift([150, '150%']);
    targets = [[100, 'tgt']];
  } else if (view === 'fps') {
    max = Math.max(Math.max(ta, tb) * 1.34, top);
    ticks = mixed ? [[ta, ta, 'ab-ca'], [tb, tb, 'ab-cb'], [0, '0']] : [[ta, ta], [ta / 2, ta / 2], [0, '0']];
    targets = mixed ? [[ta, 'tgt-a'], [tb, 'tgt-b']] : [[ta, 'tgt']];
  } else {
    const fa = 1000 / ta, fb = 1000 / tb, hi = Math.max(fa, fb);
    max = Math.max(hi * 3, Math.min(top, hi * 6)); // taller spikes are cut at the top
    // Two target frames when no round number fits, so the upper half of the scale has a reference too.
    const grid = [200, 100, 50].find((g) => g < max * 0.92 && g > hi * 1.5) || (hi * 2 < max * 0.92 ? Math.round(hi * 20) / 10 : null);
    ticks = mixed ? [[fa, fa.toFixed(1), 'ab-ca'], [fb, fb.toFixed(1), 'ab-cb']] : [[fa, fa.toFixed(1)]];
    if (grid) ticks.push([grid, String(grid)]);
    ticks.push([0, '0']);
    targets = mixed ? [[fa, 'tgt-a'], [fb, 'tgt-b']] : [[fa, 'tgt']];
  }
  const y = (v) => T + (1 - Math.min(v, max) / max) * (H - T - B);
  const svg = $('ab-svg');
  const line = (cls, y1, x1 = 0, x2 = 1000, y2 = y1) => el('line', { class: cls, x1, x2, y1, y2, 'vector-effect': 'non-scaling-stroke' });
  svg.replaceChildren();
  const holdName = (k, ms, kind) => `${k.toUpperCase()} · ${kind === 'loading' ? 'LOADING' : 'STILL'} ${(ms / 1000).toFixed(1)} s · not counted`;
  for (const k of SIDES) {
    for (const [at, ms, kind] of ab[k].data.paused) {
      const x0 = X(at - shift(k)), x1 = X(at + ms / 1000 - shift(k));
      if (x1 > x0) {
        const r = el('rect', { class: `held held-${k}`, x: x0.toFixed(1), y: T, width: (x1 - x0).toFixed(1), height: H - T - B });
        r.appendChild(el('title', {}, holdName(k, ms, kind)));
        svg.appendChild(r);
      }
    }
  }
  for (const [v] of ticks) if (!targets.some(([t]) => t === v)) svg.appendChild(line('grid', y(v)));
  for (const [v, cls] of targets) svg.appendChild(line(cls, y(v)));
  for (const [k, pts] of [['b', sb], ['a', sa]]) {
    for (const r of runs(pts)) {
      // A lone second between held ones is drawn a second wide; one point would draw nothing.
      const line = r.length > 1 ? r : [[r[0][0] - 0.5, r[0][1]], [r[0][0] + 0.5, r[0][1]]];
      svg.appendChild(el('polyline', { class: `tr-${k}`, 'vector-effect': 'non-scaling-stroke', points: line.map(([u, v]) => `${X(u).toFixed(1)},${y(v).toFixed(1)}`).join(' ') }));
    }
  }
  svg.appendChild(line('ph', 0, 0, 0, H));
  const names = { fps: 'FPS', pct: '% of target', ft: 'frame time' };
  svg.setAttribute('aria-label', `${names[view]} of A and B over the shared timeline, offsets applied`);
  $('ab-y').replaceChildren(...ticks.map(([v, label, cls]) => {
    const s = node('span', cls || '', String(label));
    s.style.top = `${(y(v) / H) * 100}%`;
    return s;
  }));
  $('ab-chart-title').textContent = view === 'fps' ? 'FPS, aligned' : view === 'pct' ? 'Frame rate, aligned' : 'Frame time, aligned';
  $('ab-chart-hint').textContent = view === 'pct' ? '100% means on its own target · click to jump both videos'
    : view === 'ft' ? 'Worst frame of each second in ms, spikes point up · click to jump both videos'
      : 'Offsets applied · click to jump both videos';
  $('ab-legend').replaceChildren(...SIDES.map((k) => {
    const s = node('span');
    s.append(node('i', `ab-legend-line${k === 'b' ? ' b' : ''}`), `${k.toUpperCase()} · ${mixed ? abSum(k).target_fps : ab[k].title || ab[k].q.stem}`);
    return s;
  }));

  for (const k of SIDES) {
    const lane = $(`ab-lane-${k}`);
    lane.replaceChildren();
    // Stills and loads in the side's own lane, named, so the chart's bands can be told apart.
    for (const [at, ms, kind] of ab[k].data.paused) {
      const u0 = Math.max(0, at - shift(k)), u1 = Math.min(span, at + ms / 1000 - shift(k));
      if (u1 <= u0) continue;
      const s = node('span', 'ab-hold', kind === 'loading' ? 'LOADING' : 'STILL');
      Object.assign(s.style, { left: `${(u0 / span) * 100}%`, width: `${((u1 - u0) / span) * 100}%` });
      s.title = holdName(k, ms, kind);
      lane.appendChild(s);
    }
    for (const [at, ms] of ab[k].data.hitches) {
      const u = at - shift(k);
      if (u < 0 || u > span) continue;
      const i = node('i');
      i.style.left = `${(u / span) * 100}%`;
      i.title = `${fmtStamp(u, 1)} · ${ms.toFixed(1)} ms`;
      lane.appendChild(i);
    }
    lane.appendChild(node('span', 'ab-ph'));
  }

  // A − B per second of the shared timeline: fps, or points of own target when the targets differ. Both sides
  // are read at the same moment (the middle of the shared second), between their per-second values, so a
  // fractional offset compares what is on screen together; a second inside a still or a load is not compared.
  $('ab-diff').hidden = view === 'ft';
  if (view !== 'ft') {
    const val = (k, u) => {
      const d = ab[k].data, p = d.playFps, t = Math.min(p.length - 1, Math.max(0, u + shift(k) - 0.5));
      const i = Math.floor(t), f = t - i, v0 = p[i] && p[i][1], v1 = f > 0 && p[i + 1] ? p[i + 1][1] : v0;
      if (v0 == null || v1 == null) return null;
      const v = v0 + (v1 - v0) * f;
      // Capped at 100 % as in the Numbers: running over a target is not better than holding it.
      return mixed ? Math.min(100, (v / d.summary.target_fps) * 100) : v;
    };
    const diffs = [];
    for (let s = 0; s < Math.ceil(span); s++) {
      const va = val('a', s + 0.5), vb = val('b', s + 0.5);
      if (va !== null && vb !== null) diffs.push([s, va - vb]);
    }
    const peak = Math.max(0, ...diffs.map((d) => Math.abs(d[1])));
    let lim = mixed ? 25 : 15;
    for (const base = lim; lim < peak && lim < base * 4;) lim *= 2; // a loading screen must not flatten the rest
    const dsvg = $('ab-diff-svg');
    dsvg.replaceChildren(line('zero', 40));
    for (const [s, d] of diffs) {
      if (Math.abs(d) < 0.05) continue;
      const h = (Math.min(Math.abs(d), lim) / lim) * 36;
      const e = Math.min(s + 1, span), x0 = X(s + (e - s) * 0.2), w = Math.max(1.5, X(s + (e - s) * 0.8) - x0); // the last second may be partial
      dsvg.appendChild(el('rect', { class: d > 0 ? 'bar-a' : 'bar-b', x: x0.toFixed(1), y: (d > 0 ? 40 - h : 40).toFixed(1), width: w.toFixed(1), height: h.toFixed(1) }));
    }
    dsvg.appendChild(line('ph', 0, 0, 0, 80));
    dsvg.setAttribute('aria-label', `A minus B for each second, in ${mixed ? 'points of target' : 'fps'}`);
    $('ab-diff-y').replaceChildren(...[[0, `+${lim}`], [50, '0'], [100, `−${lim}`]].map(([top, t]) => {
      const s = node('span', '', t);
      s.style.top = `${top}%`;
      return s;
    }));
    $('ab-diff-hint').textContent = mixed ? 'In points of own target, capped at 100 % as in the Numbers' : 'Above the line A is ahead, below it B is ahead';
  }

  // Round steps placed at their own time, about 4 of them, then the end (a step too close to the end is left out).
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((x) => span / x <= 5) || 1200;
  const at = [];
  for (let t = 0; t < span - step * 0.4; t += step) at.push(t);
  at.push(span);
  $('ab-ticks').replaceChildren(...at.map((t) => {
    const s = node('span', '', fmtDuration(t));
    s.style.left = `${(t / span) * 100}%`;
    return s;
  }));
}

/** The numbers side by side; with different targets each is also shown, and judged, as % of its own target. */
function renderAbNumbers() {
  const sa = abShown('a'), sb = abShown('b'), mixed = mixedTargets();
  document.querySelector('#ab-mode .ab-tables').classList.toggle('wide-cells', mixed);
  const ta = sa.target_fps, tb = sb.target_fps;
  $('ab-th-a').textContent = mixed ? `A · target ${ta}` : 'A';
  $('ab-th-b').textContent = mixed ? `B · target ${tb}` : 'B';
  // Banded as shown, so 56.96 printed as 57.0 is not amber here and white on the end card.
  const fps = (v, t) => ({ v: v.toFixed(1), u: 'fps', lv: level(Number(v.toFixed(1)), t), sub: mixed ? `${Math.round((100 * Number(v.toFixed(1))) / t)}%` : null }); // as the end card: the shown value, 100 * v / t
  // [name, cell A, cell B, A − B (positive: A is better), even below, how the gap reads]
  const pts = (d) => `+${Math.round(d)} pts`;
  const own = (v, t) => Math.min(100, (100 * v) / t); // running over its target is not better than holding it
  const r1 = (v) => Number(v.toFixed(1)); // gaps from the numbers as shown, as the end card takes them
  const rows = [];
  for (const [name, key] of [['Average', 'avg_fps'], ['1% low', 'low_1pct_fps'], ['0.1% low', 'low_0_1pct_fps']]) {
    const d = mixed ? Math.round(own(r1(sa[key]), ta)) - Math.round(own(r1(sb[key]), tb)) : r1(sa[key]) - r1(sb[key]);
    rows.push([name, fps(sa[key], ta), fps(sb[key], tb), d, mixed ? 1 : 0.05, mixed ? pts : (x) => `+${x.toFixed(1)}`]);
  }
  const frames = (ms, t) => Math.round(ms / (1000 / t));
  const nFrames = (n) => `${n} frame${n === 1 ? '' : 's'}`;
  rows.push(['Longest frame',
    { v: sa.longest_frame_ms.toFixed(1), u: 'ms', sub: mixed ? nFrames(frames(sa.longest_frame_ms, ta)) : null },
    { v: sb.longest_frame_ms.toFixed(1), u: 'ms', sub: mixed ? nFrames(frames(sb.longest_frame_ms, tb)) : null },
    mixed ? frames(sb.longest_frame_ms, tb) - frames(sa.longest_frame_ms, ta) : r1(sb.longest_frame_ms) - r1(sa.longest_frame_ms),
    mixed ? 0.5 : 0.05, mixed ? (x) => `${nFrames(x)} shorter` : (x) => `−${x.toFixed(1)}`]);
  const pa = sa.pacing.even_pct, pb = sb.pacing.even_pct;
  rows.push(['Pacing', { v: pa === null ? '–' : pa.toFixed(0), u: pa === null ? 'unlocked' : '% even' }, { v: pb === null ? '–' : pb.toFixed(0), u: pb === null ? 'unlocked' : '% even' },
    pa === null || pb === null ? null : Math.round(pa) - Math.round(pb), 1, pts]); // unlocked has no pacing to compare
  const over = (t) => (mixed ? `over ${(2500 / t).toFixed(1)} ms` : null);
  rows.push(['Hitches', { v: String(sa.hitches.count), sub: over(ta) }, { v: String(sb.hitches.count), sub: over(tb) },
    sb.hitches.count - sa.hitches.count, 1, (x) => `${x} fewer`]);
  rows.push(['Missed target', { v: sa.frames_missing_target_pct.toFixed(1), u: '%' }, { v: sb.frames_missing_target_pct.toFixed(1), u: '%' },
    r1(sb.frames_missing_target_pct) - r1(sa.frames_missing_target_pct), 0.05, (x) => `−${x.toFixed(1)}`]);

  const cell = (c) => {
    const td = node('td');
    const v = node('span', c.lv === 'warn' ? 'lv-warn' : c.lv === 'bad' ? 'lv-bad' : '', c.v);
    td.appendChild(v);
    if (c.u) td.append(' ', node('span', 'u', c.u));
    if (c.sub) td.appendChild(node('span', 'sub', c.sub));
    return td;
  };
  $('ab-numbers').replaceChildren(...rows.map(([name, a, b, d, even, fmt]) => {
    const tr = node('tr');
    const th = node('th', '', name);
    th.scope = 'row';
    const better = node('td');
    if (d === null) better.appendChild(node('span', 'even', '–'));
    else if (Math.abs(d) < even) better.appendChild(node('span', 'even', 'Even'));
    else {
      const chipEl = node('span', 'ab-better');
      chipEl.append(node('b', d > 0 ? '' : 'cb', d > 0 ? 'A' : 'B'), fmt(Math.abs(d)));
      better.appendChild(chipEl);
    }
    tr.append(th, cell(a), cell(b), better);
    return tr;
  }));
}

/** Hitches of both on the shared timeline; two within 0.5 s of each other are one spot. */
function renderAbHitches() {
  const span = abSpan();
  const list = (k) => ab[k].data.hitches.map(([at, ms]) => ({ u: at - shift(k), ms, k })).filter((h) => h.u >= 0 && h.u <= span);
  const bs = list('b'), rows = [];
  for (const h of list('a')) {
    const i = bs.findIndex((x) => Math.abs(x.u - h.u) <= 0.5);
    const pair = i >= 0 ? bs.splice(i, 1)[0] : null;
    rows.push({ u: pair ? Math.min(h.u, pair.u) : h.u, a: h.ms, b: pair ? pair.ms : null });
  }
  for (const h of bs) rows.push({ u: h.u, a: null, b: h.ms });
  rows.sort((x, y) => x.u - y.u);
  ab.hitchRows = rows;
  const body = $('ab-hitches');
  body.replaceChildren();
  if (!rows.length) {
    const tr = node('tr'), td = node('td', 'empty', 'No hitches in either recording where they overlap.');
    td.colSpan = 4;
    tr.appendChild(td);
    body.appendChild(tr);
  }
  for (const row of rows) {
    const tr = node('tr'), at = node('td'), btn = node('button', 'ab-at', fmtStamp(row.u, 1));
    btn.type = 'button';
    btn.title = 'Jump both videos here';
    btn.addEventListener('click', () => { pauseAB(); seekAB(row.u); });
    at.appendChild(btn);
    const ms = (v) => (v === null ? node('td', 'dash', '—') : node('td', '', `${v.toFixed(1)} ms`));
    const where = row.a !== null && row.b !== null ? ['', 'Both'] : row.a !== null ? ['ca', 'A only'] : ['cb', 'B only'];
    tr.append(at, ms(row.a), ms(row.b), node('td', `where ${where[0]}`, where[1]));
    row.tr = tr;
    body.appendChild(tr);
  }
}

function setOffset(v) {
  if (!Number.isFinite(v) || !abReady()) { renderAB(); return; }
  pauseAB();
  const keepA = ab.u + shift('a'); // A's picture stays where it is
  ab.offset = Math.round(v * 1000) / 1000;
  ab.u = keepA - shift('a');
  renderAB();
}
$('ab-offset').addEventListener('change', () => setOffset(Number($('ab-offset').value.replace(/[−–]/g, '-').replace(/s\s*$/i, '').trim())));
for (const b of document.querySelectorAll('.ab-step')) {
  b.addEventListener('click', () => {
    if (!abReady()) return;
    const st = b.dataset.step, frame = 1 / (abSum('b').capture.refresh_hz || 60);
    setOffset(ab.offset + (st === 'f' ? frame : st === '-f' ? -frame : Number(st)));
  });
}

for (const k of SIDES) {
  $(`ab-title-${k}`).addEventListener('input', () => { if (ab[k]) { ab[k].title = $(`ab-title-${k}`).value; if (abReady() && !mixedTargets()) drawAB(); } });
  $(`ab-sub-${k}`).addEventListener('input', () => { if (ab[k]) ab[k].sub = $(`ab-sub-${k}`).value; });
  $(`ab-title-${k}`).addEventListener('change', () => { if (abReady()) renderAbVerdict(); });
  const menu = $(`ab-list-${k}`).parentElement;
  menu.addEventListener('toggle', () => { if (menu.open) fillPicker(k); });
}

$('ab-playbtn').addEventListener('click', () => (ab.playing ? pauseAB() : playAB()));
$('ab-prev-hitch').addEventListener('click', () => jumpAbHitch(-1));
$('ab-next-hitch').addEventListener('click', () => jumpAbHitch(1));
$('ab-back').addEventListener('click', () => stepAbFrame(-1));
$('ab-fwd').addEventListener('click', () => stepAbFrame(1));
$('ab-scrub').addEventListener('input', () => seekAB(Number($('ab-scrub').value)));
for (const r of document.querySelectorAll('input[name="ab-sound"]')) {
  r.addEventListener('change', () => {
    ab.sound = radioValue('ab-sound');
    for (const k of SIDES) Object.assign($(`ab-video-${k}`), { muted: ab.sound !== k, playbackRate: 1 }); // the leader may change
  });
}
ab.sound = radioValue('ab-sound');
for (const r of document.querySelectorAll('input[name="ab-view"]')) r.addEventListener('change', () => { if (abReady()) { ab.view = radioValue('ab-view'); drawAB(); tickAB(); } });
// A click on the graph or a lane jumps both videos there.
for (const id of ['ab-svg', 'ab-diff-svg', 'ab-lane-a', 'ab-lane-b']) {
  $(id).addEventListener('click', (e) => {
    if (!abReady()) return;
    const r = $(id).getBoundingClientRect();
    pauseAB();
    seekAB(((e.clientX - r.left) / r.width) * abSpan());
  });
}

$('ab-swap').addEventListener('click', () => {
  if (!abReady()) return;
  [ab.a, ab.b] = [ab.b, ab.a];
  ab.offset = -ab.offset;
  for (const k of SIDES) loadAbVideo(k);
  renderAB();
});

$('ab-copy').addEventListener('click', async () => {
  if (!abReady()) return;
  const lines = [$('ab-sentence').textContent, `A: ${ab.a.title || ab.a.q.stem} · B: ${ab.b.title || ab.b.q.stem} · B offset ${fmtOffset(ab.offset)}`];
  for (const tr of $('ab-numbers').rows) lines.push([...tr.cells].map((c) => c.innerText.replace(/\s+/g, ' ').trim()).join(' · '));
  const label = $('ab-copy').lastChild;
  try {
    await navigator.clipboard.writeText(lines.filter(Boolean).join('\n'));
    label.textContent = 'Copied';
    setTimeout(() => { label.textContent = 'Copy summary'; }, 1500);
  } catch (e) {
    $('compare-status').textContent = `Could not copy: ${e.message}`;
  }
});

// ---- the export menu ----

const ABX_SIZES = {
  '16:9': [['1080', '1080p', 1920, 1080], ['1440', '1440p', 2560, 1440], ['2160', '4K', 3840, 2160]],
  '21:9': [['1080', '2560×1080', 2560, 1080], ['2160', '4K · 5120×2160', 5120, 2160]],
};
const even = (v) => Math.round(v / 2) * 2;

function syncAbExport() {
  const frame = radioValue('abx-frame');
  const below = $('abx-fit-below');
  below.disabled = frame !== '21:9';
  if (below.disabled && below.checked) $('abx-fit-letterbox').checked = true;
  const box = $('abx-sizes'), cur = box.querySelector('input:checked');
  const want = cur ? cur.value : '1080';
  const sizes = ABX_SIZES[frame], fid = document.activeElement.id; // rebuilding the radios drops keyboard focus to the page
  box.replaceChildren();
  for (const [v, label] of sizes) {
    const input = node('input', 'vis');
    Object.assign(input, { type: 'radio', name: 'abx-size', id: `abx-size-${v}`, value: v, checked: v === want });
    const l = node('label', '', label);
    l.htmlFor = input.id;
    input.addEventListener('change', syncAbExport);
    box.append(input, l);
  }
  if (!box.querySelector('input:checked')) box.querySelector('input').checked = true;
  if (fid && document.activeElement === document.body && $(fid)) $(fid).focus();
  const fit = radioValue('abx-fit'), size = sizes.find(([v]) => v === radioValue('abx-size'));
  const [, , W, H] = size;
  // Panes are half the width; letterbox and data-below leave bands for the data (artboard 720 high: 360 or 480 of it).
  const pw = even(W / 2), ph = fit === 'crop' ? H : even(frame === '16:9' ? H / 2 : (H * 480) / 720);
  const gpu = radioValue('opt-enc') === 'gpu', hevc = gpu && W > 4096;
  $('abx-sum').textContent = `${W}×${H} · each video ${pw}×${ph} · ${hevc ? 'HEVC' : 'H.264'} on ${gpu ? 'GPU' : 'CPU'}`;
  $('abx-time').hidden = H < 2160;
  $('abx-time').textContent = `About 4× the render time of ${frame === '21:9' ? '2560×1080' : '1080p'}`;
  $('abx-hevc').hidden = !hevc;
  $('abx-fit-hint').textContent = (fit === 'crop' ? `Crop keeps the centre ${frame === '21:9' ? 67 : 50}% of each video's width.`
    : fit === 'below' ? 'Each video keeps its whole picture; the data sits in one band underneath.'
      : 'Each video keeps its whole picture, with the data in bands around it.') + ' Data below is 21:9 only.';
  const src = $('opt-upscaler').querySelector('option[value="fsrcnnx"]'), o = $('abx-upscaler').querySelector('option[value="fsrcnnx"]');
  o.disabled = src.disabled;
  o.textContent = src.textContent;
  if (o.disabled && o.selected) $('abx-upscaler').value = 'lanczos';
}
for (const name of ['abx-frame', 'abx-fit']) for (const r of document.querySelectorAll(`input[name="${name}"]`)) r.addEventListener('change', syncAbExport);
$('ab-export-menu').addEventListener('toggle', () => {
  if (!$('ab-export-menu').open) return;
  if (!abReady()) {
    $('ab-export-menu').open = false;
    $('compare-status').textContent = 'Choose A and B first.';
    return;
  }
  $('abx-upscaler').value = $('opt-upscaler').value;
  syncAbExport();
});
$('ab-export-open').addEventListener('click', (e) => { if (!abReady()) e.preventDefault(); });
$('abx-cancel').addEventListener('click', () => { $('ab-export-menu').open = false; });
$('abx-go').addEventListener('click', async () => {
  $('ab-export-menu').open = false;
  if (!abReady() || state.running) return;
  await state.gpuReady;
  pauseAB();
  const o = renderOptions();
  const opts = {
    inputs: SIDES.map((k) => ({ video: abVideoPath(k), outDir: ab[k].q.result.outDir, title: ab[k].title.trim() || ab[k].q.stem, subtitle: ab[k].sub.trim(), start: ab[k].base })),
    offset: ab.offset, frame: radioValue('abx-frame'), fit: radioValue('abx-fit'), size: radioValue('abx-size'),
    encoder: o.encoder, quality: o.quality, upscaler: $('abx-upscaler').value, sound: ab.sound.toUpperCase(), endCard: true,
    watermark: o.watermark,
  };
  runCompareExport(() => window.api.compareAB(opts));
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') for (const m of document.querySelectorAll('details.menu[open]')) m.open = false;
  if (!viewIs('view-compare') || $('ab-mode').hidden || !abReady() || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === ' ' && e.target === document.body) { e.preventDefault(); $('ab-playbtn').click(); }
  else if (e.key === ',') stepAbFrame(-1);
  else if (e.key === '.') stepAbFrame(1);
  else if (e.key === 'h' || e.key === 'H') jumpAbHitch(e.key === 'h' ? 1 : -1);
});

// ---------- compare: edit & export ----------

// A project of 2 or 3 tracks of clips on one timeline (the model is in src/core/timeline.js). Times are timeline
// seconds; a clip shows its source video from `in` to `out`, starting at `at`. The monitor lays the panes out
// from the core's layoutBoxes in px of a 720-high board, as the export's artboards are drawn, then scales it.
const LETTERS = ['A', 'B', 'C'];
const TK = ['var(--a)', 'var(--b)', 'var(--c)']; // a track's colour in the window
const TK_VIDEO = ['#4F9CF9', '#C084FC', '#34D399']; // and on the video, in every window theme
const ED_FITS = { letterbox: 'Letterbox', crop: 'Crop', below: 'Data below', third: '21:9 · 3 videos' };
const ED_CROPS = ['crop', 'third']; // the fits that crop, where pan and zoom apply
const FPS_TOP = 0.219, FPS_HALF = 0.9375; // where the target and half of it sit in an FPS graph, from its top (as the export)
const edNewTrack = () => ({ title: '', subtitle: '', clips: [] });
const ed = {
  p: { tracks: [edNewTrack(), edNewTrack()], range: null, frame: '16:9', fit: 'letterbox', size: '1080', sound: 0 },
  t: 0, sel: null, tab: 'media', zoom: 0, pps: 1, snap: true, exact: false, safe: true,
  data: null, boxes: null, error: '', media: new Map(), series: [], undo: [], redo: [],
  videos: [], spare: [], cur: [], pv: [], board: null, scale: 1, // spare: per track, the next clip cued before a cut
  playing: false, playSeq: 0, clock: 0, lastStep: 0, dataSeq: 0, exactSeq: 0, restored: false, notice: '',
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ms3 = (v) => Math.round(v * 1000) / 1000;
const clipLen = (c) => c.out - c.in;
const clipEnd = (c) => c.at + c.out - c.in;
const edMedia = (c) => ed.media.get(c.outDir) || null; // { video, name, stem, data: abData } once read
const edTrackEnd = (tr) => Math.max(0, ...tr.clips.map(clipEnd));
const edClipId = (ti, ci) => `${LETTERS[ti]}${ci + 1}`;
const edSelClip = () => (ed.sel && ed.p.tracks[ed.sel.ti] && ed.p.tracks[ed.sel.ti].clips[ed.sel.ci]) || null;
const edCrops = () => ED_CROPS.includes(ed.p.fit);
const edHz = (c) => (edMedia(c) && edMedia(c).data.summary.capture.refresh_hz) || 60;
const edFrameStep = () => 1 / Math.max(60, ...ed.p.tracks.flatMap((tr) => tr.clips.map(edHz)));
const fmtPan = (p) => `${p < 0 ? '−' : ''}${Math.abs(Math.round(p * 100))}%`;
const edStatus = (text) => { $('compare-status').textContent = text; };
/** The export range: the one set, or 0 to the end of the shortest track that has clips (as the core has it). */
function edRange() {
  const ends = ed.p.tracks.filter((tr) => tr.clips.length).map(edTrackEnd);
  return ed.p.range || { in: 0, out: ends.length ? Math.min(...ends) : 0 };
}
/** What the ruler spans: the range and every clip, at least 10 s. */
const edLength = () => Math.max(10, edRange().out, ...ed.p.tracks.map(edTrackEnd));
/** Where a clip's analysis lies in its source video: [start, end] s (source time = analysis time + start_s). */
function edSrcSpan(c) {
  const cap = edMedia(c).data.summary.capture, st = cap.start_s || 0;
  return [st, st + cap.seconds];
}
const edTarget = (ti) => {
  const c = ed.p.tracks[ti].clips.find(edMedia);
  return c ? edMedia(c).data.summary.target_fps : null;
};
function edTrackTitle(ti) {
  const tr = ed.p.tracks[ti], c = tr.clips.find(edMedia);
  return tr.title.trim() || (c ? edMedia(c).stem : `Track ${LETTERS[ti]}`);
}
const edClipAt = (ti, t) => ed.p.tracks[ti].clips.find((c) => t >= c.at && t < clipEnd(c)) || null;
/** The time the monitor shows for t: at the range's end, its last frame (a clip ending there is not a gap yet). */
const edShowT = (t) => { const out = edRange().out; return Math.abs(t - out) < 1e-6 ? Math.max(0, out - edFrameStep()) : t; };

/** The project as the core takes it. */
function edProject() {
  const o = renderOptions();
  return {
    tracks: ed.p.tracks.map((tr, ti) => ({
      title: edTrackTitle(ti), subtitle: tr.subtitle.trim(),
      clips: tr.clips.map(({ video, outDir, in: i, out, at, pan, zoom }) => ({ video, outDir, in: i, out, at, pan, zoom })),
    })),
    range: { ...edRange() }, frame: ed.p.frame, fit: ed.p.fit, size: ed.p.size, sound: ed.p.sound,
    encoder: o.encoder, quality: o.quality, upscaler: o.upscaler, endCard: true, watermark: o.watermark,
  };
}

// ---- changes: every edit is a snapshot of the project JSON, so it can be undone ----

const edSnap = () => JSON.stringify(ed.p);
/** Clips in time order on each track, the selection following its clip. */
function edNormalise() {
  const s = edSelClip();
  for (const tr of ed.p.tracks) tr.clips.sort((x, y) => x.at - y.at);
  ed.sel = null;
  ed.p.tracks.forEach((tr, ti) => { const ci = tr.clips.indexOf(s); if (ci >= 0) ed.sel = { ti, ci }; });
}
/** One undo step: the project as it was, with the selection it had then. */
function edPush(before, sel = ed.sel) {
  if (before === edSnap()) return;
  ed.undo.push({ p: before, sel });
  if (ed.undo.length > 100) ed.undo.shift();
  ed.redo = [];
  edChanged();
}
function edCommit(fn) {
  const before = edSnap(), sel = ed.sel;
  edPause();
  fn();
  edNormalise();
  edPush(before, sel);
}
function edUndo(dir) {
  const from = dir < 0 ? ed.undo : ed.redo, to = dir < 0 ? ed.redo : ed.undo;
  if (!from.length) return;
  edPause();
  to.push({ p: edSnap(), sel: ed.sel });
  const { p, sel } = from.pop();
  ed.p = JSON.parse(p);
  // A track the snapshot does not have (undoing '+ Track C') lets go of its videos, as removing it does.
  for (let ti = Math.max(ed.videos.length, ed.spare.length) - 1; ti >= ed.p.tracks.length; ti--) edDropVideos(ti);
  ed.sel = sel && ed.p.tracks[sel.ti] && ed.p.tracks[sel.ti].clips[sel.ci] ? sel : null;
  edChanged();
}
function edChanged() {
  ed.notice = ''; // the restore notice stays up until the first edit
  try { localStorage.setItem('editProject', edSnap()); } catch (_) { /* the session still works */ }
  ed.series = ed.p.tracks.map((_, ti) => edTrackSeries(ti));
  edRender();
  edFetchSoon();
}

/** A clip's recording: probed (so main may read the video) and its analysis read (so main may use the folder). */
async function edLoadMedia(video, outDir) {
  if (ed.media.has(outDir)) return true;
  if (!state.queue.some((q) => q.path === video || (q.result && q.result.video === video))) {
    const pr = await window.api.probe(video);
    if (!pr.ok) return false;
  }
  const r = await window.api.abData(outDir);
  if (!r.ok) return false;
  const name = fileName(video);
  ed.media.set(outDir, { video, outDir, name, stem: name.replace(/\.[^.]+$/, ''), data: r.result });
  return true;
}

/** The last project, with the clips whose recording or analysis is gone dropped. */
async function edRestore() {
  ed.restored = true;
  let p = null;
  try { p = JSON.parse(localStorage.getItem('editProject') || 'null'); } catch (_) { /* none */ }
  if (!p || !Array.isArray(p.tracks) || p.tracks.length < 2 || p.tracks.length > 3) return;
  let dropped = 0;
  for (const tr of p.tracks) {
    const keep = [];
    for (const c of Array.isArray(tr.clips) ? tr.clips : []) {
      if (c && typeof c.video === 'string' && typeof c.outDir === 'string' && await edLoadMedia(c.video, c.outDir)) keep.push(c);
      else dropped++;
    }
    tr.clips = keep;
  }
  ed.p = { ...ed.p, ...p, tracks: p.tracks.map((tr) => ({ ...edNewTrack(), ...tr })) };
  edNormalise();
  if (dropped) edStatus(ed.notice = `${dropped} clip${dropped === 1 ? ' was' : 's were'} left out of the last project: the recording or its analysis is gone.`);
}

/** Where a clip of len s may start on a track near `at`: there if it fits, else after the last clip. */
function edFreeAt(tr, at, len) {
  const fits = !tr.clips.some((c) => at < clipEnd(c) - 1e-6 && at + len > c.at + 1e-6);
  return fits ? at : edTrackEnd(tr);
}

/** Add an analysed recording to track ti, its whole analysed range, at the end or where it was dropped. */
async function edAdd(cand, ti, at = null) {
  const q = cand.q || await itemForEntry(cand.e);
  if (!q || !q.result || !q.result.outDir) { edStatus(`${cand.name} could not be read back. Analyse it again.`); return; }
  const video = q.result.video || q.path;
  if (!(await edLoadMedia(video, q.result.outDir))) { edStatus(`${cand.name} has no readable analysis. Analyse it again.`); return; }
  edCommit(() => {
    const tr = ed.p.tracks[ti], c = { video, outDir: q.result.outDir, in: 0, out: 0, at: 0, pan: 0, zoom: 1 };
    [c.in, c.out] = edSrcSpan(c).map(ms3);
    c.at = ms3(at == null ? edTrackEnd(tr) : edFreeAt(tr, Math.max(0, at), clipLen(c)));
    tr.clips.push(c);
    ed.sel = { ti, ci: tr.clips.length - 1 };
    ed.tab = 'clip';
  });
}

// ---- what each track shows on the timeline: play FPS, worst frame of each second, hitches, stills ----

function edTrackSeries(ti) {
  const out = { fps: [], ft: [], hitches: [], paused: [], gaps: [] };
  let end = edRange().in;
  for (const c of ed.p.tracks[ti].clips) {
    if (c.at - end > 0.05) out.gaps.push([end, c.at]);
    end = Math.max(end, clipEnd(c));
    const m = edMedia(c);
    if (!m) continue;
    const st = m.data.summary.capture.start_s || 0;
    const tl = (a) => c.at + a + st - c.in; // analysis time -> timeline
    const inside = (a) => a + st >= c.in && a + st < c.out;
    const p0 = out.paused.length;
    for (const [a, ms, kind] of m.data.paused) {
      const a0 = Math.max(a + st, c.in), a1 = Math.min(a + st + ms / 1000, c.out);
      if (a1 > a0) out.paused.push([c.at + a0 - c.in, c.at + a1 - c.in, kind]);
    }
    // A second touching a still or load has no frame-time step: the export shows that span as a band, not a frame.
    const held = (x) => out.paused.slice(p0).some(([a, b]) => x - 0.5 < b && x + 0.5 > a);
    for (const [key, rows] of [['fps', m.data.playFps], ['ft', m.data.ftMax]]) {
      for (const [sec, v] of rows) if (inside(sec + 0.5)) out[key].push([tl(sec + 0.5), key === 'ft' && held(tl(sec + 0.5)) ? null : v]);
      out[key].push([clipEnd(c), null]); // the line breaks between clips
    }
    for (const [a, ms] of m.data.hitches) if (inside(a)) out.hitches.push([tl(a), ms]);
  }
  if (edRange().out - end > 0.05) out.gaps.push([end, edRange().out]);
  return out;
}

/** What track ti shows at t: a gap or a still or load (named as the export names it, with its length), or the play
 * FPS of the nearest second that has one. */
function edLive(ti, t) {
  const c = edClipAt(ti, t);
  if (!c || !edMedia(c)) {
    const r = edRange(), clips = ed.p.tracks[ti].clips;
    const a = Math.max(r.in, ...clips.filter((k) => clipEnd(k) <= t + 1e-6).map(clipEnd)), b = Math.min(r.out, ...clips.filter((k) => k.at > t).map((k) => k.at));
    return { gap: true, held: 'NO VIDEO', len: b - a };
  }
  const s = ed.series[ti] || { fps: [], paused: [] };
  const held = s.paused.find(([a, b]) => t >= a && t < b);
  if (held) return { held: held[2] === 'loading' ? 'LOADING' : 'STILL', len: held[1] - held[0] };
  // The number the export shows (projectData's 0.25 s steps), while the numbers are for this project as it is.
  const td = ed.data && ed.dataSnap === edSnap() && ed.data.tracks[ti], k = td && td.live ? Math.floor((t - ed.data.project.range.in) / 0.25 + 1e-6) : -1;
  if (k >= 0 && k < td.live.length) return { fps: td.live[k] };
  let best = null;
  for (const [x, v] of s.fps) if (v !== null && x >= c.at && x < clipEnd(c) && (!best || Math.abs(x - t) < Math.abs(best[0] - t))) best = [x, v];
  return { fps: best ? best[1] : null };
}

// ---- the program monitor ----

/** The export size and each pane in px of the 720-high board: { W, H, bw, panes: [{ x, y, w, h, video }] }. */
function edBoard() {
  const sizes = ABX_SIZES[ed.p.frame], [, , W, H] = sizes.find(([v]) => v === ed.p.size) || sizes[0];
  const bw = (720 * W) / H, n = ed.p.tracks.length;
  const lb = ed.boxes;
  if (lb && Array.isArray(lb.panes) && lb.panes.length === n && lb.width === W && lb.fit === ed.p.fit) {
    const k = 720 / lb.height, sc = (r) => ({ x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k });
    return { W, H, bw, panes: lb.panes.map((pn, i) => ({ ...sc(pn), video: sc(lb.videos[i]) })) };
  }
  // Until the core has laid it out (an empty project): the same rules, in board px.
  const pw = bw / n;
  return {
    W, H, bw, panes: ed.p.tracks.map((_, i) => {
      const x = i * pw, v = ed.p.fit === 'third' ? { y: 72, h: 480 } : ed.p.fit === 'crop' ? { y: 0, h: 720 } // as videoRects in compare-ab.js
        : ed.p.fit === 'below' ? { y: 0, h: (pw * 9) / 16 } : { y: ed.p.frame === '21:9' ? 60 : 180, h: (pw * 9) / 16 };
      return { x, y: 0, w: pw, h: 720, video: { x, w: pw, ...v } };
    }),
  };
}

/** The source's crop window at the clip's pan and zoom, as fractions of the source frame. */
function edCropWindow(ti, c) {
  const m = edMedia(c), pn = ed.board && ed.board.panes[ti];
  if (!m || !pn || !edCrops()) return { x: 0, y: 0, w: 1, h: 1 };
  const cap = m.data.summary.capture, vr = pn.video;
  const s = Math.max(vr.w / cap.width, vr.h / cap.height) * (c.zoom || 1), SW = cap.width * s, SH = cap.height * s;
  return { x: ((SW - vr.w) * ((c.pan || 0) + 1)) / 2 / SW, y: (SH - vr.h) / 2 / SH, w: vr.w / SW, h: vr.h / SH, room: SW - vr.w };
}

function edNewVideo() {
  const v = document.createElement('video');
  Object.assign(v, { preload: 'auto', playsInline: true, muted: true });
  v._lead = { seek: 0.25, load: 0.5 }; // s a seek, or opening another file, takes while playing; learnt as it plays
  v.addEventListener('loadedmetadata', () => { if (v._want != null) { v.currentTime = v._want; v._want = null; } });
  v.addEventListener('error', () => { if (v.getAttribute('src')) edStatus(`${decodeURI(v.getAttribute('src')).split('/').pop()} does not play here; use Exact frame to see it.`); });
  return v;
}
const edVideo = (ti) => ed.videos[ti] || (ed.videos[ti] = edNewVideo());
/** Track ti's second video: hidden, it opens the clip that follows straight on and waits on its In, so the cut is a swap. */
const edSpare = (ti) => ed.spare[ti] || Object.assign(ed.spare[ti] = edNewVideo(), { hidden: true });
const edAllVideos = () => [...ed.videos, ...ed.spare].filter(Boolean);

/** The video of track ti cropped into its pane as the export crops it (or whole, letterboxed, where it does not crop):
 * the one on screen, or v cued on clip c. */
function edFitVideo(ti, v = ed.videos[ti], c = ed.cur[ti]) {
  const pn = ed.board && ed.board.panes[ti];
  if (!v || !c || !pn) return;
  if (!edCrops()) { v.className = 'fit'; v.removeAttribute('style'); return; }
  const w = edCropWindow(ti, c), W = pn.video.w / w.w, H = pn.video.h / w.h;
  v.className = '';
  Object.assign(v.style, { width: `${W}px`, height: `${H}px`, left: `${-w.x * W}px`, top: `${-w.y * H}px` });
}

/** Show source time `at` of `video` on v. While playing (live), aim where the clock will be once it has landed and
 * started moving again, by what the last seeks took; edStep learns the lead from where each one did (v._calib). */
function edCue(v, video, at, live) {
  const url = fileUrl(video), load = v.getAttribute('src') !== url, lead = live ? v._lead[load ? 'load' : 'seek'] : 0;
  v._calib = live ? (load ? 'load' : 'seek') : null;
  edCued(v, live ? at + lead : null);
  if (load) { v._want = at + lead; v.src = url; }
  else if (v.readyState) v.currentTime = at + lead;
  else v._want = at + lead;
}

/** Point track ti's video at timeline time t: another clip switches src or seeks; a gap hides it. While playing
 * (live), a gap waits on the next clip's first frame, so that clip only has to start when its time comes. */
function edPlace(ti, t, hard = false, live = false) {
  let v = edVideo(ti);
  const ts = edShowT(t), c = edClipAt(ti, ts), sp = ed.spare[ti];
  if (c !== ed.cur[ti]) {
    ed.cur[ti] = c;
    if (live && c && sp && sp._pre === c && !sp.seeking && sp.readyState >= 2) {
      // Cued on the spare before the cut: swap the two, so the new clip shows from its In with no load or seek.
      [ed.videos[ti], ed.spare[ti]] = [sp, v];
      v.pause();
      Object.assign(v, { hidden: true, muted: true, playbackRate: 1, _pre: null, _cueT: null, _calib: null, _hold: false });
      v = sp;
      v._pre = null;
      edFitVideo(ti);
      v.hidden = false;
      v.muted = ed.p.sound !== ti;
      edCued(v, Math.max(v.currentTime, c.in)); // left alone till it moves on from there
      if (v.paused) v.play().catch(() => {});
      return v;
    }
    if (c && sp && sp._pre === c) { sp.pause(); sp._pre = null; } // not ready in time: the clip loads on the one on screen
    hard = true;
    edFitVideo(ti);
  }
  if (live && c) {
    // The clip that follows straight on: cue it on the spare from 1.5 s before, and start it (hidden) a moment early.
    const next = ed.p.tracks[ti].clips.find((k) => k.at >= clipEnd(c) - 1e-3 && k.at - clipEnd(c) < 0.05);
    if (next && next.at - ts < 1.5) {
      const s2 = edSpare(ti);
      if (s2._pre !== next) { s2._pre = next; edFitVideo(ti, s2, next); edCue(s2, next.video, next.in, false); }
      else if (next.at - ts < 0.05 && !s2.seeking && s2.readyState >= 3 && s2.paused) s2.play().catch(() => {});
    }
  }
  v.hidden = !c;
  v.muted = ed.p.sound !== ti;
  if (!c) {
    const next = live && ed.p.tracks[ti].clips.find((k) => k.at > ts);
    if (next && next.at - ts < 3 && v._pre !== next) { v._pre = next; edCue(v, next.video, next.in, false); }
    // Started a moment early (still hidden), so it is moving when its time comes.
    if (next && v._pre === next && next.at - ts < 0.05 && !v.seeking && v.readyState >= 3) { if (v.paused) v.play().catch(() => {}); }
    else if (!v.paused) v.pause();
    return null;
  }
  const want = c.in + ts - c.at, pre = v._pre === c;
  v._pre = null;
  if (live && pre && !v.seeking && want - c.in < 0.1) { edCued(v, c.in); return v; } // cued in the gap: it only has to start
  if (hard || v.getAttribute('src') !== fileUrl(c.video)) edCue(v, c.video, want, live);
  return v;
}

const pvEl = (cls, style, text) => { const n = node('div', cls, text); Object.assign(n.style, style); return n; };
const px = (v) => `${v}px`;

function edBuildMonitor() {
  const b = ed.board = edBoard();
  $('ed-monitor').style.aspectRatio = `${b.W} / ${b.H}`;
  // Its height is capped to keep the timeline's tracks in view (styles.css): the width follows from the frame.
  $('ed-monitor').style.setProperty('--ar', String(b.W / b.H));
  $('edit-mode').style.setProperty('--ed-n', String(ed.p.tracks.length));
  const board = $('ed-board'), exactImg = $('ed-exact-img');
  Object.assign(board.style, { width: px(b.bw), height: '720px' });
  board.replaceChildren();
  const r = edRange(), len = Math.max(0.001, r.out - r.in), wm = renderOptions().watermark;
  ed.pv = b.panes.map((pn, ti) => {
    const color = TK_VIDEO[ti], v = { x: pn.video.x - pn.x, y: pn.video.y - pn.y, w: pn.video.w, h: pn.video.h };
    const pane = pvEl('pv-pane', { left: px(pn.x), top: px(pn.y), width: px(pn.w), height: px(pn.h) });
    const vid = pvEl('pv-vid', { left: px(v.x), top: px(v.y), width: px(v.w), height: px(v.h) });
    const none = pvEl('pv-none', {}, 'NO VIDEO');
    vid.append(edVideo(ti), edSpare(ti), none);
    pane.appendChild(vid);
    // Name and live FPS: in the band above the video when there is one, else on the video.
    const above = v.y >= 60;
    const name = pvEl(`pv-name${above ? '' : ' on-video'}`, above ? { left: 0, top: 0, width: px(pn.w), height: px(Math.min(v.y, 72)) }
      : { left: px(v.x + 12), top: px(v.y + 12), maxWidth: px(v.w - 286) });
    const names = node('div', 'pv-names'), title = node('div', 'pv-title'), tag = node('span', 'pv-tag', LETTERS[ti]);
    tag.style.background = color;
    title.append(tag, node('b', '', edTrackTitle(ti)));
    names.append(title);
    if (ed.p.tracks[ti].subtitle.trim()) names.appendChild(node('span', 'pv-sub', ed.p.tracks[ti].subtitle.trim()));
    const live = node('div', 'pv-live'), num = node('b'), unit = node('span', '', 'FPS');
    live.append(num, unit);
    name.append(names, live);
    pane.appendChild(name);
    // FPS over the whole range, the part played bright, with the playhead.
    const target = edTarget(ti) || 60, s = ed.series[ti] || { fps: [], ft: [] };
    const fy = (val) => clamp(160 * (FPS_TOP + (1 - val / target) * 2 * (FPS_HALF - FPS_TOP)), 0, 160);
    const fps = pvEl('pv-box pv-fps', { right: px(pn.w - v.x - v.w + 12), top: px(v.y + 12) });
    fps.appendChild(node('span', 'pv-cap', `FPS · TARGET ${target}`));
    const g = pvEl('pv-graph', { paddingRight: '32px' });
    const svg = el('svg', { viewBox: '0 0 1000 160', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    svg.style.height = '60px'; // a style attribute would break the page's CSP
    const ln = (y, op, dash) => el('line', { x1: 0, x2: 1000, y1: y, y2: y, stroke: '#F5F6F8', 'stroke-opacity': op, 'vector-effect': 'non-scaling-stroke', ...(dash ? { 'stroke-dasharray': '4 4' } : {}) });
    const pts = [];
    for (const [x, val] of s.fps) if (x >= r.in && x <= r.out) pts.push(val === null ? null : `${(((x - r.in) / len) * 1000).toFixed(1)},${fy(val).toFixed(1)}`);
    const lines = pts.join(' ').split(/\s*null\s*/).filter(Boolean);
    const clipId = `pv-clip-${ti}`, clipDef = el('clipPath', { id: clipId }), clipRect = el('rect', { x: 0, y: 0, width: 0, height: 160 });
    clipDef.appendChild(clipRect);
    const defs = el('defs');
    defs.appendChild(clipDef);
    svg.append(defs, ln(150, 0.15), ln(35.1, 0.45, true));
    for (const p of lines) svg.appendChild(el('polyline', { points: p, fill: 'none', stroke: color, 'stroke-opacity': 0.4, 'stroke-width': 3, 'vector-effect': 'non-scaling-stroke' }));
    const bright = el('g', { 'clip-path': `url(#${clipId})` });
    for (const p of lines) bright.appendChild(el('polyline', { points: p, fill: 'none', stroke: color, 'stroke-width': 3, 'vector-effect': 'non-scaling-stroke' }));
    const phLine = el('line', { x1: 0, x2: 0, y1: 0, y2: 160, stroke: '#F5F6F8', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' });
    svg.append(bright, phLine);
    g.append(svg, pvEl('pv-gut t', { top: '21.9%' }, String(target)), pvEl('pv-gut', { top: '93.75%' }, String(target / 2)));
    fps.appendChild(g);
    pane.appendChild(fps);
    // Frame time of the last 10 s: in the band below the video, or on the video above YouTube's controls.
    const below = pn.h - v.y - v.h >= 120, ftBottom = below ? 0 : Math.max(pn.h - 662.4, pn.h - v.y - v.h + 12);
    const ft = pvEl(`pv-ft${below ? '' : ' on-video'}`, below ? { left: 0, top: px(v.y + v.h), width: px(pn.w), padding: '8px 16px 0' }
      : { left: px(v.x + 12), width: px(v.w - 24), bottom: px(ftBottom) });
    const head = node('div', 'pv-ft-head');
    head.appendChild(node('span', '', `${LETTERS[ti]} · FRAME TIME · ms`));
    if (wm && ti === b.panes.length - 1) head.appendChild(node('span', '', wm));
    const tf = 1000 / target, fsvg = el('svg', { viewBox: '0 0 1000 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    fsvg.style.height = '64px';
    const ftLine = el('path', { fill: 'none', stroke: color, 'stroke-width': 3, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' });
    const ftBands = el('path', { fill: '#F5F6F8', 'fill-opacity': 0.14 }); // stills, loads and gaps, as the export dims them
    fsvg.append(ftBands, ln(25, 0.15), ln(50, 0.1), ftLine, ln(75, 0.6, true));
    const fg = pvEl('pv-graph', { paddingRight: '62px' });
    const r1 = (x) => String(Math.round(x * 10) / 10);
    fg.append(fsvg, pvEl('pv-gut', { top: '25%' }, r1(3 * tf)), pvEl('pv-gut t', { top: '75%' }, r1(tf)));
    ft.append(head, fg);
    pane.appendChild(ft);
    // The numbers over the export range, and the HITCH tag above them.
    const statsBottom = below ? pn.h - v.y - v.h + 12 : ftBottom + 120;
    const stats = pvEl('pv-box pv-stats', { left: px(v.x + 12), bottom: px(statsBottom) });
    // A track with nothing to count in the range (all gap) has no numbers, not red zeros.
    const td = ed.data && ed.data.tracks && ed.data.tracks[ti], sum = td && td.gapS < len - 0.05 && td.summary;
    // During a still, a load or a gap the line gives way to its name and length, as in the export (edTick).
    const sline = node('span'), shold = node('span');
    if (sum) {
      const bv = (val) => { const lv = level(Number(val.toFixed(1)), target); return node('b', lv === 'ok' ? '' : `pv-${lv}`, val.toFixed(1)); };
      sline.append('AVG ', bv(sum.avg_fps), ' · 1% ', bv(sum.low_1pct_fps), ' · ', node('b', '', String(sum.hitches.count)), ' HITCHES');
    }
    stats.append(sline, shold);
    stats.hidden = !sum;
    pane.appendChild(stats);
    const hitch = pvEl('pv-hitch', { left: px(v.x + 12), bottom: px(statsBottom + 52) });
    pane.appendChild(hitch);
    board.appendChild(pane);
    const tfMax = 4 * tf;
    return { none, num, unit, clipRect, phLine, ftLine, ftBands, hitch, stats, sline, shold, hasSum: Boolean(sum), ftY: (val) => clamp(100 - (val / tfMax) * 100, 0, 100) };
  });
  // The exact frame covers the live panes, but not the selected clip's outline.
  board.appendChild(exactImg);
  // The selected clip's crop window, in its track's colour; dragging it sideways pans. Shown while that clip is at the playhead (edTick).
  const c = edSelClip();
  ed.selOut = null;
  if (c && b.panes[ed.sel.ti]) {
    const vr = b.panes[ed.sel.ti].video, out = pvEl('pv-sel', { left: px(vr.x), top: px(vr.y), width: px(vr.w), height: px(vr.h) });
    out.style.setProperty('--tk', TK_VIDEO[ed.sel.ti]);
    out.id = 'pv-sel';
    out.title = edCrops() ? 'Drag sideways to pan the crop' : 'This layout shows the whole picture';
    out.appendChild(node('span', '', `${edClipId(ed.sel.ti, ed.sel.ci)}${edCrops() ? ` · pan ${fmtPan(c.pan || 0)}` : ''}`));
    board.appendChild(out);
    ed.selOut = out;
  }
  if (ed.playing) ed.p.tracks.forEach((_, ti) => edFitVideo(ti)); // as they are: placing them again would seek every one
  else {
    ed.cur = [];
    ed.p.tracks.forEach((_, ti) => edPlace(ti, ed.t, true));
  }
  edScale();
  edTick();
}

/** Fit the board in the monitor (the whole screen in full screen), with the safe-area strip on the picture. */
function edScale() {
  const m = $('ed-monitor'), b = ed.board;
  if (!b || !m.clientWidth) return;
  const s = Math.min(m.clientWidth / b.bw, m.clientHeight / 720), ox = (m.clientWidth - b.bw * s) / 2, oy = (m.clientHeight - 720 * s) / 2;
  ed.scale = s;
  $('ed-board').style.transform = `translate(${ox}px, ${oy}px) scale(${s})`;
  Object.assign($('ed-safe-strip').style, { left: px(ox), right: 'auto', width: px(b.bw * s), bottom: px(oy), height: px(57.6 * s) });
}
new ResizeObserver(() => { edScale(); edRenderTimeline(); }).observe($('ed-monitor'));

/** Everything that follows the playhead: time, live FPS, the graphs' playheads, the frame-time window, HITCH tags. */
function edTick() {
  if (!ed.board) return;
  const t = ed.t, r = edRange(), len = Math.max(0.001, r.out - r.in);
  $('ed-now').textContent = fmtStamp(t);
  const ph = $('ed-ph');
  if (ph) {
    ph.style.left = px(t * ed.pps);
    const sc = $('ed-scroll'), x = t * ed.pps;
    if (ed.playing && (x > sc.scrollLeft + sc.clientWidth - 20 || x < sc.scrollLeft)) sc.scrollLeft = x - 40;
    edRulerFade();
  }
  if (ed.selOut) ed.selOut.hidden = !ed.sel || ed.cur[ed.sel.ti] !== edSelClip();
  const x = clamp(((t - r.in) / len) * 1000, 0, 1000);
  ed.pv.forEach((pv, ti) => {
    const live = edLive(ti, edShowT(t)), target = edTarget(ti) || 60;
    // A still, load or gap the export names (0.5 s or more): no live number, its name and length in the stats box.
    const hold = live.held && live.len >= 0.5 - 1e-6 ? live : null;
    pv.none.hidden = !live.gap;
    pv.unit.hidden = Boolean(hold);
    const key = hold ? `${hold.held}|${hold.len.toFixed(1)}` : '';
    if (pv.holdKey !== key) {
      pv.holdKey = key;
      pv.shold.replaceChildren(...(hold ? [node('b', '', hold.held), ` · ${hold.len.toFixed(1)} s · not counted`] : []));
      pv.sline.hidden = Boolean(hold);
      pv.shold.hidden = !hold;
      pv.stats.hidden = !hold && !pv.hasSum;
    }
    if (hold) { pv.num.className = ''; pv.num.textContent = ''; }
    else if (live.fps != null) {
      const lv = level(Math.round(live.fps), target);
      pv.num.className = lv === 'ok' ? '' : `pv-${lv}`; // not .warn: that is the app's warning banner
      pv.num.textContent = String(Math.round(live.fps));
    } else { pv.num.className = ''; pv.num.textContent = '–'; }
    pv.clipRect.setAttribute('width', x);
    pv.phLine.setAttribute('x1', x);
    pv.phLine.setAttribute('x2', x);
    // The last 10 s, inside the graph (the gutter labels are right of it): each second's worst frame as a step across
    // its second, so one between two stills still shows; a null breaks the line between clips.
    const s = ed.series[ti] || { ft: [], hitches: [] }, fx = (at) => clamp(((at - t + 10) / 10) * 1000, 0, 1000).toFixed(1);
    let d = '', pen = 'M';
    for (const [at, ms] of s.ft) {
      if (ms === null) { pen = 'M'; continue; }
      if (at + 0.5 < t - 10 || at - 0.5 > t) continue;
      const y = pv.ftY(ms).toFixed(1);
      d += `${pen}${fx(at - 0.5)},${y}L${fx(at + 0.5)},${y}`;
      pen = 'L';
    }
    pv.ftLine.setAttribute('d', d);
    let bands = '';
    for (const [a, b] of [...(s.paused || []), ...(s.gaps || [])]) {
      if (a > t || b < t - 10) continue;
      bands += `M${fx(a)},0H${fx(Math.min(b, t))}V100H${fx(a)}Z`;
    }
    pv.ftBands.setAttribute('d', bands);
    const h = live.gap ? null : s.hitches.find(([at]) => t >= at && t < at + 1);
    pv.hitch.hidden = !h;
    if (h) pv.hitch.textContent = `HITCH · ${Math.round(h[1])} ms`;
  });
}

// ---- playback: the sound track's video leads, the others follow; in gaps a plain clock leads ----

/** Timeline time from track ti's video. */
const edTimeOf = (ti) => ed.cur[ti].at + ed.videos[ti].currentTime - ed.cur[ti].in;
/** The track whose video sets the clock: the sound track first. One that has just switched clips leads again only
 * once it has caught up with the clock, so its seek does not pull the others back. */
function edLeader(tClock) {
  const order = [ed.p.sound, ...ed.p.tracks.keys()];
  // Within two frames of the clock, and moving: as the clock follows the leader, a stalled one would stop it. Chromium's
  // clock also runs slow over the last moments of a file, so a video that near its end does not lead.
  const now = performance.now();
  const ok = (ti) => {
    const v = ed.videos[ti], c = ed.cur[ti];
    return ti != null && c && v && !v.paused && !v.seeking && v._cueT == null && v.readyState >= 3 && now - v._ctAt < 50 && !(v.duration - v.currentTime < 0.25) &&
      v.getAttribute('src') === fileUrl(c.video) && Math.abs(edTimeOf(ti) - tClock) < 0.035;
  };
  const ti = order.find(ok);
  return ti === undefined ? null : ti;
}
/** v was sent to source time `at` while playing: it is left alone, and does not lead, till it moves on from there. */
function edCued(v, at) {
  v._cueT = at;
  v._cueAt = performance.now();
}
function edPlayIcon() {
  $('ed-play').setAttribute('aria-label', ed.playing ? 'Pause (Space)' : 'Play (Space)');
  $('ed-play').querySelector('path').setAttribute('d', ed.playing ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M7 5l12 7-12 7z');
}
async function edPlay() {
  const r = edRange();
  if (!ed.board || !(r.out - r.in > 0.05)) return;
  if (ed.t >= r.out - 0.05 || ed.t < r.in) ed.t = r.in;
  ed.playing = true;
  const go = ++ed.playSeq;
  ed.clock = performance.now() - ed.t * 1000; // a step before the videos settle must not run from an old clock
  ed.exactSeq++;
  $('ed-exact-img').hidden = $('ed-exact-badge').hidden = true;
  edPlayIcon();
  const vids = ed.p.tracks.map((_, ti) => edPlace(ti, ed.t, true)).filter(Boolean);
  await Promise.all(vids.map(settled)); // all start together, as in A / B
  if (!ed.playing || go !== ed.playSeq) return;
  ed.clock = performance.now() - ed.t * 1000;
  for (const v of edAllVideos()) {
    // rAF stops while the window is covered; timeupdate (~4 a second) keeps the clock and the followers going.
    v.ontimeupdate = () => { if (ed.playing && performance.now() - ed.lastStep > 250) edStep(); };
  }
  for (const v of vids) { v.play().catch(() => {}); edCued(v, v.currentTime); }
  // The clock waits for the first video to move: a decoder can take a few hundred ms to start after a seek.
  [ed.startT, ed.startAt] = [ed.t, performance.now()];
  requestAnimationFrame(() => edFrame(go));
}
/** One animation frame of play `go`: a loop left from a play paused and started again within a frame stops here. */
function edFrame(go) {
  if (!ed.playing || go !== ed.playSeq) return;
  edStep();
  requestAnimationFrame(() => edFrame(go));
}
function edPause() {
  const was = ed.playing;
  ed.playing = false;
  ed.playSeq++;
  ed.startT = null;
  for (const v of edAllVideos()) { v.pause(); v.playbackRate = 1; v.ontimeupdate = null; v._calib = v._pre = v._cueT = null; }
  if (was) { edPlayIcon(); edScheduleExact(); edThumbSoon(); }
}
/** One step of the shared clock: follow the leader, switch clips at their edges, pull the others in, redraw. */
function edStep() {
  const now = performance.now(), dt = Math.min(0.5, (now - (ed.lastStep || now)) / 1000);
  ed.lastStep = now;
  let tClock = (now - ed.clock) / 1000;
  // A main-thread stall: the videos played on while this did not run, so what drifted is not theirs to correct by a
  // seek, and where a cue landed says nothing about what seeks take. Measured again next step.
  const stalled = dt > 0.1;
  for (const v of edAllVideos()) if (v.currentTime !== v._ct) [v._ct, v._ctAt] = [v.currentTime, now]; // when each last moved
  // A cued video that has moved on (or given up after 2 s) is in play again; where it landed tunes the next lead.
  ed.cur.forEach((c, ti) => {
    const v = ed.videos[ti];
    if (!c || !v || v._cueT == null || v.seeking || (v.currentTime <= v._cueT + 0.001 && now - v._cueAt < 2000)) return;
    if (v._calib && !stalled) v._lead[v._calib] = clamp(v._lead[v._calib] - (v.currentTime - (c.in + tClock - c.at)), 0.02, 1.5);
    v._cueT = v._calib = null;
  });
  if (ed.startT != null) {
    const vs = ed.cur.map((c, ti) => c && ed.videos[ti]).filter(Boolean);
    if (vs.length && vs.every((v) => v._cueT != null) && now - ed.startAt < 2000) tClock = ed.startT;
    else ed.startT = null;
  }
  // The clock waits for a leader that is behind (starting, slowed), but runs ahead to one that is ahead by at most 12 %
  // of the step: a jolt forward in its clock is spread over a few frames instead of passed to every follower at once.
  const lead = edLeader(tClock), end = edRange().out;
  const t = lead !== null ? tClock + Math.min(edTimeOf(lead) - tClock, 0.12 * dt) : tClock;
  ed.t = t;
  ed.clock = performance.now() - t * 1000;
  if (t >= end) { edPause(); edSeek(end); return; }
  ed.p.tracks.forEach((_, ti) => {
    const v = edPlace(ti, t, false, true); // past its clip's out, the leader too switches here
    // A recording can end a moment before its clip does: hold its last frame (play() would start it over).
    if (!v || v.ended) return;
    // The leader plays at normal speed: a rate left from following would run the whole clock fast.
    if (ti === lead) { if (v.playbackRate !== 1) v.playbackRate = 1; return; }
    const c = ed.cur[ti], want = c.in + t - c.at;
    if (v._cueT == null && !v.seeking && v.readyState >= 3 && v.getAttribute('src') === fileUrl(c.video)) {
      const drift = v.currentTime - want;
      // Far behind (a clip switch): seek to where the clock will be. Well ahead: hold the frame till the clock comes.
      // Small drift, a seek's overshoot too, is pulled in by speed, in 5 % steps (each change of rate costs the decoder a little).
      if (drift < -0.1 || drift > 0.5) { if (!stalled) { edCue(v, c.video, want, true); v.playbackRate = 1; } }
      else if (drift > 0.15 || (v._hold && drift > 0.02)) { v._hold = true; if (!v.paused) v.pause(); return; }
      else {
        v._hold = false;
        const rate = Math.abs(drift) < 0.006 ? 1 : 1 - clamp(Math.round(drift * 100) / 20, -0.25, 0.25);
        if (v.playbackRate !== rate) v.playbackRate = rate;
      }
    }
    if (v.paused) v.play().catch(() => {});
  });
  edTick();
}
function edSeek(t) {
  ed.t = clamp(t, 0, edLength());
  ed.clock = performance.now() - ed.t * 1000;
  ed.p.tracks.forEach((_, ti) => edPlace(ti, ed.t, true));
  edTick();
  if (!ed.playing) { edScheduleExact(); edThumbSoon(); }
}
function edStepFrame(dir) {
  edPause();
  edSeek(ed.t + dir * edFrameStep());
}

/** The exact export frame from ffmpeg, ~400 ms after the playhead settles; a newer request replaces an older one. */
let edExactTimer = 0;
function edScheduleExact() {
  clearTimeout(edExactTimer);
  ed.exactSeq++;
  $('ed-exact-img').hidden = $('ed-exact-badge').hidden = true;
  if (!ed.exact || ed.playing || !ed.data) return;
  const r = edRange();
  if (ed.t < r.in - 1e-6 || ed.t > r.out + 1e-6) { $('ed-exact-badge').hidden = false; $('ed-exact-badge').textContent = 'Outside the export range'; return; }
  const seq = ed.exactSeq;
  edExactTimer = setTimeout(async () => {
    $('ed-exact-badge').hidden = false;
    $('ed-exact-badge').textContent = 'Exact…';
    const r = await window.api.timelineFrame(edProject(), ed.t);
    if (seq !== ed.exactSeq || !ed.exact || ed.playing) return;
    if (r.ok) {
      $('ed-exact-img').src = r.url;
      $('ed-exact-img').hidden = false;
      $('ed-exact-badge').textContent = 'Exact';
    } else {
      $('ed-exact-badge').hidden = true;
      if (!r.cancelled) edStatus(`The exact frame failed. ${r.error}`);
    }
  }, 400);
}

// ---- the numbers and the layout from the core ----

let edFetchTimer = 0;
function edFetchSoon() { clearTimeout(edFetchTimer); edFetchTimer = setTimeout(edFetch, 120); }
async function edFetch() {
  const seq = ++ed.dataSeq, snap = edSnap();
  let r = { ok: false, error: '' };
  if (ed.p.tracks.some((tr) => tr.clips.length)) r = await window.api.projectData(edProject());
  if (seq !== ed.dataSeq) return;
  ed.data = r.ok ? r.result : null;
  ed.dataSnap = snap;
  ed.boxes = (r.ok ? r.result.layoutBoxes : r.layoutBoxes) || null;
  ed.error = r.ok ? '' : r.error;
  if (!state.running && !$('edit-mode').hidden) edStatus([ed.notice, ed.error].filter(Boolean).join(' '));
  $('ed-export').disabled = !ed.data;
  edBuildMonitor();
  if (ed.tab === 'tracks' && !$('ed-body-tracks').contains(document.activeElement)) edRenderTracks();
  edScheduleExact();
}

// ---- the page ----

function edRender() {
  edSyncLayout();
  edRenderTimeline();
  edRenderInspector();
  edBuildMonitor();
  const r = edRange(), len = Math.max(0, r.out - r.in);
  $('ed-total').textContent = `/ ${fmtStamp(len)} export`;
  const rg = $('ed-range');
  rg.replaceChildren('Export range ', node('b', '', `${fmtStamp(r.in)} – ${fmtStamp(r.out)}`), ` · ${fmtDuration(len)}`);
  $('ed-add-c').hidden = ed.p.tracks.length > 2;
  $('ed-export').disabled = !ed.data;
}

async function edOpen() {
  if (!ed.restored) await edRestore();
  ed.series = ed.p.tracks.map((_, ti) => edTrackSeries(ti));
  if (!ed.p.tracks.some((tr) => tr.clips.length)) ed.tab = 'media';
  edRender();
  edFetchSoon();
}

/** The Layout menu: frame, the fits the track count allows, the sizes of the frame. */
function edSyncLayout() {
  const p = ed.p, three = p.tracks.length === 3;
  // Nothing on any track: no transport, no graphs over NO VIDEO, nothing to scroll.
  const empty = !p.tracks.some((tr) => tr.clips.length);
  $('edit-mode').classList.toggle('ed-empty', empty);
  for (const id of ['ed-start', 'ed-back', 'ed-play', 'ed-fwd', 'ed-end', 'ed-mark-in', 'ed-mark-out']) $(id).disabled = empty;
  $(`edx-frame-${p.frame === '21:9' ? '219' : '169'}`).checked = true;
  $('edx-frame-169').disabled = three;
  const fits = three ? ['third'] : ['letterbox', 'crop', 'below'];
  const fid = document.activeElement.id; // rebuilding the radios drops keyboard focus to the page
  $('edx-fits').replaceChildren(...fits.flatMap((f) => {
    const i = node('input', 'vis');
    Object.assign(i, { type: 'radio', name: 'edx-fit', id: `edx-fit-${f}`, value: f, checked: p.fit === f, disabled: f === 'below' && p.frame !== '21:9' });
    i.addEventListener('change', () => edCommit(() => { ed.p.fit = f; }));
    const l = node('label', '', ED_FITS[f]);
    l.htmlFor = i.id;
    return [i, l];
  }));
  const sizes = ABX_SIZES[p.frame];
  $('edx-sizes').replaceChildren(...sizes.flatMap(([v, label]) => {
    const i = node('input', 'vis');
    Object.assign(i, { type: 'radio', name: 'edx-size', id: `edx-size-${v}`, value: v, checked: p.size === v });
    i.addEventListener('change', () => edCommit(() => { ed.p.size = v; }));
    const l = node('label', '', label);
    l.htmlFor = i.id;
    return [i, l];
  }));
  if (fid && document.activeElement === document.body && $(fid)) $(fid).focus();
  const [, , W, H] = sizes.find(([v]) => v === p.size) || sizes[0];
  const b = edBoard(), pv = b.panes[0].video, k = H / 720, e2 = (v) => Math.round((v * k) / 2) * 2;
  const gpu = radioValue('opt-enc') === 'gpu', hevc = gpu && W > 4096;
  $('edx-sum').textContent = `${W}×${H} · each video ${e2(pv.w)}×${e2(pv.h)} · ${hevc ? 'HEVC' : 'H.264'} on ${gpu ? 'GPU' : 'CPU'}`;
  $('edx-hevc').hidden = !hevc;
  const desc = p.fit === 'letterbox' ? 'each video whole, the data in bands' : p.fit === 'below' ? 'each video whole, the data below'
    : `each video the centre ${p.frame === '21:9' ? '2/3' : 'half'}`;
  $('edx-fit-hint').textContent = three ? 'Three tracks export as 21:9 with three videos side by side, each its centre 2/3.'
    : p.fit === 'crop' ? 'Crop fills each pane; pan and zoom each clip in the Clip tab. Data below is 21:9 only.'
      : 'Each video keeps its whole picture; pan and zoom do not apply. Data below is 21:9 only.';
  $('ed-layout-sum').textContent = `${p.frame} · ${three ? '3 videos' : ED_FITS[p.fit].toLowerCase()} · ${W}×${H}`;
  $('ed-desc').textContent = `${p.frame} · ${W}×${H} · ${desc}`;
}
for (const r of document.querySelectorAll('input[name="edx-frame"]')) {
  r.addEventListener('change', () => edCommit(() => {
    ed.p.frame = r.value;
    if (r.value !== '21:9' && ed.p.fit === 'below') ed.p.fit = 'letterbox';
    if (!ABX_SIZES[r.value].some(([v]) => v === ed.p.size)) ed.p.size = '1080';
  }));
}

// ---- timeline ----

function edPpsFit() { return Math.max(0.5, ($('ed-scroll').clientWidth || 600) / edLength()); }

function edRenderTimeline() {
  if ($('edit-mode').hidden) return;
  const inner = $('ed-inner'), len = edLength(), r = edRange();
  // While dragging the scale stays put: re-fitting as a clip moves past the end would run it away from the pointer.
  const pps = ed.pps = ed.dragPps || edPpsFit() * 2 ** (ed.zoom / 12.5);
  inner.style.width = px(Math.floor(len * pps));
  inner.classList.toggle('ed-split', radioValue('ed-tool') === 'split');
  $('ed-heads').replaceChildren(node('div', 'ed-tracks-l', 'Tracks'), node('div'), ...ed.p.tracks.map((_, ti) => edTrackHead(ti)));
  const ruler = node('div', 'ed-ruler');
  const work = node('div', 'ed-work'), bar = node('span');
  Object.assign(bar.style, { left: px(r.in * pps), width: px(Math.max(2, (r.out - r.in) * pps)) });
  bar.title = 'Export range: drag its ends, or press I and O';
  work.appendChild(bar);
  const lanes = ed.p.tracks.map((tr, ti) => {
    const lane = node('div', 'ed-lane');
    lane.dataset.ti = ti;
    lane.style.setProperty('--tk', TK[ti]);
    // Gaps inside the export range: NO VIDEO in the export, not counted.
    let from = r.in;
    for (const c of [...tr.clips, { at: r.out, in: 0, out: 0 }]) {
      const a = Math.max(from, r.in), b2 = Math.min(c.at, r.out);
      if (b2 - a > 0.05) {
        const gap = node('div', 'ed-gap');
        Object.assign(gap.style, { left: px(a * pps), width: px((b2 - a) * pps) });
        if ((b2 - a) * pps >= 40) gap.appendChild(node('span', '', 'gap')); // narrower, the hatching alone says it
        lane.appendChild(gap);
      }
      from = Math.max(from, clipEnd(c));
    }
    tr.clips.forEach((c, ci) => lane.appendChild(edClipBlock(ti, ci, c, pps)));
    return lane;
  });
  const ph = node('div', 'ed-ph');
  ph.id = 'ed-ph';
  ph.style.left = px(ed.t * pps);
  const refocus = inner.contains(document.activeElement) && document.activeElement.classList.contains('ed-clipb');
  inner.replaceChildren(ruler, work, ...lanes, ph);
  // The rebuilt blocks are new elements: keyboard focus moves to the selected one rather than dropping to the page.
  const selB = refocus && ed.sel && inner.querySelector(`.ed-clipb[data-ti="${ed.sel.ti}"][data-ci="${ed.sel.ci}"]`);
  if (selB) selB.focus({ preventScroll: true });
  edRuler();
}

/** Ruler labels at round steps at least 80 px apart (down to 0.01 s, as m:ss.cc), minor ticks between them; drawn
 * for the part in view and a screen either side, as zoomed in the timeline is hundreds of thousands of px wide. */
const RULER_STEPS = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
function edRuler() {
  const ruler = document.querySelector('#ed-inner .ed-ruler'), sc = $('ed-scroll'), pps = ed.pps, len = edLength();
  if (!ruler) return;
  const step = RULER_STEPS.find((v) => v * pps >= 80) || 2400, lead = Math.round((step / 10 ** Math.floor(Math.log10(step) + 1e-9)) * 10) / 10;
  const minor = step / (lead === 5 || lead === 2.5 ? 5 : lead === 1 || lead === 2 ? 2 : 3), fmt = step < 1 ? fmtStamp : fmtDuration;
  const x0 = Math.max(0, sc.scrollLeft - sc.clientWidth), x1 = Math.min(len * pps, sc.scrollLeft + 2 * sc.clientWidth);
  const kids = [];
  for (let i = Math.ceil(x0 / pps / minor); i * minor * pps <= x1 + 1e-6; i++) {
    const q = (i * minor) / step, tick = node('i', Math.abs(q - Math.round(q)) < 1e-6 ? '' : 'minor');
    tick.style.left = px(i * minor * pps);
    kids.push(tick);
  }
  ed.rulerLabels = [];
  for (let i = Math.ceil(x0 / pps / step); i * step * pps <= Math.min(x1, len * pps - 24); i++) {
    const lab = node('span', i ? '' : 'first', fmt(i * step));
    lab.style.left = px(i * step * pps);
    kids.push(lab);
    ed.rulerLabels.push([i * step * pps, lab]);
  }
  ruler.replaceChildren(...kids);
  ed.rulerSpan = [x0, x1];
  edRulerFade();
}
/** A label the playhead's knob would cover steps aside for it. */
function edRulerFade() {
  const x = ed.t * ed.pps;
  for (const [lx, lab] of ed.rulerLabels || []) {
    const w = lab.textContent.length * 6.7, a = lab.classList.contains('first') ? lx : lx - w / 2;
    lab.classList.toggle('near', x > a - 9 && x < a + w + 9);
  }
}
$('ed-scroll').addEventListener('scroll', () => {
  const sc = $('ed-scroll'), [x0, x1] = ed.rulerSpan || [0, 0];
  if ((sc.scrollLeft < x0 && x0 > 0) || sc.scrollLeft + sc.clientWidth > x1) edRuler();
}, { passive: true });

function edClipBlock(ti, ci, c, pps) {
  const sel = ed.sel && ed.sel.ti === ti && ed.sel.ci === ci, m = edMedia(c), len = clipLen(c);
  const b = node('div', `ed-clipb${sel ? ' sel' : ''}`);
  Object.assign(b.style, { left: px(c.at * pps), width: px(Math.max(6, len * pps)) });
  Object.assign(b.dataset, { ti, ci });
  const name = m ? m.name : fileName(c.video);
  b.title = `${edClipId(ti, ci)} · ${name}`;
  b.tabIndex = 0;
  b.setAttribute('role', 'button');
  b.setAttribute('aria-label', `Clip ${edClipId(ti, ci)}, ${name}, ${fmtStamp(len, 1)} long`);
  const nm = node('div', 'nm');
  nm.append(node('b', '', edClipId(ti, ci)), node('span', 'fn', name), node('span', 'ed-dur', fmtStamp(len, 1)));
  b.appendChild(nm);
  if (m) {
    // Play FPS against the target: on target sits near the top, a dip drops toward the bottom.
    const st = m.data.summary.capture.start_s || 0, target = m.data.summary.target_fps;
    const pts = m.data.playFps.filter(([sec, v]) => v !== null && sec + st + 0.5 >= c.in && sec + st + 0.5 < c.out)
      .map(([sec, v]) => `${(((sec + st + 0.5 - c.in) / len) * 100).toFixed(2)},${(18 - Math.min(1.1, v / target) * 13).toFixed(1)}`);
    const svg = el('svg', { viewBox: '0 0 100 20', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    // Points sit mid-second: the first and last are carried out to the clip's edges, so the line spans the block.
    if (pts.length) svg.appendChild(el('polyline', { points: `0,${pts[0].split(',')[1]} ${pts.join(' ')} 100,${pts[pts.length - 1].split(',')[1]}`, fill: 'none', stroke: TK[ti], 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' }));
    b.appendChild(svg);
    for (const [a, ms] of m.data.hitches) {
      const src = a + st;
      if (src < c.in || src >= c.out) continue;
      const tick = node('span', 'tick');
      tick.style.left = `${((src - c.in) / len) * 100}%`;
      tick.title = `Hitch ${ms.toFixed(1)} ms`;
      b.appendChild(tick);
    }
  }
  for (const side of ['l', 'r']) {
    const h = node('span', 'ed-handle');
    h.dataset.edge = side;
    h.style[side === 'l' ? 'left' : 'right'] = 0;
    h.title = side === 'l' ? 'Drag to trim the start (In)' : 'Drag to trim the end (Out)';
    b.appendChild(h);
  }
  return b;
}

const SPEAKER_ON = 'M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12';
const SPEAKER_OFF = 'M4 9h4l5-4v14l-5-4H4zM17 9l5 6M22 9l-5 6';
function edTrackHead(ti) {
  const tr = ed.p.tracks[ti], h = node('div', 'ed-th');
  h.style.setProperty('--tk', TK[ti]);
  const names = node('div', 'ed-th-names'), n = tr.clips.length, target = edTarget(ti);
  names.append(node('b', '', edTrackTitle(ti)), node('span', '', `${n} clip${n === 1 ? '' : 's'}${target ? ` · ${target} fps` : ''}`));
  const on = ed.p.sound === ti, snd = node('button', 'ed-icon');
  snd.type = 'button';
  snd.setAttribute('aria-pressed', String(on));
  snd.setAttribute('aria-label', on ? 'Sound from this track (on)' : 'Use this track for sound');
  snd.title = on ? 'Sound comes from this track' : 'Use this track for sound';
  const ico = el('svg', { class: 'ico ico-s', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  ico.appendChild(el('path', { d: on ? SPEAKER_ON : SPEAKER_OFF }));
  snd.appendChild(ico);
  snd.addEventListener('click', () => edCommit(() => { ed.p.sound = on ? null : ti; }));
  // The track's menu opens from its tag, so the head keeps its room for the name and "2 clips · 30 fps".
  // It opens to the right and upward: the last track's head sits at the window's foot.
  const menu = node('details', 'menu menu-up ed-th-menu'), sum = node('summary', 'ed-tag mono', LETTERS[ti]);
  sum.setAttribute('aria-label', `Track ${LETTERS[ti]} menu`);
  sum.title = 'Track menu';
  const list = node('div', 'menu-list'), rm = node('button', '', 'Remove track');
  rm.type = 'button';
  rm.disabled = ed.p.tracks.length < 3;
  rm.title = rm.disabled ? 'A project keeps at least two tracks' : `Remove track ${LETTERS[ti]} and its clips`;
  rm.addEventListener('click', () => { menu.open = false; edRemoveTrack(ti); });
  list.appendChild(rm);
  menu.append(sum, list);
  h.append(menu, names, snd);
  return h;
}

/** Unload and drop track ti's videos (decoder, file handle on the recording). */
function edDropVideos(ti) {
  for (const vs of [ed.videos, ed.spare]) {
    const [v] = vs.splice(ti, 1);
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); }
  }
}
function edRemoveTrack(ti) {
  if (ed.p.tracks.length < 3) return;
  edCommit(() => {
    ed.p.tracks.splice(ti, 1);
    edDropVideos(ti); // the tracks after it keep theirs
    if (ed.p.sound === ti) ed.p.sound = 0;
    else if (ed.p.sound > ti) ed.p.sound--;
    ed.p.fit = 'crop';
    ed.sel = null;
  });
}
$('ed-add-c').addEventListener('click', () => edCommit(() => {
  if (ed.p.tracks.length > 2) return;
  ed.p.tracks.push(edNewTrack());
  Object.assign(ed.p, { frame: '21:9', fit: 'third' });
  if (!ABX_SIZES['21:9'].some(([v]) => v === ed.p.size)) ed.p.size = '1080';
}));

/** Snap t to the playhead, clip edges, hitches and range ends within 8 px; skip is the clip being dragged. */
function edSnapPoints(skip) {
  const r = edRange(), pts = [ed.t, r.in, r.out];
  ed.p.tracks.forEach((tr, ti) => {
    for (const c of tr.clips) if (c !== skip) pts.push(c.at, clipEnd(c));
    // Not the dragged clip's own hitches: they move with it (call this before the clip moves).
    const own = tr.clips.includes(skip) ? [skip.at, clipEnd(skip)] : null;
    for (const [at] of (ed.series[ti] || { hitches: [] }).hitches) if (!own || at < own[0] || at >= own[1]) pts.push(at);
  });
  return pts;
}
/** The shift that snaps the nearest of edges to a point, or 0. */
function edSnapShift(edges, pts) {
  if (!ed.snap) return 0;
  let best = 0, dist = 8 / ed.pps;
  for (const e of edges) for (const p of pts) if (Math.abs(p - e) < dist) { dist = Math.abs(p - e); best = p - e; }
  return best;
}

const edTimeAt = (clientX) => (clientX - $('ed-inner').getBoundingClientRect().left) / ed.pps;

/** A drag on the timeline: fn(dt, e) on each move; one undo step when it changed something. */
/** redraw false: the drag only moves the playhead (the ruler), so the timeline is not rebuilt on each move. */
function edDrag(e, fn, redraw = true) {
  const x0 = e.clientX, before = edSnap(), sel = ed.sel;
  edPause();
  ed.dragPps = ed.pps;
  const move = (ev) => { fn((ev.clientX - x0) / ed.pps, ev); if (redraw) { edNormalise(); edRenderTimeline(); } edSeek(ed.t); };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    ed.dragPps = 0; // fits again
    if (before !== edSnap()) edPush(before, sel);
    else edRenderTimeline();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function edSplit(ti, ci, t) {
  const c = ed.p.tracks[ti] && ed.p.tracks[ti].clips[ci];
  if (!c) return;
  const min = 1 / edHz(c);
  if (t - c.at < min || clipEnd(c) - t < min) { edStatus('Move the playhead inside the clip to split it there.'); return; }
  edCommit(() => {
    const cut = ms3(c.in + t - c.at), right = { ...c, in: cut, at: ms3(t) };
    c.out = cut;
    ed.p.tracks[ti].clips.push(right);
    ed.sel = { ti, ci: ed.p.tracks[ti].clips.length - 1 };
  });
}

function edSelect(ti, ci) {
  if (ed.sel && ed.sel.ti === ti && ed.sel.ci === ci && ed.tab !== 'media') return;
  ed.sel = { ti, ci };
  if (ed.tab === 'media') ed.tab = 'clip';
  edRenderTimeline();
  edRenderInspector();
  edBuildMonitor();
}
// Tabbing onto a clip selects it, as clicking does.
$('ed-inner').addEventListener('focusin', (e) => {
  if (e.target.classList.contains('ed-clipb')) edSelect(Number(e.target.dataset.ti), Number(e.target.dataset.ci));
});

$('ed-inner').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault(); // no text selection while dragging; so focus would stay on a slider or radio: move it off
  let target = e.target;
  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur();
    // Blurring an edited field commits it, which redraws the timeline: find what is under the pointer now.
    if (!target.isConnected) target = document.elementFromPoint(e.clientX, e.clientY) || document.body;
  }
  if (target.closest('.ed-ruler')) {
    edPause();
    edSeek(edTimeAt(e.clientX));
    edDrag(e, (_dt, ev) => { ed.t = clamp(edTimeAt(ev.clientX), 0, edLength()); }, false);
    return;
  }
  const bar = target.closest('.ed-work span');
  if (bar) {
    const r0 = { ...edRange() }, rect = bar.getBoundingClientRect(), dl = Math.abs(e.clientX - rect.left), dr = Math.abs(rect.right - e.clientX);
    // A bar under 20 px is all ends: the nearer one (zoom in to move the whole range).
    const end = rect.width < 20 ? (dl <= dr ? 'in' : 'out') : dl < 10 ? 'in' : dr < 10 ? 'out' : 'both';
    edDrag(e, (dt) => {
      const r = { ...r0 }, pts = edSnapPoints(null).filter((p) => p !== r0.in && p !== r0.out);
      if (end !== 'out') r.in = r0.in + dt;
      if (end !== 'in') r.out = r0.out + dt;
      const s = edSnapShift(end === 'in' ? [r.in] : end === 'out' ? [r.out] : [r.in, r.out], pts);
      if (end !== 'out') r.in += s;
      if (end !== 'in') r.out += s;
      if (end === 'both') { const sh = Math.max(0, -r.in); r.in += sh; r.out += sh; }
      r.in = ms3(clamp(r.in, 0, r.out - 0.1));
      r.out = ms3(Math.max(r.out, r.in + 0.1));
      ed.p.range = r;
    });
    return;
  }
  const blk = target.closest('.ed-clipb');
  if (!blk) {
    if (ed.sel) { ed.sel = null; edRenderTimeline(); edRenderInspector(); edBuildMonitor(); }
    return;
  }
  const ti = Number(blk.dataset.ti), ci = Number(blk.dataset.ci), tr = ed.p.tracks[ti], c = tr.clips[ci];
  if (radioValue('ed-tool') === 'split') { edSplit(ti, ci, edTimeAt(e.clientX)); return; }
  // Which part was grabbed, before selecting redraws the block.
  const br = blk.getBoundingClientRect();
  const edge = target.dataset.edge || (e.clientX - br.left < 6 ? 'l' : br.right - e.clientX < 6 ? 'r' : null);
  edSelect(ti, ci);
  const c0 = { ...c }, prev = tr.clips[ci - 1], next = tr.clips[ci + 1], min = 1 / edHz(c);
  const lo = prev ? clipEnd(prev) : 0, hi = next ? next.at : Infinity, [smin, smax] = edMedia(c) ? edSrcSpan(c) : [c.in, c.out];
  const pts = edSnapPoints(c);
  edDrag(e, (dt) => {
    if (edge === 'l') {
      // The left edge moves In and the start together, so the rest of the clip stays where it is.
      let d = dt + edSnapShift([c0.at + dt], pts);
      d = clamp(d, Math.max(smin - c0.in, lo - c0.at), c0.out - min - c0.in);
      Object.assign(c, { in: ms3(c0.in + d), at: ms3(c0.at + d) });
    } else if (edge === 'r') {
      let d = dt + edSnapShift([clipEnd(c0) + dt], pts);
      d = clamp(d, c0.in + min - c0.out, Math.min(smax - c0.out, hi - clipEnd(c0)));
      c.out = ms3(c0.out + d);
    } else {
      let at = c0.at + dt;
      at += edSnapShift([at, at + clipLen(c0)], pts);
      c.at = ms3(clamp(at, lo, hi - clipLen(c0)));
    }
  });
});

// Recordings dragged from Media onto a lane.
$('ed-inner').addEventListener('dragover', (e) => {
  const lane = e.target.closest('.ed-lane');
  if (!lane || !e.dataTransfer.types.includes('text/x-cfps-media')) return;
  e.preventDefault();
  for (const l of document.querySelectorAll('.ed-lane.drop')) if (l !== lane) l.classList.remove('drop');
  lane.classList.add('drop');
});
$('ed-inner').addEventListener('dragleave', (e) => { const lane = e.target.closest('.ed-lane'); if (lane && !lane.contains(e.relatedTarget)) lane.classList.remove('drop'); });
$('ed-inner').addEventListener('drop', (e) => {
  const lane = e.target.closest('.ed-lane'), path = e.dataTransfer.getData('text/x-cfps-media');
  for (const l of document.querySelectorAll('.ed-lane.drop')) l.classList.remove('drop');
  if (!lane || !path) return;
  e.preventDefault();
  const cand = abCandidates().find((c) => c.path === path);
  if (cand) edAdd(cand, Number(lane.dataset.ti), edTimeAt(e.clientX));
});

$('ed-zoom').addEventListener('input', () => {
  // About the playhead while it is in view, else about the middle.
  const sc = $('ed-scroll'), ph = ed.t * ed.pps - sc.scrollLeft;
  const [at, off] = ph >= 0 && ph <= sc.clientWidth ? [ed.t, ph] : [(sc.scrollLeft + sc.clientWidth / 2) / ed.pps, sc.clientWidth / 2];
  ed.zoom = Number($('ed-zoom').value);
  edRenderTimeline();
  sc.scrollLeft = at * ed.pps - off;
  edRuler();
});
$('ed-fit').addEventListener('click', () => { ed.zoom = 0; $('ed-zoom').value = 0; edRenderTimeline(); });
$('ed-snap').addEventListener('click', () => { ed.snap = !ed.snap; $('ed-snap').setAttribute('aria-pressed', String(ed.snap)); });
for (const r of document.querySelectorAll('input[name="ed-tool"]')) r.addEventListener('change', edRenderTimeline);

// ---- inspector ----

function edRenderInspector() {
  for (const k of ['clip', 'tracks', 'media']) {
    $(`ed-tab-${k}`).setAttribute('aria-selected', String(ed.tab === k));
    $(`ed-body-${k}`).hidden = ed.tab !== k;
  }
  if (ed.tab === 'clip') edRenderClip();
  else if (ed.tab === 'tracks') { if (!edTracksEditing && !$('ed-body-tracks').contains(document.activeElement)) edRenderTracks(); }
  else edRenderMedia();
}
// Rebuilding the Tracks fields while focus moves between them drops the focus: rebuild once it has left the tab.
// A field's change runs before Tab moves focus (activeElement is body then), so its own edPush must not rebuild.
let edTracksEditing = false;
$('ed-body-tracks').addEventListener('focusout', (e) => {
  if (ed.tab === 'tracks' && !$('ed-body-tracks').contains(e.relatedTarget)) setTimeout(() => { if (ed.tab === 'tracks' && !$('ed-body-tracks').contains(document.activeElement)) edRenderTracks(); });
});
for (const k of ['clip', 'tracks', 'media']) $(`ed-tab-${k}`).addEventListener('click', () => { ed.tab = k; edRenderInspector(); });

function edRenderClip() {
  const c = edSelClip(), m = c && edMedia(c);
  $('ed-clip-none').hidden = Boolean(m);
  $('ed-clip').hidden = !m;
  if (!m) return;
  const { ti, ci } = ed.sel, s = m.data.summary, cap = s.capture;
  $('ed-body-clip').style.setProperty('--tk', TK[ti]);
  $('ed-clip-tag').textContent = LETTERS[ti];
  $('ed-clip-name').textContent = `${edClipId(ti, ci)} · ${m.name}`;
  $('ed-clip-name').title = c.video;
  $('ed-clip-meta').textContent = `${cap.height}p${Math.round(cap.refresh_hz)} · ${s.target_fps} fps target · ${fmtDuration(cap.seconds)} recorded`;
  for (const [f, v] of [['at', c.at], ['in', c.in], ['out', c.out]]) {
    if (document.activeElement !== $(`ed-f-${f}`)) $(`ed-f-${f}`).value = fmtStamp(v, 3);
    $(`ed-f-${f}`).classList.remove('invalid');
  }
  $('ed-f-len').textContent = fmtStamp(clipLen(c), 3);
  const crops = edCrops(), w = edCropWindow(ti, c);
  $('ed-crop').classList.toggle('off', !crops);
  for (const id of ['ed-pan', 'ed-zoom-c', 'ed-centre']) $(id).disabled = !crops;
  $('ed-crop-hint').hidden = crops;
  $('ed-crop-hint').textContent = `${ED_FITS[ed.p.fit]} shows the whole picture: pan and zoom apply to Crop and 21:9 · 3 videos.`;
  $('ed-crop-share').textContent = !crops ? 'whole picture' : Math.abs(w.w - 2 / 3) < 0.01 ? '2/3 of the width shows'
    : Math.abs(w.w - 0.5) < 0.01 ? 'half the width shows' : `${Math.round(w.w * 100)}% of the width shows`;
  $('ed-pan').value = Math.round((c.pan || 0) * 100);
  $('ed-pan-val').textContent = fmtPan(c.pan || 0);
  $('ed-zoom-c').value = Math.round((c.zoom || 1) * 100);
  $('ed-zoom-val').textContent = `${Math.round((c.zoom || 1) * 100)}%`;
  Object.assign($('ed-thumb-win').style, { left: `${w.x * 100}%`, top: `${w.y * 100}%`, width: `${w.w * 100}%`, height: `${w.h * 100}%` });
  $('ed-thumb-win').style.setProperty('--tk', TK_VIDEO[ti]); // on the video, as the monitor draws it, in every theme
  if (!edThumbKey.startsWith(`${c.video}@`)) $('ed-thumb-img').hidden = true; // another video's frame: hide until this one's arrives
  edThumbSoon();
}

/** The source frame of the selected clip at the playhead (its In when the playhead is elsewhere), ~300 ms after it settles. */
let edThumbTimer = 0, edThumbKey = '', edThumbSeq = 0;
function edThumbSoon() {
  clearTimeout(edThumbTimer);
  edThumbTimer = setTimeout(async () => {
    const seq = ++edThumbSeq; // a slower older answer must not land over a newer one
    const c = edSelClip();
    if (!c || ed.playing || ed.tab !== 'clip') return;
    const src = ed.t >= c.at && ed.t < clipEnd(c) ? c.in + ed.t - c.at : c.in, key = `${c.video}@${src.toFixed(2)}`;
    if (key === edThumbKey && !$('ed-thumb-img').hidden) return;
    const r = await window.api.frameAt(c.video, src);
    if (seq === edThumbSeq && r.ok && edSelClip() === c) {
      edThumbKey = key;
      $('ed-thumb-img').src = `data:image/jpeg;base64,${r.jpeg}`;
      $('ed-thumb-img').hidden = false;
    }
  }, 300);
}

/** Set a timing field of the selected clip, kept clear of its neighbours and inside its analysed range. */
function edSetTiming(f, v) {
  const c = edSelClip();
  if (!c || !Number.isFinite(v)) { edRenderClip(); return; }
  edCommit(() => {
    const tr = ed.p.tracks[ed.sel.ti], ci = ed.sel.ci, prev = tr.clips[ci - 1], next = tr.clips[ci + 1];
    const [smin, smax] = edSrcSpan(c), min = 1 / edHz(c), room = next ? next.at - c.at : Infinity;
    if (f === 'at') c.at = ms3(clamp(v, prev ? clipEnd(prev) : 0, next ? next.at - clipLen(c) : Infinity));
    if (f === 'in') c.in = ms3(clamp(v, Math.max(smin, c.out - room), c.out - min));
    if (f === 'out') c.out = ms3(clamp(v, c.in + min, Math.min(smax, c.in + room)));
  });
}
for (const f of ['at', 'in', 'out']) {
  const input = $(`ed-f-${f}`);
  input.addEventListener('change', () => {
    const v = parseTime(input.value);
    if (!Number.isFinite(v)) { input.classList.add('invalid'); return; }
    edSetTiming(f, v);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
}
for (const b of document.querySelectorAll('.ed-nudge')) {
  b.addEventListener('click', (e) => {
    const c = edSelClip();
    if (!c) return;
    edSetTiming(b.dataset.f, c[b.dataset.f] + Number(b.dataset.d) * (e.shiftKey ? 1 : 1 / edHz(c)));
  });
}

/** A live change to the selected clip's crop (slider or monitor drag); the undo step is taken when it ends. */
let edCropBefore = null;
function edCropLive(fn) {
  const c = edSelClip();
  if (!c || !edCrops()) return;
  // Pan what can be seen: bring the clip under the playhead first.
  if (ed.cur[ed.sel.ti] !== c) { edPause(); edSeek(clamp(ed.t, c.at, clipEnd(c) - edFrameStep())); }
  if (edCropBefore === null) edCropBefore = edSnap();
  fn(c);
  edFitVideo(ed.sel.ti);
  edRenderClip();
  const chip = document.querySelector('#pv-sel span');
  if (chip) chip.textContent = `${edClipId(ed.sel.ti, ed.sel.ci)} · pan ${fmtPan(c.pan || 0)}`;
}
function edCropDone() {
  if (edCropBefore === null) return;
  const before = edCropBefore;
  edCropBefore = null;
  edPush(before);
}
$('ed-pan').addEventListener('input', () => edCropLive((c) => { c.pan = Number($('ed-pan').value) / 100; }));
$('ed-zoom-c').addEventListener('input', () => edCropLive((c) => { c.zoom = Number($('ed-zoom-c').value) / 100; }));
$('ed-pan').addEventListener('change', edCropDone);
$('ed-zoom-c').addEventListener('change', edCropDone);
$('ed-centre').addEventListener('click', () => { edCropLive((c) => { c.pan = 0; }); edCropDone(); });
$('ed-board').addEventListener('pointerdown', (e) => {
  const out = e.target.closest('#pv-sel'), c = edSelClip();
  if (!out || !c || !edCrops() || e.button !== 0) return;
  e.preventDefault();
  const x0 = e.clientX, p0 = c.pan || 0, room = edCropWindow(ed.sel.ti, c).room;
  if (!(room > 0)) return;
  const move = (ev) => edCropLive((cl) => { cl.pan = Math.round(clamp(p0 + (((ev.clientX - x0) / ed.scale) * 2) / room, -1, 1) * 100) / 100; });
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); edCropDone(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

function edRenderTracks() {
  const body = $('ed-body-tracks');
  const parts = ed.p.tracks.map((tr, ti) => {
    const sec = node('section', 'ed-track');
    sec.setAttribute('aria-label', `Track ${LETTERS[ti]}`);
    sec.style.setProperty('--tk', TK[ti]);
    const head = node('div', 'ed-track-head'), target = edTarget(ti);
    head.append(node('span', 'ed-tag mono', LETTERS[ti]), node('b', '', `Track ${LETTERS[ti]}`), node('span', 'spacer'), node('span', 'mono hint', target ? `${target} fps target` : 'no clips yet'));
    sec.appendChild(head);
    for (const [key, label, ph] of [['title', 'Title on the video', edTrackTitle(ti)], ['subtitle', 'Subtitle', 'None']]) {
      const id = `ed-k-${LETTERS[ti]}-${key}`, l = node('label', '', label), input = node('input', 'ed-input');
      l.htmlFor = id;
      Object.assign(input, { id, type: 'text', value: tr[key], placeholder: ph, autocomplete: 'off' });
      let before = null;
      input.addEventListener('focus', () => { before = edSnap(); });
      input.addEventListener('input', () => { tr[key] = input.value; edBuildMonitor(); $('ed-heads').replaceChildren(node('div', 'ed-tracks-l', 'Tracks'), node('div'), ...ed.p.tracks.map((_, i) => edTrackHead(i))); });
      input.addEventListener('change', () => { if (before !== null) { const b = before; before = edSnap(); edTracksEditing = true; try { edPush(b); } finally { edTracksEditing = false; } } });
      sec.append(l, input);
    }
    const td = ed.data && ed.data.tracks[ti], sum = td && td.summary;
    if (sum && target) {
      const nums = node('div', 'ed-nums mono');
      const b = (v) => { const lv = level(Number(v.toFixed(1)), target); return node('b', lv === 'ok' ? '' : `lv-${lv}`, v.toFixed(1)); };
      const avg = node('span'), low = node('span'), hit = node('span');
      avg.append('AVG ', b(sum.avg_fps));
      low.append('1% ', b(sum.low_1pct_fps));
      const gap = td.gapS;
      hit.append(node('b', '', String(sum.hitches.count)), ` hitch${sum.hitches.count === 1 ? '' : 'es'}`);
      nums.append(avg, low, hit);
      sec.appendChild(nums);
      if (gap >= 0.05) sec.appendChild(node('div', 'ed-nums mono', `${gap.toFixed(1)} s gap not counted`));
    }
    return sec;
  });
  const note = node('p', 'hint', 'Numbers cover the export range. Sound comes from the track with the speaker on.');
  const verdict = ed.data && typeof ed.data.verdict === 'string' && ed.data.verdict ? node('p', 'hint', ed.data.verdict) : '';
  body.replaceChildren(...parts, ...(verdict ? [verdict] : []), note);
}

function edRenderMedia() {
  const body = $('ed-body-media'), cands = abCandidates(), n = ed.p.tracks.length;
  const rows = cands.map((cand) => {
    const row = node('div', 'ed-media');
    row.draggable = true;
    row.title = `${cand.path}\nDrag onto a track, or add it at the end of one`;
    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-cfps-media', cand.path); e.dataTransfer.effectAllowed = 'copy'; });
    const info = cand.q ? cand.q.info : cand.e.info, secs = cand.q ? cand.q.result.summary.capture.seconds : cand.e.seconds;
    row.append(node('span', 'ed-media-name', cand.name),
      node('span', 'ed-media-meta mono', [info ? fmtFormat(info) : '', secs ? `${fmtDuration(secs)} analysed` : ''].filter(Boolean).join(' · ')));
    const add = node('div', 'ed-media-add');
    add.appendChild(node('span', '', 'Add to'));
    for (let ti = 0; ti < n; ti++) {
      const b = node('button', '', LETTERS[ti]);
      b.type = 'button';
      b.style.setProperty('--tk', TK[ti]);
      b.setAttribute('aria-label', `Add ${cand.name} to track ${LETTERS[ti]}`);
      b.addEventListener('click', () => edAdd(cand, ti));
      add.appendChild(b);
    }
    row.appendChild(add);
    return row;
  });
  body.replaceChildren(...(rows.length ? rows : [node('p', 'hint', 'No analysed recordings yet. Analyse some in the Library; they show up here.')]),
    node('p', 'hint', 'A clip is added at the end of the track with its whole analysed range. All clips on a track need the same fps target.'));
}

// ---- transport, header, keys ----

function edMark(which) {
  const r = { ...edRange() }, len = r.out - r.in, end = Math.max(0, ...ed.p.tracks.map(edTrackEnd)), t = ed.t;
  // In past Out (or Out before In) starts a new range there, as long as the old one where it fits.
  if (which === 'in') {
    if (t >= end - 0.05) { edStatus('Mark In before the end of the clips.'); return; }
    if (t >= r.out - 0.05) r.out = ms3(Math.min(end, t + len));
    r.in = ms3(t);
  } else {
    if (t <= 0.05) { edStatus('Mark Out after the start.'); return; }
    if (t <= r.in + 0.05) r.in = ms3(Math.max(0, t - len));
    r.out = ms3(t);
  }
  edCommit(() => { ed.p.range = r; });
}
$('ed-play').addEventListener('click', () => (ed.playing ? edPause() : edPlay()));
$('ed-start').addEventListener('click', () => { edPause(); edSeek(edRange().in); });
$('ed-end').addEventListener('click', () => { edPause(); edSeek(edRange().out); });
$('ed-back').addEventListener('click', () => edStepFrame(-1));
$('ed-fwd').addEventListener('click', () => edStepFrame(1));
$('ed-mark-in').addEventListener('click', () => edMark('in'));
$('ed-mark-out').addEventListener('click', () => edMark('out'));
$('ed-safe').addEventListener('click', () => {
  ed.safe = !ed.safe;
  $('ed-safe').setAttribute('aria-pressed', String(ed.safe));
  $('ed-safe-strip').hidden = !ed.safe;
});
const edFullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : $('ed-monitor').requestFullscreen()).catch(() => {});
$('ed-full').addEventListener('click', edFullscreen);
for (const r of document.querySelectorAll('input[name="ed-quality"]')) {
  r.addEventListener('change', () => { ed.exact = radioValue('ed-quality') === 'exact'; edScheduleExact(); });
}
$('ed-export').addEventListener('click', async () => {
  if (state.running) return;
  if (!ed.data) { edStatus(ed.error || 'Add clips to the tracks first.'); return; }
  await state.gpuReady;
  edPause();
  runCompareExport(() => window.api.renderTimeline(edProject()));
});

document.addEventListener('keydown', (e) => {
  // Only fields one types into keep their keys; a focused slider, radio or button does not.
  if (!viewIs('view-compare') || $('edit-mode').hidden || e.target.closest('input:not([type=radio]):not([type=checkbox]):not([type=range]):not([type=button]), select, textarea, [contenteditable]')) return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (mod && (k === 'z' || k === 'y')) { e.preventDefault(); edUndo(k === 'y' || e.shiftKey ? 1 : -1); return; }
  if (mod || e.altKey) return;
  const blk = e.target.closest('.ed-clipb');
  if (blk && k === 'enter') { e.preventDefault(); edSelect(Number(blk.dataset.ti), Number(blk.dataset.ci)); return; }
  if (k === ' ') {
    e.preventDefault();
    if (e.target.blur && !blk) e.target.blur(); // a focused button would also take the Space as a click
    $('ed-play').click();
  } else if (k === ',') edStepFrame(-1);
  else if (k === '.') edStepFrame(1);
  else if (k === 'i') edMark('in');
  else if (k === 'o') edMark('out');
  else if (k === 'v' || k === 'c') { $(k === 'v' ? 'ed-tool-select' : 'ed-tool-split').checked = true; edRenderTimeline(); }
  else if (k === 's') { if (ed.sel) edSplit(ed.sel.ti, ed.sel.ci, ed.t); }
  else if (k === 'delete' || k === 'backspace') {
    if (!ed.sel) return;
    e.preventDefault();
    const { ti, ci } = ed.sel;
    edCommit(() => { ed.p.tracks[ti].clips.splice(ci, 1); ed.sel = null; });
  } else if (k === 'f') edFullscreen();
});

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
  position: ['opt-pos', 'radio'], style: ['opt-style', 'radio'], frame: ['opt-frame', 'radio'], theme: ['opt-theme', 'radio'], encoder: ['opt-enc', 'radio'],
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
