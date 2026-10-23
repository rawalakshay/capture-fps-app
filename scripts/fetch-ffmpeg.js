#!/usr/bin/env node
'use strict';
// Fetch the ffmpeg build the installer bundles (Gyan "full": GPL, includes libass
// for the overlay and libplacebo for GPU upscaling) into vendor/ffmpeg.
// Windows only; needs nothing but Node and PowerShell.
//   node scripts/fetch-ffmpeg.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// Pinned, so every build of the app ships the same, verified ffmpeg. To move to a
// newer release: change VERSION, run once to see the new hash, then pin it here.
// gyan.dev ships the full build as .7z only; its GitHub mirror has the same build as a zip.
const VERSION = '9.0.2';
const SHA256 = '759d0a9831c436a0eb331ad36f236c06cb04aaa0005da46571f0e9d3d9206f6b';
const URL = `https://github.com/GyanD/codexffmpeg/releases/download/${VERSION}/ffmpeg-${VERSION}-full_build.zip`;

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
const DEST = path.join(__dirname, '..', 'vendor', 'ffmpeg');

/** The build in `dir` has the filters the app needs (libass overlay, libplacebo and cas upscaling), or why not. */
function verify(dir) {
  try {
    const filters = execFileSync(path.join(dir, 'ffmpeg.exe'), ['-hide_banner', '-filters']).toString();
    for (const f of ['ass', 'libplacebo', 'cas']) {
      if (!new RegExp(`^\\s*\\S*\\s+${f}\\s`, 'm').test(filters)) return `lacks the ${f} filter; expected the full build`;
    }
    if (!fs.existsSync(path.join(dir, 'ffprobe.exe'))) return 'ffprobe.exe is missing';
    return null;
  } catch (e) {
    return e.message;
  }
}

function download(url, file, hops = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 3) {
        res.resume();
        return resolve(download(res.headers.location, file, hops + 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`${url}: HTTP ${res.statusCode}`));
      const total = Number(res.headers['content-length']) || 0;
      let got = 0, shown = -1;
      res.on('data', (c) => {
        got += c.length;
        const pct = total ? Math.floor(got * 100 / total) : -1;
        if (pct !== shown && pct % 10 === 0) { shown = pct; process.stderr.write(`\r  ${pct}%`); }
      });
      res.pipe(fs.createWriteStream(file)).on('finish', () => { process.stderr.write('\n'); resolve(); }).on('error', reject);
    }).on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('download stalled for 60 s')));
  });
}

async function main() {
  // What is already there is only kept if it passes the same check as a fresh download.
  if (fs.existsSync(path.join(DEST, 'ffmpeg.exe'))) {
    const why = verify(DEST);
    if (!why) { console.log(`ffmpeg already in ${DEST}`); return; }
    console.log(`replacing ${DEST}: ${why}`);
    fs.rmSync(DEST, { recursive: true, force: true });
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-'));
  const zip = path.join(tmp, 'ffmpeg.zip');
  console.log(`downloading ${URL} (about 250 MB)`);
  await download(URL, zip);
  const got = sha256(zip);
  if (got !== SHA256) throw new Error(`SHA-256 of the download is ${got}, expected ${SHA256}; refusing to use it`);
  console.log('unpacking');
  const q = (s) => s.replace(/'/g, "''"); // a PowerShell single-quoted string doubles its quotes
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${q(zip)}' -DestinationPath '${q(tmp)}' -Force`], { stdio: 'inherit' });
  const root = fs.readdirSync(tmp).map((n) => path.join(tmp, n)).find((p) => fs.existsSync(path.join(p, 'bin', 'ffmpeg.exe')));
  if (!root) throw new Error('ffmpeg.exe not found in the archive');
  fs.mkdirSync(DEST, { recursive: true });
  for (const f of ['ffmpeg.exe', 'ffprobe.exe']) fs.copyFileSync(path.join(root, 'bin', f), path.join(DEST, f));
  for (const f of ['LICENSE', 'README.txt']) if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(DEST, f));
  fs.rmSync(tmp, { recursive: true, force: true });
  const why = verify(DEST);
  if (why) throw new Error(`the downloaded ffmpeg ${why}`);
  const banner = execFileSync(path.join(DEST, 'ffmpeg.exe'), ['-version']).toString().split(/\r?\n/)[0];
  console.log(`${banner}\n-> ${DEST}`);
}

if (require.main === module) main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
module.exports = { verify };
