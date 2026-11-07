'use strict';
// Ground truth: clips with a known frame cadence are generated with ffmpeg,
// encoded like a recording, and the engine must recover the cadence, the
// holds and the tears. Skipped when ffmpeg is not installed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { which } = require('../src/core/ffmpeg');
const { measureDiffs, analyse, summarise } = require('../src/core/analysis');
const { compareVideos, analyseVideo, renderOverlay } = require('../src/core/pipeline');
const { probe } = require('../src/core/ffmpeg');

const FFMPEG = which('ffmpeg');
const SIZE = '1280x720';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-fps-synth-'));
test.after(() => fs.rmSync(work, { recursive: true, force: true }));

/** A clip from an ffmpeg input list and filter graph, encoded as a recording would be. */
function clip(name, inputs, graph) {
  const file = path.join(work, `${name}.mp4`);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', ...inputs];
  if (graph) args.push('-filter_complex', graph, '-map', '[v]');
  args.push('-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', file);
  execFileSync(FFMPEG, args, { windowsHide: true });
  return file;
}

const src = (rate, hz, seconds, extra = '') => ['-t', String(seconds), '-f', 'lavfi', '-i', `testsrc2=size=${SIZE}:rate=${rate}${extra},fps=${hz}`];

async function run(file, hz, target = null) {
  const rows = await measureDiffs(file, work, {});
  const a = analyse(rows, hz, null, target);
  return { a, s: summarise(a, { width: 1280, height: 720 }) };
}

const holdsOf = (a) => a.holdRefreshes.slice(0, -1); // the last frame ends with the clip

for (const [rate, hz, k] of [[30, 60, 2], [20, 60, 3], [40, 120, 3]]) {
  test(`${rate} fps in a ${hz} Hz capture holds every frame ${k} refreshes`, { skip: !FFMPEG && 'ffmpeg not found' }, async () => {
    const { a, s } = await run(clip(`lock${rate}_${hz}`, src(rate, hz, 4)), hz);
    assert.equal(a.target, rate);
    assert.ok(holdsOf(a).every((n) => n === k), `holds ${JSON.stringify([...new Set(holdsOf(a))])}`);
    assert.equal(s.avg_fps, rate);
    assert.equal(s.pacing.even_pct, 100);
    assert.equal(s.hitches.count, 0);
    assert.equal(s.tears.count, 0);
    assert.equal(s.threshold_source, 'auto (two clear groups)');
  });
}

test('24 fps in a 60 Hz capture is a 2-3 cadence, half even', { skip: !FFMPEG && 'ffmpeg not found' }, async () => {
  const { a, s } = await run(clip('cadence24', src(24, 60, 4)), 60, 30);
  const holds = holdsOf(a);
  const twos = holds.filter((n) => n === 2).length, threes = holds.filter((n) => n === 3).length;
  assert.equal(twos + threes, holds.length, `only 2s and 3s: ${JSON.stringify([...new Set(holds)])}`);
  assert.ok(Math.abs(twos - threes) <= 2, `${twos} twos vs ${threes} threes`);
  assert.ok(Math.abs(s.pacing.even_pct - 50) < 3, `even ${s.pacing.even_pct}%`);
  assert.equal(s.hitches.count, 0);
});

test('a torn second shows as tears at mid-height; a clean clip has none', { skip: !FFMPEG && 'ffmpeg not found' }, async () => {
  // A camera pan at 30 fps: 3 s clean, then 1 s where the bottom half lags the top by one refresh.
  const pan = (seconds) => ['-t', String(seconds), '-f', 'lavfi', '-i', `testsrc2=size=1600x900:rate=30,crop=${SIZE.replace('x', ':')}:x=t*100:y=t*40,fps=60`];
  const graph = '[1:v]split[a][b];[a]crop=iw:ih/2:0:0[t];[b]crop=iw:ih/2:0:ih/2,tpad=start=1:start_mode=clone[u];' +
    '[t][u]vstack=shortest=1[torn];[0:v][torn]concat=n=2:v=1:a=0[v]';
  const { a, s } = await run(clip('torn', [...pan(3), ...pan(1)], graph), 60);
  assert.ok(a.tears.every((t) => t.time >= 2.9), `tears in the clean part: ${JSON.stringify(a.tears.slice(0, 3))}`);
  assert.ok(a.tears.length >= 50 && a.tears.length <= 62, `${a.tears.length} tears`);
  assert.ok(a.tears.every((t) => Math.abs(t.y - 0.5) < 0.07), `tear y: ${JSON.stringify([...new Set(a.tears.map((t) => t.y))])}`);
  assert.equal(s.tears.count, a.tears.length);
});

test('a black second is loading, not a hitch, and is left out of the play numbers', { skip: !FFMPEG && 'ffmpeg not found' }, async () => {
  const graph = '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]';
  const black = ['-t', '1', '-f', 'lavfi', '-i', `color=black:size=${SIZE}:rate=60`];
  const { a, s } = await run(clip('loading', [...src(30, 60, 2), ...black, ...src(30, 60, 2)], graph), 60);
  assert.equal(s.loading.count, 1, JSON.stringify(a.holds));
  assert.ok(Math.abs(s.loading.seconds - 1) < 0.05, `loading ${s.loading.seconds} s`);
  assert.equal(s.hitches.count, 0);
  assert.equal(s.avg_fps, 30);
  assert.equal(s.low_1pct_fps, 30);
  assert.ok(s.all_frames.low_0_1pct_fps < 5, 'the raw numbers keep the hold');
});

test('a still second after a calm scene is static; a stuck frame in motion is a hitch', { skip: !FFMPEG && 'ffmpeg not found' }, async () => {
  // Calm: a slow-moving source held still for 1 s. Motion: the normal source held still for 0.2 s.
  const still = (i) => `[${i}:v]trim=duration=0.0167,setpts=PTS-STARTPTS,loop=loop=59:size=1:start=0[s${i}]`;
  // a white box crossing a dark grey screen at 1 px per refresh: every refresh a new frame, each a tiny change
  const calmSrc = ['-t', '2', '-f', 'lavfi', '-i',
    `color=0x404040:size=${SIZE}:rate=60[bg];color=white:size=40x40:rate=60[box];[bg][box]overlay=x=t*60:y=100`];
  const graph = `${still(0)};[0:v][s0][1:v]concat=n=3:v=1:a=0[v]`;
  const { s: calm } = await run(clip('static', [...calmSrc, ...src(30, 60, 2)], graph), 60, 30);
  assert.equal(calm.static_holds.count, 1, JSON.stringify(calm.hitches));
  assert.equal(calm.hitches.count, 0);

  const hitchGraph = '[1:v]trim=duration=0.0167,setpts=PTS-STARTPTS,loop=loop=11:size=1:start=0[s];[0:v][s][2:v]concat=n=3:v=1:a=0[v]';
  const { s: moving } = await run(clip('hitch', [...src(30, 60, 2), ...src(30, 60, 1), ...src(30, 60, 2)], hitchGraph), 60, 30);
  assert.equal(moving.hitches.count, 1, JSON.stringify(moving.static_holds));
  assert.ok(Math.abs(moving.hitches.first[0][1] - 200) <= 34, `hitch ${moving.hitches.first[0][1]} ms`);
  assert.ok(moving.stutter_time_pct > 0);
});

test('the end card survives a range end: the video is the span plus the card', { skip: !FFMPEG && 'ffmpeg not found' }, async () => {
  const video = clip('endcard', src(30, 60, 3));
  const an = await analyseVideo({ video, outDir: path.join(work, 'endcard_fps'), end: 2, hwDecode: false });
  const r = await renderOverlay(an, { endCard: true, encoder: 'cpu', hwDecode: false });
  const info = await probe(r.path);
  assert.ok(Math.abs(info.duration - 6) < 0.1, `duration ${info.duration}`);
  assert.equal(an.overlayCache, undefined, 'the built overlay is dropped once written');
});

test('two clips stack side by side from their offsets, ending with the shorter',{ skip: !FFMPEG && 'ffmpeg not found' }, async () => {
  const a = clip('cmpA', src(30, 60, 3)), b = clip('cmpB', src(30, 60, 2));
  const r = await compareVideos({ inputs: [{ file: a, offset: 1, label: 'PS5' }, { file: b, label: '' }], encoder: 'cpu', hwDecode: false, out: path.join(work, 'cmp.mp4') });
  const info = await probe(r.path);
  assert.deepEqual([info.width, info.height, r.layout], [2560, 720, 'h']);
  assert.ok(Math.abs(info.duration - 2) < 0.1, `duration ${info.duration}`);
  assert.ok(!fs.readdirSync(work).some((f) => f.startsWith('compare_label_')), 'label files cleaned up');
});
