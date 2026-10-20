'use strict';
// Locating and running ffmpeg / ffprobe.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// The bundled ffmpeg: resources/ffmpeg in the installed app, vendor/ffmpeg in a checkout.
const BUNDLED = [
  process.resourcesPath ? path.join(process.resourcesPath, 'ffmpeg') : null,
  path.join(__dirname, '..', '..', 'vendor', 'ffmpeg'),
].filter(Boolean);

function which(tool) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of BUNDLED.concat((process.env.PATH || '').split(path.delimiter))) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir.replace(/^"|"$/g, ''), tool + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch (_) { /* not here */ }
    }
  }
  return null;
}

function need(tool) {
  const p = which(tool);
  if (!p) {
    throw new Error(`${tool} not found. Run "npm run fetch-ffmpeg", or install ffmpeg ` +
      `(for example "winget install Gyan.FFmpeg") and restart the app.`);
  }
  return p;
}

let toolsCache = null;

/** Both tools on PATH and ffmpeg built with libass (the 'ass' filter draws the overlay); checked once. */
function toolStatus() {
  if (!toolsCache) {
    toolsCache = new Promise((resolve) => {
      const ffmpeg = which('ffmpeg');
      const ffprobe = which('ffprobe');
      const done = (reason) => resolve({ ffmpeg, ffprobe, ok: !reason, reason: reason || null });
      if (!ffmpeg) return done('ffmpeg not found');
      if (!ffprobe) return done('ffprobe not found');
      execFile(ffmpeg, ['-hide_banner', '-filters'], { windowsHide: true, timeout: 20000, maxBuffer: 1 << 20 }, (err, stdout) => {
        done(!err && /^\s*\S*\s+ass\s/m.test(stdout) ? null
          : 'ffmpeg has no subtitle support (libass). Install the Gyan.FFmpeg build.');
      });
    });
  }
  return toolsCache;
}

function rate(text) {
  const [num, den = '1'] = String(text || '0/1').split('/');
  const d = parseFloat(den) || 0;
  return d ? (parseFloat(num) || 0) / d : 0;
}

function probe(video) {
  return new Promise((resolve, reject) => {
    execFile(need('ffprobe'), [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate:format=duration',
      '-of', 'json', video,
    ], { windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`ffprobe could not read the file: ${(stderr || err.message).trim()}`));
      let j;
      try {
        j = JSON.parse(stdout);
      } catch (e) {
        return reject(new Error('ffprobe returned unreadable output'));
      }
      const streams = j.streams || [];
      const s = streams.find((x) => x.codec_type === 'video');
      if (!s) return reject(new Error('No video stream in this file'));
      const audio = streams.find((x) => x.codec_type === 'audio');
      const hz = rate(s.avg_frame_rate) || rate(s.r_frame_rate);
      resolve({
        width: parseInt(s.width, 10),
        height: parseInt(s.height, 10),
        hz,
        duration: parseFloat((j.format || {}).duration) || 0,
        audioCodec: audio ? audio.codec_name : null,
      });
    });
  });
}

let gpuCache = null;

/** Whether NVENC really works here (an NVIDIA GPU and driver), checked once. */
function gpuStatus() {
  if (!gpuCache) {
    gpuCache = new Promise((resolve) => {
      const ff = which('ffmpeg');
      if (!ff) return resolve({ nvenc: false, reason: 'ffmpeg not found' });
      execFile(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=30',
        '-frames:v', '3', '-c:v', 'h264_nvenc', '-f', 'null', '-'],
      { windowsHide: true, timeout: 20000 }, (err, _out, stderr) => {
        resolve(err
          ? { nvenc: false, reason: (stderr || err.message).trim().split(/\r?\n/).pop() }
          : { nvenc: true });
      });
    });
  }
  return gpuCache;
}

let vulkanCache = null;

/** Whether GPU upscaling works here (a Vulkan device and ffmpeg's libplacebo filter), checked once. */
function vulkanStatus() {
  if (!vulkanCache) {
    vulkanCache = new Promise((resolve) => {
      const ff = which('ffmpeg');
      if (!ff) return resolve({ ok: false, reason: 'ffmpeg not found' });
      execFile(ff, ['-hide_banner', '-loglevel', 'error', '-init_hw_device', 'vulkan', '-f', 'lavfi', '-i', 'color=c=gray:s=64x64:r=30',
        '-frames:v', '2', '-vf', 'libplacebo=w=128:h=128:format=yuv420p', '-f', 'null', '-'],
      { windowsHide: true, timeout: 20000 }, (err, _out, stderr) => {
        resolve(err ? { ok: false, reason: (stderr || err.message).trim().split(/\r?\n/).pop() } : { ok: true, reason: null });
      });
    });
  }
  return vulkanCache;
}

/**
 * Run ffmpeg with machine-readable progress. Resolves when it exits 0.
 * onProgress(seconds_done) is called as it goes; signal aborts it.
 */
function runFfmpeg(args, { cwd, onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const child = spawn(need('ffmpeg'), [
      '-hide_banner', '-nostats', '-loglevel', 'error', '-progress', 'pipe:1', ...args,
    ], { cwd, windowsHide: true });
    let errTail = '';
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && onProgress) onProgress(parseInt(m[1], 10) / 1e6);
      }
    });
    child.stderr.on('data', (chunk) => {
      errTail = (errTail + chunk.toString()).slice(-4000);
    });
    const onAbort = () => child.kill();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) return reject(abortError());
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg failed (exit ${code}): ${errTail.trim() || 'no error text'}`));
    });
  });
}

function abortError() {
  const e = new Error('Cancelled');
  e.name = 'AbortError';
  return e;
}

/** -ss before the input, -t after it, as the Python script does. */
function seekArgs(start) {
  return start ? ['-ss', start.toFixed(3)] : [];
}

function spanArgs(start, end) {
  return end ? ['-t', (end - (start || 0)).toFixed(3)] : [];
}

module.exports = { which, need, toolStatus, gpuStatus, vulkanStatus, probe, runFfmpeg, seekArgs, spanArgs, abortError };
