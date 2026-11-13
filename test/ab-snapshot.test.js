'use strict';
// The two-pane A/B overlay must not change while the export grows to three panes:
// the .ass of fixed synthetic clips is hashed for every frame and fit. The hashes were
// taken before the N-pane work and re-taken once on purpose (2.2.2: Inter names, spike markers from the frame's start,
// no dash after a hold). SNAP_DIR=<dir> writes the .ass files there to diff.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { analyse, summarise } = require('../src/core/analysis');
const ab = require('../src/core/compare-ab');

const HZ = 60;
function rowsFromCounts(counts, blackAt = -1) {
  const rows = [];
  let i = 0;
  counts.forEach((c, f) => {
    for (let r = 0; r < c; r++, i++) rows.push([i / HZ, i === 0 ? Infinity : r === 0 ? 10 : 0.05, r === 0 ? 100 : 5, f === blackAt && r === 0 ? 5 : 100]);
  });
  return rows;
}
const EVENTFUL = [...Array(120).fill(1), 12, ...Array(60).fill(1), 90, ...Array(200).fill(1)];

function ass(frame, fit) {
  const panes = [analyse(rowsFromCounts(Array(600).fill(1)), HZ, 0.4, 60), analyse(rowsFromCounts(EVENTFUL, 181), HZ, 0.4, 60)];
  const W = frame === '21:9' ? 2560 : 1920, span = 6;
  return ab.abOverlay({
    panes: panes.map((a, i) => ({ a: ab.shiftAnalysis(a, 0, span), summary: summarise(a, { width: 1920, height: 1080 }), title: i ? 'PS5' : 'PS5 Pro', subtitle: 'Forza Horizon 6 · Performance' })),
    size: { width: W, height: 1080 }, frame, fit, span, endCard: true,
  }).build();
}

const HASHES = {
  '16:9/letterbox': 'da70070e23529e8fb1aa21f3563f7569c1c7bffedccf5add24d47f944d3913d3',
  '16:9/crop': '55530621df54e8b8937191d96e281b6bc459b43280e95b70171331506948b493',
  '21:9/letterbox': '496ef81cf6028170e9b8a9fe636a0ed320795276e121850272a625869016dbb7',
  '21:9/crop': '38d551bdf90325f6e6a49febf704c45d50b8e03b0ca5eb1a98be2bcd2b8a36b9',
  '21:9/below': '6188d8cfcb3ab69f1ad849f5c6d4367eaab7b5a6fc464bdf5c6eec1500efe3c1',
};

for (const [key, want] of Object.entries(HASHES)) {
  test(`two-pane A/B ${key} overlay is unchanged`, () => {
    const s = ass(...key.split('/'));
    if (process.env.SNAP_DIR) fs.writeFileSync(path.join(process.env.SNAP_DIR, `${key.replace(/[/:]/g, '-')}.ass`), s);
    assert.equal(crypto.createHash('sha256').update(s).digest('hex'), want);
  });
}
