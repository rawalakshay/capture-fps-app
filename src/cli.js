#!/usr/bin/env node
'use strict';
// Command-line front end, same engine as the app:
//   node src/cli.js run.mp4 [--no-video] [--start S] [--end S] [--target 30]
//                           [--threshold X] [--title T] [--out DIR]
//                           [--position left|center|right] [--encoder gpu|cpu]
//                           [--quality high|standard|small] [--cpu-decode]
//                           [--resolution source|1080|1440|2160] [--upscaler lanczos|sharp|fsrcnnx]
//                           [--no-target-pill] [--no-format-pill] [--watermark T | --no-watermark]
//                           [--caption T] [--caption-position top-left|top-center|top-right|bottom-left|bottom-center|bottom-right]
//                           [--style panel|strip|glass|none] [--long-graph] [--long-graph-opacity 0.86]

const { runJob, QUALITY, ENCODERS, RESOLUTIONS, UPSCALERS } = require('./core/pipeline');
const { TARGETS, STALL_MS } = require('./core/analysis');
const { POSITIONS, CAPTION_POSITIONS, STYLES } = require('./core/overlay');
const { gpuStatus } = require('./core/ffmpeg');

function parseArgs(argv) {
  const o = { renderVideo: true };
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${name} needs a number`);
    return n;
  };
  const oneOf = (v, name, list) => {
    if (!list.includes(v)) throw new Error(`${name} must be one of ${list.join(', ')}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--no-video') o.renderVideo = false;
    else if (a === '--start') o.start = num(next(), a);
    else if (a === '--end') o.end = num(next(), a);
    else if (a === '--target') o.target = oneOf(num(next(), a), a, TARGETS);
    else if (a === '--threshold') o.threshold = num(next(), a);
    else if (a === '--title') o.title = next();
    else if (a === '--out') o.outDir = next();
    else if (a === '--overlay-rate') o.overlayRate = num(next(), a);
    else if (a === '--position') o.position = oneOf(next(), a, POSITIONS);
    else if (a === '--no-target-pill') o.showTarget = false;
    else if (a === '--no-format-pill') o.showFormat = false;
    else if (a === '--caption') o.caption = next();
    else if (a === '--watermark') o.watermark = next();
    else if (a === '--style') o.style = oneOf(next(), a, STYLES);
    else if (a === '--long-graph') o.longGraph = true;
    else if (a === '--long-graph-opacity') o.longGraphOpacity = num(next(), a);
    else if (a === '--no-watermark') o.watermark = '';
    else if (a === '--caption-position') o.captionPosition = oneOf(next(), a, CAPTION_POSITIONS);
    else if (a === '--encoder') o.encoder = oneOf(next(), a, ENCODERS);
    else if (a === '--quality') o.quality = oneOf(next(), a, Object.keys(QUALITY));
    else if (a === '--cpu-decode') o.hwDecode = false;
    else if (a === '--resolution') o.resolution = oneOf(next(), a, Object.keys(RESOLUTIONS));
    else if (a === '--upscaler') o.upscaler = oneOf(next(), a, UPSCALERS);
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o.video = a;
  }
  if (!o.video) throw new Error('usage: node src/cli.js <video> [options]');
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.encoder && opts.renderVideo) opts.encoder = (await gpuStatus()).nvenc ? 'gpu' : 'cpu';
  let lastPhase = '';
  const r = await runJob(opts, {
    onProgress: ({ phase, fraction }) => {
      if (phase !== lastPhase) {
        if (lastPhase) process.stderr.write('\n');
        lastPhase = phase;
      }
      if (phase !== 'done') process.stderr.write(`\r${phase.padEnd(8)} ${(fraction * 100).toFixed(0).padStart(3)}%`);
    },
  });
  process.stderr.write('\n');
  const s = r.summary;
  const c = s.capture;
  console.log(`capture      ${c.width}x${c.height} @ ${c.refresh_hz.toFixed(3)} Hz, ${c.seconds.toFixed(1)} s, ${c.refreshes} refreshes`);
  console.log(`threshold    ${s.threshold.toFixed(3)} (${s.threshold_source}); diff percentiles ${JSON.stringify(s.diff_percentiles)}`);
  console.log(`game frames  ${s.game_frames}`);
  console.log(`average      ${s.avg_fps} fps   (target ${s.target_fps})`);
  console.log(`1% low       ${s.low_1pct_fps} fps   0.1% low ${s.low_0_1pct_fps} fps`);
  console.log(`1 s range    ${s.min_1s_fps} .. ${s.max_1s_fps} fps`);
  console.log(`missed cap   ${s.frames_missing_target} frames (${s.frames_missing_target_pct}%), longest ${s.longest_frame_ms} ms`);
  if (s.possible_stalls_or_static_scenes.length) {
    console.log(`check these  frames >= ${STALL_MS} ms (stall or static scene?): ${JSON.stringify(s.possible_stalls_or_static_scenes.slice(0, 8))}`);
  }
  if (c.dropped_by_recorder) {
    console.log(`WARNING      the recording itself is missing ${c.dropped_by_recorder} refreshes (recorder dropped frames)`);
  }
  console.log(`measured     in ${r.measureSeconds.toFixed(1)} s (${r.hwDecode ? 'GPU' : 'CPU'} decoding)`);
  if (r.overlayVideo) {
    console.log(`rendered     in ${r.renderSeconds.toFixed(1)} s (${r.encoder === 'gpu' ? 'NVENC' : 'x264'}, ${r.outputWidth}x${r.outputHeight})`);
    console.log(`video        ${r.overlayVideo}`);
  }
  console.log(`files        ${r.outDir}`);
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
