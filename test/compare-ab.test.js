'use strict';
// The A/B export and the bands look, checked from the outside: synthetic clips go
// through analyse(), the overlay's ASS text is parsed back, and the filter graph and
// encoder choice are checked as data.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { analyse, summarise, writeCsvs } = require('../src/core/analysis');
const { createOverlay, assColor } = require('../src/core/overlay');
const ab = require('../src/core/compare-ab');
const { compareABGraph, videoArgs, sizeFor, overlayFilter, AB_SIZES } = require('../src/core/pipeline');

const HZ = 60;
const WHITE = assColor(0xF5F6F8).slice(2), AMBER = assColor(0xF5B544).slice(2), RED = assColor(0xF2555C).slice(2);

/** Measurement rows for a clip given refresh counts per game frame; frame `blackAt` starts on a black screen. */
function rowsFromCounts(counts, blackAt = -1) {
  const rows = [];
  let i = 0;
  counts.forEach((c, f) => {
    for (let r = 0; r < c; r++, i++) rows.push([i / HZ, i === 0 ? Infinity : r === 0 ? 10 : 0.05, r === 0 ? 100 : 5, f === blackAt && r === 0 ? 5 : 100]);
  });
  return rows;
}

// 2 s at 60, a 200 ms hitch, 1 s at 60, a 1.5 s load, then 3.3 s at 60.
const EVENTFUL = [...Array(120).fill(1), 12, ...Array(60).fill(1), 90, ...Array(200).fill(1)];
const eventful = () => analyse(rowsFromCounts(EVENTFUL, 181), HZ, 0.4, 60);
const locked = (n = 600, k = 1, target = 60) => analyse(rowsFromCounts(Array(n).fill(k)), HZ, 0.4, target);

const EVENT_RE = /^Dialogue: (\d+),(\d+):(\d\d):(\d\d)\.(\d\d),(\d+):(\d\d):(\d\d)\.(\d\d),HUD,,0,0,0,,(.*)$/;

function parse(ass) {
  const secs = (h, m, s, cs) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(cs) / 100;
  return ass.split('\n').map((line) => EVENT_RE.exec(line)).filter(Boolean).map((m) => {
    const text = m[10], tags = (text.match(/\{[^}]*\}/g) || []).join('');
    const pos = /\\pos\(([-\d.]+),([-\d.]+)\)/.exec(tags) || /\\move\(([-\d.]+),([-\d.]+),/.exec(tags);
    const drawing = /\\p1/.test(tags);
    const nums = drawing ? (text.replace(/\{[^}]*\}/g, ' ').match(/-?\d+(\.\d+)?/g) || []).map(Number) : [];
    const ys = nums.filter((_, i) => i % 2 === 1);
    return {
      layer: Number(m[1]), start: secs(m[2], m[3], m[4], m[5]), end: secs(m[6], m[7], m[8], m[9]),
      text, plain: text.replace(/\{[^}]*\}/g, ''), drawing, moving: /\\move\(/.test(tags),
      an: Number((/\\an(\d)/.exec(tags) || [])[1] || 7), pos: pos ? [Number(pos[1]), Number(pos[2])] : null,
      fs: Math.max(0, ...[...tags.matchAll(/\\fs([\d.]+)/g)].map((x) => Number(x[1]))),
      colors: [...tags.matchAll(/\\c&H([0-9A-F]{8})/g)].map((x) => x[1]),
      yMin: ys.length ? Math.min(...ys) : null, yMax: ys.length ? Math.max(...ys) : null,
    };
  });
}

const active = (events, t) => events.filter((e) => e.start - 1e-6 <= t && t < e.end - 1e-6);
const findText = (events, t, re) => active(events, t).filter((e) => !e.drawing && re.test(e.plain));

/** Lowest point an event reaches, in output px. */
function bottomOf(e) {
  if (e.drawing) return e.pos[1] + e.yMax;
  if (e.an <= 3) return e.pos[1]; // anchored by the bottom of the text
  return e.pos[1] + e.fs * (e.plain.split('\\N').length); // \an7: top, one line per \N
}

function assertSafe(events, H, what) {
  const limit = 0.92 * H + 0.5;
  for (const e of events) {
    if (e.drawing && e.yMax - e.yMin > 0.5 * H) continue; // the seam between the videos and the end card's backdrop
    assert.ok(bottomOf(e) <= limit, `${what}: "${e.plain || e.text.slice(0, 60)}" reaches ${bottomOf(e).toFixed(1)} px, below ${limit.toFixed(1)}`);
  }
}

function abEvents({ frame = '16:9', fit = 'letterbox', panes = [locked(), eventful()], span = 6, endCard = true, sums, subs } = {}) {
  const [W, H] = AB_SIZES[frame][1080];
  const ov = ab.abOverlay({
    panes: panes.map((a, i) => ({ a: ab.shiftAnalysis(a, 0, span), summary: (sums || [])[i] || summarise(a, { width: 1920, height: 1080 }), title: i ? 'PS5' : 'PS5 Pro', subtitle: subs ? subs[i] : 'Forza Horizon 6 · Performance' })),
    size: { width: W, height: H }, frame, fit, span, endCard,
  });
  const ass = ov.build();
  return { ass, events: parse(ass), W, H };
}

function fixtureDir(a) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capfps-ab-'));
  writeCsvs(a, dir);
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summarise(a, { width: 1920, height: 1080 })));
  return dir;
}

test('loadAnalysis rebuilds the overlay fields from a saved folder and names a missing file', async () => {
  const a = eventful(), dir = fixtureDir(a);
  try {
    const an = await ab.loadAnalysis(dir);
    assert.equal(an.outDir, path.resolve(dir));
    assert.equal(an.a.starts.length, a.starts.length);
    assert.ok(an.a.frameMs.every((ms, i) => Math.abs(ms - a.frameMs[i]) < 0.01));
    assert.deepEqual(an.a.kind, a.kind);
    assert.deepEqual(an.a.holds.map((h) => h.kind), ['hitch', 'loading']);
    assert.equal(an.a.target, 60);
    assert.equal(an.a.hz, 60);
    assert.ok(Math.abs(an.a.duration - a.duration) < 0.01);
    // The whole run re-summarised gives summary.json's numbers, not ones off by the rounded length.
    const whole = ab.overlapSummary(dir, 0, an.a.duration);
    // (lows can move by 0.01: frames.csv keeps frame times to 2 decimals)
    assert.deepEqual([whole.avg_fps, whole.frames_missing_target_pct], [an.summary.avg_fps, an.summary.frames_missing_target_pct]);
    assert.deepEqual([an.a.tears, an.a.droppedAt], [[], []]);
    assert.deepEqual([an.info.width, an.info.height, an.info.fps], [1920, 1080, 60]);
    assert.equal(an.perSecond.length, Math.floor(a.duration));
    const d = ab.abData(dir);
    assert.deepEqual(d.hitches, [[2, 200]]);
    assert.deepEqual(d.paused, [[3.2, 1500, 'loading']]);
    assert.equal(d.ftMax.length, d.perSecond.length);
    assert.equal(d.ftMax[2][1], 200, 'the hitch is the worst frame of second 2');
    assert.equal(d.ftMax[3][1], null, 'second 3 is mostly the load: the line breaks there, as in the FPS view');
    fs.rmSync(path.join(dir, 'frames.csv'));
    await assert.rejects(ab.loadAnalysis(dir), /frames\.csv is missing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compareABGraph lays out every frame and fit with even panes that fill the width', () => {
  const info = { width: 1920, height: 1080, hz: 60, duration: 20 };
  const expect = {
    '16:9/letterbox': [1920, 1080, 270, 540], '16:9/crop': [1920, 1080, 0, 1080],
    '21:9/letterbox': [2560, 1080, 90, 720], '21:9/crop': [2560, 1080, 0, 1080], '21:9/below': [2560, 1080, 0, 720],
  };
  for (const [key, [W, H, y, h]] of Object.entries(expect)) {
    const [frame, fit] = key.split('/');
    for (const size of Object.keys(AB_SIZES[frame])) {
      const g = compareABGraph({ infos: [info, info], offset: 0, frame, fit, size, assName: 'ab.ass', outDir: '.' });
      const k = Number(size) / 1080;
      assert.deepEqual([g.width, g.height], AB_SIZES[frame][size], key);
      for (const p of g.panes) assert.ok(p.w % 2 === 0 && p.h % 2 === 0 && p.y % 2 === 0, `${key} ${size}: even pane ${JSON.stringify(p)}`);
      assert.equal(g.panes[0].x, 0);
      assert.equal(g.panes[1].x, g.panes[0].w, `${key}: B starts where A ends`);
      assert.equal(g.panes[0].w + g.panes[1].w, g.width, `${key}: the halves fill the width`);
      if (size === '1080') assert.deepEqual([W, H, g.panes[0].y, g.panes[0].h], [W, H, y, h], key);
      else assert.ok(Math.abs(g.panes[0].h - h * k) <= 2, `${key} ${size}: pane height scales`);
      assert.match(g.graph, new RegExp(`\\[1:v\\].*${fit === 'crop' ? 'force_original_aspect_ratio=increase.*crop=' : 'force_original_aspect_ratio=decrease.*pad='}`), key);
    }
  }
  assert.throws(() => compareABGraph({ infos: [info, info], frame: '16:9', fit: 'below', assName: 'a.ass' }), /21:9/);
});

test('compareABGraph trims the right input by the offset and holds both for the end card', () => {
  const a = { width: 1920, height: 1080, hz: 60, duration: 10 }, b = { ...a, duration: 12 };
  const later = compareABGraph({ infos: [a, b], offset: 1.5, frame: '16:9', fit: 'letterbox', assName: 'ab.ass', outDir: '.', endCard: true, sound: 1 });
  assert.deepEqual(later.skips, [0, 1.5]);
  assert.equal(later.span, 10);
  // Each input seeks before decoding (-ss before -i); the graph only cuts the length.
  assert.deepEqual(later.seeks, ['0.000', '1.500']);
  assert.ok(later.graph.includes('[1:v]setpts=PTS-STARTPTS,trim=duration=10.000,'));
  assert.ok(later.graph.includes('[0:v]setpts=PTS-STARTPTS,trim=duration=10.000,'));
  assert.ok(!later.graph.includes('trim=start='));
  assert.ok(later.graph.includes('color=c=black:s=1920x1080:r=60:d=15.000[bg]'), 'canvas runs on through the end card');
  assert.equal((later.graph.match(/tpad=stop_mode=clone:stop_duration=5/g) || []).length, 2);
  assert.ok(later.graph.includes('[1:a]asetpts=PTS-STARTPTS,atrim=duration=10.000'), 'sound from B, cut like B');
  const earlier = compareABGraph({ infos: [a, b], offset: -2, frame: '16:9', fit: 'crop', assName: 'ab.ass', outDir: '.', end: 3 });
  assert.deepEqual(earlier.skips, [2, 0]);
  assert.equal(earlier.span, 3, 'end caps the length');
  assert.ok(!earlier.graph.includes('tpad') && !earlier.graph.includes('[a]'));
  assert.throws(() => compareABGraph({ infos: [a, b], offset: 20, assName: 'ab.ass' }), /do not overlap/);
  const ranged = compareABGraph({ infos: [a, b], offset: 1.5, starts: [3, 0], frame: '16:9', fit: 'letterbox', assName: 'ab.ass', outDir: '.', sound: 0 });
  assert.deepEqual(ranged.seeks, ['3.000', '1.500'], 'an analysis of a range starts at its In point');
  assert.ok(ranged.graph.includes('[0:a]asetpts=PTS-STARTPTS,atrim=duration='));
  const small = { width: 1280, height: 720, hz: 60, duration: 10 };
  const up = compareABGraph({ infos: [small, a], offset: 0, frame: '21:9', fit: 'letterbox', size: '2160', upscaler: 'sharp', assName: 'ab.ass', outDir: '.' });
  assert.ok(up.upscaled && /\[0:v\].*cas=0\.4/.test(up.graph.split(';')[1]), 'the upscaler applies to a pane bigger than its source');
});

test('the encoder switches to HEVC above 4096 px on the GPU, x264 takes any width', () => {
  const q = { crf: 16, cq: 22 };
  assert.equal(videoArgs('gpu', 3840, 2160, q).codec, 'h264');
  assert.ok(videoArgs('gpu', 3840, 2160, q).args.includes('h264_nvenc'));
  const wide = videoArgs('gpu', 5120, 2160, q);
  assert.equal(wide.codec, 'hevc');
  assert.ok(wide.args.includes('hevc_nvenc') && wide.args.includes('hvc1'));
  assert.ok(videoArgs('cpu', 5120, 2160, q).args.includes('libx264'));
  assert.throws(() => videoArgs('gpu', 10240, 4320, q), /wider than NVENC allows/);
});

for (const [frame, fit] of [['16:9', 'letterbox'], ['16:9', 'crop'], ['21:9', 'letterbox'], ['21:9', 'crop'], ['21:9', 'below']]) {
  test(`A/B ${frame} ${fit}: every label and graph stays above the bottom 8 %`, () => {
    const { ass, events, H } = abEvents({ frame, fit });
    assert.ok(!/NaN|undefined|Infinity|null/.test(ass), 'no stray values');
    assertSafe(events, H, `${frame} ${fit}`);
    assert.ok(ass.includes('PS5 Pro') && ass.includes('4aLse Benchmarks'));
    assert.equal(findText(events, 1, /^AVG /).length, 2, 'one live box per video');
  });
}

test('FPS graph: the target sits at 21.9 % and half of it at 93.75 % of the graph', () => {
  const { events } = abEvents();
  const k = 1.5, top = 16 + 1.3 * 18 + 4, h = 110; // 16:9 letterbox: the FPS block in A's top band
  const label = (s) => events.find((e) => !e.drawing && e.plain === s && e.pos[0] < 960);
  const at = (e) => e.pos[1] / k - 0.65 * 18; // labels are centred on their line: baseline 0.375 em under it, then the descent
  assert.ok(Math.abs((at(label('60')) - top) / h - ab.FPS_TOP) < 0.002, `60 at ${(at(label('60')) - top) / h}`);
  assert.ok(Math.abs((at(label('30')) - top) / h - ab.FPS_HALF) < 0.002, `30 at ${(at(label('30')) - top) / h}`);
  // At a 30 fps target the same places hold 30 and 15.
  const thirty = abEvents({ panes: [locked(300, 2, 30), locked(300, 2, 30)] }).events;
  assert.ok(thirty.some((e) => e.plain === '15') && thirty.some((e) => e.plain === '133.3' || e.plain === '100'), '30 fps scales');
  // The played part is revealed by a clip that grows over the clip; the playhead moves with it.
  const played = events.filter((e) => /\\t\(0,6000,\\clip/.test(e.text));
  assert.equal(played.length, 2);
  assert.equal(events.filter((e) => e.moving && /\\move\([\d.]+,[\d.]+,[\d.]+,[\d.]+,0,6000\)/.test(e.text)).length, 2, 'two playheads');
});

test('live box: numbers coloured by their share of the target', () => {
  const base = summarise(locked(), { width: 1920, height: 1080 });
  const sums = [{ ...base, avg_fps: 59.5, low_1pct_fps: 51.8 }, { ...base, avg_fps: 58.0, low_1pct_fps: 42.1, hitches: { count: 7 } }];
  const { events } = abEvents({ sums, panes: [locked(), locked(600, 1, 60)] });
  const [a, b] = findText(events, 1, /^AVG /).sort((x, y) => x.pos[0] - y.pos[0]);
  assert.equal(a.plain, 'AVG 59.5 · 1% 51.8 · 0 HITCHES');
  assert.equal(b.plain, 'AVG 58.0 · 1% 42.1 · 7 HITCHES');
  const nums = (e) => [...e.text.matchAll(/\\c&H([0-9A-F]{8})\}([\d.]+)/g)].map((m) => [m[2], m[1]]);
  assert.deepEqual(nums(a), [['59.5', WHITE], ['51.8', AMBER], ['0', WHITE]]);
  assert.deepEqual(nums(b), [['58.0', WHITE], ['42.1', RED], ['7', WHITE]]);
  // The hero reads the last half second: a locked 48 fps clip is amber (80 % of 60).
  const amber = abEvents({ panes: [analyse(rowsFromCounts(Array.from({ length: 480 }, (_, i) => (i % 4 === 3 ? 2 : 1))), HZ, 0.4, 60), locked()] }).events;
  const hero = findText(amber, 3, /^\d+ FPS$/).sort((x, y) => x.pos[0] - y.pos[0])[0];
  assert.equal(hero.plain, '48 FPS');
  assert.ok(hero.colors[0] === AMBER);
});

test('a hitch shows a red tag for a second and a capped spike in the frame times', () => {
  const { events } = abEvents();
  const tag = events.filter((e) => e.plain === 'HITCH · 200 ms');
  assert.equal(tag.length, 1);
  assert.deepEqual([tag[0].start, tag[0].end], [2, 3]);
  assert.ok(events.some((e) => e.drawing && e.colors.includes(RED) && e.start === 2 && e.end === 3), 'red pill behind it');
  const cap = events.filter((e) => e.plain === '▲ 200 ms');
  assert.equal(cap.length, 1, 'the 200 ms spike is over the 66.7 ms scale');
  assert.ok(cap[0].moving && /\\clip\(/.test(cap[0].text));
  assert.ok(Math.abs(cap[0].start - 2) < 0.011, 'appears with the spike, as the frame starts');
  assert.equal(findText(events, 2.5, /^\d+ FPS$/).length, 2, 'hitches are play: the hero stays');
});

test('a load replaces the live number with LOADING and is a band in both graphs, never 0 fps', () => {
  const { events } = abEvents();
  const word = events.filter((e) => e.plain === 'LOADING' && !e.moving);
  const box = word.find((e) => e.start === 3.2 && e.pos[0] < 1100);
  assert.ok(box && box.end === 4.7, 'LOADING for the whole load');
  assert.ok(events.some((e) => e.plain === '1.5 s · not counted' && e.start === 3.2 && e.end === 4.7));
  const heroes = findText(events, 4, /^\d+ FPS$/);
  assert.equal(heroes.length, 1, 'only A shows a number during B\'s load');
  assert.equal(findText(events, 4, /^AVG /).length, 1, 'B\'s summary line gives way too');
  assert.equal(findText(events, 5, /^\d+ FPS$/).length, 2, 'back after the load');
  assert.ok(word.some((e) => e.start === 0 && e.end === 6), 'the FPS graph labels the load band');
  // The frame-time graph names the load in its header row (one word beside the watermark), held at the row's
  // right end while the band comes in, then riding the band's left edge out.
  const head = 552 * 1.5; // the top of the 'FRAME TIME · ms' row
  const ftLabels = abEvents({ span: 8, endCard: false }).events.filter((e) => e.plain === 'LOADING' && e.pos[0] > 960 && Math.abs(e.pos[1] - head) < 1);
  const pinned = ftLabels.find((e) => !e.moving), riding = ftLabels.find((e) => e.moving);
  assert.ok(pinned && pinned.start === 3.2, `pinned from the load's start: ${pinned && pinned.start}`);
  assert.ok(riding && riding.start === pinned.end && Math.abs(/\\move\(([\d.]+)/.exec(riding.text)[1] - pinned.pos[0]) < 0.11, 'then moves on from there');
  const bandLeft = (t) => (640 + 24 + 584 - 56) * 1.5 - (t - 3.2) * (584 - 56) / 10 * 1.5;
  assert.ok(Math.abs(bandLeft(riding.start) - pinned.pos[0]) < 1.5, 'once the band reaches it');
  assert.ok(/\\clip\(/.test(riding.text), 'and slides out under the header text, not over it');
  // A calm scene (small diffs) then a 1 s hold: a menu or a held shot.
  const calm = rowsFromCounts([...Array(60).fill(1), 60, ...Array(60).fill(1)]).map((r) => [r[0], r[1] === 10 ? 0.5 : r[1], r[2], r[3]]);
  const still = abEvents({ panes: [analyse(calm, HZ, 0.4, 60), locked()], span: 3 }).events;
  assert.ok(still.some((e) => e.plain === 'STILL'), 'a hold after a calm scene reads STILL');
});

test('the end card follows the clip for 5 s with the verdict and who is better', () => {
  const { events } = abEvents();
  const card = events.filter((e) => e.start === 6 && e.end === 11);
  assert.ok(card.length > 20);
  assert.ok(card.some((e) => e.plain === 'RESULT · Forza Horizon 6 · Performance'));
  assert.ok(card.some((e) => /^PS5 Pro$/.test(e.plain)) && card.some((e) => e.plain === 'BETTER'));
  // Both are unlocked (60 on 60 Hz), so missed target takes pacing's row.
  for (const s of ['Average', '1% low', '0.1% low', 'Hitches', 'Missed target', 'Numbers cover the 0:06 shown · stills and loading screens not counted', '4aLse Benchmarks']) {
    assert.ok(card.some((e) => e.plain === s), s);
  }
  assert.ok(!card.some((e) => e.plain === 'Pacing' || e.plain === '–'), 'no row of dashes');
  assert.ok(card.some((e) => e.plain === 'A 1 fewer'), 'A has no hitch, B one');
  // The verdict names the videos by their titles, as the window does.
  assert.ok(card.some((e) => /^PS5 Pro /.test(e.plain)) && !card.some((e) => /^[AB] (holds|stays|averages)/.test(e.plain)), 'titles in the verdict');
  assertSafe(card, 1080, 'end card');
  assert.equal(abEvents({ endCard: false }).events.filter((e) => e.start >= 6).length, 0);
});

test('pacing on the end card: as the window shows it, missed target instead when a side is unlocked', () => {
  const s = (even, missed = 1.2) => ({ avg_fps: 59, low_1pct_fps: 50, low_0_1pct_fps: 45, hitches: { count: 0 }, target_fps: 60, frames_missing_target_pct: missed, pacing: { even_pct: even, holds: { 1: 90, 2: 10 } } });
  const last = (a, b) => ab.abRows(a, b)[4];
  assert.deepEqual(last(s(null, 0.4), s(null, 2.13)), ['Missed target', '0.4%', '2.1%', 0xF5F6F8, 0xF5F6F8, { side: 0, text: 'A −1.7' }]);
  assert.equal(last(s(null), s(97))[0], 'Missed target');
  assert.deepEqual(last(s(null), s(null))[5], { side: null, text: 'Even' });
  assert.deepEqual(last(s(97), s(88)).slice(0, 3).concat(last(s(97), s(88))[5]), ['Pacing', '97%', '88%', { side: 0, text: 'A +9 pts' }]);
});

test('verdict: plain English, by fps at the same target and by share of target otherwise', () => {
  const s = (avg, low, hitches, target = 60) => ({ avg_fps: avg, low_1pct_fps: low, hitches: { count: hitches }, target_fps: target });
  assert.equal(ab.verdict(s(59.5, 51.8, 2), s(58.0, 42.1, 7)), "A holds 60 fps almost everywhere. B runs 1.5 fps lower and hitches 7 times to A's 2.");
  assert.equal(ab.verdict(s(58.0, 42.1, 7), s(59.5, 51.8, 2)), "B holds 60 fps almost everywhere. A runs 1.5 fps lower and hitches 7 times to B's 2.");
  assert.equal(ab.verdict(s(55, 50, 1), s(50, 35, 3)), "A stays close to 60 fps, averaging 55.0. B runs 5.0 fps lower and hitches 3 times to A's 1.");
  // A 1% low in the red is not "close to 60", whatever the average.
  assert.equal(ab.verdict(s(58.7, 30, 0), s(56.1, 30, 3)), 'A averages 58.7 fps against a 60 fps target. B runs 2.6 fps lower and hitches 3 times while A has none.');
  assert.equal(ab.verdict(s(59.8, 55, 1), s(58.4, 50, 0), ['S', 'A']), 'S holds 60 fps almost everywhere. A runs 1.4 fps lower, but never hitches (S hitches 1 time).');
  assert.equal(ab.verdict(s(60, 59, 0), s(60, 58, 0)), 'A holds 60 fps almost everywhere. B matches it on average, and neither hitches.');
  assert.equal(ab.verdict(s(59.8, 55, 3), s(59, 50, 1)), "A holds 60 fps almost everywhere. B runs 0.8 fps lower, but hitches only 1 time to A's 3.");
  assert.equal(ab.verdict(s(59.7, 51.6, 0), s(29.9, 24.3, 0, 30)), 'Both hold their targets; A is steadier, 1% low 86 % of target vs 81 %.');
  assert.equal(ab.verdict(s(59.7, 51.6, 0), s(25, 20, 0, 30)), 'A holds its 60 fps target; B averages 83 % of its 30 fps target.');
  assert.equal(ab.verdict(s(50, 40, 0), s(25, 20, 0, 30), ['PS5', 'Switch 2']), 'Neither holds its target: PS5 averages 83 % of its 60 fps target, Switch 2 averages 83 % of its 30 fps target.');
});

test('bands: the video in a pane, numbers in the side panel, nothing in the bottom 8 %', () => {
  const a = eventful(), capture = { width: 1920, height: 1080, hz: 60 };
  for (const [frame, res, W] of [['16:9', '1080', 1920], ['16:9', '1440', 2560], ['21:9', '1080', 2560], ['21:9', '2160', 5120]]) {
    const size = sizeFor(capture, { style: 'bands', frame, resolution: res });
    assert.equal(size.width, W, `${frame} ${res}`);
    const ov = createOverlay(a, size, 'Forza Horizon 6', 30, 'right', capture, { style: 'bands', frame, subtitle: 'PS5 Pro · Performance' });
    assert.equal(ov.constructor.name, 'BandsOverlay');
    const ass = ov.build(), events = parse(ass), k = size.height / 720;
    assert.ok(!/NaN|undefined|Infinity|null/.test(ass), `${frame}: no stray values`);
    assertSafe(events, size.height, `bands ${frame} ${res}`);
    const wide = frame === '21:9', hx = (wide ? 1306 : 982) * k, hy = ((wide ? 174 : 150.3) + 0.275 * (wide ? 84 : 72)) * k;
    const hero = active(events, 1).filter((e) => e.pos && Math.abs(e.pos[0] - hx) < 0.11 && Math.abs(e.pos[1] - hy) < 0.11);
    assert.equal(hero.length, 1, `${frame}: one hero`);
    assert.equal(hero[0].plain, '60 FPS');
    assert.equal(active(events, 4).filter((e) => Math.abs(e.pos[0] - hx) < 0.11 && Math.abs(e.pos[1] - hy) < 0.11 && /FPS$/.test(e.plain)).length, 0, 'no number during the load');
    for (const s of ['AVG', '1% LOW', '0.1% LOW', 'HITCHES', 'FRAME TIME · ms', 'FPS', 'Forza Horizon 6', 'PS5 Pro · Performance', '4aLse Benchmarks', 'HITCH']) {
      if (s !== 'HITCH') assert.ok(events.some((e) => e.plain === s), `${frame}: ${s}`);
    }
    assert.equal(events.some((e) => e.plain === 'LONGEST') && events.some((e) => e.plain === 'MISSED'), wide, `${frame}: six stats only on 21:9, missed target for pacing when unlocked`);
    assert.ok(events.some((e) => e.plain === '▲ 200 ms'), 'capped spike');
  }
  const filter = overlayFilter('overlay.ass', path.resolve('F:/clips/run_fps'), sizeFor(capture, { style: 'bands', frame: '16:9', resolution: '1080' }));
  assert.ok(filter.startsWith('scale=1440:810:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad=1440:810:(ow-iw)/2:(oh-ih)/2:black,pad=1920:1080:0:0:black,ass='), filter);
  const wide = sizeFor(capture, { style: 'bands', frame: '21:9', resolution: '2160' });
  assert.deepEqual([wide.pane.w, wide.pane.h, wide.scaled], [3840, 2160, true]);
});

test('a bands preview freezes the growing clip of the played FPS line', () => {
  const a = locked(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capfps-bands-'));
  try {
    const size = sizeFor({ width: 1920, height: 1080 }, { style: 'bands', frame: '16:9', resolution: '1080' });
    const file = createOverlay(a, size, 'x', 30, 'right', { width: 1920, height: 1080 }, { style: 'bands' }).writeTo(path.join(dir, 'p.ass'), { at: 5 });
    const clipOf = (e) => (/\\clip\(([\d,]+)\)/.exec(e.text) || [null, ''])[1].split(',').map(Number);
    // The FPS graph's line is in the side panel, above the frame-time band (y 810 px at 1080p).
    const played = parse(fs.readFileSync(file, 'utf8')).filter((e) => e.drawing && clipOf(e).length === 4 && clipOf(e)[3] < 810);
    assert.equal(played.length, 1);
    assert.ok(!/\\t\(/.test(played[0].text), 'no animation left');
    const [x0, , x1] = clipOf(played[0]);
    const left = 982 * 1.5, right = (982 + 276 - 28) * 1.5;
    assert.ok(Math.abs(x1 - (left + (right - left) / 2)) <= 1, `clip edge at the playhead: ${x1}`);
    assert.ok(x0 < left);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('abData: play FPS leaves loads out, stills and loads merged as the export labels them; old folders are refused', async () => {
  const a = eventful(), dir = fixtureDir(a);
  try {
    const d = ab.abData(dir);
    assert.equal(d.playFps.length, d.perSecond.length);
    assert.deepEqual([d.playFps[3][1], d.playFps[4][1]], [null, null], 'seconds mostly inside the load have no play FPS, not a drop');
    assert.ok(Math.abs(d.playFps[1][1] - 60) < 0.01 && Math.abs(d.playFps[6][1] - 60) < 0.5);
    assert.ok(d.perSecond[3][1] < 30, 'the raw count does drop there');
    // Short stills close together are one span, as on the video.
    const st = { starts: [0, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 3], frameMs: [1000, 100, 100, 100, 100, 100, 1500, 16.7], kind: ['ok', 'static', 'static', 'static', 'static', 'static', 'ok', 'ok'] };
    const held = new ab.BandsOverlay({ ...a, ...st, holds: [] }, { width: 1920, height: 1080 }, 'x', 30, 'right', {}, {}).holdSpans();
    assert.deepEqual(held.map((h) => [h.t0, Math.round(h.t1 * 1000) / 1000, h.kind]), [[1, 1.5, 'static']]);
    fs.writeFileSync(path.join(dir, 'frames.csv'), 'frame,start_s,frame_time_ms\n0,0,16.7\n');
    await assert.rejects(ab.loadAnalysis(dir), /frames\.csv in .* is from an older version\. Analyse that video again\./);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compareABGraph: the faster clip sets the frame rate, sizes are checked, the sound lasts through the end card', () => {
  const a = { width: 1280, height: 720, hz: 30, duration: 10 }, b = { width: 1920, height: 1080, hz: 60, duration: 10 };
  for (const infos of [[a, b], [b, a]]) {
    const g = compareABGraph({ infos, offset: 0, frame: '16:9', fit: 'letterbox', assName: 'ab.ass', outDir: '.', endCard: true, sound: 0 });
    assert.ok(g.graph.includes('color=c=black:s=1920x1080:r=60:d=15.000[bg]'), 'B at 60 is not cut to A\'s 30');
    assert.ok(g.graph.includes('apad=whole_dur=15.000[a]'), 'silence under the end card');
  }
  assert.throws(() => compareABGraph({ infos: [b, b], frame: '21:9', size: '1440', assName: 'ab.ass' }), /Size 1440 is not available for 21:9 \(1080 or 2160\)/);
});

test('an end card at a size above the recording keeps its hold in front of the upscale', () => {
  const capture = { width: 1920, height: 1080 };
  for (const up of ['lanczos', 'sharp', 'fsrcnnx']) {
    const f = overlayFilter('overlay.ass', path.resolve('F:/clips/run_fps'), sizeFor(capture, { resolution: '2160' }), up, true);
    assert.ok(f.startsWith('tpad=stop_mode=clone:stop_duration=') && /,(scale=|libplacebo=w=)3840/.test(f), `${up}: ${f}`);
  }
});

test('mixed targets: running over a target is not better than holding it, and the gap is from the shown numbers', () => {
  const s = (avg, low, low01, target, hitches = 0) => ({ avg_fps: avg, low_1pct_fps: low, low_0_1pct_fps: low01, hitches: { count: hitches }, target_fps: target, pacing: { even_pct: null } });
  const rows = ab.abRows(s(56.9, 50, 40, 60), s(47.6, 15, 10, 30));
  assert.deepEqual(rows[0][5], { side: 1, text: 'B +5 pts' }, '95 % against 100 %, not 159 %');
  assert.equal(rows[1][5].side, 0, '1% low: A 83 % beats B 50 %');
  assert.equal(ab.verdict(s(56.9, 50, 40, 60), s(47.6, 15, 10, 30)),
    'B holds its 30 fps target; A averages 95 % of its 60 fps target. B runs well above its 30 fps target; check the target setting.');
  const same = ab.abRows(s(60, 59, 30.04, 60), s(59, 50, 4.05, 60));
  assert.deepEqual(same[2].slice(1, 3).concat(same[2][5].text), ['30.0', '4.0', 'A +26.0']);
});

test('frame times: capped markers never overlap, long frames are steps, cut frames keep their height', () => {
  // 433 ms and 250 ms spikes 1 s apart, then a 133 ms one: closer than a marker is wide.
  const counts = [...Array(120).fill(1), 26, ...Array(60).fill(1), 15, ...Array(30).fill(1), 8, ...Array(200).fill(1)];
  const a = analyse(rowsFromCounts(counts), HZ, 0.4, 60);
  const { events, W } = abEvents({ panes: [a, a], span: 10, endCard: false });
  const caps = events.filter((e) => /^▲ \d+ ms$/.test(e.plain) && e.pos[0] < W / 2);
  // The red pills behind the markers, where each is at time t: no two overlap.
  const pills = events.filter((e) => e.drawing && e.moving && e.layer === 3 && e.colors.includes(RED) && e.pos[0] < W / 2);
  const xAt = (e, t) => {
    const m = /\\move\(([-\d.]+),[-\d.]+,([-\d.]+),[-\d.]+,0,(\d+)\)/.exec(e.text);
    return Number(m[1]) + (Number(m[2]) - Number(m[1])) * Math.min(1, ((t - e.start) * 1000) / Number(m[3]));
  };
  const wOf = (e) => Math.max(...(e.text.replace(/\{[^}]*\}/g, ' ').match(/-?\d+(\.\d+)?/g) || []).map(Number).filter((_, i) => i % 2 === 0));
  assert.equal(pills.length, caps.length);
  for (let t = 0; t < 10; t += 0.05) {
    const on = active(pills, t).map((e) => [xAt(e, t), xAt(e, t) + wOf(e)]).sort((p, q) => p[0] - q[0]);
    for (let i = 1; i < on.length; i++) assert.ok(on[i][0] >= on[i - 1][1], `markers overlap at ${t.toFixed(2)}: ${JSON.stringify(on)}`);
  }
  assert.ok(caps.some((e) => e.plain === '▲ 433 ms'), 'the biggest stays');
  // A cut at the start keeps the frame's own time for the graph.
  const cut = ab.shiftAnalysis(locked(), 0.3 + 0.0165, 5);
  assert.ok(cut.frameMs[0] < 1 && Math.abs(cut.shownMs[0] - 16.67) < 0.01);
});

test('the live number follows a hitch while its frame is on screen', () => {
  const { events } = abEvents();
  const heroB = (t) => findText(events, t, /^\d+ FPS$/).sort((x, y) => x.pos[0] - y.pos[0])[1];
  assert.equal(heroB(1.9).plain, '60 FPS');
  assert.ok(Number(heroB(2.15).plain.split(' ')[0]) < 57, `drops during the 200 ms hitch: ${heroB(2.15).plain}`);
});

test('the numbers on an A/B video cover the overlap it shows, not the whole recordings', () => {
  const dir = fixtureDir(eventful());
  try {
    assert.equal(ab.overlapSummary(dir, 0, 1.9).hitches.count, 0, 'the hitch at 2 s is after the shown part');
    assert.equal(ab.overlapSummary(dir, 0, 6).hitches.count, 1);
    const late = ab.overlapSummary(dir, 2.5, 3);
    assert.deepEqual([late.hitches.count, late.loading.count, late.capture.seconds], [0, 1, 3]);
    assert.ok(Math.abs(late.avg_fps - 60) < 0.5, `play FPS leaves the load out: ${late.avg_fps}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('live box and bands panel colour a number as it is printed', () => {
  const base = summarise(locked(), { width: 1920, height: 1080 });
  const { events } = abEvents({ sums: [{ ...base, avg_fps: 56.96, low_1pct_fps: 47.96 }, base] });
  const a = findText(events, 1, /^AVG /).sort((x, y) => x.pos[0] - y.pos[0])[0];
  const nums = [...a.text.matchAll(/\c&H([0-9A-F]{8})\}([\d.]+)/g)].map((m) => [m[2], m[1]]);
  assert.deepEqual(nums.slice(0, 2), [['57.0', WHITE], ['48.0', AMBER]], '95.0 % and 80.0 % as shown');
});

test('frame times: a run of stills is one band, the spike rises as its frame starts, names sit above the plot', () => {
  // 1 s calm, four 200 ms stills one frame apart, 2 s calm: one span in both graphs.
  const counts = [...Array(60).fill(1), 12, 1, 12, 1, 12, 1, 12, ...Array(120).fill(1)];
  const calm = rowsFromCounts(counts).map((r) => [r[0], r[1] === 10 ? 0.5 : r[1], r[2], r[3]]);
  const still = abEvents({ panes: [analyse(calm, HZ, 0.4, 60), locked()], span: 4, endCard: false }).events;
  const bands = still.filter((e) => e.drawing && e.moving && e.layer === 1 && e.pos[0] < 960);
  assert.equal(bands.length, 1, `one dimmed band, not ${bands.length} slivers`);
  assert.ok(Math.abs(bands[0].start - 1) < 0.011);
  // The hitch's step comes in at 2.0 s, when the frame starts, already at the top of the scale.
  const { events } = abEvents();
  const step = events.filter((e) => e.drawing && e.moving && e.layer === 2 && e.pos[0] > 960 && Math.abs(e.start - 2) < 0.006);
  assert.equal(step.length, 1);
  assert.ok(step[0].yMin < 20, `the step starting at 2.0 s is the spike: top ${step[0].yMin}`);
  // The load's name is above the plots in both graphs: never over the ▲ markers or the line.
  const cap = events.find((e) => e.plain === '▲ 200 ms'), name = events.find((e) => e.plain === 'LOADING' && e.start === 3.2 && e.pos[1] > 800);
  assert.ok(name.pos[1] + 18 * 1.5 <= cap.pos[1], `${name.pos[1]} above ${cap.pos[1]}`);
  const word = events.find((e) => e.plain === 'LOADING' && e.start === 0 && e.pos[0] > 960);
  assert.ok(word.pos[1] < (16 + 1.3 * 18 + 4) * 1.5, `above B's FPS plot: ${word.pos[1]}`);
});

test('a bands preview freezes events that glide off the left edge too', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capfps-bands-'));
  try {
    const size = sizeFor({ width: 1920, height: 1080 }, { style: 'bands', frame: '16:9', resolution: '1080' });
    const file = createOverlay(eventful(), size, 'x', 30, 'right', { width: 1920, height: 1080 }, { style: 'bands' }).writeTo(path.join(dir, 'p.ass'), { at: 6 });
    const ass = fs.readFileSync(file, 'utf8');
    assert.ok(/▲ 200 ms/.test(ass), 'the spike marker is on screen at 6 s');
    assert.ok(!/\move\(/.test(ass), 'every moving event frozen');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a very short range counts cut frames by the part shown: no average past the frame rate, no lows from slivers', () => {
  // 30 fps (2 refreshes per frame); 0.07 s from 0.01 s cuts a frame at each end.
  const s = summarise(ab.shiftAnalysis(locked(600, 2, 30), 0.01, 0.07), { width: 1920, height: 1080 });
  assert.ok(s.avg_fps <= 30.01, `avg ${s.avg_fps}`);
  assert.ok(Math.abs(s.avg_fps - 30) < 0.5, `avg ${s.avg_fps}`);
  assert.ok(s.low_1pct_fps <= 30.01, `1% low ${s.low_1pct_fps}`);
});

test('a cut on a whole or half second keeps no rounding sliver of the frame before it', () => {
  // Locked 120 fps as frames.csv has it: starts to 0.1 ms, frame times to 0.01 ms, so frame 59 ends 0.03 ms past 0.5 s.
  const starts = Array.from({ length: 600 }, (_, i) => Math.round(i / 120 * 1e4) / 1e4);
  const a = { starts, frameMs: starts.map(() => 8.33), holdRefreshes: starts.map(() => 1), kind: starts.map(() => 'ok'),
    hz: 120, target: 120, kRef: 1, duration: 5, holds: [], droppedAt: [], tears: [] };
  for (const cut of [0.5, 1]) {
    const sh = ab.shiftAnalysis(a, cut, 2);
    assert.equal(sh.starts.length, 240, `cut at ${cut}: 2 s of 120 fps`);
    assert.ok(ab.liveFps(sh).every((v) => v == null || v <= 120), `cut at ${cut}: live ${ab.liveFps(sh)}`);
  }
  // The end too: frame 121 starts at 1.008333 s, written 1.0083, just inside a span of 121/120 s.
  assert.equal(ab.shiftAnalysis(a, 0, 121 / 120).starts.length, 121);
});

test('right after a load the live number comes back without a flash of a dash', () => {
  const { events } = abEvents(); // B loads from 3.2 to 4.7 s
  for (let t = 4.7; t < 5.5; t += 0.02) assert.equal(findText(events, t, /^– FPS$/).length, 0, `– FPS at ${t.toFixed(2)}`);
  assert.equal(findText(events, 5.4, /^\d+ FPS$/).length, 2, 'both numbers are back');
});

test('crop layouts: the two name panels are as tall as each other when one subtitle needs two lines', () => {
  for (const frame of ['16:9', '21:9']) {
    const { events, W } = abEvents({ frame, fit: 'crop', subs: ['Forza Horizon 6 · Performance mode with ray tracing', 'PS5'] });
    // Each side's name panel: the dark box at the top whose left edge is nearest the side's left.
    const pts = (e) => (e.text.replace(/\{[^}]*\}/g, ' ').match(/-?\d+(\.\d+)?/g) || []).map(Number);
    const panels = events.filter((e) => e.drawing && !e.moving && e.layer === 0 && e.start === 0 && e.yMin < 60).map((e) => {
      const p = pts(e), xs = p.filter((_, i) => i % 2 === 0);
      return { x: Math.min(...xs), bottom: e.yMax };
    });
    const boxes = [0, 1].map((side) => panels.filter((b) => b.x >= side * W / 2 && b.x < side * W / 2 + 100)[0]);
    assert.ok(boxes[0] && boxes[1], `${frame}: both panels found`);
    assert.equal(boxes[0].bottom, boxes[1].bottom, `${frame}: same height`);
  }
});
