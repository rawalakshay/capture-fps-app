'use strict';
// An analysis (measure -> analyse -> numbers) and, separately, rendering the
// overlay video from a finished analysis, so a video can be rendered again
// with other settings without measuring again.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { probe, runFfmpeg, seekArgs, spanArgs, gpuStatus, abortError } = require('./ffmpeg');
const { measureDiffs, analyse, summarise, writeCsvs, perSecondFps, targetsFor } = require('./analysis');
const { createOverlay, assFilter, filterPath, END_CARD_S } = require('./overlay');
const { loadAnalysis, analysisStart, shiftAnalysis, abOverlay, bandsPane, videoRects, AB_END_CARD_S, AB_SIZES, FT_WIN } = require('./compare-ab');
const timeline = require('./timeline');
const { normaliseProject, trackAnalysis, analysisOf } = timeline;

// ffmpeg runs outside Electron and cannot read inside app.asar: the packaged app unpacks assets (build.asarUnpack).
const assetsDir = (dir) => path.join(dir, '..', '..', 'assets').replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked');
const ASSETS = assetsDir(__dirname);
const FONTS_DIR = path.join(ASSETS, 'fonts');
// How the picture is enlarged when the output is bigger than the recording:
// plain Lanczos (today's default), Lanczos plus a contrast-adaptive sharpen,
// or the FSRCNNX shader on the GPU through libplacebo (Vulkan).
const UPSCALERS = ['lanczos', 'sharp', 'fsrcnnx'];
const SHADER = path.join(ASSETS, 'shaders', 'FSRCNNX_x2_8-0-4-1.glsl');

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
const NVENC_H264_MAX = 4096; // widest frame NVENC H.264 accepts; wider goes to HEVC
const NVENC_HEVC_MAX = 8192;
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

/** The output size for opts: the bands look draws a frame of its own (opts.frame) with the video in a pane. */
function sizeFor(info, opts) {
  const res = String(opts.resolution || 'source');
  if (opts.style !== 'bands') return outputSize(info, res);
  const b = bandsPane(RESOLUTIONS[res] || info.height, opts.frame);
  return { ...b, scaled: b.pane.w > info.width || b.pane.h > info.height };
}

/** Encoder arguments: x264, or NVENC H.264, HEVC when the frame is wider than H.264 allows. */
function videoArgs(encoder, width, height, q) {
  if (encoder !== 'gpu') return { codec: 'h264', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(q.crf)] };
  if (width > NVENC_HEVC_MAX) {
    throw new Error(`${width}×${height} is wider than NVENC allows (${NVENC_HEVC_MAX} pixels). ` +
      'Choose a lower resolution or the CPU (x264) encoder.');
  }
  const hevc = width > NVENC_H264_MAX;
  return {
    codec: hevc ? 'hevc' : 'h264',
    args: ['-c:v', hevc ? 'hevc_nvenc' : 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(q.cq),
      '-b:v', '0', '-spatial-aq', '1', ...(hevc ? ['-tag:v', 'hvc1'] : [])],
  };
}

/** Scale a source into a w x h pane: all of it, letterboxed ('fit'), or filling it, cropped ('cover').
 * up: the pane is bigger than the source, so the chosen upscaler applies. With 'cover', zoom (1..2)
 * scales the source further and pan (-1 left edge .. 1 right edge) moves the crop window. */
function paneScale(w, h, mode, upscaler, up, outDir, pan = 0, zoom = 1) {
  const ar = mode === 'cover' ? 'increase' : 'decrease';
  const zw = zoom === 1 ? w : Math.round(w * zoom / 2) * 2, zh = zoom === 1 ? h : Math.round(h * zoom / 2) * 2;
  const fit = mode === 'cover' ? `crop=${w}:${h}${pan ? `:(iw-${w})*${((pan + 1) / 2).toFixed(4)}:(ih-${h})/2` : ''}`
    : `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`;
  if (up && upscaler === 'fsrcnnx') {
    return `libplacebo=w=${zw}:h=${zh}:force_original_aspect_ratio=${ar}:force_divisible_by=2:upscaler=ewa_lanczos:` +
      `custom_shader_path=${filterPath(SHADER, outDir)}:format=yuv420p,${fit}`;
  }
  return `scale=${zw}:${zh}:force_original_aspect_ratio=${ar}:force_divisible_by=2:flags=lanczos,${up && upscaler === 'sharp' ? 'cas=0.4,' : ''}${fit}`;
}

/** Decode on the GPU unless told not to; NVENC working means an NVIDIA GPU. */
async function useHwDecode(opts) {
  if (opts.hwDecode === true || opts.hwDecode === false) return opts.hwDecode;
  return (await gpuStatus()).nvenc;
}
// shortcut: each '-hwaccel cuda' input holds its own GPU decoder from the start (64 5K HEVC clips took 7.7 GB of an
// 8 GB card), so past this many inputs the clips decode on the CPU; decode them in turn or check free VRAM if that is too slow.
const HW_DECODE_MAX_INPUTS = 6;

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
  // Where the analysed range sits in the file, so a folder read back later (A/B, --ab) lines up with the picture.
  Object.assign(summary.capture, { start_s: start || 0, end_s: end });
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

// The file is labelled BT.709, as the sources are. ass draws exact colours only when both its input is labelled
// BT.709 (the black canvas has no label) and the .ass says 'YCbCr Matrix: TV.709' (abOverlay's ycbcr);
// otherwise libass keeps VSFilter's BT.601 colours and every overlay colour plays back off.
const BT709 = 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv,';

/** The overlay filter `ass` drawn after the chain `src` (ending in a comma), out as [v]. With an end card the playing part goes
 * through libass frame by frame and the end card, which does not move, is drawn on one frame and held: libass took
 * about 75 ms a frame over the full-frame card at 5120x2160, three times the rest of the export. */
function overlayThenCard(src, ass, rate, span, hold, post = '') {
  if (!hold) return `${src}${ass}${post}[v]`;
  const n = Math.round(span * rate), m = Math.ceil(hold * rate);
  return `${src}split[op][oe];[op]trim=end_frame=${n},${ass}[oplay];` +
    // Retimed into the card for libass (frame n can fall before the card's start, rounded to 0.01 s); concat wants each part from 0.
    `[oe]trim=start_frame=${n}:end_frame=${n + 1},setpts=${(span + hold / 2).toFixed(3)}/TB,${ass},loop=loop=${m - 1}:size=1:start=0,setpts=N/(${rate}*TB)[ocard];` +
    `[oplay][ocard]concat=n=2:v=1:a=0${post}[v]`;
}

/** The ass filter with the bundled fonts, after the chosen upscale when the output is bigger. */
function overlayFilter(assName, outDir, size, upscaler = 'lanczos', endCard = false) {
  const fonts = fs.existsSync(FONTS_DIR) ? FONTS_DIR : null;
  // The end card is drawn over the last frame, held for its length.
  let up = endCard ? `tpad=stop_mode=clone:stop_duration=${END_CARD_S},` : '';
  if (size.pane) { // the bands look: the video in its pane, the rest of the frame black
    const p = size.pane;
    up += `${paneScale(p.w, p.h, 'fit', upscaler, size.scaled, outDir)},pad=${size.width}:${size.height}:${p.x}:${p.y}:black,`;
  } else if (size.scaled) {
    const { width: w, height: h } = size;
    up += upscaler === 'fsrcnnx'
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
  const size = sizeFor(info, opts);
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
  const size = sizeFor(info, opts);
  const q = QUALITY[opts.quality] || QUALITY.standard;
  const vid = videoArgs(encoder, size.width, size.height, q);
  // shortcut: the bands look has no end card of its own yet (the panel's is laid out for its 1080p board)
  const endCard = Boolean(opts.endCard) && opts.style !== 'bands';
  onProgress({ phase: 'overlay', fraction: 0 });
  overlayFor(an, opts, size).writeTo(path.join(outDir, 'overlay.ass'));
  delete an.overlayCache; // on disk now; an hour of events must not sit in memory for the rest of the session
  if (signal && signal.aborted) throw abortError();

  const hw = await useHwDecode(opts);
  const up = upscalerFor(opts, size);
  const audio = !info.audioCodec ? []
    : MP4_AUDIO.has(info.audioCodec) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k'];
  const dst = path.join(outDir, `${path.parse(video).name}_fps.mp4`);
  const part = `${dst}.part.mp4`; // the previous video is only replaced once this one is complete
  const span = Math.max(0.001, (end || info.duration) - (start || 0));
  // With an end card the span cuts the input, not the output: an output -t
  // would cut the padded card off with it.
  const cut = spanArgs(start, end), inCut = endCard;

  const t0 = Date.now();
  onProgress({ phase: 'render', fraction: 0 });
  try {
    await runFfmpeg([
      '-y', ...up.args, ...(hw ? ['-hwaccel', 'cuda'] : []), ...seekArgs(start), ...(inCut ? cut : []), '-i', video, ...(inCut ? [] : cut),
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', overlayFilter('overlay.ass', outDir, size, up.upscaler, endCard),
      ...vid.args, '-pix_fmt', 'yuv420p', ...audio, part, // absolute: a name starting with "-" would read as an option
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
    width: size.width, height: size.height, codec: vid.codec,
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

// ---- A/B: two analysed recordings side by side with their numbers ----

/** A default output name that does not replace an earlier export: file, else "<name> (2).mp4", "(3)"… */
function freeName(file) {
  const { dir, name, ext } = path.parse(file);
  let f = file;
  for (let k = 2; fs.existsSync(f); k++) f = path.join(dir, `${name} (${k})${ext}`);
  return f;
}

// Output sizes per frame shape (AB_SIZES, from compare-ab); 21:9 is 64:27 (2560x1080).
const AB_FITS = ['letterbox', 'crop', 'below'];

/**
 * The A/B filter graph: a black canvas, each source trimmed by its skip, scaled into its
 * half and laid on it, then the overlay. p: { infos: [A, B] (probe info), offset (B time =
 * A time + offset), frame, fit, size, end? (cap on the length, s), upscaler, endCard, sound
 * (input index or null for none), assName, outDir, fontsDir, starts? (where each analysis began in its file, s) }.
 * infos[i].duration is the analysed length.
 * Returns { graph, width, height, panes: [{ x, y, w, h }], skips, span, upscaled }.
 */
function compareABGraph(p) {
  const frame = p.frame === '21:9' ? '21:9' : '16:9';
  const fit = AB_FITS.includes(p.fit) ? p.fit : 'letterbox';
  if (fit === 'below' && frame !== '21:9') throw new Error('Data below needs the 21:9 frame');
  const size = String(p.size || '1080');
  if (!AB_SIZES[frame][size]) throw new Error(`Size ${size} is not available for ${frame} (${Object.keys(AB_SIZES[frame]).join(' or ')})`);
  const [W, H] = AB_SIZES[frame][size];
  const { rects: panes } = videoRects(frame, fit, W, H), half = W / 2, top = panes[0].y, vh = panes[0].h;
  const offset = Number(p.offset) || 0, skips = [Math.max(0, -offset), Math.max(0, offset)];
  const starts = (p.starts || [0, 0]).map((v) => Math.max(0, Number(v) || 0));
  let span = Math.min(...p.infos.map((inf, i) => inf.duration - skips[i]));
  if (Number(p.end) > 0) span = Math.min(span, Number(p.end));
  if (!(span > 0.05)) throw new Error(`The two clips do not overlap with B offset by ${offset.toFixed(3)} s`);
  const mode = fit === 'crop' ? 'cover' : 'fit';
  const ups = p.infos.map((inf) => (mode === 'cover' ? Math.max : Math.min)(half / inf.width, vh / inf.height) > 1);
  // Each input seeks on its own (-ss before -i, see seeks): trimmed after decoding, hours in would decode those hours first.
  const seeks = starts.map((s, i) => (s + skips[i]).toFixed(3));
  const cut = `setpts=PTS-STARTPTS,trim=duration=${span.toFixed(3)},setpts=PTS-STARTPTS`;
  // The end card holds each video's last frame; padded per input, as tpad after the overlays stretches the timestamps.
  const hold = p.endCard ? `,tpad=stop_mode=clone:stop_duration=${AB_END_CARD_S}` : '';
  const chains = panes.map((pn, i) => `[${i}:v]${cut},${paneScale(pn.w, pn.h, mode, p.upscaler, ups[i], p.outDir || '.')}${hold}[v${i}]`);
  const total = span + (p.endCard ? AB_END_CARD_S : 0);
  // The canvas sets the output's frame rate: the faster of the two, so neither side loses frames.
  const rate = Math.max(...p.infos.map((inf) => inf.hz || 60));
  let graph = `color=c=black:s=${W}x${H}:r=${rate}:d=${total.toFixed(3)}[bg];${chains.join(';')};` +
    `[bg][v0]overlay=${panes[0].x}:${top}[o0];` +
    overlayThenCard(`[o0][v1]overlay=${panes[1].x}:${top},`, `${BT709}${assFilter(p.assName, p.outDir || '.', p.fontsDir || null)}`, rate, span, p.endCard ? AB_END_CARD_S : 0);
  if (p.sound === 0 || p.sound === 1) {
    graph += `;[${p.sound}:a]asetpts=PTS-STARTPTS,atrim=duration=${span.toFixed(3)},asetpts=PTS-STARTPTS,` +
      `apad=whole_dur=${total.toFixed(3)}[a]`; // silence under the end card, so both streams last as long
  }
  return { graph, width: W, height: H, panes, skips, seeks, span, upscaled: ups.some(Boolean) };
}

/**
 * One video of two analysed recordings side by side, each with its name, whole-clip FPS,
 * live FPS, hitches and frame times, and an end card comparing them.
 * opts: { inputs: [{ video, outDir, title?, subtitle?, start? (the analysis's In point, s) }, same for B], offset = 0, frame = '16:9' | '21:9',
 *         fit = 'letterbox' | 'crop' | 'below' (21:9 only), size = '1080' | '1440' | '2160', encoder,
 *         quality, upscaler, sound = 'A' | 'B', endCard = true, watermark?, out?, end? (cap the length, s), hwDecode? }
 * onProgress({ phase: 'compare', fraction })
 */
async function compareAB(opts, { onProgress = () => {}, signal } = {}) {
  const inputs = opts.inputs || [];
  if (inputs.length !== 2) throw new Error('A/B compare needs two analysed videos');
  for (const i of inputs) if (!i || !i.video || !fs.existsSync(i.video)) throw new Error(`${(i && i.video) || 'A video'} not found`);
  const ans = await Promise.all(inputs.map((i) => loadAnalysis(i.outDir, i.video)));
  const encoder = ENCODERS.includes(opts.encoder) ? opts.encoder : 'gpu';
  const q = QUALITY[opts.quality] || QUALITY.standard;
  const upscaler = UPSCALERS.includes(opts.upscaler) ? opts.upscaler : 'lanczos';
  const endCard = opts.endCard !== false;
  const stems = ans.map((an) => path.parse(an.video).name);
  const out = path.resolve(opts.out || freeName(path.join(ans[0].outDir, `${stems[0]}_vs_${stems[1]}_ab.mp4`)));
  const outDir = path.dirname(out);
  fs.mkdirSync(outDir, { recursive: true });
  // The chosen side's sound, or the other's when it has none.
  const want = opts.sound === 'B' ? 1 : 0;
  const soundI = ans[want].info.audioCodec ? want : ans[1 - want].info.audioCodec ? 1 - want : null;
  const assName = `ab_overlay_${process.pid}.ass`;
  // An analysis of a range starts at its In point (given, or saved with it) and lasts what was analysed.
  const starts = inputs.map((i, n) => Math.max(0, Number(i.start != null ? i.start : analysisStart(ans[n], ans[n].info.duration)) || 0));
  const g = compareABGraph({
    infos: ans.map((an, i) => ({ ...an.info, duration: Math.min(an.info.duration - starts[i], an.a.duration || Infinity) })),
    starts, offset: opts.offset, frame: opts.frame, fit: opts.fit, size: String(opts.size || '1080'),
    end: opts.end, upscaler, endCard, sound: soundI, assName, outDir,
    fontsDir: fs.existsSync(FONTS_DIR) ? FONTS_DIR : null,
  });
  const vid = videoArgs(encoder, g.width, g.height, q);
  const hw = await useHwDecode(opts);
  const assFile = path.join(outDir, assName), part = `${out}.part.mp4`;
  const t0 = Date.now();
  onProgress({ phase: 'compare', fraction: 0 });
  try {
    abOverlay({
      // Every number on the video covers what it shows: the overlap after the skips, not the whole recordings.
      panes: ans.map((an, i) => ({ an, a: shiftAnalysis(an.a, g.skips[i], g.span) })).map(({ an, a }, i) => ({
        a, summary: summarise(a, an.info),
        title: inputs[i].title || stems[i], subtitle: inputs[i].subtitle || '',
      })),
      size: { width: g.width, height: g.height }, frame: opts.frame === '21:9' ? '21:9' : '16:9', fit: opts.fit || 'letterbox',
      span: g.span, endCard, watermark: opts.watermark, ycbcr: 'TV.709',
    }).writeTo(assFile);
    if (signal && signal.aborted) throw abortError();
    const total = g.span + (endCard ? AB_END_CARD_S : 0);
    await runFfmpeg([
      '-y', ...(upscaler === 'fsrcnnx' && g.upscaled ? ['-init_hw_device', 'vulkan'] : []),
      ...ans.flatMap((an, i) => [...(hw ? ['-hwaccel', 'cuda'] : []), '-ss', g.seeks[i], '-i', an.video]),
      '-filter_complex', g.graph, '-map', '[v]', ...(g.graph.endsWith('[a]') ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '192k'] : []),
      ...vid.args, '-pix_fmt', 'yuv420p', part,
    ], {
      cwd: outDir, signal,
      onProgress: (s) => onProgress({ phase: 'compare', fraction: Math.min(1, s / total) }),
    });
  } catch (e) {
    fs.rmSync(part, { force: true });
    if (e.name !== 'AbortError' && !e.code && upscaler === 'fsrcnnx' && g.upscaled) {
      e.message = `GPU upscaling (FSRCNNX, Vulkan) failed. Choose Lanczos or Lanczos + sharpen and try again.\n\n${e.message}`;
    } else if (e.name !== 'AbortError' && !e.code && encoder === 'gpu') {
      e.message = `GPU encoding (NVENC) failed. Choose CPU (x264) and try again.\n\n${e.message}`;
    }
    throw e;
  } finally {
    fs.rmSync(assFile, { force: true });
  }
  try {
    fs.renameSync(part, out);
  } catch (e) { // on Windows a player holding the last export open blocks the replace
    fs.rmSync(part, { force: true });
    throw new Error(`Could not replace ${path.basename(out)}. Close it in your player and export again.\n\n${e.message}`);
  }
  return { path: out, seconds: (Date.now() - t0) / 1000, width: g.width, height: g.height, encoder, codec: vid.codec, hwDecode: hw, sound: soundI === null ? null : 'AB'[soundI] };
}

// ---- Edit & export: a timeline of clips on two or three tracks ----

/**
 * The filter graph of a normalised project (timeline.normaliseProject). Pure: infos[track][clip] are
 * the sources' probe info ({ width, height, hz, audioCodec }; 1080p60 without sound when missing).
 * One input per clip, cut on the input side (-ss/-t) to the part inside the range; per track the clip
 * segments and black gap segments concatenated, held for the end card, laid on a black canvas; then
 * the overlay. Sound: the chosen track's clips, silence for gaps and silent clips.
 * Returns { graph, inputs: [{ video, ss, t, args }], width, height, rects, span, total, rate, upscaled, audio }.
 */
/** A source's frame rate for the graph: an NTSC rate (N*1000/1001, as 59.94) exactly, else the whole number.
 * Rounded to 60, a 59.94 recording would repeat a frame every 16.7 s. */
function gridRate(hz) {
  const ntsc = Math.round(hz * 1.001) * 1000 / 1001;
  return Math.abs(hz / ntsc - 1) < 5e-4 ? ntsc : Math.round(hz); // NTSC and whole rates lie 0.1 % apart
}

/** The output's frame rate (the fastest clip, at least 30) and each track's, from the clips inside the range only:
 * one parked past Out does not double the frames to draw. 0 for a track with none. */
function rangeRates(p, infos = []) {
  const live = (c) => Math.min(c.at + c.out - c.in, p.range.out) - Math.max(c.at, p.range.in) > 1e-3;
  const tracks = p.tracks.map((t, ti) => Math.max(0, ...t.clips.flatMap((c, ci) => (live(c) ? [gridRate(((infos[ti] || [])[ci] || {}).hz || 60)] : []))));
  // The floor of 30 is 29.97 for an NTSC project: lifting it to 30 would repeat a frame every 33 s.
  const top = Math.max(...tracks);
  return { rate: top >= gridRate(29.97) ? top : 30, tracks };
}

/** rates: rangeRates of the whole project, when p is a slice of it (an exact frame), so both share one frame grid.
 * grid: the whole project's range.in, for such a slice: each track's frames then lie on its grid from there, as in the export. */
function timelineGraph(p, { infos = [], assName = 'timeline.ass', outDir = '.', fontsDir = null, post = '', rates = rangeRates(p, infos), grid = null } = {}) {
  const [W, H] = AB_SIZES[p.frame][String(p.size)];
  const { mode, rects } = videoRects(p.frame, p.fit, W, H);
  const r0 = p.range.in, span = p.range.out - p.range.in, hold = p.endCard ? AB_END_CARD_S : 0, total = span + hold;
  const upscaler = UPSCALERS.includes(p.upscaler) ? p.upscaler : 'lanczos';
  const info = (ti, ci) => ({ width: 1920, height: 1080, hz: 60, audioCodec: null, ...((infos[ti] || [])[ci] || {}) });
  // The canvas sets the output's frame rate: the fastest clip, so no track loses frames.
  const { rate } = rates;
  const inputs = [], chains = [], aud = [];
  let upscaled = false;
  const sec = (v) => v.toFixed(3);
  const silence = (d, label) => `aevalsrc=0:c=stereo:s=48000:d=${sec(d)},aformat=sample_fmts=fltp:channel_layouts=stereo[${label}]`;
  p.tracks.forEach((t, ti) => {
    const R = rects[ti], segs = [], asegs = [], withSound = p.sound === ti;
    const trackRate = rates.tracks[ti] || rate;
    const order = t.clips.map((_, i) => i).sort((x, y) => t.clips[x].at - t.clips[y].at);
    // Segments start and end on the track's frame grid: cut to seconds, each would round to whole frames on its
    // own and the clips after it would drift from their numbers and sound by a fraction of a frame per segment.
    // A slice is laid out from the export's start (org) and keeps the frames from the one on screen at its own start (skip).
    const org = grid == null ? r0 : grid, skip = grid == null ? 0 : Math.floor((r0 - grid) * trackRate + 1e-6);
    const frames = (o0, o1) => Math.round(o1 * trackRate) - Math.max(Math.round(o0 * trackRate), skip);
    let cur = 0, gaps = 0;
    const gap = (to) => {
      const n = frames(cur, to);
      if (to - cur > 1e-3 && n > 0) {
        const g = `g${ti}_${gaps++}`, d = n / trackRate;
        chains.push(`color=c=black:s=${R.w}x${R.h}:r=${trackRate}:d=${sec(d)},trim=end_frame=${n},format=yuv420p,setsar=1[${g}]`);
        segs.push(`[${g}]`);
        if (withSound) { chains.push(silence(d, `${g}a`)); asegs.push(`[${g}a]`); }
      }
      cur = Math.max(cur, to);
    };
    for (const ci of order) {
      const c = t.clips[ci], v0 = Math.max(c.at, org), v1 = Math.min(c.at + c.out - c.in, r0 + span);
      if (v1 - v0 <= 1e-3) continue;
      gap(v0 - org);
      const n = frames(v0 - org, v1 - org);
      if (n <= 0) continue; // under half a frame: the gap after it covers it
      const k = inputs.length, len = v1 - v0, inf = info(ti, ci), d = n / trackRate;
      // A slice starts at the source frame the export shows at frame skip (a slower source repeats on the track's grid).
      const drop = Math.max(0, skip - Math.round((v0 - org) * trackRate)), src = Math.min(trackRate, gridRate(inf.hz) || trackRate);
      const ss = c.in + (v0 - c.at) + Math.floor(drop * src / trackRate + 1e-6) / src;
      // Rounded down: rounded up past a frame's time, -ss drops that frame.
      const ssArg = grid == null ? sec(ss) : (Math.floor(ss * 1000) / 1000).toFixed(3);
      inputs.push({ video: c.video, ss, t: len, args: ['-ss', ssArg, '-t', sec(len), '-i', c.video] });
      const crop = mode === 'cover', zoom = crop ? Number(c.zoom) || 1 : 1, pan = crop ? Number(c.pan) || 0 : 0;
      const up = (crop ? Math.max : Math.min)(R.w / inf.width, R.h / inf.height) * zoom > 1;
      upscaled = upscaled || up;
      chains.push(`[${k}:v]setpts=PTS-STARTPTS,${paneScale(R.w, R.h, mode, upscaler, up, outDir, pan, zoom)},` +
        // A clone at the end, should the input give a frame short of n.
        `fps=${trackRate},setsar=1,format=yuv420p,tpad=stop_mode=clone:stop=1,trim=end_frame=${n},setpts=PTS-STARTPTS[c${k}]`);
      segs.push(`[c${k}]`);
      if (withSound) {
        chains.push(inf.audioCodec ? `[${k}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${sec(d)}[c${k}a]`
          : silence(d, `c${k}a`));
        asegs.push(`[c${k}a]`);
      }
      cur = v1 - org;
    }
    gap(p.range.out - org);
    chains.push(`${segs.join('')}concat=n=${segs.length}:v=1:a=0,trim=duration=${sec(span)}` +
      `${hold ? `,tpad=stop_mode=clone:stop_duration=${hold}` : ''}[t${ti}]`);
    if (withSound) aud.push(`${asegs.join('')}concat=n=${asegs.length}:v=0:a=1,apad=whole_dur=${sec(total)}[a]`);
  });
  const lays = rects.map((R, ti) => `[${ti ? `o${ti - 1}` : 'bg'}][t${ti}]overlay=${R.x}:${R.y}`);
  const graph = [`color=c=black:s=${W}x${H}:r=${rate}:d=${sec(total)}[bg]`, ...chains,
    ...lays.map((l, ti) => (ti < lays.length - 1 ? `${l}[o${ti}]` : overlayThenCard(`${l},`, `${BT709}${assFilter(assName, outDir, fontsDir)}`, rate, span, hold, post))), ...aud].join(';');
  return { graph, inputs, width: W, height: H, rects, span, total, rate, upscaled, audio: aud.length > 0 };
}

/** The overlay of a normalised project: one pane per track on the output clock. window: [t0, t1] on that clock
 * to draw the scrolling frame times only for (an exact frame needs one moment, not hours of them). */
function timelineOverlay(p, size, { window } = {}) {
  const panes = p.tracks.map((t, i) => {
    const reads = t.clips.map((c) => analysisOf(c.outDir));
    const a = trackAnalysis(t, reads, p.range);
    return { a, summary: summarise(a, reads[0].summary.capture), title: t.title, subtitle: t.subtitle };
  });
  return abOverlay({ panes, size, frame: p.frame, fit: p.fit, span: p.range.out - p.range.in, endCard: p.endCard, watermark: p.watermark, window, ycbcr: 'TV.709' });
}

const probed = new Map(); // video path -> probe, for exact frames while scrubbing

/** Probe info of every clip, each checked against its analysis (analysisStart); cached: reuse the last probe of each video. */
async function probeClips(p, cached = false) {
  return Promise.all(p.tracks.map((t) => Promise.all(t.clips.map(async (c) => {
    if (!fs.existsSync(c.video)) throw new Error(`${c.video} not found`);
    if (!cached) return checked(c, await probe(c.video));
    if (!probed.has(c.video)) probed.set(c.video, probe(c.video).catch((e) => { probed.delete(c.video); throw e; }));
    return checked(c, await probed.get(c.video));
  }))));
}
const checked = (c, info) => { analysisStart(analysisOf(c.outDir), info.duration); return info; };

/**
 * Render a timeline project (see timeline.js). ctx: { onProgress({ phase: 'compare', fraction }), signal,
 * out? (else project.out, else <first clip stem>_timeline_<frame>-<fit>.mp4 in track A's first clip's folder), hwDecode? }.
 */
async function renderTimeline(project, { onProgress = () => {}, signal, out: outOpt, hwDecode } = {}) {
  const p = normaliseProject(project);
  const first = p.tracks[0].clips[0];
  const infos = await probeClips(p);
  const q = QUALITY[p.quality] || QUALITY.standard;
  const out = path.resolve(outOpt || p.out ||
    freeName(path.join(first.outDir, `${path.parse(first.video).name}_timeline_${p.frame.replace(':', 'x')}-${p.fit}.mp4`)));
  const outDir = path.dirname(out);
  fs.mkdirSync(outDir, { recursive: true });
  const assName = `timeline_overlay_${process.pid}_${Date.now()}.ass`;
  const g = timelineGraph(p, { infos, assName, outDir, fontsDir: fs.existsSync(FONTS_DIR) ? FONTS_DIR : null });
  const vid = videoArgs(p.encoder, g.width, g.height, q);
  const hw = g.inputs.length <= HW_DECODE_MAX_INPUTS && await useHwDecode({ hwDecode });
  const assFile = path.join(outDir, assName), graphFile = `${assFile}.graph.txt`, part = `${out}.part.mp4`;
  const t0 = Date.now();
  onProgress({ phase: 'compare', fraction: 0 });
  try {
    timelineOverlay(p, { width: g.width, height: g.height }).writeTo(assFile);
    // From a file: inline, a project of many clips runs past Windows' 32K command line.
    fs.writeFileSync(graphFile, g.graph);
    if (signal && signal.aborted) throw abortError();
    await runFfmpeg([
      '-y', ...(p.upscaler === 'fsrcnnx' && g.upscaled ? ['-init_hw_device', 'vulkan'] : []),
      ...g.inputs.flatMap((i) => [...(hw ? ['-hwaccel', 'cuda'] : []), ...i.args]),
      '-/filter_complex', graphFile, '-map', '[v]', ...(g.audio ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '192k'] : []),
      // The graph gives exactly this many; ffmpeg's constant-rate output would repeat the last one to fill its duration.
      '-frames:v', String(Math.ceil(g.total * g.rate - 1e-6)),
      ...vid.args, '-pix_fmt', 'yuv420p', part,
    ], {
      cwd: outDir, signal,
      onProgress: (s) => onProgress({ phase: 'compare', fraction: Math.min(1, s / g.total) }),
    });
  } catch (e) {
    fs.rmSync(part, { force: true });
    // A spawn error (it has a code) never reached the GPU.
    if (e.name !== 'AbortError' && !e.code && p.upscaler === 'fsrcnnx' && g.upscaled) {
      e.message = `GPU upscaling (FSRCNNX, Vulkan) failed. Choose Lanczos or Lanczos + sharpen and try again.\n\n${e.message}`;
    } else if (e.name !== 'AbortError' && !e.code && p.encoder === 'gpu') {
      e.message = `GPU encoding (NVENC) failed. Choose CPU (x264) and try again.\n\n${e.message}`;
    }
    throw e;
  } finally {
    fs.rmSync(assFile, { force: true });
    fs.rmSync(graphFile, { force: true });
  }
  try {
    fs.renameSync(part, out);
  } catch (e) { // on Windows a player holding the last export open blocks the replace
    fs.rmSync(part, { force: true });
    throw new Error(`Could not replace ${path.basename(out)}. Close it in your player and export again.\n\n${e.message}`);
  }
  return { path: out, seconds: (Date.now() - t0) / 1000, width: g.width, height: g.height, encoder: p.encoder, codec: vid.codec, hwDecode: hw };
}

let frameSeq = 0;

/**
 * One exact frame of the export at timeline time t (clamped into the range; the end card is not
 * drawn), at most 1920 wide, as a JPEG in the temp folder. Returns its path; the caller deletes it.
 */
async function timelineFrame(project, t, { signal, hwDecode } = {}) {
  const p = normaliseProject(project);
  const [W, H] = AB_SIZES[p.frame][p.size];
  const infos = await probeClips(p, true);
  // The export's frame that is on screen at t: on its frame grid from range.in, so a clip edge falls where the export has it.
  const rates = rangeRates(p, infos), { rate } = rates;
  const k = Math.min(Math.max(0, Math.floor((Number(t) - p.range.in) * rate + 1e-6) || 0), Math.ceil((p.range.out - p.range.in) * rate) - 1);
  const at = p.range.in + k / rate;
  const one = { ...p, range: { in: at, out: at + 0.1 }, endCard: false, sound: null };
  const dir = os.tmpdir(), id = `capfps_frame_${process.pid}_${++frameSeq}`;
  const assName = `${id}.ass`, dst = path.join(dir, `${id}.jpg`);
  // Ends in TV range: left to negotiate, the JPEG's full range reaches back through ass, which then draws its
  // limited-range colours into a full-range frame (the dark boxes come out grey, unlike the export).
  // The export is drawn in BT.709; a JPEG is read as BT.601, so the matrix changes here, as players convert it.
  const post = `,scale=${W > 1920 ? `1920:${Math.round(H * 1920 / W / 2) * 2}` : 'iw:ih'}:flags=bicubic:in_color_matrix=bt709:out_color_matrix=bt601` +
    ',format=pix_fmts=yuv420p:color_ranges=tv';
  const g = timelineGraph(one, { infos, assName, outDir: dir, fontsDir: fs.existsSync(FONTS_DIR) ? FONTS_DIR : null, post, rates, grid: p.range.in });
  // Only the moment is drawn: the scrolling frame times of the last 10 s (the numbers still cover the whole range).
  const ov = timelineOverlay({ ...p, endCard: false }, { width: W, height: H }, { window: [k / rate - FT_WIN - 1, k / rate + 1] });
  const hw = g.inputs.length <= HW_DECODE_MAX_INPUTS && await useHwDecode({ hwDecode });
  const graphFile = path.join(dir, `${id}.graph.txt`);
  try {
    ov.writeTo(path.join(dir, assName), { at: k / rate });
    fs.writeFileSync(graphFile, g.graph);
    if (signal && signal.aborted) throw abortError();
    await runFfmpeg([
      '-y', ...g.inputs.flatMap((i) => [...(hw ? ['-hwaccel', 'cuda'] : []), ...i.args]),
      '-/filter_complex', graphFile, '-map', '[v]', '-frames:v', '1', '-q:v', '4', dst,
    ], { cwd: dir, signal });
  } catch (e) {
    fs.rmSync(dst, { force: true });
    throw e;
  } finally {
    fs.rmSync(path.join(dir, assName), { force: true });
    fs.rmSync(graphFile, { force: true });
  }
  return dst;
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
  compareAB, compareABGraph, videoArgs, sizeFor, AB_SIZES, AB_FITS, paneScale, freeName,
  timelineGraph, renderTimeline, timelineFrame, timelineOverlay, assetsDir,
  normaliseProject: timeline.normaliseProject, // for the CLI
};
