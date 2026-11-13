'use strict';
// Edit & export: two or three tracks of trimmed clips on one timeline, as plain JSON shared by
// the window, IPC, the command line and the renderer (pipeline.renderTimeline).
//
// project = { tracks: [{ title, subtitle, clips: [{ video, outDir, in, out, at, pan = 0, zoom = 1 }] }] (A, B, C),
//             range: { in, out }, frame: '16:9' | '21:9', fit: 'letterbox' | 'crop' | 'below' | 'third',
//             size, encoder, quality, upscaler, sound: track index | null, endCard = true, watermark? }
// in / out are times in the source video; at is where the clip starts on the timeline.

const fs = require('fs');
const path = require('path');
const { summarise } = require('./analysis');
const { readAnalysis, shiftAnalysis, abData, liveFps, verdict, verdictN, AB_SIZES, videoRects, thirds } = require('./compare-ab');

const FRAMES = ['16:9', '21:9'];
const FITS = ['letterbox', 'crop', 'below', 'third'];
const CROP_FITS = ['crop', 'third']; // where pan and zoom apply
const LETTERS = 'ABC';
const MAX_CLIPS = 64;
const EPS = 0.011;   // s: summary.json keeps lengths to 0.01 s
const GAP_MIN = 1e-3; // s: closer clips touch
const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mss = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;

const cache = new Map();
/** readAnalysis of an output folder, read again only when its frames.csv changes; abData is kept with it. */
function analysisOf(outDir) {
  const dir = path.resolve(String(outDir || ''));
  let m = 0;
  try { m = fs.statSync(path.join(dir, 'frames.csv')).mtimeMs; } catch (_) { /* readAnalysis names the missing file */ }
  const hit = cache.get(dir);
  if (hit && hit.m === m) return hit.read;
  const read = readAnalysis(dir);
  if (cache.size >= 2 * MAX_CLIPS) cache.clear();
  cache.set(dir, { m, read });
  return read;
}

/** Where an analysis sits in its video: [start, end] in source seconds. */
function sourceSpan(read) {
  const s0 = Number((read.summary.capture || {}).start_s) || 0;
  return [s0, s0 + read.a.duration];
}

const clipLen = (c) => c.out - c.in;
const trackEnd = (t) => Math.max(0, ...t.clips.map((c) => c.at + clipLen(c)));

/** Validates p, fills the defaults and returns a copy. Errors are plain English. */
function normaliseProject(p) {
  if (!p || !Array.isArray(p.tracks)) throw new Error('A project needs a list of tracks');
  const n = p.tracks.length;
  if (n < 2 || n > 3) throw new Error(`A project has 2 or 3 tracks, not ${n}`);
  const frame = p.frame ?? (n === 3 ? '21:9' : '16:9'), fit = p.fit ?? (n === 3 ? 'third' : 'letterbox');
  if (!FRAMES.includes(frame)) throw new Error(`Frame must be ${FRAMES.join(' or ')}, not ${frame}`);
  if (!FITS.includes(fit)) throw new Error(`Fit must be one of ${FITS.join(', ')}, not ${fit}`);
  if (n === 3 && (frame !== '21:9' || fit !== 'third')) throw new Error('Three tracks need the 21:9 frame with the three videos side by side');
  if (n === 2 && fit === 'third') throw new Error('Three videos side by side needs a third track');
  if (fit === 'below' && frame !== '21:9') throw new Error('Data below needs the 21:9 frame');
  const size = String(p.size ?? '1080');
  if (!AB_SIZES[frame][size]) throw new Error(`Size ${size} is not available for ${frame} (${Object.keys(AB_SIZES[frame]).join(' or ')})`);
  // Each clip is one ffmpeg input with its own decoder.
  const count = p.tracks.reduce((s, t) => s + (t && Array.isArray(t.clips) ? t.clips.length : 0), 0);
  if (count > MAX_CLIPS) throw new Error(`A project holds up to ${MAX_CLIPS} clips; this one has ${count}. Remove or re-trim some.`);
  // Each parsed analysis is tens of MB: only this project's stay cached, or a few long folders fill the heap.
  const used = new Set(p.tracks.flatMap((t) => (t && Array.isArray(t.clips) ? t.clips : []).map((c) => c && path.resolve(String(c.outDir || '')))));
  for (const dir of cache.keys()) if (!used.has(dir)) cache.delete(dir);

  const tracks = p.tracks.map((t, ti) => {
    const L = LETTERS[ti], targets = new Set();
    const clips = (t && Array.isArray(t.clips) ? t.clips : []).map((c, ci) => {
      const id = `${L}${ci + 1}`;
      if (!c || !c.video || !c.outDir) throw new Error(`Clip ${id} needs a video and the folder of its analysis`);
      const read = analysisOf(c.outDir), [s0, s1] = sourceSpan(read);
      const num = (v, name) => {
        const x = Number(v);
        if (v === null || v === '' || !Number.isFinite(x)) throw new Error(`Clip ${id}: ${name} must be a number of seconds`);
        return x;
      };
      const clip = {
        ...c, video: path.resolve(c.video), outDir: path.resolve(c.outDir),
        in: num(c.in ?? s0, 'In'), out: num(c.out ?? s1, 'Out'), at: num(c.at ?? 0, 'Starts at'),
        pan: clamp(num(c.pan ?? 0, 'Pan'), -1, 1), zoom: clamp(num(c.zoom ?? 1, 'Zoom'), 1, 2),
      };
      if (!(clip.out > clip.in)) throw new Error(`Clip ${id}: Out (${mss(clip.out)}) must be after In (${mss(clip.in)})`);
      if (clip.in < s0 - EPS || clip.out > s1 + EPS) {
        throw new Error(`Clip ${id} uses ${mss(clip.in)} to ${mss(clip.out)} of ${path.basename(clip.video)}, ` +
          `but only ${mss(s0)} to ${mss(s1)} was analysed. Trim it inside that part or analyse more of the video.`);
      }
      if (clip.at < 0) throw new Error(`Clip ${id} starts before the timeline does (${clip.at.toFixed(2)} s)`);
      clip.in = Math.max(clip.in, s0);
      clip.out = Math.min(clip.out, s1);
      targets.add(read.a.target);
      return clip;
    });
    // An empty track would export as NO VIDEO throughout, with 0.0 numbers and a verdict about nothing.
    if (!clips.length) throw new Error(`Track ${L} has no clips. Add a clip to it from Media${n === 3 ? ' or remove the track' : ''}.`);
    if (targets.size > 1) {
      throw new Error(`Track ${L} mixes ${[...targets].sort((x, y) => x - y).join(' and ')} fps targets — put them on separate tracks`);
    }
    const order = clips.map((_, i) => i).sort((x, y) => clips[x].at - clips[y].at);
    for (let k = 1; k < order.length; k++) {
      const a = clips[order[k - 1]], b = clips[order[k]], over = a.at + clipLen(a) - b.at;
      if (over > GAP_MIN) throw new Error(`Clips ${L}${order[k - 1] + 1} and ${L}${order[k] + 1} on track ${L} overlap by ${over.toFixed(2)} s`);
    }
    const title = String((t && t.title) || (clips[0] ? path.parse(clips[0].video).name : ''));
    return { ...t, title, subtitle: String((t && t.subtitle) || ''), clips };
  });

  const ends = tracks.map(trackEnd);
  const r = p.range || {};
  const range = { in: Number(r.in ?? 0), out: Number(r.out ?? (ends.length ? Math.min(...ends) : 0)) };
  if (!Number.isFinite(range.in) || !Number.isFinite(range.out) || range.in < 0) throw new Error('The export range must be two times of at least 0 s');
  if (!(range.out - range.in > 0.05)) {
    throw new Error(`The export range ${mss(range.in)} – ${mss(range.out)} is empty; it must be longer than 0.05 s`);
  }
  // A track with no video in the range would export as NO VIDEO throughout, with red zeros and a BEST for it.
  tracks.forEach((t, ti) => {
    if (!t.clips.some((c) => Math.min(c.at + clipLen(c), range.out) - Math.max(c.at, range.in) > GAP_MIN)) {
      throw new Error(`Track ${LETTERS[ti]} has no video inside the export range — move its clips or the range`);
    }
  });
  const sound = p.sound === null ? null : Number(p.sound ?? 0);
  if (sound !== null && !(Number.isInteger(sound) && sound >= 0 && sound < n)) throw new Error(`Sound must come from track A to ${LETTERS[n - 1]}, or none`);
  return {
    ...p, tracks, range, frame, fit, size, sound,
    encoder: p.encoder === 'cpu' ? 'cpu' : 'gpu', quality: p.quality || 'standard', upscaler: p.upscaler || 'lanczos',
    endCard: p.endCard !== false,
  };
}

/**
 * One track as one analysis on the output clock (range.in is 0, range.out - range.in long):
 * each clip's [in, out) placed at `at`, cut to the range, gaps as single 'gap' frames.
 * analyses: readAnalysis results parallel to track.clips (read from the folders when missing).
 */
function trackAnalysis(track, analyses, range) {
  const r0 = range.in, D = range.out - range.in;
  const reads = track.clips.map((c, i) => (analyses && analyses[i]) || analysisOf(c.outDir));
  const order = track.clips.map((_, i) => i).sort((x, y) => track.clips[x].at - track.clips[y].at);
  const first = reads[order[0]].a;
  // One refresh grid for the track: the finest recording's. Each clip's holds are rescaled to it, so
  // pacing does not depend on which clip comes first when a track mixes 60 and 120 Hz recordings.
  const hz = Math.max(...reads.map((r) => r.a.hz || r.a.target), first.hz || first.target);
  const out = {
    hz, target: first.target, kRef: Math.max(1, Math.round(hz / first.target)),
    duration: D, starts: [], frameMs: [], shownMs: [], holdRefreshes: [], kind: [], holds: [], droppedAt: [], tears: [],
    times: [], diffs: [], peaks: [], luma: [], newFrame: [], droppedRefreshes: 0,
    threshold: first.threshold, thresholdSource: first.thresholdSource,
  };
  const refreshMs = 1000 / hz;
  let t = 0; // output time reached
  const gap = (to) => {
    if (to - t > GAP_MIN) {
      const ms = (to - t) * 1000;
      out.starts.push(t); out.frameMs.push(ms); out.shownMs.push(ms); out.holdRefreshes.push(Math.round(ms / refreshMs)); out.kind.push('gap');
      out.holds.push({ start: t, ms, kind: 'gap' });
    }
    t = Math.max(t, to);
  };
  for (const i of order) {
    const c = track.clips[i], v0 = Math.max(c.at, r0), v1 = Math.min(c.at + clipLen(c), r0 + D);
    if (v1 - v0 <= GAP_MIN) continue;
    const o0 = v0 - r0;
    gap(o0);
    // A hold that began before the cut is not counted again (shiftAnalysis keeps only those starting inside).
    const sh = shiftAnalysis(reads[i].a, c.in - sourceSpan(reads[i])[0] + (v0 - c.at), v1 - v0);
    const scale = hz / (reads[i].a.hz || reads[i].a.target);
    for (let j = 0; j < sh.starts.length; j++) {
      out.starts.push(sh.starts[j] + o0); out.frameMs.push(sh.frameMs[j]); out.shownMs.push(sh.shownMs[j]);
      out.holdRefreshes.push(scale === 1 ? sh.holdRefreshes[j] : Math.round(sh.holdRefreshes[j] * scale)); out.kind.push(sh.kind[j]);
    }
    for (const h of sh.holds) out.holds.push({ ...h, start: h.start + o0 });
    t = Math.max(t, v1 - r0);
  }
  gap(D);
  return out;
}

/** Where a source of sw x sh lands for a video rect: the whole picture's rect in frame px (it may run
 * past the video rect when cropped) and the part shown as fractions of the source. */
function placeSource(rect, sw, sh, mode, pan = 0, zoom = 1) {
  const s = mode === 'cover' ? Math.max(rect.w / sw, rect.h / sh) * zoom : Math.min(rect.w / sw, rect.h / sh);
  const pw = sw * s, ph = sh * s;
  if (mode !== 'cover') {
    return { picture: { x: rect.x + (rect.w - pw) / 2, y: rect.y + (rect.h - ph) / 2, w: pw, h: ph }, crop: { x: 0, y: 0, w: 1, h: 1 } };
  }
  const dx = (pw - rect.w) * (pan + 1) / 2, dy = (ph - rect.h) / 2;
  return { picture: { x: rect.x - dx, y: rect.y - dy, w: pw, h: ph }, crop: { x: dx / pw, y: dy / ph, w: rect.w / pw, h: rect.h / ph } };
}

/**
 * The export's geometry, from the numbers the renderer uses: frame size, each track's column (panes),
 * where its video sits (videos), and per clip where its source lands (picture) and what part shows (crop).
 * mode: 'cover' (crop fits: pan and zoom apply) or 'fit' (letterboxed, pan and zoom ignored).
 */
function layoutBoxes(p) {
  const n = p.tracks.length, frame = p.frame || (n === 3 ? '21:9' : '16:9'), fit = p.fit || (n === 3 ? 'third' : 'letterbox');
  const [W, H] = AB_SIZES[frame][String(p.size || '1080')] || AB_SIZES[frame][1080];
  const { mode, rects } = videoRects(frame, fit, W, H);
  const b = fit === 'third' ? thirds(W) : [0, W / 2, W];
  const panes = rects.map((_, i) => ({ x: b[i], y: 0, w: b[i + 1] - b[i], h: H }));
  const clips = p.tracks.map((t, i) => (t.clips || []).map((c) => {
    const cap = analysisOf(c.outDir).summary.capture || {};
    return placeSource(rects[i], cap.width || 1920, cap.height || 1080, mode, Number(c.pan) || 0, Number(c.zoom) || 1);
  }));
  return { width: W, height: H, frame, fit, mode, cropping: CROP_FITS.includes(fit), panes, videos: rects, clips };
}

/** What the window needs, without ffmpeg: per track its numbers over the range, per clip abData on the
 * source clock (times are source-video seconds) cut to [in, out), the verdict and layoutBoxes. */
function projectData(p) {
  const project = normaliseProject(p);
  const reads = project.tracks.map((t) => t.clips.map((c) => analysisOf(c.outDir)));
  const tracks = project.tracks.map((t, i) => {
    const a = trackAnalysis(t, reads[i], project.range);
    const gapMs = a.frameMs.reduce((s, ms, j) => s + (a.kind[j] === 'gap' ? ms : 0), 0);
    return { title: t.title, subtitle: t.subtitle, target: a.target, summary: summarise(a, reads[i][0].summary.capture), gapS: r3(gapMs / 1000),
      live: liveFps(a) } // the live FPS the export shows, every 0.25 s from range.in;
  });
  const clips = project.tracks.map((t, i) => t.clips.map((c, j) => {
    const read = reads[i][j], [s0, s1] = sourceSpan(read), lo = c.in - s0, hi = c.out - s0, src = (v) => r3(v + s0);
    const entry = cache.get(read.outDir);
    const d = entry && entry.read === read ? (entry.ab = entry.ab || abData(read.outDir, read)) : abData(read.outDir, read);
    const perSec = (rows) => rows.filter(([sec]) => sec + 1 > lo && sec < hi).map(([sec, v]) => [src(sec), v]);
    const cap = read.summary.capture || {};
    return {
      id: `${LETTERS[i]}${j + 1}`, target: read.a.target, hz: read.a.hz, width: cap.width, height: cap.height, start: r3(s0), end: r3(s1),
      playFps: perSec(d.playFps), ftMax: perSec(d.ftMax),
      hitches: d.hitches.filter(([s]) => s >= lo && s < hi).map(([s, ms]) => [src(s), ms]),
      paused: d.paused.filter(([s, ms]) => s + ms / 1000 > lo && s < hi).map(([s, ms, k]) => [src(s), ms, k]),
    };
  }));
  const sums = tracks.map((x) => x.summary), names = tracks.map((x, i) => x.title || LETTERS[i]);
  return {
    project, tracks, clips,
    verdict: sums.length === 2 ? verdict(sums[0], sums[1], names) : verdictN(sums, names),
    layoutBoxes: layoutBoxes(project),
  };
}

module.exports = { normaliseProject, trackAnalysis, projectData, layoutBoxes, analysisOf };
