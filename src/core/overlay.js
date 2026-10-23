'use strict';
// Burned-in overlay as ASS subtitles (rendered by ffmpeg/libass).
// Palette and fonts follow the onionHEN performance overlay design; the layout
// is in CSS px at 1080p, scaled to the output height. Every number states its
// window, and frames are counted by time so a locked frame rate reads flat.

const fs = require('fs');
const path = require('path');
const { bisectLeft, bisectRight, percentile } = require('./analysis');

const PANEL = 0x0A0C0F, LINE = 0x3A434C;
const TEXT = 0xEEF2F5, LABEL = 0xC9D0D6, DIM = 0xA7B0B8, FOOT = 0x8E98A1;
const BLUE = 0x5AA9E6, AMBER = 0xF5B13D, RED = 0xF2545B;
const MONO = 'IBM Plex Mono', MONO_MED = 'IBM Plex Mono Medm', MONO_SEMI = 'IBM Plex Mono SmBld';
const SANS = 'IBM Plex Sans Cond', SANS_MED = 'IBM Plex Sans Cond Medm', SANS_SEMI = 'IBM Plex Sans Cond SmBld';
// libass sizes a font by ascent + descent (1.3 em for Plex), CSS by its em.
const FS_PER_PX = 1.3, DESCENT = 0.275;

const PW = 380.0, PAD = 16.0;   // panel width and padding
const IW = PW - 2 * PAD;        // inner width
const PH = 476.0;               // panel height
const CHART_H = 72.0;
const FPS_BARS = 40, FPS_BUCKET = 0.25; // FPS chart: 40 slices of 250 ms
const FT_SHOW = 89;                     // frame-time chart: 89 completed frames + the one on screen
const MIN_FRAMES_LOW = 20;              // frames a window needs before a percentile is shown
const STALL_LIVE_MS = 100, STALL_LIVE_FRAMES = 3; // the frame on screen counts as a stall after this
const MAX_OVERFLOW_LABELS = 4;
const LG_H = 116, LG_PAD = 16, LG_TOP = 32, LG_CH = 72, LG_WIN = 7.5; // long graph box, chart top/height, window s
const WATERMARK = '4aLse Benchmarks';     // bottom left of every video; opts.watermark overrides, '' removes it

// Layout in panel px: text baselines and box tops, as in the design.
const LAYOUT = Object.freeze({
  PW, PAD, IW, PH, CHART_H,
  TITLE_BASE: 31.7, PILL_TOP: 16.5, PILL_H: 20.6, PILL_BASE: 31.3,
  EYEBROW_BASE: 58, GRID_LABEL_BASE: 76.2, GRID_VALUE_BASE: 109.25,
  HERO_BASE: 111, HERO_FPS_BASE: 94,
  LAST_BASE: 146, RUN_LABEL_BASE: 168, RUN_VALUE_BASE: 190,
  FPS_LABEL_BASE: 216, FPS_TOP: 226,
  FT_LABEL_BASE: 322, FT_TOP: 332,
  PACING_BASE: 428, PACING_Y: 436, PACING_H: 14,
  FOOT_BASE: 466,
  COL1_R: PW - PAD - 62.4 - 18, COL2_R: PW - PAD,
  RUN_COLS: Object.freeze([1, 2, 3, 4].map((i) => PAD + IW * i / 4)),
});

const f1 = (x) => x.toFixed(1);
const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

/** &HAABBGGRR; ASS alpha 00 = opaque. */
function assColor(rgb, alpha = 1.0) {
  const r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
  return `&H${hex2(Math.round((1.0 - alpha) * 255))}${hex2(b)}${hex2(g)}${hex2(r)}`;
}

function assTime(t) {
  let cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000); cs -= h * 360000;
  const m = Math.floor(cs / 6000); cs -= m * 6000;
  const s = Math.floor(cs / 100); cs -= s * 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** Timecode m:ss.ff, rounded the way assTime() rounds, so it matches the event it sits in. */
function tc(t) {
  let cs = Math.max(0, Math.round(t * 100));
  const m = Math.floor(cs / 6000); cs -= m * 6000;
  const s = Math.floor(cs / 100); cs -= s * 100;
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function rectsPath(rects) {
  const parts = [];
  for (const [x, y, w, h] of rects) {
    if (w <= 0 || h <= 0) continue;
    const x2 = x + w, y2 = y + h;
    parts.push(`m ${f1(x)} ${f1(y)} l ${f1(x2)} ${f1(y)} ${f1(x2)} ${f1(y2)} ${f1(x)} ${f1(y2)}`);
  }
  return parts.join(' ');
}

/** Rounded rectangle as an ASS drawing (cubic corners). */
function roundedPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  const k = r * 0.4477; // control-point inset for a quarter circle
  const x2 = x + w, y2 = y + h;
  return [
    `m ${f1(x + r)} ${f1(y)}`,
    `l ${f1(x2 - r)} ${f1(y)}`,
    `b ${f1(x2 - k)} ${f1(y)} ${f1(x2)} ${f1(y + k)} ${f1(x2)} ${f1(y + r)}`,
    `l ${f1(x2)} ${f1(y2 - r)}`,
    `b ${f1(x2)} ${f1(y2 - k)} ${f1(x2 - k)} ${f1(y2)} ${f1(x2 - r)} ${f1(y2)}`,
    `l ${f1(x + r)} ${f1(y2)}`,
    `b ${f1(x + k)} ${f1(y2)} ${f1(x)} ${f1(y2 - k)} ${f1(x)} ${f1(y2 - r)}`,
    `l ${f1(x)} ${f1(y + r)}`,
    `b ${f1(x)} ${f1(y + k)} ${f1(x + k)} ${f1(y)} ${f1(x + r)} ${f1(y)}`,
  ].join(' ');
}

/** Text colour for a frame rate against the target: on target, a little under, well under. */
function levelColor(fps, target) {
  if (fps >= 0.95 * target) return TEXT;
  if (fps >= 0.8 * target) return AMBER;
  return RED;
}
function barColor(fps, target) {
  if (fps >= 0.95 * target) return BLUE;
  if (fps >= 0.8 * target) return AMBER;
  return RED;
}
/** Bar and text colours for a frame time against the target frame time. */
function ftBarColor(ms, targetMs) {
  if (ms <= targetMs * 1.2) return BLUE;
  if (ms <= targetMs * 2.05) return AMBER;
  return RED;
}
function ftTextColor(ms, targetMs) {
  if (ms <= targetMs * 1.2) return TEXT;
  if (ms <= targetMs * 2.05) return AMBER;
  return RED;
}

/** Width of mono text in CSS px (Plex Mono advances are exactly 0.6 em). */
const monoW = (s, size, spacing = 0) => s.length * (0.6 + spacing) * size;
/** Rough width of condensed sans text; only used to decide whether something fits. */
function sansW(s, size, spacing = 0) {
  let em = 0;
  for (const ch of s) {
    if (ch === ' ') em += 0.22;
    else if (ch >= '0' && ch <= '9') em += 0.54;
    else if (ch >= 'A' && ch <= 'Z') em += 0.6;
    else em += 0.5;
    em += spacing;
  }
  return em * size;
}
/** Whole number when it is one, else one decimal: 16.7, 33.3, 50, 100. */
const fmtMs = (v) => (Math.abs(v - Math.round(v)) < 0.05 ? v.toFixed(0) : v.toFixed(1));
const fmt1 = (v) => (v == null ? '–' : v.toFixed(1));
const fmt0 = (v) => (v == null ? '–' : v.toFixed(0));
/** Braces and backslashes would be read as override tags or line breaks. */
const cleanText = (s) => String(s).replace(/[\\{}\r\n]/g, '');
function shortSource(s) {
  if (!s || s === 'default') return 'default';
  return s.startsWith('auto') ? 'auto' : 'set';
}

/**
 * Frames in [t0, t1), each counted by the share of its on-screen time that
 * falls inside the window, so a frame straddling an edge counts partly in
 * each window and a locked frame rate reads flat. The frame still on screen
 * at tNow lasts (tNow - start) so far, but never less than floorS: a game
 * cannot render a frame shorter than its target, so a tick that falls
 * mid-frame does not count that frame as finished.
 */
function weightedFrames(starts, ends, t0, t1, tNow, floorS = 0) {
  let total = 0;
  for (let i = bisectRight(ends, t0); i < starts.length && starts[i] < t1; i++) {
    const st = starts[i];
    if (st > tNow) break;
    const complete = ends[i] <= tNow;
    const en = complete ? ends[i] : tNow;
    const dur = complete ? en - st : Math.max(en - st, floorS);
    if (dur <= 0) continue;
    const ov = Math.min(en, t1) - Math.max(st, t0);
    if (ov > 0) total += ov / dur;
  }
  return total;
}

/**
 * The panel. Numbers update every 250 ms; the frame-time chart, the frame on
 * screen and the timecode every 1/rate s. Only what a live overlay could know
 * at time t is drawn at t.
 */
class Overlay {
  /**
   * a: the analysis; size: the output video size the panel is laid out for;
   * capture: the recording's probe info (for the format pill), if different.
   */
  constructor(a, size, title, rate = 30, position = 'right', capture = null, opts = {}) {
    this.a = a;
    this.opts = opts;
    this.k = size.height / 1080.0;
    this.w = size.width;
    this.h = size.height;
    this.capture = capture || size;
    this.title = title;
    this.rate = Math.min(100, Math.max(1, Number(rate) || 30)); // ASS times are centiseconds
    this.lines = [];
    this.slots = new Map();
    // Panel origin (1080p px) along the top edge: left, center or right.
    const frameW = this.w / this.k;
    this.W = this.constructor.W;
    this.H = this.constructor.H;
    this.position = position;
    this.ox = position === 'left' ? 24 : position === 'center' ? (frameW - this.W) / 2 : frameW - 24 - this.W;
    this.oy = 24.0;
  }

  static W = PW;
  static H = PH;

  px(v) { return v * this.k; }

  /** One styled text run; size in CSS px, spacing in em. */
  run(s, font, size, color, spacing = 0.0) {
    return `{\\fn${font}\\fs${f1(this.px(size) * FS_PER_PX)}` +
      `\\fsp${this.px(size * spacing).toFixed(2)}\\c${assColor(color)}}${s}`;
  }

  // ---- event bodies and emission ----

  /** Runs with their baseline at (x, baseline) in panel px; size is the
   * largest run size in the line (it sets the descent libass anchors by). */
  textBody(x, baseline, runs, size, align = 'l') {
    const an = { l: 1, c: 2, r: 3 }[align];
    const X = this.px(this.ox + x);
    const Y = this.px(this.oy + baseline + DESCENT * size);
    return `{\\an${an}\\pos(${f1(X)},${f1(Y)})\\bord0\\shad0}${runs}`;
  }

  /** A drawing in output px. With an outline colour the fill is fillAlpha
   * (0 = hollow, as the pills are) and the 1 px border takes alpha. */
  shapeBody(p, color, alpha, outline = null, fillAlpha = 0) {
    const aa = hex2(Math.round((1 - alpha) * 255));
    const style = outline === null
      ? `\\bord0\\c${assColor(color)}\\1a&H${aa}&`
      : `\\bord${f1(this.px(1))}\\c${assColor(color)}\\3c${assColor(outline)}` +
        `\\1a&H${hex2(Math.round((1 - fillAlpha) * 255))}&\\3a&H${aa}&`;
    return `{\\an7\\pos(0,0)\\shad0\\p1${style}}${p}{\\p0}`;
  }

  /** Rectangles given in panel px. */
  rectsBody(rects, color, alpha) {
    const { ox, oy } = this;
    return this.shapeBody(rectsPath(rects.map(([x, y, w, h]) =>
      [this.px(ox + x), this.px(oy + y), this.px(w), this.px(h)])), color, alpha);
  }

  emit(layer, t0, t1, body) {
    const s0 = assTime(t0), s1 = assTime(t1);
    if (s0 === s1 || !body) return;
    this.lines.push(`Dialogue: ${layer},${s0},${s1},HUD,,0,0,0,,${body}`);
  }

  text(t0, t1, x, baseline, runs, size, align = 'l', layer = 3) {
    this.emit(layer, t0, t1, this.textBody(x, baseline, runs, size, align));
  }

  shape(t0, t1, p, color, alpha, layer = 1, outline = null, fillAlpha = 0) {
    if (!p) return;
    this.emit(layer, t0, t1, this.shapeBody(p, color, alpha, outline, fillAlpha));
  }

  rects(t0, t1, rects, color, alpha, layer = 2) {
    if (!rects.length) return;
    this.emit(layer, t0, t1, this.rectsBody(rects, color, alpha));
  }

  /** A line that only changes now and then: one event per change, not per
   * tick. body null means nothing is shown. */
  slot(key, layer, t, body) {
    const open = this.slots.get(key);
    if (open && open.body === body) return;
    if (open) this.emit(open.layer, open.t0, t, open.body);
    this.slots.set(key, body ? { layer, t0: t, body } : null);
  }

  flushSlots(tEnd) {
    for (const open of this.slots.values()) if (open) this.emit(open.layer, open.t0, tEnd, open.body);
    this.slots.clear();
  }

  // ---- drawing helpers (panel px) ----

  /** Hollow pill with mono text, right edge at rightX; returns its width. */
  pill(t0, t1, rightX, s, top = LAYOUT.PILL_TOP, size = 13) {
    const w = monoW(s, size) + 16, h = size === 13 ? LAYOUT.PILL_H : size * FS_PER_PX + 4;
    this.shape(t0, t1, roundedPath(this.px(this.ox + rightX - w + 0.5), this.px(this.oy + top),
      this.px(w - 1), this.px(h), this.px(4)), PANEL, 1.0, 1, LINE);
    this.text(t0, t1, rightX - w / 2, top + LAYOUT.PILL_BASE - LAYOUT.PILL_TOP, this.run(s, MONO_MED, size, DIM), size, 'c');
    return w;
  }

  /** Small mono label in a panel-coloured box, left-aligned at left/top. */
  chartLabelLeft(t0, t1, left, top, s) {
    const size = 13, w = monoW(s, size) + 8, h = size * FS_PER_PX;
    this.shape(t0, t1, roundedPath(this.px(this.ox + left), this.px(this.oy + top), this.px(w), this.px(h), this.px(2)),
      PANEL, 0.86, 3);
    this.text(t0, t1, left + 4, top + h - DESCENT * size, this.run(s, MONO_MED, size, LABEL), size, 'l', 4);
  }

  /** Free text on the video, 24 px in from a corner or edge, outlined so it reads on any footage.
   * At the top on the panel's side it sits below the panel instead. */
  drawCaption(D, s, where, aboveWatermark = false) {
    const [v, h] = where.split('-');
    const frameW = this.w / this.k, margin = 24, size = 28;
    const an = { top: 7, bottom: 1 }[v] + { left: 0, center: 1, right: 2 }[h];
    const x = h === 'left' ? margin : h === 'center' ? frameW / 2 : frameW - margin;
    const underPanel = v === 'top' && h === this.position;
    // Bottom left is the watermark's spot; with the long graph on, the whole bottom edge is taken.
    const lift = this.lg ? this.lg.gy - 16 - (1080 - margin) : aboveWatermark && h === 'left' ? -40 : 0;
    const y = v === 'bottom' ? 1080 - margin + lift : underPanel ? this.oy + this.H + 16 : margin;
    this.emit(3, 0, D, `{\\an${an}\\pos(${f1(this.px(x))},${f1(this.px(y))})\\bord${f1(this.px(2))}\\3c${assColor(PANEL)}\\shad0}` +
      this.run(s, SANS_SEMI, size, TEXT, 0.04));
  }

  /** Watermark at the bottom left: smaller and dimmer than a caption, outlined, 80 % opaque. */
  drawWatermark(D, s) {
    this.emit(3, 0, D, `{\\an1\\pos(${f1(this.px(24))},${f1(this.px(1056))})\\bord${f1(this.px(1.5))}\\3c${assColor(PANEL)}` +
      `\\1a&H33&\\3a&H33&\\shad0}` + this.run(s, SANS_SEMI, 22, LABEL, 0.04));
  }

  /** Value box at the top of the frame-time chart for a bar taller than the scale. */
  overflowLabel(i, t, xBar, barW, ms, top = LAYOUT.FT_TOP + 2, mid = PAD + IW / 2, key = 'ovl') {
    const s = ms.toFixed(0), size = 13, w = monoW(s, size) + 8, h = 17;
    const lx = xBar + barW / 2 > mid ? xBar - 2 - w : xBar + barW + 2;
    this.slot(`${key}${i}b`, 3, t, this.shapeBody(roundedPath(this.px(this.ox + lx), this.px(this.oy + top),
      this.px(w), this.px(h), this.px(2)), PANEL, 0.86));
    this.slot(`${key}${i}t`, 4, t, this.textBody(lx + w - 4, top + h - DESCENT * size, this.run(s, MONO_SEMI, size, RED), size, 'r'));
  }

  /** Outlined bar for the frame still on screen; inset 1 px so the border stays in its column. */
  liveBar(t, x, w, h, stalled, bottom = LAYOUT.FT_TOP + CHART_H, key = 'ftLive') {
    const col = stalled ? RED : LABEL;
    const { ox, oy } = this;
    const p = rectsPath([[this.px(ox + x + 1), this.px(oy + bottom - h + 1),
      this.px(Math.max(0.5, w - 2)), this.px(Math.max(0.5, h - 2))]]);
    this.slot(key, 2, t, this.shapeBody(p, col, 1.0, col, stalled ? 0.55 : 0.3));
  }

  /** Frame-time chart: fixed columns filled from the right, the newest completed frame
   * next to the frame on screen in the last column; bars taller than the 3x scale get a value box. */
  ftChart(tt, f, { key, x, top, w, h, slots }) {
    const { targetMs } = this.m;
    const fbw = (w - (slots - 1)) / slots, scale = 3 * targetMs;
    const first = slots - 1 - f.last.length;
    const groups = new Map([[BLUE, []], [AMBER, []], [RED, []]]);
    const keys = new Map([[BLUE, `${key}Blue`], [AMBER, `${key}Amber`], [RED, `${key}Red`]]);
    const overflow = [];
    f.last.forEach((ms, j) => {
      const bh = Math.max(2.0, Math.min(1.0, ms / scale) * h);
      const bx = x + (first + j) * (fbw + 1);
      groups.get(ftBarColor(ms, targetMs)).push([bx, top + h - bh, fbw, bh]);
      if (ms > scale * 1.001) overflow.push({ x: bx, ms });
    });
    for (const [col, rs] of groups) this.slot(keys.get(col), 2, tt, rs.length ? this.rectsBody(rs, col, 1.0) : null);
    const shown = overflow.slice(-MAX_OVERFLOW_LABELS), okey = key === 'ft' ? 'ovl' : `${key}ovl`;
    for (let i = 0; i < MAX_OVERFLOW_LABELS; i++) {
      if (shown[i]) this.overflowLabel(i, tt, shown[i].x, fbw, shown[i].ms, top + 2, x + w / 2, okey);
      else { this.slot(`${okey}${i}b`, 3, tt, null); this.slot(`${okey}${i}t`, 4, tt, null); }
    }
    this.liveBar(tt, x + (slots - 1) * (fbw + 1), fbw, Math.max(2.0, Math.min(1.0, f.elapsed / scale) * h), f.stalled, top + h, `${key}Live`);
  }

  /** Small upward triangle, 7 x 5.5 px, base at baseY, left corner at x. */
  trianglePath(x, baseY) {
    const { ox, oy } = this, X = (v) => f1(this.px(ox + v)), Y = (v) => f1(this.px(oy + v));
    return `m ${X(x)} ${Y(baseY)} l ${X(x + 3.5)} ${Y(baseY - 5.5)} ${X(x + 7)} ${Y(baseY)}`;
  }

  /** Stacked share bar with labels inside the segments that can hold them. */
  stackedBar(t0, t1, segs, x = PAD, y = LAYOUT.PACING_Y, width = IW, h = LAYOUT.PACING_H, labels = true) {
    const live = segs.filter(([share]) => share > 0);
    const avail = width - (live.length - 1) * 2;
    for (const [share, color, label] of live) {
      const w = share * avail;
      this.shape(t0, t1, roundedPath(this.px(this.ox + x), this.px(this.oy + y), this.px(w), this.px(h), this.px(2)), color, 1.0, 2);
      if (labels) {
        const pct = `${Math.round(share * 100)}%`, full = `${label}  ${pct}`;
        const s = w >= monoW(full, 13) + 10 ? full : w >= monoW(pct, 13) + 8 ? pct : null;
        if (s) this.text(t0, t1, x + w / 2, y + h - 3.5, this.run(s, MONO_SEMI, 13, PANEL), 13, 'c');
      }
      x += w + 2;
    }
  }

  // ---- model ----

  /** Keep the completed frames' times sorted as ticks advance (for the RUN percentiles). */
  absorbCompleted(hi) {
    const { frameMs } = this.a;
    for (; this.doneCount < hi; this.doneCount++) {
      const ms = frameMs[this.doneCount];
      this.sortedDone.splice(bisectLeft(this.sortedDone, ms), 0, ms);
      if (ms > this.m.targetMs + this.m.refreshMs * 0.5) this.missedCount++;
    }
  }

  /** Everything the numbers tick shows at tq. */
  numbersAt(tq) {
    const { starts, frameMs, droppedAt } = this.a;
    const ends = this.ends;
    const { target, refreshMs, kRef, floorS, yMax } = this.m;
    const minSpan = refreshMs / 1000;
    const span05 = Math.min(0.5, tq), span10 = Math.min(10, tq);
    const hero = span05 >= minSpan ? weightedFrames(starts, ends, tq - span05, tq, tq, floorS) / span05 : null;
    const avg = span10 >= minSpan ? weightedFrames(starts, ends, tq - span10, tq, tq, floorS) / span10 : null;
    const hiQ = bisectRight(ends, tq);
    const w10 = frameMs.slice(bisectLeft(ends, tq - 10), hiQ);
    const s10 = w10.slice().sort((x, y) => x - y);
    const low = s10.length >= MIN_FRAMES_LOW ? 1000 / percentile(s10, 0.99) : null;
    let on = 0, late = 0, stall = 0;
    for (const ms of w10) {
      const n = Math.round(ms / refreshMs);
      if (n <= kRef) on++; else if (n <= 2 * kRef) late++; else stall++;
    }
    const pacing = w10.length ? { on, late, stall, n: w10.length } : null;
    // Run so far: completed frames plus the share of the frame on screen.
    let runAvg = null;
    if (tq >= minSpan) {
      const cur = bisectRight(starts, tq) - 1;
      let frac = 0;
      if (cur >= hiQ) { const el = tq - starts[cur]; frac = el / Math.max(el, floorS); }
      runAvg = (hiQ + frac) / tq;
    }
    this.absorbCompleted(hiQ);
    const done = this.sortedDone;
    const run1 = done.length >= MIN_FRAMES_LOW ? 1000 / percentile(done, 0.99) : null;
    const run01 = done.length >= MIN_FRAMES_LOW ? 1000 / percentile(done, 0.999) : null;
    const missed = done.length ? this.missedCount / done.length : null;
    const bucketEnd = Math.floor(tq / FPS_BUCKET) * FPS_BUCKET;
    const bars = [];
    for (let j = 0; j < FPS_BARS; j++) {
      const s = bucketEnd - (FPS_BARS - j) * FPS_BUCKET;
      if (s < 0) continue;
      const fps = weightedFrames(starts, ends, s, s + FPS_BUCKET, tq, floorS) / FPS_BUCKET;
      const drop = bisectLeft(droppedAt, s) < bisectLeft(droppedAt, s + FPS_BUCKET);
      bars.push({ j, fps, drop });
    }
    const vals = bars.map((b) => b.fps);
    return {
      hero, avg, low, pacing, runAvg, run1, run01, missed, bars, yMax, target,
      mn: vals.length ? Math.min(...vals) : null, mx: vals.length ? Math.max(...vals) : null,
      dropsInWindow: bars.some((b) => b.drop),
    };
  }

  /** The frame on screen and the last completed frames at tt. */
  frameAt(tt) {
    const { starts, frameMs } = this.a;
    const ends = this.ends;
    const hiT = bisectRight(ends, tt);
    const lastMs = hiT > 0 ? frameMs[hiT - 1] : null;
    const cur = bisectRight(starts, tt) - 1;
    const elapsed = cur >= 0 ? (tt - starts[cur]) * 1000 : 0;
    const last = frameMs.slice(Math.max(0, hiT - FT_SHOW), hiT);
    const spanS = last.length ? ends[hiT - 1] - starts[hiT - last.length] : 0;
    return {
      lastMs, elapsed, stalled: elapsed >= this.m.stallMs, last, spanS,
      ftMax: last.length ? Math.max(...last) : null,
    };
  }

  // ---- passes ----

  /** Pills, right to left, each optional; returns the width they take (with the 6 px gaps). */
  drawPills(D, right, top, size) {
    const a = this.a, cap = this.capture, o = this.opts;
    let pillsW = 0;
    for (const s of [o.showTarget !== false && `TARGET ${this.m.target}`,
      o.showFormat !== false && cap && cap.height && `${cap.height}P${a.hz ? Math.round(a.hz) : ''}`]) {
      if (!s) continue;
      const w = this.pill(0, D, right, s, top, size);
      right -= w + 6;
      pillsW += w + 6;
    }
    return pillsW;
  }

  /** Title cut to fit `avail` px with an ellipsis. */
  fitTitle(avail, size = 14, spacing = 0.08) {
    let title = cleanText(this.title).toUpperCase();
    if (sansW(title, size, spacing) > avail) {
      while (title.length > 1 && sansW(`${title}…`, size, spacing) > avail) title = title.slice(0, -1);
      title = `${title.trimEnd()}…`;
    }
    return title;
  }

  /** What every look shares outside its own box: watermark, caption, long graph chrome. */
  drawExtras(D) {
    const o = this.opts;
    const wm = cleanText(o.watermark ?? WATERMARK);
    if (wm) this.drawWatermark(D, wm);
    if (o.caption) this.drawCaption(D, cleanText(o.caption), CAPTION_POSITIONS.includes(o.captionPosition) ? o.captionPosition : 'top-left', !!wm);
    if (this.lg) this.drawLongGraphChrome(D);
  }

  drawChrome(D) {
    const a = this.a, L = LAYOUT, px = (v) => this.px(v);
    const { target, targetMs, yMax } = this.m;
    const { ox, oy } = this;
    this.shape(0, D, roundedPath(px(ox), px(oy), px(PW), px(PH), px(10)), PANEL, 0.86, 0);
    // Pills, right to left: target, then the capture format; each can be turned off.
    const pillsW = this.drawPills(D, PW - PAD, LAYOUT.PILL_TOP, 13);
    // Title, cut to fit beside the pills.
    const title = this.fitTitle(IW - Math.max(0, pillsW - 6) - 8);
    this.drawExtras(D);
    this.text(0, D, PAD, L.TITLE_BASE, this.run(title, SANS_SEMI, 14, DIM, 0.08), 14);
    this.text(0, D, L.COL2_R, L.EYEBROW_BASE, this.run('LAST 10 S', SANS_MED, 13, FOOT, 0.06), 13, 'r');
    this.text(0, D, L.COL1_R, L.GRID_LABEL_BASE, this.run('AVG', SANS_SEMI, 16, LABEL, 0.06), 16, 'r');
    this.text(0, D, L.COL2_R, L.GRID_LABEL_BASE, this.run('1% LOW', SANS_SEMI, 16, LABEL, 0.06), 16, 'r');
    ['RUN AVG', '1% LOW', '0.1% LOW', 'MISSED'].forEach((s, i) => {
      this.text(0, D, L.RUN_COLS[i], L.RUN_LABEL_BASE, this.run(s, SANS_MED, 13, FOOT, 0.06), 13, 'r');
    });
    // Chart baselines, the target line and the frame-time grid, labelled at the left.
    this.rects(0, D, [[PAD, L.FPS_TOP + CHART_H, IW, 1], [PAD, L.FT_TOP + CHART_H, IW, 1]], LINE, 1.0);
    const ty = L.FPS_TOP + CHART_H - CHART_H * (target / yMax);
    this.rects(0, D, [[PAD, ty, IW, 1]], TEXT, 0.45, 3);
    this.chartLabelLeft(0, D, PAD, ty + 3, String(target));
    const g1 = CHART_H / 3, g2 = CHART_H * 2 / 3;
    this.rects(0, D, [[PAD, L.FT_TOP + CHART_H - g1, IW, 1]], TEXT, 0.45, 3);
    this.rects(0, D, [[PAD, L.FT_TOP + CHART_H - g2, IW, 1]], TEXT, 0.22, 3);
    this.chartLabelLeft(0, D, PAD, L.FT_TOP + CHART_H - g1 + 3, `${targetMs.toFixed(1)} ms`);
    this.chartLabelLeft(0, D, PAD, L.FT_TOP + CHART_H - g2 + 3, (2 * targetMs).toFixed(1));
    this.text(0, D, PAD, L.PACING_BASE, this.run('PACING · 10 S', SANS_SEMI, 16, LABEL, 0.06), 16);
    const n = a.droppedRefreshes || 0;
    const drops = n ? `${n} rec drop${n === 1 ? '' : 's'}` : 'no rec drops';
    this.text(0, D, PAD, L.FOOT_BASE,
      this.run(`thr ${Number(a.threshold).toFixed(2)} ${shortSource(a.thresholdSource)} · ${drops}`, SANS, 13, FOOT), 13);
  }

  drawNumbers(tq, tEnd) {
    const n = this.numbersAt(tq);
    const L = LAYOUT;
    const { target, refreshMs, kRef, yMax } = this.m;
    // Hero and its labels (the labels move with the digit count).
    const heroS = fmt0(n.hero);
    this.text(tq, tEnd, PAD, L.HERO_BASE,
      this.run(heroS, MONO_SEMI, 72, n.hero == null ? TEXT : levelColor(n.hero, target), -0.03), 72);
    const lx = PAD + monoW(heroS, 72, -0.03) + 8;
    this.slot('heroFps', 3, tq, this.textBody(lx, L.HERO_FPS_BASE, this.run('FPS', SANS_SEMI, 16, LABEL, 0.06), 16));
    this.slot('heroSub', 3, tq, this.textBody(lx, L.HERO_BASE, this.run('0.5 S', SANS_MED, 13, FOOT, 0.06), 13));
    this.text(tq, tEnd, L.COL1_R, L.GRID_VALUE_BASE,
      this.run(fmt1(n.avg), MONO_SEMI, 26, n.avg == null ? TEXT : levelColor(n.avg, target)), 26, 'r');
    this.text(tq, tEnd, L.COL2_R, L.GRID_VALUE_BASE,
      this.run(fmt1(n.low), MONO_SEMI, 26, n.low == null ? TEXT : levelColor(n.low, target)), 26, 'r');
    const runVals = [fmt1(n.runAvg), fmt1(n.run1), fmt1(n.run01), n.missed == null ? '–' : `${Math.round(n.missed * 100)}%`];
    runVals.forEach((s, i) => this.text(tq, tEnd, L.RUN_COLS[i], L.RUN_VALUE_BASE, this.run(s, MONO_SEMI, 20, TEXT), 20, 'r'));
    // FPS chart: 40 slices, time-weighted.
    const bw = (IW - (FPS_BARS - 1) * 2) / FPS_BARS;
    const groups = new Map([[BLUE, []], [AMBER, []], [RED, []]]);
    const tris = [];
    for (const b of n.bars) {
      const h = Math.max(2.0, Math.min(1.0, b.fps / yMax) * CHART_H);
      const x = PAD + b.j * (bw + 2);
      groups.get(barColor(b.fps, target)).push([x, L.FPS_TOP + CHART_H - h, bw, h]);
      if (b.drop) tris.push(x + bw / 2 - 3.5);
    }
    for (const [col, rs] of groups) this.rects(tq, tEnd, rs, col, 1.0);
    this.slot('drops', 2, tq, tris.length
      ? this.shapeBody(tris.map((x) => this.trianglePath(x, L.FPS_TOP + CHART_H + 8)).join(' '), RED, 1.0) : null);
    const left = this.run('FPS · LAST 10 S', SANS_SEMI, 16, LABEL, 0.06) +
      (n.dropsInWindow ? '' : this.run(' · ¼ S SLICES', SANS_MED, 13, FOOT, 0.04));
    this.slot('fpsLabelL', 3, tq, this.textBody(PAD, L.FPS_LABEL_BASE, left, 16));
    this.text(tq, tEnd, PW - PAD, L.FPS_LABEL_BASE,
      (n.dropsInWindow ? this.run('REC DROP · ', SANS_SEMI, 16, RED, 0.06) : '') +
      this.run('MIN ', SANS_SEMI, 16, LABEL, 0.06) + this.run(fmt0(n.mn), MONO_SEMI, 16, TEXT) +
      this.run(' · MAX ', SANS_SEMI, 16, LABEL, 0.06) + this.run(fmt0(n.mx), MONO_SEMI, 16, TEXT), 16, 'r');
    // Pacing: shares of frames on time, one target frame late, and longer.
    if (n.pacing) {
      const p = n.pacing, ms = (c) => fmtMs(c * refreshMs);
      const labOn = kRef === 1 ? `${ms(1)} ms` : `≤${ms(kRef)} ms`;
      const labLate = kRef === 1 ? `${ms(2)} ms` : `${ms(kRef + 1)}–${ms(2 * kRef)} ms`;
      const labStall = `≥${ms(2 * kRef + 1)} ms`;
      const share = (v) => v / p.n;
      this.text(tq, tEnd, PW - PAD, L.PACING_BASE,
        this.run(`${labStall} `, SANS_MED, 13, FOOT, 0.04) +
        this.run(`${Math.round(share(p.stall) * 100)}%`, MONO_SEMI, 13, p.stall ? RED : TEXT), 13, 'r');
      this.stackedBar(tq, tEnd, [[share(p.on), BLUE, labOn], [share(p.late), AMBER, labLate], [share(p.stall), RED, labStall]]);
    } else {
      this.text(tq, tEnd, PW - PAD, L.PACING_BASE, this.run('–', MONO_MED, 13, FOOT), 13, 'r');
    }
  }

  drawFrame(tt, tEnd) {
    const f = this.frameAt(tt);
    const L = LAYOUT;
    const { targetMs } = this.m;
    this.slot('last', 3, tt, this.textBody(PAD, L.LAST_BASE,
      this.run('LAST FRAME  ', SANS_SEMI, 16, LABEL, 0.06) +
      this.run(fmt1(f.lastMs), MONO_SEMI, 20, f.lastMs == null ? TEXT : ftTextColor(f.lastMs, targetMs)) +
      this.run(' ms', MONO_SEMI, 13, DIM), 20));
    this.slot('stall', 3, tt, f.stalled ? this.textBody(PW - PAD, L.LAST_BASE,
      this.run('STALL  ', SANS_SEMI, 16, RED, 0.06) + this.run(`${f.elapsed.toFixed(0)} ms`, MONO_SEMI, 20, RED), 20, 'r') : null);
    this.ftChart(tt, f, { key: 'ft', x: PAD, top: L.FT_TOP, w: IW, h: CHART_H, slots: FT_SHOW + 1 });
    const shownFrames = f.last.length + 1;
    this.slot('ftLabelL', 3, tt, this.textBody(PAD, L.FT_LABEL_BASE,
      this.run('FRAME TIME', SANS_SEMI, 16, LABEL, 0.06) +
      this.run(` · ${shownFrames} FRAME${shownFrames === 1 ? '' : 'S'} · ${f.spanS.toFixed(1)} S`, SANS_MED, 13, FOOT, 0.04), 16));
    this.slot('ftMax', 3, tt, this.textBody(PW - PAD, L.FT_LABEL_BASE,
      this.run('MAX ', SANS_SEMI, 16, LABEL, 0.06) +
      this.run(fmt1(f.ftMax), MONO_SEMI, 16, f.ftMax == null ? TEXT : ftTextColor(f.ftMax, targetMs)) +
      this.run(' ms', MONO_SEMI, 13, DIM), 16, 'r'));
    this.text(tt, tEnd, PW - PAD, L.FOOT_BASE, this.run(tc(tt), MONO_MED, 13, LABEL), 13, 'r');
    this.drawLongGraphTick(tt, f);
  }

  // ---- long frame-time graph: 70 % of the width along the bottom edge, a 7.5 s window that scrolls ----

  /** Frame px of the graph, and its origin relative to the panel's (rx, ry) for the panel-px helpers. */
  longGraphGeometry() {
    const frameW = this.w / this.k;
    const GW = Math.round(0.7 * frameW), gx = (frameW - GW) / 2, gy = 1080 - 24 - LG_H;
    const x0 = gx + LG_PAD, iw = GW - 2 * LG_PAD;
    const op = Number(this.opts.longGraphOpacity);
    return {
      GW, gx, gy, x0, iw, top: gy + LG_TOP, speed: iw / LG_WIN,
      alpha: Number.isFinite(op) ? Math.min(1, Math.max(0, op)) : 0.86,
      rx: gx - this.ox, ry: gy - this.oy,
    };
  }

  drawLongGraphChrome(D) {
    const g = this.lg, { targetMs } = this.m, px = (v) => this.px(v);
    const top = g.ry + LG_TOP, x0 = g.rx + LG_PAD;
    this.shape(0, D, roundedPath(px(g.gx), px(g.gy), px(g.GW), px(LG_H), px(10)), PANEL, g.alpha, 0);
    this.text(0, D, x0, g.ry + 22, this.run('FRAME TIME', SANS_SEMI, 16, LABEL, 0.06) +
      this.run(` · LAST ${LG_WIN} S`, SANS_MED, 13, FOOT, 0.04), 16);
    this.rects(0, D, [[x0, top + LG_CH, g.iw, 1]], LINE, 1.0);
    const g1 = LG_CH / 3, g2 = LG_CH * 2 / 3;
    this.rects(0, D, [[x0, top + LG_CH - g1, g.iw, 1]], TEXT, 0.45, 3);
    this.rects(0, D, [[x0, top + LG_CH - g2, g.iw, 1]], TEXT, 0.22, 3);
    this.chartLabelLeft(0, D, x0, top + LG_CH - g1 + 3, `${targetMs.toFixed(1)} ms`);
    this.chartLabelLeft(0, D, x0, top + LG_CH - g2 + 3, (2 * targetMs).toFixed(1));
  }

  /** The frame on screen (f, from frameAt(tt)) growing at the right edge, and the window's MAX. */
  drawLongGraphTick(tt, f) {
    if (!this.lg) return;
    const g = this.lg, { targetMs } = this.m, scale = 3 * targetMs;
    const wl = Math.min(g.iw, Math.max(1, f.elapsed / 1000 * g.speed));
    const hl = Math.max(2.0, Math.min(1.0, f.elapsed / scale) * LG_CH);
    this.liveBar(tt, g.rx + LG_PAD + g.iw - wl, wl + 2, hl, f.stalled, g.ry + LG_TOP + LG_CH, 'lgLive');
    const { frameMs } = this.a, ends = this.ends;
    let mx = f.stalled ? f.elapsed : 0;
    for (let i = bisectRight(ends, tt - LG_WIN), hi = bisectRight(ends, tt); i < hi; i++) if (frameMs[i] > mx) mx = frameMs[i];
    this.slot('lgMax', 3, tt, mx ? this.textBody(g.rx + g.GW - LG_PAD, g.ry + 22,
      this.run('MAX ', SANS_SEMI, 16, LABEL, 0.06) + this.run(fmt1(mx), MONO_SEMI, 16, ftTextColor(mx, targetMs)) +
      this.run(' ms', MONO_SEMI, 13, DIM), 16, 'r') : null);
  }

  /** One moving event per completed frame: it appears at the right edge when the frame
   * ends and glides left at the window's speed, clipped to the chart. */
  drawLongGraphBars(D) {
    const g = this.lg, { targetMs } = this.m, scale = 3 * targetMs, px = (v) => this.px(v);
    const { frameMs } = this.a, ends = this.ends;
    const clip = `\\clip(${Math.floor(px(g.x0))},${Math.floor(px(g.top))},${Math.ceil(px(g.x0 + g.iw))},${Math.ceil(px(g.top + LG_CH + 1))})`;
    const move = (x1, y) => `\\move(${f1(px(x1))},${f1(px(y))},${f1(px(x1 - g.speed * LG_WIN))},${f1(px(y))},0,${LG_WIN * 1000})`;
    for (let i = 0; i < frameMs.length; i++) {
      const e = ends[i];
      if (e > D) break;
      const ms = frameMs[i], t1 = Math.min(D, e + LG_WIN);
      const w = Math.max(1, ms / 1000 * g.speed - 1), h = Math.max(2.0, Math.min(1.0, ms / scale) * LG_CH);
      const x1 = g.x0 + g.iw - w, y = g.top + LG_CH - h;
      this.emit(2, e, t1, `{\\an7${move(x1, y)}${clip}\\shad0\\p1\\bord0\\c${assColor(ftBarColor(ms, targetMs))}}` +
        rectsPath([[0, 0, px(w), px(h)]]) + '{\\p0}');
      if (ms > scale * 1.001) { // value box to the left of the bar, moving with it
        const s = ms.toFixed(0), size = 13, lw = monoW(s, size) + 8, lh = 17, lx = x1 - 2 - lw, ly = g.top + 2;
        this.emit(3, e, t1, `{\\an7${move(lx, ly)}${clip}\\shad0\\p1\\bord0\\c${assColor(PANEL)}\\1a&H24&}` +
          roundedPath(0, 0, px(lw), px(lh), px(2)) + '{\\p0}');
        this.emit(4, e, t1, `{\\an3${move(lx + lw - 4, ly + lh)}${clip}\\bord0\\shad0}` + this.run(s, MONO_SEMI, size, RED));
      }
    }
  }

  /** Run every pass; the events end up in this.lines. */
  render() {
    const a = this.a;
    const target = a.target, targetMs = 1000.0 / target;
    const refreshMs = a.hz ? 1000.0 / a.hz : targetMs;
    this.m = {
      target, targetMs, refreshMs,
      kRef: Math.max(1, Math.round(targetMs / refreshMs)),
      floorS: targetMs / 1000,
      stallMs: Math.max(STALL_LIVE_MS, STALL_LIVE_FRAMES * targetMs),
      yMax: Math.max(target, Math.min(1.25 * target, a.hz || 1.25 * target)),
    };
    if (!Array.isArray(a.droppedAt)) a.droppedAt = [];
    this.ends = a.starts.map((s, i) => s + a.frameMs[i] / 1000.0);
    this.sortedDone = [];
    this.doneCount = 0;
    this.missedCount = 0;
    this.lines = [];
    this.slots = new Map();

    const D = a.duration;
    this.lg = this.opts.longGraph ? this.longGraphGeometry() : null;
    this.drawChrome(D);
    const nNum = Math.ceil(D / FPS_BUCKET);
    for (let u = 0; u < nNum; u++) this.drawNumbers(u * FPS_BUCKET, Math.min(D, (u + 1) * FPS_BUCKET));
    const nTick = Math.ceil(D * this.rate);
    for (let u = 0; u < nTick; u++) this.drawFrame(u / this.rate, Math.min(D, (u + 1) / this.rate));
    this.flushSlots(D);
    if (this.lg) this.drawLongGraphBars(D);
  }

  /** The whole subtitle as text. Fine for clips of minutes; long clips go through writeTo(). */
  build() {
    this.render();
    return this.head().concat(this.lines).join('\n') + '\n';
  }

  /** Write the subtitle to a file in slices, so an hour-long clip never needs one 500 MB string. */
  writeTo(file, { at } = {}) {
    this.render();
    let lines = this.lines;
    if (typeof at === 'number') { // one moment only, for a preview frame: its events, re-timed to the first second
      const EVT = /^Dialogue: (\d+),([\d:.]+),([\d:.]+),/;
      const secs = (s) => s.split(':').reduce((acc, v) => acc * 60 + Number(v), 0);
      const MOVE = /\\move\(([\d.]+),([\d.]+),([\d.]+),([\d.]+),(\d+),(\d+)\)/;
      lines = this.lines.filter((l) => { const m = EVT.exec(l); return secs(m[2]) <= at && at < secs(m[3]); })
        .map((l) => {
          const t0 = secs(EVT.exec(l)[2]);
          // A moving event is frozen where it would be at `at`.
          const frozen = l.replace(MOVE, (_, x1, y1, x2, y2, m1, m2) => {
            const k = Math.min(1, Math.max(0, ((at - t0) * 1000 - m1) / (m2 - m1)));
            return `\\pos(${f1(+x1 + (x2 - x1) * k)},${f1(+y1 + (y2 - y1) * k)})`;
          });
          return frozen.replace(EVT, 'Dialogue: $1,0:00:00.00,0:00:01.00,');
        });
    }
    const fd = fs.openSync(file, 'w');
    try {
      fs.writeSync(fd, this.head().join('\n') + '\n');
      for (let i = 0; i < lines.length; i += 50000) fs.writeSync(fd, lines.slice(i, i + 50000).join('\n') + '\n');
    } finally {
      fs.closeSync(fd);
    }
    return file;
  }

  head() {
    return [
      '[Script Info]',
      'ScriptType: v4.00+',
      `PlayResX: ${this.w}`,
      `PlayResY: ${this.h}`,
      'ScaledBorderAndShadow: yes',
      'WrapStyle: 2',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, ' +
        'OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ' +
        'ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, ' +
        'Alignment, MarginL, MarginR, MarginV, Encoding',
      `Style: HUD,${SANS},${(this.px(16) * FS_PER_PX).toFixed(0)},${assColor(TEXT)},` +
        `${assColor(TEXT)},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ];
  }
}

// ---- look B: one strip along the top edge ----

const STRIP = (() => {
  const heroX = 22, heroEnd = heroX + monoW('888', 46) * 0.97 + 8 + 36 + 22;
  const col = 88; // fits "483.3 ms" (five mono digits at 22 px plus the unit)
  const stats = heroEnd + 23, chart = stats + 4 * col + 2 + 23, pacing = chart + 269 + 22 + 23;
  const rightBlock = pacing + 120 + 22 + 23, right = rightBlock + 196;
  const S = Object.freeze({ H: 76, W: Math.round(right + 22), heroX, col, divs: [heroEnd, stats + 4 * col + 2, chart + 269 + 22, rightBlock - 23],
    stats, chart, pacing, right });
  if (S.divs[1] < stats + 4 * col || S.divs[2] < chart + 269) throw new Error('strip divider inside a group');
  return S;
})();

class StripOverlay extends Overlay {
  static W = STRIP.W;
  static H = STRIP.H;

  drawChrome(D) {
    const S = STRIP, { W, H } = S;
    // Dark fill at 84 % with a faint white hairline edge (shape: fill colour, edge alpha, layer, edge colour, fill alpha).
    this.shape(0, D, roundedPath(this.px(this.ox), this.px(this.oy), this.px(W), this.px(H), this.px(16)), PANEL, 0.08, 0, 0xFFFFFF, 0.84);
    for (const x of S.divs) this.rects(0, D, [[x, 18, 1, 40]], LINE, 1.0, 1);
    ['FRAME', 'AVG 10 S', '1% LOW', 'MAX'].forEach((s, i) => {
      this.text(0, D, S.stats + i * S.col, 31, this.run(s, SANS_MED, 11, FOOT, 0.06), 11);
    });
    this.text(0, D, S.pacing, 31, this.run('PACING 10 S', SANS_MED, 11, FOOT, 0.06), 11);
    this.drawPills(D, S.right, 16, 13);
    this.text(0, D, S.right, 58, this.run(this.fitTitle(196, 11, 0.08), SANS_SEMI, 11, DIM, 0.08), 11, 'r');
    this.drawExtras(D);
  }

  drawNumbers(tq, tEnd) {
    const n = this.numbersAt(tq), S = STRIP, { target } = this.m;
    const heroS = fmt0(n.hero);
    this.text(tq, tEnd, S.heroX, 54, this.run(heroS, MONO_SEMI, 46, n.hero == null ? TEXT : levelColor(n.hero, target), -0.03), 46);
    const lx = S.heroX + monoW(heroS, 46, -0.03) + 8;
    this.slot('heroFps', 3, tq, this.textBody(lx, 37, this.run('FPS', SANS_SEMI, 13, LABEL, 0.06), 13));
    this.slot('heroSub', 3, tq, this.textBody(lx, 54, this.run('0.5 S', SANS_MED, 11, FOOT, 0.06), 11));
    this.text(tq, tEnd, S.stats + S.col, 56, this.run(fmt1(n.avg), MONO_SEMI, 22, n.avg == null ? TEXT : levelColor(n.avg, target)), 22);
    this.text(tq, tEnd, S.stats + 2 * S.col, 56, this.run(fmt1(n.low), MONO_SEMI, 22, n.low == null ? TEXT : levelColor(n.low, target)), 22);
    const p = n.pacing;
    if (!p) return;
    const sh = (v) => v / p.n, pct = (v) => `${Math.round(sh(v) * 100)}%`;
    this.stackedBar(tq, tEnd, [[sh(p.on), BLUE], [sh(p.late), AMBER], [sh(p.stall), RED]], S.pacing, 40, 120, 6, false);
    this.text(tq, tEnd, S.pacing, 60, this.run(pct(p.on), MONO_SEMI, 11, TEXT), 11);
    this.text(tq, tEnd, S.pacing + 120, 60, this.run(`${pct(p.late)} · ${pct(p.stall)}`, MONO_MED, 11, p.stall ? RED : FOOT), 11, 'r');
  }

  drawFrame(tt, tEnd) {
    const f = this.frameAt(tt), S = STRIP, { targetMs } = this.m;
    const ms = (v) => this.run(fmt1(v), MONO_SEMI, 22, v == null ? TEXT : ftTextColor(v, targetMs)) + this.run(' ms', MONO_SEMI, 11, DIM);
    this.slot('last', 3, tt, this.textBody(S.stats, 56, ms(f.lastMs), 22));
    this.slot('ftMax', 3, tt, this.textBody(S.stats + 3 * S.col, 56, ms(f.ftMax), 22));
    this.ftChart(tt, f, { key: 'sft', x: S.chart, top: 18, w: 269, h: 40, slots: FT_SHOW + 1 });
    this.drawLongGraphTick(tt, f);
  }
}

// ---- look C: three glass tiles ----

const GLASS = Object.freeze({ W: 320, H: 352, tiles: [[0, 134], [144, 76], [230, 122]], lineX: 168, lineR: 304, lineY: 116, lineH: 56, colX: [16, 90, 164, 238] });

class GlassOverlay extends Overlay {
  static W = GLASS.W;
  static H = GLASS.H;

  drawChrome(D) {
    const G = GLASS, { target, yMax } = this.m;
    for (const [y, h] of G.tiles) {
      this.shape(0, D, roundedPath(this.px(this.ox), this.px(this.oy + y), this.px(G.W), this.px(h), this.px(14)), PANEL, 0.08, 0, 0xFFFFFF, 0.74);
    }
    const pillsW = this.drawPills(D, G.W - 16, 14, 11);
    this.text(0, D, 18, 29, this.run(this.fitTitle(G.W - 36 - pillsW, 12, 0.08), SANS_SEMI, 12, DIM, 0.08), 12);
    this.text(0, D, G.lineX, 128, this.run('LAST 10 S', SANS_MED, 10, FOOT, 0.06), 10);
    const lw = G.lineR - G.lineX;
    this.rects(0, D, [[G.lineX, G.lineY, lw, 1]], LINE, 1.0);
    this.rects(0, D, [[G.lineX, G.lineY - G.lineH * (target / yMax), lw, 1]], TEXT, 0.45, 3);
    // MISSED is right-aligned at the tile edge so a long FRAME value has room.
    ['AVG 10 S', '1% LOW', 'FRAME', 'MISSED'].forEach((s, i) => {
      this.text(0, D, i === 3 ? G.W - 16 : G.colX[i], 172, this.run(s, SANS_MED, 11, FOOT, 0.06), 11, i === 3 ? 'r' : 'l');
    });
    this.text(0, D, 16, 256, this.run('FRAME TIME', SANS_SEMI, 12, LABEL, 0.06), 12);
    this.drawExtras(D);
  }

  drawNumbers(tq, tEnd) {
    const n = this.numbersAt(tq), G = GLASS, { target, yMax } = this.m;
    const heroS = fmt0(n.hero);
    this.text(tq, tEnd, 16, 114, this.run(heroS, MONO, 76, n.hero == null ? TEXT : levelColor(n.hero, target), -0.05), 76);
    const lx = 16 + monoW(heroS, 76, -0.05) + 4;
    this.slot('heroFps', 3, tq, this.textBody(lx, 90, this.run('FPS', SANS_SEMI, 13, LABEL, 0.06), 13));
    this.slot('heroSub', 3, tq, this.textBody(lx, 108, this.run('0.5 S', SANS_MED, 11, FOOT, 0.06), 11));
    // The 10 s FPS line: a flat-filled area under it and the line as thin quads (libass has no gradients).
    if (n.bars.length > 1) {
      const lw = G.lineR - G.lineX, { ox, oy } = this, X = (v) => f1(this.px(ox + v)), Y = (v) => f1(this.px(oy + v));
      const pts = n.bars.map((b, i) => [G.lineX + i * lw / (FPS_BARS - 1), G.lineY - Math.min(1, b.fps / yMax) * G.lineH]);
      const area = `m ${X(pts[0][0])} ${Y(G.lineY)} l ` + pts.map(([x, y]) => `${X(x)} ${Y(y)}`).join(' ') + ` ${X(pts[pts.length - 1][0])} ${Y(G.lineY)}`;
      this.shape(tq, tEnd, area, BLUE, 0.25, 2);
      const line = pts.slice(1).map(([x, y], i) => {
        const [x0, y0] = pts[i];
        return `m ${X(x0)} ${Y(y0 - 1)} l ${X(x)} ${Y(y - 1)} ${X(x)} ${Y(y + 1)} ${X(x0)} ${Y(y0 + 1)}`;
      }).join(' ');
      this.shape(tq, tEnd, line, BLUE, 1.0, 2);
      this.text(tq, tEnd, G.lineR, 128, this.run(`MIN ${fmt0(n.mn)} · MAX ${fmt0(n.mx)}`, MONO_MED, 10, FOOT), 10, 'r');
    }
    const val = (i, s, col) => this.text(tq, tEnd, G.colX[i], 203, this.run(s, MONO_SEMI, 22, col), 22);
    val(0, fmt1(n.avg), n.avg == null ? TEXT : levelColor(n.avg, target));
    val(1, fmt1(n.low), n.low == null ? TEXT : levelColor(n.low, target));
    this.text(tq, tEnd, G.W - 16, 203, this.run(n.missed == null ? '–' : `${Math.round(n.missed * 100)}%`, MONO_SEMI, 22, TEXT), 22, 'r');
    const p = n.pacing;
    if (!p) return;
    const sh = (v) => v / p.n, pct = (v) => `${Math.round(sh(v) * 100)}%`;
    this.stackedBar(tq, tEnd, [[sh(p.on), BLUE], [sh(p.late), AMBER], [sh(p.stall), RED]], 16, 326, G.W - 32, 5, false);
    this.text(tq, tEnd, 16, 345, this.run(`ON TIME ${pct(p.on)}`, MONO_MED, 10, FOOT), 10);
    this.text(tq, tEnd, G.W - 16, 345, this.run(`LATE ${pct(p.late)} · STALL ${pct(p.stall)}`, MONO_MED, 10, p.stall ? RED : FOOT), 10, 'r');
  }

  drawFrame(tt, tEnd) {
    const f = this.frameAt(tt), G = GLASS, { targetMs } = this.m;
    this.slot('last', 3, tt, this.textBody(G.colX[2], 203,
      this.run(fmt1(f.lastMs), MONO_SEMI, 22, f.lastMs == null ? TEXT : ftTextColor(f.lastMs, targetMs)) + this.run(' ms', MONO_SEMI, 11, DIM), 22));
    this.slot('ftMax', 3, tt, this.textBody(G.W - 16, 256,
      this.run('MAX ', SANS_SEMI, 12, LABEL, 0.06) + this.run(fmt1(f.ftMax), MONO_SEMI, 12, f.ftMax == null ? TEXT : ftTextColor(f.ftMax, targetMs)) +
      this.run(' ms', MONO_SEMI, 10, DIM), 12, 'r'));
    this.ftChart(tt, f, { key: 'gft', x: 16, top: 266, w: G.W - 32, h: 50, slots: FT_SHOW + 1 });
    this.drawLongGraphTick(tt, f);
  }
}

// ---- look D: no overlay, only the extras (watermark, caption, long graph) ----

class NoneOverlay extends Overlay {
  drawChrome(D) { this.drawExtras(D); }
  drawNumbers() {}
  drawFrame(tt) { if (this.lg) this.drawLongGraphTick(tt, this.frameAt(tt)); }
}

const STYLES = ['panel', 'strip', 'glass', 'none'];
const LOOKS = { panel: Overlay, strip: StripOverlay, glass: GlassOverlay, none: NoneOverlay };
/** The overlay for opts.style (panel when unknown). */
function createOverlay(a, size, title, rate, position, capture, opts = {}) {
  return new (STYLES.includes(opts.style) ? LOOKS[opts.style] : Overlay)(a, size, title, rate, position, capture, opts);
}

/** ffmpeg 'ass' filter, pointed at the bundled fonts. */
function assFilter(assName, cwd, fontsDir) {
  if (!fontsDir) return `ass=${assName}`;
  return `ass=${assName}:fontsdir=${filterPath(fontsDir, cwd)}`;
}

/** A path as a quoted ffmpeg filter option, relative to cwd (absolute across drives). */
function filterPath(p, cwd) {
  const rel = path.relative(path.resolve(cwd), p);
  return `'${rel.split(path.sep).join('/').replace(/:/g, '\\:').replace(/'/g, "'\\''")}'`;
}

const POSITIONS = ['left', 'center', 'right'];
const CAPTION_POSITIONS = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'];

module.exports = {
  Overlay, StripOverlay, GlassOverlay, NoneOverlay, createOverlay, STYLES,
  assFilter, filterPath, assTime, assColor, tc, weightedFrames, POSITIONS, CAPTION_POSITIONS, LAYOUT,
  COLORS: Object.freeze({ PANEL, LINE, TEXT, LABEL, DIM, FOOT, BLUE, AMBER, RED }),
};
