'use strict';
// The burned-in overlay, checked from the outside: synthetic clips go through
// analyse() and Overlay.build(), the ASS text is parsed back, and the panel
// must show what a viewer should see at a given moment.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { analyse, summarise } = require('../src/core/analysis');
const { Overlay, createOverlay, assColor, LAYOUT, COLORS, THEMES, THEME_NAMES } = require('../src/core/overlay');

const HZ = 60;
const SIZE = { width: 1920, height: 1080, hz: HZ };
const OX = 24, OY = 24; // panel origin with position 'left' at 1080p
const BLUE = assColor(COLORS.BLUE).slice(2), AMBER = assColor(COLORS.AMBER).slice(2), RED = assColor(COLORS.RED).slice(2);

/**
 * Measurement rows [t, diff] for a clip given refresh counts per game frame.
 * gapAt: refresh index from which the recorder's timestamps jump ahead by
 * gapRefreshes periods (a gap of gapRefreshes + 1 periods).
 */
function rowsFromCounts(counts, { gapAt = -1, gapRefreshes = 0 } = {}) {
  const rows = [];
  let i = 0;
  for (const c of counts) {
    for (let r = 0; r < c; r++) {
      const shift = gapAt >= 0 && i >= gapAt ? gapRefreshes : 0;
      rows.push([(i + shift) / HZ, i === 0 ? Infinity : r === 0 ? 10 : 0.05]);
      i++;
    }
  }
  return rows;
}

const EVENT_RE = /^Dialogue: (\d+),(\d+):(\d\d):(\d\d)\.(\d\d),(\d+):(\d\d):(\d\d)\.(\d\d),HUD,,0,0,0,,(.*)$/;
const RECT_RE = /m ([\d.]+) ([\d.]+) l ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)/g;

function parse(ass) {
  const events = [];
  const secs = (h, m, s, cs) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(cs) / 100;
  for (const line of ass.split('\n')) {
    const m = EVENT_RE.exec(line);
    if (!m) continue;
    const text = m[10];
    const tags = (text.match(/\{[^}]*\}/g) || []).join('');
    const drawing = /\\p1/.test(tags);
    const pos = /\\pos\(([\d.]+),([\d.]+)\)/.exec(tags);
    const rects = drawing
      ? [...text.matchAll(RECT_RE)].map((r) => ({ x: +r[1], y: +r[2], w: +r[3] - +r[1], h: +r[6] - +r[2], y2: +r[6] }))
      : [];
    events.push({
      layer: Number(m[1]), start: secs(m[2], m[3], m[4], m[5]), end: secs(m[6], m[7], m[8], m[9]),
      text, plain: text.replace(/\{[^}]*\}/g, ''), drawing,
      pos: pos ? [Number(pos[1]), Number(pos[2])] : null,
      colors: [...tags.matchAll(/\\c&H([0-9A-F]{8})/g)].map((x) => x[1]),
      rects,
    });
  }
  return events;
}

const active = (events, t) => events.filter((e) => e.start - 1e-6 <= t && t < e.end - 1e-6);

/** The one text event whose anchor is at (x, baseline) for a run of `size` px. */
function textAt(events, t, x, baseline, size) {
  const X = OX + x, Y = OY + baseline + 0.275 * size;
  const hits = active(events, t).filter((e) => e.pos && !e.drawing &&
    Math.abs(e.pos[0] - X) < 0.11 && Math.abs(e.pos[1] - Y) < 0.11);
  assert.equal(hits.length, 1, `one text at (${X}, ${Y.toFixed(1)}) at t=${t}; got ${hits.map((h) => h.plain).join(' | ') || 'none'}`);
  return hits[0].plain;
}

/** FPS-chart bars active at t (rects standing on the chart baseline). */
function fpsBars(events, t) {
  const base = OY + LAYOUT.FPS_TOP + LAYOUT.CHART_H;
  return active(events, t).filter((e) => e.drawing)
    .flatMap((e) => e.rects.filter((r) => Math.abs(r.y2 - base) < 0.11 && r.h >= 2).map((r) => ({ ...r, colors: e.colors })));
}

function build(counts, target, opts = {}) {
  const a = analyse(rowsFromCounts(counts, opts), HZ, 0.4, target);
  const ass = new Overlay(a, SIZE, 'Test clip', 30, 'left', SIZE).build();
  return { a, ass, events: parse(ass), summary: summarise(a, SIZE) };
}

const lastTick = (duration) => (Math.ceil(duration / 0.25) - 1) * 0.25;

const LOCKED = [[30, Array(360).fill(2)], [60, Array(720).fill(1)], [20, Array(240).fill(3)]];

for (const [target, counts] of LOCKED) {
  test(`a game locked at ${target} fps reads flat at every tick`, () => {
    const { a, events, summary } = build(counts, target);
    const yMax = Math.max(target, Math.min(1.25 * target, HZ));
    const expH = (target / yMax) * LAYOUT.CHART_H;
    for (let t = 0.25; t < a.duration - 0.25; t += 0.25) {
      assert.equal(textAt(events, t, LAYOUT.PAD, LAYOUT.HERO_BASE, 72), String(target), `hero at ${t}`);
      assert.equal(textAt(events, t, LAYOUT.COL2_R, LAYOUT.FPS_LABEL_BASE, 16), `MIN ${target} · MAX ${target}`, `min/max at ${t}`);
      const bars = fpsBars(events, t);
      assert.ok(bars.length >= 1, `bars at ${t}`);
      for (const b of bars) {
        assert.ok(Math.abs(b.h - expH) < 0.2, `bar height ${b.h} vs ${expH} at ${t}`);
        assert.ok(b.colors.includes(BLUE), `blue bar at ${t}`);
      }
    }
    const base = OY + LAYOUT.FPS_TOP + LAYOUT.CHART_H;
    for (const e of events) {
      if (!e.drawing || !(e.colors.includes(AMBER) || e.colors.includes(RED))) continue;
      assert.ok(!e.rects.some((r) => Math.abs(r.y2 - base) < 0.11 && r.h >= 2), 'no amber or red FPS bar');
    }
    const t = lastTick(a.duration) + 0.01;
    assert.equal(textAt(events, t, LAYOUT.RUN_COLS[0], LAYOUT.RUN_VALUE_BASE, 20), `${target}.0`);
    assert.equal(Number(textAt(events, t, LAYOUT.RUN_COLS[1], LAYOUT.RUN_VALUE_BASE, 20)), summary.low_1pct_fps);
    assert.equal(Number(textAt(events, t, LAYOUT.RUN_COLS[2], LAYOUT.RUN_VALUE_BASE, 20)), summary.low_0_1pct_fps);
    assert.equal(textAt(events, t, LAYOUT.RUN_COLS[3], LAYOUT.RUN_VALUE_BASE, 20), `${Math.round(summary.frames_missing_target_pct)}%`);
    assert.equal(textAt(events, t, LAYOUT.RUN_COLS[4], LAYOUT.RUN_VALUE_BASE, 20), '0');
    assert.equal(textAt(events, t, LAYOUT.COL1_R, LAYOUT.GRID_VALUE_BASE, 26), `${target}.0`);
    assert.equal(textAt(events, t, LAYOUT.COL2_R, LAYOUT.GRID_VALUE_BASE, 26), `${target}.0`);
  });
}

test('a hitch is shown while it happens, then as a labelled bar and counted', () => {
  // 1 s at 30 fps, a 483 ms frame stuck in motion, then 30 fps again.
  const { a, events } = build([...Array(30).fill(2), 29, ...Array(324).fill(2)], 30);
  assert.equal(a.kind[30], 'hitch');
  for (const tick of [3, 9, 14]) { // 1/30 s ticks inside the hitch
    const t = Math.round((1 + tick / 30) * 100) / 100;
    const s = textAt(events, t, LAYOUT.COL2_R, LAYOUT.LAST_BASE, 20);
    assert.match(s, /^HITCH\s+\d+ ms$/);
    assert.equal(Number(/(\d+) ms/.exec(s)[1]), Math.round((tick / 30) * 1000), `hitch counter at ${t}`);
  }
  const Y = OY + LAYOUT.LAST_BASE + 0.275 * 20;
  assert.equal(active(events, 1.6).filter((e) => e.pos && Math.abs(e.pos[0] - (OX + LAYOUT.COL2_R)) < 0.11 &&
    Math.abs(e.pos[1] - Y) < 0.11).length, 0, 'no badge once frames flow again');
  assert.equal(textAt(events, 1.5, LAYOUT.PAD, LAYOUT.LAST_BASE, 20), 'LAST FRAME  483.3 ms');
  const label = active(events, 2.0).filter((e) => e.plain === '483');
  assert.equal(label.length, 1, 'overflow value printed');
  assert.ok(label[0].colors.includes(RED));
  assert.match(textAt(events, 2.0, LAYOUT.COL2_R, LAYOUT.FT_LABEL_BASE, 16), /^MAX 483\.3 ms$/);
  const t = lastTick(a.duration) + 0.01;
  const runAvg = Number(textAt(events, t, LAYOUT.RUN_COLS[0], LAYOUT.RUN_VALUE_BASE, 20));
  assert.ok(Math.abs(runAvg - a.frameMs.length / a.duration) <= 0.15, `run avg ${runAvg}`);
  assert.equal(textAt(events, t, LAYOUT.RUN_COLS[4], LAYOUT.RUN_VALUE_BASE, 20), '1');
  // An amber marker under the slice where the hitch ended; no red REC DROP one.
  const tris = active(events, 2.0).filter((e) => e.drawing && e.rects.length === 0 && / l /.test(e.text) && !/ b /.test(e.text));
  assert.equal(tris.length, 1);
  assert.ok(tris[0].colors.includes(AMBER));
});

test('a hold with no motion before it is a still: dim, not red, and left out of the numbers', () => {
  const { a, events, summary } = build([29, ...Array(354).fill(2)], 30); // 483 ms first frame, then 30 fps
  assert.equal(a.kind[0], 'static');
  const s = textAt(events, 0.3, LAYOUT.COL2_R, LAYOUT.LAST_BASE, 20);
  assert.match(s, /^STILL\s+\d+ ms$/);
  assert.equal(active(events, 1.0).filter((e) => e.plain === '483').length, 0, 'no red value box for a still');
  // The first ¼ s slice lies wholly inside the still: a dim stub, not a red 0 fps bar, and not the MIN.
  const FOOT = assColor(COLORS.FOOT).slice(2);
  const first = fpsBars(events, 1.0).sort((p, q) => p.x - q.x)[0];
  assert.ok(first.colors.includes(FOOT) && !first.colors.includes(RED), `first slice colours ${first.colors}`);
  assert.equal(textAt(events, 1.0, LAYOUT.COL2_R, LAYOUT.FPS_LABEL_BASE, 16), 'MIN 30 · MAX 30');
  const t = lastTick(a.duration) + 0.01;
  assert.equal(textAt(events, t, LAYOUT.RUN_COLS[0], LAYOUT.RUN_VALUE_BASE, 20), '30.0');
  assert.equal(textAt(events, t, LAYOUT.RUN_COLS[4], LAYOUT.RUN_VALUE_BASE, 20), '0');
  assert.equal(summary.static_holds.count, 1);
  assert.equal(summary.avg_fps, 30);
});

test('recorder drops are flagged on the chart and in the footer', () => {
  const { a, ass, events } = build(Array(720).fill(1), 60, { gapAt: 300, gapRefreshes: 2 });
  assert.equal(a.droppedRefreshes, 2);
  assert.equal(a.droppedAt.length, 1);
  assert.ok(Math.abs(a.droppedAt[0] - 5) < 1e-9);
  assert.ok(!active(events, 5.1).some((e) => e.plain.includes('REC DROP')), 'not before the slice is drawn');
  assert.equal(textAt(events, 6.0, LAYOUT.COL2_R, LAYOUT.FPS_LABEL_BASE, 16), 'REC DROP · MIN 60 · MAX 60');
  assert.equal(textAt(events, 6.0, LAYOUT.PAD, LAYOUT.FPS_LABEL_BASE, 16), 'FPS · LAST 10 S');
  assert.equal(textAt(events, 4.0, LAYOUT.PAD, LAYOUT.FPS_LABEL_BASE, 16), 'FPS · LAST 10 S · ¼ S SLICES');
  const tri = active(events, 6.0).filter((e) => e.drawing && e.colors.includes(RED) && e.rects.length === 0 && / l /.test(e.text));
  assert.equal(tri.length, 1, 'one triangle marker');
  assert.ok(ass.includes('2 rec drops'));
  assert.ok(ass.includes('1080P60'));
  assert.ok(ass.includes('TEST CLIP'));
});

test('header pills can be turned off and a caption placed on the video', () => {
  const a = analyse(rowsFromCounts(Array(720).fill(1)), HZ, 0.4, 60);
  const mk = (opts) => new Overlay(a, SIZE, 'Test clip', 30, 'left', SIZE, opts).build();
  const off = mk({ showTarget: false, showFormat: false });
  assert.ok(!off.includes('TARGET 60') && !off.includes('1080P60'));
  assert.ok(mk({ showFormat: false }).includes('TARGET 60'));
  const cap = parse(mk({ caption: 'Game {Benchmark} at 1440p', captionPosition: 'bottom-right' }));
  const c = cap.filter((e) => e.plain === 'Game Benchmark at 1440p');
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].pos, [1896, 1056]);
  assert.ok(/\\an3\\/.test(c[0].text));
  // At the top on the panel's side the caption drops below the panel.
  const under = parse(mk({ caption: 'x', captionPosition: 'top-left' })).find((e) => e.plain === 'x');
  assert.deepEqual(under.pos, [24, OY + LAYOUT.PH + 16]);
  // The watermark owns the bottom left; a caption there sits above it.
  const wm = parse(mk({ caption: 'x', captionPosition: 'bottom-left' }));
  assert.deepEqual(wm.find((e) => e.plain === '4aLse Benchmarks').pos, [24, 1056]);
  assert.deepEqual(wm.find((e) => e.plain === 'x').pos, [24, 1016]);
  assert.ok(!mk({ watermark: '' }).includes('4aLse'));
  assert.ok(mk({ watermark: 'Other' }).includes('}Other'));
  // A newline would end the subtitle line early.
  assert.ok(parse(mk({ caption: 'a\nb' })).some((e) => e.plain === 'ab'));
});

test('writeTo streams the same bytes build returns', () => {
  const a = analyse(rowsFromCounts(Array(720).fill(1)), HZ, 0.4, 60);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-'));
  const file = path.join(dir, 'overlay.ass');
  new Overlay(a, SIZE, 'Test clip', 30, 'left', SIZE).writeTo(file);
  assert.equal(fs.readFileSync(file, 'utf8'), new Overlay(a, SIZE, 'Test clip', 30, 'left', SIZE).build());
  // A preview moment: only the events live at that time, all moved to the first second.
  new Overlay(a, SIZE, 'Test clip', 30, 'left', SIZE).writeTo(file, { at: 6.01 });
  const one = parse(fs.readFileSync(file, 'utf8'));
  const all = parse(new Overlay(a, SIZE, 'Test clip', 30, 'left', SIZE).build());
  assert.equal(one.length, active(all, 6.01).length);
  assert.ok(one.length > 20 && one.every((e) => e.start === 0 && e.end === 1));
  assert.equal(textAt(one, 0.5, LAYOUT.PAD, LAYOUT.HERO_BASE, 72), '60');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the strip and glass looks build cleanly and show the hero', () => {
  const a = analyse(rowsFromCounts(Array(720).fill(1)), HZ, 0.4, 60);
  for (const [style, x, base, size] of [['strip', 22, 54, 46], ['glass', 16, 114, 76]]) {
    const ov = createOverlay(a, SIZE, 'Test clip', 30, 'right', SIZE, { style });
    const W = ov.W;
    assert.ok(W > 0 && W < 1920 && W !== LAYOUT.PW, `${style}: own width (${W})`);
    const ass = ov.build(), events = parse(ass);
    assert.ok(!/NaN|undefined|Infinity|null/.test(ass), `${style}: no stray values`);
    const X = 1920 - 24 - W + x, Y = OY + base + 0.275 * size;
    const hero = active(events, 6.0).filter((e) => e.pos && Math.abs(e.pos[0] - X) < 0.11 && Math.abs(e.pos[1] - Y) < 0.11);
    assert.equal(hero.length, 1, `${style}: one hero text`);
    assert.equal(hero[0].plain, '60');
    assert.ok(ass.includes('TARGET 60') && ass.includes('TEST CLIP'), `${style}: pills and title`);
    // The box is a dark fill with a faint white edge, not the other way round.
    const box = events.find((e) => e.layer === 0 && e.drawing);
    assert.ok(box.text.includes(`\\c${assColor(COLORS.PANEL)}`) && box.text.includes('\\3c&H00FFFFFF') && box.text.includes('\\3a&HEB&'), `${style}: box colours`);
    assert.ok(events.length <= 350 * a.duration + 100, `${style}: ${events.length} events`);
  }
  const none = createOverlay(a, SIZE, 'Test clip', 30, 'right', SIZE, { style: 'none', caption: 'Cap' }).build();
  assert.ok(none.includes('4aLse') && none.includes('}Cap') && !/TARGET|TEST CLIP|FPS/.test(none), 'none: extras only');
  assert.ok(parse(none).length < 10, 'none: no per-frame events');
  for (const style of ['nope', 'constructor', '__proto__']) {
    assert.equal(createOverlay(a, SIZE, 'x', 30, 'right', SIZE, { style }).constructor, Overlay, `${style} falls back to the panel`);
  }
});

test('the compact look shows FPS, average, frame time and the graph, nothing else', () => {
  // 1.5 s locked at 60, one 483 ms hitch, then 5.4 s locked again.
  const a = analyse(rowsFromCounts([...Array(90).fill(1), 29, ...Array(324).fill(1)]), HZ, 0.4, 60);
  for (const theme of THEME_NAMES) {
    const ov = createOverlay(a, SIZE, 'Test clip', 30, 'left', SIZE, { style: 'compact', theme });
    assert.equal(ov.W, 356);
    const ass = ov.build(), events = parse(ass);
    assert.ok(!/NaN|undefined|Infinity|null/.test(ass), `${theme}: no stray values`);
    assert.ok(!/TARGET|TEST CLIP|1% LOW/.test(ass), `${theme}: no pills, title or lows`);
    assert.ok(ass.includes('AVG 10 S') && ass.includes('}FRAME') && ass.includes('}FPS'), `${theme}: labels`);
    const hero = active(events, 6.0).filter((e) => e.pos && Math.abs(e.pos[0] - (OX + 18)) < 0.11 && Math.abs(e.pos[1] - (OY + 45 + 0.275 * 40)) < 0.11);
    assert.equal(hero.length, 1, `${theme}: one hero text`);
    assert.equal(hero[0].plain, '60');
    // Everything but the watermark stays inside the tile.
    const inside = (x, y) => x >= OX - 0.11 && x <= OX + 356 + 0.11 && y >= OY - 0.11 && y <= OY + 114 + 0.11;
    for (const e of active(events, 6.0).filter((x) => !x.plain.includes('4aLse'))) {
      if (e.drawing) assert.ok(e.rects.every((r) => inside(r.x, r.y) && inside(r.x + r.w, r.y2)), `${theme}: shape inside`);
      else assert.ok(inside(...e.pos), `${theme}: ${e.plain} inside`);
    }
  }
  const events = parse(createOverlay(a, SIZE, 'Test clip', 30, 'left', SIZE, { style: 'compact' }).build());
  // While the hitch is on screen FRAME reads HITCH in red; after it the graph labels the 483 ms bar.
  const during = active(events, 1.5 + 0.3);
  assert.ok(during.some((e) => e.plain === 'HITCH' && e.colors.includes(RED)), 'hitch badge');
  assert.ok(!during.some((e) => e.plain === 'FRAME'), 'FRAME gives way to the badge');
  assert.ok(active(events, 3.0).some((e) => e.plain === '483' && e.colors.includes(RED)), 'overflow label on the graph');
});

/** Bounding box (output px) of a still drawing's path. */
function pathBox(e) {
  const nums = e.text.replace(/^.*?\\p1[^}]*\}/, '').replace(/\{\\p0\}$/, '').match(/-?[\d.]+/g).map(Number);
  const xs = nums.filter((_, i) => i % 2 === 0), ys = nums.filter((_, i) => i % 2 === 1);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

test('the broadcast look: a top-right panel over FPS and frame-time graphs, in every theme and at 4K', () => {
  // 30 fps on 60 Hz: two back-to-back spikes (100 and 83 ms) at 2 s, a 483 ms hitch at 6.15 s.
  const counts = [...Array(60).fill(2), 6, 2, 5, ...Array(118).fill(2), 29, ...Array(120).fill(2)];
  const a = analyse(rowsFromCounts(counts), HZ, 0.4, 30);
  for (const height of [1080, 2160]) {
    const k = height / 1080, size = { width: 1920 * k, height, hz: HZ };
    for (const theme of THEME_NAMES) {
      const ov = createOverlay(a, size, 'Test clip', 30, 'left', size, { style: 'broadcast', theme });
      const ass = ov.build(), events = parse(ass), tag = `${theme}@${height}`;
      assert.ok(!/NaN|undefined|Infinity|null/.test(ass), `${tag}: no stray values`);
      assert.ok(ass.includes('TARGET 30') && ass.includes('TEST CLIP') && !ass.includes('1080P60'), `${tag}: title and target pill only`);
      // The panel: 452 x 400 with its BLUE edge, 5 px from the top and right whatever position was asked for.
      const panel = events.find((e) => e.layer === 0 && e.drawing && e.text.includes(`\\3c${assColor(THEMES[theme].BLUE)}`));
      const [px0, py0, px1, py1] = pathBox(panel);
      assert.ok(Math.abs(px0 - (1920 - 5 - 452) * k) < 0.2 && Math.abs(px1 - (1920 - 5) * k) < 0.2 && Math.abs(py0 - 5 * k) < 0.2 && Math.abs(py1 - 405 * k) < 0.2, `${tag}: panel at the top right`);
      // The graph boxes: FPS full width 12 px above the bottom, frame time 360 x 132 above it at the left.
      const boxes = events.filter((e) => e.layer === 0 && e.drawing && e !== panel).map(pathBox);
      assert.ok(boxes.some((b) => b.every((v, i) => Math.abs(v - [16, 868, 1864, 1068][i] * k) < 0.2)), `${tag}: FPS box`);
      assert.ok(boxes.some((b) => b.every((v, i) => Math.abs(v - [16, 731, 376, 863][i] * k) < 0.2)), `${tag}: frame-time box`);
      // Everything on screen sits in the panel, in the graph area at the bottom, or is the watermark at the top left.
      const inPanel = (x, y) => x >= px0 - 0.2 && x <= px1 + 0.2 && y >= py0 - 0.2 && y <= py1 + 0.2;
      const inGraphs = (x, y) => x >= 16 * k - 0.2 && x <= 1904 * k + 0.2 && y >= 690 * k && y <= 1080 * k;
      for (const e of active(events, 7.0)) {
        if (/\\move\(/.test(e.text)) assert.ok(e.text.includes(ov.g.fps.clip) || e.text.includes(ov.g.ft.clip), `${tag}: moving event clipped to a graph`);
        else if (e.drawing) { const [x0, y0, x1, y1] = pathBox(e); assert.ok((inPanel(x0, y0) && inPanel(x1, y1)) || (inGraphs(x0, y0) && inGraphs(x1, y1)), `${tag}: shape ${pathBox(e)}`); }
        else if (e.plain.includes('4aLse')) assert.deepEqual(e.pos, [16 * k, 16 * k], `${tag}: watermark top left`);
        else assert.ok(inPanel(...e.pos) || inGraphs(...e.pos), `${tag}: ${e.plain} at ${e.pos}`);
      }
      const hero = active(events, 9.0).filter((e) => e.plain === '30' && e.pos && Math.abs(e.pos[0] - px0 - 22 * k) < 0.2);
      assert.ok(hero.length >= 1, `${tag}: hero`);
    }
  }
  const ov = createOverlay(a, SIZE, 'Test clip', 30, 'right', SIZE, { style: 'broadcast' });
  const events = parse(ov.build());
  // One tag per spike cluster (the worst frame) and one per dip, gliding with the lines.
  const tags = (clip) => events.filter((e) => !e.drawing && e.text.includes(clip));
  assert.deepEqual([...new Set(tags(ov.g.ft.clip).map((e) => e.plain))], ['100', '483'], 'one tag per spike cluster');
  assert.ok(tags(ov.g.ft.clip).every((e) => e.layer === 4), 'spike tags over their box');
  const dipsAt = (t) => active(tags(ov.g.fps.clip), t);
  assert.equal(dipsAt(7.5).length, 2, 'one tag per dip once both are over');
  // A new tag waits wholly inside its box: its right edge never starts past the plot's.
  for (const p of [ov.g.fps, ov.g.ft]) {
    for (const e of events.filter((e) => e.drawing && e.layer === 3 && e.text.includes(p.clip))) {
      const x = Number(/\\move\(([\d.]+)/.exec(e.text)[1]);
      assert.ok(x + pathBox(e)[2] <= (p.x0 + p.iw) * ov.k + 0.2, `tag inside at ${e.start}`);
    }
  }
  // While the hitch is held the hero gets a red HITCH tag and the frame on screen counts up in red, in ms past 1 s too.
  const during = active(events, 6.4);
  assert.ok(during.some((e) => e.plain === 'HITCH'), 'hold tag');
  assert.ok(during.some((e) => /^FRAME ON SCREEN \d+ ms$/.test(e.plain) && e.colors.includes(RED)), 'held time in red');
  // A still: the hero shows the real 0.5 s rate (0, red), the FPS line keeps going through it, and the frame-time line
  // runs along the bottom in the line's one colour, without a spike tag: a still is not a hitch. The FPS dip gets one tag, at its low.
  const rows = rowsFromCounts([...Array(90).fill(2), 150, ...Array(60).fill(2)]);
  for (let k = 81; k < 90; k++) rows[2 * k][1] = 0.6; // barely any motion before the 2.5 s hold at 3 s: a still
  const still = analyse(rows, HZ, 0.4, 30);
  assert.equal(still.kind[90], 'static');
  const sov = createOverlay(still, SIZE, 'Test clip', 30, 'right', SIZE, { style: 'broadcast', theme: 'vice' });
  const sev = parse(sov.build()), at = active(sev, 4.5);
  assert.ok(at.some((e) => e.plain === '0' && e.colors.includes(assColor(THEMES.vice.RED).slice(2))), 'real rate in red while held');
  assert.ok(at.some((e) => e.plain === 'STILL') && at.some((e) => e.plain === 'FRAME ON SCREEN 1500 ms'), 'still tag, held time in ms');
  assert.ok(sev.some((e) => e.drawing && e.text.includes(sov.g.fps.clip) && e.start > 3.5 && e.start < 5.4), 'FPS line through the still');
  assert.ok(!sev.some((e) => !e.drawing && e.text.includes(sov.g.ft.clip)), 'no spike tag for a still');
  const dips = active(sev, 6).filter((e) => !e.drawing && e.text.includes(sov.g.fps.clip));
  assert.deepEqual(dips.map((e) => e.plain), ['0'], 'one dip tag, at the low');
  assert.ok(!sev.some((e) => e.drawing && e.text.includes(sov.g.ft.clip) && !e.text.includes(`\\c${assColor(THEMES.vice.BLUE)}`)), 'one line colour');
  assert.ok(!sev.some((e) => /\\fax/.test(e.text) && !/\\fnIBM/.test(e.text) && e.plain === '30'), 'upright hero');
  // The long graph is not drawn: the look has its own frame-time graph.
  assert.equal(createOverlay(a, SIZE, 'Test clip', 30, 'right', SIZE, { style: 'broadcast', longGraph: true }).build(), ov.build());
});

test('the broadcast-lite look: one slim top-right row over smaller Broadcast graphs, in every theme and at 4K', () => {
  const counts = [...Array(60).fill(2), 6, 2, 5, ...Array(118).fill(2), 29, ...Array(120).fill(2)];
  const a = analyse(rowsFromCounts(counts), HZ, 0.4, 30);
  for (const height of [1080, 2160]) {
    const k = height / 1080, size = { width: 1920 * k, height, hz: HZ };
    for (const theme of THEME_NAMES) {
      const ov = createOverlay(a, size, 'Test clip', 30, 'left', size, { style: 'broadcast-lite', theme });
      const ass = ov.build(), events = parse(ass), tag = `${theme}@${height}`;
      assert.ok(!/NaN|undefined|Infinity|null/.test(ass), `${tag}: no stray values`);
      assert.ok(ass.includes('TARGET 30') && ass.includes('TEST CLIP') && !ass.includes('RUN AVG') && !ass.includes('PACING'), `${tag}: header, no run row or pacing`);
      // The panel: 400 x 134, 5 px from the top and right whatever position was asked for.
      const panel = events.find((e) => e.layer === 0 && e.drawing && e.text.includes(`\\3c${assColor(THEMES[theme].BLUE)}`));
      const [px0, py0, px1, py1] = pathBox(panel);
      assert.ok(Math.abs(px0 - (1920 - 5 - 400) * k) < 0.2 && Math.abs(px1 - (1920 - 5) * k) < 0.2 && Math.abs(py0 - 5 * k) < 0.2 && Math.abs(py1 - 139 * k) < 0.2, `${tag}: panel at the top right`);
      // The graph boxes: FPS 140 px tall, 12 px above the bottom; frame time 300 x 96 above it at the left.
      const boxes = events.filter((e) => e.layer === 0 && e.drawing && e !== panel).map(pathBox);
      assert.ok(boxes.some((b) => b.every((v, i) => Math.abs(v - [16, 928, 1864, 1068][i] * k) < 0.2)), `${tag}: FPS box`);
      assert.ok(boxes.some((b) => b.every((v, i) => Math.abs(v - [16, 827, 316, 923][i] * k) < 0.2)), `${tag}: frame-time box`);
      const inPanel = (x, y) => x >= px0 - 0.2 && x <= px1 + 0.2 && y >= py0 - 0.2 && y <= py1 + 0.2;
      const inGraphs = (x, y) => x >= 16 * k - 0.2 && x <= 1904 * k + 0.2 && y >= 790 * k && y <= 1080 * k;
      for (const e of active(events, 7.0)) {
        if (/\\move\(/.test(e.text)) assert.ok(e.text.includes(ov.g.fps.clip) || e.text.includes(ov.g.ft.clip), `${tag}: moving event clipped to a graph`);
        else if (e.drawing) { const [x0, y0, x1, y1] = pathBox(e); assert.ok((inPanel(x0, y0) && inPanel(x1, y1)) || (inGraphs(x0, y0) && inGraphs(x1, y1)), `${tag}: shape ${pathBox(e)}`); }
        else if (e.plain.includes('4aLse')) assert.deepEqual(e.pos, [16 * k, 16 * k], `${tag}: watermark top left`);
        // A text's anchor is its line box bottom, below the baseline by the descent: 0.377 em of the 56 px Oswald hero in vice.
        else assert.ok(inPanel(e.pos[0], e.pos[1] - 22 * k) || inGraphs(...e.pos), `${tag}: ${e.plain} at ${e.pos}`);
      }
      // Labels on one baseline, numbers on another: the hero, AVG and 1% LOW share a y.
      const at9 = active(events, 9.0).filter((e) => !e.drawing && e.pos && inPanel(...e.pos));
      const ys = (re) => at9.filter((e) => re.test(e.plain)).map((e) => e.pos[1]);
      assert.equal(new Set(ys(/^(AVG|1% LOW|FRAME MS|FPS · 0\.5 S)$/)).size, 1, `${tag}: one label baseline`);
    }
  }
  const events = parse(createOverlay(a, SIZE, 'Test clip', 30, 'right', SIZE, { style: 'broadcast-lite' }).build());
  // While the hitch is held: a red HITCH tag beside FPS, and FRAME MS counting up in red.
  const during = active(events, 6.4);
  assert.ok(during.some((e) => e.plain === 'HITCH') && during.some((e) => e.plain === 'FPS'), 'hold tag beside FPS');
  assert.ok(during.some((e) => /^\d+\.\d$/.test(e.plain) && e.colors.includes(RED)), 'held time in red');
  assert.ok(!during.some((e) => e.plain === 'FPS · 0.5 S'), 'tag replaces the window label');
});

test('the broadcast look grows with the clip, not with the clip times its window', () => {
  const count = (seconds) => {
    const counts = Array.from({ length: seconds * 30 }, (_, i) => (i % 97 === 50 ? 6 : 2));
    const a = analyse(rowsFromCounts(counts), HZ, 0.4, 30);
    const ass = createOverlay(a, SIZE, 'Test clip', 30, 'right', SIZE, { style: 'broadcast' }).build();
    return { events: parse(ass).length, bytes: Buffer.byteLength(ass) };
  };
  const short = count(10), long = count(40);
  assert.ok(long.events / short.events < 4.4 && long.bytes / short.bytes < 4.4, `x${(long.events / short.events).toFixed(2)} events, x${(long.bytes / short.bytes).toFixed(2)} bytes`);
});

test('the long graph scrolls one moving event per frame', () => {
  const a = analyse(rowsFromCounts([...Array(30).fill(2), 29, ...Array(324).fill(2)]), HZ, 0.4, 30);
  const ass = new Overlay(a, SIZE, 'Test clip', 30, 'left', SIZE,
    { longGraph: true, longGraphOpacity: 0.5, caption: 'Cap', captionPosition: 'bottom-center' }).build();
  const events = parse(ass);
  const moving = events.filter((e) => /\\move\(/.test(e.text));
  // The last frame ends with the clip, so its bar never shows; the 483 ms hitch adds a value box and its text.
  assert.equal(moving.length, a.frameMs.length - 1 + 2);
  assert.ok(moving.every((e) => /\\clip\(/.test(e.text)), 'every moving event is clipped to the chart');
  const first = moving.find((e) => e.drawing && e.colors.includes(RED));
  assert.ok(Math.abs(first.start - 89 / 60) < 0.011, 'the hitch bar appears when that frame ends');
  // Background at 50 %: the graph box is a layer-0 drawing with alpha 80.
  assert.ok(events.some((e) => e.layer === 0 && e.drawing && e.text.includes('\\1a&H80&')), 'graph background at 50 %');
  assert.deepEqual(events.find((e) => e.plain === 'Cap').pos, [960, 1080 - 24 - 116 - 16]);
  assert.ok(ass.includes('LAST 7.5 S'));
  assert.ok(events.length <= 500 * a.duration + 100, `${events.length} events for ${a.duration} s`);
});

test('pacing shows how many frames held the cap exactly, and on-time shares at the refresh rate', () => {
  const { events } = build(Array(360).fill(2), 30);
  assert.equal(active(events, 6.0).filter((e) => e.plain === '33.3 ms  100%').length, 1);
  assert.equal(textAt(events, 6.0, LAYOUT.COL2_R, LAYOUT.PACING_BASE, 13), 'EVEN 100%');
  assert.equal(textAt(events, 6.0, LAYOUT.COL2_R, LAYOUT.FOOT_BASE, 13), '0:06.00');
  // 30 fps delivered as 1-3-1-3 refreshes: the average is 30, the pacing is not.
  const uneven = build(Array.from({ length: 360 }, (_, i) => (i % 2 ? 3 : 1)), 30);
  assert.equal(uneven.summary.avg_fps, 30);
  assert.equal(uneven.summary.pacing.even_pct, 0);
  assert.equal(textAt(uneven.events, 6.0, LAYOUT.COL2_R, LAYOUT.PACING_BASE, 13), 'EVEN 0%');
  assert.equal(textAt(uneven.events, 6.0, LAYOUT.COL1_R, LAYOUT.GRID_VALUE_BASE, 26), '30.0');
  // At the refresh rate every frame is one refresh: the on-time bar stays.
  const sixty = build(Array(720).fill(1), 60);
  assert.equal(active(sixty.events, 6.0).filter((e) => e.plain === '16.7 ms  100%').length, 1);
});

test('a tear draws a fading line across the video where it was, and flags the FPS row', () => {
  const a = analyse(rowsFromCounts(Array(720).fill(1)), HZ, 0.4, 60);
  a.tears = [{ time: 3, y: 0.5 }];
  const events = parse(new Overlay(a, SIZE, 'Test clip', 30, 'left', SIZE).build());
  const line = events.filter((e) => e.layer === 5);
  assert.equal(line.length, 1);
  assert.ok(Math.abs(line[0].start - 3) < 0.011 && Math.abs(line[0].end - 3.4) < 0.011);
  assert.ok(line[0].text.includes('\\fad(0,300)') && line[0].colors.includes(RED));
  assert.deepEqual([line[0].rects[0].x, line[0].rects[0].y, line[0].rects[0].w], [0, 539, 1920]);
  assert.equal(textAt(events, 3.25, LAYOUT.COL2_R, LAYOUT.FPS_LABEL_BASE, 16), 'TEAR · MIN 60 · MAX 60');
  assert.equal(textAt(events, 2.75, LAYOUT.COL2_R, LAYOUT.FPS_LABEL_BASE, 16), 'MIN 60 · MAX 60');
});

test('the end card holds the results over the last frame for 4 s', () => {
  const a = analyse(rowsFromCounts([...Array(30).fill(2), 29, ...Array(324).fill(2)]), HZ, 0.4, 30);
  const s = summarise(a, SIZE);
  const events = parse(new Overlay(a, SIZE, 'Test clip', 30, 'left', SIZE, { endCard: true }).build());
  const card = events.filter((e) => e.start >= a.duration - 0.011);
  assert.ok(card.length > 30, `${card.length} card events`);
  assert.ok(card.every((e) => Math.abs(e.end - (a.duration + 4)) < 0.011), 'all end 4 s after the clip');
  const plain = card.map((e) => e.plain);
  for (const s of ['AVG FPS', '1% LOW', 'PACING EVEN', 'STUTTER TIME', 'HITCHES', 'TEARS']) assert.ok(plain.includes(s), s);
  assert.ok(plain.some((p) => p.startsWith('FRAME TIME · ')), 'histogram title');
  assert.ok(plain.includes(s.avg_fps.toFixed(1)) && plain.includes(String(s.hitches.count)) && plain.includes(`${Math.round(s.pacing.even_pct)}%`));
  assert.ok(!events.some((e) => e.start < a.duration - 0.011 && e.end > a.duration + 0.011), 'nothing else runs into the card');
});

test('overlay themes recolour the panel; classic is the default and unchanged', () => {
  const a = analyse(rowsFromCounts(Array(720).fill(1)), HZ, 0.4, 60);
  const mk = (theme) => new Overlay(a, SIZE, 'Test clip', 30, 'left', SIZE, theme === undefined ? {} : { theme }).build();
  assert.deepEqual(THEME_NAMES, ['classic', 'mono', 'aurora', 'vice']);
  const out = {};
  for (const theme of THEME_NAMES) {
    out[theme] = mk(theme);
    const events = parse(out[theme]);
    assert.ok(events.length > 100 && !/NaN|undefined|Infinity|null/.test(out[theme]), `${theme}: builds`);
    const hero = active(events, 6.0).filter((e) => e.plain === '60' && e.pos && Math.abs(e.pos[0] - (OX + LAYOUT.PAD)) < 0.11);
    assert.ok(hero.length >= 1, `${theme}: hero shown`);
    assert.ok(out[theme].includes(assColor(THEMES[theme].PANEL)), `${theme}: its card colour`);
  }
  assert.equal(out.classic, mk(undefined), 'classic is the default');
  assert.equal(mk('nope'), out.classic, 'an unknown theme falls back to classic');
  assert.ok(out.vice.includes('\\fnOswald Bold') && out.vice.includes('\\fnOswald Medium') && out.vice.includes('\\fax-0.18'), 'vice: sheared Oswald');
  assert.ok(!/\\fnIBM Plex Mono[^\\]*\\[^}]*\\fax/.test(out.vice), 'vice: mono runs are not sheared');
  assert.ok(out.vice.includes('\\clip('), 'vice: two-tone hero');
  assert.ok(out.aurora.includes('\\blur'), 'aurora: hero glow');
  // Mono's on-target bars are the text colour at 55 %, not blue.
  const bars = fpsBars(parse(out.mono), 6.0);
  assert.ok(bars.length > 10 && bars.every((b) => b.colors.includes(assColor(THEMES.mono.TEXT).slice(2))), 'mono: white bars');
  const barEvents = parse(out.mono).filter((e) => e.drawing && e.rects.some((r) => Math.abs(r.y2 - (OY + LAYOUT.FPS_TOP + LAYOUT.CHART_H)) < 0.11 && r.h >= 2));
  assert.ok(barEvents.length && barEvents.every((e) => e.text.includes('\\1a&H73&')), 'mono: bars at 55 % alpha');
  assert.ok(!out.mono.includes(assColor(COLORS.BLUE)), 'mono: no blue');
});

test('the subtitle file is well formed and bounded', () => {
  const clips = [[30, Array(360).fill(2)], [60, Array(720).fill(1)], [30, [29, ...Array(354).fill(2)]]];
  for (const [target, counts] of clips) {
    const { a, ass, events } = build(counts, target);
    assert.ok(!/NaN|undefined|Infinity|null/.test(ass), 'no stray values');
    assert.ok(ass.includes('PlayResX: 1920') && ass.includes('PlayResY: 1080'));
    for (const e of events) {
      assert.ok(e.start < e.end, `event ${e.start}-${e.end}`);
      assert.ok(e.end <= a.duration + 0.011, `event ends after the clip: ${e.end}`);
    }
    assert.ok(events.length <= 350 * a.duration + 100, `${events.length} events for ${a.duration} s`);
    assert.ok(Buffer.byteLength(ass) <= 250e3 * a.duration, `${Buffer.byteLength(ass)} bytes for ${a.duration} s`);
  }
});
