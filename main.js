'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { toolStatus, gpuStatus, probe } = require('./src/core/ffmpeg');
const { analyseVideo, renderOverlay, publicResult, defaultOutDir } = require('./src/core/pipeline');

let win = null;
let job = null;          // { controller } while a job runs
let lastAnalysis = null; // kept so the video can be rendered again without measuring
let lastOutDir = null;   // only paths inside this may be opened

const VIDEO_EXT = ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'ts', 'm2ts'];

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#101317',
    title: 'Capture FPS',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function isVideo(p) {
  return typeof p === 'string' && VIDEO_EXT.includes(path.extname(p).slice(1).toLowerCase());
}

function insideOutput(p) {
  if (!lastOutDir || typeof p !== 'string') return false;
  const rel = path.relative(lastOutDir, path.resolve(p));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
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
    return e.name === 'AbortError' ? { error: 'Rendering was cancelled.' } : { error: e.message };
  }
}

ipcMain.handle('tools', () => toolStatus());
ipcMain.handle('gpu', () => gpuStatus());

ipcMain.handle('pick-video', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a capture recording',
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: VIDEO_EXT }, { name: 'All files', extensions: ['*'] }],
  });
  return r.canceled ? null : r.filePaths[0];
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
    return { ok: true, info, outDir: defaultOutDir(video), name: path.basename(video) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Measure and analyse, then render unless the window asked for numbers only.
// A failed or cancelled render still returns the analysis.
ipcMain.handle('start-job', (_e, opts) => asJob(async (signal) => {
  const an = await analyseVideo(opts, { signal, onProgress: sendProgress });
  lastAnalysis = an;
  lastOutDir = an.outDir;
  const render = opts.renderVideo === false ? null : await tryRender(an, opts, signal);
  return { ok: true, result: publicResult(an, render) };
}));

// Render the last analysis again with new overlay or encoder settings.
ipcMain.handle('render-only', (_e, opts) => asJob(async (signal) => {
  if (!lastAnalysis) return { ok: false, error: 'Analyse a recording first.' };
  const render = await tryRender(lastAnalysis, opts, signal);
  return { ok: true, result: publicResult(lastAnalysis, render) };
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

ipcMain.handle('is-video', (_e, p) => isVideo(p));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (job) job.controller.abort();
  app.quit();
});
