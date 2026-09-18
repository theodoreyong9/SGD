// scripts/generate-icons.mjs — builds real PNG files for the PWA manifest.
// No canvas library: this hand-encodes valid PNGs (IHDR/IDAT/IEND, zlib via
// node:zlib, CRC32 table) and rasterizes a small graph glyph — a few nodes
// and the edges between them, the same shape the app itself renders — with
// basic circle/line math. Run: node scripts/generate-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const BG = [0x10, 0x14, 0x1c];
const ACCENT = [0xc7, 0x9a, 0x3b];
const EDGE = [0x5c, 0x7a, 0x99];

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = makeCrcTable();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function drawGraphGlyph(size) {
  const px = new Uint8ClampedArray(size * size * 4);
  const set = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const circle = (cx, cy, radius, color) => {
    for (let y = Math.floor(cy - radius); y <= cy + radius; y++) {
      for (let x = Math.floor(cx - radius); x <= cx + radius; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) set(x, y, color);
      }
    }
  };
  const line = (x0, y0, x1, y1, color, thickness) => {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      circle(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, thickness, color);
    }
  };

  // background with rounded corners
  const radius = size * 0.18;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = true;
      if (x < radius && y < radius) inside = (x - radius) ** 2 + (y - radius) ** 2 <= radius ** 2;
      else if (x > size - radius && y < radius) inside = (x - (size - radius)) ** 2 + (y - radius) ** 2 <= radius ** 2;
      else if (x < radius && y > size - radius) inside = (x - radius) ** 2 + (y - (size - radius)) ** 2 <= radius ** 2;
      else if (x > size - radius && y > size - radius) inside = (x - (size - radius)) ** 2 + (y - (size - radius)) ** 2 <= radius ** 2;
      if (inside) set(x, y, BG);
    }
  }

  // Four propositions (nodes) and the relations (edges) between them —
  // one central idea with three others connected to it, echoing how a
  // submission lands in the graph next to what it relates to.
  const cx = size / 2, cy = size / 2;
  const satellites = [0, 1, 2].map((i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / 3;
    const r = size * 0.32;
    return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
  });

  for (const [sx, sy] of satellites) line(cx, cy, sx, sy, EDGE, size * 0.012);
  line(satellites[0][0], satellites[0][1], satellites[1][0], satellites[1][1], EDGE, size * 0.01);
  for (const [sx, sy] of satellites) circle(sx, sy, size * 0.075, EDGE);
  circle(cx, cy, size * 0.12, ACCENT);

  return px;
}

function encodePNG(size) {
  const pixels = drawGraphGlyph(size);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter type 0 (none) per scanline
    for (let x = 0; x < size; x++) {
      const srcI = (y * size + x) * 4;
      const dstI = rowStart + 1 + x * 4;
      raw[dstI] = pixels[srcI];
      raw[dstI + 1] = pixels[srcI + 1];
      raw[dstI + 2] = pixels[srcI + 2];
      raw[dstI + 3] = pixels[srcI + 3];
    }
  }

  const idatData = deflateSync(raw);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('icons', { recursive: true });
for (const size of [192, 512]) {
  const buf = encodePNG(size);
  const path = `icons/icon-${size}.png`;
  writeFileSync(path, buf);
  console.log(`wrote ${path} (${buf.length} bytes)`);
}
