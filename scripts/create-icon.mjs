import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
const table = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = table[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc(Buffer.concat([name, data])), 8 + data.length);
  return result;
}
const size = 256,
  raw = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    const inside = x >= 12 && x < 244 && y >= 12 && y < 244;
    const wave = [70, 110, 150, 190].some(
      (center, index) => Math.abs(x - center) < 10 && Math.abs(y - 128) < [30, 65, 47, 22][index],
    );
    const rgba = wave ? [215, 220, 255, 255] : inside ? [59, 66, 128, 255] : [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) raw[y * (size * 4 + 1) + 1 + x * 4 + c] = rgba[c];
  }
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0);
ihdr.writeUInt32BE(size, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);
mkdirSync('resources', { recursive: true });
writeFileSync('resources/icon.ico', Buffer.concat([ico, png]));
