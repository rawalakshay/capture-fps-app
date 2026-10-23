'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTime } = require('../src/core/time');

test('parseTime reads seconds and m:ss', () => {
  assert.equal(parseTime('112'), 112);
  assert.equal(parseTime('1:52'), 112);
  assert.equal(parseTime(' 01:52.5 '), 112.5);
  assert.equal(parseTime('1:01:52'), 3712);
  assert.equal(parseTime('.5'), 0.5);
  for (const bad of ['', '1:', ':5', '-5', '1:2:3:4', 'abc', '1m52', null]) assert.ok(Number.isNaN(parseTime(bad)), String(bad));
});
