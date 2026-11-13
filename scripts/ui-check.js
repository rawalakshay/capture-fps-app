'use strict';
// Dev tool: drives the real Electron app over CDP, runs an analysis on a clip and screenshots every view at
// several window sizes, reporting overflow and runtime errors as JSON.
//   node scripts/ui-check.js <clip.mp4> <out-dir> [clip-b.mp4]
// The A / B states compare the clip with clip-b (default: the clip again); the copies analysed for them live in out-dir.
// The Edit & export states put the clip and those copies on three tracks, then drag, trim, split, undo and export.
// Safe to run several at once: each run has its own CDP port and Electron profile (out-dir/profile).
// Needs Node 22 (global WebSocket and fetch); no npm packages.

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const [srcClip, outDir, clipB = srcClip] = process.argv.slice(2);
if (!srcClip || !outDir) { console.error('usage: node scripts/ui-check.js <clip> <out-dir> [clip-b]'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
// Analyses and exports land next to the clip, so drive a copy inside out-dir and never write beside the original.
const clip = path.resolve(outDir, 'clip.mp4');
if (path.resolve(srcClip) !== clip) fs.copyFileSync(srcClip, clip);
const SIZES = [[980, 680], [1280, 800], [1440, 900], [1920, 1080]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Several checks may run at once: each gets a free CDP port and its own profile (localStorage, caches) under out-dir.
// shortcut: the port is freed before Electron binds it, so a race with another process is possible; the devtools check below catches it.
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer().once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
let PORT;
let electron;
let electronExit = null;
const stderr = [];
async function launch() {
  PORT = await freePort();
  const profile = path.resolve(outDir, 'profile');
  const q = (a) => (process.platform === 'win32' ? `"${a}"` : a); // shell: true on Windows joins args with spaces
  electron = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron', '.', `--remote-debugging-port=${PORT}`, q(`--user-data-dir=${profile}`)], { cwd: ROOT, stdio: 'pipe', shell: process.platform === 'win32' });
  electron.stderr.on('data', (d) => stderr.push(String(d)));
  electron.on('exit', (code) => { electronExit = code; });
}
const killAll = () => {
  try {
    if (process.platform === 'win32') execSync(`taskkill /PID ${electron.pid} /T /F`, { stdio: 'ignore' });
    else electron.kill('SIGKILL');
  } catch (_) { /* already gone */ }
};
process.on('exit', killAll);

async function pageTarget() {
  for (let i = 0; i < 120; i++) {
    if (electronExit !== null) throw new Error(`electron exited (code ${electronExit}) before devtools started on port ${PORT}:
${stderr.join('').slice(-1500)}`);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (_) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`devtools did not start on port ${PORT} within 30 s (another app on that port?):
${stderr.join('').slice(-1500)}`);
}

// ---- minimal CDP client (one per socket: the page, and the browser for window bounds) ----
const errors = [];
function connect(url) {
  const pending = new Map();
  const events = new Map(); // method -> [resolvers]
  let seq = 0;
  const ws = new WebSocket(url);
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(`exception: ${d.exception && d.exception.description || d.text} @${d.url || ''}:${d.lineNumber}`);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(`console.error: ${msg.params.args.map((a) => a.description || a.value).join(' ')}`);
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push(`log: ${msg.params.entry.text} ${msg.params.entry.url || ''}`);
    }
    for (const r of events.get(msg.method) || []) r(msg.params);
    events.delete(msg.method);
  };
  const send = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { method, resolve, reject }));
  };
  const once = (method) => new Promise((r) => events.set(method, [...(events.get(method) || []), r]));
  return new Promise((resolve, reject) => { ws.onopen = () => resolve({ send, once }); ws.onerror = reject; });
}
let page;
const send = (m, p) => page.send(m, p);
const once = (m) => page.once(m);
async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text}
${expression.slice(0, 120)}`);
  return r.result.value;
}
async function waitFor(expression, ms = 360000, every = 500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evalJs(expression)) return true;
    await sleep(every);
  }
  throw new Error(`timeout waiting for ${expression}`);
}

// Runs in the page: overflow findings for the visible view.
const OVERFLOW_JS = `(() => {
  const vis = (e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed';
  const ref = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.classList.length ? '.' + [...e.classList].join('.') : '');
  const txt = (e) => (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
  const out = { docWide: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    bodyTall: document.body.scrollHeight > innerHeight + 1, offscreen: [], spillX: [], spillY: [], clipped: [] };
  const inScroller = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowY; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true; } return false; };
  for (const e of document.querySelectorAll('body *')) {
    if (e.closest('svg') || !vis(e)) continue;
    const r = e.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    // What a box that clips cuts off (a cropped video in its pane) is not on screen.
    let L = r.left, R = r.right;
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible') { const pr = p.getBoundingClientRect(); L = Math.max(L, pr.left); R = Math.min(R, pr.right); }
    if (R > L && (R > innerWidth + 1 || L < -1)) out.offscreen.push(ref(e) + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
    const cs = getComputedStyle(e);
    if (e.tagName !== 'SVG' && e.scrollWidth > e.clientWidth + 1 && cs.overflowX === 'visible' && cs.textOverflow !== 'ellipsis') out.spillX.push(ref(e) + ' ' + e.clientWidth + '<' + e.scrollWidth + ' "' + txt(e) + '"');
    if (e.scrollHeight > e.clientHeight + 1 && cs.overflowY === 'visible' && !inScroller(e)) out.spillY.push(ref(e) + ' ' + e.clientHeight + '<' + e.scrollHeight + ' "' + txt(e) + '"');
    // A table cell cut off by a box that clips or scrolls sideways: what spillX cannot see.
    if (e.tagName === 'TD' || e.tagName === 'TH') {
      for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
        if (getComputedStyle(p).overflowX === 'visible') continue;
        const pr = p.getBoundingClientRect();
        if (r.right > pr.right + 1 || r.left < pr.left - 1) out.clipped.push(ref(e) + ' ' + Math.round(r.left) + '..' + Math.round(r.right) + ' in ' + ref(p) + ' ' + Math.round(pr.left) + '..' + Math.round(pr.right) + ' "' + txt(e) + '"');
        break;
      }
    }
  }
  return out;
})()`;

const CLICK_CARD = `document.querySelector('#lib-grid .card-main[title$="clip.mp4"]').click()`;
const report = { shots: [], overflow: {}, topbar: {}, errors, steps: [] };
async function shotAllSizes(view) {
  for (const [w, h] of SIZES) {
    // Electron's CDP has no Browser.getWindowForTarget, so the viewport is emulated instead of resizing the window.
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    // The bottom of #main moves with the viewport: scroll there again at each size.
    if (view.endsWith('-bottom')) await evalJs('document.getElementById("main").scrollTop = 99999');
    await sleep(400);
    const file = path.join(outDir, `${view}-${w}x${h}.png`);
    const png = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
    fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
    report.shots.push(file);
    report.overflow[`${view}-${w}x${h}`] = await evalJs(OVERFLOW_JS);
    // Round-2 regression: the topbar action group must stay on one row and the topbar on at most two.
    if (view.startsWith('work')) report.topbar[`${view}-${w}x${h}`] = await evalJs(TOPBAR_JS);
    // The A / B tables must fit their panels: a cut-off Better column passed a green run once.
    if (view.startsWith('ab')) {
      const fit = await evalJs(`[...document.querySelectorAll('#ab-mode .ab-scroll')].filter((e) => e.offsetParent && e.scrollWidth > e.clientWidth + 1).map((e) => e.closest('section').getAttribute('aria-label') + ' ' + e.clientWidth + '<' + e.scrollWidth)`);
      if (fit.length) unfit.push(`${view}-${w}x${h}: ${fit.join(', ')}`);
    }
  }
  if (unfit.length) throw new Error(`tables wider than their panels: ${unfit.splice(0).join('; ')}`);
}
const unfit = [];
/** The view at every size, then scrolled to the bottom of #main at every size. */
async function shotTopAndBottom(view) {
  await shotAllSizes(view);
  await evalJs('document.getElementById("main").scrollTop = 99999');
  await sleep(200);
  await shotAllSizes(`${view}-bottom`);
  await evalJs('document.getElementById("main").scrollTop = 0');
}
const TOPBAR_JS = `(() => {
  const rows = (els) => new Set([...els].filter((e) => e.offsetParent !== null).map((e) => Math.round(e.getBoundingClientRect().top))).size;
  return { actionRows: rows(document.querySelectorAll('#view-work .btn-row-end > *')), topbarRows: rows(document.querySelectorAll('#view-work .topbar > *')), topbarH: Math.round(document.querySelector('#view-work .topbar').getBoundingClientRect().height) };
})()`;
// A 3x crop of one element, for looking at small text.
async function zoomShot(name, selector) {
  const r = await evalJs(`JSON.stringify(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect())`);
  const { x, y, width, height } = JSON.parse(r);
  const png = await send('Page.captureScreenshot', { format: 'png', clip: { x, y, width, height, scale: 3 } });
  const file = path.join(outDir, `zoom-${name}.png`);
  fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
  report.shots.push(file);
}
async function step(name, fn) {
  try { await fn(); report.steps.push(`${name}: ok`); } catch (e) { report.steps.push(`${name}: FAILED ${e.message}`); }
}

(async () => {
  await launch();
  const target = await pageTarget();
  page = await connect(target.webSocketDebuggerUrl);
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  const clipJs = JSON.stringify(clip.replace(/\//g, '\\'));

  // Fresh start: no library, no remembered options.
  await evalJs('localStorage.clear()');
  const loaded = once('Page.loadEventFired');
  await send('Page.reload');
  await loaded;
  await sleep(800);
  await waitFor('state.toolsOk', 20000);
  await step('library-empty', () => shotAllSizes('library-empty'));
  report.version = await evalJs('(() => { const v = document.getElementById("version-main"), m = document.getElementById("main").getBoundingClientRect(), r = v.getBoundingClientRect(); return JSON.stringify({ text: v.textContent, inMain: !!v.closest("#main"), overlapsMain: r.right > m.left && r.width > 0, rect: [r.left, r.top, r.width, r.height].map(Math.round) }); })()');

  await step('add clip', async () => {
    await evalJs(`addVideos([${clipJs}])`);
    await waitFor('state.queue.length === 1 && state.current && !document.getElementById("view-work").hidden', 30000);
    await evalJs('document.getElementById("opt-render").checked = true; document.getElementById("opt-render").dispatchEvent(new Event("change"))');
    await shotAllSizes('work-pending');
  });

  await step('run', async () => {
    await evalJs('document.getElementById("run").click()');
    await waitFor('state.running', 10000, 100);
    await sleep(1500);
    // Round-1 fixes: .step-pct must hold only the percentage; the version label must live in the rail, not over #main.
    report.measuring = await evalJs('JSON.stringify({ stepPct: [...document.querySelectorAll(".step-pct")].map(e => e.textContent), verdictTitle: document.getElementById("verdict-title").textContent, queueText: document.getElementById("queue-text").textContent })');
    await shotAllSizes('work-measuring');
    await waitFor('!state.running && state.result', 360000);
    // The preview is scheduled 600 ms after the run and takes a moment to render: wait for it rather than guess.
    await waitFor('!document.getElementById("preview-img").hidden && document.getElementById("preview-img").naturalWidth > 0', 60000, 200).catch(() => {});
    report.result = await evalJs('JSON.stringify({ status: state.current.status, error: state.current.error, overlayVideo: state.result && state.result.overlayVideo, avg: state.result && state.result.summary.avg_fps, hasImg: !document.getElementById("preview-img").hidden && !!document.getElementById("preview-img").naturalWidth, view: VIEWS.find(v => !document.getElementById(v).hidden) })');
    await shotAllSizes('work-result');
  });

  await step('preview', async () => {
    await evalJs('document.getElementById("scrub").value = 3; document.getElementById("scrub").dispatchEvent(new Event("input"))');
    await evalJs('runPreview()');
    await waitFor('!state.running', 60000);
    await sleep(500);
    report.preview = await evalJs('JSON.stringify({ at: state.previewAt, hasImg: !document.getElementById("preview-img").hidden && !!document.getElementById("preview-img").naturalWidth, warnings: document.getElementById("warnings").textContent })');
    await shotAllSizes('work-preview');
  });

  await step('range', async () => {
    await evalJs('setRange(2, 8)');
    await sleep(300);
    await shotAllSizes('work-range');
    await evalJs('document.getElementById("range-clear").click()');
  });

  await step('library-card', async () => {
    await evalJs('document.getElementById("back").click()');
    await sleep(300);
    report.library = await evalJs('JSON.stringify({ cards: document.querySelectorAll("#lib-grid .card").length, thumbs: document.querySelectorAll("#lib-grid .card img").length, libCount: document.getElementById("lib-count").textContent })');
    await shotAllSizes('library-card');
    await zoomShot('card', '#lib-grid .card');
  });

  await step('reopen card', async () => {
    await evalJs(CLICK_CARD);
    await waitFor('!document.getElementById("view-work").hidden', 10000, 100);
    // The preview drawn (or not to be drawn: an older analysis), and the app idle again: not a shot of it half-way.
    await waitFor('!state.running && (document.getElementById("preview-empty").hidden ? document.getElementById("preview-img").complete : document.getElementById("preview-empty").textContent !== "Drawing the preview…")', 60000, 200);
    await sleep(300);
    await shotAllSizes('work-reopened');
  });

  await step('compare', async () => {
    await evalJs('document.getElementById("nav-compare").click()');
    await sleep(600);
    await shotAllSizes('ab-one'); // A / B with one analysed recording: B still to choose
    report.abOne = JSON.parse(await evalJs('JSON.stringify({ exportDisabled: document.getElementById("ab-export-open").getAttribute("aria-disabled"), swapDisabled: document.getElementById("ab-swap").disabled })'));
    await evalJs('document.getElementById("mode-stack").click()');
    await sleep(400);
    report.compare = await evalJs('JSON.stringify({ rows: document.querySelectorAll("#compare-list > *").length, chartKids: document.getElementById("compare-chart").childElementCount })');
    await shotAllSizes('compare');
  });

  await step('error', async () => {
    await evalJs(`showError('The analysis stopped', 'ffmpeg exited with code 1\\n[libx264 @ 000001] Error while opening encoder for output stream #0:0 - maybe incorrect parameters such as bit_rate, rate, width or height\\nConversion failed!')`);
    await sleep(300);
    await shotAllSizes('error');
    await evalJs('document.getElementById("error-back").click()');
  });

  await step('failed probe card', async () => {
    await evalJs(`addVideos(['C:\\\\nope\\\\missing.mkv'])`);
    await sleep(1500);
    await evalJs('document.getElementById("nav-library").click()');
    await sleep(300);
    report.failedCard = await evalJs('JSON.stringify({ cards: document.querySelectorAll("#lib-grid .card").length, retry: document.querySelectorAll("#lib-grid .card-st button").length, view: VIEWS.find(v => !document.getElementById(v).hidden) })');
    await shotAllSizes('library-failed');
  });

  await step('compare-two', async () => {
    await evalJs('document.getElementById("nav-compare").click(); document.getElementById("mode-stack").click()');
    await evalJs('compare.inputs.push({ file: compare.inputs[0].file, offset: "0:01", label: "clip B long label name" }); renderCompareList(); drawCompareChart()');
    await sleep(400);
    await shotAllSizes('compare-two');
    await zoomShot('compare-col', '#compare-list > *');
    await evalJs('compare.inputs.pop(); renderCompareList()');
  });

  // A / B: a second recording (and a third measured against 30 fps) analysed into out-dir, never next to the originals.
  const analyseCopy = async (src, name, target) => {
    const dst = path.join(outDir, name);
    fs.copyFileSync(src, dst);
    const js = JSON.stringify(dst);
    await evalJs(`addVideos([${js}], { open: false })`);
    await waitFor(`state.queue.some((q) => q.path === ${js})`, 30000, 200);
    await evalJs(`openItem(state.queue.find((q) => q.path === ${js})); document.getElementById("opt-render").checked = false; document.getElementById("opt-render").dispatchEvent(new Event("change")); document.getElementById("opt-target").value = ${JSON.stringify(target)}`);
    // The previous run's preview (scheduled 600 ms after it) holds state.running and would swallow the click.
    await sleep(800);
    await waitFor('!state.running', 60000, 100);
    await evalJs('clearTimeout(previewTimer); document.getElementById("run").click()');
    await waitFor(`state.runningItem && state.runningItem.path === ${js}`, 10000, 100);
    await waitFor(`!state.running && state.queue.find((q) => q.path === ${js}).result`, 360000);
    await evalJs('document.getElementById("opt-target").value = ""; document.getElementById("opt-render").checked = true; document.getElementById("opt-render").dispatchEvent(new Event("change"))');
  };
  const AB_STATE = `JSON.stringify({ ready: abReady(), a: ab.a && ab.a.q.name, b: ab.b && ab.b.q.name, offset: ab.offset, u: ab.u, view: radioValue("ab-view"),
    sentence: document.getElementById("ab-sentence").textContent, chips: document.getElementById("ab-chips").textContent, lead: document.getElementById("ab-lead").textContent,
    numbers: [...document.getElementById("ab-numbers").rows].map((r) => [...r.cells].map((c) => c.innerText.replace(/\\s+/g, " ").trim()).join(" | ")),
    hitchRows: document.querySelectorAll("#ab-hitches tr").length, traces: document.querySelectorAll("#ab-svg polyline").length, yLabels: document.getElementById("ab-y").textContent,
    live: ["a", "b"].map((k) => { const e = document.getElementById("ab-live-" + k); return e.hidden ? "" : e.textContent; }), playable: ["a", "b"].map((k) => ab[k] && ab[k].playable),
    videoWidth: ["a", "b"].map((k) => document.getElementById("ab-video-" + k).videoWidth), status: document.getElementById("compare-status").textContent })`;
  await step('ab analyse', async () => {
    await analyseCopy(clipB, 'abB.mp4', '');
    await analyseCopy(clipB, 'abC.mp4', '30');
  });

  await step('ab', async () => {
    await evalJs('document.getElementById("nav-compare").click(); document.getElementById("mode-ab").click()');
    await waitFor('abReady()', 20000, 200);
    await evalJs('setOffset(0.5); seekAB(1)');
    await sleep(1500); // the videos load their first frame
    report.ab = JSON.parse(await evalJs(AB_STATE));
    if (report.ab.live.some((s) => !s)) throw new Error(`a pane has no live pill: ${JSON.stringify(report.ab.live)}`);
    await shotTopAndBottom('ab');
  });

  await step('ab play', async () => {
    await send('Page.bringToFront'); // a covered window gets no animation frames, only the 4-a-second fallback
    await sleep(300);
    await evalJs('seekAB(0); document.getElementById("ab-playbtn").click()');
    // Sampled twice: right after the start, and once the follower has had time to settle.
    const sample = 'JSON.stringify({ playing: ab.playing, u: ab.u, a: document.getElementById("ab-video-a").currentTime, b: document.getElementById("ab-video-b").currentTime, offset: ab.offset, stepAgeMs: Math.round(performance.now() - (ab.lastStep || 0)), now: document.getElementById("ab-now").textContent, pills: ["a", "b"].map((k) => !document.getElementById("ab-live-" + k).hidden) })';
    // A playing pane always shows a pill, and B stays on its offset (within two 60 Hz frames): by the median of the
    // samples and once settled, as one sample can catch a moment's lag on a loaded machine.
    const check = (s) => {
      if (!s.playing || s.pills.includes(false)) throw new Error(`playing ${s.playing}, pills ${s.pills} at u=${s.u}`);
    };
    const off = (s) => Math.abs(s.b - s.a - s.offset);
    const samples = [];
    for (let i = 0; i < 6; i++) { await sleep(250); samples.push(JSON.parse(await evalJs(sample))); }
    report.abPlay = samples[5];
    report.abPlay.drift = samples.map((s) => Number((s.b - s.a - s.offset).toFixed(3)));
    await sleep(1500);
    // Settled is a median too: each video's currentTime is refreshed on its own schedule, so a single read of the
    // pair can be a frame apart while playback is in step (one run read 39 ms between -7 ms samples).
    const settled = [];
    for (let i = 0; i < 7; i++) { if (i) await sleep(100); settled.push(JSON.parse(await evalJs(sample))); }
    report.abPlay.later = settled[6];
    report.abPlay.settledDrift = settled.map((s) => Number((s.b - s.a - s.offset).toFixed(3)));
    samples.forEach(check);
    settled.forEach(check);
    const median = (xs) => xs.map(off).sort((x, y) => x - y)[xs.length >> 1];
    const med = median(samples), late = median(settled);
    if (med > 0.034 || late > 0.034) throw new Error(`B is off its ${report.abPlay.offset} s offset by ${med.toFixed(3)} s (median), ${late.toFixed(3)} s settled (median)`);
    // The shared clock must move with the videos, or the playhead, readout and pills froze while they played.
    const l = report.abPlay.later;
    if (Math.abs(l.u - l.a) > 0.3 || l.u < report.abPlay.u + 1 || l.now === report.abPlay.now) throw new Error(`clock stuck: u ${report.abPlay.u} → ${l.u}, A at ${l.a}, readout ${l.now}`);
    await evalJs('pauseAB()');
  });

  await step('ab-export', async () => {
    await evalJs('document.getElementById("ab-export-menu").open = true');
    await sleep(200);
    await evalJs('document.getElementById("abx-frame-219").click(); document.getElementById("abx-fit-crop").click(); document.getElementById("abx-size-2160").click()');
    await sleep(200);
    report.abExport = JSON.parse(await evalJs('JSON.stringify({ sum: document.getElementById("abx-sum").textContent, time: document.getElementById("abx-time").hidden ? "" : document.getElementById("abx-time").textContent, hevc: !document.getElementById("abx-hevc").hidden, belowDisabled: document.getElementById("abx-fit-below").disabled })'));
    await shotAllSizes('ab-export');
    await evalJs('document.getElementById("abx-cancel").click()');
  });

  // The sample clips have no hitches: lay a few on the window's copy of the data (never the files) to see the
  // lanes, the HITCH badges and the paired table. B's 1.05 s sits 0.5 s ahead, so it pairs with A's 0.6 s.
  await step('ab-hitches', async () => {
    await evalJs('window.__hitches = [ab.a.data.hitches, ab.b.data.hitches]; ab.a.data.hitches = [[0.6, 50], [2.2, 66.7]]; ab.b.data.hitches = [[1.05, 50], [3.0, 83.3]]; renderAB(); seekAB(0.6)');
    await sleep(800);
    report.abHitches = JSON.parse(await evalJs('JSON.stringify({ rows: [...document.querySelectorAll("#ab-hitches tr")].map((r) => r.innerText.replace(/\\s+/g, " ") + (r.classList.contains("on") ? " [on]" : "")), badges: ["a", "b"].map((k) => document.getElementById("ab-hitch-" + k).hidden ? "" : document.getElementById("ab-hitch-" + k).textContent), lanes: ["a", "b"].map((k) => document.querySelectorAll("#ab-lane-" + k + " i").length) })'));
    await shotTopAndBottom('ab-hitches');
    await evalJs('document.getElementById("ab-next-hitch").click()');
    report.abHitches.next = await evalJs('ab.u');
    await evalJs('[ab.a.data.hitches, ab.b.data.hitches] = window.__hitches; renderAB(); seekAB(1)');
  });

  // The export itself, small and fast (16:9 letterbox 1080p), into A's output folder; then the IPC edges.
  await step('ab export run', async () => {
    await evalJs('document.getElementById("ab-export-menu").open = true');
    await evalJs('compare.out = null; document.getElementById("abx-frame-169").click(); document.getElementById("abx-fit-letterbox").click(); document.getElementById("abx-size-1080").click(); document.getElementById("abx-go").click()');
    await waitFor('state.running', 10000, 100);
    await waitFor('!state.running', 360000);
    report.abExportRun = JSON.parse(await evalJs('JSON.stringify({ status: document.getElementById("compare-status").textContent, out: compare.out, play: !document.getElementById("compare-play").hidden })'));
    if (!/_ab/.test(report.abExportRun.out || '') || !fs.existsSync(report.abExportRun.out)) throw new Error(`no export: ${report.abExportRun.status}`);
    report.abIpc = JSON.parse(await evalJs(`(async () => {
      const f = await window.api.frameAt(ab.a.q.path, 1);
      const bad = await window.api.abData("C:\\\\nope");
      const notVideo = await window.api.frameAt("C:\\\\Windows\\\\win.ini", 0);
      const unread = await window.api.compareAB({ inputs: [{ video: ab.a.q.path, outDir: "C:\\\\Windows" }, { video: ab.b.q.path, outDir: ab.b.q.result.outDir }] });
      return JSON.stringify({ frameAt: f.ok && f.jpeg.length, badFolder: bad, notVideo, unread });
    })()`));
    // Each guard's own message: the bad inputs would also fail later without the guard.
    const abWant = { notVideo: (e) => e === 'Not a video file', unread: (e) => e === 'Choose two analysed recordings first.' };
    for (const k in abWant) if (!abWant[k](report.abIpc[k].error)) throw new Error(`ab ${k} not refused by its guard: ${report.abIpc[k].error}`);
    if (!report.abIpc.frameAt) throw new Error('frameAt refused a video this session analysed');
  });

  await step('ab-light', async () => {
    await evalJs('document.getElementById("theme").value = "light"; document.getElementById("theme").dispatchEvent(new Event("change"))');
    await sleep(300);
    await shotTopAndBottom('ab-light');
    await evalJs('document.getElementById("theme").value = "dark"; document.getElementById("theme").dispatchEvent(new Event("change"))');
  });

  await step('ab-frametime', async () => {
    await evalJs('document.getElementById("ab-view-ft").click()');
    await sleep(300);
    report.abFrameTime = JSON.parse(await evalJs(AB_STATE));
    await shotTopAndBottom('ab-frametime');
  });

  await step('ab-mixed', async () => {
    await evalJs(`setSide("b", state.queue.find((q) => q.path === ${JSON.stringify(path.join(outDir, 'abC.mp4'))}))`);
    await sleep(1500);
    report.abMixed = JSON.parse(await evalJs(AB_STATE));
    await shotTopAndBottom('ab-mixed');
  });

  // ---- Edit & export: three tracks of the recordings analysed above, laid out on one timeline ----
  const ED_STATE = `JSON.stringify({ tracks: ed.p.tracks.map((t) => t.clips.map((c) => [c.at, c.in, c.out, c.pan].map((v) => Math.round(v * 1000) / 1000))),
    sel: ed.sel, range: edRange(), fit: ed.p.fit, frame: ed.p.frame, error: ed.error, data: !!ed.data, boxes: !!ed.boxes, t: ed.t,
    layout: document.getElementById("ed-layout-sum").textContent, desc: document.getElementById("ed-desc").textContent,
    live: [...document.querySelectorAll("#ed-board .pv-live b")].map((b) => b.textContent), none: [...document.querySelectorAll("#ed-board .pv-none")].map((n) => !n.hidden),
    stats: [...document.querySelectorAll("#ed-board .pv-stats")].map((n) => n.hidden ? "" : n.innerText), gaps: document.querySelectorAll("#ed-inner .ed-gap").length,
    chip: (document.querySelector("#pv-sel span") || {}).textContent || "", status: document.getElementById("compare-status").textContent })`;
  const edState = async () => JSON.parse(await evalJs(ED_STATE));
  // A real mouse drag (pointer events come from these), from x0,y to x1,y in window px.
  const mouseDrag = async (x0, y, x1) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 5; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / 5, y, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(300);
  };
  const key = async (k, modifiers = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text: modifiers ? undefined : k, modifiers, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, modifiers, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
    await sleep(300);
  };
  const rectOf = async (sel) => JSON.parse(await evalJs(`JSON.stringify(document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect())`));
  const edWait = () => waitFor('ed.data && !ed.error', 20000, 200);

  await step('edit-empty', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await evalJs('localStorage.removeItem("editProject"); document.getElementById("nav-compare").click(); document.getElementById("mode-edit").click()');
    await sleep(800);
    report.editEmpty = await edState();
    await shotAllSizes('edit-empty');
  });

  await step('edit', async () => {
    await evalJs(`(async () => {
      const find = (n) => abCandidates().find((c) => c.path.endsWith(n));
      document.getElementById("ed-add-c").click();
      await edAdd(find("clip.mp4"), 0); await edAdd(find("clip.mp4"), 0);
      await edAdd(find("abB.mp4"), 1);
      await edAdd(find("abC.mp4"), 2); edSetTiming("out", edSelClip().in + 3);
      await edAdd(find("abC.mp4"), 2, 5);
      edCropLive((c) => { c.pan = -0.12; }); edCropDone();
      edSeek(6);
    })()`);
    await edWait();
    await sleep(1500); // the videos load their frames
    report.edit = await edState();
    const e = report.edit;
    if (e.tracks.map((t) => t.length).join() !== '2,1,2' || !e.gaps || e.sel.ti !== 2 || e.sel.ci !== 1) throw new Error(`not the project asked for: ${JSON.stringify(e)}`);
    if (e.live.length !== 3 || !e.chip.startsWith('C2')) throw new Error(`monitor: ${JSON.stringify(e.live)} chip "${e.chip}"`);
    await shotTopAndBottom('edit');
    await evalJs('edSeek(4)'); // in C's gap: NO VIDEO
    await sleep(500);
    report.editGap = await edState();
    // As the export: no live number, the stats box names the gap and its length.
    if (!report.editGap.none[2] || report.editGap.live[2] !== '' || !/^NO VIDEO · \d+\.\d s · not counted$/.test(report.editGap.stats[2])) {
      throw new Error(`the gap shows ${JSON.stringify([report.editGap.live, report.editGap.stats])}`);
    }
    await evalJs('edSeek(6)');
  });

  await step('edit-tracks', async () => {
    await evalJs('document.getElementById("ed-tab-tracks").click()');
    await sleep(300);
    report.editTracks = await evalJs('document.getElementById("ed-body-tracks").innerText.replace(/\\s+/g, " ")');
    await shotAllSizes('edit-tracks');
    // Tab out of an edited field: the edit's own re-render must not rebuild the fields and drop the focus.
    await evalJs('document.getElementById("ed-k-A-title").focus()');
    await send('Input.insertText', { text: 'Hello' });
    for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await sleep(300);
    const tabbed = await evalJs('JSON.stringify([document.activeElement.id, ed.p.tracks[0].title])');
    await evalJs('document.activeElement.blur(); edUndo(-1)');
    if (tabbed !== '["ed-k-A-subtitle","Hello"]') throw new Error(`Tab from the title field: ${tabbed}`);
    await evalJs('document.getElementById("ed-tab-clip").click()');
  });

  await step('edit-layout-menu', async () => {
    await evalJs('document.getElementById("ed-layout-menu").open = true');
    await sleep(300);
    report.editLayout = await evalJs('JSON.stringify({ fits: [...document.querySelectorAll("#edx-fits label")].map((l) => l.textContent), sizes: [...document.querySelectorAll("#edx-sizes label")].map((l) => l.textContent), frame169: document.getElementById("edx-frame-169").disabled, sum: document.getElementById("edx-sum").textContent })');
    await shotAllSizes('edit-layout-menu');
    await evalJs('document.getElementById("ed-layout-menu").open = false');
  });

  await step('edit-track-menu', async () => {
    // The tag opens the track's menu (Remove track); open, it carries the caret that hover and focus show.
    await evalJs('document.getElementById("main").scrollTop = 99999; document.querySelector("#ed-heads .ed-th-menu").open = true');
    await sleep(300);
    await zoomShot('edit-track-menu', '#ed-heads');
    report.editTrackMenu = await evalJs('JSON.stringify([...document.querySelectorAll("#ed-heads .ed-th-menu")[0].querySelectorAll(".menu-list button")].map((b) => [b.textContent, b.disabled]))');
    await evalJs('document.querySelector("#ed-heads .ed-th-menu").open = false; document.getElementById("main").scrollTop = 0');
  });

  await step('edit-exact', async () => {
    // Inside the export range (with a short clip-b it ends before 0:06): outside it there is no exact frame.
    await evalJs('if (ed.t >= edRange().out) edSeek(edRange().out - 0.5); document.getElementById("ed-exact").click()');
    await waitFor('!document.getElementById("ed-exact-img").hidden && document.getElementById("ed-exact-img").naturalWidth > 0', 60000, 300);
    report.editExact = JSON.parse(await evalJs('JSON.stringify({ w: document.getElementById("ed-exact-img").naturalWidth, h: document.getElementById("ed-exact-img").naturalHeight, badge: document.getElementById("ed-exact-badge").textContent })'));
    await shotAllSizes('edit-exact');
    await evalJs('document.getElementById("ed-live").click()');
  });

  await step('edit-light', async () => {
    await evalJs('document.getElementById("theme").value = "light"; document.getElementById("theme").dispatchEvent(new Event("change"))');
    await sleep(300);
    await shotTopAndBottom('edit-light');
    await evalJs('document.getElementById("theme").value = "dark"; document.getElementById("theme").dispatchEvent(new Event("change"))');
  });

  await step('edit play', async () => {
    await send('Page.bringToFront');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    // From the range's start, for as long as the range allows (clip-b may be as short as the clip).
    const range = JSON.parse(await evalJs('edPause(); edSeek(edRange().in); JSON.stringify(edRange())'));
    const need = Math.min(4, range.out - range.in - 0.6);
    await evalJs('document.getElementById("ed-play").click()');
    // Every track showing a clip plays its source at the shared clock (within two 60 Hz frames), across A1 -> A2 and C's gap.
    // Read against the live clock: ed.t only moves ~4 times a second while the window is covered.
    const sample = `JSON.stringify({ playing: ed.playing, t: ed.t, drift: ed.p.tracks.map((tr, ti) => { const now = (performance.now() - ed.clock) / 1000, c = ed.cur[ti], v = ed.videos[ti]; return c && v && !v.seeking && v.readyState >= 2 ? Math.round((v.currentTime - (c.in + now - c.at)) * 1000) / 1000 : null; }) })`;
    const samples = [];
    for (let i = 0; i < 16; i++) { await sleep(400); samples.push(JSON.parse(await evalJs(sample))); }
    report.editPlay = samples;
    await evalJs('edPause()');
    const moved = Math.max(...samples.map((s) => s.t)) - samples[0].t;
    if (moved < need) throw new Error(`the clock did not move: ${samples[0].t} -> ${samples[samples.length - 1].t}, not ${need.toFixed(1)} s`);
    // A clip switch (A1 -> A2, C's gap -> C2) may jolt a track for a moment; it must settle, and mostly be in sync.
    const play = samples.filter((s) => s.playing); // stopped at the range's end, a paused video has no drift to speak of
    const all = play.slice(3).flatMap((s) => s.drift.filter((d) => d !== null)).map(Math.abs).sort((x, y) => x - y);
    const last = play.slice(-3).flatMap((s) => s.drift.filter((d) => d !== null));
    if (all[Math.floor(all.length / 2)] > 0.034 || last.some((d) => Math.abs(d) > 0.034)) throw new Error(`tracks out of sync: ${JSON.stringify(samples.map((s) => s.drift))}`);
  });

  await step('edit drag, trim, split, undo', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await evalJs('edPause(); document.getElementById("ed-fit").click(); document.getElementById("main").scrollTop = 99999');
    await sleep(300);
    const before = await edState();
    let r = await rectOf('#ed-inner .ed-clipb[data-ti="0"][data-ci="1"]');
    await mouseDrag(r.x + r.width / 2, r.y + r.height / 2, r.x + r.width / 2 + 40);
    const moved = await edState();
    if (!(moved.tracks[0][1][0] > before.tracks[0][1][0] + 0.2)) throw new Error(`A2 did not move: ${before.tracks[0][1][0]} -> ${moved.tracks[0][1][0]}`);
    r = await rectOf('#ed-inner .ed-clipb[data-ti="0"][data-ci="1"]');
    await mouseDrag(r.x + r.width - 3, r.y + r.height / 2, r.x + r.width - 33);
    const trimmed = await edState();
    if (!(trimmed.tracks[0][1][2] < moved.tracks[0][1][2] - 0.2)) throw new Error(`A2's Out did not move: ${moved.tracks[0][1][2]} -> ${trimmed.tracks[0][1][2]}`);
    r = await rectOf('#ed-inner .ed-clipb[data-ti="1"][data-ci="0"]');
    await mouseDrag(r.x + r.width / 2, r.y + r.height / 2, r.x + r.width / 2); // a click selects B1
    await evalJs('edSeek(2); document.activeElement && document.activeElement.blur()');
    await key('s');
    const split = await edState();
    if (split.tracks[1].length !== 2) throw new Error(`S did not split B1: ${JSON.stringify(split.tracks[1])}`);
    await key('z', 2); // Ctrl+Z
    const undone = await edState();
    if (undone.tracks[1].length !== 1) throw new Error(`Ctrl+Z did not undo the split: ${JSON.stringify(undone.tracks[1])}`);
    if (JSON.stringify(undone.sel) !== '{"ti":1,"ci":0}') throw new Error(`undoing the split did not reselect B1: ${JSON.stringify(undone.sel)}`);
    await key('z', 2 | 8); // Ctrl+Shift+Z
    const redone = await edState();
    await key('z', 2);
    report.editSteps = { before: before.tracks, moved: moved.tracks[0], trimmed: trimmed.tracks[0], split: split.tracks[1], undone: undone.tracks[1], redone: redone.tracks[1] };
    if (redone.tracks[1].length !== 2) throw new Error('Ctrl+Shift+Z did not redo the split');
    const keptSel = await evalJs('edSelect(0, 1); edCommit(() => { ed.p.tracks[0].clips[1].at += 1; }); edUndo(-1); JSON.stringify(ed.sel)');
    if (keptSel !== '{"ti":0,"ci":1}') throw new Error(`undoing a move of A2 dropped its selection: ${keptSel}`);
    await evalJs('edSelect(1, 0)');
    await shotAllSizes('edit-edited');
  });

  await step('edit export', async () => {
    await evalJs('edCommit(() => { ed.p.range = { in: 0, out: 1.5 }; })');
    await edWait();
    await evalJs('compare.out = null; document.getElementById("ed-export").click()');
    await waitFor('state.running', 10000, 100);
    await waitFor('!state.running', 360000);
    report.editExport = JSON.parse(await evalJs('JSON.stringify({ status: document.getElementById("compare-status").textContent, out: compare.out, play: !document.getElementById("compare-play").hidden })'));
    if (!/_timeline_/.test(report.editExport.out || '') || !fs.existsSync(report.editExport.out)) throw new Error(`no export: ${report.editExport.status}`);
    report.editExport.bytes = fs.statSync(report.editExport.out).size;
    report.editIpc = JSON.parse(await evalJs(`(async () => {
      const p = edProject();
      const unread = await window.api.projectData({ ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, outDir: "C:\\\\Windows" })) })) });
      const notVideo = await window.api.timelineFrame({ ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, video: "C:\\\\Windows\\\\win.ini" })) })) }, 0);
      return JSON.stringify({ unread, notVideo });
    })()`));
    const edWant = { unread: (e) => (e || '').startsWith('A clip comes from a folder'), notVideo: (e) => /is not a video this session has opened/.test(e || '') };
    for (const k in edWant) if (!edWant[k](report.editIpc[k].error)) throw new Error(`edit ${k} not refused by its guard: ${report.editIpc[k].error}`);
  });

  await step('inspector-open', async () => {
    await evalJs(CLICK_CARD);
    await sleep(300);
    await evalJs('for (const id of ["sec-measure", "sec-overlay", "sec-export"]) document.getElementById(id).open = true; document.getElementById("opt-watermark-on").checked = true; document.getElementById("opt-watermark-on").dispatchEvent(new Event("change")); document.getElementById("opt-caption").value = "Quality mode"; document.getElementById("opt-caption").dispatchEvent(new Event("input"))');
    await sleep(300);
    report.inspector = await evalJs('JSON.stringify({ scrolls: getComputedStyle(document.getElementById("inspector")).overflowY, paneScroll: [...document.querySelectorAll("#inspector, #inspector *")].filter(e => e.scrollHeight > e.clientHeight + 1).map(e => e.tagName + "#" + e.id + "." + e.className + " " + getComputedStyle(e).overflowY).slice(0, 6) })');
    await shotAllSizes('work-inspector');
    await evalJs('document.getElementById("inspector").scrollTop = 99999');
    await sleep(200);
    await shotAllSizes('work-inspector-bottom');
    await evalJs('document.getElementById("inspector").scrollTop = 0; document.getElementById("style-bands").click(); document.getElementById("frame-219").click()');
    await sleep(300);
    report.bands = await evalJs('JSON.stringify({ frameRow: !document.getElementById("row-frame").hidden, sizes: [...document.getElementById("opt-res").options].map(o => o.text), summary: document.getElementById("sum-export").textContent })');
    await shotAllSizes('work-bands');
    await evalJs('document.getElementById("frame-169").click(); document.getElementById("style-panel").click()');
  });

  // A card from an earlier session: reload, then open it through probe + loadResult against the real folder.
  await step('restored card', async () => {
    const loaded = once('Page.loadEventFired');
    await send('Page.reload');
    await loaded;
    await sleep(800);
    await waitFor('state.toolsOk', 20000);
    await evalJs(CLICK_CARD);
    await waitFor('!document.getElementById("view-work").hidden && state.result', 20000, 200);
    await sleep(500);
    report.restored = await evalJs('JSON.stringify({ status: state.current.status, avg: state.result.summary.avg_fps, perSecond: state.result.perSecond && state.result.perSecond.length, previewEmpty: document.getElementById("preview-empty").textContent, renderDisabled: document.getElementById("render-again").disabled, previewDisabled: document.getElementById("preview").disabled, bars: document.querySelectorAll("#chart rect").length })');
    await shotAllSizes('work-restored');
  });

  // Theme sanity: light theme on the result view.
  await step('light theme', async () => {
    await evalJs(CLICK_CARD);
    await sleep(300);
    await evalJs('document.getElementById("theme").value = "light"; document.getElementById("theme").dispatchEvent(new Event("change"))');
    await sleep(300);
    await shotAllSizes('work-light');
    await evalJs('document.getElementById("theme").value = "dark"; document.getElementById("theme").dispatchEvent(new Event("change"))');
  });

  report.stderr = stderr.join('').split('\n').filter((l) => /error|warn|exception/i.test(l)).slice(0, 40);
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  killAll();
  process.exit(report.steps.some((s) => s.includes(': FAILED')) || report.errors.some((e) => e.startsWith('exception:')) ? 1 : 0);
})().catch((e) => {
  console.error('ui-check failed:', e.stack);
  report.fatal = e.message;
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  killAll();
  process.exit(1);
});
