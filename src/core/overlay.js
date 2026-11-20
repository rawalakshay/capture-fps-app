'use strict';
// Burned-in overlay as ASS subtitles (rendered by ffmpeg/libass).
// Palette and fonts follow the onionHEN performance overlay design; the layout
// is in CSS px at 1080p, scaled to the output height. Every number states its
// window, and frames are counted by time so a locked frame rate reads flat.

const fs = require('fs');
const path = require('path');
const { bisectLeft, bisectRight, percentile, summarise, isPlay } = require('./analysis');

const MONO = 'IBM Plex Mono', MONO_MED = 'IBM Plex Mono Medm', MONO_SEMI = 'IBM Plex Mono SmBld';
const SANS = 'IBM Plex Sans Cond', SANS_MED = 'IBM Plex Sans Cond Medm', SANS_SEMI = 'IBM Plex Sans Cond SmBld';
const MONO_FONTS = new Set([MONO, MONO_MED, MONO_SEMI]);
const PLEX = { MONO, MONO_MED, MONO_SEMI, SANS, SANS_MED, SANS_SEMI };
// Colour themes (opts.theme). BLUE is the "on target" colour; BAR_A is the alpha
// on-target bars are filled with; HERO replaces the hero number's font when set;
// FAX shears the sans runs; ACCENT, GLOW and TWO_TONE are decorations the Panel
// look draws. classic is the original palette and the fallback.
const THEMES = Object.freeze({
  classic: Object.freeze({
    PANEL: 0x0A0C0F, PANEL_A: 0.86, LINE: 0x3A434C, LINE_A: 1.0,
    TEXT: 0xEEF2F5, LABEL: 0xC9D0D6, DIM: 0xA7B0B8, FOOT: 0x8E98A1,
    BLUE: 0x5AA9E6, AMBER: 0xF5B13D, RED: 0xF2545B, BAR_A: 1.0, HERO: null, FAX: 0, ...PLEX,
  }),
  mono: Object.freeze({
    PANEL: 0x0A0C0F, PANEL_A: 0.82, LINE: 0xFFFFFF, LINE_A: 0.12,
    TEXT: 0xEEF2F5, LABEL: 0xC9D0D6, DIM: 0xA7B0B8, FOOT: 0x8E98A1,
    BLUE: 0xEEF2F5, AMBER: 0xF5B13D, RED: 0xF2545B, BAR_A: 0.55, HERO: null, FAX: 0, ...PLEX,
  }),
  aurora: Object.freeze({
    PANEL: 0x080C16, PANEL_A: 0.86, LINE: 0x22D3EE, LINE_A: 0.35,
    TEXT: 0xE6FBFF, LABEL: 0xA5F3FC, DIM: 0xCBD5E1, FOOT: 0x94A3B8,
    BLUE: 0x22D3EE, AMBER: 0xFBBF24, RED: 0xFB7185, BAR_A: 1.0, HERO: null, FAX: 0, ...PLEX,
    ACCENT: 'left', GLOW: true,
  }),
  vice: Object.freeze({
    PANEL: 0x150A24, PANEL_A: 0.88, LINE: 0xFF4FA3, LINE_A: 0.30,
    TEXT: 0xFDF2F8, LABEL: 0xE9D5FF, DIM: 0xC4B5FD, FOOT: 0xA78BFA,
    BLUE: 0xFF4FA3, AMBER: 0xFF8A3D, RED: 0xFF3344, BAR_A: 1.0, FAX: -0.18,
    MONO, MONO_MED, MONO_SEMI, SANS: 'Oswald Medium', SANS_MED: 'Oswald Medium', SANS_SEMI: 'Oswald Bold', HERO: 'Oswald Bold',
    ACCENT: 'top', TWO_TONE: true,
  }),
});
const THEME_NAMES = Object.freeze(Object.keys(THEMES));
const HERO_CAP = 0.81; // Oswald cap height in em, for the two-tone split
// libass sizes a font by ascent + descent (1.3 em for Plex), CSS by its em.
const FS_PER_PX = 1.3, DESCENT = 0.275;
// Inter (the A/B and timeline names) is 1.21 em; its 0.03 em smaller descent is left to DESCENT.
const FS_PER_FONT = { 'Inter Medium': 1.21, 'Inter SemiBold': 1.21 };

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
const TEAR_SHOW_S = 0.4;                  // a tear line stays on the video this long, fading out
const END_CARD_S = 4;                     // the results card after the clip (opts.endCard)
const HOLD_NAMES = { hitch: 'HITCH', static: 'STILL', loading: 'LOADING', gap: 'NO VIDEO' };

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
  RUN_COLS: Object.freeze([1, 2, 3, 4, 5].map((i) => PAD + IW * i / 5)),
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
function weightedFrames(starts, ends, t0, t1, tNow, floorS = 0, kinds = null) {
  let total = 0;
  for (let i = bisectRight(ends, t0); i < starts.length && starts[i] < t1; i++) {
    const st = starts[i];
    if (st > tNow) break;
    if (kinds && !isPlay(kinds[i])) continue;
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
    this.c = THEMES[opts.theme] || THEMES.classic;
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

  /** Text colour for a frame rate against the target: on target, a little under, well under. */
  levelColor(fps, target) {
    if (fps >= 0.95 * target) return this.c.TEXT;
    if (fps >= 0.8 * target) return this.c.AMBER;
    return this.c.RED;
  }
  barColor(fps, target) {
    if (fps >= 0.95 * target) return this.c.BLUE;
    if (fps >= 0.8 * target) return this.c.AMBER;
    return this.c.RED;
  }
  /** Bar and text colours for a frame time against the target frame time. */
  ftBarColor(ms, targetMs) {
    if (ms <= targetMs * 1.2) return this.c.BLUE;
    if (ms <= targetMs * 2.05) return this.c.AMBER;
    return this.c.RED;
  }
  ftTextColor(ms, targetMs) {
    if (ms <= targetMs * 1.2) return this.c.TEXT;
    if (ms <= targetMs * 2.05) return this.c.AMBER;
    return this.c.RED;
  }
  /** On-target bars may be translucent (mono draws them as white at 55 %); the rest are solid. */
  barAlpha(color) { return color === this.c.BLUE ? this.c.BAR_A : 1.0; }

  /** One styled text run; size in CSS px, spacing in em. The theme's shear applies to sans runs. */
  run(s, font, size, color, spacing = 0.0) {
    const fax = this.c.FAX && !MONO_FONTS.has(font) ? `\\fax${this.c.FAX}` : '';
    return `{\\fn${font}\\fs${f1(this.px(size) * (FS_PER_FONT[font] || FS_PER_PX))}` +
      `\\fsp${this.px(size * spacing).toFixed(2)}${fax}\\c${assColor(color)}}${s}`;
  }

  // ---- event bodies and emission ----

  /** Runs with their baseline at (x, baseline) in panel px; size is the
   * largest run size in the line (it sets the descent libass anchors by).
   * extra: more override tags (\clip, \blur) for the line. */
  textBody(x, baseline, runs, size, align = 'l', extra = '') {
    const an = { l: 1, c: 2, r: 3 }[align];
    const X = this.px(this.ox + x);
    const Y = this.px(this.oy + baseline + DESCENT * size);
    return `{\\an${an}\\pos(${f1(X)},${f1(Y)})\\bord0\\shad0${extra}}${runs}`;
  }

  /** A drawing in output px. With an outline colour the fill is fillAlpha
   * (0 = hollow, as the pills are) and the 1 px border takes alpha. */
  shapeBody(p, color, alpha, outline = null, fillAlpha = 0, extra = '') {
    const aa = hex2(Math.round((1 - alpha) * 255));
    const style = outline === null
      ? `\\bord0\\c${assColor(color)}\\1a&H${aa}&`
      : `\\bord${f1(this.px(1))}\\c${assColor(color)}\\3c${assColor(outline)}` +
        `\\1a&H${hex2(Math.round((1 - fillAlpha) * 255))}&\\3a&H${aa}&`;
    return `{\\an7\\pos(0,0)\\shad0${extra}\\p1${style}}${p}{\\p0}`;
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

  text(t0, t1, x, baseline, runs, size, align = 'l', layer = 3, extra = '') {
    this.emit(layer, t0, t1, this.textBody(x, baseline, runs, size, align, extra));
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
      this.px(w - 1), this.px(h), this.px(4)), this.c.PANEL, this.c.LINE_A, 1, this.c.LINE);
    this.text(t0, t1, rightX - w / 2, top + LAYOUT.PILL_BASE - LAYOUT.PILL_TOP, this.run(s, this.c.MONO_MED, size, this.c.DIM), size, 'c');
    return w;
  }

  /** Small mono label in a panel-coloured box, left-aligned at left/top. */
  chartLabelLeft(t0, t1, left, top, s) {
    const size = 13, w = monoW(s, size) + 8, h = size * FS_PER_PX;
    this.shape(t0, t1, roundedPath(this.px(this.ox + left), this.px(this.oy + top), this.px(w), this.px(h), this.px(2)),
      this.c.PANEL, this.c.PANEL_A, 3);
    this.text(t0, t1, left + 4, top + h - DESCENT * size, this.run(s, this.c.MONO_MED, size, this.c.LABEL), size, 'l', 4);
  }

  /** Free text on the video, 24 px in from a corner or edge, outlined so it reads on any footage.
   * At the top on the panel's side it sits below the panel instead. */
  drawCaption(D, s, where, aboveWatermark = false) {
    const [v, h] = where.split('-');
    const frameW = this.w / this.k, margin = 24, size = 28;
    const an = { top: 7, bottom: 1 }[v] + { left: 0, center: 1, right: 2 }[h];
    const x = h === 'left' ? margin : h === 'center' ? frameW / 2 : frameW - margin;
    const y = this.captionY(v, h, aboveWatermark);
    this.emit(3, 0, D, `{\\an${an}\\pos(${f1(this.px(x))},${f1(this.px(y))})\\bord${f1(this.px(2))}\\3c${assColor(this.c.PANEL)}\\shad0}` +
      this.run(s, this.c.SANS_SEMI, size, this.c.TEXT, 0.04));
  }

  /** The caption's y (1080p px) on edge v at side h. */
  captionY(v, h, aboveWatermark) {
    const margin = 24;
    // Bottom left is the watermark's spot; with the long graph on, the whole bottom edge is taken.
    if (v === 'bottom') return 1080 - margin + (this.lg ? this.lg.gy - 16 - (1080 - margin) : aboveWatermark && h === 'left' ? -40 : 0);
    return h === this.position ? this.oy + this.H + 16 : margin;
  }

  /** The theme's accent on a W x H box at the panel origin with corner radius R: a light down the left edge, or a pink-orange top edge. */
  drawAccent(D, W, H, R) {
    const c = this.c, px = (v) => this.px(v), { ox, oy } = this;
    if (c.ACCENT === 'left') this.shape(0, D, roundedPath(px(ox), px(oy + 12), px(3), px(H - 24), px(1.5)), c.BLUE, 1.0, 1);
    else if (c.ACCENT === 'top') {
      const p = roundedPath(px(ox + 1), px(oy + 1), px(W - 2), px(H - 2), px(R - 1));
      const clip = (x1, x2) => `\\clip(${Math.round(px(x1))},${Math.round(px(oy))},${Math.round(px(x2))},${Math.round(px(oy + 4))})`;
      this.emit(1, 0, D, this.shapeBody(p, c.BLUE, 1.0, null, 0, clip(ox, ox + W / 2)));
      this.emit(1, 0, D, this.shapeBody(p, c.AMBER, 1.0, null, 0, clip(ox + W / 2, ox + W)));
    }
  }

  /** Watermark at the bottom left: smaller and dimmer than a caption, outlined, 80 % opaque. */
  drawWatermark(D, s) {
    this.emit(3, 0, D, `{\\an1\\pos(${f1(this.px(24))},${f1(this.px(1056))})\\bord${f1(this.px(1.5))}\\3c${assColor(this.c.PANEL)}` +
      `\\1a&H33&\\3a&H33&\\shad0}` + this.run(s, this.c.SANS_SEMI, 22, this.c.LABEL, 0.04));
  }

  /** Value box at the top of the frame-time chart for a bar taller than the scale. */
  overflowLabel(i, t, xBar, barW, ms, top = LAYOUT.FT_TOP + 2, mid = PAD + IW / 2, key = 'ovl') {
    const s = ms.toFixed(0), size = 13, w = monoW(s, size) + 8, h = 17;
    const lx = xBar + barW / 2 > mid ? xBar - 2 - w : xBar + barW + 2;
    this.slot(`${key}${i}b`, 3, t, this.shapeBody(roundedPath(this.px(this.ox + lx), this.px(this.oy + top),
      this.px(w), this.px(h), this.px(2)), this.c.PANEL, this.c.PANEL_A));
    this.slot(`${key}${i}t`, 4, t, this.textBody(lx + w - 4, top + h - DESCENT * size, this.run(s, this.c.MONO_SEMI, size, this.c.RED), size, 'r'));
  }

  /** Outlined bar for the frame still on screen; inset 1 px so the border stays in its column.
   * stalled: 'hitch' draws it red, 'paused' (a still or a load) dim, anything else plain. */
  liveBar(t, x, w, h, stalled, bottom = LAYOUT.FT_TOP + CHART_H, key = 'ftLive') {
    const col = stalled === 'hitch' ? this.c.RED : stalled === 'paused' ? this.c.FOOT : this.c.LABEL;
    const { ox, oy } = this;
    const p = rectsPath([[this.px(ox + x + 1), this.px(oy + bottom - h + 1),
      this.px(Math.max(0.5, w - 2)), this.px(Math.max(0.5, h - 2))]]);
    this.slot(key, 2, t, this.shapeBody(p, col, 1.0, col, stalled === 'hitch' ? 0.55 : 0.3));
  }

  /** Frame-time chart: fixed columns filled from the right, the newest completed frame
   * next to the frame on screen in the last column; bars taller than the 3x scale get a value box. */
  ftChart(tt, f, { key, x, top, w, h, slots }) {
    const { targetMs } = this.m;
    const fbw = (w - (slots - 1)) / slots, scale = 3 * targetMs;
    const first = slots - 1 - f.last.length;
    const groups = new Map([[this.c.BLUE, []], [this.c.AMBER, []], [this.c.RED, []], [this.c.FOOT, []]]);
    const keys = new Map([[this.c.BLUE, `${key}Blue`], [this.c.AMBER, `${key}Amber`], [this.c.RED, `${key}Red`], [this.c.FOOT, `${key}Dim`]]);
    const overflow = [];
    f.last.forEach((ms, j) => {
      const bh = Math.max(2.0, Math.min(1.0, ms / scale) * h);
      const bx = x + (first + j) * (fbw + 1);
      const play = isPlay(f.lastKinds[j]);
      groups.get(play ? this.ftBarColor(ms, targetMs) : this.c.FOOT).push([bx, top + h - bh, fbw, bh]);
      if (ms > scale * 1.001 && play) overflow.push({ x: bx, ms });
    });
    for (const [col, rs] of groups) this.slot(keys.get(col), 2, tt, rs.length ? this.rectsBody(rs, col, this.barAlpha(col)) : null);
    const shown = overflow.slice(-MAX_OVERFLOW_LABELS), okey = key === 'ft' ? 'ovl' : `${key}ovl`;
    for (let i = 0; i < MAX_OVERFLOW_LABELS; i++) {
      if (shown[i]) this.overflowLabel(i, tt, shown[i].x, fbw, shown[i].ms, top + 2, x + w / 2, okey);
      else { this.slot(`${okey}${i}b`, 3, tt, null); this.slot(`${okey}${i}t`, 4, tt, null); }
    }
    this.liveBar(tt, x + (slots - 1) * (fbw + 1), fbw, Math.max(2.0, Math.min(1.0, f.elapsed / scale) * h), f.stallKind, top + h, `${key}Live`);
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
      this.shape(t0, t1, roundedPath(this.px(this.ox + x), this.px(this.oy + y), this.px(w), this.px(h), this.px(2)), color, this.barAlpha(color), 2);
      if (labels) {
        const pct = `${Math.round(share * 100)}%`, full = `${label}  ${pct}`;
        const s = w >= monoW(full, 13) + 10 ? full : w >= monoW(pct, 13) + 8 ? pct : null;
        if (s) this.text(t0, t1, x + w / 2, y + h - 3.5, this.run(s, this.c.MONO_SEMI, 13, this.c.PANEL), 13, 'c');
      }
      x += w + 2;
    }
  }

  // ---- model ----

  /** Keep the completed play frames' times sorted as ticks advance (for the RUN percentiles);
   * stills and loads only add to the paused time. */
  absorbCompleted(hi) {
    const { frameMs, kind } = this.a;
    for (; this.doneCount < hi; this.doneCount++) {
      const ms = frameMs[this.doneCount];
      if (!isPlay(kind[this.doneCount])) { this.pausedS += ms / 1000; continue; }
      this.sortedDone.splice(bisectLeft(this.sortedDone, ms), 0, ms);
      if (ms > this.m.targetMs + this.m.refreshMs * 0.5) this.missedCount++;
    }
  }

  /** Seconds of [t0, t1) spent in stills and loads, the frame on screen at tNow included. */
  pausedIn(t0, t1, tNow) {
    const { starts, kind } = this.a, ends = this.ends;
    let s = 0;
    for (let i = bisectRight(ends, t0); i < starts.length && starts[i] < t1; i++) {
      if (starts[i] > tNow || isPlay(kind[i])) continue;
      s += Math.max(0, Math.min(ends[i], tNow, t1) - Math.max(starts[i], t0));
    }
    return s;
  }

  /** Everything the numbers tick shows at tq. */
  numbersAt(tq) {
    const { starts, frameMs, kind, droppedAt } = this.a;
    const ends = this.ends, hitchAt = this.hitchAt, tearAt = this.tearAt;
    const { target, refreshMs, kRef, floorS, yMax } = this.m;
    const minSpan = refreshMs / 1000;
    // Stills and loads are not play: their time comes off the window.
    const rate = (span) => {
      if (span < minSpan) return null;
      const live = span - this.pausedIn(tq - span, tq, tq);
      return live >= minSpan ? weightedFrames(starts, ends, tq - span, tq, tq, floorS, kind) / live : null;
    };
    const hero = rate(Math.min(0.5, tq)), avg = rate(Math.min(10, tq));
    const hiQ = bisectRight(ends, tq);
    const w10 = [];
    for (let i = bisectLeft(ends, tq - 10); i < hiQ; i++) if (isPlay(kind[i])) w10.push(frameMs[i]);
    const s10 = w10.slice().sort((x, y) => x - y);
    const low = s10.length >= MIN_FRAMES_LOW ? 1000 / percentile(s10, 0.99) : null;
    let on = 0, late = 0, stall = 0, short = 0, even = 0;
    for (const ms of w10) {
      const n = Math.round(ms / refreshMs);
      if (n <= kRef) on++; else if (n <= 2 * kRef) late++; else stall++;
      if (n < kRef) short++; else if (n === kRef) even++;
    }
    const pacing = w10.length ? { on, late, stall, n: w10.length } : null;
    // With a cap below the refresh rate, pacing is how many frames held exactly the cap's refreshes.
    const cadence = pacing && kRef > 1 ? { short, even, late, stall, n: w10.length } : null;
    // Run so far: completed play frames plus the share of the frame on screen, over the play time.
    this.absorbCompleted(hiQ);
    let runAvg = null;
    if (tq >= minSpan) {
      const cur = bisectRight(starts, tq) - 1;
      let frac = 0, paused = this.pausedS;
      if (cur >= hiQ) {
        const el = tq - starts[cur];
        if (isPlay(kind[cur])) frac = el / Math.max(el, floorS); else paused += el;
      }
      const live = tq - paused;
      runAvg = live >= minSpan ? (this.sortedDone.length + frac) / live : null;
    }
    const done = this.sortedDone;
    const run1 = done.length >= MIN_FRAMES_LOW ? 1000 / percentile(done, 0.99) : null;
    const run01 = done.length >= MIN_FRAMES_LOW ? 1000 / percentile(done, 0.999) : null;
    const missed = done.length ? this.missedCount / done.length : null;
    const hitches = bisectRight(hitchAt, tq);
    const bucketEnd = Math.floor(tq / FPS_BUCKET) * FPS_BUCKET;
    const bars = [];
    for (let j = 0; j < FPS_BARS; j++) {
      const s = bucketEnd - (FPS_BARS - j) * FPS_BUCKET;
      if (s < 0) continue;
      const live = FPS_BUCKET - this.pausedIn(s, s + FPS_BUCKET, tq);
      // A slice wholly inside a still or a load has no play to rate: it is drawn dim, not as 0 fps.
      const paused = live <= 0;
      const fps = paused ? 0 : weightedFrames(starts, ends, s, s + FPS_BUCKET, tq, floorS, kind) / live;
      const drop = bisectLeft(droppedAt, s) < bisectLeft(droppedAt, s + FPS_BUCKET);
      const hitch = bisectLeft(hitchAt, s) < bisectLeft(hitchAt, Math.min(tq, s + FPS_BUCKET));
      bars.push({ j, fps, drop, hitch, paused });
    }
    const vals = bars.filter((b) => !b.paused).map((b) => b.fps);
    return {
      hero, avg, low, pacing, cadence, runAvg, run1, run01, missed, hitches, bars, yMax, target,
      mn: vals.length ? Math.min(...vals) : null, mx: vals.length ? Math.max(...vals) : null,
      dropsInWindow: bars.some((b) => b.drop),
      tearsInWindow: bisectLeft(tearAt, tq - 10) < bisectRight(tearAt, tq),
    };
  }

  /** The frame on screen and the last completed frames at tt. */
  frameAt(tt) {
    const { starts, frameMs, kind } = this.a;
    const ends = this.ends;
    const hiT = bisectRight(ends, tt);
    const lastMs = hiT > 0 ? frameMs[hiT - 1] : null;
    const cur = bisectRight(starts, tt) - 1;
    const elapsed = cur >= 0 ? (tt - starts[cur]) * 1000 : 0;
    const lo = Math.max(0, hiT - FT_SHOW);
    const last = frameMs.slice(lo, hiT), lastKinds = kind.slice(lo, hiT);
    const spanS = last.length ? ends[hiT - 1] - starts[hiT - last.length] : 0;
    const stalled = elapsed >= this.m.stallMs;
    // What the frame on screen turns out to be; a hold the engine did not class is a plain stall.
    const k = cur >= 0 ? kind[cur] : 'ok';
    const stallKind = !stalled ? null : isPlay(k) ? 'hitch' : 'paused';
    const play = last.filter((_, j) => isPlay(lastKinds[j]));
    return {
      lastMs, elapsed, stalled, stallKind, kind: k, last, lastKinds, spanS,
      ftMax: play.length ? Math.max(...play) : null,
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
  fitTitle(avail, size = 14, spacing = 0.08, width = sansW) {
    let title = cleanText(this.title).toUpperCase();
    if (width(title, size, spacing) > avail) {
      while (title.length > 1 && width(`${title}…`, size, spacing) > avail) title = title.slice(0, -1);
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
    this.shape(0, D, roundedPath(px(ox), px(oy), px(PW), px(PH), px(10)), this.c.PANEL, this.c.PANEL_A, 0);
    const c = this.c;
    if (c.ACCENT === 'left') { // a 3 px light along the left edge, clear of the corners
      this.shape(0, D, roundedPath(px(ox), px(oy + 14), px(3), px(PH - 28), px(1.5)), c.BLUE, 1.0, 1);
    } else if (c.ACCENT === 'top') { // the card's own outline 1 px in, clipped to its top 3 px: pink left, orange right
      const p = roundedPath(px(ox + 1), px(oy + 1), px(PW - 2), px(PH - 2), px(9));
      const clip = (x1, x2) => `\\clip(${Math.round(px(x1))},${Math.round(px(oy))},${Math.round(px(x2))},${Math.round(px(oy + 4))})`;
      this.emit(1, 0, D, this.shapeBody(p, c.BLUE, 1.0, null, 0, clip(ox, ox + PW / 2)));
      this.emit(1, 0, D, this.shapeBody(p, c.AMBER, 1.0, null, 0, clip(ox + PW / 2, ox + PW)));
    }
    // Pills, right to left: target, then the capture format; each can be turned off.
    const pillsW = this.drawPills(D, PW - PAD, LAYOUT.PILL_TOP, 13);
    // Title, cut to fit beside the pills.
    const title = this.fitTitle(IW - Math.max(0, pillsW - 6) - 8);
    this.drawExtras(D);
    this.text(0, D, PAD, L.TITLE_BASE, this.run(title, this.c.SANS_SEMI, 14, this.c.DIM, 0.08), 14);
    this.text(0, D, L.COL2_R, L.EYEBROW_BASE, this.run('LAST 10 S', this.c.SANS_MED, 13, this.c.FOOT, 0.06), 13, 'r');
    this.text(0, D, L.COL1_R, L.GRID_LABEL_BASE, this.run('AVG', this.c.SANS_SEMI, 16, this.c.LABEL, 0.06), 16, 'r');
    this.text(0, D, L.COL2_R, L.GRID_LABEL_BASE, this.run('1% LOW', this.c.SANS_SEMI, 16, this.c.LABEL, 0.06), 16, 'r');
    ['RUN AVG', '1% LOW', '0.1% LOW', 'MISSED', 'HITCHES'].forEach((s, i) => {
      this.text(0, D, L.RUN_COLS[i], L.RUN_LABEL_BASE, this.run(s, this.c.SANS_MED, 13, this.c.FOOT, 0.06), 13, 'r');
    });
    // Chart baselines, the target line and the frame-time grid, labelled at the left.
    this.rects(0, D, [[PAD, L.FPS_TOP + CHART_H, IW, 1], [PAD, L.FT_TOP + CHART_H, IW, 1]], this.c.LINE, this.c.LINE_A);
    const ty = L.FPS_TOP + CHART_H - CHART_H * (target / yMax);
    this.rects(0, D, [[PAD, ty, IW, 1]], this.c.TEXT, 0.45, 3);
    this.chartLabelLeft(0, D, PAD, ty + 3, String(target));
    const g1 = CHART_H / 3, g2 = CHART_H * 2 / 3;
    this.rects(0, D, [[PAD, L.FT_TOP + CHART_H - g1, IW, 1]], this.c.TEXT, 0.45, 3);
    this.rects(0, D, [[PAD, L.FT_TOP + CHART_H - g2, IW, 1]], this.c.TEXT, 0.22, 3);
    this.chartLabelLeft(0, D, PAD, L.FT_TOP + CHART_H - g1 + 3, `${targetMs.toFixed(1)} ms`);
    this.chartLabelLeft(0, D, PAD, L.FT_TOP + CHART_H - g2 + 3, (2 * targetMs).toFixed(1));
    // Below the refresh rate, a frame one refresh late (3 refreshes at 30 fps in 60 Hz) is the pacing line.
    if (this.m.kRef > 1) {
      const gl = CHART_H * (this.m.kRef + 1) / (3 * this.m.kRef);
      this.rects(0, D, [[PAD, L.FT_TOP + CHART_H - gl, IW, 1]], this.c.AMBER, 0.35, 3);
    }
    this.text(0, D, PAD, L.PACING_BASE, this.run('PACING · 10 S', this.c.SANS_SEMI, 16, this.c.LABEL, 0.06), 16);
    const n = a.droppedRefreshes || 0;
    const drops = n ? `${n} rec drop${n === 1 ? '' : 's'}` : 'no rec drops';
    this.text(0, D, PAD, L.FOOT_BASE,
      this.run(`thr ${Number(a.threshold).toFixed(2)} ${shortSource(a.thresholdSource)} · ${drops}`, this.c.SANS, 13, this.c.FOOT), 13);
  }

  drawNumbers(tq, tEnd) {
    const n = this.numbersAt(tq);
    const L = LAYOUT;
    const { target, refreshMs, kRef, yMax } = this.m;
    // Hero and its labels (the labels move with the digit count).
    const heroS = fmt0(n.hero), c = this.c, heroFont = c.HERO || c.MONO_SEMI;
    const heroCol = n.hero == null ? c.TEXT : this.levelColor(n.hero, target);
    const hero = (col) => this.run(heroS, heroFont, 72, col, -0.03);
    if (c.TWO_TONE && heroCol === c.TEXT) { // on target: the digits' top 55 % pink, the rest orange
      const split = Math.round(this.px(this.oy + L.HERO_BASE - 0.45 * HERO_CAP * 72));
      this.text(tq, tEnd, PAD, L.HERO_BASE, hero(c.BLUE), 72, 'l', 3, `\\clip(0,0,${this.w},${split})`);
      this.text(tq, tEnd, PAD, L.HERO_BASE, hero(c.AMBER), 72, 'l', 3, `\\clip(0,${split},${this.w},${this.h})`);
    } else {
      if (c.GLOW) this.text(tq, tEnd, PAD, L.HERO_BASE, hero(heroCol === c.TEXT ? c.BLUE : heroCol), 72, 'l', 2, `\\blur${f1(this.px(6))}\\1a&H80&`);
      this.text(tq, tEnd, PAD, L.HERO_BASE, hero(heroCol), 72);
    }
    const lx = PAD + monoW(heroS, 72, -0.03) + 8;
    this.slot('heroFps', 3, tq, this.textBody(lx, L.HERO_FPS_BASE, this.run('FPS', this.c.SANS_SEMI, 16, this.c.LABEL, 0.06), 16));
    this.slot('heroSub', 3, tq, this.textBody(lx, L.HERO_BASE, this.run('0.5 S', this.c.SANS_MED, 13, this.c.FOOT, 0.06), 13));
    this.text(tq, tEnd, L.COL1_R, L.GRID_VALUE_BASE,
      this.run(fmt1(n.avg), this.c.MONO_SEMI, 26, n.avg == null ? this.c.TEXT : this.levelColor(n.avg, target)), 26, 'r');
    this.text(tq, tEnd, L.COL2_R, L.GRID_VALUE_BASE,
      this.run(fmt1(n.low), this.c.MONO_SEMI, 26, n.low == null ? this.c.TEXT : this.levelColor(n.low, target)), 26, 'r');
    const runVals = [fmt1(n.runAvg), fmt1(n.run1), fmt1(n.run01), n.missed == null ? '–' : `${Math.round(n.missed * 100)}%`, String(n.hitches)];
    runVals.forEach((s, i) => this.text(tq, tEnd, L.RUN_COLS[i], L.RUN_VALUE_BASE, this.run(s, this.c.MONO_SEMI, 20, i === 4 && n.hitches ? this.c.RED : this.c.TEXT), 20, 'r'));
    // FPS chart: 40 slices, time-weighted.
    const bw = (IW - (FPS_BARS - 1) * 2) / FPS_BARS;
    const groups = new Map([[this.c.BLUE, []], [this.c.AMBER, []], [this.c.RED, []], [this.c.FOOT, []]]);
    const tris = [], hitchTris = [];
    for (const b of n.bars) {
      const h = Math.max(2.0, Math.min(1.0, b.fps / yMax) * CHART_H);
      const x = PAD + b.j * (bw + 2);
      groups.get(b.paused ? this.c.FOOT : this.barColor(b.fps, target)).push([x, L.FPS_TOP + CHART_H - h, bw, h]);
      if (b.drop) tris.push(x + bw / 2 - 3.5);
      else if (b.hitch) hitchTris.push(x + bw / 2 - 3.5);
    }
    for (const [col, rs] of groups) this.rects(tq, tEnd, rs, col, this.barAlpha(col));
    // Markers under the slices: a red triangle for a recorder drop, an amber one for a hitch.
    this.slot('drops', 2, tq, tris.length
      ? this.shapeBody(tris.map((x) => this.trianglePath(x, L.FPS_TOP + CHART_H + 8)).join(' '), this.c.RED, 1.0) : null);
    this.slot('hitches', 2, tq, hitchTris.length
      ? this.shapeBody(hitchTris.map((x) => this.trianglePath(x, L.FPS_TOP + CHART_H + 8)).join(' '), this.c.AMBER, 1.0) : null);
    const flagged = n.dropsInWindow || n.tearsInWindow;
    const left = this.run('FPS · LAST 10 S', this.c.SANS_SEMI, 16, this.c.LABEL, 0.06) +
      (flagged ? '' : this.run(' · ¼ S SLICES', this.c.SANS_MED, 13, this.c.FOOT, 0.04));
    this.slot('fpsLabelL', 3, tq, this.textBody(PAD, L.FPS_LABEL_BASE, left, 16));
    this.text(tq, tEnd, PW - PAD, L.FPS_LABEL_BASE,
      (n.dropsInWindow ? this.run('REC DROP · ', this.c.SANS_SEMI, 16, this.c.RED, 0.06) : '') +
      (n.tearsInWindow ? this.run('TEAR · ', this.c.SANS_SEMI, 16, this.c.RED, 0.06) : '') +
      this.run('MIN ', this.c.SANS_SEMI, 16, this.c.LABEL, 0.06) + this.run(fmt0(n.mn), this.c.MONO_SEMI, 16, this.c.TEXT) +
      this.run(' · MAX ', this.c.SANS_SEMI, 16, this.c.LABEL, 0.06) + this.run(fmt0(n.mx), this.c.MONO_SEMI, 16, this.c.TEXT), 16, 'r');
    // Pacing: below the refresh rate, the share of frames that held exactly the cap's
    // refreshes; at the refresh rate, shares of frames on time, one frame late, and longer.
    if (n.cadence) {
      const c = n.cadence, share = (v) => v / c.n, evenPct = Math.round(share(c.even) * 100);
      this.text(tq, tEnd, PW - PAD, L.PACING_BASE,
        this.run('EVEN ', this.c.SANS_MED, 13, this.c.FOOT, 0.04) +
        this.run(`${evenPct}%`, this.c.MONO_SEMI, 13, evenPct >= 95 ? this.c.TEXT : evenPct >= 80 ? this.c.AMBER : this.c.RED), 13, 'r');
      this.stackedBar(tq, tEnd, [[share(c.short), this.c.AMBER, 'SHORT'], [share(c.even), this.c.BLUE, `${fmtMs(kRef * refreshMs)} ms`],
        [share(c.late), this.c.AMBER, 'LATE'], [share(c.stall), this.c.RED, 'STALL']]);
    } else if (n.pacing) {
      const p = n.pacing, ms = (c) => fmtMs(c * refreshMs);
      const labOn = kRef === 1 ? `${ms(1)} ms` : `≤${ms(kRef)} ms`;
      const labLate = kRef === 1 ? `${ms(2)} ms` : `${ms(kRef + 1)}–${ms(2 * kRef)} ms`;
      const labStall = `≥${ms(2 * kRef + 1)} ms`;
      const share = (v) => v / p.n;
      this.text(tq, tEnd, PW - PAD, L.PACING_BASE,
        this.run(`${labStall} `, this.c.SANS_MED, 13, this.c.FOOT, 0.04) +
        this.run(`${Math.round(share(p.stall) * 100)}%`, this.c.MONO_SEMI, 13, p.stall ? this.c.RED : this.c.TEXT), 13, 'r');
      this.stackedBar(tq, tEnd, [[share(p.on), this.c.BLUE, labOn], [share(p.late), this.c.AMBER, labLate], [share(p.stall), this.c.RED, labStall]]);
    } else {
      this.text(tq, tEnd, PW - PAD, L.PACING_BASE, this.run('–', this.c.MONO_MED, 13, this.c.FOOT), 13, 'r');
    }
  }

  drawFrame(tt, tEnd) {
    const f = this.frameAt(tt);
    const L = LAYOUT;
    const { targetMs } = this.m;
    this.slot('last', 3, tt, this.textBody(PAD, L.LAST_BASE,
      this.run('LAST FRAME  ', this.c.SANS_SEMI, 16, this.c.LABEL, 0.06) +
      this.run(fmt1(f.lastMs), this.c.MONO_SEMI, 20, f.lastMs == null ? this.c.TEXT : this.ftTextColor(f.lastMs, targetMs)) +
      this.run(' ms', this.c.MONO_SEMI, 13, this.c.DIM), 20));
    const hot = f.stallKind === 'hitch', badge = HOLD_NAMES[f.kind] || 'STALL';
    const held = f.elapsed < 1000 ? `${f.elapsed.toFixed(0)} ms` : `${(f.elapsed / 1000).toFixed(1)} s`;
    this.slot('stall', 3, tt, f.stalled ? this.textBody(PW - PAD, L.LAST_BASE,
      this.run(`${badge}  `, this.c.SANS_SEMI, 16, hot ? this.c.RED : this.c.DIM, 0.06) + this.run(held, this.c.MONO_SEMI, 20, hot ? this.c.RED : this.c.DIM), 20, 'r') : null);
    this.ftChart(tt, f, { key: 'ft', x: PAD, top: L.FT_TOP, w: IW, h: CHART_H, slots: FT_SHOW + 1 });
    const shownFrames = f.last.length + 1;
    this.slot('ftLabelL', 3, tt, this.textBody(PAD, L.FT_LABEL_BASE,
      this.run('FRAME TIME', this.c.SANS_SEMI, 16, this.c.LABEL, 0.06) +
      this.run(` · ${shownFrames} FRAME${shownFrames === 1 ? '' : 'S'} · ${f.spanS.toFixed(1)} S`, this.c.SANS_MED, 13, this.c.FOOT, 0.04), 16));
    this.slot('ftMax', 3, tt, this.textBody(PW - PAD, L.FT_LABEL_BASE,
      this.run('MAX ', this.c.SANS_SEMI, 16, this.c.LABEL, 0.06) +
      this.run(fmt1(f.ftMax), this.c.MONO_SEMI, 16, f.ftMax == null ? this.c.TEXT : this.ftTextColor(f.ftMax, targetMs)) +
      this.run(' ms', this.c.MONO_SEMI, 13, this.c.DIM), 16, 'r'));
    this.text(tt, tEnd, PW - PAD, L.FOOT_BASE, this.run(tc(tt), this.c.MONO_MED, 13, this.c.LABEL), 13, 'r');
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
    this.shape(0, D, roundedPath(px(g.gx), px(g.gy), px(g.GW), px(LG_H), px(10)), this.c.PANEL, g.alpha, 0);
    this.text(0, D, x0, g.ry + 22, this.run('FRAME TIME', this.c.SANS_SEMI, 16, this.c.LABEL, 0.06) +
      this.run(` · LAST ${LG_WIN} S`, this.c.SANS_MED, 13, this.c.FOOT, 0.04), 16);
    this.rects(0, D, [[x0, top + LG_CH, g.iw, 1]], this.c.LINE, this.c.LINE_A);
    const g1 = LG_CH / 3, g2 = LG_CH * 2 / 3;
    this.rects(0, D, [[x0, top + LG_CH - g1, g.iw, 1]], this.c.TEXT, 0.45, 3);
    this.rects(0, D, [[x0, top + LG_CH - g2, g.iw, 1]], this.c.TEXT, 0.22, 3);
    this.chartLabelLeft(0, D, x0, top + LG_CH - g1 + 3, `${targetMs.toFixed(1)} ms`);
    this.chartLabelLeft(0, D, x0, top + LG_CH - g2 + 3, (2 * targetMs).toFixed(1));
  }

  /** The frame on screen (f, from frameAt(tt)) growing at the right edge, and the window's MAX. */
  drawLongGraphTick(tt, f) {
    if (!this.lg) return;
    const g = this.lg, { targetMs } = this.m, scale = 3 * targetMs;
    const wl = Math.min(g.iw, Math.max(1, f.elapsed / 1000 * g.speed));
    const hl = Math.max(2.0, Math.min(1.0, f.elapsed / scale) * LG_CH);
    this.liveBar(tt, g.rx + LG_PAD + g.iw - wl, wl + 2, hl, f.stallKind, g.ry + LG_TOP + LG_CH, 'lgLive');
    const { frameMs, kind } = this.a, ends = this.ends;
    let mx = f.stallKind === 'hitch' ? f.elapsed : 0;
    for (let i = bisectRight(ends, tt - LG_WIN), hi = bisectRight(ends, tt); i < hi; i++) if (isPlay(kind[i]) && frameMs[i] > mx) mx = frameMs[i];
    this.slot('lgMax', 3, tt, mx ? this.textBody(g.rx + g.GW - LG_PAD, g.ry + 22,
      this.run('MAX ', this.c.SANS_SEMI, 16, this.c.LABEL, 0.06) + this.run(fmt1(mx), this.c.MONO_SEMI, 16, this.ftTextColor(mx, targetMs)) +
      this.run(' ms', this.c.MONO_SEMI, 13, this.c.DIM), 16, 'r') : null);
  }

  /** One moving event per completed frame: it appears at the right edge when the frame
   * ends and glides left at the window's speed, clipped to the chart. */
  drawLongGraphBars(D) {
    const g = this.lg, { targetMs } = this.m, scale = 3 * targetMs, px = (v) => this.px(v);
    const { frameMs, kind } = this.a, ends = this.ends;
    const clip = `\\clip(${Math.floor(px(g.x0))},${Math.floor(px(g.top))},${Math.ceil(px(g.x0 + g.iw))},${Math.ceil(px(g.top + LG_CH + 1))})`;
    const move = (x1, y) => `\\move(${f1(px(x1))},${f1(px(y))},${f1(px(x1 - g.speed * LG_WIN))},${f1(px(y))},0,${LG_WIN * 1000})`;
    for (let i = 0; i < frameMs.length; i++) {
      const e = ends[i];
      if (e > D) break;
      const ms = frameMs[i], t1 = Math.min(D, e + LG_WIN);
      const w = Math.max(1, ms / 1000 * g.speed - 1), h = Math.max(2.0, Math.min(1.0, ms / scale) * LG_CH);
      const x1 = g.x0 + g.iw - w, y = g.top + LG_CH - h;
      const play = isPlay(kind[i]), col = play ? this.ftBarColor(ms, targetMs) : this.c.FOOT, ba = this.barAlpha(col);
      this.emit(2, e, t1, `{\\an7${move(x1, y)}${clip}\\shad0\\p1\\bord0\\c${assColor(col)}${ba < 1 ? `\\1a&H${hex2(Math.round((1 - ba) * 255))}&` : ''}}` +
        rectsPath([[0, 0, px(w), px(h)]]) + '{\\p0}');
      if (ms > scale * 1.001 && play) { // value box to the left of the bar, moving with it
        const s = ms.toFixed(0), size = 13, lw = monoW(s, size) + 8, lh = 17, lx = x1 - 2 - lw, ly = g.top + 2;
        this.emit(3, e, t1, `{\\an7${move(lx, ly)}${clip}\\shad0\\p1\\bord0\\c${assColor(this.c.PANEL)}\\1a&H24&}` +
          roundedPath(0, 0, px(lw), px(lh), px(2)) + '{\\p0}');
        this.emit(4, e, t1, `{\\an3${move(lx + lw - 4, ly + lh)}${clip}\\bord0\\shad0}` + this.run(s, this.c.MONO_SEMI, size, this.c.RED));
      }
    }
  }

  /** A red line across the video where each tear was, fading out. */
  drawTears(D) {
    for (const t of this.a.tears) {
      if (t.time >= D) break;
      const y = Math.round(t.y * this.h);
      this.emit(5, t.time, Math.min(D, t.time + TEAR_SHOW_S),
        `{\\an7\\pos(0,0)\\fad(0,${Math.round(TEAR_SHOW_S * 750)})\\shad0\\p1\\bord0\\c${assColor(this.c.RED)}}` +
        rectsPath([[0, y - 1, this.w, this.px(2)]]) + '{\\p0}');
    }
  }

  /** The results after the clip: the run's numbers and a frame-time histogram over a dimmed frame. */
  drawEndCard(D) {
    const s = summarise(this.a, this.capture), { refreshMs, kRef, targetMs } = this.m;
    const t0 = D, t1 = D + END_CARD_S, frameW = this.w / this.k;
    const W = 760, H = 540, x0 = (frameW - W) / 2, y0 = (1080 - H) / 2;
    const { ox, oy } = this, X = (v) => x0 - ox + v, Y = (v) => y0 - oy + v; // panel-px helpers draw from the panel origin
    this.emit(0, t0, t1, this.shapeBody(rectsPath([[0, 0, this.w, this.h]]), this.c.PANEL, 0.78));
    this.shape(t0, t1, roundedPath(this.px(x0), this.px(y0), this.px(W), this.px(H), this.px(14)), this.c.PANEL, this.c.LINE_A, 1, this.c.LINE, 0.96);
    this.text(t0, t1, X(32), Y(44), this.run(this.fitTitle(W - 64 - 160, 20, 0.06), this.c.SANS_SEMI, 20, this.c.TEXT, 0.06), 20);
    this.text(t0, t1, X(W - 32), Y(44), this.run(`${this.capture.height}P${Math.round(this.a.hz)} · TARGET ${this.a.target}`, this.c.MONO_MED, 13, this.c.DIM), 13, 'r');
    const fps = (v) => fmt1(v), pct = (v) => (v == null ? '–' : `${Math.round(v)}%`);
    const cells = [
      ['AVG FPS', fps(s.avg_fps), this.levelColor(s.avg_fps, s.target_fps)],
      ['1% LOW', fps(s.low_1pct_fps), this.levelColor(s.low_1pct_fps, s.target_fps)],
      ['0.1% LOW', fps(s.low_0_1pct_fps), this.levelColor(s.low_0_1pct_fps, s.target_fps)],
      ['MISSED', pct(s.frames_missing_target_pct), this.c.TEXT],
      ['PACING EVEN', pct(s.pacing.even_pct), s.pacing.even_pct == null ? this.c.TEXT : s.pacing.even_pct >= 95 ? this.c.TEXT : s.pacing.even_pct >= 80 ? this.c.AMBER : this.c.RED],
      ['STUTTER TIME', `${s.stutter_time_pct.toFixed(1)}%`, s.stutter_time_pct > 5 ? this.c.RED : s.stutter_time_pct > 1 ? this.c.AMBER : this.c.TEXT],
      ['HITCHES', String(s.hitches.count), s.hitches.count ? this.c.RED : this.c.TEXT],
      ['TEARS', String(s.tears.count), s.tears.count ? this.c.RED : this.c.TEXT],
    ];
    const colW = (W - 64) / 4;
    cells.forEach(([label, value, color], i) => {
      const cx = X(32 + (i % 4) * colW), cy = Y(96 + Math.floor(i / 4) * 92);
      this.text(t0, t1, cx, cy, this.run(label, this.c.SANS_MED, 13, this.c.FOOT, 0.06), 13);
      this.text(t0, t1, cx, cy + 44, this.run(value, this.c.MONO_SEMI, 40, color, -0.02), 40);
    });
    // Histogram: play frames by refreshes held, 1 to 11 and 12+, coloured against the cap.
    const bins = new Array(12).fill(0);
    let total = 0;
    this.a.holdRefreshes.forEach((n, i) => { if (isPlay(this.a.kind[i])) { bins[Math.min(11, Math.max(1, n)) - 1]++; total++; } });
    const hx = X(32), hy = Y(316), hw = W - 64, hh = 150, bw = (hw - 11 * 6) / 12;
    this.text(t0, t1, hx, hy - 10, this.run('FRAME TIME', this.c.SANS_SEMI, 16, this.c.LABEL, 0.06) +
      this.run(` · ${total} FRAMES BY REFRESHES HELD`, this.c.SANS_MED, 13, this.c.FOOT, 0.04), 16);
    const peak = Math.max(1, ...bins);
    bins.forEach((c, i) => {
      const n = i + 1, h = Math.max(2, c / peak * hh * 0.85), bx = hx + i * (bw + 6); // room for the share label above the tallest bar
      this.rects(t0, t1, [[bx, hy + hh - h, bw, h]], this.ftBarColor(n * refreshMs, targetMs), this.barAlpha(this.ftBarColor(n * refreshMs, targetMs)));
      const lab = n === 12 ? `${fmtMs(12 * refreshMs)}+` : fmtMs(n * refreshMs);
      this.text(t0, t1, bx + bw / 2, hy + hh + 18, this.run(lab, this.c.MONO_MED, 11, n === kRef ? this.c.TEXT : this.c.FOOT), 11, 'c');
      if (c) this.text(t0, t1, bx + bw / 2, hy + hh - h - 4, this.run(`${Math.round(100 * c / total)}%`, this.c.MONO_MED, 11, this.c.LABEL), 11, 'c');
    });
    const left = [s.static_holds.seconds && `${s.static_holds.seconds.toFixed(1)} S STILL`, s.loading.seconds && `${s.loading.seconds.toFixed(1)} S LOADING`]
      .filter(Boolean).join(' · ');
    this.text(t0, t1, X(32), Y(H - 20), this.run(`${s.seconds.toFixed(1)} S OF PLAY${left ? ` · ${left} LEFT OUT` : ''}`, this.c.SANS, 13, this.c.FOOT), 13);
  }

  /** Run every pass; the events end up in this.lines. Running it again is free. */
  render() {
    if (this.rendered) return;
    this.rendered = true;
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
    if (!Array.isArray(a.kind)) a.kind = [];
    if (!Array.isArray(a.holds)) a.holds = [];
    if (!Array.isArray(a.tears)) a.tears = [];
    this.ends = a.starts.map((s, i) => s + a.frameMs[i] / 1000.0);
    // When each hitch became known (its frame ended), and when each tear was.
    this.hitchAt = a.holds.filter((h) => h.kind === 'hitch').map((h) => h.start + h.ms / 1000).sort((x, y) => x - y);
    this.tearAt = a.tears.map((t) => t.time);
    this.sortedDone = [];
    this.doneCount = 0;
    this.missedCount = 0;
    this.pausedS = 0;
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
    this.drawTears(D);
    if (this.opts.endCard) this.drawEndCard(D);
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
    if (typeof at === 'number') lines = freezeAt(lines, at);
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
      `Style: HUD,${this.c.SANS},${(this.px(16) * FS_PER_PX).toFixed(0)},${assColor(this.c.TEXT)},` +
        `${assColor(this.c.TEXT)},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
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
    this.shape(0, D, roundedPath(this.px(this.ox), this.px(this.oy), this.px(W), this.px(H), this.px(16)), this.c.PANEL, 0.08, 0, 0xFFFFFF, 0.84);
    for (const x of S.divs) this.rects(0, D, [[x, 18, 1, 40]], this.c.LINE, this.c.LINE_A, 1);
    ['FRAME', 'AVG 10 S', '1% LOW', 'MAX'].forEach((s, i) => {
      this.text(0, D, S.stats + i * S.col, 31, this.run(s, this.c.SANS_MED, 11, this.c.FOOT, 0.06), 11);
    });
    this.text(0, D, S.pacing, 31, this.run('PACING 10 S', this.c.SANS_MED, 11, this.c.FOOT, 0.06), 11);
    this.drawPills(D, S.right, 16, 13);
    this.text(0, D, S.right, 58, this.run(this.fitTitle(196, 11, 0.08), this.c.SANS_SEMI, 11, this.c.DIM, 0.08), 11, 'r');
    this.drawExtras(D);
  }

  drawNumbers(tq, tEnd) {
    const n = this.numbersAt(tq), S = STRIP, { target } = this.m;
    const heroS = fmt0(n.hero);
    this.text(tq, tEnd, S.heroX, 54, this.run(heroS, this.c.HERO || this.c.MONO_SEMI, 46, n.hero == null ? this.c.TEXT : this.levelColor(n.hero, target), -0.03), 46);
    const lx = S.heroX + monoW(heroS, 46, -0.03) + 8;
    this.slot('heroFps', 3, tq, this.textBody(lx, 37, this.run('FPS', this.c.SANS_SEMI, 13, this.c.LABEL, 0.06), 13));
    this.slot('heroSub', 3, tq, this.textBody(lx, 54, this.run('0.5 S', this.c.SANS_MED, 11, this.c.FOOT, 0.06), 11));
    this.text(tq, tEnd, S.stats + S.col, 56, this.run(fmt1(n.avg), this.c.MONO_SEMI, 22, n.avg == null ? this.c.TEXT : this.levelColor(n.avg, target)), 22);
    this.text(tq, tEnd, S.stats + 2 * S.col, 56, this.run(fmt1(n.low), this.c.MONO_SEMI, 22, n.low == null ? this.c.TEXT : this.levelColor(n.low, target)), 22);
    const p = n.pacing;
    if (!p) return;
    const sh = (v) => v / p.n, pct = (v) => `${Math.round(sh(v) * 100)}%`;
    this.stackedBar(tq, tEnd, [[sh(p.on), this.c.BLUE], [sh(p.late), this.c.AMBER], [sh(p.stall), this.c.RED]], S.pacing, 40, 120, 6, false);
    this.text(tq, tEnd, S.pacing, 60, this.run(pct(p.on), this.c.MONO_SEMI, 11, this.c.TEXT), 11);
    this.text(tq, tEnd, S.pacing + 120, 60, this.run(`${pct(p.late)} · ${pct(p.stall)}`, this.c.MONO_MED, 11, p.stall ? this.c.RED : this.c.FOOT), 11, 'r');
  }

  drawFrame(tt, tEnd) {
    const f = this.frameAt(tt), S = STRIP, { targetMs } = this.m;
    this.slot('badge', 3, tt, f.stalled ? this.textBody(S.stats + 3 * S.col, 31,
      this.run(HOLD_NAMES[f.kind] || 'STALL', this.c.SANS_SEMI, 11, f.stallKind === 'hitch' ? this.c.RED : this.c.DIM, 0.06), 11) : null);
    const ms = (v) => this.run(fmt1(v), this.c.MONO_SEMI, 22, v == null ? this.c.TEXT : this.ftTextColor(v, targetMs)) + this.run(' ms', this.c.MONO_SEMI, 11, this.c.DIM);
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
      this.shape(0, D, roundedPath(this.px(this.ox), this.px(this.oy + y), this.px(G.W), this.px(h), this.px(14)), this.c.PANEL, 0.08, 0, 0xFFFFFF, 0.74);
    }
    const pillsW = this.drawPills(D, G.W - 16, 14, 11);
    this.text(0, D, 18, 29, this.run(this.fitTitle(G.W - 36 - pillsW, 12, 0.08), this.c.SANS_SEMI, 12, this.c.DIM, 0.08), 12);
    this.text(0, D, G.lineX, 128, this.run('LAST 10 S', this.c.SANS_MED, 10, this.c.FOOT, 0.06), 10);
    const lw = G.lineR - G.lineX;
    this.rects(0, D, [[G.lineX, G.lineY, lw, 1]], this.c.LINE, this.c.LINE_A);
    this.rects(0, D, [[G.lineX, G.lineY - G.lineH * (target / yMax), lw, 1]], this.c.TEXT, 0.45, 3);
    // MISSED is right-aligned at the tile edge so a long FRAME value has room.
    ['AVG 10 S', '1% LOW', 'FRAME', 'MISSED'].forEach((s, i) => {
      this.text(0, D, i === 3 ? G.W - 16 : G.colX[i], 172, this.run(s, this.c.SANS_MED, 11, this.c.FOOT, 0.06), 11, i === 3 ? 'r' : 'l');
    });
    this.text(0, D, 16, 256, this.run('FRAME TIME', this.c.SANS_SEMI, 12, this.c.LABEL, 0.06), 12);
    this.drawExtras(D);
  }

  drawNumbers(tq, tEnd) {
    const n = this.numbersAt(tq), G = GLASS, { target, yMax } = this.m;
    const heroS = fmt0(n.hero);
    this.text(tq, tEnd, 16, 114, this.run(heroS, this.c.HERO || this.c.MONO, 76, n.hero == null ? this.c.TEXT : this.levelColor(n.hero, target), -0.05), 76);
    const lx = 16 + monoW(heroS, 76, -0.05) + 4;
    this.slot('heroFps', 3, tq, this.textBody(lx, 90, this.run('FPS', this.c.SANS_SEMI, 13, this.c.LABEL, 0.06), 13));
    this.slot('heroSub', 3, tq, this.textBody(lx, 108, this.run('0.5 S', this.c.SANS_MED, 11, this.c.FOOT, 0.06), 11));
    // The 10 s FPS line: a flat-filled area under it and the line as thin quads (libass has no gradients).
    if (n.bars.length > 1) {
      const lw = G.lineR - G.lineX, { ox, oy } = this, X = (v) => f1(this.px(ox + v)), Y = (v) => f1(this.px(oy + v));
      const pts = n.bars.map((b, i) => [G.lineX + i * lw / (FPS_BARS - 1), G.lineY - Math.min(1, b.fps / yMax) * G.lineH]);
      const area = `m ${X(pts[0][0])} ${Y(G.lineY)} l ` + pts.map(([x, y]) => `${X(x)} ${Y(y)}`).join(' ') + ` ${X(pts[pts.length - 1][0])} ${Y(G.lineY)}`;
      this.shape(tq, tEnd, area, this.c.BLUE, 0.25, 2);
      const line = pts.slice(1).map(([x, y], i) => {
        const [x0, y0] = pts[i];
        return `m ${X(x0)} ${Y(y0 - 1)} l ${X(x)} ${Y(y - 1)} ${X(x)} ${Y(y + 1)} ${X(x0)} ${Y(y0 + 1)}`;
      }).join(' ');
      this.shape(tq, tEnd, line, this.c.BLUE, 1.0, 2);
      this.text(tq, tEnd, G.lineR, 128, this.run(`MIN ${fmt0(n.mn)} · MAX ${fmt0(n.mx)}`, this.c.MONO_MED, 10, this.c.FOOT), 10, 'r');
    }
    const val = (i, s, col) => this.text(tq, tEnd, G.colX[i], 203, this.run(s, this.c.MONO_SEMI, 22, col), 22);
    val(0, fmt1(n.avg), n.avg == null ? this.c.TEXT : this.levelColor(n.avg, target));
    val(1, fmt1(n.low), n.low == null ? this.c.TEXT : this.levelColor(n.low, target));
    this.text(tq, tEnd, G.W - 16, 203, this.run(n.missed == null ? '–' : `${Math.round(n.missed * 100)}%`, this.c.MONO_SEMI, 22, this.c.TEXT), 22, 'r');
    const p = n.pacing;
    if (!p) return;
    const sh = (v) => v / p.n, pct = (v) => `${Math.round(sh(v) * 100)}%`;
    this.stackedBar(tq, tEnd, [[sh(p.on), this.c.BLUE], [sh(p.late), this.c.AMBER], [sh(p.stall), this.c.RED]], 16, 326, G.W - 32, 5, false);
    this.text(tq, tEnd, 16, 345, this.run(`ON TIME ${pct(p.on)}`, this.c.MONO_MED, 10, this.c.FOOT), 10);
    this.text(tq, tEnd, G.W - 16, 345, this.run(`LATE ${pct(p.late)} · STALL ${pct(p.stall)}`, this.c.MONO_MED, 10, p.stall ? this.c.RED : this.c.FOOT), 10, 'r');
  }

  drawFrame(tt, tEnd) {
    const f = this.frameAt(tt), G = GLASS, { targetMs } = this.m;
    this.slot('last', 3, tt, this.textBody(G.colX[2], 203,
      this.run(fmt1(f.lastMs), this.c.MONO_SEMI, 22, f.lastMs == null ? this.c.TEXT : this.ftTextColor(f.lastMs, targetMs)) + this.run(' ms', this.c.MONO_SEMI, 11, this.c.DIM), 22));
    this.slot('ftMax', 3, tt, this.textBody(G.W - 16, 256,
      this.run('MAX ', this.c.SANS_SEMI, 12, this.c.LABEL, 0.06) + this.run(fmt1(f.ftMax), this.c.MONO_SEMI, 12, f.ftMax == null ? this.c.TEXT : this.ftTextColor(f.ftMax, targetMs)) +
      this.run(' ms', this.c.MONO_SEMI, 10, this.c.DIM), 12, 'r'));
    this.ftChart(tt, f, { key: 'gft', x: 16, top: 266, w: G.W - 32, h: 50, slots: FT_SHOW + 1 });
    this.drawLongGraphTick(tt, f);
  }
}

// ---- look E: compact tile, FPS / AVG / FRAME over a frame-time graph ----

// Row 1 centres on y 31; the graph fills row 2. Columns: hero, divider, AVG, FRAME (fits "1250.0 ms").
const COMPACT = Object.freeze({ W: 356, H: 114, R: 14, X: 18, div: 144, avg: 159, frame: 245, LABEL_BASE: 24, VALUE_BASE: 48,
  chart: { x: 18, top: 62, w: 320, h: 38 } });

class CompactOverlay extends Overlay {
  static W = COMPACT.W;
  static H = COMPACT.H;

  drawChrome(D) {
    const C = COMPACT, c = this.c, px = (v) => this.px(v), { ox, oy } = this;
    this.shape(0, D, roundedPath(px(ox), px(oy), px(C.W), px(C.H), px(C.R)), c.PANEL, 0.08, 0, 0xFFFFFF, 0.84);
    this.drawAccent(D, C.W, C.H, C.R); // the theme accents the Panel draws, sized to the tile
    this.rects(0, D, [[C.div, 13, 1, 36]], c.LINE, c.LINE_A, 1);
    this.text(0, D, C.avg, C.LABEL_BASE, this.run('AVG 10 S', c.SANS_MED, 11, c.FOOT, 0.06), 11);
    this.drawExtras(D);
  }

  drawNumbers(tq, tEnd) {
    const n = this.numbersAt(tq), C = COMPACT, { target } = this.m;
    const heroS = fmt0(n.hero);
    this.text(tq, tEnd, C.X, 45, this.run(heroS, this.c.HERO || this.c.MONO_SEMI, 40, n.hero == null ? this.c.TEXT : this.levelColor(n.hero, target), -0.03), 40);
    const lx = C.X + monoW(heroS, 40, -0.03) + 6;
    this.slot('heroFps', 3, tq, this.textBody(lx, 31, this.run('FPS', this.c.SANS_SEMI, 13, this.c.LABEL, 0.06), 13));
    this.slot('heroSub', 3, tq, this.textBody(lx, 45, this.run('0.5 S', this.c.SANS_MED, 11, this.c.FOOT, 0.06), 11));
    this.text(tq, tEnd, C.avg, C.VALUE_BASE, this.run(fmt1(n.avg), this.c.MONO_SEMI, 22, n.avg == null ? this.c.TEXT : this.levelColor(n.avg, target)), 22);
  }

  drawFrame(tt, tEnd) {
    const f = this.frameAt(tt), C = COMPACT, { targetMs } = this.m;
    // FRAME becomes the hold's name while a frame is held, as the Strip's badge.
    const label = f.stalled ? this.run(HOLD_NAMES[f.kind] || 'STALL', this.c.SANS_SEMI, 11, f.stallKind === 'hitch' ? this.c.RED : this.c.DIM, 0.06)
      : this.run('FRAME', this.c.SANS_MED, 11, this.c.FOOT, 0.06);
    this.slot('frameLabel', 3, tt, this.textBody(C.frame, C.LABEL_BASE, label, 11));
    this.slot('last', 3, tt, this.textBody(C.frame, C.VALUE_BASE,
      this.run(fmt1(f.lastMs), this.c.MONO_SEMI, 22, f.lastMs == null ? this.c.TEXT : this.ftTextColor(f.lastMs, targetMs)) + this.run(' ms', this.c.MONO_SEMI, 11, this.c.DIM), 22));
    this.ftChart(tt, f, { key: 'cft', ...C.chart, slots: FT_SHOW + 1 });
    this.drawLongGraphTick(tt, f);
  }
}

// ---- look F: broadcast, a corner panel at the top right over scrolling FPS and frame-time graphs ----

// Panel px: baselines as the design's CSS lays its rows out (22 px padding, rows 16 px apart). [free, held] for the
// hero's labels: a held frame's tag pushes them up. Graphs in frame px: FPS along the bottom, frame time above it at the left.
const BROADCAST = Object.freeze({
  W: 452, H: 400, PAD: 22, EDGE: 5, R: 10,
  TITLE_BASE: 46, PILL_TOP: 22, PILL_H: 32,
  EYEBROW_BASE: 92.5, GRID_LABEL_BASE: 121.5, GRID_VALUE_BASE: 156.5, COL1_R: 341,
  HERO_BASE: 162, FPS_BASE: [124, 91.5], SUB_BASE: [155, 122], TAG_TOP: 131.5, TAG_H: 28.5, TAG_BASE: 154,
  FRAME_BASE: 201.5, DIV_Y: 223, RUN_LABEL_BASE: 261, RUN_VALUE_BASE: 291,
  PACING_BASE: 330, BAR_Y: 342.5, BAR_H: 14, LEGEND_BASE: 378,
  SIDE: 16, WIN: 10, STEP: 0.05, BORDER: 2, FPS_H: 200, FPS_BOTTOM: 12, AXIS_W: 40, FT_W: 360, FT_H: 132, FT_GAP: 5,
});
// libass sizes a font by its OS/2 win ascent + descent: 1.702 em for Oswald (Plex's 1.3 is FS_PER_PX), 0.377 em of it below the baseline.
const OSWALD_LINE = 1.702, OSWALD_DESCENT = 0.377;
// Oswald Bold's digits are proportional: their advances in em, to place the hero's labels.
const OSWALD_DIGITS = [0.55, 0.385, 0.514, 0.514, 0.524, 0.509, 0.538, 0.439, 0.521, 0.538];
/** Frame rates: one decimal below 100, none from 100 up, so never more than 4 characters. */
const fmtV = (v) => (v == null ? '–' : v >= 99.95 ? v.toFixed(0) : v.toFixed(1));
/** Frame times: one decimal below 1000 ms, none from there up ('116.7', '1833'). */
const fmtFt = (v) => (v >= 999.95 ? v.toFixed(0) : v.toFixed(1));

class BroadcastOverlay extends Overlay {
  static W = BROADCAST.W;
  static H = BROADCAST.H;

  constructor(a, size, title, rate, position, capture, opts = {}) {
    // Always the top-right corner; its own frame-time graph replaces the long one.
    super(a, size, title, rate, 'right', capture, { ...opts, longGraph: false });
    this.ox = this.w / this.k - BROADCAST.EDGE - this.W;
    this.oy = BROADCAST.EDGE;
    this.g = this.graphs();
  }

  /** This look's own runs: Oswald at the design's px (libass sizes it by its 1.702 em line, not Plex's 1.3) and upright,
   * as the design draws it. The end card and the caption keep the shared run(). */
  brun(s, font, size, color, spacing = 0) {
    const k = font.startsWith('Oswald') ? OSWALD_LINE / FS_PER_PX : 1;
    return this.run(s, font, size * k, color, spacing / k).replace(/\\fax[-\d.]+/, '');
  }

  /** textBody for brun() runs: Oswald's deeper descent would lift the baseline, so the line moves down by the difference. */
  btext(x, baseline, runs, size, align = 'l', extra = '') {
    return this.textBody(x, baseline + (runs.includes('\\fnOswald') ? (OSWALD_DESCENT - DESCENT) * size : 0), runs, size, align, extra);
  }

  bt(t0, t1, x, baseline, runs, size, align = 'l', layer = 3, extra = '') {
    this.emit(layer, t0, t1, this.btext(x, baseline, runs, size, align, extra));
  }

  /** Width of this look's sans text: sansW is shaped on Plex Sans Cond, Oswald runs about 8 % narrower, and both draw
   * '%', W and M wider than it allows. */
  sw(s, size, spacing = 0) {
    const wide = (re) => (s.match(re) || []).length;
    return (sansW(s, size, spacing) + size * (0.35 * wide(/%/g) + 0.3 * wide(/[WM]/g))) * (this.c.SANS.startsWith('Oswald') ? 0.92 : 1.02);
  }

  /** Each graph's plot (inside its border) in frame px, its scroll speed and its clip in output px. */
  graphs() {
    const B = BROADCAST, b = B.BORDER, frameW = this.w / this.k, px = (v) => this.px(v);
    const plot = (x, y, w, h) => ({
      box: [x, y, w, h], x0: x + b, top: y + b, iw: w - 2 * b, ih: h - 2 * b, speed: (w - 2 * b) / B.WIN,
      clip: `\\clip(${Math.floor(px(x + b))},${Math.floor(px(y + b))},${Math.ceil(px(x + w - b))},${Math.ceil(px(y + h - b))})`,
    });
    const fy = 1080 - B.FPS_BOTTOM - B.FPS_H;
    return { fps: plot(B.SIDE, fy, frameW - 2 * B.SIDE - B.AXIS_W, B.FPS_H), ft: plot(B.SIDE, fy - B.FT_GAP - B.FT_H, B.FT_W, B.FT_H) };
  }

  /** Text and slots in frame px rather than panel px, outlined so they read on the video. */
  gtext(x, base, runs, size, align = 'l') {
    return this.btext(x - this.ox, base - this.oy, runs, size, align, `\\bord${f1(this.px(1.5))}\\3c${assColor(this.c.PANEL)}\\3a&H60&`);
  }

  /** An event at frame px (x, y) at time `born` that glides left with plot p's window, clipped to the plot;
   * body follows the override block (a drawing with its top left at 0,0, or text runs). */
  glide(layer, p, born, t0, t1, x, y, body, an = 7) {
    const r0 = Math.round(t0 * 100) / 100, r1 = Math.round(t1 * 100) / 100;
    if (r1 <= r0) return;
    const at = (t) => f1(this.px(x - p.speed * (t - born))), Y = f1(this.px(y));
    this.emit(layer, r0, r1, `{\\an${an}\\move(${at(r0)},${Y},${at(r1)},${Y},0,${Math.round((r1 - r0) * 1000)})${p.clip}\\bord0\\shad0}${body}`);
  }

  /** Line piece (x1, y1)-(x2, y2) in frame px, th thick, square ends so pieces join: [left, top, drawing from 0,0]. */
  segment(x1, y1, x2, y2, th) {
    const len = Math.hypot(x2 - x1, y2 - y1) || 1, dx = (x2 - x1) / len * th / 2, dy = (y2 - y1) / len * th / 2;
    const pts = [[x1 - dx - dy, y1 - dy + dx], [x2 + dx - dy, y2 + dy + dx], [x2 + dx + dy, y2 + dy - dx], [x1 - dx + dy, y1 - dy - dx]];
    const l = Math.min(...pts.map((q) => q[0])), t = Math.min(...pts.map((q) => q[1]));
    return [l, t, `m ${pts.map(([x, y]) => `${f1(this.px(x - l))} ${f1(this.px(y - t))}`).join(' l ')}`];
  }

  /** Value tag centred at frame px x (at `born`), top at y, gliding with plot p from t0 to t1. Born at the plot's
   * right edge, it waits wholly inside the plot until the point it marks has scrolled in under it. */
  tag(p, born, t0, t1, x, y, s, fill) {
    const size = 12, w = monoW(s, size) + 10, h = size * FS_PER_PX, lim = p.x0 + p.iw - w / 2 - 2;
    const draw = (q, a, b, cx) => {
      this.glide(3, q, born, a, b, cx - w / 2, y, `{\\p1\\c${assColor(fill)}}${roundedPath(0, 0, this.px(w), this.px(h), this.px(3))}{\\p0}`);
      this.glide(4, q, born, a, b, cx, y + h, this.run(s, this.c.MONO_SEMI, size, this.c.TEXT), 2);
    };
    const tc = x > lim ? Math.min(t1, born + (x - lim) / p.speed) : t0;
    if (tc > t0) draw({ ...p, speed: 0 }, t0, tc, lim);
    draw(p, Math.max(t0, tc), t1, x);
  }

  drawWatermark(D, s) { // top left: the bottom belongs to the graphs
    this.emit(3, 0, D, `{\\an7\\pos(${f1(this.px(16))},${f1(this.px(16))})\\bord${f1(this.px(1.5))}\\3c${assColor(this.c.PANEL)}` +
      `\\1a&H33&\\3a&H33&\\shad0}` + this.brun(s, this.c.SANS_SEMI, 16, this.c.TEXT, 0.06));
  }

  captionY(v, h, aboveWatermark) { // above the graphs; at the top under the panel or the watermark
    if (v === 'bottom') return this.g.ft.box[1] - 40;
    return h === 'right' ? this.oy + this.H + 16 : h === 'left' && aboveWatermark ? 48 : 24;
  }

  drawChrome(D) {
    const B = BROADCAST, c = this.c, px = (v) => this.px(v), { ox, oy } = this, { W, H, PAD } = B, { target, targetMs } = this.m;
    this.heroLx = [];
    this.shape(0, D, roundedPath(px(ox), px(oy), px(W), px(H), px(B.R)), c.PANEL, 0.3, 0, c.BLUE, 0.62);
    this.drawAccent(D, W, H, B.R);
    let pillW = 0;
    if (this.opts.showTarget !== false) {
      const s = `TARGET ${target}`;
      pillW = this.sw(s, 18, 0.06) + 16;
      this.shape(0, D, roundedPath(px(ox + W - PAD - pillW), px(oy + B.PILL_TOP), px(pillW), px(B.PILL_H), px(4)), c.PANEL, 0.55, 1, c.BLUE, 0);
      this.bt(0, D, W - PAD - pillW / 2, B.TITLE_BASE, this.brun(s, c.SANS_MED, 18, c.TEXT, 0.06), 18, 'c');
    }
    this.bt(0, D, PAD, B.TITLE_BASE, this.brun(this.fitTitle(W - 2 * PAD - pillW - 8, 16, 0.08, (s, z, sp) => this.sw(s, z, sp)), c.SANS_SEMI, 16, c.DIM, 0.08), 16);
    this.bt(0, D, W - PAD, B.EYEBROW_BASE, this.brun('LAST 10 S', c.SANS_MED, 18, c.FOOT, 0.08), 18, 'r');
    this.bt(0, D, B.COL1_R, B.GRID_LABEL_BASE, this.brun('AVG', c.SANS_SEMI, 15, c.LABEL, 0.06), 15, 'r');
    this.bt(0, D, W - PAD, B.GRID_LABEL_BASE, this.brun('1% LOW', c.SANS_SEMI, 15, c.LABEL, 0.06), 15, 'r');
    this.rects(0, D, [[PAD, B.DIV_Y, W - 2 * PAD, 1]], c.BLUE, 0.3, 1);
    // RUN row: five label-wide columns spread edge to edge with equal gaps (flex space-between), values left-aligned under
    // their labels; in a wider sans than Oswald the labels shrink until the gaps are at least 12 px.
    const labels = ['RUN AVG', '1% LOW', '0.1% LOW', 'MISSED', 'HITCHES'];
    const cols = (size) => labels.map((s) => this.sw(s, size, 0.06));
    let runSize = 18;
    while (runSize > 12 && cols(runSize).reduce((x, y) => x + y) + 4 * 12 > W - 2 * PAD) runSize -= 0.5;
    const ws = cols(runSize), gap = (W - 2 * PAD - ws.reduce((x, y) => x + y)) / 4;
    this.runX = [];
    labels.reduce((x, s, i) => { this.runX.push(x); return x + ws[i] + gap; }, PAD);
    labels.forEach((s, i) => this.bt(0, D, this.runX[i], B.RUN_LABEL_BASE, this.brun(s, c.SANS_MED, runSize, c.FOOT, 0.06), runSize));
    // FRAME row: both labels shrink the same way if, with values of up to 9 characters (' 116.7 ms', ' 12000 ms'), the sides would meet.
    const frameW = (size) => this.sw('FRAME ON SCREEN', size, 0.08) + this.sw('10 S MAX', size, 0.08) + 2 * monoW(' 000.0 ms', 15) + 10;
    this.frameSize = 18;
    while (this.frameSize > 12 && frameW(this.frameSize) > W - 2 * PAD) this.frameSize -= 0.5;
    this.bt(0, D, PAD, B.PACING_BASE, this.brun('PACING · 10 S', c.SANS_SEMI, 15, c.LABEL, 0.06), 15);
    this.drawExtras(D);
    // The graphs: boxes, grids, axes, titles, then the lines that scroll through them. Each line is its own thin drawing:
    // one drawing spanning the box would have libass blend a box-sized bitmap every frame.
    const R = (rs) => rectsPath(rs.map((r) => r.map(px)));
    const lines = (rs, color, alpha) => rs.forEach((r) => this.shape(0, D, R([r]), color, alpha, 1));
    const { fps, ft } = this.g, fyMax = target * 4 / 3, scale = 3 * targetMs;
    for (const p of [fps, ft]) {
      const [x, y, w, h] = p.box, b = B.BORDER;
      this.shape(0, D, R([p.box]), c.PANEL, 0.55, 0);
      lines([[x, y, w, b], [x, y + h - b, w, b], [x, y + b, b, h - 2 * b], [x + w - b, y + b, b, h - 2 * b]], c.TEXT, 0.85);
      lines([[p.x0 + p.iw / 2 - 0.75, p.top, 1.5, p.ih]], c.TEXT, 0.6);
    }
    lines([0.25, 0.5].map((q) => [fps.x0, fps.top + fps.ih * (1 - q), fps.iw, 1]), c.TEXT, 0.35);
    lines([1 / 3, 2 / 3].map((q) => [ft.x0, ft.top + ft.ih * q, ft.iw, 1]), c.TEXT, 0.35);
    const ty = fps.top + fps.ih * (1 - target / fyMax), dash = [];
    for (let x = fps.x0; x < fps.x0 + fps.iw; x += 12) dash.push([x, ty - 0.75, Math.min(6, fps.x0 + fps.iw - x), 1.5]);
    this.shape(0, D, R(dash), c.AMBER, 1.0, 1);
    // Axis labels beside each box, the top and bottom ones kept level with it; whole frame rates, so '53' not '53.3' fits the column.
    const axis = (p, x, vals, size, align) => vals.forEach(([s, q]) => {
      const top = Math.min(p.ih - size, Math.max(0, p.ih * q - size / 2));
      this.emit(3, 0, D, this.gtext(x, p.top + top + 0.875 * size, this.run(s, c.MONO_SEMI, size, c.TEXT), size, align));
    });
    axis(fps, this.w / this.k - B.SIDE, [1, 0.75, 0.5, 0.25, 0].map((q) => [(q * fyMax).toFixed(0), 1 - q]), 21, 'r');
    axis(ft, B.SIDE + B.FT_W + 8, [['0.0', 0], [fmtMs(targetMs), 1 / 3], [fmtMs(2 * targetMs), 2 / 3], [fmtMs(scale), 1]], 14, 'l');
    this.emit(3, 0, D, this.gtext(B.SIDE, ft.box[1] - 12, this.brun('FRAME-TIME (MS)', c.SANS_SEMI, 20, c.TEXT, 0.04) +
      this.brun('   LAST 10 S', c.SANS_MED, 14, c.LABEL, 0.08), 20));
    this.drawFpsLine(D);
    this.drawFtLine(D);
  }

  /** The 0.5 s rate every 50 ms (this.fs[k] at k * STEP: play frames over the whole window, so a still or a load dips it
   * like the design's), drawn as one gliding piece per sample, with one tag per dip below 90 % of the target at its lowest
   * point so far: the tag labels the line as drawn, holds included. */
  drawFpsLine(D) {
    const B = BROADCAST, c = this.c, p = this.g.fps, { starts, kind } = this.a, { target, floorS, refreshMs } = this.m;
    const minSpan = refreshMs / 1000, fyMax = target * 4 / 3, right = p.x0 + p.iw;
    const Y = (v) => p.top + p.ih * (1 - Math.min(v, fyMax) / fyMax);
    const fs = this.fs = [null];
    for (let k = 1; k * B.STEP <= D + 1e-9; k++) {
      const t = k * B.STEP, span = Math.min(0.5, t);
      fs.push(span >= minSpan ? weightedFrames(starts, this.ends, t - span, t, t, floorS, kind) / span : null);
    }
    const tagUntil = (d, t1) => {
      const v = Math.round(d.v); // coloured by the number it shows
      this.tag(p, d.t, d.t, Math.min(D, t1), right, Math.min(Y(d.v) - p.top, p.ih - 30) + p.top + 8, String(v), v >= 0.8 * target ? c.AMBER : c.RED);
    };
    let dip = null;
    for (let k = 1; k < fs.length; k++) {
      const v = fs[k], t = k * B.STEP;
      if (fs[k - 1] != null && v != null) {
        const [l, top, path] = this.segment(right - p.speed * B.STEP, Y(fs[k - 1]), right, Y(v), 3);
        this.glide(2, p, t, t, Math.min(D, t + B.WIN + B.STEP), l, top, `{\\p1\\c${assColor(c.BLUE)}}${path}{\\p0}`);
      }
      if (v == null || v >= 0.9 * target) {
        if (dip) tagUntil(dip, dip.t + B.WIN);
        dip = null;
      } else if (!dip || v < dip.v) { // a new low moves the dip's one tag there
        if (dip) tagUntil(dip, t);
        dip = { v, t };
      }
    }
    if (dip) tagUntil(dip, dip.t + B.WIN);
  }

  /** One gliding piece per frame, 0 ms at the top, one colour as in the design. A frame past the
   * scale (3x the target) is a step: it drops at its start once it passes the scale and runs along the bottom while it
   * lasts. Play frames over 2.05x the target get a red tag, one per cluster (the worst). */
  drawFtLine(D) {
    const B = BROADCAST, c = this.c, p = this.g.ft, { frameMs, kind } = this.a, ends = this.ends, { targetMs } = this.m;
    const scale = 3 * targetMs, right = p.x0 + p.iw, Y = (ms) => p.top + p.ih * Math.min(ms, scale) / scale, bottom = Y(scale);
    const col = c.BLUE;
    const piece = (born, t1, x1, y1, x2, y2) => {
      const [l, top, path] = this.segment(x1, y1, x2, y2, 2.5);
      this.glide(2, p, born, born, Math.min(D, t1), l, top, `{\\p1\\c${assColor(col)}}${path}{\\p0}`);
    };
    const tagUntil = (sp, t1) => this.tag(p, sp.t, sp.t, Math.min(D, t1), right, p.top + p.ih - 3 - 12 * FS_PER_PX, sp.ms.toFixed(0), c.RED);
    let spike = null, lastI = -99;
    for (let i = 1; i < frameMs.length && ends[i] <= D; i++) {
      const s = ends[i - 1], e = ends[i], ms = frameMs[i], xs = right - p.speed * (e - s), play = isPlay(kind[i]);
      if (ms <= scale) piece(e, e + B.WIN + 0.05, xs, Y(frameMs[i - 1]), right, Y(ms));
      else {
        const ts = s + scale / 1000, x0 = right - p.speed * (ts - s);
        piece(ts, s + B.WIN + 0.05, x0, Y(frameMs[i - 1]), x0, bottom);
        piece(ts, e, x0, bottom, right + p.speed * (e - ts), bottom); // reaches the right edge until the frame ends
        piece(e, e + B.WIN + 0.05, xs, bottom, right, bottom);
      }
      if (ms <= 2.05 * targetMs || !play) continue;
      if (spike && i - lastI <= 8) { // back to back: the cluster keeps one tag, on its worst frame
        if (ms > spike.ms) { tagUntil(spike, e); spike = { ms, t: e }; }
      } else {
        if (spike) tagUntil(spike, spike.t + B.WIN);
        spike = { ms, t: e };
      }
      lastI = i;
    }
    if (spike) tagUntil(spike, spike.t + B.WIN);
  }

  drawNumbers(tq, tEnd) {
    const n = this.numbersAt(tq), B = BROADCAST, c = this.c, px = (v) => this.px(v), { ox, oy } = this, { W, PAD } = B, { target } = this.m;
    // The graph's 0.5 s rate (play frames over the whole window): through a hold it falls, as in the design's hold state.
    const hv = this.fs[Math.min(this.fs.length - 1, Math.round(tq / B.STEP))];
    const heroS = fmt0(hv), heroCol = hv == null ? c.TEXT : this.levelColor(hv, target);
    const hero = (col) => this.brun(heroS, c.HERO || c.MONO_SEMI, 104, col, -0.02);
    if (c.TWO_TONE && hv != null && heroCol === c.TEXT) { // as the Panel's: the digits' top 55 % BLUE, the rest AMBER
      const split = Math.round(px(oy + B.HERO_BASE - 0.45 * HERO_CAP * 104));
      this.bt(tq, tEnd, PAD, B.HERO_BASE, hero(c.BLUE), 104, 'l', 3, `\\clip(0,0,${this.w},${split})`);
      this.bt(tq, tEnd, PAD, B.HERO_BASE, hero(c.AMBER), 104, 'l', 3, `\\clip(0,${split},${this.w},${this.h})`);
    } else this.bt(tq, tEnd, PAD, B.HERO_BASE, hero(heroCol), 104);
    // Where the hero's labels go for this tick (drawFrame places them), 10 px after its digits, and where the AVG value starts.
    this.heroLx.push([PAD + [...heroS].reduce((w, ch) => w + (c.HERO ? OSWALD_DIGITS[ch] ?? 0.56 : 0.6) - 0.02, 0) * 104 + 10,
      B.COL1_R - monoW(fmtV(n.avg), 28)]);
    const lv = (v) => (v == null ? c.TEXT : this.levelColor(v, target));
    this.text(tq, tEnd, B.COL1_R, B.GRID_VALUE_BASE, this.run(fmtV(n.avg), c.MONO_SEMI, 28, lv(n.avg)), 28, 'r');
    this.text(tq, tEnd, W - PAD, B.GRID_VALUE_BASE, this.run(fmtV(n.low), c.MONO_SEMI, 28, lv(n.low)), 28, 'r');
    [fmtV(n.runAvg), fmtV(n.run1), fmtV(n.run01), n.missed == null ? '–' : `${(n.missed * 100).toFixed(1)}%`, String(n.hitches)].forEach((s, i) =>
      this.text(tq, tEnd, this.runX[i], B.RUN_VALUE_BASE, this.run(s, c.MONO_SEMI, 20, i === 4 && n.hitches ? c.AMBER : c.TEXT), 20));
    const p = n.pacing, sh = (v) => v / p.n;
    if (p) this.stackedBar(tq, tEnd, [[sh(p.on), c.BLUE], [sh(p.late), c.AMBER], [sh(p.stall), c.RED]], PAD, B.BAR_Y, W - 2 * PAD, B.BAR_H, false);
    let x = PAD;
    [['ON TIME', 'on', c.BLUE], ['LATE', 'late', c.AMBER], ['STALL', 'stall', c.RED]].forEach(([label, key, col], i) => {
      const s = p && `${label} ${Math.round(sh(p[key]) * 100)}%`;
      this.slot(`bSq${i}`, 2, tq, p ? this.shapeBody(roundedPath(px(ox + x), px(oy + B.LEGEND_BASE - 9.5), px(10), px(10), px(2)), col, 1.0) : null);
      this.slot(`bLeg${i}`, 3, tq, p ? this.textBody(x + 16, B.LEGEND_BASE, this.run(s, c.MONO_MED, 13, c.LABEL), 13) : null);
      if (p) x += 16 + monoW(s, 13) + 18;
    });
  }

  drawFrame(tt) {
    const f = this.frameAt(tt), B = BROADCAST, c = this.c, px = (v) => this.px(v), { ox, oy } = this, { targetMs } = this.m;
    const [lx, avgL] = this.heroLx[Math.min(this.heroLx.length - 1, Math.floor(tt / FPS_BUCKET + 1e-6))] || [B.PAD, B.COL1_R];
    const held = f.stalled ? 1 : 0, name = f.stalled ? HOLD_NAMES[f.kind] || 'STALL' : null;
    // The hold's tag ends 6 px before the AVG value on screen; a long name shrinks to fit there, but never below 14 px.
    const ts = name ? Math.max(14, Math.min(18, 18 * (avgL - 6 - lx - 16) / this.sw(name, 18, 0.08))) : 18;
    const tw = name ? this.sw(name, ts, 0.08) + 16 : 0;
    this.slot('bFps', 3, tt, this.btext(lx, B.FPS_BASE[held], this.brun('FPS', c.SANS_SEMI, 18, c.LABEL, 0.06), 18));
    this.slot('bSub', 3, tt, this.btext(lx, B.SUB_BASE[held], this.brun('0.5 S', c.SANS_MED, 18, c.FOOT, 0.06), 18));
    this.slot('bTagBox', 3, tt, name ? this.shapeBody(roundedPath(px(ox + lx), px(oy + B.TAG_TOP), px(tw), px(B.TAG_H), px(4)), c.RED, 1.0) : null);
    this.slot('bTag', 4, tt, name ? this.btext(lx + tw / 2, B.TAG_BASE, this.brun(name, c.SANS_SEMI, ts, c.TEXT, 0.08), ts, 'c') : null);
    const ms = f.stalled ? `${f.elapsed.toFixed(0)} ms` : f.lastMs == null ? '–' : `${fmtFt(f.lastMs)} ms`;
    const col = f.stalled ? c.RED : f.lastMs == null ? c.TEXT : this.ftTextColor(f.lastMs, targetMs), fz = this.frameSize;
    this.slot('bFrame', 3, tt, this.btext(B.PAD, B.FRAME_BASE, this.brun('FRAME ON SCREEN', c.SANS_MED, fz, c.FOOT, 0.08) + this.run(` ${ms}`, c.MONO_SEMI, 15, col), fz));
    const { frameMs, kind } = this.a, ends = this.ends;
    let mx = 0;
    for (let i = bisectRight(ends, tt - B.WIN), hi = bisectRight(ends, tt); i < hi; i++) if (isPlay(kind[i]) && frameMs[i] > mx) mx = frameMs[i];
    this.slot('bMax', 3, tt, this.btext(B.W - B.PAD, B.FRAME_BASE, this.brun('10 S MAX', c.SANS_MED, fz, c.FOOT, 0.08) +
      this.run(` ${mx ? `${fmtFt(mx)} ms` : '–'}`, c.MONO_SEMI, 15, c.AMBER), fz, 'r'));
    // FPS graph title: min and max of the line drawn so far in the window, so it agrees with the line and its tags.
    const fs = this.fs, k1 = Math.min(fs.length - 1, Math.floor(tt / B.STEP + 1e-6));
    let mn = Infinity, mxf = -Infinity;
    for (let k = Math.max(1, Math.ceil((tt - B.WIN) / B.STEP - 1e-6)); k <= k1; k++) if (fs[k] != null) { mn = Math.min(mn, fs[k]); mxf = Math.max(mxf, fs[k]); }
    const g = this.g.fps;
    this.slot('bFpsHead', 3, tt, this.gtext(g.box[0] + g.box[2], g.box[1] - 12,
      this.brun(`LAST 10 S${mxf >= mn ? ` · MIN ${mn.toFixed(0)} · MAX ${mxf.toFixed(0)}` : ''}   `, c.SANS_MED, 14, c.LABEL, 0.08) +
      this.brun('FRAME-RATE (FPS)', c.SANS_SEMI, 20, c.TEXT, 0.04), 20, 'r'));
  }
}

// ---- look D: no overlay, only the extras (watermark, caption, long graph) ----

class NoneOverlay extends Overlay {
  drawChrome(D) { this.drawExtras(D); }
  drawNumbers() {}
  drawFrame(tt) { if (this.lg) this.drawLongGraphTick(tt, this.frameAt(tt)); }
}

const STYLES = ['panel', 'strip', 'glass', 'compact', 'broadcast', 'none', 'bands'];
const LOOKS = { panel: Overlay, strip: StripOverlay, glass: GlassOverlay, compact: CompactOverlay, broadcast: BroadcastOverlay, none: NoneOverlay };
/** The overlay for opts.style (panel when unknown). */
function createOverlay(a, size, title, rate, position, capture, opts = {}) {
  // bands lives with the A/B export whose parts it shares; required here so the two files do not load each other at start
  const Look = opts.style === 'bands' ? require('./compare-ab').BandsOverlay : STYLES.includes(opts.style) ? LOOKS[opts.style] : Overlay;
  return new Look(a, size, title, rate, position, capture, opts);
}

/** One moment of an overlay, for a preview frame: the events on screen at `at`, re-timed to the first second. */
function freezeAt(lines, at) {
  const EVT = /^Dialogue: (\d+),([\d:.]+),([\d:.]+),/;
  const secs = (s) => s.split(':').reduce((acc, v) => acc * 60 + Number(v), 0);
  // Coordinates can be negative: the frame-time graph's events glide off its left edge.
  const MOVE = /\\move\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(\d+),(\d+)\)/;
  const GROW = /\\clip\(([-\d.,]+)\)\\t\((\d+),(\d+),\\clip\(([-\d.,]+)\)\)/;
  return lines.filter((l) => { const m = EVT.exec(l); return secs(m[2]) <= at && at < secs(m[3]); })
    .map((l) => {
      const t0 = secs(EVT.exec(l)[2]);
      // A moving event is frozen where it would be at `at`.
      const frozen = l.replace(MOVE, (_, x1, y1, x2, y2, m1, m2) => {
        const k = Math.min(1, Math.max(0, ((at - t0) * 1000 - m1) / (m2 - m1)));
        return `\\pos(${f1(+x1 + (x2 - x1) * k)},${f1(+y1 + (y2 - y1) * k)})`;
      }).replace(GROW, (_, c0, m1, m2, c1) => { // a clip that widens over the clip (the bands look's played FPS line)
        const k = Math.min(1, Math.max(0, ((at - t0) * 1000 - m1) / (m2 - m1))), p = c0.split(','), q = c1.split(',');
        return `\\clip(${p.map((v, i) => Math.round(+v + (q[i] - v) * k)).join(',')})`;
      });
      return frozen.replace(EVT, 'Dialogue: $1,0:00:00.00,0:00:01.00,');
    });
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
  Overlay, StripOverlay, GlassOverlay, CompactOverlay, BroadcastOverlay, NoneOverlay, createOverlay, STYLES, END_CARD_S,
  assFilter, filterPath, assTime, assColor, tc, weightedFrames, POSITIONS, CAPTION_POSITIONS, LAYOUT,
  THEMES, THEME_NAMES, COLORS: THEMES.classic,
  rectsPath, roundedPath, monoW, fmtMs, cleanText, freezeAt,
};
