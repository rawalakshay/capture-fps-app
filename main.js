'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { toolStatus, gpuStatus, vulkanStatus, probe, runFfmpeg } = require('./src/core/ffmpeg');
const { analyseVideo, renderOverlay, previewFrame, publicResult, defaultOutDir, compareVideos, compareAB, renderTimeline, timelineFrame } = require('./src/core/pipeline');
const { abData, overlapSummary, verdict } = require('./src/core/compare-ab');
const { targetsFor } = require('./src/core/analysis');
const { projectData, layoutBoxes } = require('./src/core/timeline');

let win = null;
let job = null;          // { controller } while a job runs
let lastAnalysis = null; // kept so the video can be rendered again without measuring
const outDirs = new Set(); // every output folder of this session; only paths inside one may be opened
const videos = new Set();  // every video this session has probed or analysed; only these are read for A / B
const knownVideo = (v) => typeof v === 'string' && path.isAbsolute(v) && videos.has(path.resolve(v));

const VIDEO_EXT = ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'ts', 'm2ts'];

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#0B0C0F',
    title: 'Capture FPS',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // A covered window would pause the muted videos the compare modes play in step, and refuse to restart them.
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function insideOutput(p) {
  if (typeof p !== 'string') return false;
  return [...outDirs].some((dir) => {
    const rel = path.relative(dir, path.resolve(p));
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

function sendProgress(p) {
  if (win && !win.isDestroyed()) win.webContents.send('job-progress', p);
}

/** Run fn(signal) as the one job; returns its value or { ok: false, ... }. */
async function asJob(fn) {
  if (job) return { ok: false, error: 'A job is already running' };
  const controller = new AbortController();
  job = { controller };
  try {
    return await fn(controller.signal);
  } catch (e) {
    return { ok: false, cancelled: e.name === 'AbortError', error: e.message };
  } finally {
    job = null;
  }
}

/** Render, turning failure or cancelling into a note on the result. */
async function tryRender(an, opts, signal) {
  try {
    return await renderOverlay(an, opts, { signal, onProgress: sendProgress });
  } catch (e) {
    return e.name === 'AbortError' ? { error: 'Rendering was cancelled.', cancelled: true } : { error: e.message };
  }
}

ipcMain.handle('tools', () => toolStatus());
ipcMain.handle('version', () => app.getVersion());
ipcMain.handle('gpu', () => gpuStatus());
ipcMain.handle('vulkan', () => vulkanStatus());

ipcMain.handle('pick-video', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose capture recordings',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video', extensions: VIDEO_EXT }, { name: 'All files', extensions: ['*'] }],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('pick-folder', async (_e, current) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose the output folder',
    defaultPath: typeof current === 'string' ? current : undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('probe', async (_e, video) => {
  try {
    if (!fs.existsSync(video)) return { ok: false, error: 'File not found' };
    const info = await probe(video);
    videos.add(path.resolve(video));
    return { ok: true, info, outDir: defaultOutDir(video), name: path.basename(video), targets: targetsFor(info.hz), size: fs.statSync(video).size };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Measure and analyse, then render unless the window asked for numbers only.
// A failed or cancelled render still returns the analysis.
ipcMain.handle('start-job', (_e, opts) => asJob(async (signal) => {
  const an = await analyseVideo(opts, { signal, onProgress: sendProgress });
  lastAnalysis = an;
  outDirs.add(an.outDir);
  videos.add(an.video);
  const render = opts.renderVideo === false ? null : await tryRender(an, opts, signal);
  return { ok: true, result: publicResult(an, render) };
}));

// Render the last analysis again with new overlay or encoder settings.
ipcMain.handle('render-only', (_e, opts) => asJob(async (signal) => {
  if (!lastAnalysis) return { ok: false, error: 'Analyse a recording first.' };
  const render = await tryRender(lastAnalysis, opts, signal);
  return { ok: true, result: publicResult(lastAnalysis, render) };
}));

// One frame of the last analysis with the overlay as the current settings would draw it.
ipcMain.handle('preview', (_e, opts, at) => asJob(async (signal) => {
  if (!lastAnalysis) return { ok: false, error: 'Analyse a recording first.' };
  const r = await previewFrame(lastAnalysis, opts, at, { signal });
  return { ok: true, at: r.at, jpeg: fs.readFileSync(r.path).toString('base64') };
}));

// Stack rendered videos side by side; the output folder joins the ones that may be opened.
ipcMain.handle('compare', (_e, opts) => asJob(async (signal) => {
  // The window never picks the output path; it goes next to the first input.
  const r = await compareVideos({ ...opts, out: undefined }, { signal, onProgress: sendProgress });
  outDirs.add(path.dirname(r.path));
  return { ok: true, result: r };
}));

// A finished run from an earlier session, read back from its output folder (those two files only).
ipcMain.handle('load-result', (_e, outDir) => {
  try {
    if (typeof outDir !== 'string') return { ok: false };
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'));
    const perSecond = fs.readFileSync(path.join(outDir, 'per_second.csv'), 'utf8').trim().split(/\r?\n/).slice(1)
      .map((l) => l.split(',').map(Number)).filter((r) => r.length === 2 && r.every(Number.isFinite));
    outDirs.add(path.resolve(outDir));
    return { ok: true, result: { summary, perSecond } };
  } catch (_) {
    return { ok: false };
  }
});

// What the A / B view needs from a finished run's folder; the folder joins the ones that may be opened.
ipcMain.handle('ab-data', async (_e, outDir) => {
  try {
    if (typeof outDir !== 'string') return { ok: false, error: 'No output folder' };
    const result = await abData(outDir);
    outDirs.add(path.resolve(outDir));
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// The numbers of the part of a run that A / B shows (from skip, span long), from a folder already read.
ipcMain.handle('ab-summary', (_e, outDir, skip, span) => {
  try {
    if (!insideOutput(outDir)) return { ok: false, error: 'No output folder' };
    return { ok: true, result: overlapSummary(outDir, skip, span) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('ab-verdict', (_e, sumA, sumB, titles) => {
  try {
    return verdict(sumA, sumB, titles);
  } catch (_) {
    return null;
  }
});

// A still of a video the window cannot play itself (an unsupported codec): ~960 px wide JPEG.
let frameSeq = 0;
ipcMain.handle('frame-at', async (_e, video, t) => {
  if (!knownVideo(video) || !fs.existsSync(video)) {
    return { ok: false, error: 'Not a video file' };
  }
  const dst = path.join(app.getPath('temp'), `capture-fps-frame-${process.pid}-${++frameSeq}.jpg`);
  try {
    await runFfmpeg(['-y', '-ss', Math.max(0, Number(t) || 0).toFixed(3), '-i', video, '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '5', dst]);
    return { ok: true, jpeg: fs.readFileSync(dst).toString('base64') };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    fs.rmSync(dst, { force: true });
  }
});

// Two analysed recordings side by side with their data drawn on; only folders this session has read may be used.
ipcMain.handle('compare-ab', (_e, opts) => asJob(async (signal) => {
  const inputs = opts && Array.isArray(opts.inputs) ? opts.inputs : [];
  if (inputs.length !== 2 || !inputs.every((i) => i && insideOutput(i.outDir) && knownVideo(i.video))) return { ok: false, error: 'Choose two analysed recordings first.' };
  // The window never picks the output path; it goes next to A's analysis, which this session may open.
  const r = await compareAB({ ...opts, out: undefined }, { signal, onProgress: sendProgress });
  outDirs.add(path.dirname(r.path));
  return { ok: true, result: r };
}));

// ---- Edit & export: a project of 2 or 3 tracks of clips (see src/core/timeline.js) ----

/** null when every clip is an analysed recording this session has read; otherwise why not. */
function projectProblem(p) {
  if (!p || !Array.isArray(p.tracks) || p.tracks.length < 2 || p.tracks.length > 3) return 'A project has 2 or 3 tracks.';
  for (const t of p.tracks) {
    if (!t || !Array.isArray(t.clips)) return 'A track has no clip list.';
    for (const c of t.clips) {
      if (!c || !insideOutput(c.outDir)) return 'A clip comes from a folder this session has not read. Add it again from Media.';
      if (!knownVideo(c.video) || !fs.existsSync(c.video)) return `${c && c.video} is not a video this session has opened.`;
    }
  }
  return null;
}

// What the window draws: numbers per track and clip, the verdict, and where each pane sits (also for a project
// that does not validate yet, so the monitor can still be laid out).
ipcMain.handle('project-data', async (_e, project) => {
  const bad = projectProblem(project);
  if (bad) return { ok: false, error: bad };
  try {
    return { ok: true, result: projectData(project) };
  } catch (e) {
    let boxes = null;
    try { boxes = layoutBoxes(project); } catch (_) { /* drawn without them */ }
    return { ok: false, error: e.message, layoutBoxes: boxes };
  }
});

// One exact frame of the export; a newer request cancels the one still running.
let frameJob = null;
ipcMain.handle('timeline-frame', async (_e, project, t) => {
  const bad = projectProblem(project);
  if (bad) return { ok: false, error: bad };
  if (frameJob) frameJob.abort();
  const ctl = frameJob = new AbortController();
  let file = null;
  try {
    const r = await timelineFrame(project, Math.max(0, Number(t) || 0), { signal: ctl.signal });
    file = typeof r === 'string' ? r : r && r.path;
    return { ok: true, url: `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}` };
  } catch (e) {
    return { ok: false, cancelled: e.name === 'AbortError', error: e.message };
  } finally {
    if (file) fs.rmSync(file, { force: true });
    if (frameJob === ctl) frameJob = null;
  }
});

// The export; it goes next to track A's first analysis (the window never picks the path), which may then be opened.
ipcMain.handle('render-timeline', (_e, project) => asJob(async (signal) => {
  const bad = projectProblem(project);
  if (bad) return { ok: false, error: bad };
  const r = await renderTimeline({ ...project, out: undefined }, { signal, onProgress: sendProgress });
  outDirs.add(path.dirname(r.path));
  return { ok: true, result: r };
}));

ipcMain.handle('cancel-job', () => {
  if (job) job.controller.abort();
  return true;
});

ipcMain.handle('open-path', async (_e, p) => {
  if (!insideOutput(p)) return false;
  return (await shell.openPath(p)) === '';
});

ipcMain.handle('show-in-folder', (_e, p) => {
  if (!insideOutput(p)) return false;
  shell.showItemInFolder(p);
  return true;
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (job) job.controller.abort();
  app.quit();
});
