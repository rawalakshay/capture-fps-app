'use strict';
// An analysis (measure -> analyse -> numbers) and, separately, rendering the
// overlay video from a finished analysis, so a video can be rendered again
// with other settings without measuring again.

const fs = require('fs');
const path = require('path');
const { probe, runFfmpeg, seekArgs, spanArgs, gpuStatus, abortError } = require('./ffmpeg');
const { measureDiffs, analyse, summarise, writeCsvs, perSecondFps } = require('./analysis');
const { createOverlay, assFilter } = require('./overlay');

const FONTS_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

// One quality choice for both encoders. NVENC CQ 22 gives about the size of
// x264 CRF 16 at slightly higher SSIM on 1080p60 game capture.
const QUALITY = {
  high: { crf: 12, cq: 18 },
  standard: { crf: 16, cq: 22 },
  small: { crf: 20, cq: 26 },
};
const ENCODERS = ['gpu', 'cpu'];
// Output heights; 'source' keeps the recording's size. Width follows the
// recording's aspect ratio.
const RESOLUTIONS = { source: null, 1080: 1080, 1440: 1440, 2160: 2160 };
const NVENC_H264_MAX = 4096; // widest frame NVENC H.264 accepts
// Audio an MP4 can carry as it is; anything else is re-encoded to AAC.
const MP4_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'alac', 'flac']);

function defaultOutDir(video) {
  const p = path.parse(video);
  return path.join(p.dir, `${p.name}_fps`);
}

function outputSize(info, resolution) {
  const h = RESOLUTIONS[resolution];
  if (!h || h === info.height) return { width: info.width, height: info.height, scaled: false };
  return { width: Math.round((info.width * h) / info.height / 2) * 2, height: h, scaled: true };
}

/** Decode on the GPU unless told not to; NVENC working means an NVIDIA GPU. */
async function useHwDecode(opts) {
  if (opts.hwDecode === true || opts.hwDecode === false) return opts.hwDecode;
  return (await gpuStatus()).nvenc;
}

/**
 * opts: { video, outDir?, start?, end?, target?, threshold?, hwDecode? }
 * onProgress({ phase: 'measure'|'analyse', fraction })
 */
async function analyseVideo(opts, { onProgress = () => {}, signal } = {}) {
  const video = path.resolve(opts.video);
  if (!fs.existsSync(video)) throw new Error(`${video} not found`);
  const start = opts.start || null;
  const end = opts.end || null;
  if (start !== null && end !== null && end <= start) throw new Error('End must be after start');
  const outDir = path.resolve(opts.outDir || defaultOutDir(video));
  fs.mkdirSync(outDir, { recursive: true });

  const info = await probe(video);
  const span = Math.max(0.001, (end || info.duration) - (start || 0));
  const t0 = Date.now();
  onProgress({ phase: 'measure', fraction: 0 });
  const progress = (s) => onProgress({ phase: 'measure', fraction: Math.min(1, s / span) });
  let hw = await useHwDecode(opts);
  let rows;
  try {
    rows = await measureDiffs(video, outDir, { start, end, signal, hwaccel: hw, onProgress: progress });
  } catch (e) {
    if (e.name === 'AbortError' || !hw) throw e;
    hw = false; // GPU decoding failed outright: measure again on the CPU
    rows = await measureDiffs(video, outDir, { start, end, signal, hwaccel: false, onProgress: progress });
  }
  const measureSeconds = (Date.now() - t0) / 1000;

  onProgress({ phase: 'analyse', fraction: 0 });
  const a = analyse(rows, info.hz, opts.threshold ?? null, opts.target || null);
  const summary = summarise(a, info);
  writeCsvs(a, outDir);
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  return {
    video, outDir, start, end, info, a, summary,
    perSecond: perSecondFps(a), measureSeconds, hwDecode: hw,
  };
}

/**
 * Render the overlay video from an analysis.
 * opts: { title?, position = 'right', encoder = 'gpu' | 'cpu',
 *         quality = 'standard', resolution = 'source' | '1080' | '1440' | '2160',
 *         overlayRate = 30, hwDecode?, showTarget = true, showFormat = true,
 *         caption?, captionPosition = 'top-left', watermark?,
 *         style = 'panel' | 'strip' | 'glass', longGraph = false, longGraphOpacity = 0.86 }
 * onProgress({ phase: 'overlay'|'render', fraction })
 */
async function renderOverlay(an, opts = {}, { onProgress = () => {}, signal } = {}) {
  const { video, outDir, start, end, info, a } = an;
  const encoder = ENCODERS.includes(opts.encoder) ? opts.encoder : 'gpu';
  const size = outputSize(info, String(opts.resolution || 'source'));
  if (encoder === 'gpu' && size.width > NVENC_H264_MAX) {
    throw new Error(`${size.width}×${size.height} is wider than NVENC H.264 allows ` +
      `(${NVENC_H264_MAX} pixels). Choose a lower resolution or the CPU (x264) encoder.`);
  }
  onProgress({ phase: 'overlay', fraction: 0 });
  // The overlay is laid out for the output size, so it stays sharp when the
  // video is scaled; its format pill names the recording, not the output.
  const title = opts.title || path.parse(video).name;
  createOverlay(a, size, title, opts.overlayRate || 30, opts.position || 'right', info, opts).writeTo(path.join(outDir, 'overlay.ass'));
  if (signal && signal.aborted) throw abortError();

  const q = QUALITY[opts.quality] || QUALITY.standard;
  const hw = await useHwDecode(opts);
  const video_ = encoder === 'gpu'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(q.cq),
      '-b:v', '0', '-spatial-aq', '1']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(q.crf)];
  const audio = !info.audioCodec ? []
    : MP4_AUDIO.has(info.audioCodec) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k'];
  const dst = path.join(outDir, `${path.parse(video).name}_fps.mp4`);
  const fonts = fs.existsSync(FONTS_DIR) ? FONTS_DIR : null;
  const span = Math.max(0.001, (end || info.duration) - (start || 0));

  const t0 = Date.now();
  onProgress({ phase: 'render', fraction: 0 });
  try {
    await runFfmpeg([
      '-y', ...(hw ? ['-hwaccel', 'cuda'] : []), ...seekArgs(start), '-i', video, ...spanArgs(start, end),
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', (size.scaled ? `scale=${size.width}:${size.height}:flags=lanczos,` : '') +
        assFilter('overlay.ass', outDir, fonts),
      ...video_, '-pix_fmt', 'yuv420p', ...audio, dst, // absolute: a name starting with "-" would read as an option
    ], {
      cwd: outDir, signal,
      onProgress: (s) => onProgress({ phase: 'render', fraction: Math.min(1, s / span) }),
    });
  } catch (e) {
    fs.rmSync(dst, { force: true }); // never leave a half-written video
    if (e.name !== 'AbortError' && encoder === 'gpu') {
      e.message = `GPU encoding (NVENC) failed. Choose CPU (x264) and render again.\n\n${e.message}`;
    }
    throw e;
  }
  return {
    path: dst, seconds: (Date.now() - t0) / 1000, encoder, hwDecode: hw,
    width: size.width, height: size.height,
  };
}

/** What the window and the command line get back. */
function publicResult(an, render) {
  return {
    video: an.video, outDir: an.outDir, info: an.info, summary: an.summary,
    perSecond: an.perSecond, measureSeconds: an.measureSeconds, hwDecode: an.hwDecode,
    overlayVideo: render && render.path ? render.path : null,
    renderSeconds: render && render.seconds ? render.seconds : null,
    encoder: render && render.encoder ? render.encoder : null,
    outputWidth: render && render.width ? render.width : null,
    outputHeight: render && render.height ? render.height : null,
    renderError: render && render.error ? render.error : null,
  };
}

/** Analysis plus, unless renderVideo is false, the overlay video. */
async function runJob(opts, ctx = {}) {
  const an = await analyseVideo(opts, ctx);
  const render = opts.renderVideo === false ? null : await renderOverlay(an, opts, ctx);
  ctx.onProgress && ctx.onProgress({ phase: 'done', fraction: 1 });
  return publicResult(an, render);
}

module.exports = {
  analyseVideo, renderOverlay, runJob, publicResult, defaultOutDir,
  FONTS_DIR, QUALITY, ENCODERS, RESOLUTIONS, outputSize,
};
