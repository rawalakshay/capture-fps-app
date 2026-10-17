'use strict';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';

const state = {
  video: null,
  info: null,
  outDir: null,
  toolsOk: false,
  running: false,
  result: null,
  gpu: false,
  gpuReady: Promise.resolve(),
};

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

function show(view) {
  for (const id of ['view-empty', 'view-progress', 'view-error', 'view-results']) $(id).hidden = id !== view;
}

function el(tag, attrs = {}, text) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}

function updateRunButton() {
  $('run').disabled = !(state.toolsOk && state.info) || state.running;
  $('out-change').disabled = !state.info || state.running;
  $('pick').disabled = state.running;
  $('pick2').disabled = state.running;
  $('render-again').disabled = state.running;
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
    n.textContent = `${t.ffmpeg ? 'ffprobe' : 'ffmpeg'} not found on PATH`;
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
    $('enc-gpu-sub').textContent = 'About 5× faster';
    $('enc-gpu').checked = true; // the default when the GPU can do it
    $('tools').textContent = 'ffmpeg ready · NVIDIA GPU';
  } else {
    $('enc-gpu-sub').textContent = 'Not available here';
    $('enc-gpu').disabled = true;
    document.querySelector('label[for="enc-gpu"]').title = g.reason || 'No NVIDIA GPU found';
    $('enc-cpu').checked = true;
  }
  remember('opt-enc', 'encoder');
}

// ---------- choosing a video ----------

async function setVideo(p) {
  if (!p || state.running) return;
  $('file-name').textContent = p.split(/[\\/]/).pop();
  $('file-meta').textContent = 'Reading…';
  $('file-meta').className = 'file-meta';
  $('pick').classList.add('has-file');
  const r = await window.api.probe(p);
  if (!r.ok) {
    state.video = null;
    state.info = null;
    $('file-meta').textContent = r.error;
    $('file-meta').className = 'file-meta err';
    updateRunButton();
    return;
  }
  state.video = p;
  state.info = r.info;
  state.outDir = r.outDir;
  const i = r.info;
  $('file-meta').textContent = `${i.width}×${i.height} · ${i.hz.toFixed(2)} Hz · ${fmtDuration(i.duration)}`;
  $('opt-title').placeholder = r.name.replace(/\.[^.]+$/, '');
  $('out-path').textContent = state.outDir;
  $('out-path').title = state.outDir;
  $('drop-title').textContent = r.name;
  $('drop-sub').textContent = i.hz < 59 || i.hz > 61
    ? `Recorded at ${i.hz.toFixed(2)} fps. The game's frame rate is measured against this; record at the console's refresh rate (60) for best results.`
    : 'Ready. Set any options on the left, then press Analyse.';
  $('pick2').textContent = 'Choose another video';
  if (!state.running) show('view-empty');
  updateRunButton();
}

async function pickVideo() {
  const p = await window.api.pickVideo();
  if (p) setVideo(p);
}

$('pick').addEventListener('click', pickVideo);
$('pick2').addEventListener('click', pickVideo);

$('out-change').addEventListener('click', async () => {
  const p = await window.api.pickFolder(state.outDir);
  if (p) {
    state.outDir = p;
    $('out-path').textContent = p;
    $('out-path').title = p;
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
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (f) setVideo(window.api.pathForFile(f));
});

$('opt-render').addEventListener('change', () => {
  $('video-opts').hidden = !$('opt-render').checked;
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
remember('opt-style', 'overlayStyle');

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
  const start = num('opt-start');
  const end = num('opt-end');
  if (start !== null && end !== null && end <= start) {
    $('opt-end').classList.add('invalid');
    throw new Error('End must be after start');
  }
  return {
    video: state.video,
    outDir: state.outDir,
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
    title: $('opt-title').value.trim() || null,
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
  updateRunButton();
  $('cancel').hidden = false;
  $('prog-name').textContent = state.video.split(/[\\/]/).pop();
  currentStep = null;
  resetSteps(opts.renderVideo);
  show('view-progress');

  const r = await window.api.startJob(opts);
  finishJob(r, opts, 'The analysis stopped');
});

$('render-again').addEventListener('click', async () => {
  if (!state.result || state.running) return;
  await state.gpuReady;
  const opts = renderOptions();
  state.running = true;
  updateRunButton();
  $('cancel').hidden = false;
  $('prog-name').textContent = state.result.video.split(/[\\/]/).pop();
  currentStep = null;
  resetSteps(true, true);
  show('view-progress');
  const r = await window.api.renderOnly(opts);
  finishJob(r, state.opts, 'Rendering stopped');
});

function finishJob(r, opts, errorTitle) {
  state.running = false;
  $('cancel').hidden = true;
  updateRunButton();
  if (r.ok) {
    state.result = r.result;
    state.opts = opts;
    renderResults(r.result, opts);
    show('view-results');
  } else if (r.cancelled) {
    show(state.result ? 'view-results' : 'view-empty');
  } else {
    $('error-title').textContent = errorTitle;
    $('error-text').textContent = r.error;
    show('view-error');
  }
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
  $('res-name').textContent = r.video.split(/[\\/]/).pop();
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
  $('t-range').textContent = `${s.min_1s_fps}–${s.max_1s_fps}`;
  setLevel($('t-range'), s.min_1s_fps, t);
  $('t-missed').textContent = s.frames_missing_target.toLocaleString();
  $('t-missed-sub').textContent = `${s.frames_missing_target_pct}% of frames stayed past ${t} fps`;
  $('t-longest').textContent = s.longest_frame_ms.toFixed(1);

  const warn = $('warnings');
  warn.replaceChildren();
  const addWarn = (text) => {
    const d = document.createElement('div');
    d.className = 'warn';
    d.textContent = text;
    warn.appendChild(d);
  };
  if (c.dropped_by_recorder) {
    addWarn(`The recording itself is missing ${c.dropped_by_recorder} refresh${c.dropped_by_recorder === 1 ? '' : 'es'} (OBS dropped frames). Results near those points are not reliable.`);
  }
  if (r.renderError) addWarn(`The overlay video was not made. ${r.renderError}`);
  if (c.refresh_hz < 59 || c.refresh_hz > 61) {
    addWarn(`Recorded at ${c.refresh_hz} fps. Match OBS to the console's refresh rate (usually 60) so every refresh is captured.`);
  }

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
  $('render-again').textContent = r.overlayVideo ? 'Render again' : 'Render video';
  drawChart();
}

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
  host.appendChild(svg);
}

new ResizeObserver(() => { if (!$('view-results').hidden) drawChart(); }).observe($('chart'));

checkTools();
