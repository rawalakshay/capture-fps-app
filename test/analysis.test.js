'use strict';
// The measurement core: ffmpeg's metadata text -> rows -> frames -> summary numbers.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDiffs, analyse, summarise } = require('../src/core/analysis');

test('parseDiffs reads the metadata filter output and restores the first refresh', () => {
  // tblend stamps each diff with the later refresh of the pair, so the first refresh is missing.
  const text = [
    'frame:0    pts:1001    pts_time:0.016683',
    'lavfi.signalstats.YAVG=0.012345',
    'frame:1    pts:2002    pts_time:0.033367',
    'lavfi.signalstats.YAVG=9.5',
    'frame:2    pts:3003    pts_time:0.05005',
    'lavfi.signalstats.YAVG=0.02',
    '',
  ].join('\n');
  const rows = parseDiffs(text);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], [0, Infinity]);
  assert.ok(Math.abs(rows[1][0] - 0.016684) < 1e-6 && rows[1][1] === 0.012345);
  assert.ok(Math.abs(rows[3][0] - 0.050051) < 1e-6 && rows[3][1] === 0.02);
  assert.equal(parseDiffs('frame:0 pts:0 pts_time:0\nlavfi.signalstats.YAVG=1\n').length, 1, 'one frame cannot be shifted');
  assert.equal(parseDiffs('').length, 0);
});

test('a game locked at 30 fps summarises as 30 fps with nothing missed', () => {
  const rows = [];
  for (let i = 0; i < 720; i++) rows.push([i / 60, i === 0 ? Infinity : i % 2 ? 0.05 : 10]); // new, repeat, new, ...
  const a = analyse(rows, 60, null, null);
  const s = summarise(a, { width: 1920, height: 1080 });
  assert.equal(a.target, 30);
  assert.equal(s.game_frames, 360);
  assert.equal(s.avg_fps, 30);
  assert.equal(s.low_1pct_fps, 30);
  assert.equal(s.frames_missing_target, 0);
  assert.equal(s.capture.dropped_by_recorder, 0);
  assert.equal(s.threshold_source, 'auto (two clear groups)');
});
