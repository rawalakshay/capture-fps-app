'use strict';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';

const state = {
  queue: [],          // { path, name, stem, info, defaultOutDir, status, result, opts, error }
  outBase: null,      // a folder the user chose; null = next to each video
  toolsOk: false,
  running: false,
  cancelled: false,
  result: null,
  opts: null,
  lastAnalysed: null, // video path the main process can render or preview again
  previewAt: 0,       // seconds into the analysed span
  range: null,        // chart selection [start, end] in clip seconds, mirrored in the Start and End fields
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

function level(fps, target) {
  if (fps >= 0.95 * target) return 'ok';
  if (fps >= 0.8 * target) return 'warn';
  return 'bad';
}

const STEP_OF_VIEW = { 'view-empty': 1, 'view-progress': 2, 'view-error': 2, 'view-results': 3 };
function show(view) {
  for (const id of ['view-empty', 'view-progress', 'view-error', 'view-results']) $(id).hidden = id !== view;
  for (const li of $('stepbar').children) {
    const n = Number(li.dataset.s);
    li.classList.toggle('on', n === STEP_OF_VIEW[view]);
    li.classList.toggle('done', n < STEP_OF_VIEW[view]);
  }
}

function el(tag, attrs = {}, text) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}

function updateRunButton() {
  const ready = state.toolsOk && state.queue.length > 0;
  $('run').disabled = !ready || state.running;
  $('out-change').disabled = !state.queue.length || state.running;
  $('pick').disabled = state.running;
  $('pick2').disabled = state.running;
  // Render and preview need the analysis the main process still holds: the last one.
  const current = state.result && state.result.video === state.lastAnalysed;
  for (const id of ['render-again', 'preview']) {
    $(id).disabled = state.running || !current;
    $(id).title = current || !state.result ? $(id).dataset.title || ($(id).dataset.title = $(id).title) : 'Analyse this recording again to render or preview it';
  }
  $('copy-summary').disabled = !state.result;
  const hint = $('run-hint');
  if (!state.toolsOk) hint.textContent = 'ffmpeg is not ready';
  else if (!state.queue.length) hint.textContent = 'Choose a recording first';
  else if (state.running) hint.textContent = 'Working…';
  else { // measuring takes about the clip's length, rendering about as much again
    const a = parseTime($('opt-start').value) || 0, b = parseTime($('opt-end').value) || Infinity;
    const secs = state.queue.reduce((t, q) => t + Math.max(0, Math.min(b, q.info.duration) - a), 0) * ($('opt-render').checked ? 2 : 1);
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
  const t = await window.api.tools();
  state.toolsOk = t.ok;
  const n = $('tools');
  if (t.ok) {
    n.textContent = 'ffmpeg ready';
    n.className = 'tools ok';
  } else {
    n.textContent = t.reason;
    n.className = 'tools bad';
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
    $('tools').textContent = 'ffmpeg ready · NVIDIA GPU';
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

// ---------- choosing a video ----------

/** Where an item's files go: the chosen folder (a subfolder each when there are several), or next to the video. */
function itemOutDir(item) {
  if (!state.outBase) return item.defaultOutDir;
  return state.queue.length > 1 ? `${state.outBase}\\${item.stem}_fps` : state.outBase;
}

function renderQueue() {
  const ul = $('queue');
  ul.replaceChildren();
  ul.hidden = state.queue.length < 2;
  const words = { waiting: 'waiting', measuring: 'working…', done: 'done', error: 'failed', cancelled: 'cancelled' };
  for (const item of state.queue) {
    const li = document.createElement('li');
    const a = document.createElement('span');
    a.className = 'q-name';
    a.textContent = item.name;
    a.title = item.path;
    const b = document.createElement('span');
    b.className = `q-status ${item.status}`;
    b.textContent = words[item.status];
    li.append(a, b);
    ul.appendChild(li);
  }
  const first = state.queue[0];
  $('pick').classList.toggle('has-file', Boolean(first));
  $('file-name').textContent = first ? first.name + (state.queue.length > 1 ? ` + ${state.queue.length - 1} more` : '') : 'Choose videos…';
  const out = first ? (state.outBase || first.defaultOutDir) : 'Next to the video';
  $('out-path').textContent = out;
  $('out-path').title = out;
  $('drop-title').textContent = first ? (state.queue.length > 1 ? `${state.queue.length} recordings queued` : first.name) : 'Drop recordings here';
  $('pick2').textContent = first ? 'Choose other videos' : 'Choose videos';
  $('side').classList.toggle('no-file', !first);
  renderRecent();
  syncSummaries();
  // Several clips keep their own file names as the overlay title.
  $('opt-title').disabled = state.queue.length > 1;
  $('opt-title').placeholder = state.queue.length > 1 ? 'Each clip uses its file name' : first ? first.stem : 'File name';
  syncUpscaler();
  updateRunButton();
}

/** Probe each file; files already queued are skipped, unreadable ones are reported and dropped. */
async function addVideos(paths) {
  paths = (paths || []).filter((p) => p && !state.queue.some((q) => q.path === p));
  if (!paths.length || state.running) return;
  $('long-note').hidden = true;
  $('file-meta').textContent = 'Reading…';
  $('file-meta').className = 'file-meta';
  const errors = [];
  for (const p of paths) {
    const r = await window.api.probe(p);
    if (!r.ok) { errors.push(`${fileName(p)}: ${r.error}`); continue; }
    state.queue.push({ path: p, name: r.name, stem: r.name.replace(/\.[^.]+$/, ''), info: r.info, defaultOutDir: r.outDir, status: 'waiting', result: null });
    rememberRecent(p);
  }
  const first = state.queue[0];
  if (first) {
    const i = first.info;
    $('file-meta').textContent = `${i.width}×${i.height} · ${i.hz.toFixed(2)} Hz · ${fmtDuration(i.duration)}` +
      (state.queue.length > 1 ? ` · ${state.queue.length} files` : '');
    $('drop-sub').textContent = i.hz < 59 || i.hz > 61
      ? `Recorded at ${i.hz.toFixed(2)} fps. The game's frame rate is measured against this; record at the console's refresh rate (60) for best results.`
      : 'Ready. Set any options on the left, then press Analyse.';
  }
  if (errors.length) {
    $('file-meta').textContent = errors.join(' · ');
    $('file-meta').className = 'file-meta err';
  }
  renderQueue();
  if (!state.running) show('view-empty');
}

async function pickVideo() {
  const paths = await window.api.pickVideo();
  if (paths.length) {
    if (!state.running) { state.queue = []; renderQueue(); } // a fresh pick replaces the list
    addVideos(paths);
  }
}

$('pick').addEventListener('click', pickVideo);
$('pick2').addEventListener('click', pickVideo);

$('out-change').addEventListener('click', async () => {
  const p = await window.api.pickFolder(state.outBase || (state.queue[0] && state.queue[0].defaultOutDir));
  if (p) {
    state.outBase = p;
    renderQueue();
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
  $('video-opts').hidden = $('tab-look').hidden = $('tab-export').hidden = !on;
  if (!on) selectTab('measure');
  updateRunButton();
});

// ---------- option tabs ----------

function selectTab(name) {
  for (const b of $('tabs').children) b.setAttribute('aria-selected', String(b.id === `tab-${name}`));
  for (const p of document.querySelectorAll('#panes .pane')) p.hidden = p.id !== `pane-${name}`;
}
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[role="tab"]');
  if (b) selectTab(b.id.slice(4));
});

remember('opt-pos', 'overlayPosition');

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
  const h = Number($('opt-res').value) || 0, src = state.queue[0] ? state.queue[0].info.height : 0;
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
}
for (const r of document.querySelectorAll('input[name="opt-style"]')) r.addEventListener('change', syncStyle);
syncStyle();

// The pill chips show what they would draw.
function syncSummaries() {
  const q = state.queue[0];
  document.querySelector('label[for="opt-target-pill"]').textContent = `TARGET ${$('opt-target').value || 'auto'}`;
  document.querySelector('label[for="opt-format-pill"]').textContent = q ? `${q.info.height}P${Math.round(q.info.hz)}` : 'format';
}
$('side').addEventListener('input', syncSummaries);
$('side').addEventListener('change', syncSummaries);
syncSummaries();

// ⋯ menus close on a choice or a click elsewhere.
document.addEventListener('click', (e) => {
  for (const m of document.querySelectorAll('details.menu[open]')) {
    if (!m.contains(e.target) || e.target.closest('.menu-list button')) m.open = false;
  }
});
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Enter' && !$('run').disabled) $('run').click();
  const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
  if (step && !$('scrub-row').hidden && !$('view-results').hidden && !/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) {
    e.preventDefault();
    const before = $('scrub').value;
    $('scrub').value = Number(before) + step; // the input clamps it to its range
    if ($('scrub').value !== before) $('scrub').dispatchEvent(new Event('change'));
  }
});

// The last two recordings, as shortcuts on the empty screen.
function loadRecent() {
  try { return JSON.parse(localStorage.getItem('recent') || '[]') || []; } catch (_) { return []; }
}
function rememberRecent(p) {
  try { localStorage.setItem('recent', JSON.stringify([p, ...loadRecent().filter((x) => x !== p)].slice(0, 2))); } catch (_) { /* ignore */ }
}
function renderRecent() {
  const box = $('recent'), list = loadRecent();
  box.replaceChildren();
  box.hidden = !list.length || state.queue.length > 0;
  if (box.hidden) return;
  box.append('Recent:');
  for (const p of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = fileName(p);
    b.title = p;
    b.addEventListener('click', () => addVideos([p]));
    box.appendChild(b);
  }
}
renderRecent();

// The preview follows the overlay and export options while results are up (debounced).
let previewTimer = 0, previewDirty = false;
function schedulePreview() {
  if ($('view-results').hidden || !state.result || state.result.video !== state.lastAnalysed) return;
  if (state.running) { previewDirty = true; return; } // drawn again once the current one is done
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 600);
}
$('video-opts').addEventListener('input', schedulePreview);

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
    title: state.queue.length > 1 ? null : $('opt-title').value.trim() || null,
    position: radioValue('opt-pos'),
    showTarget: $('opt-target-pill').checked,
    showFormat: $('opt-format-pill').checked,
    caption: $('opt-caption').value.trim() || null,
    captionPosition: $('opt-caption-pos').value,
    watermark: $('opt-watermark-on').checked ? $('opt-watermark').value.trim() : '',
    style: radioValue('opt-style'),
    longGraph: $('opt-long').checked,
    longGraphOpacity: Number($('opt-long-opacity').value) / 100,
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
    li.querySelector('.step-pct').textContent = '';
  }
}

let phaseStart = 0;
let currentStep = null;

function onProgress({ phase, fraction }) {
  if (phase === 'done') return;
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
  if (phase === 'analyse' || phase === 'overlay') {
    li.classList.add('indeterminate');
    pct.textContent = phase === 'overlay' ? 'building overlay…' : '';
    return;
  }
  li.classList.remove('indeterminate');
  li.querySelector('.bar-fill').style.width = `${(fraction * 100).toFixed(1)}%`;
  const elapsed = (performance.now() - phaseStart) / 1000;
  let eta = '';
  if (fraction > 0.03 && elapsed > 2) eta = ` · ${fmtDuration(elapsed / fraction - elapsed)} left`;
  pct.textContent = `${Math.floor(fraction * 100)}%${eta}`;
}

window.api.onProgress(onProgress);

/** A note when the clip is long enough that the overlay file and the render get heavy. */
function longClipNote(opts) {
  const longest = Math.max(...state.queue.map((q) => (opts.end || q.info.duration) - (opts.start || 0)));
  if (!opts.renderVideo || longest <= 1800) return null;
  return `This clip is ${Math.round(longest / 60)} minutes long. The overlay file will be about ${Math.round(longest * 0.2)} MB and rendering will take a while. ` +
    'Set a range, or turn off "Also render the video", to go faster.';
}

$('run').addEventListener('click', async () => {
  await state.gpuReady; // the encoder default depends on the GPU check
  let opts;
  try {
    opts = readOptions();
  } catch (e) {
    $('file-meta').textContent = e.message;
    $('file-meta').className = 'file-meta err';
    return;
  }
  state.running = true;
  state.cancelled = false;
  updateRunButton();
  $('cancel').hidden = false;
  const note = longClipNote(opts);
  $('long-note').textContent = note || '';
  $('long-note').hidden = !note;
  for (const item of state.queue) { item.status = 'waiting'; item.result = null; item.error = null; item.note = null; }
  // One after another; a cancel stops the current job and skips the rest.
  for (let i = 0; i < state.queue.length; i++) {
    const item = state.queue[i];
    if (state.cancelled) { item.status = 'cancelled'; continue; }
    item.status = 'measuring';
    renderQueue();
    $('prog-name').textContent = item.name + (state.queue.length > 1 ? ` (${i + 1} of ${state.queue.length})` : '');
    currentStep = null;
    resetSteps(opts.renderVideo);
    show('view-progress');
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
    if (r.ok) state.lastAnalysed = r.result.video; // the resolved path, as results carry it
    if (r.cancelled || (r.result && r.result.renderCancelled)) state.cancelled = true; // Cancel stops the whole queue
  }
  renderQueue();
  state.running = false;
  $('cancel').hidden = true;
  const done = state.queue.filter((q) => q.status === 'done');
  const failed = state.queue.find((q) => q.status === 'error');
  if (done.length) {
    selectResult(done[done.length - 1]);
    if (failed) addWarning(`${failed.name} failed: ${failed.error}`);
    show('view-results');
  } else if (failed) {
    showError(state.queue.length > 1 ? `${failed.name}: the analysis stopped` : 'The analysis stopped', failed.error);
  } else {
    show(state.result ? 'view-results' : 'view-empty');
  }
  updateRunButton();
});

$('render-again').addEventListener('click', async () => {
  if (!state.result || state.running) return;
  await state.gpuReady;
  const opts = renderOptions();
  state.running = true;
  updateRunButton();
  $('cancel').hidden = false;
  $('prog-name').textContent = fileName(state.result.video);
  currentStep = null;
  resetSteps(true, true);
  show('view-progress');
  const r = await window.api.renderOnly(opts);
  finishJob(r, state.opts, 'Rendering stopped');
});

$('preview').addEventListener('click', () => runPreview());

/** One frame at state.previewAt with the overlay options on the left, shown under the warnings. */
async function runPreview() {
  if (!state.result) return;
  if (state.running) { previewDirty = true; return; } // drawn again at the new moment once this one is done
  await state.gpuReady;
  const at = state.previewAt;
  const opts = renderOptions();
  state.running = true;
  updateRunButton();
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
  if (state.previewAt === at) { state.previewAt = r.at; syncScrub(); } // unless the user moved on meanwhile
  $('preview-cap').textContent = `At ${fmtStamp((state.opts.start || 0) + r.at)} with the options on the left. Drag the slider, press ← →, or click the chart to move the moment; press Render video to apply the options.`;
}

function finishJob(r, opts, errorTitle) {
  state.running = false;
  $('cancel').hidden = true;
  updateRunButton();
  if (r.ok) {
    const item = state.queue.find((q) => q.result && q.result.video === r.result.video);
    if (item) item.result = r.result;
    state.result = r.result;
    state.opts = opts;
    renderResults(r.result, opts);
    show('view-results');
  } else if (r.cancelled) {
    show(state.result ? 'view-results' : 'view-empty');
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

/** Show one queued item's results; the switch row lists every finished one. */
function selectResult(item) {
  state.result = item.result;
  state.opts = item.opts;
  renderResults(item.result, item.opts);
  const nav = $('res-switch');
  nav.replaceChildren();
  const done = state.queue.filter((q) => q.status === 'done');
  nav.hidden = done.length < 2;
  for (const q of done) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn-small';
    b.textContent = q.name;
    b.setAttribute('aria-pressed', String(q === item));
    b.addEventListener('click', () => { if (!state.running) selectResult(q); });
    nav.appendChild(b);
  }
  updateRunButton();
}

function addWarning(text) {
  const d = document.createElement('div');
  d.className = 'warn';
  d.textContent = text;
  $('warnings').appendChild(d);
}

$('cancel').addEventListener('click', () => window.api.cancelJob());
$('error-back').addEventListener('click', () => show(state.result ? 'view-results' : 'view-empty'));

// ---------- results ----------

function setLevel(node, fps, target) {
  node.className = `lv-${level(fps, target)}`;
}

function renderResults(r, opts) {
  const s = r.summary;
  const c = s.capture;
  const t = s.target_fps;
  $('res-name').textContent = fileName(r.video);
  state.previewAt = c.seconds / 2;
  previewDirty = false; // a fresh preview is scheduled below anyway
  // The main process only holds the last analysis, so only that one can be previewed.
  const current = r.video === state.lastAnalysed;
  $('preview-img').hidden = true;
  $('preview-empty').hidden = false;
  $('preview-empty').textContent = current ? 'Drawing the preview…' : 'Analyse this recording again to preview the overlay.';
  if (current) setTimeout(schedulePreview, 0); // after the view is shown
  $('scrub-row').hidden = !current;
  $('scrub').max = Math.max(0, Math.ceil(c.seconds) - 1);
  syncScrub();
  renderVerdict(s, opts);
  const nStalls = s.possible_stalls_or_static_scenes.length;
  $('t-longest-sub').textContent = nStalls ? `${nStalls} frame${nStalls === 1 ? '' : 's'} over 200 ms` : 'No frame over 200 ms';
  $('sum-details').textContent = `${nStalls} long frame${nStalls === 1 ? '' : 's'} · threshold ${s.threshold} ${s.threshold_source}`;
  const span = opts.start || opts.end
    ? ` · ${fmtStamp(opts.start || 0)}–${opts.end ? fmtStamp(opts.end) : 'end'}`
    : '';
  $('res-meta').textContent = `${c.width}×${c.height} · ${c.refresh_hz} Hz · ${fmtDuration(c.seconds)} analysed${span} · target ${t} fps`;

  $('t-avg').textContent = s.avg_fps.toFixed(1);
  setLevel($('t-avg'), s.avg_fps, t);
  $('t-avg-sub').textContent = `${s.game_frames.toLocaleString()} game frames`;
  $('t-low1').textContent = s.low_1pct_fps.toFixed(1);
  setLevel($('t-low1'), s.low_1pct_fps, t);
  $('t-low01').textContent = s.low_0_1pct_fps.toFixed(1);
  setLevel($('t-low01'), s.low_0_1pct_fps, t);
  $('t-missed').textContent = s.frames_missing_target.toLocaleString();
  $('t-missed-sub').textContent = `${s.frames_missing_target_pct}%`;
  $('t-longest').textContent = s.longest_frame_ms.toFixed(1);

  $('warnings').replaceChildren();
  if (c.dropped_by_recorder) {
    addWarning(`The recording itself is missing ${c.dropped_by_recorder} refresh${c.dropped_by_recorder === 1 ? '' : 'es'} (OBS dropped frames). Results near those points are not reliable.`);
  }
  if (r.renderError) addWarning(`The overlay video was not made. ${r.renderError}`);
  if (c.refresh_hz < 59 || c.refresh_hz > 61) {
    addWarning(`Recorded at ${c.refresh_hz} fps. Match OBS to the console's refresh rate (usually 60) so every refresh is captured.`);
  }
  if (!$('long-note').hidden) addWarning($('long-note').textContent);
  const item = state.queue.find((q) => q.result === r);
  if (item && item.note) addWarning(item.note);

  const stalls = $('stalls');
  stalls.replaceChildren();
  const list = s.possible_stalls_or_static_scenes;
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'None. No frame stayed on screen for 200 ms or more.';
    stalls.appendChild(li);
  }
  for (const [at, ms] of list) {
    const li = document.createElement('li');
    const a = document.createElement('span');
    a.textContent = fmtStamp((opts.start || 0) + at);
    const b = document.createElement('span');
    b.textContent = `${ms.toFixed(1)} ms`;
    b.className = ms >= 500 ? 'lv-bad' : 'lv-warn';
    li.append(a, b);
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
    ['Threshold', `${s.threshold} (${s.threshold_source})`],
    ['Diff p5 / p50 / p95', `${p.p5} / ${p.p50} / ${p.p95}`],
    ['Dropped by recorder', String(c.dropped_by_recorder)],
    ['Measured in', `${fmtDuration(r.measureSeconds)} (${r.hwDecode ? 'GPU' : 'CPU'} decoding)`],
    ['Rendered in', r.overlayVideo ? `${fmtDuration(r.renderSeconds)} (${r.encoder === 'gpu' ? 'NVENC' : 'x264'}, ${r.outputWidth}×${r.outputHeight})` : 'Not rendered'],
    ['Output', r.outDir],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }

  $('open-video').hidden = !r.overlayVideo;
  // One primary action: Play once a video exists, else Render.
  $('render-again').textContent = r.overlayVideo ? 'Render again' : 'Render video';
  $('render-again').classList.toggle('btn-primary', !r.overlayVideo);
  $('render-again').classList.toggle('btn-small', Boolean(r.overlayVideo));
  drawChart();
}

/** One sentence above the numbers: how many frames hit the target, and the worst moments as chips that seek the preview. */
function renderVerdict(s, opts) {
  const t = s.target_fps, off = opts.start || 0;
  const held = Math.max(0, Math.min(100, Math.round(100 - s.frames_missing_target_pct)));
  const lv = held >= 95 ? 'ok' : held >= 80 ? 'warn' : 'bad';
  const worst = s.possible_stalls_or_static_scenes.slice().sort((a, b) => b[1] - a[1]);
  const box = $('verdict');
  box.className = `verdict lv-${lv}`;
  $('verdict-ring').style.setProperty('--pct', `${held}%`);
  $('verdict-pct').textContent = `${held}%`;
  const capped = worst.length >= 20 && worst[0][1] < s.longest_frame_ms; // the list holds the first 20 only
  $('verdict-title').textContent = `${held}% of frames hit ${t} fps.` + (worst.length
    ? ` ${capped ? '20+' : worst.length} long frame${worst.length === 1 ? '' : 's'}, the ${capped ? 'longest listed' : 'worst'} at ${fmtDuration(off + worst[0][0])}.`
    : ' No frame stayed on screen for 200 ms or more.');
  $('verdict-sub').textContent = `Average ${s.avg_fps.toFixed(1)} fps · 1% low ${s.low_1pct_fps.toFixed(1)} fps · ` +
    `${s.frames_missing_target.toLocaleString()} of ${s.game_frames.toLocaleString()} frames missed the target in ${fmtDuration(s.capture.seconds)}`;
  const chips = $('verdict-chips');
  chips.replaceChildren();
  for (const [at, ms] of worst.slice(0, 3)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = ms >= 500 ? 'lv-bad' : 'lv-warn';
    b.textContent = `${fmtDuration(off + at)} · ${ms.toFixed(0)} ms`;
    b.title = 'Preview this moment';
    b.addEventListener('click', () => { state.previewAt = at; runPreview(); });
    chips.appendChild(b);
  }
}

/** The slider and its label follow state.previewAt. */
function syncScrub() {
  $('scrub').value = Math.floor(state.previewAt);
  $('scrub-val').textContent = fmtDuration(((state.opts && state.opts.start) || 0) + state.previewAt);
}
$('scrub').addEventListener('input', () => {
  $('scrub-val').textContent = fmtDuration(((state.opts && state.opts.start) || 0) + Number($('scrub').value));
});
$('scrub').addEventListener('change', () => {
  state.previewAt = Number($('scrub').value) + 0.5;
  runPreview();
});

$('open-video').addEventListener('click', () => {
  if (state.result && state.result.overlayVideo) window.api.openPath(state.result.overlayVideo);
});
$('open-folder').addEventListener('click', () => {
  if (!state.result) return;
  window.api.showInFolder(state.result.overlayVideo || `${state.result.outDir}\\summary.json`);
});

function drawChart() {
  const host = $('chart');
  host.replaceChildren();
  if (!state.result) return;
  const data = state.result.perSecond;
  const target = state.result.summary.target_fps;
  const W = host.clientWidth, H = host.clientHeight;
  if (!W || !data.length) return;
  const L = 34, R = 8, T = 10, B = 24;
  const pw = W - L - R, ph = H - T - B;
  const maxY = Math.max(target * 1.25, ...data.map((d) => d[1]));
  const y = (v) => T + ph - (v / maxY) * ph;
  const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Frames per second for each second of the recording, target ${target}` });

  for (const v of [0, target / 2, target]) {
    svg.appendChild(el('line', { class: 'grid', x1: L, x2: W - R, y1: y(v), y2: y(v) }));
    svg.appendChild(el('text', { class: 'axis', x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, String(Math.round(v))));
  }

  const n = data.length;
  const slot = pw / n;
  const gap = slot > 4 ? 1 : 0;
  const colors = { ok: '#5AA9E6', warn: '#F5B13D', bad: '#F2545B' };
  const offset = (state.opts && state.opts.start) || 0;
  for (const [sec, fps] of data) {
    const h = Math.max(1.5, (fps / maxY) * ph);
    const rect = el('rect', {
      x: (L + sec * slot).toFixed(2), y: (T + ph - h).toFixed(2),
      width: Math.max(0.6, slot - gap).toFixed(2), height: h.toFixed(2),
      fill: colors[level(fps, target)],
    });
    rect.appendChild(el('title', {}, `${fmtDuration(offset + sec)}  ${fps} fps`));
    svg.appendChild(rect);
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

  // Click a second to preview there; drag to set Start and End; double-click to clear.
  const sel = el('rect', { class: 'sel', x: L, y: T, width: 0, height: ph, visibility: 'hidden' });
  const hit = el('rect', { class: 'hit', x: L, y: T, width: pw, height: ph });
  svg.append(sel, hit);
  const secAt = (e) => Math.min(n, Math.max(0, Math.round((e.clientX - svg.getBoundingClientRect().left - L) / slot)));
  const showSel = (a, b) => {
    sel.setAttribute('x', L + Math.min(a, b) * slot);
    sel.setAttribute('width', Math.abs(a - b) * slot);
    sel.setAttribute('visibility', 'visible');
  };
  let s0 = null;
  hit.addEventListener('pointerdown', (e) => { s0 = secAt(e); hit.setPointerCapture(e.pointerId); });
  hit.addEventListener('pointermove', (e) => { if (s0 !== null) showSel(s0, secAt(e)); });
  hit.addEventListener('pointerup', (e) => {
    if (s0 === null) return;
    const s1 = secAt(e), a = Math.min(s0, s1), b = Math.max(s0, s1);
    s0 = null;
    if (b - a >= 1) {
      showSel(a, b);
      setRange(offset + a, offset + b);
    } else {
      sel.setAttribute('visibility', 'hidden');
      state.previewAt = Math.min(a, Math.max(0, n - 1)) + 0.5;
      runPreview();
    }
  });
  hit.addEventListener('dblclick', () => { setRange(null, null); sel.setAttribute('visibility', 'hidden'); });
  if (state.range) {
    const [a, b] = state.range;
    if (a >= offset && b <= offset + n) showSel(a - offset, b - offset);
  }
  host.appendChild(svg);
}

/** Write a chart selection into the Start and End fields (null clears both). */
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
    ? 'Click a second to preview the overlay there. Drag across the chart to set Start and End, then press Analyse to measure only that part. Double-click to clear.'
    : `Start and End set to ${fmtStamp(a)}–${fmtStamp(b)}. Press Analyse to measure only that part. Double-click the chart to clear.`;
}

new ResizeObserver(() => { if (!$('view-results').hidden) drawChart(); }).observe($('chart'));

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
  const stalls = s.possible_stalls_or_static_scenes;
  if (stalls.length) lines.push(`Long frames: ${stalls.slice(0, 8).map(([at, ms]) => `${fmtStamp(off + at)} (${ms.toFixed(0)} ms)`).join(', ')}`);
  if (c.dropped_by_recorder) lines.push(`Recorder dropped ${c.dropped_by_recorder} refreshes`);
  const b = $('copy-summary');
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    b.textContent = 'Copied';
    setTimeout(() => { b.textContent = 'Copy summary'; }, 1500);
  } catch (e) {
    addWarning(`Could not copy: ${e.message}`);
  }
});

// ---------- presets ----------

// Every option a preset holds: control id (or radio group name) and how to read it.
const PRESET_CONTROLS = {
  position: ['opt-pos', 'radio'], style: ['opt-style', 'radio'], encoder: ['opt-enc', 'radio'],
  showTarget: ['opt-target-pill', 'checked'], showFormat: ['opt-format-pill', 'checked'],
  caption: ['opt-caption', 'value'], captionPosition: ['opt-caption-pos', 'value'],
  watermarkOn: ['opt-watermark-on', 'checked'], watermark: ['opt-watermark', 'value'],
  longGraph: ['opt-long', 'checked'], longGraphOpacity: ['opt-long-opacity', 'value'],
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

checkTools();
