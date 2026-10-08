// Draws KAI's icon set — the PNG/ICO files Tauri needs.
//
// ORIGINAL artwork: the mark is the same character the island draws, rasterised
// here with no dependencies (node:zlib only). It is a squircle "core" with a
// single horizontal iris band and a thin kernel ring — nothing is traced,
// sampled or derived from another app's assets.
//
//   node scripts/gen-icons.mjs
//
// MIT.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");

// ── Palette ───────────────────────────────────────────────────────────────────

const CORE_TOP = [42, 51, 82]; // #2A3352
const CORE_BOTTOM = [14, 17, 32]; // #0E1120
const RIM = [180, 229, 255]; // #B4E5FF
const BAND = [217, 245, 255]; // #D9F5FF
const ACCENT = [56, 189, 248]; // #38BDF8

const SS = 4; // supersampling factor per axis

/** Squircle membership test in unit coordinates (exponent 4 = a rounded square). */
function insideSquircle(x, y, r, exp = 4) {
  return Math.pow(Math.abs(x / r), exp) + Math.pow(Math.abs(y / r), exp) <= 1;
}

/** Rounded-rect (capsule) membership test. */
function insidePill(x, y, hw, hh) {
  const r = Math.min(hw, hh);
  const cx = Math.max(-hw + r, Math.min(hw - r, x));
  const cy = Math.max(-hh + r, Math.min(hh - r, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

const mix = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t);

function renderKai(size) {
  const px = new Uint8Array(size * size * 4);
  const c = size / 2;
  const R = size * 0.36; // core half-extent
  const rimW = R * 0.075;
  const bandHW = R * 0.62; // iris band half-width
  const bandHH = Math.max(size * 0.035, R * 0.13); // iris band half-height

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rimHits = 0;
      let coreHits = 0;
      let bandHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px0 = x + (sx + 0.5) / SS - c;
          const py0 = y + (sy + 0.5) / SS - c;

          // Rim first: the core silhouette grown by rimW.
          if (!insideSquircle(px0, py0, R + rimW)) continue;
          rimHits++;
          if (!insideSquircle(px0, py0, R)) continue;
          coreHits++;

          if (insidePill(px0, py0, bandHW, bandHH)) bandHits++;
        }
      }

      const total = SS * SS;
      if (rimHits === 0) continue;

      const rimA = rimHits / total;
      const coreA = coreHits / total;
      const bandA = bandHits / Math.max(1, coreHits);

      // Core gradient: top-left dark indigo → bottom-right near-black.
      const t = Math.min(1, Math.max(0, ((x - c) * 0.45 + (y - c) * 0.9) / (2 * R) + 0.5));
      let col = mix(CORE_TOP, CORE_BOTTOM, t);

      // Rim glows underneath the core edge and over its outline.
      col = mix(col, RIM, coreA > 0 ? 0 : 0.85);

      if (bandA > 0) {
        // The band brightens towards its middle, ending on the accent colour.
        const inner = 1 - Math.min(1, Math.abs(x - c) / bandHW);
        col = mix(ACCENT, BAND, 0.35 + inner * 0.65);
        col = mix(col, BAND, bandA);
      }

      const o = (y * size + x) * 4;
      px[o] = Math.round(col[0]);
      px[o + 1] = Math.round(col[1]);
      px[o + 2] = Math.round(col[2]);
      px[o + 3] = Math.round(Math.min(1, rimA) * 255);
    }
  }
  return px;
}

// ── PNG encoder (no dependencies) ─────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── ICO container (PNG-in-ICO, Windows Vista and later) ───────────────────────

function encodeICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// ── Go ────────────────────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true });

const png = (size) => encodePNG(size, renderKai(size));

const files = {
  "32x32.png": png(32),
  "128x128.png": png(128),
  "128x128@2x.png": png(256),
  "icon.png": png(512),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(OUT, name), data);
  console.log(`${name} — ${data.length} bytes`);
}

const ico = encodeICO([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: png(size) })));
writeFileSync(join(OUT, "icon.ico"), ico);
console.log(`icon.ico — ${ico.length} bytes`);
