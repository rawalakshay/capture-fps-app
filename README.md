# Capture FPS

A small desktop app that grew out of `capture_fps.py`: measure a console
game's frame rate from a capture-card recording and burn an FPS overlay into
the video. The measurement is the Python script's, rewritten in JavaScript so
Python is not needed, plus a peak test (see Measurement); the overlay is the
app's own design (see Overlay).

## Install

Run `Capture FPS Setup <version>.exe` from the release. It carries its own
ffmpeg (the Gyan "full" build, GPL, with libass and libplacebo), so nothing
else is needed. Windows 10 or 11, 64-bit.

## Run from source

- Node.js 18 or newer.
- `npm install`, then `npm run fetch-ffmpeg` once (downloads the bundled
  ffmpeg into `vendor/ffmpeg`), or have ffmpeg and ffprobe built with libass on
  PATH (`winget install Gyan.FFmpeg`).
- `npm start`, or double-click `Capture FPS.cmd` (installs Electron on the
  first run).

## Build the installer

```
npm run dist
```

Fetches ffmpeg if needed (a pinned version, checked against its SHA-256 in
`scripts/fetch-ffmpeg.js`; to move to a newer ffmpeg, change the version there,
run the script once to see the new hash, and pin it) and writes
`dist/Capture FPS Setup <version>.exe`
(NSIS, per-user or per-machine, with a choice of folder). To sign it, set
`CSC_LINK` to the `.pfx` file (or its base64) and `CSC_KEY_PASSWORD` to its
password before running; electron-builder signs the exe and the installer.
Unsigned builds work but Windows SmartScreen warns on first run.

## Use

1. Choose one or more recordings, or drop them on the window. Several are
   analysed one after another with the same options; the results page then
   has a row of buttons to switch between them.
2. The options sit in three tabs under the file. **Measure** has the
   range (seconds or m:ss, such as `112` or `1:52`; leave End empty to go to
   the end), the target (20/30/60 fps), the threshold and the output folder;
   leave target and threshold on Auto unless the results look wrong.
   **Look** and **Export** hold everything below. The **Preset** box at
   the top saves every option under a name (the Save button beside it) and
   brings it back with one pick. **Overlay look** picks the Panel (the full instrument panel,
   the default), the Strip (one bar along the top edge), Glass (three
   tiles) or None (no FPS overlay at all: the video is only upscaled and gets
   the watermark, caption and long graph if set). **Position** puts it at the top left, middle or right of
   the frame. **Frame-time graph** adds a scrolling 7.5 s frame-time
   strip across 70 % of the bottom edge, with its own background opacity. The **TARGET** and capture format (**1080P60**) pills
   in the panel header can each be turned off. A **Caption** is free text
   (say, "Game Benchmark at 1440p") drawn in any corner or edge of the video;
   at the top on the panel's side it sits just below the panel. Every video
   carries a small **Watermark** at the bottom left, "4aLse Benchmarks" by
   default; switch it off or change the text (a bottom-left caption sits above
   it). The CLI has `--watermark` and `--no-watermark`. **Encoder** picks GPU (NVENC, about 5x faster, NVIDIA
   only) or CPU (x264, any PC); **Quality** is High, Standard or Smaller
   files on either. **Size** keeps the recording's size or
   scales the video to 1080p, 1440p or 4K; the overlay is drawn at the output
   size, so it stays sharp. **Upscaler** (shown only when the output is bigger) picks how the picture is enlarged:
   Lanczos (the default, as before), Lanczos + sharpen (a light
   contrast-adaptive sharpen, no extra cost), or FSRCNNX on the GPU (a small
   neural-network shader run through libplacebo over Vulkan; sharper edges and
   textures, needs a GPU with Vulkan; the shader is igv's FSRCNNX, LGPL-3.0,
   in `assets/shaders`). None adds real detail the recording does not have.
   The app remembers these choices.
3. Press **Analyse** (or Ctrl+Enter). Measuring decodes the whole recording;
   rendering the video re-encodes it. Switch off **Also render the video**
   for numbers only. The line under the button says roughly how long it will take.
4. Results open with a verdict line (how many frames hit the target, and
   the worst long frames as chips that jump the preview there) and a live
   preview: one frame with the overlay as the options on the left would draw
   it. It redraws about a second after any overlay or export option changes;
   drag the slider under it, press ← →, or click a second on the chart to
   move the moment. Below it are the average, 1% and 0.1% lows, the longest frame,
   the per-second FPS chart and, under **Details**, every frame of 200 ms or
   more to check (a stall, or a still shot such as a cutscene hold) and the
   measurement numbers. Drag across the chart to set the range, then press
   Analyse to measure only that part. **Render video** makes the video with
   the options now set on the left, without measuring again; **Play video**
   opens the rendered file. The ⋯ menu has **Copy summary** (the key numbers
   as text), **Show files** and **Refresh preview**. Clips over 30 minutes
   get a note that the overlay file will be large and the render slow.

## Measurement

Every captured refresh is compared with the one before it on a 640-pixel-wide
grey copy. A refresh is a new game frame when the mean difference is above
the threshold (Otsu's split of the two groups, or the value set by hand), or
when any one spot of the picture changed by 64 levels or more out of 255. The
peak test catches calm scenes: a character moving against a still background
averages to almost nothing, while a truly repeated frame only carries faint,
evenly spread encoder noise, which never peaks. Record at high quality (NVENC
CQP 20 or better, x264 CRF 18 or better): at x264 CRF 23 a repeat re-encoded
at a keyframe can read as a new frame. A screen that does not change at all,
such as a pause menu or a fade, cannot be measured from a recording; frames
the game presented without changing a pixel appear as one long frame.

## Overlay

The panel burned into the video (380 × 476 px at 1080p, scaled with the output)
shows, from the top:

- **Title and pills**: the recording's format (`1080P60`) and the target.
- **FPS** (large): the frame rate over the last 0.5 s. Frames are counted by
  time, so a game locked at 30 fps reads a steady 30, and the frame still on
  screen counts for the time it has been there (never less than one target
  frame). White on target, amber from 80 %, red below.
- **AVG · 1% LOW** over the last 10 s: the time-weighted rate and the frame
  rate at the 99th-percentile frame time, computed as on the results page
  (`–` until the window holds 20 frames).
- **LAST FRAME**: how long the last completed frame stayed on screen. While
  the frame on screen has lasted at least max(100 ms, 3 target frames), a red
  **STALL** counter shows how long it has been there.
- **RUN AVG · 1% LOW · 0.1% LOW · MISSED**: the run so far (frames ÷ time,
  interpolated percentiles, share of frames longer than the target). They
  match `summary.json` at the last tick.
- **FPS · LAST 10 S**: forty ¼ s slices, time-weighted, with their MIN and
  MAX; the scale tops out at the capture's refresh rate. A red ▲ under a
  slice and `REC DROP` mark refreshes the recorder dropped.
- **FRAME TIME**: the last 89 completed frames plus an outlined bar for the
  frame on screen (red when stalled). The scale is three target frames;
  taller bars print their value. MAX is over the frames drawn.
- **PACING · 10 S**: the share of frames that took one target frame, up to
  two, or longer.
- Footer: the threshold that split new frames from repeats and how it was
  chosen, dropped refreshes, and a timecode.

Numbers update every 250 ms; the frame-time chart, the stall counter and the
timecode every 1/30 s (`--overlay-rate`, 1–100, trades that smoothness for
subtitle size; `overlay.ass` is roughly 0.2 MB per second of video).

## Speed

- Measuring decodes on the GPU when an NVIDIA card is present (CUDA). The
  values are bit-identical to CPU decoding; if GPU decoding fails the app
  measures on the CPU instead.
- GPU rendering uses NVENC (CQ 18/22/26 for High/Standard/Smaller); CPU
  rendering uses x264 veryfast (CRF 12/16/20), which matched x264 medium's
  size and quality on game capture at twice the speed.
- Audio is copied as it is, not re-encoded.

On a 30 s 1080p60 clip: about 53 s before these changes, 31 s now on the
CPU, 13 s on the GPU. Results tell you how long each step took.

Output goes to `<video name>_fps` next to the recording unless you change it:
`summary.json`, `frames.csv`, `per_second.csv`, `refreshes.csv`,
`overlay.ass` and `<video name>_fps.mp4`.

## Command line

The same engine runs without the window:

```
node src/cli.js run.mp4 [--no-video] [--start S|m:ss] [--end S|m:ss] [--target 30]
                        [--threshold X] [--title T] [--out DIR]
                        [--position left|center|right] [--encoder gpu|cpu]
                        [--quality high|standard|small] [--cpu-decode]
                        [--resolution source|1080|1440|2160] [--upscaler lanczos|sharp|fsrcnnx]
                        [--no-target-pill] [--no-format-pill] [--watermark T | --no-watermark]
                        [--caption T] [--caption-position top-left|top-center|top-right|
                                                          bottom-left|bottom-center|bottom-right]
                        [--style panel|strip|glass|none] [--long-graph] [--long-graph-opacity 0.86]
```

## Layout

| Path | What it holds |
|---|---|
| `src/core/ffmpeg.js` | Finding and running ffmpeg/ffprobe, with progress |
| `src/core/analysis.js` | Frame detection, threshold, statistics, CSVs |
| `src/core/overlay.js` | The burned-in panel (ASS subtitles) |
| `src/core/pipeline.js` | One job from measuring to the overlay video |
| `src/core/time.js` | Seconds or m:ss typed by a person, for the window and the CLI |
| `src/cli.js` | Command-line front end |
| `main.js`, `preload.js` | Electron main process and the bridge to the window |
| `renderer/` | The window: HTML, CSS and script, no framework |
| `assets/fonts/` | IBM Plex fonts (SIL Open Font License), used by the window and the overlay |
