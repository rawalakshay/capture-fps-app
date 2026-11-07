'use strict';
// The ffmpeg filter chain: upscale (when the output is bigger) then the overlay.

const test = require('node:test');
const { compareGraph } = require('../src/core/pipeline');
const assert = require('node:assert/strict');
const path = require('path');
const { overlayFilter, UPSCALERS } = require('../src/core/pipeline');
const { filterPath } = require('../src/core/overlay');

test('overlayFilter picks the upscale chain and escapes the shader path', () => {
  const outDir = path.resolve('F:/clips/run_fps'), big = { width: 3840, height: 2160, scaled: true }, same = { width: 1920, height: 1080, scaled: false };
  const ass = (s) => assert.ok(/(^|,)ass=overlay\.ass:fontsdir='[^']+'$/.test(s), s);
  for (const u of UPSCALERS) ass(overlayFilter('overlay.ass', outDir, big, u));
  assert.ok(overlayFilter('overlay.ass', outDir, big, 'lanczos').startsWith('scale=3840:2160:flags=lanczos,ass='));
  assert.ok(overlayFilter('overlay.ass', outDir, big, 'sharp').startsWith('scale=3840:2160:flags=lanczos,cas=0.4,ass='));
  const ai = overlayFilter('overlay.ass', outDir, big, 'fsrcnnx');
  assert.ok(ai.startsWith("libplacebo=w=3840:h=2160:upscaler=ewa_lanczos:custom_shader_path='"), ai);
  assert.ok(ai.includes("FSRCNNX_x2_8-0-4-1.glsl':format=yuv420p,ass="), ai);
  assert.ok(!/[^\\]:[/\\]/.test(ai.split("custom_shader_path='")[1].split("'")[0]), 'drive colon escaped in the shader path');
  // No scaling: the upscaler is ignored.
  assert.ok(overlayFilter('overlay.ass', outDir, same, 'fsrcnnx').startsWith('ass='));
  assert.equal(overlayFilter('overlay.ass', outDir, big, 'nope'), overlayFilter('overlay.ass', outDir, big, 'lanczos'));
});

test("filterPath quotes a path with an apostrophe the way ffmpeg's token parser reads it", () => {
  assert.equal(filterPath(path.resolve("C:/Users/O'Neil/fonts"), path.resolve('F:/clips/run_fps')), "'C\\:/Users/O'\\''Neil/fonts'");
});

test('compareGraph scales every pane to a shared edge and stacks them', () => {
  const p1080 = { width: 1920, height: 1080 }, p720 = { width: 1280, height: 720 };
  const h = compareGraph([p1080, p720], 'h', [null, null]);
  assert.equal(h.width, 2560); // the 1080p pane shrinks to 720p's height
  assert.equal(h.height, 720);
  assert.ok(h.graph.startsWith('[0:v]scale=1280:720:flags=lanczos[p0];[1:v]scale=1280:720:flags=lanczos[p1];[p0][p1]hstack=inputs=2:shortest=1[v]'), h.graph);
  const v = compareGraph([p1080, p720], 'v', []);
  assert.deepEqual([v.width, v.height], [1280, 1440]);
  assert.ok(v.graph.includes('vstack=inputs=2:shortest=1'));
  const g = compareGraph([p1080, p1080, p1080], 'grid', [null, null, null]);
  assert.deepEqual([g.width, g.height], [3840, 2160]);
  assert.ok(g.graph.includes('xstack=inputs=3:layout=0_0|1920_0|0_1080:fill=black:shortest=1'));
  // A label is drawn from a text file with the bundled font, centred at the top of its pane.
  const l = compareGraph([p1080, p1080], 'h', ['C:\\x\\a.txt', null], 'C:\\x');
  assert.ok(/\[0:v\]scale=1920:1080:flags=lanczos,drawtext=fontfile=.*IBMPlexSansCondensed-SemiBold\.ttf.*:textfile='a\.txt':expansion=none:fontsize=49.*x=\(w-text_w\)\/2:y=24\[p0\]/.test(l.graph), l.graph);
  assert.ok(l.graph.includes('[1:v]scale=1920:1080:flags=lanczos[p1]'));
});
