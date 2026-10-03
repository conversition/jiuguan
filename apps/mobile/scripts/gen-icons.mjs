// P9-01/P10-06：生成 PWA 图标与 android launcher 图标（纯 Node PNG 编码，无图像依赖）。
// 用法：node scripts/gen-icons.mjs
// - PWA: public/icons/icon-{192,512}.png
// - android 主资源（release，蓝）：mipmap-*/ic_launcher.png + ic_launcher_round.png
// - android debug 源集（dev，橙）：src/debug/res/mipmap-*/…（applicationId 已有 .dev 后缀，图标也区分）
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

const hexToRgba = (hex) => {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1];
  if (!value) throw new Error(`颜色非法: ${hex}`);
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16), 0xff];
};

/** 画一个图标：背景 + 居中圆角 tile + 对话框三笔。round=true 时整体圆形裁剪。 */
function drawIcon(size, { background, accent, glyph = '#e8edf4', round = false }) {
  const bg = hexToRgba(background);
  const tile = hexToRgba(accent);
  const ink = hexToRgba(glyph);
  const transparent = [0, 0, 0, 0];
  const pixels = Buffer.alloc(size * size * 4);
  const margin = Math.round(size * 0.12);
  const tileEnd = size - margin;
  const inset = Math.round(size * 0.06);
  const glyphStart = margin + inset;
  const glyphEnd = tileEnd - inset;
  const barWidth = Math.max(2, Math.round(size * 0.045));
  const center = size / 2;
  const radius = size / 2 - (round ? 0 : 0);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      if (round) {
        const distance = Math.hypot(x + 0.5 - center, y + 0.5 - center);
        if (distance > radius) { pixels.set(transparent, offset); continue; }
      }
      let color = bg;
      if (x >= margin && x < tileEnd && y >= margin && y < tileEnd) color = tile;
      const barTop = glyphStart;
      const barBottom = glyphEnd;
      if (x >= glyphStart && x < glyphStart + barWidth && y >= barTop && y < barBottom) color = ink;
      if (y >= glyphStart && y < glyphStart + barWidth && x >= glyphStart && x < glyphEnd) color = ink;
      if (y >= barBottom - barWidth && y < barBottom && x >= glyphStart && x < glyphStart + Math.round((glyphEnd - glyphStart) * 0.55)) color = ink;
      pixels.set(color, offset);
    }
  }
  return encodePng(size, pixels);
}

const mobileDir = resolve(import.meta.dirname ?? '.', '..');
const webPublic = resolve(mobileDir, '..', 'web', 'public', 'icons');

// 1) PWA 图标（web）：蓝
mkdirSync(webPublic, { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(join(webPublic, `icon-${size}.png`), drawIcon(size, {
    background: '#0f1115', accent: '#2b6cb3',
  }));
  console.log(`pwa icon-${size}.png written`);
}

// 2) android launcher：release（主资源，蓝）与 debug 源集（dev，橙）
const DENSITIES = [
  ['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192],
];
const variants = [
  { resDir: join(mobileDir, 'android', 'app', 'src', 'main', 'res'), accent: '#2b6cb3', label: 'release' },
  { resDir: join(mobileDir, 'android', 'app', 'src', 'debug', 'res'), accent: '#d97706', label: 'debug(dev)' },
];
for (const { resDir, accent, label } of variants) {
  for (const [density, size] of DENSITIES) {
    const dir = join(resDir, `mipmap-${density}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ic_launcher.png'), drawIcon(size, {
      background: '#0f1115', accent,
    }));
    writeFileSync(join(dir, 'ic_launcher_round.png'), drawIcon(size, {
      background: '#0f1115', accent, round: true,
    }));
  }
  console.log(`android ${label} launcher icons written (${DENSITIES.length} densities)`);
}
