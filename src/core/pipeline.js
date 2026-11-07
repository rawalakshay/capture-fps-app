'use strict';
// An analysis (measure -> analyse -> numbers) and, separately, rendering the
// overlay video from a finished analysis, so a video can be rendered again
// with other settings without measuring again.

const fs = require('fs');
const path = require('path');
const { probe, runFfmpeg, seekArgs, spanArgs, gpuStatus, abortError } = require('./ffmpeg');
const { measureDiffs, analyse, summarise, writeCsvs, perSecondFps, targetsFor } = require('./analysis');
const { createOverlay, assFilter, filterPath, END_CARD_S } = require('./overlay');

const FONTS_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
// How the picture is enlarged when the output is bigger than the recording:
// plain Lanczos (today's default), Lanczos plus a contrast-adaptive sharpen,
// or the FSRCNNX shader on the GPU through libplacebo (Vulkan).
const UPSCALERS = ['lanczos', 'sharp', 'fsrcnnx'];
const SHADER = path.join(__dirname, '..', '..', 'assets', 'shaders', 'FSRCNNX_x2_8-0-4-1.glsl');

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
  if (opts.target && !targetsFor(info.hz).includes(opts.target)) {
    throw new Error(`A ${Math.round(info.hz)} Hz recording can carry a target of ${targetsFor(info.hz).join(', ')} fps, not ${opts.target}`);
  }
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

/** The overlay laid out for the output size, so it stays sharp when the video
 * is scaled; its format pill names the recording, not the output. */
function overlayFor(an, opts, size) {
  const title = opts.title || path.parse(an.video).name;
  // The built overlay is kept on the analysis: a preview scrub with the same
  // options must not lay out the whole clip again.
  const key = JSON.stringify([title, opts, size]);
  if (!an.overlayCache || an.overlayCache.key !== key) {
    an.overlayCache = { key, ov: createOverlay(an.a, size, title, opts.overlayRate || 30, opts.position || 'right', an.info, opts) };
  }
  return an.overlayCache.ov;
}

/** The ass filter with the bundled fonts, after the chosen upscale when the output is bigger. */
function overlayFilter(assName, outDir, size, upscaler = 'lanczos', endCard = false) {
  const fonts = fs.existsSync(FONTS_DIR) ? FONTS_DIR : null;
  // The end card is drawn over the last frame, held for its length.
  let up = endCard ? `tpad=stop_mode=clone:stop_duration=${END_CARD_S},` : '';
  if (size.scaled) {
    const { width: w, height: h } = size;
    up = upscaler === 'fsrcnnx'
      ? `libplacebo=w=${w}:h=${h}:upscaler=ewa_lanczos:custom_shader_path=${filterPath(SHADER, outDir)}:format=yuv420p,`
      : `scale=${w}:${h}:flags=lanczos,${upscaler === 'sharp' ? 'cas=0.4,' : ''}`;
  }
  return up + assFilter(assName, outDir, fonts);
}

/** The chosen upscaler, and the global ffmpeg arguments it needs. */
function upscalerFor(opts, size) {
  const upscaler = UPSCALERS.includes(opts.upscaler) ? opts.upscaler : 'lanczos';
  return { upscaler, args: upscaler === 'fsrcnnx' && size.scaled ? ['-init_hw_device', 'vulkan'] : [] };
}

/**
 * One frame, `at` seconds into the analysed span, with the overlay as it would
 * be rendered with opts: written to outDir/preview.jpg. Same opts as renderOverlay.
 */
async function previewFrame(an, opts = {}, at = 0, { signal } = {}) {
  const { video, outDir, start, end, info } = an;
  const size = outputSize(info, String(opts.resolution || 'source'));
  const span = Math.max(0.001, (end || info.duration) - (start || 0));
  at = Math.min(Math.max(0, Number(at) || 0), Math.max(0, span - 0.05));
  overlayFor(an, opts, size).writeTo(path.join(outDir, 'preview.ass'), { at });
  if (signal && signal.aborted) throw abortError();
  const dst = path.join(outDir, 'preview.jpg');
  const hw = await useHwDecode(opts);
  const up = upscalerFor(opts, size);
  await runFfmpeg([
    '-y', ...up.args, ...(hw ? ['-hwaccel', 'cuda'] : []), '-ss', ((start || 0) + at).toFixed(3), '-i', video,
    '-frames:v', '1', '-vf', overlayFilter('preview.ass', outDir, size, up.upscaler), '-q:v', '4', dst,
  ], { cwd: outDir, signal });
  return { path: dst, at };
}

/**
 * Render the overlay video from an analysis.
 * opts: { title?, position = 'right', encoder = 'gpu' | 'cpu',
 *         quality = 'standard', resolution = 'source' | '1080' | '1440' | '2160',
 *         overlayRate = 30, hwDecode?, showTarget = true, showFormat = true,
 *         caption?, captionPosition = 'top-left', watermark?,
 *         style = 'panel' | 'strip' | 'glass', longGraph = false, longGraphOpacity = 0.86, endCard = false,
 *         upscaler = 'lanczos' | 'sharp' | 'fsrcnnx' (only when resolution is above the recording) }
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
  overlayFor(an, opts, size).writeTo(path.join(outDir, 'overlay.ass'));
  delete an.overlayCache; // on disk now; an hour of events must not sit in memory for the rest of the session
  if (signal && signal.aborted) throw abortError();

  const q = QUALITY[opts.quality] || QUALITY.standard;
  const hw = await useHwDecode(opts);
  const up = upscalerFor(opts, size);
  const video_ = encoder === 'gpu'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(q.cq),
      '-b:v', '0', '-spatial-aq', '1']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(q.crf)];
  const audio = !info.audioCodec ? []
    : MP4_AUDIO.has(info.audioCodec) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k'];
  const dst = path.join(outDir, `${path.parse(video).name}_fps.mp4`);
  const part = `${dst}.part.mp4`; // the previous video is only replaced once this one is complete
  const span = Math.max(0.001, (end || info.duration) - (start || 0));
  // With an end card the span cuts the input, not the output: an output -t
  // would cut the padded card off with it.
  const cut = spanArgs(start, end), inCut = Boolean(opts.endCard);

  const t0 = Date.now();
  onProgress({ phase: 'render', fraction: 0 });
  try {
    await runFfmpeg([
      '-y', ...up.args, ...(hw ? ['-hwaccel', 'cuda'] : []), ...seekArgs(start), ...(inCut ? cut : []), '-i', video, ...(inCut ? [] : cut),
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', overlayFilter('overlay.ass', outDir, size, up.upscaler, Boolean(opts.endCard)),
      ...video_, '-pix_fmt', 'yuv420p', ...audio, part, // absolute: a name starting with "-" would read as an option
    ], {
      cwd: outDir, signal,
      onProgress: (s) => onProgress({ phase: 'render', fraction: Math.min(1, s / span) }),
    });
  } catch (e) {
    fs.rmSync(part, { force: true }); // never leave a half-written video
    if (e.name !== 'AbortError' && up.args.length) {
      e.message = `GPU upscaling (FSRCNNX, Vulkan) failed. Choose Lanczos or Lanczos + sharpen and render again.\n\n${e.message}`;
    } else if (e.name !== 'AbortError' && encoder === 'gpu') {
      e.message = `GPU encoding (NVENC) failed. Choose CPU (x264) and render again.\n\n${e.message}`;
    }
    throw e;
  }
  fs.renameSync(part, dst);
  return {
    path: dst, seconds: (Date.now() - t0) / 1000, encoder, hwDecode: hw,
    width: size.width, height: size.height,
  };
}

// ---- comparison: two to four rendered videos side by side ----

const LAYOUTS = ['h', 'v', 'grid'];
const LABEL_FONT = path.join(FONTS_DIR, 'IBMPlexSansCondensed-SemiBold.ttf');

/** A pane label as a drawtext filter: the text comes from a file, so nothing needs escaping. */
function labelFilter(textFile, paneH, outDir) {
  return `drawtext=fontfile=${filterPath(LABEL_FONT, outDir)}:textfile=${filterPath(textFile, outDir)}:expansion=none` +
    `:fontsize=${Math.round(paneH * 0.045)}:fontcolor=white:borderw=${Math.max(1, Math.round(paneH / 400))}:bordercolor=black@0.8` +
    ':x=(w-text_w)/2:y=24';
}

/**
 * The filter graph that scales each input to a common pane size and stacks the
 * panes: side by side ('h'), stacked ('v') or in a grid. labelFiles[i] (a path or
 * null) names the pane. Returns { graph, width, height }.
 */
function compareGraph(infos, layout, labelFiles = [], outDir = '.') {
  const n = infos.length;
  const even = (v) => Math.round(v / 2) * 2;
  const minH = Math.min(...infos.map((i) => i.height)), minW = Math.min(...infos.map((i) => i.width));
  const cols = layout === 'grid' ? Math.ceil(Math.sqrt(n)) : layout === 'h' ? n : 1;
  const rows = Math.ceil(n / cols);
  // Panes share a height side by side, a width stacked, both in a grid.
  const panes = infos.map((i) => layout === 'h' ? { w: even(i.width * minH / i.height), h: minH }
    : layout === 'v' ? { w: minW, h: even(i.height * minW / i.width) } : { w: minW, h: minH });
  const chains = panes.map((p, i) => `[${i}:v]scale=${p.w}:${p.h}:flags=lanczos` +
    (labelFiles[i] ? `,${labelFilter(labelFiles[i], p.h, outDir)}` : '') + `[p${i}]`);
  const ins = panes.map((_, i) => `[p${i}]`).join('');
  let stack, width, height;
  if (layout === 'grid') {
    const pos = panes.map((_, i) => `${(i % cols) * minW}_${Math.floor(i / cols) * minH}`).join('|');
    stack = `xstack=inputs=${n}:layout=${pos}:fill=black:shortest=1`;
    width = cols * minW; height = rows * minH;
  } else if (layout === 'v') {
    stack = `vstack=inputs=${n}:shortest=1`;
    width = minW; height = panes.reduce((s, p) => s + p.h, 0);
  } else {
    stack = `hstack=inputs=${n}:shortest=1`;
    width = panes.reduce((s, p) => s + p.w, 0); height = minH;
  }
  return { graph: `${chains.join(';')};${ins}${stack}[v]`, width, height };
}

/**
 * Stack rendered videos into one, each started at its own offset so the clips
 * line up, with a label over each pane. The audio is the first input's.
 * opts: { inputs: [{ file, offset = 0, label = file name }], layout = 'h' | 'v' | 'grid',
 *         out?, encoder, quality, hwDecode? }
 * onProgress({ phase: 'compare', fraction })
 */
async function compareVideos(opts, { onProgress = () => {}, signal } = {}) {
  const inputs = (opts.inputs || []).map((x) => (typeof x === 'string' ? { file: x } : { ...x }));
  if (inputs.length < 2 || inputs.length > 4) throw new Error('Compare needs 2 to 4 videos');
  for (const i of inputs) {
    i.file = path.resolve(i.file);
    if (!fs.existsSync(i.file)) throw new Error(`${i.file} not found`);
    i.offset = Math.max(0, Number(i.offset) || 0);
    if (i.label === undefined || i.label === null) i.label = path.parse(i.file).name.replace(/_fps$/, '');
  }
  const infos = await Promise.all(inputs.map((i) => probe(i.file)));
  const layout = LAYOUTS.includes(opts.layout) ? opts.layout : inputs.length > 2 ? 'grid' : 'h';
  const encoder = ENCODERS.includes(opts.encoder) ? opts.encoder : 'gpu';
  const q = QUALITY[opts.quality] || QUALITY.standard;
  const stems = inputs.map((i) => path.parse(i.file).name.replace(/_fps$/, ''));
  const out = path.resolve(opts.out || path.join(path.dirname(inputs[0].file), `${stems.join('_vs_')}_compare.mp4`));
  const outDir = path.dirname(out);
  fs.mkdirSync(outDir, { recursive: true });
  const labelFiles = inputs.map((i, k) => (i.label === '' ? null : path.join(outDir, `compare_label_${process.pid}_${k}.txt`)));
  const g = compareGraph(infos, layout, labelFiles, outDir);
  if (encoder === 'gpu' && g.width > NVENC_H264_MAX) {
    throw new Error(`${g.width}×${g.height} is wider than NVENC H.264 allows (${NVENC_H264_MAX} pixels). ` +
      'Stack the videos or choose the CPU (x264) encoder.');
  }
  const hw = await useHwDecode(opts);
  const video_ = encoder === 'gpu'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(q.cq), '-b:v', '0', '-spatial-aq', '1']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(q.crf)];
  const span = Math.max(0.001, Math.min(...inputs.map((i, k) => infos[k].duration - i.offset)));
  const part = `${out}.part.mp4`;
  const t0 = Date.now();
  onProgress({ phase: 'compare', fraction: 0 });
  try {
    labelFiles.forEach((f, k) => { if (f) fs.writeFileSync(f, inputs[k].label); });
    await runFfmpeg([
      '-y',
      ...inputs.flatMap((i) => [...(hw ? ['-hwaccel', 'cuda'] : []), '-ss', i.offset.toFixed(3), '-i', i.file]),
      '-filter_complex', g.graph, '-map', '[v]', '-map', '0:a:0?', '-shortest',
      ...video_, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', part,
    ], {
      cwd: outDir, signal,
      onProgress: (s) => onProgress({ phase: 'compare', fraction: Math.min(1, s / span) }),
    });
  } catch (e) {
    fs.rmSync(part, { force: true });
    if (e.name !== 'AbortError' && encoder === 'gpu') e.message = `GPU encoding (NVENC) failed. Choose CPU (x264) and try again.\n\n${e.message}`;
    throw e;
  } finally {
    for (const f of labelFiles) if (f) fs.rmSync(f, { force: true });
  }
  fs.renameSync(part, out);
  return { path: out, seconds: (Date.now() - t0) / 1000, encoder, hwDecode: hw, width: g.width, height: g.height, layout };
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
    renderCancelled: Boolean(render && render.cancelled),
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
  analyseVideo, renderOverlay, previewFrame, runJob, publicResult, defaultOutDir, compareVideos, compareGraph,
  FONTS_DIR, QUALITY, ENCODERS, RESOLUTIONS, UPSCALERS, LAYOUTS, outputSize, overlayFilter,
};
