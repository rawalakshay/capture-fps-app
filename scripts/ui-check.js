'use strict';
// Dev tool: drives the real Electron app over CDP, runs an analysis on a clip and screenshots every view at
// several window sizes, reporting overflow and runtime errors as JSON.
//   node scripts/ui-check.js <clip.mp4> <out-dir>
// Needs Node 22 (global WebSocket and fetch); no npm packages.

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9333;
const [clip, outDir] = process.argv.slice(2);
if (!clip || !outDir) { console.error('usage: node scripts/ui-check.js <clip> <out-dir>'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const SIZES = [[980, 680], [1280, 800], [1440, 900], [1920, 1080]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const electron = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron', '.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: 'pipe', shell: process.platform === 'win32' });
const stderr = [];
electron.stderr.on('data', (d) => stderr.push(String(d)));
const killAll = () => {
  try {
    if (process.platform === 'win32') execSync(`taskkill /PID ${electron.pid} /T /F`, { stdio: 'ignore' });
    else electron.kill('SIGKILL');
  } catch (_) { /* already gone */ }
};
process.on('exit', killAll);

async function pageTarget() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (_) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('electron did not expose a page target');
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
    bodyTall: document.body.scrollHeight > innerHeight + 1, offscreen: [], spillX: [], spillY: [] };
  const inScroller = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowY; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true; } return false; };
  for (const e of document.querySelectorAll('body *')) {
    if (e.closest('svg') || !vis(e)) continue;
    const r = e.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    if (r.right > innerWidth + 1 || r.left < -1) out.offscreen.push(ref(e) + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
    const cs = getComputedStyle(e);
    if (e.tagName !== 'SVG' && e.scrollWidth > e.clientWidth + 1 && cs.overflowX === 'visible' && cs.textOverflow !== 'ellipsis') out.spillX.push(ref(e) + ' ' + e.clientWidth + '<' + e.scrollWidth + ' "' + txt(e) + '"');
    if (e.scrollHeight > e.clientHeight + 1 && cs.overflowY === 'visible' && !inScroller(e)) out.spillY.push(ref(e) + ' ' + e.clientHeight + '<' + e.scrollHeight + ' "' + txt(e) + '"');
  }
  return out;
})()`;

const CLICK_CARD = `document.querySelector('#lib-grid .card-main[title$="clip.mp4"]').click()`;
const report = { shots: [], overflow: {}, topbar: {}, errors, steps: [] };
async function shotAllSizes(view) {
  for (const [w, h] of SIZES) {
    // Electron's CDP has no Browser.getWindowForTarget, so the viewport is emulated instead of resizing the window.
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    const file = path.join(outDir, `${view}-${w}x${h}.png`);
    const png = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
    fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
    report.shots.push(file);
    report.overflow[`${view}-${w}x${h}`] = await evalJs(OVERFLOW_JS);
    // Round-2 regression: the topbar action group must stay on one row and the topbar on at most two.
    if (view.startsWith('work')) report.topbar[`${view}-${w}x${h}`] = await evalJs(TOPBAR_JS);
  }
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
    await sleep(800);
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
    await sleep(500);
    await shotAllSizes('work-reopened');
  });

  await step('compare', async () => {
    await evalJs('document.getElementById("nav-compare").click()');
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
    await evalJs('document.getElementById("nav-compare").click()');
    await evalJs('compare.inputs.push({ file: compare.inputs[0].file, offset: "0:01", label: "clip B long label name" }); renderCompareList(); drawCompareChart()');
    await sleep(400);
    await shotAllSizes('compare-two');
    await zoomShot('compare-col', '#compare-list > *');
    await evalJs('compare.inputs.pop(); renderCompareList()');
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
  process.exit(0);
})().catch((e) => {
  console.error('ui-check failed:', e.stack);
  report.fatal = e.message;
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  killAll();
  process.exit(1);
});
