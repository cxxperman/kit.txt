// Draws the product icons from icons/sprites.json: a chunky pixel sprite, one flat orange, a dark
// upright eye, transparent background — the same language as the Kapsula critter and the Aura fish.
//   node tools/icons.js   → dist/icons/<name>.png (256 px), <name>.ico (16–256 px) and sheet.png
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const { colors, sprites } = JSON.parse(fs.readFileSync(path.join(root, 'icons', 'sprites.json'), 'utf8'));
const rgb = Object.fromEntries(Object.entries(colors).map(([k, v]) => [k, [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16))]));

// Supersampled, so the sprite stays crisp at 256 px and readable at 16 px
function render(sprite, size) {
  const cols = sprite[0].length, rows = sprite.length;
  const cell = (size * 0.94) / Math.max(cols, rows);
  const ox = (size - cell * cols) / 2, oy = (size - cell * rows) / 2;
  const S = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const gx = Math.floor((x + (sx + 0.5) / S - ox) / cell), gy = Math.floor((y + (sy + 0.5) / S - oy) / cell);
      const c = gx >= 0 && gx < cols && gy >= 0 && gy < rows ? rgb[sprite[gy][gx]] : null;
      if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
    }
    const i = (y * size + x) * 4;
    if (a) { px[i] = r / a; px[i + 1] = g / a; px[i + 2] = b / a; px[i + 3] = (a * 255) / (S * S); }
  }
  return px;
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const byte of buf) c = CRC[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}
function png(px, w, h) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function ico(sprite) {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map(s => png(render(sprite, s), s, s));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let at = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    head[e] = s & 255; head[e + 1] = s & 255; head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(images[i].length, e + 8); head.writeUInt32LE(at, e + 12);
    at += images[i].length;
  });
  return Buffer.concat([head, ...images]);
}

const out = path.join(root, 'dist', 'icons');
fs.mkdirSync(out, { recursive: true });
const names = Object.keys(sprites);
for (const name of names) {
  for (const row of sprites[name]) if (row.length !== sprites[name][0].length) throw new Error('Uneven rows in ' + name);
  fs.writeFileSync(path.join(out, name + '.png'), png(render(sprites[name], 256), 256, 256));
  fs.writeFileSync(path.join(out, name + '.ico'), ico(sprites[name]));
}
// Preview: every sprite on the dark background of the apps
const tile = 200, pad = 28, W = names.length * tile, H = tile;
const sheet = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) { sheet[i * 4] = 0x15; sheet[i * 4 + 1] = 0x15; sheet[i * 4 + 2] = 0x18; sheet[i * 4 + 3] = 255; }
names.forEach((name, n) => {
  const s = tile - pad * 2, px = render(sprites[name], s);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const a = px[(y * s + x) * 4 + 3] / 255, o = ((y + pad) * W + n * tile + pad + x) * 4;
    for (let k = 0; k < 3; k++) sheet[o + k] = px[(y * s + x) * 4 + k] * a + sheet[o + k] * (1 - a);
  }
});
fs.writeFileSync(path.join(out, 'sheet.png'), png(sheet, W, H));
console.log('Wrote ' + names.length + ' icons: ' + names.join(', '));
