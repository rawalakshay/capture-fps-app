'use strict';
// Frame detection and statistics: a port of capture_fps.py, plus the peak test.
//
// The console sends a fixed-refresh signal (e.g. 60 Hz). When the game
// renders slower than the refresh, the same image is sent more than once.
// Every captured refresh is compared with the one before it; a refresh that
// changed is a new game frame, one that did not is a repeat. A refresh
// counts as changed when the mean difference is above the threshold or when
// any one spot changed strongly (the peak): a small real change in a calm
// scene averages to almost nothing, encoder noise on a repeat never peaks.
//
// The same decode pass also keeps each refresh's mean brightness (black
// screens are loading, not stutter) and the mean difference of 16 horizontal
// bands (a torn refresh changes in one contiguous part of the picture only).

const fs = require('fs');
const path = require('path');
const { runFfmpeg, seekArgs } = require('./ffmpeg');

// A refresh counts as a new frame when the mean absolute luma difference to
// the previous refresh (0..255, on a downscaled grey image) is above this.
const DEFAULT_THRESHOLD = 0.4;
// A refresh is also a new frame when any pixel of the downscaled diff (a 3x3
// block at 1080p, 0..255) changed by at least this much. Encoder noise on a
// repeat peaked at 20 in 120 Mbps NVENC recordings and 31 at x264 CRF 23;
// real changes peaked at 87 or more.
const PEAK_NEW = 64;
// And a refresh is only a new frame when its peak is at least this: a repeat
// re-encoded at a keyframe shifts the mean (0.23 seen at x264 CRF 18) but
// peaks like noise (24).
const PEAK_MIN = 40;
// The diff is also averaged over a GRID_W x GRID_H grid; rows are the bands.
// (swscale cannot scale to a width of 1, so the columns are averaged here.)
const GRID_W = 4, GRID_H = 16;
// A hold is a frame on screen for at least this many target frames
// (CapFrameX draws its stutter line at 2.5x the average frame time).
const HOLD_X = 2.5;
// A refresh darker than this (mean luma, 0..255) is a black screen.
const NEAR_BLACK = 16;
// The scene was calm before a hold when the median diff of the last
// CALM_FRAMES new frames was below CALM_DIFF: a menu or a still, not a hitch.
const CALM_DIFF = 1.0, CALM_FRAMES = 6;
// Tear: one contiguous run of changed bands next to one of still bands, each
// at least this many bands tall. A band still on more than TEAR_MAX_SHARE of
// new frames is a static HUD or letterbox, not tearing. The changed side must
// have moved as a whole (a tear line crosses the width): at least TEAR_WIDE
// of its cells changed, which a cursor or a character on a still scene never
// does, and changed by TEAR_MIN_MOTION on average: a visible tear needs motion.
const TEAR_MIN_BANDS = 2, TEAR_MAX_SHARE = 0.5, TEAR_WIDE = 0.6, TEAR_MIN_MOTION = 1.0;

function bisectLeft(a, x, lo = 0, hi = a.length) {
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function bisectRight(a, x, lo = 0, hi = a.length) {
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x < a[mid]) hi = mid; else lo = mid + 1;
  }
  return lo;
}

function round(x, n) {
  const p = 10 ** n;
  return Math.round(x * p) / p;
}

/** Frame caps a fixed-refresh signal can carry: the refresh and its integer fractions down to 20 fps. */
function targetsFor(hz) {
  const r = Math.round(hz) || 60;
  const out = [];
  for (let t = 20; t <= r; t++) if (r % t === 0) out.push(t);
  return out.length ? out : [r];
}

/**
 * [time_s, diff_to_previous, peak_diff, luma, bands[16]] for every captured
 * refresh; the first one gets diff = Infinity (always a new frame).
 */
async function measureDiffs(video, work, { start, end, onProgress, signal, hwaccel = false } = {}) {
  // per process: two app windows may measure the same recording
  const pid = process.pid;
  const names = [`diff_raw_${pid}.txt`, `diff_peak_${pid}.txt`, `luma_${pid}.bin`, `grid_${pid}.bin`];
  const meta = (key, file) => `metadata=mode=print:key=lavfi.signalstats.${key}:file=${file}`;
  const grid = `format=gray16le,scale=${GRID_W}:${GRID_H}:flags=area`;
  // The span is cut once, here, so every output sees the same refreshes.
  const trim = end ? `trim=duration=${(end - (start || 0)).toFixed(3)},` : '';
  const graph = `[0:v]${trim}scale=640:-2:flags=area,format=gray,split=2[src][d0];` +
    `[src]${grid}[lg];` +
    '[d0]tblend=all_mode=difference,split=2[d1][d2];' +
    `[d1]signalstats,${meta('YAVG', names[0])},${meta('YMAX', names[1])}[s1];` +
    `[d2]${grid}[dg]`;
  let texts, luma, bands;
  try {
    await runFfmpeg([
      '-y', ...(hwaccel ? ['-hwaccel', 'cuda'] : []), ...seekArgs(start), '-i', path.resolve(video),
      '-an', '-sn', '-dn', '-filter_complex', graph,
      '-map', '[s1]', '-f', 'null', '-',
      // passthrough: a raw output must not be padded to a constant rate
      '-map', '[lg]', '-fps_mode', 'passthrough', '-f', 'rawvideo', names[2],
      '-map', '[dg]', '-fps_mode', 'passthrough', '-f', 'rawvideo', names[3],
    ], { cwd: work, onProgress, signal });
    texts = names.slice(0, 2).map((n) => fs.readFileSync(path.join(work, n), 'utf8'));
    luma = fs.readFileSync(path.join(work, names[2]));
    bands = fs.readFileSync(path.join(work, names[3]));
  } finally {
    for (const n of names) fs.rmSync(path.join(work, n), { force: true });
  }
  const rows = parseDiffs(...texts, luma, bands);
  if (rows.length < 3) throw new Error('Too few frames measured; is this a video file?');
  return rows;
}

/** Rows from the metadata filters' text: lines of `pts_time:` then `lavfi.signalstats.YAVG=`
 * in text, the same frames' `lavfi.signalstats.YMAX=` in peakText, every refresh's own
 * picture as a gray16le GRID_W x GRID_H grid in lumaGrid, and the diff frames' grid in diffGrid. */
function parseDiffs(text, peakText = '', lumaGrid = null, diffGrid = null) {
  const { times, values: diffs } = parseMeta(text, 'YAVG');
  const peaks = parseMeta(peakText, 'YMAX').values;
  const luma = lumaGrid ? parseGrid(lumaGrid).map((c) => c.reduce((s, v) => s + v, 0) / c.length) : [];
  const bands = diffGrid ? parseGrid(diffGrid) : [];
  if (diffGrid && bands.length !== times.length) {
    throw new Error(`Band grid has ${bands.length} frames, the diff text ${times.length}`);
  }
  if (times.length < 2) return times.map((t, i) => [t, diffs[i], peaks[i], luma[i + 1], bands[i]]);
  // tblend emits one frame per pair, stamped with the later frame; put the
  // very first refresh back in front of it.
  const period = times[1] - times[0];
  const first = times[0] - period;
  const rows = [[0.0, Infinity, undefined, luma[0], undefined]];
  for (let i = 0; i < times.length; i++) rows.push([times[i] - first, diffs[i], peaks[i], luma[i + 1], bands[i]]);
  return rows;
}

function parseMeta(text, key) {
  const times = [];
  const values = [];
  const re = new RegExp(`lavfi[.]signalstats[.]${key}=([-0-9.e]+)`);
  let pendingT = null;
  for (const line of text.split(/\r?\n/)) {
    let m = /pts_time:([-0-9.e]+)/.exec(line);
    if (m) {
      pendingT = parseFloat(m[1]);
      continue;
    }
    m = re.exec(line);
    if (m && pendingT !== null) {
      times.push(pendingT);
      values.push(parseFloat(m[1]));
      pendingT = null;
    }
  }
  return { times, values };
}

/** Per frame, its GRID_W x GRID_H cells (0..255, row-major) as a Float32Array. */
function parseGrid(buf) {
  const n = GRID_W * GRID_H, per = n * 2;
  const out = [];
  for (let off = 0; off + per <= buf.length; off += per) {
    const cells = new Float32Array(n);
    for (let k = 0; k < n; k++) cells[k] = buf.readUInt16LE(off + k * 2) / 256;
    out.push(cells);
  }
  return out;
}

/** The mean of each band (row) of a cell grid. */
function bandMeans(cells) {
  const b = new Array(GRID_H);
  for (let r = 0; r < GRID_H; r++) {
    let s = 0;
    for (let c = 0; c < GRID_W; c++) s += cells[r * GRID_W + c];
    b[r] = s / GRID_W;
  }
  return b;
}

/**
 * Split repeats from new frames on a log scale; null if the data is not
 * clearly two groups (e.g. every refresh is new, a true 60 fps game).
 */
function otsuThreshold(diffs) {
  const vals = diffs.filter(Number.isFinite).map((d) => Math.log10(d + 0.01));
  if (vals.length < 50) return null;
  let lo = Infinity, hi = -Infinity;
  for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (hi - lo < 1e-6) return null;
  const bins = 256;
  const hist = new Array(bins).fill(0);
  for (const v of vals) hist[Math.min(bins - 1, Math.floor((v - lo) / (hi - lo) * bins))] += 1;
  const total = vals.length;
  let sumAll = 0;
  for (let i = 0; i < bins; i++) sumAll += i * hist[i];
  let best = -1, bestI = 0, w0 = 0, sum0 = 0;
  for (let i = 0; i < bins; i++) {
    w0 += hist[i];
    if (w0 === 0 || w0 === total) continue;
    sum0 += i * hist[i];
    const m0 = sum0 / w0, m1 = (sumAll - sum0) / (total - w0);
    const between = w0 * (total - w0) * (m0 - m1) ** 2;
    if (between > best) { best = between; bestI = i; }
  }
  const cut = 10 ** (lo + (bestI + 1) / bins * (hi - lo)) - 0.01;
  const low = diffs.filter((d) => Number.isFinite(d) && d <= cut);
  const high = diffs.filter((d) => Number.isFinite(d) && d > cut);
  if (!low.length || !high.length) return null;
  const meanLo = low.reduce((s, d) => s + d, 0) / low.length;
  const meanHi = high.reduce((s, d) => s + d, 0) / high.length;
  const share = Math.min(low.length, high.length) / total;
  // Repeats must really be near-identical and clearly apart from motion.
  if (meanLo < 0.25 && meanHi > 6 * Math.max(meanLo, 0.02) && share > 0.05) {
    return Math.min(Math.max(cut, 0.1), 1.0);
  }
  return null;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0.0;
  const k = (sorted.length - 1) * p;
  const f = Math.floor(k), c = Math.ceil(k);
  if (f === c) return sorted[k];
  return sorted[f] + (sorted[c] - sorted[f]) * (k - f);
}

function median(vals) {
  const s = vals.slice().sort((x, y) => x - y);
  return percentile(s, 0.5);
}

function inferTarget(avgFps, hz = 60) {
  const targets = targetsFor(hz);
  for (const t of targets) if (avgFps <= t * 1.05) return t;
  return targets[targets.length - 1];
}

/**
 * Tears: refreshes that changed in one part of the picture while a run of
 * bands at the top or bottom stayed as they were, and where that still part
 * then changes on the next refresh (the rest of the frame arriving). A still
 * sky over a moving character never does that. Bands still on most new
 * frames (a HUD, a letterbox bar) are left out. Returns [{ i, y }] with y
 * the boundary as a share of the height.
 */
function findTears(grids, newFrame, threshold) {
  const newIdx = [];
  for (let i = 0; i < grids.length; i++) if (newFrame[i] && grids[i]) newIdx.push(i);
  if (!newIdx.length) return [];
  const bands = new Map(newIdx.map((i) => [i, bandMeans(grids[i])]));
  const stillCount = new Array(GRID_H).fill(0);
  for (const i of newIdx) bands.get(i).forEach((v, r) => { if (v < threshold) stillCount[r]++; });
  const live = []; // band indices that take part in motion
  stillCount.forEach((n, r) => { if (n <= TEAR_MAX_SHARE * newIdx.length) live.push(r); });
  const n = live.length;
  if (n < 2 * TEAR_MIN_BANDS) return [];
  const moved = (i, k) => bands.has(i) ? bands.get(i)[live[k]] >= threshold : grids[i] && bandMeans(grids[i])[live[k]] >= threshold;
  const found = [];
  for (const i of newIdx) {
    if (i + 1 >= grids.length) continue;
    let top = 0, bottom = 0;
    while (top < n && !moved(i, top)) top++;
    while (bottom < n && !moved(i, n - 1 - bottom)) bottom++;
    let changed = 0, cells = 0, wide = 0, motion = 0;
    for (let k = top; k < n - bottom; k++) {
      if (!moved(i, k)) continue;
      changed++;
      for (let c = 0; c < GRID_W; c++) {
        const v = grids[i][live[k] * GRID_W + c];
        cells++; motion += v;
        if (v >= threshold) wide++;
      }
    }
    if (changed < TEAR_MIN_BANDS || wide < TEAR_WIDE * cells || motion < TEAR_MIN_MOTION * cells) continue;
    // one still run at an edge, and its band next to the boundary changes next refresh
    if (top >= TEAR_MIN_BANDS && bottom < TEAR_MIN_BANDS && moved(i + 1, top - 1)) found.push({ i, y: live[top] / GRID_H });
    else if (bottom >= TEAR_MIN_BANDS && top < TEAR_MIN_BANDS && moved(i + 1, n - bottom)) found.push({ i, y: live[n - bottom] / GRID_H });
  }
  // A boundary on most new frames is a static region the mask missed, not tearing.
  const perY = new Map();
  for (const t of found) perY.set(t.y, (perY.get(t.y) || 0) + 1);
  return found.filter((t) => perY.get(t.y) <= TEAR_MAX_SHARE * newIdx.length);
}

function analyse(rows, hz, threshold, target) {
  const pts = rows.map((r) => r[0]);
  const diffs = rows.map((r) => r[1]);
  const peaks = rows.map((r) => r[2]);
  const luma = rows.map((r) => r[3]);
  const grids = rows.map((r) => r[4]);
  const period = hz > 0 ? 1.0 / hz : (pts[1] - pts[0]);
  // The signal is fixed-refresh, so refresh i is at exactly i x period.
  // Container timestamps are often rounded to 1 ms, which would blur every
  // frame time; they are only used to spot refreshes the recorder dropped.
  const times = pts.map((_, i) => i * period);
  let dropped = 0;
  const droppedAt = []; // time (in the fixed-refresh base) of each refresh that follows a gap
  // The recorder stamps its last frame when it stops, so a gap there is not a drop.
  for (let i = 1; i < pts.length - 1; i++) {
    const gap = pts[i] - pts[i - 1];
    if (gap > 1.5 * period) {
      dropped += Math.max(0, Math.round(gap / period) - 1);
      droppedAt.push(times[i]);
    }
  }
  const duration = times.length * period;
  const a = {
    hz, droppedRefreshes: dropped, droppedAt, duration, times, diffs, peaks, luma, newFrame: [],
    starts: [], frameMs: [], holdRefreshes: [], kind: [], holds: [], tears: [],
    threshold: DEFAULT_THRESHOLD, thresholdSource: 'default', target: 60, kRef: 1,
  };
  if (threshold !== null && threshold !== undefined) {
    a.threshold = threshold;
    a.thresholdSource = 'set by hand';
  } else {
    const auto = otsuThreshold(diffs.slice(1));
    if (auto !== null) {
      a.threshold = auto;
      a.thresholdSource = 'auto (two clear groups)';
    }
  }
  a.newFrame = diffs.map((d, i) => (d > a.threshold && !(peaks[i] < PEAK_MIN)) || peaks[i] >= PEAK_NEW);
  a.starts = times.filter((_, i) => a.newFrame[i]);
  const startIdx = [];
  a.newFrame.forEach((n, i) => { if (n) startIdx.push(i); });
  for (let i = 0; i < a.starts.length; i++) {
    const end = i + 1 < a.starts.length ? a.starts[i + 1] : duration;
    a.frameMs.push((end - a.starts[i]) * 1000.0);
  }
  const refreshMs = period * 1000;
  a.holdRefreshes = a.frameMs.map((ms) => Math.round(ms / refreshMs));
  // The target comes from the frames in play: a hold that is long for even
  // the lowest target (20 fps) is a menu, a load or a hitch, not the pace.
  const quickAt = Math.ceil(HOLD_X * hz / 20);
  let quickN = 0, quickMs = 0;
  a.frameMs.forEach((ms, f) => { if (a.holdRefreshes[f] < quickAt) { quickN++; quickMs += ms; } });
  const avg = quickMs > 0 ? quickN / (quickMs / 1000) : 0.0;
  a.target = target || inferTarget(avg, hz);
  a.kRef = Math.max(1, Math.round(hz / a.target)); // refreshes per target frame
  // Long holds: a black screen is loading; a hold after a calm scene is a
  // menu or still; anything else is a hitch.
  // shortcut: a real hitch inside an already-calm scene reads as static; revisit on a GTA 6 clip that shows one
  const holdAt = Math.ceil(HOLD_X * a.kRef);
  const recent = [];
  for (let f = 0; f < a.frameMs.length; f++) {
    const i = startIdx[f];
    let kind = 'ok';
    if (a.holdRefreshes[f] >= holdAt) {
      if (luma[i] !== undefined && luma[i] < NEAR_BLACK) kind = 'loading';
      else if (!recent.length || median(recent) < CALM_DIFF) kind = 'static';
      else kind = 'hitch';
      a.holds.push({ start: a.starts[f], ms: a.frameMs[f], kind });
    }
    a.kind.push(kind);
    if (Number.isFinite(diffs[i])) {
      recent.push(diffs[i]);
      if (recent.length > CALM_FRAMES) recent.shift();
    }
  }
  a.tears = findTears(grids, a.newFrame, a.threshold).map((t) => ({ time: times[t.i], y: t.y }));
  return a;
}

function perSecondFps(a) {
  const out = [];
  for (let sec = 0; sec < Math.floor(a.duration); sec++) {
    out.push([sec, bisectLeft(a.starts, sec + 1) - bisectLeft(a.starts, sec)]);
  }
  return out;
}

/** True for frames that are part of play: not a menu, still or load screen, nor a gap between clips on a timeline. */
const isPlay = (kind) => kind !== 'static' && kind !== 'loading' && kind !== 'gap';

/** The headline numbers for a set of frame times over `duration` seconds. */
function frameStats(frameMs, duration, targetMs, refreshMs, count = frameMs.length) {
  const fts = frameMs.slice().sort((x, y) => x - y);
  const n = frameMs.length;
  const avg = duration > 0 ? count / duration : 0.0;
  const p99 = percentile(fts, 0.99), p999 = percentile(fts, 0.999);
  // A frame "misses" when it stays on screen at least one refresh longer
  // than the cap allows.
  const missed = frameMs.filter((ms) => ms > targetMs + refreshMs * 0.5).length;
  return {
    game_frames: n,
    seconds: round(duration, 2),
    avg_fps: round(avg, 2),
    low_1pct_fps: p99 ? round(1000.0 / p99, 2) : 0.0,
    low_0_1pct_fps: p999 ? round(1000.0 / p999, 2) : 0.0,
    frames_missing_target: missed,
    frames_missing_target_pct: n ? round(100.0 * missed / n, 2) : 0.0,
    longest_frame_ms: fts.length ? round(fts[fts.length - 1], 1) : 0.0,
  };
}

function summarise(a, info) {
  const targetMs = 1000.0 / a.target;
  const refreshMs = a.hz ? 1000.0 / a.hz : targetMs;
  const playMs = a.frameMs.filter((_, i) => isPlay(a.kind[i]));
  const pausedS = (a.frameMs.reduce((s, ms, i) => s + (isPlay(a.kind[i]) ? 0 : ms), 0)) / 1000;
  const playS = Math.max(0, a.duration - pausedS);
  // A frame cut by a range edge (shiftAnalysis keeps its full length in shownMs) counts for the part shown,
  // so a short range cannot average more frames than it has room for.
  const playN = a.shownMs ? a.frameMs.reduce((s, ms, i) => s + (isPlay(a.kind[i]) ? Math.min(1, ms / (a.shownMs[i] || ms)) : 0), 0) : playMs.length;
  // Lows and misses go by each frame's whole length: a 3 ms sliver of a cut frame is not a 3 ms frame.
  const playFull = a.shownMs ? a.shownMs.filter((_, i) => isPlay(a.kind[i])) : playMs;
  const play = frameStats(playFull, playS, targetMs, refreshMs, playN);
  const perSecond = perSecondFps(a);
  const finite = a.diffs.filter(Number.isFinite).sort((x, y) => x - y);
  const fpsVals = perSecond.map((r) => r[1]);
  const byKind = (k) => a.holds.filter((h) => h.kind === k);
  const list = (hs, n) => hs.slice(0, n).map((h) => [round(h.start, 2), round(h.ms, 1)]);
  // CapFrameX: time spent in frames longer than 2.5x the average frame time.
  const avgMs = play.game_frames ? 1000 / play.avg_fps : 0;
  const stutterMs = playMs.reduce((s, ms) => s + (ms > HOLD_X * avgMs ? ms : 0), 0);
  const holdCounts = { 1: 0, 2: 0, 3: 0, '4+': 0 };
  let even = 0;
  a.holdRefreshes.forEach((n, i) => {
    if (!isPlay(a.kind[i])) return;
    holdCounts[n >= 4 ? '4+' : Math.max(1, n)]++;
    if (n === a.kRef) even++;
  });
  const minutes = a.duration / 60;
  return {
    capture: {
      width: info.width, height: info.height,
      refresh_hz: round(a.hz, 3), seconds: round(a.duration, 2),
      refreshes: a.times.length, dropped_by_recorder: a.droppedRefreshes,
      dropped_at_s: a.droppedAt.map((t) => round(t, 2)),
    },
    ...play,
    all_frames: frameStats(a.frameMs, a.duration, targetMs, refreshMs),
    min_1s_fps: fpsVals.length ? Math.min(...fpsVals) : 0,
    max_1s_fps: fpsVals.length ? Math.max(...fpsVals) : 0,
    target_fps: a.target,
    holds: a.holds.slice(0, 40).map((h) => [round(h.start, 2), round(h.ms, 1), h.kind]),
    hitches: { count: byKind('hitch').length, first: list(byKind('hitch'), 20) },
    static_holds: { count: byKind('static').length, seconds: round(byKind('static').reduce((s, h) => s + h.ms, 0) / 1000, 2), first: list(byKind('static'), 20) },
    loading: { count: byKind('loading').length, seconds: round(byKind('loading').reduce((s, h) => s + h.ms, 0) / 1000, 2), first: list(byKind('loading'), 20) },
    stutter_time_pct: playS ? round(100 * stutterMs / 1000 / playS, 2) : 0.0,
    pacing: {
      even_pct: a.target === Math.round(a.hz) || !playMs.length ? null : round(100 * even / playMs.length, 2),
      holds: holdCounts,
    },
    tears: {
      count: a.tears.length,
      per_minute: minutes ? round(a.tears.length / minutes, 2) : 0.0,
      first: a.tears.slice(0, 50).map((t) => [round(t.time, 2), round(t.y, 3)]),
    },
    threshold: round(a.threshold, 3),
    threshold_source: a.thresholdSource,
    diff_percentiles: {
      p5: round(percentile(finite, 0.05), 3),
      p25: round(percentile(finite, 0.25), 3),
      p50: round(percentile(finite, 0.5), 3),
      p75: round(percentile(finite, 0.75), 3),
      p95: round(percentile(finite, 0.95), 3),
    },
  };
}

function writeCsvs(a, out) {
  const tearAt = new Map(a.tears.map((t) => [round(t.time, 6), t.y]));
  const r = ['refresh,time_s,diff,peak,luma,new_frame,tear_y'];
  a.times.forEach((t, i) => {
    const d = a.diffs[i], p = a.peaks[i], l = a.luma[i], y = tearAt.get(round(t, 6));
    r.push(`${i},${t.toFixed(4)},${Number.isFinite(d) ? d.toFixed(4) : ''},${Number.isFinite(p) ? p : ''},` +
      `${Number.isFinite(l) ? l.toFixed(2) : ''},${a.newFrame[i] ? 1 : 0},${y === undefined ? '' : y.toFixed(3)}`);
  });
  fs.writeFileSync(path.join(out, 'refreshes.csv'), r.join('\r\n') + '\r\n');
  const f = ['frame,start_s,frame_time_ms,hold_refreshes,kind'];
  a.starts.forEach((s, i) => f.push(`${i},${s.toFixed(4)},${a.frameMs[i].toFixed(2)},${a.holdRefreshes[i]},${a.kind[i]}`));
  fs.writeFileSync(path.join(out, 'frames.csv'), f.join('\r\n') + '\r\n');
  const p = ['second,fps'];
  for (const [sec, fps] of perSecondFps(a)) p.push(`${sec},${fps}`);
  fs.writeFileSync(path.join(out, 'per_second.csv'), p.join('\r\n') + '\r\n');
}

module.exports = {
  DEFAULT_THRESHOLD, PEAK_NEW, PEAK_MIN, HOLD_X, GRID_H,
  bisectLeft, bisectRight, measureDiffs, parseDiffs, otsuThreshold, percentile,
  targetsFor, inferTarget, analyse, perSecondFps, summarise, writeCsvs, isPlay, findTears,
};
