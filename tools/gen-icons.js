// 用 Node 内置 zlib 手写 PNG 编码器，生成扩展图标（无外部依赖）。
// 旧版图标设计：粉色(#fb7299)圆角方块 + 白色下载箭头（下载工具品牌标识）。
// 新版图标（哔哩喵 / Bili-Mux）：粉色圆角方块 + 白色猫脸 + 下载元素，
//   PNG 由 AI 生成后 sips 缩放，SVG 手绘在 icon.svg 中。本脚本保留用于快速重绘旧版。
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const PINK = [251, 114, 153];   // #fb7299
const WHITE = [255, 255, 255];

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function drawIcon(S) {
  const buf = Buffer.alloc(S * S * 4); // 全透明
  const set = (x, y, rgb) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2]; buf[i + 3] = 255;
  };
  const px = (v) => Math.round(v * S);

  // 1) 粉色圆角方块背景
  const r = px(0.22);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const inX = x >= r || x < S - r ? true : false;
      const inY = y >= r || y < S - r ? true : false;
      let inside = inX && inY;
      if (!inside) {
        // 圆角区域：检查到最近圆角圆心的距离
        const cx = x < r ? r : (x >= S - r ? S - 1 - r : x);
        const cy = y < r ? r : (y >= S - r ? S - 1 - r : y);
        const dx = x - cx, dy = y - cy;
        inside = dx * dx + dy * dy <= r * r;
      }
      if (inside) set(x, y, PINK);
    }
  }

  // 2) 白色下载箭头
  const cx = S / 2;
  const shaftT = px(0.12), yTop = px(0.20);
  const headBase = px(0.58), apex = px(0.70);
  const headHalf = px(0.18);
  const trayY0 = px(0.77), trayY1 = px(0.83), trayHalf = px(0.28);

  // 竖杆
  for (let y = yTop; y < headBase; y++)
    for (let x = Math.round(cx - shaftT / 2); x < Math.round(cx + shaftT / 2); x++) set(x, y, WHITE);
  // 箭头三角（向下）
  for (let y = headBase; y <= apex; y++) {
    const t = (y - headBase) / (apex - headBase);
    const halfW = headHalf * t;
    for (let x = Math.round(cx - halfW); x <= Math.round(cx + halfW); x++) set(x, y, WHITE);
  }
  // 底部托盘横条
  for (let y = trayY0; y <= trayY1; y++)
    for (let x = Math.round(cx - trayHalf); x <= Math.round(cx + trayHalf); x++) set(x, y, WHITE);

  return buf;
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
[16, 48, 128].forEach((s) => {
  const png = encodePNG(s, s, drawIcon(s));
  const f = path.join(outDir, `icon${s}.png`);
  fs.writeFileSync(f, png);
  console.log('wrote', f, png.length, 'bytes');
});
