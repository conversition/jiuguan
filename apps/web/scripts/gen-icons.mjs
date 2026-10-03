// P9-02：生成 PWA 图标（纯 Node PNG 编码，无图像依赖）。用法：node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const bg = [0x0f, 0x11, 0x15, 0xff];
  const tile = [0x2b, 0x6c, 0xb3, 0xff];   // 蓝
  const glyph = [0xe8, 0xed, 0xf4, 0xff];  // 浅
  const margin = Math.round(size * 0.12);
  const tileEnd = size - margin;
  const inset = Math.round(size * 0.06);
  const glyphStart = margin + inset;
  const glyphEnd = tileEnd - inset;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      let color = bg;
      if (x >= margin && x < tileEnd && y >= margin && y < tileEnd) color = tile;
      // 中央竖排三笔（抽象"对话框"）
      const barWidth = Math.max(2, Math.round(size * 0.045));
      const barTop = glyphStart;
      const barBottom = glyphEnd;
      if (x >= glyphStart && x < glyphStart + barWidth && y >= barTop && y < barBottom) color = glyph;
      if (y >= glyphStart && y < glyphStart + barWidth && x >= glyphStart && x < glyphEnd) color = glyph;
      if (y >= barBottom - barWidth && y < barBottom && x >= glyphStart && x < glyphStart + Math.round((glyphEnd - glyphStart) * 0.55)) color = glyph;
      pixels.set(color, offset);
    }
  }
  return encodePng(size, pixels);
}

const outDir = resolve(import.meta.dirname ?? '.', '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(join(outDir, `icon-${size}.png`), drawIcon(size));
  console.log(`icon-${size}.png written`);
}
