'use strict';
// Edit & export: the project model, one analysis per track on the output clock, the filter graph
// and the three-up overlay, from synthetic analyses saved to temp folders.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { analyse, summarise, writeCsvs, isPlay } = require('../src/core/analysis');
const { assColor } = require('../src/core/overlay');
const ab = require('../src/core/compare-ab');
const tl = require('../src/core/timeline');
const { timelineGraph, timelineOverlay, videoArgs, QUALITY, compareABGraph, freeName } = require('../src/core/pipeline');

const HZ = 60;
function rowsFromCounts(counts, blackAt = -1) {
  const rows = [];
  let i = 0;
  counts.forEach((c, f) => {
    for (let r = 0; r < c; r++, i++) rows.push([i / HZ, i === 0 ? Infinity : r === 0 ? 10 : 0.05, r === 0 ? 100 : 5, f === blackAt && r === 0 ? 5 : 100]);
  });
  return rows;
}
// 2 s at 60, a 200 ms hitch, 1 s at 60, a 1.5 s load, then 3.3 s at 60 (6.37 s).
const EVENTFUL = [...Array(120).fill(1), 12, ...Array(60).fill(1), 90, ...Array(200).fill(1)];

const dirs = [];
function saved(a, startS = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capfps-tl-'));
  writeCsvs(a, dir);
  const s = summarise(a, { width: 1920, height: 1080 });
  s.capture.start_s = startS;
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(s));
  dirs.push(dir);
  return dir;
}
const LOCKED = saved(analyse(rowsFromCounts(Array(600).fill(1)), HZ, 0.4, 60));        // 10 s at 60
const EVENT = saved(analyse(rowsFromCounts(EVENTFUL, 181), HZ, 0.4, 60));               // hitch 2.0, load 3.2-4.7
const THIRTY = saved(analyse(rowsFromCounts(Array(300).fill(2)), HZ, 0.4, 30));         // 10 s at 30
const LATE = saved(analyse(rowsFromCounts(Array(300).fill(1)), HZ, 0.4, 60), 20);       // 5 s analysed from 0:20
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const clip = (outDir, inS, outS, at, more = {}) => ({ video: path.join(outDir, 'Forza Horizon 6.mp4'), outDir, in: inS, out: outS, at, ...more });
const two = (more = {}) => ({ tracks: [{ clips: [clip(LOCKED, 0, 6, 0)] }, { clips: [clip(EVENT, 0, 6, 0)] }], ...more });
const three = (more = {}) => ({
  tracks: [
    { title: 'Quality', clips: [clip(LOCKED, 0, 3, 0), clip(LOCKED, 5, 8, 3)] },
    { title: 'Performance', clips: [clip(EVENT, 0, 6, 0)] },
    { title: 'Ray Tracing', clips: [clip(THIRTY, 0, 2, 0), clip(THIRTY, 4, 6, 3.5)] },
  ],
  frame: '21:9', fit: 'third', ...more,
});

test('normaliseProject fills the defaults', () => {
  const p = tl.normaliseProject(two());
  assert.deepEqual([p.frame, p.fit, p.size, p.sound, p.endCard, p.encoder], ['16:9', 'letterbox', '1080', 0, true, 'gpu']);
  assert.deepEqual(p.range, { in: 0, out: 6 }, 'to the end of the shortest track');
  assert.equal(p.tracks[0].title, 'Forza Horizon 6', 'title from the first clip\'s file name');
  assert.deepEqual([p.tracks[0].clips[0].pan, p.tracks[0].clips[0].zoom], [0, 1]);
  const one = { clips: [{ video: 'x.mp4', outDir: LOCKED }] };
  const t = tl.normaliseProject({ tracks: [one, one, one] });
  assert.deepEqual([t.frame, t.fit, t.tracks[0].clips[0].in], ['21:9', 'third', 0]);
  assert.ok(Math.abs(t.tracks[0].clips[0].out - 10) < 0.001, 'a clip without in/out takes the whole analysis');
});

test('normaliseProject says plainly what is wrong', () => {
  const bad = (p, re) => assert.throws(() => tl.normaliseProject(p), re);
  bad({ tracks: [{ clips: [clip(LOCKED, 0, 4, 0), clip(LOCKED, 5, 8, 3)] }, { clips: [clip(EVENT, 0, 6, 0)] }] }, /Clips A1 and A2 on track A overlap by 1\.00 s/);
  bad({ tracks: [{ clips: [clip(LOCKED, 0, 4, 0)] }, { clips: [clip(EVENT, 0, 3, 0), clip(THIRTY, 0, 3, 3)] }] }, /Track B mixes 30 and 60 fps targets — put them on separate tracks/);
  bad(three({ fit: 'crop' }), /Three tracks need the 21:9 frame/);
  bad(three({ frame: '16:9' }), /Three tracks need the 21:9 frame/);
  bad(two({ frame: '21:9', fit: 'third' }), /needs a third track/);
  bad(two({ fit: 'below' }), /Data below needs the 21:9 frame/);
  bad({ tracks: [{ clips: [clip(LOCKED, 0, 12, 0)] }, { clips: [clip(EVENT, 0, 6, 0)] }] }, /A1 uses 0:00\.00 to 0:12\.00 .* only 0:00\.00 to 0:10\.00 was analysed/);
  bad({ tracks: [{ clips: [clip(LATE, 10, 22, 0)] }, { clips: [clip(EVENT, 0, 6, 0)] }] }, /only 0:20\.00 to 0:25\.00 was analysed/, 'source time = analysis time + start_s');
  bad(two({ range: { in: 2, out: 2.03 } }), /export range .* is empty/);
  bad({ tracks: [{ clips: [clip(LOCKED, 0, 6, 0)] }, { clips: [clip(EVENT, 0, 6, 0)] }, { clips: [clip(LOCKED, 0, 4, 7)] }], frame: '21:9', fit: 'third', range: { in: 0, out: 6 } },
    /Track C has no video inside the export range — move its clips or the range/, 'all gap: no red zeros, no BEST for it');
  bad({ tracks: [{ clips: [] }, { clips: [] }] }, /Add a clip/);
  bad({ tracks: [{ clips: [clip(LOCKED, 0, 4, 0)] }, { clips: [] }] }, /Track B has no clips\. Add a clip to it from Media\./);
  bad(three({ tracks: [...three().tracks.slice(0, 2), { clips: [] }] }), /Track C has no clips\. Add a clip to it from Media or remove the track\./);
  bad({ tracks: [{ clips: Array.from({ length: 65 }, (_, i) => clip(LOCKED, 0, 0.1, i * 0.1)) }, { clips: [clip(EVENT, 0, 6, 0)] }] }, /up to 64 clips; this one has 66/);
  bad({ tracks: [{ clips: [clip(LOCKED, 3, 2, 0)] }, { clips: [] }] }, /Out \(0:02\.00\) must be after In/);
  assert.doesNotThrow(() => tl.normaliseProject({ tracks: [{ clips: [clip(LATE, 21, 25, 0)] }, { clips: [clip(EVENT, 0, 6, 0)] }] }));
});

test('trackAnalysis: trims and offsets, gaps at the start, middle and end, the range cut', () => {
  const p = tl.normaliseProject(three({ range: { in: 0, out: 7 } }));
  const c = tl.trackAnalysis(p.tracks[2], null, p.range); // 0-2 from 0, 4-6 at 3.5, so a gap 2-3.5 and 5.5-7
  assert.equal(c.duration, 7);
  const gaps = c.starts.map((s, i) => [s, c.frameMs[i], c.kind[i]]).filter((f) => f[2] === 'gap').map(([s, ms]) => [s, Math.round(ms)]);
  assert.deepEqual(gaps, [[2, 1500], [5.5, 1500]]);
  assert.ok(c.starts.every((s, i) => i === 0 || s >= c.starts[i - 1]), 'in time order');
  assert.equal(c.holds.filter((h) => h.kind === 'gap').length, 2);
  // A gap before the first clip: the range starts before it.
  const late = tl.normaliseProject({ tracks: [{ clips: [clip(LOCKED, 0, 4, 1)] }, { clips: [clip(EVENT, 0, 5, 0)] }], range: { in: 0, out: 5 } });
  const a = tl.trackAnalysis(late.tracks[0], null, late.range);
  assert.deepEqual([a.starts[0], a.kind[0], Math.round(a.frameMs[0])], [0, 'gap', 1000]);
  assert.ok(Math.abs(a.starts[1] - 1) < 1e-9);
  // The summary leaves gaps out like stills and loads.
  const s = summarise(a, {});
  assert.ok(Math.abs(s.avg_fps - 60) < 0.2, `play fps over the clip only: ${s.avg_fps}`);
  assert.equal(s.static_holds.count + s.loading.count + s.hitches.count, 0);
  assert.ok(Math.abs(s.all_frames.avg_fps - 241 / 5) < 0.5, 'with gaps it would be lower');
  assert.equal(isPlay('gap'), false);
  // Range cut: from 1.5, the second clip's source part starts where the range cuts it.
  const cut = tl.trackAnalysis(p.tracks[0], null, { in: 1.5, out: 4.5 });
  assert.equal(cut.duration, 3);
  assert.equal(cut.kind.includes('gap'), false, 'clips touch at 3: no gap');
  assert.ok(Math.abs(cut.starts.filter((x) => x < 1.5 - 1e-9).length - 90) <= 1, 'the last 1.5 s of the first clip');
});

test('trackAnalysis: a hitch cut at a clip edge counts only when it starts inside', () => {
  const at = (inS) => {
    const p = tl.normaliseProject({ tracks: [{ clips: [clip(EVENT, inS, 3, 0)] }, { clips: [clip(LOCKED, 0, 5, 0)] }], range: { in: 0, out: 3 - inS } });
    return summarise(tl.trackAnalysis(p.tracks[0], null, p.range), {}).hitches.count;
  };
  assert.equal(at(1.9), 1);
  assert.equal(at(2.1), 0, 'the 2.0 s hitch began before the cut');
});

test('projectData: per-track numbers over the range, per-clip data on the source clock, the verdict', () => {
  const d = tl.projectData(three({ range: { in: 0, out: 6 } }));
  assert.equal(d.tracks.length, 3);
  assert.deepEqual(d.tracks.map((t) => t.target), [60, 60, 30]);
  assert.deepEqual(d.tracks.map((t) => t.gapS), [0, 0, 2]);
  assert.equal(d.tracks[1].summary.hitches.count, 1);
  assert.deepEqual(d.clips.map((c) => c.map((x) => x.id)), [['A1', 'A2'], ['B1'], ['C1', 'C2']]);
  const a2 = d.clips[0][1];
  assert.deepEqual(a2.playFps.map(([t]) => t), [5, 6, 7], 'seconds 5-7 of the source');
  assert.deepEqual(d.clips[1][0].hitches, [[2, 200]]);
  assert.match(d.verdict, /^Quality and Ray Tracing tie at 100 % of their targets; Performance reaches 9\d %\./);
  assert.match(d.verdict, /Performance hitches most, 1 time\./);
  const lb = d.layoutBoxes;
  assert.deepEqual([lb.width, lb.height, lb.mode, lb.cropping], [2560, 1080, 'cover', true]);
  assert.equal(lb.clips[2].length, 2);
  // Late source with its own analysis start: times are source seconds.
  const late = tl.projectData({ tracks: [{ clips: [clip(LATE, 21, 24, 0)] }, { clips: [clip(EVENT, 0, 3, 0)] }] });
  assert.deepEqual(late.clips[0][0].playFps.map(([t]) => t), [21, 22, 23]);
});

test('layoutBoxes: three even columns that fill 2560 with 2 px seams, the crop window at pan and zoom', () => {
  const p = three();
  p.tracks[1].clips[0].pan = -1;
  p.tracks[2].clips[0].zoom = 1.5;
  const lb = tl.layoutBoxes(tl.normaliseProject(p));
  assert.deepEqual(lb.panes.map((x) => x.w), [854, 852, 854]);
  assert.deepEqual(lb.videos.map((v) => [v.x, v.y, v.w, v.h]), [[0, 108, 854, 720], [856, 108, 850, 720], [1708, 108, 852, 720]]);
  const [a, b, c] = [lb.clips[0][0], lb.clips[1][0], lb.clips[2][0]];
  assert.ok(Math.abs(a.crop.w - 854 / 1280) < 1e-9 && Math.abs(a.crop.x - (1 - 854 / 1280) / 2) < 1e-9, 'centre 2/3 at zoom 1');
  assert.equal(b.crop.x, 0, 'pan -1: the left edge');
  assert.equal(b.picture.x, 856);
  assert.ok(Math.abs(c.crop.h - 1 / 1.5) < 1e-9, 'zoom 1.5 shows 2/3 of the height');
  const fit = tl.layoutBoxes(tl.normaliseProject(two()));
  assert.deepEqual([fit.mode, fit.cropping, fit.clips[0][0].crop], ['fit', false, { x: 0, y: 0, w: 1, h: 1 }]);
  assert.deepEqual(fit.videos[0], { x: 0, y: 270, w: 960, h: 540 }, 'the A/B letterbox pane');
});

test('timelineGraph: one input per clip cut on the input side, black gap segments, end card hold, sound', () => {
  const p = tl.normaliseProject(three({ range: { in: 0, out: 7 }, sound: 2, upscaler: 'lanczos' }));
  const infos = [[{ audioCodec: 'aac' }, { audioCodec: 'aac' }], [{}], [{ audioCodec: 'aac' }, { audioCodec: null }]];
  const g = timelineGraph(p, { infos, assName: 'tl.ass' });
  assert.deepEqual(g.inputs.map((i) => i.args.slice(0, 4)), [['-ss', '0.000', '-t', '3.000'], ['-ss', '5.000', '-t', '3.000'],
    ['-ss', '0.000', '-t', '6.000'], ['-ss', '0.000', '-t', '2.000'], ['-ss', '4.000', '-t', '2.000']]);
  assert.ok(g.graph.includes('[c0][c1][g0_0]concat=n=3:v=1:a=0,trim=duration=7.000,tpad=stop_mode=clone:stop_duration=5[t0]'), 'A: two clips, then black to the end');
  assert.ok(g.graph.includes('[c2][g1_0]concat=n=2:v=1:a=0'), 'B ends at 6');
  assert.ok(g.graph.includes('[c3][g2_0][c4][g2_1]concat=n=4:v=1:a=0'), 'C: gap in the middle and at the end');
  assert.ok(g.graph.includes('color=c=black:s=852x720:r=60:d=1.500,trim=end_frame=90,format=yuv420p,setsar=1[g2_0]'), 'gap the size of C\'s video');
  assert.ok(g.graph.includes('fps=60,setsar=1,format=yuv420p,tpad=stop_mode=clone:stop=1,trim=end_frame=180,setpts=PTS-STARTPTS[c0]'), 'a clip, as many frames as it lasts');
  assert.ok(g.graph.includes('color=c=black:s=2560x1080:r=60:d=12.000[bg]'));
  assert.ok(/\[o1\]\[t2\]overlay=1708:108,split\[op\]\[oe\];\[op\]trim=end_frame=420,setparams=colorspace=bt709:[^,]*,ass=tl\.ass\[oplay\]/.test(g.graph), 'drawn with BT.709 maths, as the file is labelled');
  // The end card does not move: drawn on one frame (retimed to 9.5 s, inside the card) and held for 5 s.
  assert.ok(/\[oe\]trim=start_frame=420:end_frame=421,setpts=9\.500\/TB,setparams=[^,]*,ass=tl\.ass,loop=loop=299:size=1:start=0,setpts=N\/\(60\*TB\)\[ocard\];\[oplay\]\[ocard\]concat=n=2:v=1:a=0\[v\]/.test(g.graph), 'end card drawn once');
  assert.ok(g.graph.includes('[3:a]asetpts=PTS-STARTPTS'), 'C1 has sound');
  assert.ok(g.graph.includes('aevalsrc=0:c=stereo:s=48000:d=2.000,aformat=sample_fmts=fltp:channel_layouts=stereo[c4a]'), 'C2 has none: silence');
  assert.ok(g.graph.includes('[c3a][g2_0a][c4a][g2_1a]concat=n=4:v=0:a=1,apad=whole_dur=12.000[a]'));
  assert.ok(g.audio && !g.graph.includes('[0:a]'), 'only the chosen track\'s sound');
  assert.equal(g.graph.match(/fps=60,setsar=1/g).length, 5, 'the 60 Hz sources at their rate');
  // Crop fits: the source fills 480 board px high (x zoom) and the window moves with pan.
  assert.ok(g.graph.includes('[0:v]setpts=PTS-STARTPTS,scale=854:720:force_original_aspect_ratio=increase:force_divisible_by=2:flags=lanczos,crop=854:720,'));
  const q = three();
  q.tracks[1].clips[0].pan = -0.5;
  q.tracks[1].clips[0].zoom = 1.5;
  const panned = timelineGraph(tl.normaliseProject(q), { infos: [] });
  assert.ok(panned.graph.includes('scale=1276:1080:force_original_aspect_ratio=increase:force_divisible_by=2:flags=lanczos,crop=850:720:(iw-850)*0.2500:(ih-720)/2'), panned.graph);
  // Letterbox ignores pan and zoom; the range cuts the input.
  const r = two({ range: { in: 1, out: 4 }, sound: null });
  r.tracks[0].clips[0].pan = 1;
  const lg = timelineGraph(tl.normaliseProject(r), {});
  assert.ok(lg.graph.includes('[0:v]setpts=PTS-STARTPTS,scale=960:540:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad=960:540'));
  assert.deepEqual(lg.inputs[0].args.slice(0, 4), ['-ss', '1.000', '-t', '3.000']);
  assert.ok(!lg.audio && !lg.graph.includes('aevalsrc'));
});

test('timelineGraph: segments start and end on the frame grid, so clips do not drift', () => {
  // Four 0.505 s clips 1.01 s apart: alone each would round to 31 or 30 frames and every boundary would slip.
  const clips = [0, 1, 2, 3].map((i) => clip(LOCKED, i * 0.6, i * 0.6 + 0.505, i * 1.01));
  const p = tl.normaliseProject({ tracks: [{ clips }, { clips: [clip(LOCKED, 0, 5, 0)] }], range: { in: 0, out: 4 }, sound: 0, endCard: false });
  const g = timelineGraph(p, {});
  const n = (re) => [...g.graph.matchAll(re)].map((m) => Number(m[1]));
  const segs = g.graph.split(';').find((s) => s.endsWith('[t0]')).match(/\[(c\d+|g0_\d+)\]/g);
  const frames = new Map([...g.graph.matchAll(/trim=end_frame=(\d+)(?:,[^;]*)?\[(c\d+|g0_\d+)\]/g)].map((m) => [`[${m[2]}]`, Number(m[1])]));
  let at = 0;
  const starts = segs.map((s) => { const a = at; at += frames.get(s); return a; });
  assert.deepEqual(starts.filter((_, i) => segs[i].startsWith('[c')), [0, 61, 121, 182], 'each clip starts on its own frame: round(at x 60)');
  assert.equal(at, 240, 'the whole range, 4 s at 60');
  assert.ok(n(/aevalsrc=0:c=stereo:s=48000:d=([\d.]+)/g).every((d) => Math.abs(d * 60 - Math.round(d * 60)) < 0.07), 'the sound cut the same way');
});

test('timelineGraph: three-up widths, 5120 wide goes to HEVC on the GPU', () => {
  for (const [size, widths] of [['1080', [854, 852, 854]], ['2160', [1706, 1708, 1706]]]) {
    const g = timelineGraph(tl.normaliseProject(three({ size })), {});
    const b = ab.thirds(g.width);
    assert.deepEqual(b.slice(1).map((x, i) => x - b[i]), widths);
    assert.ok(widths.every((w) => w % 2 === 0) && widths.reduce((s, w) => s + w, 0) === g.width);
    assert.ok(g.rects.every((r) => r.w % 2 === 0 && r.h % 2 === 0 && r.y % 2 === 0));
    assert.equal(videoArgs('gpu', g.width, g.height, QUALITY.standard).codec, size === '2160' ? 'hevc' : 'h264');
  }
});

// ---- the three-up overlay ----

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
      start: secs(m[2], m[3], m[4], m[5]), end: secs(m[6], m[7], m[8], m[9]), text, plain: text.replace(/\{[^}]*\}/g, ''), drawing,
      an: Number((/\\an(\d)/.exec(tags) || [])[1] || 7), pos: pos ? [Number(pos[1]), Number(pos[2])] : null,
      fs: Math.max(0, ...[...tags.matchAll(/\\fs([\d.]+)/g)].map((x) => Number(x[1]))),
      colors: [...tags.matchAll(/\\c&H([0-9A-F]{8})/g)].map((x) => x[1]), yMax: ys.length ? Math.max(...ys) : null, yMin: ys.length ? Math.min(...ys) : null,
    };
  });
}
const bottomOf = (e) => (e.drawing ? e.pos[1] + e.yMax : e.an <= 3 ? e.pos[1] : e.pos[1] + e.fs);

test('three-up overlay: nothing below 92 %, three lane colours, NO VIDEO in the gap, the end card with BEST', () => {
  const p = tl.normaliseProject(three({ range: { in: 0, out: 6 }, watermark: '4aLse Benchmarks' }));
  const ass = timelineOverlay(p, { width: 2560, height: 1080 }).build(), events = parse(ass);
  assert.ok(!/NaN|undefined|Infinity|null/.test(ass), 'no stray values');
  for (const e of events) {
    if (e.drawing && e.yMax - e.yMin > 540) continue; // the end card's backdrop
    assert.ok(bottomOf(e) <= 0.92 * 1080 + 0.5, `"${e.plain || e.text.slice(0, 60)}" reaches ${bottomOf(e).toFixed(1)}`);
  }
  for (const col of [0x4F9CF9, 0xC084FC, 0x34D399]) assert.ok(ass.includes(assColor(col)), `colour ${col.toString(16)}`);
  for (const s of ['A · FRAME TIME · ms', 'B · FRAME TIME · ms', 'C · FRAME TIME · ms', 'FPS · TARGET 30', 'FPS · TARGET 60', 'Ray Tracing']) {
    assert.ok(events.some((e) => e.plain === s), s);
  }
  const box = events.find((e) => /^NO VIDEO · 1\.5 s · not counted$/.test(e.plain));
  assert.ok(box && box.start === 2 && box.end === 3.5, 'C\'s gap 2-3.5 s replaces its stats line');
  assert.ok(box.pos[0] > 1708, 'in C\'s column');
  const heroC = events.filter((e) => /^\d+ FPS$/.test(e.plain) && e.pos[0] > 2400 && e.an === 3);
  assert.ok(heroC.length && heroC.every((e) => e.end <= 2.001 || e.start >= 3.499), 'C\'s live number is hidden in the gap');
  assert.ok(events.filter((e) => e.plain === '4aLse Benchmarks' && e.start === 0).every((e) => e.pos[0] > 2400), 'the watermark on the last pane');
  // The end card: three value columns and BEST.
  const card = events.filter((e) => e.start === 6 && e.end === 11);
  assert.ok(card.some((e) => e.plain === 'BEST') && !card.some((e) => e.plain === 'BETTER'));
  const avg = card.filter((e) => /^\d+\.\d$/.test(e.plain) && e.fs > 40).map((e) => e.pos[1]);
  assert.equal(avg.length, 9, 'three fps rows of three numbers');
  assert.ok(card.some((e) => e.plain === 'Numbers cover the 0:06 shown · stills, loading and gaps not counted'));
  assert.ok(card.some((e) => /does best|tie at|All three/.test(e.plain)));
  assert.ok(card.some((e) => e.plain === 'B') || card.some((e) => e.plain === 'Even'));
});

test('rowsN and verdictN: by share of each target, ties read Even', () => {
  const s = (avg, low, hitches, target = 60, missed = 1) => ({ avg_fps: avg, low_1pct_fps: low, low_0_1pct_fps: low, hitches: { count: hitches }, target_fps: target, frames_missing_target_pct: missed, pacing: { even_pct: null } });
  const rows = ab.rowsN([s(59.5, 50, 2), s(29.9, 28, 0, 30), s(54, 40, 3)]);
  assert.deepEqual(rows[0][3], { side: 1, text: 'B' }, '100 % of 30 beats 99 % of 60');
  assert.deepEqual(rows[3][3], { side: 1, text: 'B' }, 'fewest hitches');
  assert.equal(rows[4][0], 'Missed target');
  assert.deepEqual(ab.rowsN([s(60, 50, 1), s(30, 28, 1, 30), s(54, 40, 3)])[0][3], { side: null, text: 'Even' }, 'both at 100 %');
  assert.deepEqual(ab.rowsN([s(33.4, 30, 0, 30), s(30, 30, 0, 30), s(31.2, 30, 0, 30)])[0][3], { side: null, text: 'Even' }, 'above the target is no better, as the verdict has it');
  assert.equal(ab.verdictN([s(59.5, 50, 2), s(29.9, 28, 0, 30), s(54, 40, 3)], ['Quality', 'Performance', 'Ray Tracing']),
    'Performance does best, holding its 30 fps target; Quality reaches 99 %, Ray Tracing 90 %. Ray Tracing hitches most, 3 times.');
  assert.equal(ab.verdictN([s(60, 59, 0), s(60, 59, 0), s(60, 59, 0)], ['A', 'B', 'C']), 'All three hold their targets equally well. None of them hitches.');
  assert.match(ab.verdictN([s(58.2, 30, 0), s(56, 50, 0), s(55, 50, 0)], ['A', 'B', 'C']), /^A does best, averaging 97 % of its 60 fps target;/, 'a red 1% low does not "hold"');
  assert.equal(ab.verdictN([s(50, 40, 2), s(25, 20, 2, 30), s(40, 30, 0)], ['A', 'B', 'C']),
    'A and B tie at 83 % of their targets; C reaches 67 %. A and B hitch most, 2 times each.');
});

test('a gap is its own NO VIDEO span, never merged into the still before it; two panes with a gap say so on the card', () => {
  // 1 s calm, then a 1 s still at the clip's end, then nothing on the track.
  const calm = rowsFromCounts([...Array(60).fill(1), 60]).map((r) => [r[0], r[1] === 10 ? 0.5 : r[1], r[2], r[3]]);
  const still = saved(analyse(calm, HZ, 0.4, 60));
  const p = tl.normaliseProject({ tracks: [{ clips: [clip(still, 0, 2, 0)] }, { clips: [clip(LOCKED, 0, 4, 0)] }], range: { in: 0, out: 4 } });
  const events = parse(timelineOverlay(p, { width: 1920, height: 1080 }).build());
  const word = (s) => events.filter((e) => e.plain === s && e.an === 1 && e.pos[0] < 960);
  assert.ok(word('STILL').some((e) => e.start === 1 && e.end === 2), 'STILL while the still is on screen');
  assert.ok(word('NO VIDEO').some((e) => e.start === 2 && e.end === 4), 'then NO VIDEO for the gap');
  // The frame-time header names the gap too, though a still came just before it: the STILL name leaves as it comes in.
  const head = (re) => events.filter((e) => re.test(e.plain) && e.an === 7 && e.pos && e.pos[0] < 960 && e.fs < 40);
  assert.ok(head(/^NO VIDEO( · not counted)?$/).some((e) => Math.abs(e.start - 2) < 0.01), 'NO VIDEO in the frame-time header from 2 s');
  assert.ok(head(/^STILL( · not counted)?$/).every((e) => e.end <= 2.001), 'STILL gone from the header once the gap is in');
  assert.ok(events.some((e) => e.plain === 'Numbers cover the 0:04 shown · stills, loading and gaps not counted'));
});

test('an exact frame\'s overlay is the moment frozen at 0', () => {
  const p = tl.normaliseProject(three({ range: { in: 0, out: 6 } }));
  const file = path.join(os.tmpdir(), `capfps-tl-${process.pid}.ass`);
  try {
    timelineOverlay(p, { width: 2560, height: 1080 }).writeTo(file, { at: 2.5 });
    const events = parse(fs.readFileSync(file, 'utf8'));
    assert.ok(events.length > 20 && events.every((e) => e.start === 0 && e.end === 1));
    assert.ok(events.some((e) => /^NO VIDEO/.test(e.plain)), 'C is in its gap at 2.5 s');
    assert.ok(!/\move\(/.test(fs.readFileSync(file, 'utf8')));
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('rowsN: one shared target compares the shown values, so 59.4 vs 59.6 is not Even', () => {
  const s = (avg, low) => ({ avg_fps: avg, low_1pct_fps: low, low_0_1pct_fps: low, hitches: { count: 0 }, target_fps: 60, frames_missing_target_pct: 1, pacing: { even_pct: null } });
  const rows = ab.rowsN([s(59.4, 50), s(59.6, 50.4), s(55, 40)]);
  assert.deepEqual(rows[0][3], { side: 1, text: 'B' });
  assert.deepEqual(rows[1][3], { side: 1, text: 'B' });
});

test('trackAnalysis: a track mixing 60 and 120 Hz recordings paces the same in either order', () => {
  const mk = (hz) => {
    const a = { starts: [], frameMs: [], holdRefreshes: [], kind: [], holds: [], droppedAt: [], tears: [], times: [], diffs: [], peaks: [], luma: [], newFrame: [],
      target: 60, hz, duration: 5, droppedRefreshes: 0, threshold: 1, thresholdSource: 'x', kRef: hz / 60 };
    for (let i = 0; i < 300; i++) { a.starts.push(i / 60); a.frameMs.push(1000 / 60); a.holdRefreshes.push(hz / 60); a.kind.push('ok'); }
    return { outDir: `hz${hz}`, summary: { capture: { start_s: 0 } }, a };
  };
  const pacing = (reads) => summarise(tl.trackAnalysis({ clips: reads.map((r, i) => ({ outDir: r.outDir, in: 0, out: 5, at: i * 5 })) }, reads, { in: 0, out: 10 }),
    { width: 1920, height: 1080 }).pacing.even_pct;
  assert.equal(pacing([mk(60), mk(120)]), 100);
  assert.equal(pacing([mk(120), mk(60)]), 100);
});

test('the held end card frame is timed inside the card, also for a span that is not on the 0.01 s grid', () => {
  // 10.0056 s at 60 Hz: frame 600 is at 10.000 s, but the card's events start at 10.01 s.
  const info = { width: 1920, height: 1080, hz: 60, duration: 20 }, span = 10.0056, LOCKED_A = analyse(rowsFromCounts(Array(1200).fill(1)), HZ, 0.4, 60);
  const g = compareABGraph({ infos: [info, info], end: span, frame: '16:9', fit: 'letterbox', assName: 'ab.ass', outDir: '.', endCard: true });
  const m = /trim=start_frame=(\d+):end_frame=\d+,(?:setpts=([\d.]+)\/TB,)?setparams/.exec(g.graph);
  const t = m[2] ? Number(m[2]) : Number(m[1]) / 60; // what libass is given
  const ev = parse(ab.abOverlay({ panes: [0, 1].map(() => ({ a: ab.shiftAnalysis(LOCKED_A, 0, span), summary: summarise(LOCKED_A, info), title: 'X' })),
    size: { width: 1920, height: 1080 }, frame: '16:9', fit: 'letterbox', span, endCard: true }).build());
  const card = ev.filter((e) => e.plain === 'RESULT')[0];
  assert.ok(card && t >= card.start && t < card.end, `card frame at ${t} s, card ${card && card.start}-${card && card.end} s`);
});

test('analysisStart: an old folder without start_s starts at 0 only when it covers its video', () => {
  const read = (cap) => ({ outDir: 'x', summary: { capture: cap } });
  assert.equal(ab.analysisStart(read({ start_s: 20, seconds: 5 }), 600), 20);
  assert.equal(ab.analysisStart(read({ seconds: 599.6 }), 600.2), 0, 'the whole recording');
  assert.throws(() => ab.analysisStart(read({ seconds: 5 }), 600), /older version\. Analyse that video again/);
});

test('freeName: a default output name never replaces an earlier export', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capfps-name-'));
  try {
    const f = path.join(dir, 'a_vs_b_ab.mp4');
    assert.equal(freeName(f), f);
    fs.writeFileSync(f, '');
    assert.equal(freeName(f), path.join(dir, 'a_vs_b_ab (2).mp4'));
    fs.writeFileSync(path.join(dir, 'a_vs_b_ab (2).mp4'), '');
    assert.equal(freeName(f), path.join(dir, 'a_vs_b_ab (3).mp4'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('abOverlay.writeTo writes what build() gives, one pane at a time', () => {
  const p = tl.normaliseProject(three({ range: { in: 0, out: 6 } }));
  const file = path.join(os.tmpdir(), `capfps-tl-w-${process.pid}.ass`);
  try {
    const ov = timelineOverlay(p, { width: 2560, height: 1080 });
    ov.writeTo(file);
    const s = ov.build();
    assert.ok(s.includes('RESULT') && s.length > 10000);
    assert.equal(fs.readFileSync(file, 'utf8'), s);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('timelineGraph: a clip parked past Out does not raise the frame rate', () => {
  const p = tl.normaliseProject({ tracks: [{ clips: [clip(LOCKED, 0, 3, 0), clip(LOCKED, 0, 3, 5)] }, { clips: [clip(LOCKED, 0, 3, 0)] }], range: { in: 0, out: 3 }, endCard: false });
  const infos = [[{ hz: 60 }, { hz: 120 }], [{ hz: 60 }]];
  const g = timelineGraph(p, { infos });
  assert.equal(g.rate, 60, 'the 120 Hz clip is after Out');
  assert.ok(!/fps=120/.test(g.graph));
  assert.equal(timelineGraph({ ...p, range: { in: 0, out: 6 } }, { infos }).rate, 120, 'inside the range it counts');
});

test('timelineGraph: an exact frame starts each track at the source frame the export shows, on that track\'s grid', () => {
  // A 30 Hz track (black, then a clip from track frame 3) and a 60 Hz one (black, then from frame 15) in a 120 Hz export:
  // the slice at 0.25 + k/120 shows A's track frame floor(7.5 + k/4) and B's 15 + floor(k/2).
  const p = tl.normaliseProject({ tracks: [{ clips: [clip(LOCKED, 1, 6, 0.1)] }, { clips: [clip(LOCKED, 0, 6, 0.25)] }], range: { in: 0, out: 5 }, endCard: false });
  const infos = [[{ hz: 30 }], [{ hz: 60 }]], rates = { rate: 120, tracks: [30, 60] };
  for (let k = 0; k < 24; k++) {
    const at = 0.25 + k / 120;
    const g = timelineGraph({ ...p, range: { in: at, out: at + 0.1 }, sound: null }, { infos, rates, grid: 0 });
    assert.ok(!/\[g\d_\d+\]/.test(g.graph), `k=${k}: no black before the clips, they are on screen`);
    const want = [1 + (Math.floor(7.5 + k / 4) - 3) / 30, Math.floor(k / 2) / 60]; // the export's -ss plus whole track frames
    g.inputs.forEach((inp, i) => {
      const ss = Number(inp.args[1]);
      assert.ok(ss <= want[i] + 1e-9 && ss > want[i] - 0.001, `k=${k} track ${'AB'[i]}: -ss ${inp.args[1]}, frame at ${want[i].toFixed(6)}`);
    });
  }
});

test('normaliseProject keeps only the project\'s analyses cached', () => {
  const thirty = tl.analysisOf(THIRTY), locked = tl.analysisOf(LOCKED);
  tl.normaliseProject(two());
  assert.equal(tl.analysisOf(LOCKED), locked, 'a folder in the project stays cached');
  assert.notEqual(tl.analysisOf(THIRTY), thirty, 'a folder outside it is read again');
});

test('timelineGraph: a 59.94 Hz recording stays at 60000/1001, whole rates stay whole', () => {
  const p = tl.normaliseProject({ tracks: [{ clips: [clip(LOCKED, 0, 3, 0)] }, { clips: [clip(LOCKED, 0, 3, 0)] }], range: { in: 0, out: 3 }, endCard: false });
  const rate = (hz) => timelineGraph(p, { infos: [[{ hz }], [{ hz }]] }).rate;
  assert.equal(rate(59.94006), 60000 / 1001, 'rounded to 60 it repeats a frame every 16.7 s');
  assert.equal(rate(119.88012), 120000 / 1001);
  assert.deepEqual([60, 30, 120, 144].map(rate), [60, 30, 120, 144]);
  assert.equal(rate(29.97003), 30000 / 1001, 'an all-29.97 project is not lifted to 30');
  assert.equal(rate(24), 30, 'slower recordings keep the floor of 30');
  const g = timelineGraph(p, { infos: [[{ hz: 59.94006 }], [{ hz: 59.94006 }]] });
  assert.ok(g.graph.includes(`fps=${60000 / 1001},`) && g.graph.includes('trim=end_frame=180,'), '3 s of 59.94 is 180 frames');
});
