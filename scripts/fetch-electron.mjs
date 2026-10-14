// Fallback for networks that stall on a single large release download.
// All bytes are verified against the checksum shipped in the pinned official npm package.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { version } = require('electron/package.json');
const name = `electron-v${version}-win32-x64.zip`;
const expected = require('electron/checksums.json')[name];
if (!expected || process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Windows x64 checksum is required');
const url = process.argv.includes('--mirror')
  ? `https://npmmirror.com/mirrors/electron/${version}/${name}`
  : `https://github.com/electron/electron/releases/download/v${version}/${name}`;
const response = await fetch(url, {
  headers: { Range: 'bytes=0-0' },
  signal: AbortSignal.timeout(20000),
});
if (response.status !== 206) throw new Error(`Release unavailable: ${response.status}`);
const total = Number(response.headers.get('content-range')?.split('/')[1]);
await response.body.cancel();
if (!total || total > 500_000_000) throw new Error('Unexpected artifact size');
const chunkSize = 1024 * 1024;
const chunks = new Array(Math.ceil(total / chunkSize));
let next = 0,
  done = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < chunks.length) {
      const index = next++;
      const start = index * chunkSize,
        end = Math.min(total - 1, start + chunkSize - 1);
      for (let attempt = 0; ; attempt++) {
        try {
          const part = await fetch(url, {
            headers: { Range: `bytes=${start}-${end}` },
            signal: AbortSignal.timeout(60000),
          });
          if (part.status !== 206) throw new Error(`Expected partial response, got ${part.status}`);
          const bytes = Buffer.from(await part.arrayBuffer());
          if (bytes.length !== end - start + 1) throw new Error('Incomplete artifact range');
          chunks[index] = bytes;
          done++;
          if (done % 10 === 0 || done === chunks.length)
            console.log(`Electron download: ${done}/${chunks.length} parts`);
          break;
        } catch (e) {
          if (attempt >= 2) throw e;
        }
      }
    }
  }),
);
const artifact = Buffer.concat(chunks);
if (createHash('sha256').update(artifact).digest('hex') !== expected)
  throw new Error('Electron SHA256 verification failed');
mkdirSync('.cache/electron', { recursive: true });
const zip = resolve('.cache/electron', name);
writeFileSync(zip, artifact);
console.log('Official SHA256 verified');
await require('@electron-internal/extract-zip').extract(zip, {
  dir: resolve('node_modules/electron/dist'),
});
writeFileSync('node_modules/electron/path.txt', 'electron.exe');
console.log(`Electron ${version} installed`);
