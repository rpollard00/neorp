// Generates the ordered-dither mask used by the site background.
//
// The mask is colorless on purpose: it is a 1-bit ordered dither of a linear
// gradient, so CSS can paint any two theme tokens through it.
//
//   bun run dither                 # defaults
//   bun run dither -- --angle 135  # tilt the gradient
//   bun run dither -- --width 640  # finer dither dots
//
// Output: public/dither-mask.png (alpha 0 or 255, nearest-neighbour friendly).

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS = {
  // Mask resolution. One mask pixel becomes one dither dot on screen, so a
  // smaller mask means chunkier dots.
  width: 480,
  aspect: 16 / 9,
  // Degrees, y grows downward: 0 = left to right, 90 = top to bottom.
  angle: 90,
  out: "public/dither-mask.png",
};

const USAGE = `
Usage: bun run dither [-- width aspect angle out]

  --width    mask width in pixels; one mask pixel is one dither dot  (${DEFAULTS.width})
  --aspect   mask width / height                                     (${DEFAULTS.aspect})
  --angle    gradient direction in degrees, y grows downward          (${DEFAULTS.angle})
             0 = left to right, 90 = top to bottom
  --out      output path, relative to the repo root                  (${DEFAULTS.out})
`;

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=");
    const value = inline ?? argv[++i];
    if (!flag.startsWith("--")) continue;
    const key = flag.slice(2);
    if (!(key in opts)) throw new Error(`Unknown option: ${flag}`);
    opts[key] = key === "out" ? value : Number(value);
  }
  return opts;
}

/** Recursive Bayer matrix, normalised to [0, 1). */
function bayer(size) {
  if (size === 1) return [[0]];
  const half = bayer(size / 2);
  const n = half.length;
  const out = Array.from({ length: size }, () => new Array(size));
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = half[y][x] * 4;
      out[y][x] = v;
      out[y][x + n] = v + 2;
      out[y + n][x] = v + 3;
      out[y + n][x + n] = v + 1;
    }
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  // 10-12: deflate, adaptive filtering, no interlace

  // One filter byte (0 = none) per scanline.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const from = y * width * 4;
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, from, from + width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function build({ width, aspect, angle }) {
  const height = Math.round(width / aspect);
  const threshold = bayer(8);
  const rad = (angle * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const span = Math.abs(dx) + Math.abs(dy);

  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const v = (y + 0.5) / height;
      const t = (u * dx + v * dy) / span;
      const bias = (threshold[y % 8][x % 8] + 0.5) / 64;
      const i = (y * width + x) * 4 + 3;
      rgba[i] = t > bias ? 255 : 0;
    }
  }

  return { width, height, rgba };
}

const opts = parseArgs(process.argv.slice(2));
const { width, height, rgba } = build(opts);
const out = resolve(ROOT, opts.out);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, encodePng(width, height, rgba));
console.log(
  `${opts.out} — ${width}×${height}, gradient ${opts.angle}° (${(
    rgba.length / 1024
  ).toFixed(0)} KiB raw)`,
);
