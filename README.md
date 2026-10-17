# Capture FPS

A small desktop app for `capture_fps.py`: measure a console game's frame rate
from a capture-card recording and burn an FPS overlay into the video. Same
measurement method and numbers as the Python script, rewritten in JavaScript,
so Python is not needed; the overlay is the app's own design (see Overlay).

## Requirements

- Windows with Node.js 18 or newer (for the first install only).
- ffmpeg and ffprobe on PATH, built with libass:
  `winget install Gyan.FFmpeg`, then restart the app.

## Start

Double-click `Capture FPS.cmd`. The first run installs Electron (about
100 MB, once). Or, from this folder:

```
npm install
npm start
```

## Use

1. Choose a recording, or drop it on the window.
2. Optionally set a title, a start and end time, the target (20/30/60 fps)
   or a threshold. Leave target and threshold on Auto unless the results
   look wrong. **Overlay position** puts the panel at the top left, middle or
   right of the frame. **Encoder** picks GPU (NVENC, about 5x faster, NVIDIA
   only) or CPU (x264, any PC); **Video quality** is High, Standard or Smaller
   files on either. **Output resolution** keeps the recording's size or
   scales the video to 1080p, 1440p or 4K; the overlay is drawn at the output
   size, so it stays sharp. The app remembers these choices.
3. Press **Analyse**. Measuring decodes the whole recording; rendering the
   overlay video re-encodes it. Untick **Render overlay video** for numbers
   only.
4. Results show average, 1% and 0.1% lows, the per-second FPS chart and every
   frame of 200 ms or more to check (a stall, or a still shot such as a
   cutscene hold). **Play overlay video** opens the rendered file.
   **Render again** makes the video again with the overlay, encoder and
   quality now set on the left, without measuring again.

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
node src/cli.js run.mp4 [--no-video] [--start S] [--end S] [--target 30]
                        [--threshold X] [--title T] [--out DIR]
                        [--position left|center|right] [--encoder gpu|cpu]
                        [--quality high|standard|small] [--cpu-decode]
                        [--resolution source|1080|1440|2160]
```

## Layout

| Path | What it holds |
|---|---|
| `src/core/ffmpeg.js` | Finding and running ffmpeg/ffprobe, with progress |
| `src/core/analysis.js` | Frame detection, threshold, statistics, CSVs |
| `src/core/overlay.js` | The burned-in panel (ASS subtitles) |
| `src/core/pipeline.js` | One job from measuring to the overlay video |
| `src/cli.js` | Command-line front end |
| `main.js`, `preload.js` | Electron main process and the bridge to the window |
| `renderer/` | The window: HTML, CSS and script, no framework |
| `assets/fonts/` | IBM Plex fonts (SIL Open Font License), used by the window and the overlay |
