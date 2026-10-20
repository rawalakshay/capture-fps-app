'use strict';
// The ffmpeg filter chain: upscale (when the output is bigger) then the overlay.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { overlayFilter, UPSCALERS } = require('../src/core/pipeline');

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
