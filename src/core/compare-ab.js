'use strict';
// A/B: two saved analyses side by side in one video, and the single-video
// 'bands' look built from the same parts. Laid out in px of the design's
// 720-high board and scaled to the output height. Nothing is drawn in the
// bottom 8 % of the frame, where YouTube's player controls sit.

const fs = require('fs');
const path = require('path');
const { probe } = require('./ffmpeg');
const { isPlay, summarise } = require('./analysis');
const { Overlay, THEMES, weightedFrames, assColor, rectsPath, roundedPath, monoW, fmtMs, cleanText, freezeAt } = require('./overlay');

// Names, the verdict and the end card's labels are Inter, as in the design (assets/fonts/Inter-*.ttf for libass).
// Inter SemiBold's advance widths in em for ' ' to '~' (from its hmtx), so names are measured, not guessed.
const INTER_W = ('.252 .321 .523 .644 .65 1.004 .663 .326 .373 .373 .54 .673 .319 .465 .319 .379 .66 .423 .623 .636 .666 .612 .64 .576 .64 .64 ' +
  '.319 .329 .673 .673 .673 .543 .999 .728 .659 .737 .722 .605 .588 .749 .746 .277 .58 .703 .565 .922 .759 .769 .645 .773 .652 .65 .66 .736 .728 ' +
  '1.02 .72 .713 .652 .373 .379 .373 .481 .469 .351 .574 .624 .583 .624 .591 .389 .625 .612 .262 .262 .569 .262 .9 .612 .609 .624 .624 .397 .549 ' +
  '.353 .612 .587 .839 .569 .588 .566 .455 .359 .455 .673').split(' ').map(Number);
const INTER_X = { '·': 0.319, '–': 0.5, '…': 0.956 };
const nameW = (s, size) => {
  let em = 0;
  for (const ch of s) { const c = ch.charCodeAt(0); em += c >= 32 && c <= 126 ? INTER_W[c - 32] : INTER_X[ch] ?? 0.65; }
  return em * size;
};

const AB_COLORS = Object.freeze([0x4F9CF9, 0xC084FC, 0x34D399]); // A, B, C
const LETTERS = 'ABC';
const INK = 0x0B0C0F;                                   // letters on the A/B tags and the red pills
const WHITE = 0xF5F6F8;
const THEME = Object.freeze({
  ...THEMES.classic, SANS_MED: 'Inter Medium', SANS_SEMI: 'Inter SemiBold', PANEL: 0x0A0C0F, PANEL_A: 0.92, TEXT: WHITE, LABEL: 0xA3A9B5, DIM: 0xA3A9B5,
  FOOT: 0x8E95A3, AMBER: 0xF5B544, RED: 0xF2555C,
});
const WATERMARK = '4aLse Benchmarks';
const AB_END_CARD_S = 5;
const FT_WIN = 10;                        // seconds of frame times on screen
const FPS_TOP = 0.219, FPS_HALF = 0.9375; // where the target and half of it sit in an FPS graph, from its top
const HITCH_TAG_S = 1;
const HOLD_SHOW_S = 0.5;                  // stills and loads shorter than this are dimmed but not labelled
const HOLD_NAMES = Object.freeze({ static: 'STILL', loading: 'LOADING', gap: 'NO VIDEO' });
// Type sizes and graph gutters on the 16:9 board and the wider 21:9 one.
const NARROW = Object.freeze({ label: 18, hero: 56, heroGap: 6, hold: 44, fpsGutter: 28, ftGutter: 56 });
const WIDE = Object.freeze({ label: 20, hero: 72, heroGap: 14, hold: 56, fpsGutter: 32, ftGutter: 62 });
// Output sizes per frame shape; 21:9 is 64:27 (2560x1080).
const AB_SIZES = Object.freeze({
  '16:9': { 1080: [1920, 1080], 1440: [2560, 1440], 2160: [3840, 2160] },
  '21:9': { 1080: [2560, 1080], 2160: [5120, 2160] },
});
const SEAM = 2; // px of black between the videos of the three-up look
const even = (v) => Math.round(v / 2) * 2;
/** Left edges of the three-up columns and the right edge of the frame: even widths that fill W (852/854 at 2560). */
const thirds = (W) => [0, even(W / 3), even(2 * W / 3), W];

/**
 * Where the videos sit in a W x H frame of n panes: [{ x, y, w, h }], and how the source fills
 * each ('fit': all of it, letterboxed; 'cover': filling it, cropped). The A/B looks halve the
 * frame; 'third' is three columns with 2 px seams, the video 72 to 552 of the 720-high board.
 */
function videoRects(frame, fit, W, H) {
  const k = H / 720;
  if (fit === 'third') {
    const b = thirds(W), y = even(72 * k), h = even(480 * k);
    return { mode: 'cover', rects: [0, 1, 2].map((i) => ({ x: b[i] + (i ? SEAM : 0), y, w: b[i + 1] - b[i] - (i ? SEAM : 0), h })) };
  }
  const half = W / 2;
  const vh = fit === 'crop' ? H : even(half * 9 / 16);
  const top = fit === 'letterbox' ? even((frame === '21:9' ? 60 : 180) * k) : 0;
  return { mode: fit === 'crop' ? 'cover' : 'fit', rects: [0, 1].map((i) => ({ x: i * half, y: top, w: half, h: vh })) };
}

const f1 = (v) => v.toFixed(1);
const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
/** Baseline of a line of Plex text (ascent 1.025 em, descent 0.275 em) whose box is `top`, or centred on `cy`. */
const baseOf = (top, size) => top + 1.025 * size;
const mid = (cy, size) => cy + 0.375 * size;
/** Text colour of a share of the target, in %: on target, a little under, well under. */
const band = (pct) => (pct == null ? WHITE : pct >= 95 ? WHITE : pct >= 80 ? THEME.AMBER : THEME.RED);
const pctOf = (v, target) => (v == null || !target ? null : 100 * v / target);
/** The band of a number as it is shown (to 0.1), so 56.96 printed as 57.0 is not amber in one place and white in another. */
const bandShown = (v, target) => band(pctOf(v == null ? null : Number(v.toFixed(1)), target));
/** Share of its own target, capped at 100: what two different targets are compared on. */
const ownPct = (v, target) => (pctOf(v, target) == null ? null : Math.min(100, pctOf(v, target)));

/** s cut with an ellipsis to fit maxW as measured by width(). */
function fitText(s, maxW, width) {
  s = cleanText(s);
  if (width(s) <= maxW) return s;
  while (s.length > 1 && width(`${s}…`) > maxW) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

/** Words of s in lines no wider than maxW. */
function wrap(s, maxW, width) {
  const lines = [];
  for (const word of s.split(' ')) {
    const last = lines[lines.length - 1];
    if (last !== undefined && width(`${last} ${word}`) <= maxW) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
}

/** A polyline as one drawing of quads, `width` thick; null points break it. Square caps fill the joins. */
function strokePath(points, width) {
  const h = width / 2, parts = [];
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1], q = points[i];
    if (!p || !q) continue;
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const ux = (q[0] - p[0]) / len * h, uy = (q[1] - p[1]) / len * h;
    const c = [[p[0] - ux - uy, p[1] - uy + ux], [q[0] + ux - uy, q[1] + uy + ux], [q[0] + ux + uy, q[1] + uy - ux], [p[0] - ux + uy, p[1] - uy - ux]];
    parts.push(`m ${f1(c[0][0])} ${f1(c[0][1])} l ${c.slice(1).map(([x, y]) => `${f1(x)} ${f1(y)}`).join(' ')}`);
  }
  return parts.join(' ');
}

// ---- a saved analysis ----

function readCsv(file) {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((r) => r.split(','));
}

/** summary.json, per_second.csv and frames.csv of an output folder, and the analysis fields the overlay reads. */
function readAnalysis(outDir) {
  const dir = path.resolve(String(outDir || ''));
  const need = (name) => {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) throw new Error(`${name} is missing from ${dir}. Analyse that video again.`);
    return f;
  };
  const summary = JSON.parse(fs.readFileSync(need('summary.json'), 'utf8'));
  const perSecond = readCsv(need('per_second.csv')).slice(1).map(([s, f]) => [Number(s), Number(f)]);
  const [head = [], ...rows] = readCsv(need('frames.csv'));
  // Folders from before stills, loads and hitches were told apart have neither the columns nor the counts.
  if (head[3] !== 'hold_refreshes' || head[4] !== 'kind' || !summary.hitches || !summary.pacing) {
    throw new Error(`frames.csv in ${dir} is from an older version. Analyse that video again.`);
  }
  const cap = summary.capture || {};
  const a = {
    starts: rows.map((r) => Number(r[1])), frameMs: rows.map((r) => Number(r[2])),
    holdRefreshes: rows.map((r) => Number(r[3])), kind: rows.map((r) => r[4] || 'ok'),
    target: summary.target_fps, hz: cap.refresh_hz, duration: cap.seconds,
    holds: [], droppedAt: [], tears: [], times: [], diffs: [], peaks: [], luma: [], newFrame: [],
    droppedRefreshes: cap.dropped_by_recorder || 0, threshold: summary.threshold, thresholdSource: summary.threshold_source,
  };
  // capture.seconds is rounded to 0.01 s; the end of the last frame is the exact length summary.json was made from.
  const n = a.starts.length, end = n ? a.starts[n - 1] + a.frameMs[n - 1] / 1000 : null;
  if (end != null && Math.abs(end - (cap.seconds ?? end)) < 0.011) a.duration = end;
  a.kRef = Math.max(1, Math.round((a.hz || a.target) / a.target));
  a.kind.forEach((k, i) => { if (k !== 'ok') a.holds.push({ start: a.starts[i], ms: a.frameMs[i], kind: k }); });
  return { outDir: dir, summary, perSecond, a };
}

/** Where an analysis starts in its video (s), checked against the video's probed duration: folders from before
 * start_s was saved are taken as starting at 0 only when they cover the whole video. */
function analysisStart(read, duration) {
  const cap = read.summary.capture || {};
  if (cap.start_s != null) return Number(cap.start_s) || 0;
  if (Math.abs((Number(cap.seconds) || 0) - duration) <= 1) return 0;
  throw new Error(`The analysis in ${read.outDir} is from an older version. Analyse that video again.`);
}

/** A saved analysis: { video, outDir, info, summary, perSecond, a }; video is probed when given. */
async function loadAnalysis(outDir, video = null) {
  const r = readAnalysis(outDir);
  const cap = r.summary.capture || {};
  const info = video ? await probe(path.resolve(video))
    : { width: cap.width, height: cap.height, hz: cap.refresh_hz, duration: cap.seconds, audioCodec: null };
  info.fps = info.hz;
  return { video: video ? path.resolve(video) : null, ...r, info };
}

/** Stills and loads with neighbours under 0.25 s apart merged: [{ t0, t1, kind, longest }]. */
function mergeHolds({ starts, frameMs, kind }) {
  const spans = [];
  for (let i = 0; i < starts.length; i++) {
    if (isPlay(kind[i])) continue;
    const t0 = starts[i], t1 = t0 + frameMs[i] / 1000, last = spans[spans.length - 1];
    // A gap between clips is never merged with a still or load beside it: there is video on one side.
    if (last && t0 - last.t1 < 0.25 && (last.kind === 'gap') === (kind[i] === 'gap')) {
      last.t1 = t1;
      if (frameMs[i] > last.longest) Object.assign(last, { longest: frameMs[i], kind: kind[i] });
    } else spans.push({ t0, t1, kind: kind[i], longest: frameMs[i] });
  }
  return spans;
}

/** What the window draws for one side: hitches, stills and loads as the export labels them, play FPS
 * and the worst play frame of each second. */
function abData(outDir, read = readAnalysis(outDir)) {
  const { summary, perSecond, a } = read;
  const r = (v, n) => Math.round(v * 10 ** n) / 10 ** n;
  const worst = new Map();
  a.starts.forEach((s, i) => {
    if (!isPlay(a.kind[i])) return;
    const sec = Math.floor(s);
    if (!(worst.get(sec) >= a.frameMs[i])) worst.set(sec, a.frameMs[i]);
  });
  // Play FPS of each whole second: stills and loads come off its time, as in the export; null when mostly held.
  const ends = a.starts.map((s, i) => s + a.frameMs[i] / 1000), held = perSecond.map(() => 0);
  a.starts.forEach((s, i) => {
    if (isPlay(a.kind[i])) return;
    for (let sec = Math.floor(s); sec < ends[i] && sec < held.length; sec++) held[sec] += Math.min(ends[i], sec + 1) - Math.max(s, sec);
  });
  const playFps = perSecond.map(([sec], i) => [sec, held[i] <= 0.5 ? r(weightedFrames(a.starts, ends, sec, sec + 1, Infinity, 0, a.kind) / (1 - held[i]), 2) : null]);
  return {
    summary, perSecond, playFps,
    hitches: a.holds.filter((h) => h.kind === 'hitch').map((h) => [r(h.start, 3), r(h.ms, 1)]),
    paused: mergeHolds(a).filter((h) => h.t1 - h.t0 >= HOLD_SHOW_S).map((h) => [r(h.t0, 3), r((h.t1 - h.t0) * 1000, 1), h.kind]),
    ftMax: perSecond.map(([sec], i) => [sec, worst.has(sec) && held[i] <= 0.5 ? r(worst.get(sec), 1) : null]), // breaks where playFps does
  };
}

/** The analysis on the output's clock: the part from skip to skip + span, starting at 0. Frames cut at
 * either end keep their whole frame time in shownMs, so the frame-time graph does not dip at the cut. */
function shiftAnalysis(a, skip, span) {
  const out = { ...a, starts: [], frameMs: [], shownMs: [], holdRefreshes: [], kind: [], holds: [], droppedAt: [], tears: [], duration: span };
  for (let i = 0; i < a.starts.length; i++) {
    const s = a.starts[i] - skip, e = s + a.frameMs[i] / 1000;
    // frames.csv keeps times to 0.1 ms: a frame ending or starting that close to a cut is a rounding sliver, not a frame.
    if (e <= 1e-4) continue;
    if (s >= span - 1e-4) break;
    const st = Math.max(0, s), ms = (Math.min(e, span) - st) * 1000;
    out.starts.push(st); out.frameMs.push(ms); out.shownMs.push(a.frameMs[i]); out.holdRefreshes.push(a.holdRefreshes[i]); out.kind.push(a.kind[i]);
    // A hold that began before the cut is not counted again as one (the window's hitch table drops it too).
    if (a.kind[i] !== 'ok' && s >= 0) out.holds.push({ start: st, ms, kind: a.kind[i] });
  }
  return out;
}

/** The numbers of the part of a saved analysis that is on screen: from skip, span seconds long. */
function overlapSummary(outDir, skip, span) {
  const { summary, a } = readAnalysis(outDir);
  return summarise(shiftAnalysis(a, Math.max(0, Number(skip) || 0), Math.max(0, Number(span) || 0)), summary.capture);
}

// ---- the verdict and the end card's rows ----

/** Pacing in %, or null when the target is the refresh rate (unlocked: no cap to pace to), as the window shows it. */
const pacingPct = (s) => (s.pacing && s.pacing.even_pct != null ? s.pacing.even_pct : null);

const timesWord = (n) => `${n} time${n === 1 ? '' : 's'}`;

/** One plain-English line on which run held up better. titles name A and B. */
function verdict(sumA, sumB, titles = ['A', 'B']) {
  const [nA, nB] = titles;
  const hA = sumA.hitches.count, hB = sumB.hitches.count;
  if (sumA.target_fps === sumB.target_fps) {
    const t = sumA.target_fps;
    const aFirst = sumA.avg_fps > sumB.avg_fps || (sumA.avg_fps === sumB.avg_fps && hA <= hB);
    const [w, l, sw, sl, hw, hl] = aFirst ? [nA, nB, sumA, sumB, hA, hB] : [nB, nA, sumB, sumA, hB, hA];
    // "Holds" and "stays close" need the 1% low out of the red band too, as the numbers under the sentence show.
    const steady = sw.low_1pct_fps == null || sw.low_1pct_fps >= 0.8 * t;
    const first = steady && sw.avg_fps >= 0.98 * t ? `${w} holds ${t} fps almost everywhere.`
      : steady && sw.avg_fps >= 0.9 * t ? `${w} stays close to ${t} fps, averaging ${sw.avg_fps.toFixed(1)}.`
        : `${w} averages ${sw.avg_fps.toFixed(1)} fps against a ${t} fps target.`;
    const d = sw.avg_fps - sl.avg_fps;
    const pace = d < 0.05 ? `${l} matches it on average` : `${l} runs ${d.toFixed(1)} fps lower`;
    const hitch = hl > hw ? (hw ? ` and hitches ${timesWord(hl)} to ${w}'s ${hw}.` : ` and hitches ${timesWord(hl)} while ${w} has none.`)
      : hl === hw ? (hl ? `, and both hitch ${timesWord(hl)}.` : ', and neither hitches.')
        : hl ? `, but hitches only ${timesWord(hl)} to ${w}'s ${hw}.` : `, but never hitches (${w} hitches ${timesWord(hw)}).`;
    return `${first} ${pace}${hitch}`;
  }
  // Different targets: how well each holds its own. Running over a target is not better than holding it.
  const p = (s) => ({ avg: ownPct(s.avg_fps, s.target_fps), low: ownPct(s.low_1pct_fps, s.target_fps) });
  const pA = p(sumA), pB = p(sumB), okA = pA.avg >= 97, okB = pB.avg >= 97;
  const own = (n, s, q) => `${n} averages ${Math.round(q.avg)} % of its ${s.target_fps} fps target`;
  const over = [[nA, sumA], [nB, sumB]].filter(([, s]) => pctOf(s.avg_fps, s.target_fps) > 110)
    .map(([n, s]) => ` ${n} runs well above its ${s.target_fps} fps target; check the target setting.`).join('');
  let text;
  if (okA && okB) {
    if (Math.round(pA.low) === Math.round(pB.low)) text = 'Both hold their targets equally well.';
    else {
      const [w, hi, lo] = pA.low > pB.low ? [nA, pA.low, pB.low] : [nB, pB.low, pA.low];
      text = `Both hold their targets; ${w} is steadier, 1% low ${Math.round(hi)} % of target vs ${Math.round(lo)} %.`;
    }
  } else if (okA || okB) {
    const [w, sw, l, sl, ql] = okA ? [nA, sumA, nB, sumB, pB] : [nB, sumB, nA, sumA, pA];
    text = `${w} holds its ${sw.target_fps} fps target; ${own(l, sl, ql)}.`;
  } else text = `Neither holds its target: ${own(nA, sumA, pA)}, ${own(nB, sumB, pB)}.`;
  return text + over;
}

/** The end card's rows: [label, A text, B text, A colour, B colour, { side: 0|1|null, text }]. */
function abRows(sA, sB) {
  const mixed = sA.target_fps !== sB.target_fps;
  const better = (d, text) => (text === null ? { side: null, text: 'Even' } : { side: d > 0 ? 0 : 1, text: `${d > 0 ? 'A' : 'B'} ${text}` });
  const fps = (label, key) => {
    // The gap is taken from the numbers as shown, so the chip agrees with the two beside it.
    const a = Number(sA[key].toFixed(1)), b = Number(sB[key].toFixed(1)), pa = pctOf(a, sA.target_fps), pb = pctOf(b, sB.target_fps);
    const d = mixed ? Math.round(ownPct(a, sA.target_fps)) - Math.round(ownPct(b, sB.target_fps)) : a - b;
    const shown = mixed ? Math.abs(d).toFixed(0) : Math.abs(d).toFixed(1);
    return [label, a.toFixed(1), b.toFixed(1), band(pa), band(pb), better(d, Number(shown) ? `+${shown}${mixed ? ' pts' : ''}` : null)];
  };
  const hA = sA.hitches.count, hB = sB.hitches.count;
  // Pacing is shown and banded as a whole %, so a 94.6 that reads 95% is not amber.
  const whole = (v) => (v == null ? null : Math.round(v)), pa = whole(pacingPct(sA)), pb = whole(pacingPct(sB)), dp = (pa ?? 0) - (pb ?? 0);
  const pct = (v) => (v == null ? '–' : `${Math.round(v)}%`);
  // Unlocked (target = refresh rate, the usual 60 on 60 Hz) has no pacing: missed target takes its row, as the window has it.
  const ma = Number((sA.frames_missing_target_pct || 0).toFixed(1)), mb = Number((sB.frames_missing_target_pct || 0).toFixed(1));
  const last = pa == null || pb == null
    ? ['Missed target', `${ma.toFixed(1)}%`, `${mb.toFixed(1)}%`, WHITE, WHITE, better(mb - ma, Math.abs(mb - ma) < 0.05 ? null : `−${Math.abs(mb - ma).toFixed(1)}`)]
    : ['Pacing', pct(pa), pct(pb), band(pa), band(pb), better(dp, !Math.round(dp) ? null : `+${Math.abs(Math.round(dp))} pts`)];
  return [
    fps('Average', 'avg_fps'), fps('1% low', 'low_1pct_fps'), fps('0.1% low', 'low_0_1pct_fps'),
    ['Hitches', String(hA), String(hB), WHITE, WHITE, better(hB - hA, hA === hB ? null : `${Math.abs(hB - hA)} fewer`)],
    last,
  ];
}

const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Three runs: who holds their own target best (by % of it, capped at 100), and who hitches most. */
function verdictN(sums, names) {
  const r = sums.map((s) => Math.round(ownPct(s.avg_fps, s.target_fps) ?? 0));
  const low = sums.map((s) => ownPct(s.low_1pct_fps, s.target_fps) ?? 0), h = sums.map((s) => s.hitches.count);
  const order = sums.map((_, i) => i).sort((p, q) => r[q] - r[p] || low[q] - low[p] || h[p] - h[q] || p - q);
  const w = order[0], tied = order.filter((i) => r[i] === r[w]).sort((p, q) => p - q), rest = order.filter((i) => r[i] !== r[w]);
  const others = rest.map((i, j) => `${names[i]} ${j ? '' : 'reaches '}${r[i]} %`).join(', ');
  let first;
  // "Hold" needs the 1% low out of the red too, as the numbers under the sentence show.
  const holds = (i) => r[i] >= 97 && low[i] >= 80;
  if (!rest.length) first = sums.every((_, i) => holds(i)) ? 'All three hold their targets equally well.' : `All three average ${r[w]} % of their targets.`;
  else if (tied.length > 1) first = `${andList(tied.map((i) => names[i]))} tie at ${r[w]} % of their targets; ${others}.`;
  else {
    const t = sums[w].target_fps;
    first = `${names[w]} does best, ${holds(w) ? `holding its ${t} fps target` : `averaging ${r[w]} % of its ${t} fps target`}; ${others}.`;
  }
  const mx = Math.max(...h), most = order.filter((i) => h[i] === mx).sort((p, q) => p - q).map((i) => names[i]);
  const second = !mx ? 'None of them hitches.' : most.length === 1 ? `${most[0]} hitches most, ${timesWord(mx)}.` : `${andList(most)} hitch most, ${timesWord(mx)} each.`;
  return `${first} ${second}`;
}

/** The end card's rows for three runs: [label, texts, colours, { side: best or null, text }]. */
function rowsN(sums) {
  const best = (keys, high) => {
    const vals = keys.filter((v) => v != null);
    if (!vals.length) return { side: null, text: 'Even' };
    const top = high ? Math.max(...vals) : Math.min(...vals), at = keys.flatMap((v, i) => (v === top ? [i] : []));
    return at.length > 1 ? { side: null, text: 'Even' } : { side: at[0], text: LETTERS[at[0]] };
  };
  const fps = (label, key) => {
    // Capped at the target as the verdict does: above the target is no better. With one target the shown
    // values are compared (as abRows does); mixed targets go by whole % of their own target.
    const shown = sums.map((s) => Number(s[key].toFixed(1))), same = sums.every((s) => s.target_fps === sums[0].target_fps);
    return [label, shown.map((v) => v.toFixed(1)), shown.map((v, i) => band(pctOf(v, sums[i].target_fps))),
      best(shown.map((v, i) => (same ? Math.min(v, sums[i].target_fps) : Math.round(ownPct(v, sums[i].target_fps)))), true)];
  };
  const h = sums.map((s) => s.hitches.count), pace = sums.map((s) => (pacingPct(s) == null ? null : Math.round(pacingPct(s))));
  const missed = sums.map((s) => Number((s.frames_missing_target_pct || 0).toFixed(1)));
  const last = pace.some((v) => v == null)
    ? ['Missed target', missed.map((v) => `${v.toFixed(1)}%`), missed.map(() => WHITE), best(missed, false)]
    : ['Pacing', pace.map((v) => `${v}%`), pace.map(band), best(pace, true)];
  return [
    fps('Average', 'avg_fps'), fps('1% low', 'low_1pct_fps'), fps('0.1% low', 'low_0_1pct_fps'),
    ['Hitches', h.map(String), h.map(() => WHITE), best(h, false)], last,
  ];
}

// ---- drawing ----

/** Overlay drawing in board px (720 high): x from the left of this.ox, y from the top of the frame. */
class Board extends Overlay {
  constructor(a, size, title, rate, position, capture, opts = {}) {
    super(a, size, title, rate, position, capture, { ...opts, longGraph: false, endCard: false });
    this.c = THEME;
    this.k = size.height / 720;
    this.AW = size.width / this.k;
    this.ox = 0;
    this.oy = 0;
    this.wide = size.width / size.height > 2;
    this.S = this.wide ? WIDE : NARROW;
  }

  drawFrame() {}
  // shortcut: tears are not marked in these looks; map them into the video pane if anyone misses them
  drawTears() {}

  X(x) { return this.px(this.ox + x); }

  box(t0, t1, x, y, w, h, color = this.c.PANEL, alpha = this.c.PANEL_A, r = 8, layer = 0) {
    this.shape(t0, t1, roundedPath(this.X(x), this.px(y), this.px(w), this.px(h), this.px(r)), color, alpha, layer);
  }

  label(t0, t1, x, baseline, s, { size = this.S.label, color = this.c.LABEL, align = 'l', font = this.c.MONO, layer = 3 } = {}) {
    this.text(t0, t1, x, baseline, this.run(s, font, size, color), size, align, layer);
  }

  /** A 1 px line dashed 4 on, 4 off. */
  dashed(t0, t1, x, y, w, color, alpha, layer = 1) {
    const r = [];
    for (let d = 0; d < w; d += 8) r.push([x + d, y, Math.min(4, w - d), 1]);
    this.rects(t0, t1, r, color, alpha, layer);
  }

  /** The A, B or C square with its letter. */
  tag(t0, t1, x, y, size, side, font = Math.round(size * 0.555), r = size >= 40 ? 8 : size >= 36 ? 7 : 6) {
    this.box(t0, t1, x, y, size, size, AB_COLORS[side], 1, r, 1);
    this.text(t0, t1, x + size / 2, mid(y + size / 2, font), this.run(LETTERS[side], this.c.MONO_SEMI, font, INK), font, 'c', 2);
  }

  /** Stills and loads, neighbours under 0.25 s apart merged; only those of at least minS. */
  holdSpans(minS = HOLD_SHOW_S) {
    if (!this.allHolds) this.allHolds = mergeHolds(this.a);
    return this.allHolds.filter((s) => s.t1 - s.t0 >= minS);
  }

  /** Play FPS over the clip in slices, null where a slice is mostly still or loading. */
  playFps(D) {
    const { starts, kind } = this.a, step = Math.min(1, Math.max(0.25, D / 120)), out = [];
    for (let t0 = 0; t0 < D - 1e-6; t0 += step) {
      const t1 = Math.min(D, t0 + step), live = t1 - t0 - this.pausedIn(t0, t1, Infinity);
      out.push([(t0 + t1) / 2, live >= (t1 - t0) / 2 ? weightedFrames(starts, this.ends, t0, t1, Infinity, this.m.floorS, kind) / live : null]);
    }
    return out;
  }

  /** The whole clip's FPS: drawn in full at 40 %, the played part solid, a playhead; plot area g. */
  fpsGraph(D, g, color) {
    const { x, y, w, h } = g, { target } = this.m, S = this.S, ms = Math.round(D * 1000);
    const yOf = (fps) => y + h * Math.min(1, Math.max(0, FPS_TOP + (target - fps) / (target / 2) * (FPS_HALF - FPS_TOP)));
    const xOf = (t) => x + w * Math.min(1, Math.max(0, t / D));
    this.rects(0, D, [[x, yOf(target / 2), w, 1]], WHITE, 0.15, 1);
    this.dashed(0, D, x, yOf(target), w, WHITE, 0.45);
    // A still or a load is a dimmed band, never a drop to 0. Its name sits above the graph in the 'FPS' header's
    // row, from the band's left edge: clear of the line, the target line and the playhead. Names that would touch skip.
    // A gap's name and a still's close together would read as one phrase ('STILL NO VIDEO'): the gap keeps its name.
    let free = x + monoW(g.head || 'FPS', S.label) + 12, last = null;
    const spans = this.holdSpans(0), named = new Map();
    for (const s of spans) {
      const bx = xOf(s.t0), bw = Math.max(1, xOf(s.t1) - bx), name = HOLD_NAMES[s.kind], nw = monoW(name, S.label);
      const lx = Math.max(free, Math.min(bx, x + w - nw));
      if (s.t1 - s.t0 >= HOLD_SHOW_S && lx + nw <= x + w + 0.5 && lx <= bx + bw) {
        if (last && (s.kind === 'gap') !== (last.kind === 'gap') && lx - last.end < monoW('STILL', S.label)) {
          if (s.kind !== 'gap') continue;
          named.delete(last.s);
        }
        named.set(s, lx);
        last = { s, kind: s.kind, end: lx + nw };
        free = lx + nw + 8;
      }
    }
    for (const s of spans) {
      const bx = xOf(s.t0);
      this.rects(0, D, [[bx, y, Math.max(1, xOf(s.t1) - bx), h]], WHITE, 0.14, 1);
      // A gap is named only while the playhead is in it: on the header line for the whole export it reads as a status.
      if (named.has(s)) this.label(s.kind === 'gap' ? s.t0 : 0, s.kind === 'gap' ? Math.min(s.t1, D) : D, named.get(s), y - 4 - 0.275 * S.label, HOLD_NAMES[s.kind], { color: WHITE });
    }
    const pts = this.playFps(D).map(([t, fps]) => (fps == null ? null : [this.X(xOf(t)), this.px(yOf(fps))]));
    const line = strokePath(pts, this.px(3));
    if (line) {
      this.emit(1, 0, D, this.shapeBody(line, color, 0.4));
      const pad = this.px(4), x0 = Math.floor(this.X(x) - pad), y0 = Math.floor(this.px(y) - pad), y1 = Math.ceil(this.px(y + h) + pad);
      const clip = (right) => `\\clip(${x0},${y0},${Math.round(right)},${y1})`;
      this.emit(2, 0, D, this.shapeBody(line, color, 1, null, 0, `${clip(this.X(x))}\\t(0,${ms},${clip(this.X(x + w))})`));
    }
    this.emit(3, 0, D, `{\\an7\\move(${f1(this.X(x) - this.px(1))},${f1(this.px(y))},${f1(this.X(x + w) - this.px(1))},${f1(this.px(y))},0,${ms})` +
      `\\shad0\\bord0\\p1\\c${assColor(WHITE)}}${rectsPath([[0, 0, this.px(2), this.px(h)]])}{\\p0}`);
    const right = x + w + S.fpsGutter;
    this.label(0, D, right, mid(yOf(target), S.label), String(target), { color: WHITE, align: 'r' });
    this.label(0, D, right, mid(yOf(target / 2), S.label), fmtMs(target / 2), { align: 'r' });
  }

  /** Frame-time grid: 0 to 4 target frames, a dashed target line, labels in the gutter. */
  ftChrome(D, { x, y, w, h, grid2 }) {
    const { targetMs } = this.m, right = x + w + this.S.ftGutter;
    this.rects(0, D, [[x, y + h * 0.25, w, 1]], WHITE, 0.15, 1);
    if (grid2) this.rects(0, D, [[x, y + h * 0.5, w, 1]], WHITE, 0.1, 1);
    this.dashed(0, D, x, y + h * 0.75, w, WHITE, 0.6, 3);
    this.label(0, D, right, mid(y + h * 0.25, this.S.label), fmtMs(3 * targetMs), { align: 'r' });
    this.label(0, D, right, mid(y + h * 0.75, this.S.label), fmtMs(targetMs), { color: WHITE, align: 'r' });
  }

  /** The last 10 s of frame times scrolling left: one moving event per frame, newest at the right edge.
   * Spikes over the scale are capped with their value; stills and loads are dimmed, labelled bands. */
  ftMoving(D, { x, y, w, h, head }, color) {
    const { targetMs } = this.m, scale = 4 * targetMs, speed = w / FT_WIN, lw = 3, S = this.S, c = this.c;
    const { starts, kind } = this.a, frameMs = this.a.shownMs || this.a.frameMs, ends = this.ends, xR = x + w, P = (v) => this.px(v);
    const clip = `\\clip(${Math.floor(this.X(x))},${Math.floor(P(y - lw))},${Math.ceil(this.X(xR))},${Math.ceil(P(y + h + lw))})`;
    const yOf = (ms) => y + h * (1 - Math.min(1, ms / scale));
    const fill = (col, alpha = 1) => `\\p1\\c${assColor(col)}${alpha < 1 ? `\\1a&H${hex2(Math.round((1 - alpha) * 255))}&` : ''}`;
    // Anchored at (ax, ay) in board px, gliding left at the window's speed for `life` seconds.
    const moving = (layer, t0, life, ax, ay, tags, content) => {
      if (Math.min(D, t0 + life) > t0) {
        this.emit(layer, t0, Math.min(D, t0 + life), `{\\an7\\move(${f1(this.X(ax))},${f1(P(ay))},${f1(this.X(ax - speed * life))},${f1(P(ay))},0,${Math.round(life * 1000)})` +
          `${clip}\\shad0\\bord0${tags}}${content}`);
      }
    };
    // Stills and loads: one dimmed band per span, the spans the FPS graph uses; frames inside one are not drawn.
    const spans = this.holdSpans(0), hidden = [];
    for (let i = 0, j = 0; i < starts.length; i++) {
      while (j < spans.length && spans[j].t1 <= starts[i] + 1e-9) j++;
      hidden.push(!isPlay(kind[i]) || (j < spans.length && starts[i] >= spans[j].t0 - 1e-9));
    }
    for (const s of spans) {
      moving(1, s.t0, s.t1 - s.t0 + FT_WIN, xR, y, fill(WHITE, 0.14), `${rectsPath([[0, 0, P((s.t1 - s.t0) * speed), P(h)]])}{\\p0}`);
    }
    const caps = [], win = this.opts.window; // [t0, t1]: only the frames on screen then are drawn
    for (let i = 0; i < starts.length; i++) {
      const ms = frameMs[i], te = ends[i];
      if (hidden[i] || (win && (te + FT_WIN < win[0] || starts[i] > win[1]))) continue;
      // A step: up (or down) at the frame's start, then level for as long as it lasted, so a long frame reads as one;
      // just the level after a gap. It comes in as the frame starts, so a hitch's spike is up while its HITCH tag is.
      const dx = (te - starts[i]) * speed, ax = xR - 2 * lw, ay = y - 2 * lw, x0 = P(2 * lw);
      const pts = [...(i > 0 && !hidden[i - 1] ? [[x0, P(yOf(frameMs[i - 1]) - ay)]] : []), [x0, P(yOf(ms) - ay)], [P(dx + 2 * lw), P(yOf(ms) - ay)]];
      moving(2, starts[i], FT_WIN + te - starts[i], ax, ay, fill(color), `${strokePath(pts, P(lw))}{\\p0}`);
      if (ms > scale * 1.001) {
        // ▲ comes from a fallback font, about half an em wider than a Plex Mono cell
        // It comes in with the spike (the frame's length is known from its start) and goes before it would be cut at the
        // graph's left edge; the spike itself scrolls on out.
        const s = `▲ ${Math.round(ms)} ms`, pw = monoW(s, S.label) + 0.5 * S.label + 10, m = { te: starts[i], ms, s, pw, life: Math.max(0, (w - 6 - pw) / speed) };
        // Two markers must not run together: of those that would touch, the biggest stays on screen.
        const near = [];
        for (let j = caps.length - 1; j >= 0 && m.te - caps[j].te < FT_WIN + 2 * w / speed; j--) {
          if (caps[j].te + caps[j].life > m.te && (m.te - caps[j].te) * speed < pw + 8) near.push(caps[j]);
        }
        if (near.every((k) => k.ms < ms)) {
          for (const k of near) k.life = m.te - k.te;
          caps.push(m);
        }
      }
    }
    for (const m of caps) {
      moving(3, m.te, m.life, xR - 6 - m.pw, y, fill(c.RED), `${roundedPath(0, 0, P(m.pw), P(1.3 * S.label), P(4))}{\\p0}`);
      moving(4, m.te, m.life, xR - 1 - m.pw, y, '', this.run(m.s, c.MONO_SEMI, S.label, INK));
    }
    if (head) this.ftHoldNames(D, head, xR, speed);
  }

  /** Hold names in the frame-time header's free stretch (head: x0 to x1, room = x1 - x0 with a watermark), as the
   * FPS graph has them: never over the line, the ▲ markers or the target line, however short the graph. Each
   * starts at its band's left edge, held back from the right end until the band reaches it, and slides out at x0. */
  ftHoldNames(D, head, xR, speed) {
    const S = this.S, c = this.c, P = (v) => this.px(v), top = head.base - 1.025 * S.label;
    const long = head.room >= monoW('LOADING · not counted', S.label) + 8; // the same words in both columns
    const clip = `\\clip(${Math.floor(this.X(head.x0))},${Math.floor(P(top - 4))},${Math.ceil(this.X(head.x1))},${Math.ceil(P(top + 1.3 * S.label + 4))})`;
    const keep = [];
    for (const s of this.holdSpans()) {
      const name = HOLD_NAMES[s.kind], nw = monoW(long ? `${name} · not counted` : name, S.label), xMax = head.x1 - nw;
      if (xMax < head.x0) continue;
      // A name that would run into the one before it is left out; its band still shows. A gap (NO VIDEO) is named
      // anyway: the still or load names it runs into leave when it comes in, so the hold under the playhead is the one named.
      const hits = (k) => xMax < Math.min(xR - (s.t0 - k.t0) * speed, k.xMax) + k.nw + 8;
      let j = keep.length - 1, skip = false;
      for (; j >= 0 && hits(keep[j]); j--) if (s.kind !== 'gap' || keep[j].kind === 'gap') { skip = true; break; }
      if (skip) continue;
      for (let k = j + 1; k < keep.length; k++) keep[k].end = Math.min(keep[k].end, s.t0);
      keep.push({ t0: s.t0, xMax, nw, kind: s.kind, name, end: D });
    }
    for (const { t0, xMax, nw, name, end } of keep) {
      const body = this.run(name, c.MONO, S.label, WHITE) + (long ? this.run(' · not counted', c.MONO, S.label, c.LABEL) : '');
      const tp = Math.min(D, t0 + Math.max(0, xR - xMax) / speed), life = (xMax - head.x0 + (head.whole ? 0 : nw)) / speed;
      if (tp > t0) this.emit(4, t0, Math.min(tp, end), `{\\an7\\pos(${f1(this.X(xMax))},${f1(P(top))})\\shad0\\bord0}${body}`);
      if (tp < end) {
        this.emit(4, tp, Math.min(end, tp + life), `{\\an7\\move(${f1(this.X(xMax))},${f1(P(top))},${f1(this.X(xMax - speed * life))},${f1(P(top))},0,${Math.round(life * 1000)})` +
          `${clip}\\shad0\\bord0}${body}`);
      }
    }
  }

  /** Big live FPS (0.5 s window), hidden while a still or a load is on screen. heroAt: where and how big. */
  drawNumbers(tq, tEnd) {
    if (!this.heroAt) return;
    const H = this.heroAt, c = this.c;
    const bodyAt = (t) => {
      let hero = this.heroFps(t);
      // Just after a still or a load the window has no play frames yet: the last number stays rather than a flash of '–'.
      if (hero == null) hero = this.lastHero ?? null;
      else this.lastHero = hero;
      const s = hero == null ? '–' : hero.toFixed(0);
      const col = hero == null ? c.TEXT : this.levelColor(Number(s), this.m.target); // banded as shown: 47.6 reads 48, amber
      return this.textBody(H.x, H.base, this.run(s, c.MONO_SEMI, H.size, col) + this.run(' FPS', c.MONO, H.label, c.LABEL), H.size, H.align);
    };
    // While a hitch's frame is on screen the number follows it every 0.1 s, as the HITCH tag is already up.
    if (!this.hitchFrames) this.hitchFrames = this.a.holds.filter((h) => h.kind === 'hitch').map((h) => [h.start, h.start + h.ms / 1000]);
    const marks = [tq];
    for (const [h0, h1] of this.hitchFrames) for (let t = h0 + 0.1; t < h1; t += 0.1) if (t > tq && t < tEnd) marks.push(t);
    for (const h of this.holdSpans()) if (h.t1 + 0.1 > tq && h.t1 + 0.1 < tEnd) marks.push(h.t1 + 0.1); // a fresh number soon after a hold
    marks.sort((p, q) => p - q);
    marks.forEach((m, i) => this.heroSpan(m, i + 1 < marks.length ? marks[i + 1] : tEnd, bodyAt(m)));
  }

  /** numbersAt(tq).hero, the play FPS of the last 0.5 s, without numbersAt's sorted run history (its inserts grow with the square of the frames), which these looks never show. */
  heroFps(tq) {
    const span = Math.min(0.5, tq), minSpan = this.m.refreshMs / 1000;
    if (span < minSpan) return null;
    const live = span - this.pausedIn(tq - span, tq, tq);
    return live >= minSpan ? weightedFrames(this.a.starts, this.ends, tq - span, tq, tq, this.m.floorS, this.a.kind) / live : null;
  }

  /** The hero from t0 to t1, hidden while a still or a load is on screen. */
  heroSpan(t0, t1, body) {
    let t = t0;
    for (const h of this.holdSpans()) {
      if (h.t1 <= t0 || h.t0 >= t1) continue;
      if (h.t0 > t) this.slot('hero', 3, t, body);
      this.slot('hero', 3, Math.max(t, h.t0), null);
      t = Math.min(t1, h.t1);
    }
    if (t < t1) this.slot('hero', 3, t, body);
  }

  /** Parts of [0, D] outside the labelled stills and loads. */
  freeSpans(D) {
    const out = [];
    let t = 0;
    for (const h of this.holdSpans()) {
      if (h.t0 > t) out.push([t, Math.min(D, h.t0)]);
      t = Math.max(t, h.t1);
    }
    if (t < D) out.push([t, D]);
    return out;
  }

  /** Red "HITCH · NN ms" for about a second from the start of each hitch, bottom at `bottom`. */
  hitchTags(D, x, bottom, padY = 6) {
    const size = this.S.label, h = 2 * padY + 1.3 * size, top = bottom - h;
    const hs = this.a.holds.filter((hh) => hh.kind === 'hitch');
    hs.forEach((hh, i) => {
      const t0 = hh.start, t1 = Math.min(D, i + 1 < hs.length ? hs[i + 1].start : Infinity, t0 + Math.max(HITCH_TAG_S, hh.ms / 1000));
      const s = `HITCH · ${Math.round(hh.ms)} ms`;
      this.box(t0, t1, x, top, monoW(s, size) + 20, h, this.c.RED, 1, 6, 3);
      this.label(t0, t1, x + 10, top + padY + 1.025 * size, s, { color: INK, font: this.c.MONO_SEMI, layer: 4 });
    });
  }

  /** The A/B (or A/B/C) results after the clip: verdict, the numbers side by side, which is better. gaps: say they are not counted. */
  endCard(t0, t1, sums, titles, subtitles, watermark, gaps = false) {
    const c = this.c, n = sums.length, x0 = (this.AW - 1280) / 2 + 72, x1 = x0 + 1136;
    const cols = n === 2 ? [x0 + 657, x0 + 897] : [x0 + 400, x0 + 650, x0 + 900];
    this.emit(0, t0, t1, this.shapeBody(rectsPath([[0, 0, this.w, this.h]]), 0x000000, 1));
    const subs = subtitles.map((s) => cleanText(s || ''));
    const sub = subs[0] && subs.slice(1).every((s) => s === subs[0] || !s) ? subs[0] : '';
    this.label(t0, t1, x0, baseOf(40, 18), fitText(`RESULT${sub ? ` · ${sub}` : ''}`, 1136, (s) => monoW(s, 18)), { size: 18 });
    const names = titles.map((t, i) => cleanText(t || '') || LETTERS[i]);
    const lines = wrap(n === 2 ? verdict(sums[0], sums[1], names) : verdictN(sums, names), 1040, (s) => nameW(s, 34)).slice(0, 3);
    lines.forEach((ln, i) => this.text(t0, t1, x0, 105.4 + i * 42.5, this.run(ln, c.SANS_SEMI, 34, WHITE), 34));
    let y = 71.4 + lines.length * 42.5 + 20;
    cols.forEach((r, side) => {
      const name = fitText(titles[side] || LETTERS[side], 190, (s) => nameW(s, 26));
      this.text(t0, t1, r, mid(y + 25, 26), this.run(name, c.SANS_SEMI, 26, WHITE), 26, 'r');
      this.tag(t0, t1, r - nameW(name, 26) - (n === 2 ? 10 : 16) - 34, y + 8, 34, side); // nameW runs short on long names
    });
    this.label(t0, t1, x1, mid(y + 25, 18), n === 2 ? 'BETTER' : 'BEST', { size: 18, align: 'r', font: c.MONO_MED });
    y += 50;
    const rows = n === 2 ? abRows(sums[0], sums[1]).map(([l, va, vb, ca, cb, b]) => [l, [va, vb], [ca, cb], b]) : rowsN(sums);
    for (const [label, vals, colors, better] of rows) {
      const cy = y + 32.5;
      this.rects(t0, t1, [[x0, y, 1136, 1]], WHITE, 0.12, 1);
      this.text(t0, t1, x0, mid(cy, 22), this.run(label, c.SANS_MED, 22, c.LABEL), 22);
      cols.forEach((r, i) => this.text(t0, t1, r, mid(cy, 34), this.run(vals[i], c.MONO_SEMI, 34, colors[i]), 34, 'r'));
      const col = better.side == null ? c.LABEL : AB_COLORS[better.side], bw = monoW(better.text, 18) + 20, bh = 31.4;
      this.box(t0, t1, x1 - bw, cy - bh / 2, bw, bh, better.side == null ? WHITE : col, better.side == null ? 0.08 : 0.15, 6, 1);
      this.text(t0, t1, x1 - bw / 2, mid(cy, 18), this.run(better.text, c.MONO_SEMI, 18, col), 18, 'c');
      y += 65;
    }
    const sec = Math.round(t0), shown = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    this.label(t0, t1, x0, 643, `Numbers cover the ${shown} shown · ${gaps || n > 2 ? 'stills, loading and gaps' : 'stills and loading screens'} not counted`, { size: 18 });
    if (watermark) this.label(t0, t1, x1, 643, watermark, { size: 18, align: 'r', color: c.FOOT, font: c.MONO_MED });
  }
}

/** Where each part of one video's column sits, in board px from the column's left edge. */
function columnLayout(frame, fit, side, CW) {
  if (fit === 'third') { // 21:9, three videos: name band 0-72, video 72-552, frame times below (Export-21x9-3up)
    return {
      video: [72, 480], name: { kind: 'band', x: 16, right: CW - 16 },
      fps: { x: CW - 12 - 250, y: 84, w: 250, graphH: 60, panel: true, pad: [8, 10], target: true },
      live: { x: 12, bottom: 540, oneLine: true }, hitchBottom: 488, hitchPad: 4,
      // Hold names in the frame-time header: a space and more clear of 'ms', and gone whole as they reach it, not cut.
      ft: { x: 16, w: CW - 32, y: 559, gap: 3, graphH: 64, prefix: true, namesGap: 32, namesWhole: true }, divider: null,
    };
  }
  const padL = side ? 24 : 32, padR = side ? 32 : 24; // in the bands: 32 at the frame's edge, 24 at the middle
  const bandFt = { x: padL, w: CW - padL - padR };
  if (frame !== '21:9' && fit !== 'crop') {
    return {
      video: [180, 360], name: { kind: 'stack', x: padL, y: 16 },
      fps: { x: CW - padR - 300, y: 16, w: 300, graphH: 110 },
      live: { x: 16, bottom: 524 }, hitchBottom: 406,
      ft: { ...bandFt, y: 552, graphH: 70 }, divider: 'black',
    };
  }
  if (fit === 'crop') {
    const wide = frame === '21:9', m = wide ? 24 : 20, fh = wide ? 120 : 112, fw = wide ? 360 : 270;
    return {
      video: [0, 720], name: { kind: 'panel', x: m, y: m, tag: wide ? 40 : 34, title: wide ? 30 : 26 },
      fps: { x: CW - m - fw, y: m, w: fw, graphH: 84, panel: true },
      live: { x: m, bottom: 720 - (wide ? 194 : 186) }, hitchBottom: 720 - (wide ? 339 : 304),
      ft: { x: m, w: CW - 2 * m, y: 720 - 58 - fh + 10, graphH: wide ? 64 : 60, panel: [720 - 58 - fh, fh] }, divider: 'white',
    };
  }
  if (fit === 'letterbox') {
    return {
      video: [60, 480], name: { kind: 'row', x: padL, cy: 30, right: CW - padR },
      fps: { x: CW - 16 - 360, y: 76, w: 360, graphH: 80, panel: true },
      live: { x: 16, bottom: 524 }, hitchBottom: 379,
      ft: { ...bandFt, y: 552, graphH: 72 }, divider: 'black',
    };
  }
  return { // 21:9, data below
    video: [0, 480], name: { kind: 'panel', x: 16, y: 16, tag: 40, title: 30 },
    fps: { x: CW - 16 - 360, y: 16, w: 360, graphH: 80, panel: true },
    live: { x: 16, bottom: 464 }, hitchBottom: 319,
    ft: { ...bandFt, y: 494, graphH: 124, prefix: true }, divider: 'black',
  };
}

/** One video's column of the A/B (side 0, 1) or three-up (side 0 to 2) frame. opts: { side, frame, fit, subtitle, summary, watermark }. */
class ABPane extends Board {
  drawChrome(D) {
    const o = this.opts, side = o.side, color = AB_COLORS[side], S = this.S, c = this.c;
    let CW = this.AW / 2;
    if (o.fit === 'third') { // the column right of its seam, in board px
      const r = videoRects(o.frame, o.fit, this.w, this.h).rects[side];
      this.ox = r.x / this.k;
      CW = r.w / this.k;
    } else this.ox = side * CW;
    const L = columnLayout(o.frame, o.fit, side, CW);
    this.drawName(D, L, side);
    const f = L.fps, pad = f.pad || (f.panel ? [10, 12] : [0, 0]), fpsHead = f.target ? `FPS · TARGET ${this.m.target}` : 'FPS';
    if (f.panel) this.box(0, D, f.x, f.y, f.w, 2 * pad[0] + 1.3 * S.label + 4 + f.graphH);
    this.label(0, D, f.x + pad[1], baseOf(f.y + pad[0], S.label), fpsHead);
    this.fpsGraph(D, { x: f.x + pad[1], y: f.y + pad[0] + 1.3 * S.label + 4, w: f.w - 2 * pad[1] - S.fpsGutter, h: f.graphH, head: fpsHead }, color);
    if (L.live.oneLine) this.statsBox(D, L.live.x, L.live.bottom, CW);
    else this.liveBox(D, L.live.x, L.live.bottom);
    this.hitchTags(D, L.live.x, L.hitchBottom, L.hitchPad);
    const t = L.ft;
    if (t.panel) this.box(0, D, 0, t.panel[0], CW, t.panel[1], c.PANEL, c.PANEL_A, 0);
    const headText = `${t.prefix ? `${LETTERS[side]} · ` : ''}FRAME TIME · ms`, wmW = (s) => (s ? monoW(s, S.label) + 2 * S.label : 0); // 2 em, so a hold name never reads as part of the watermark
    this.label(0, D, t.x, baseOf(t.y, S.label), headText);
    if (o.watermark) this.label(0, D, t.x + t.w, baseOf(t.y, S.label), o.watermark, { color: c.FOOT, align: 'r', font: c.MONO_MED });
    const x0 = t.x + monoW(headText, S.label) + (t.namesGap || 16);
    const head = { x0, x1: t.x + t.w - wmW(o.watermark), room: t.x + t.w - wmW(o.wmText) - x0, base: baseOf(t.y, S.label), whole: t.namesWhole };
    const g = { x: t.x, y: t.y + 1.3 * S.label + (t.gap ?? 6), w: t.w - S.ftGutter, h: t.graphH, grid2: !t.panel, head };
    this.ftChrome(D, g);
    this.ftMoving(D, g, color);
    if (side && L.divider) { // the seam between the two videos
      const [vy, vh] = L.video;
      this.rects(0, D, [[-1, vy, 2, vh]], L.divider === 'white' ? 0xFFFFFF : 0x000000, L.divider === 'white' ? 0.55 : 1, 1);
    }
  }

  drawName(D, L, side) {
    const n = L.name, S = this.S, c = this.c, title = cleanText(this.title), sub = cleanText(this.opts.subtitle || '');
    const sansFit = (s, size, maxW) => fitText(s, maxW, (v) => nameW(v, size));
    const monoFit = (s, maxW) => fitText(s, maxW, (v) => monoW(v, S.label));
    if (n.kind === 'band') { // three-up: tag, title and subtitle at the left of the top band, the live number at its right
      const heroW = monoW(this.m.target >= 100 ? '000' : '00', 56) + monoW(' FPS', S.label);
      const maxW = n.right - heroW - 12 - n.x, top = sub ? 7 : 20;
      this.tag(0, D, n.x, top, 32, side, 20, 7);
      this.text(0, D, n.x + 42, mid(top + 16, 26), this.run(sansFit(title, 26, maxW - 42), c.SANS_SEMI, 26, WHITE), 26);
      if (sub) this.label(0, D, n.x, mid(top + 46, S.label), monoFit(sub, maxW));
    } else if (n.kind === 'stack') { // 16:9 letterbox: tag and name, the subtitle under them on up to two lines
      const maxW = L.fps.x - 20 - n.x;
      this.tag(0, D, n.x, n.y, 36, side);
      this.text(0, D, n.x + 46, mid(n.y + 18, 28), this.run(sansFit(title, 28, maxW - 46), c.SANS_SEMI, 28, WHITE), 28);
      const parts = sub ? sub.split(' · ') : [];
      const lines = parts.length > 1 ? [parts[0], parts.slice(1).join(' · ')] : parts;
      lines.forEach((ln, i) => this.label(0, D, n.x, baseOf(n.y + 42 + i * (1.3 * S.label + 6), S.label), monoFit(ln, maxW)));
    } else if (n.kind === 'row') { // 21:9 letterbox: all on one line in the top band
      this.tag(0, D, n.x, n.cy - 20, 40, side);
      const name = sansFit(title, 30, (n.right - n.x - 52) * 0.6), tw = nameW(name, 30);
      this.text(0, D, n.x + 52, mid(n.cy, 30), this.run(name, c.SANS_SEMI, 30, WHITE), 30);
      if (sub) this.label(0, D, n.x + 64 + tw, mid(n.cy, S.label), monoFit(sub, n.right - n.x - 64 - tw));
    } else { // a panel over the video
      const maxW = L.fps.x - 16 - n.x, tg = n.tag, ts = n.title, lh = 1.3 * S.label;
      const name = sansFit(title, ts, maxW - 34 - tg);
      // A subtitle too long for one line goes onto two at its ' · ', as in the letterbox band.
      const parts = sub.split(' · ');
      // The panels side by side match: when either subtitle needs two lines, both take two.
      const two = (this.opts.subtitles || [sub]).some((x) => x && x.includes(' · ') && monoW(x, S.label) > maxW - 24);
      const subs = !sub ? [] : two && parts.length > 1 ? [parts[0], parts.slice(1).join(' · ')] : [sub];
      const subL = subs.map((s) => monoFit(s, maxW - 24));
      const w = Math.min(maxW, Math.max(20 + tg + nameW(name, ts), 10 + Math.max(0, ...subL.map((s) => monoW(s, S.label)))) + 14);
      this.box(0, D, n.x, n.y, w, 20 + tg + (subL.length ? 4 + (two ? 2 : subL.length) * lh : 0));
      this.tag(0, D, n.x + 10, n.y + 10, tg, side);
      this.text(0, D, n.x + 20 + tg, mid(n.y + 10 + tg / 2, ts), this.run(name, c.SANS_SEMI, ts, WHITE), ts);
      subL.forEach((s, i) => this.label(0, D, n.x + 10, baseOf(n.y + 14 + tg + i * lh, S.label), s));
    }
  }

  /** Bottom-left box: live FPS and the run's AVG, 1% low and hitches; a still or a load instead while on screen. */
  liveBox(D, x, bottom) {
    const S = this.S, c = this.c, s = this.opts.summary, t = this.m.target;
    const v = (n) => (n == null ? '–' : n.toFixed(1));
    const runs = [['AVG '], [v(s.avg_fps), bandShown(s.avg_fps, t)], [' · 1% '], [v(s.low_1pct_fps), bandShown(s.low_1pct_fps, t)],
      [' · '], [String(s.hitches.count), WHITE], [' HITCHES']];
    const plain = runs.map((r) => r[0]).join('');
    const names = ['LOADING', ...this.holdSpans().map((h) => HOLD_NAMES[h.kind])];
    const bw = 28 + Math.max(monoW(plain, S.label), ...names.map((nm) => monoW(nm, S.hold)), monoW('99.9 s · not counted', S.label));
    const bh = 20 + S.hero + S.heroGap + 1.3 * S.label, top = bottom - bh;
    this.box(0, D, x, top, bw, bh);
    const line = runs.map(([str, col]) => this.run(str, col ? c.MONO_SEMI : c.MONO, S.label, col || c.LABEL)).join('');
    const lineBase = baseOf(top + 10 + S.hero + S.heroGap, S.label);
    for (const [t0, t1] of this.freeSpans(D)) this.text(t0, t1, x + 14, lineBase, line, S.label);
    for (const h of this.holdSpans()) {
      const t1 = Math.min(D, h.t1);
      this.label(h.t0, t1, x + 14, top + 10 + 0.925 * S.hold, HOLD_NAMES[h.kind], { size: S.hold, font: c.MONO_SEMI });
      this.label(h.t0, t1, x + 14, baseOf(top + 16 + 1.1 * S.hold, S.label), `${(h.t1 - h.t0).toFixed(1)} s · not counted`);
    }
    this.heroAt = { x: x + 14, base: top + 10 + 0.875 * S.hero, size: S.hero, label: S.label };
  }

  /** Three-up: one line "AVG x · 1% y · n HITCHES" at the bottom left of the video, a still, a load or a gap's
   * name and length instead while on screen; the live number sits at the right of the name band. */
  statsBox(D, x, bottom, CW) {
    const S = this.S, c = this.c, s = this.opts.summary, t = this.m.target;
    const v = (n) => (n == null ? '–' : n.toFixed(1));
    const runs = [['AVG '], [v(s.avg_fps), bandShown(s.avg_fps, t)], [' · 1% '], [v(s.low_1pct_fps), bandShown(s.low_1pct_fps, t)],
      [' · '], [String(s.hitches.count), WHITE], [' HITCHES']];
    const holds = this.holdSpans().map((h) => [h, HOLD_NAMES[h.kind], ` · ${(h.t1 - h.t0).toFixed(1)} s · not counted`]);
    const bw = 24 + Math.max(monoW(runs.map((r) => r[0]).join(''), S.label), ...holds.map(([, a, b]) => monoW(a + b, S.label)));
    const bh = 16 + 1.3 * S.label, top = bottom - bh, base = baseOf(top + 8, S.label);
    this.box(0, D, x, top, bw, bh);
    const line = runs.map(([str, col]) => this.run(str, col ? c.MONO_SEMI : c.MONO, S.label, col || c.LABEL)).join('');
    for (const [t0, t1] of this.freeSpans(D)) this.text(t0, t1, x + 12, base, line, S.label);
    for (const [h, name, rest] of holds) {
      this.text(h.t0, Math.min(D, h.t1), x + 12, base, this.run(name, c.MONO_SEMI, S.label, WHITE) + this.run(rest, c.MONO, S.label, c.LABEL), S.label);
    }
    this.heroAt = { x: CW - 16, base: mid(36, 56), size: 56, label: S.label, align: 'r' };
  }
}

/**
 * The single-video 'bands' look: the video in a pane at the top left (75 % on a 16:9
 * frame, full height on 21:9), its numbers in a side panel, frame times along the
 * bottom (16:9) or in the panel (21:9). size is the whole frame; the pipeline
 * scales the video into the pane (bandsPane).
 */
class BandsOverlay extends Board {
  drawChrome(D) {
    const c = this.c, S = this.S, wide = this.wide, color = AB_COLORS[0];
    const s = summarise(this.a, this.capture), t = this.m.target;
    const x = wide ? 1306 : 982, w = wide ? this.AW - 1280 - 52 : 276;
    const ts = wide ? 30 : 26, vs = wide ? 30 : 26, hero = wide ? 84 : 72;
    const sub = this.opts.subtitle || `${this.capture.height}p${Math.round(this.a.hz || 0)} · ${t} fps target`;
    this.text(0, D, x, wide ? 50.5 : 42.7, this.run(fitText(this.title, w, (v) => nameW(v, ts)), c.SANS_SEMI, ts, WHITE), ts);
    this.label(0, D, x, wide ? 81 : 70.35, fitText(sub, w, (v) => monoW(v, S.label)));
    this.heroAt = { x, base: wide ? 174 : 150.3, size: hero, label: S.label };
    const v1 = (n) => (n == null ? '–' : n.toFixed(1)), pace = pacingPct(s) == null ? null : Math.round(pacingPct(s));
    const stats = [['AVG', v1(s.avg_fps), bandShown(s.avg_fps, t)], ['1% LOW', v1(s.low_1pct_fps), bandShown(s.low_1pct_fps, t)],
      ['0.1% LOW', v1(s.low_0_1pct_fps), bandShown(s.low_0_1pct_fps, t)], ['HITCHES', String(s.hitches.count), WHITE]];
    // 'NNN.N ms' would run into the next column; a frame that long needs no tenths.
    const longest = s.longest_frame_ms >= 100 ? s.longest_frame_ms.toFixed(0) : v1(s.longest_frame_ms);
    // Unlocked has no pacing (pacingPct): the share of frames that missed the target takes its place.
    if (wide) {
      stats.push(['LONGEST', longest, WHITE, ' ms'], pace == null ? ['MISSED', `${(s.frames_missing_target_pct || 0).toFixed(1)}%`, WHITE]
        : ['PACING', `${pace}%`, band(pace)]);
    }
    const cols = wide ? 3 : 2, colW = (w - 12 * (cols - 1)) / cols, top0 = wide ? 198.5 : 171.3, rowH = 1.3 * S.label + 1.3 * vs + 10;
    stats.forEach(([label, val, col, unit], i) => {
      const cx = x + (i % cols) * (colW + 12), top = top0 + Math.floor(i / cols) * rowH;
      this.label(0, D, cx, baseOf(top, S.label), label);
      this.text(0, D, cx, baseOf(top + 1.3 * S.label, vs), this.run(val, c.MONO_SEMI, vs, col) + (unit ? this.run(unit, c.MONO, S.label, c.LABEL) : ''), vs);
    });
    // Stills and loads: the hero gives way to the hold's name.
    for (const h of this.holdSpans()) {
      const t1 = Math.min(D, h.t1);
      this.label(h.t0, t1, x, this.heroAt.base - hero * 0.35, HOLD_NAMES[h.kind], { size: Math.round(hero * 0.55), font: c.MONO_SEMI });
      this.label(h.t0, t1, x, this.heroAt.base, `${(h.t1 - h.t0).toFixed(1)} s · not counted`);
    }
    const fpsTop = wide ? 352.5 : 412.6, ftTop = wide ? 472.5 : 552.45;
    this.label(0, D, x, baseOf(fpsTop, S.label), 'FPS');
    this.fpsGraph(D, { x, y: fpsTop + 1.3 * S.label + 4, w: w - S.fpsGutter, h: wide ? 76 : 84 }, color);
    const wm = cleanText(this.opts.watermark ?? WATERMARK);
    const ft = wide ? { x, w, y: ftTop, h: 76, gap: 4 } : { x: 32, w: 1216, y: ftTop, h: 76, gap: 6 };
    if (!wide) this.rects(0, D, [[0, 540, this.AW, 1]], WHITE, 0.08, 1);
    this.label(0, D, ft.x, baseOf(ft.y, S.label), 'FRAME TIME · ms');
    if (wm) {
      if (wide) this.label(0, D, x + w, baseOf(592.5, S.label), wm, { color: c.FOOT, align: 'r', font: c.MONO_MED });
      else this.label(0, D, ft.x + ft.w, baseOf(ft.y, S.label), wm, { color: c.FOOT, align: 'r', font: c.MONO_MED });
    }
    const x0 = ft.x + monoW('FRAME TIME · ms', S.label) + 16, x1 = ft.x + ft.w - (wm && !wide ? monoW(wm, S.label) + 2 * S.label : 0);
    const head = { x0, x1, room: x1 - x0, base: baseOf(ft.y, S.label) };
    const g = { x: ft.x, y: ft.y + 1.3 * S.label + ft.gap, w: ft.w - S.ftGutter, h: ft.h, grid2: true, head };
    this.ftChrome(D, g);
    this.ftMoving(D, g, color);
  }
}

/** Frame and video pane of the bands look for an output height: { width, height, pane: { x, y, w, h } }. */
function bandsPane(height, frame) {
  const even = (v) => Math.round(v / 2) * 2, wide = frame === '21:9', k = height / 720;
  return {
    width: even(height * (wide ? 64 / 27 : 16 / 9)), height,
    pane: { x: 0, y: 0, w: even((wide ? 1280 : 960) * k), h: even((wide ? 720 : 540) * k) },
  };
}

/**
 * The A/B overlay. p: { panes: [{ a, summary, title, subtitle }] (A, B and for fit 'third' C, already on
 * the output's clock: shiftAnalysis or trackAnalysis), size: { width, height }, frame, fit, span, endCard, watermark?, ycbcr? }.
 * Returns { build(), writeTo(file, { at }) }; `at` writes only that moment, re-timed to 0 (a single frame).
 */
function abOverlay(p) {
  const wm = cleanText(p.watermark ?? WATERMARK), n = p.panes.length;
  // Each part's lines, one at a time: an hour of three panes held at once runs out of heap.
  const part = (k) => {
    if (k === n) {
      if (!p.endCard) return [];
      const card = new Board(p.panes[0].a, p.size, '', 30, 'left', null, {});
      card.endCard(p.span, p.span + AB_END_CARD_S, p.panes.map((x) => x.summary), p.panes.map((x, i) => x.title || LETTERS[i]),
        p.panes.map((x) => x.subtitle), wm, p.panes.some((x) => x.a.kind.includes('gap')));
      return card.lines;
    }
    const x = p.panes[k];
    const pane = new ABPane(x.a, p.size, x.title || LETTERS[k], 30, 'left', null,
      { side: k, frame: p.frame, fit: p.fit, subtitle: x.subtitle, subtitles: p.panes.map((q) => q.subtitle), summary: x.summary, watermark: k === n - 1 ? wm : '', wmText: wm, window: p.window });
    pane.render();
    return pane.lines;
  };
  // ycbcr: the matrix the video is drawn in ('TV.709' for the exports). Without it libass assumes BT.601 colours.
  const head0 = new Board(p.panes[0].a, p.size, '', 30, 'left', null, {}).head();
  const head = p.ycbcr ? head0.flatMap((l) => (l === 'WrapStyle: 2' ? [l, `YCbCr Matrix: ${p.ycbcr}`] : [l])) : head0;
  const build = () => head.concat(...Array.from({ length: n + 1 }, (_, k) => part(k))).join('\n') + '\n';
  // Written in slices like Overlay.writeTo: hours of overlap would pass V8's string limit as one string.
  const writeTo = (file, { at } = {}) => {
    const fd = fs.openSync(file, 'w');
    try {
      fs.writeSync(fd, head.join('\n') + '\n');
      for (let k = 0; k <= n; k++) {
        const body = typeof at === 'number' ? freezeAt(part(k), at) : part(k);
        for (let i = 0; i < body.length; i += 20000) fs.writeSync(fd, body.slice(i, i + 20000).join('\n') + '\n');
      }
    } finally { fs.closeSync(fd); }
  };
  return { build, writeTo };
}

/** The big live FPS an export of `a` shows from each 0.25 s step on (ABPane.heroFps at k * 0.25 s), for the
 * window's monitor. shortcut: the 0.1 s updates while a hitch frame is up are left out; add them if the monitor must follow hitches. */
function liveFps(a) {
  const target = a.target, refreshMs = a.hz ? 1000 / a.hz : 1000 / target;
  const pane = Object.assign(Object.create(ABPane.prototype), {
    a, ends: a.starts.map((s, i) => s + a.frameMs[i] / 1000), m: { refreshMs, floorS: 1 / target },
  });
  const out = [];
  for (let k = 0; k * 0.25 < a.duration; k++) {
    const v = pane.heroFps(k * 0.25);
    out.push(v == null ? null : Math.round(v * 100) / 100);
  }
  return out;
}

module.exports = {
  loadAnalysis, analysisStart, liveFps, readAnalysis, abData, shiftAnalysis, overlapSummary, verdict, verdictN, abRows, rowsN, pacingPct, abOverlay,
  bandsPane, BandsOverlay, AB_END_CARD_S, AB_SIZES, FPS_TOP, FPS_HALF, FT_WIN, videoRects, thirds,
};
