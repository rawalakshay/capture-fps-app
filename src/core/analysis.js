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

const fs = require('fs');
const path = require('path');
const { runFfmpeg, seekArgs, spanArgs } = require('./ffmpeg');

// A refresh counts as a new frame when the mean absolute luma difference to
// the previous refresh (0..255, on a downscaled grey image) is above this.
const DEFAULT_THRESHOLD = 0.4;
// A refresh is also a new frame when any pixel of the downscaled diff (a 3x3
// block at 1080p, 0..255) changed by at least this much. Encoder noise on a
// repeat peaked at 20 in 120 Mbps NVENC recordings and 31 at x264 CRF 23;
// real changes peaked at 87 or more.
const PEAK_NEW = 64;
// Frame caps a fixed 60 Hz signal can carry.
const TARGETS = [20, 30, 60];
// Frames on screen longer than this are listed for a human to check.
const STALL_MS = 200.0;

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

/**
 * [time_s, diff_to_previous, peak_diff] for every captured refresh; the first
 * one gets diff = Infinity (always a new frame).
 */
async function measureDiffs(video, work, { start, end, onProgress, signal, hwaccel = false } = {}) {
  // per process: two app windows may measure the same recording
  const names = [`diff_raw_${process.pid}.txt`, `diff_peak_${process.pid}.txt`];
  const vf = 'scale=640:-2:flags=area,format=gray,' +
    'tblend=all_mode=difference,signalstats,' +
    `metadata=mode=print:key=lavfi.signalstats.YAVG:file=${names[0]},` +
    `metadata=mode=print:key=lavfi.signalstats.YMAX:file=${names[1]}`;
  let texts;
  try {
    await runFfmpeg([
      '-y', ...(hwaccel ? ['-hwaccel', 'cuda'] : []), ...seekArgs(start), '-i', path.resolve(video),
      ...spanArgs(start, end),
      '-an', '-sn', '-dn', '-vf', vf, '-f', 'null', '-',
    ], { cwd: work, onProgress, signal });
    texts = names.map((n) => fs.readFileSync(path.join(work, n), 'utf8'));
  } finally {
    for (const n of names) fs.rmSync(path.join(work, n), { force: true });
  }
  const rows = parseDiffs(...texts);
  if (rows.length < 3) throw new Error('Too few frames measured; is this a video file?');
  return rows;
}

/** Rows from the metadata filters' text: lines of `pts_time:` then `lavfi.signalstats.YAVG=`
 * in text, and the same frames' `lavfi.signalstats.YMAX=` in peakText. */
function parseDiffs(text, peakText = '') {
  const { times, values: diffs } = parseMeta(text, 'YAVG');
  const peaks = parseMeta(peakText, 'YMAX').values;
  if (times.length < 2) return times.map((t, i) => [t, diffs[i], peaks[i]]);
  // tblend emits one frame per pair, stamped with the later frame; put the
  // very first refresh back in front of it.
  const period = times[1] - times[0];
  const first = times[0] - period;
  const rows = [[0.0, Infinity]];
  for (let i = 0; i < times.length; i++) rows.push([times[i] - first, diffs[i], peaks[i]]);
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

function inferTarget(avgFps) {
  for (const t of TARGETS) if (avgFps <= t * 1.05) return t;
  return TARGETS[TARGETS.length - 1];
}

function analyse(rows, hz, threshold, target) {
  const pts = rows.map((r) => r[0]);
  const diffs = rows.map((r) => r[1]);
  const peaks = rows.map((r) => r[2]);
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
    hz, droppedRefreshes: dropped, droppedAt, duration, times, diffs, peaks, newFrame: [],
    starts: [], frameMs: [], threshold: DEFAULT_THRESHOLD,
    thresholdSource: 'default', target: 60,
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
  a.newFrame = diffs.map((d, i) => d > a.threshold || peaks[i] >= PEAK_NEW);
  a.starts = times.filter((_, i) => a.newFrame[i]);
  for (let i = 0; i < a.starts.length; i++) {
    const end = i + 1 < a.starts.length ? a.starts[i + 1] : duration;
    a.frameMs.push((end - a.starts[i]) * 1000.0);
  }
  const avg = duration > 0 ? a.starts.length / duration : 0.0;
  a.target = target || inferTarget(avg);
  return a;
}

function perSecondFps(a) {
  const out = [];
  for (let sec = 0; sec < Math.floor(a.duration); sec++) {
    out.push([sec, bisectLeft(a.starts, sec + 1) - bisectLeft(a.starts, sec)]);
  }
  return out;
}

function summarise(a, info) {
  const fts = a.frameMs.slice().sort((x, y) => x - y);
  const n = a.frameMs.length;
  const avg = a.duration > 0 ? n / a.duration : 0.0;
  const p99 = percentile(fts, 0.99), p999 = percentile(fts, 0.999);
  const targetMs = 1000.0 / a.target;
  const refreshMs = a.hz ? 1000.0 / a.hz : targetMs;
  // A frame "misses" when it stays on screen at least one refresh longer
  // than the cap allows.
  const missed = a.frameMs.filter((ms) => ms > targetMs + refreshMs * 0.5).length;
  const perSecond = perSecondFps(a);
  const stalls = [];
  a.starts.forEach((s, i) => {
    if (a.frameMs[i] >= STALL_MS) stalls.push([round(s, 2), round(a.frameMs[i], 1)]);
  });
  const finite = a.diffs.filter(Number.isFinite).sort((x, y) => x - y);
  const fpsVals = perSecond.map((r) => r[1]);
  return {
    capture: {
      width: info.width, height: info.height,
      refresh_hz: round(a.hz, 3), seconds: round(a.duration, 2),
      refreshes: a.times.length, dropped_by_recorder: a.droppedRefreshes,
      dropped_at_s: a.droppedAt.map((t) => round(t, 2)),
    },
    game_frames: n,
    avg_fps: round(avg, 2),
    low_1pct_fps: p99 ? round(1000.0 / p99, 2) : 0.0,
    low_0_1pct_fps: p999 ? round(1000.0 / p999, 2) : 0.0,
    min_1s_fps: fpsVals.length ? Math.min(...fpsVals) : 0,
    max_1s_fps: fpsVals.length ? Math.max(...fpsVals) : 0,
    target_fps: a.target,
    frames_missing_target: missed,
    frames_missing_target_pct: n ? round(100.0 * missed / n, 2) : 0.0,
    longest_frame_ms: fts.length ? round(fts[fts.length - 1], 1) : 0.0,
    possible_stalls_or_static_scenes: stalls.slice(0, 20),
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
  const r = ['refresh,time_s,diff,peak,new_frame'];
  a.times.forEach((t, i) => {
    const d = a.diffs[i], p = a.peaks[i];
    r.push(`${i},${t.toFixed(4)},${Number.isFinite(d) ? d.toFixed(4) : ''},${Number.isFinite(p) ? p : ''},${a.newFrame[i] ? 1 : 0}`);
  });
  fs.writeFileSync(path.join(out, 'refreshes.csv'), r.join('\r\n') + '\r\n');
  const f = ['frame,start_s,frame_time_ms'];
  a.starts.forEach((s, i) => f.push(`${i},${s.toFixed(4)},${a.frameMs[i].toFixed(2)}`));
  fs.writeFileSync(path.join(out, 'frames.csv'), f.join('\r\n') + '\r\n');
  const p = ['second,fps'];
  for (const [sec, fps] of perSecondFps(a)) p.push(`${sec},${fps}`);
  fs.writeFileSync(path.join(out, 'per_second.csv'), p.join('\r\n') + '\r\n');
}

module.exports = {
  DEFAULT_THRESHOLD, PEAK_NEW, TARGETS, STALL_MS,
  bisectLeft, bisectRight, measureDiffs, parseDiffs, otsuThreshold, percentile,
  inferTarget, analyse, perSecondFps, summarise, writeCsvs,
};
