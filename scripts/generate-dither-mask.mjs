// Generates the ordered-dither mask used by the header ramp.
//
// The mask is colorless on purpose: it is a 1-bit ordered dither of a linear
// gradient, so CSS can paint any two theme tokens through it. It is mostly
// opaque at the top and fades to fully transparent at the bottom, which reads
// as "solid header colour, dithered into the solid body colour".
//
//   bun run dither                    # defaults
//   bun run dither -- --hold 0        # no solid cap, dither from the first row
//   bun run dither -- --height 270    # a mask for a full-page gradient instead
//
// Writes the mask twice: a PNG for eyeballing, and a CSS data URI that the site
// actually paints through. Both come from one run, so they cannot drift.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS = {
  // Mask resolution. One mask pixel becomes one dither dot on screen, so a
  // smaller mask means chunkier dots.
  width: 480,
  height: 40,
  // Degrees, y grows downward: 0 = left to right, 90 = top to bottom,
  // 270 = bottom to top. Coverage grows along the angle.
  angle: 270,
  // Fraction of the ramp held at full coverage at the far end of the angle.
  // 0.62 puts the solid/dither boundary at the header's bottom edge, so the
  // nav sits on solid colour and the dither runs in the gap above the h1.
  hold: 0.62,
  // The PNG is the inspectable copy of the mask. The CSS holds the same bytes
  // as a data URI, because a mask-image is not render-blocking: a separate
  // request would let the band paint solid for a frame before it dithers.
  out: "public/dither-mask.png",
  css: "src/styles/dither-mask.css",
};

const USAGE = `
Usage: bun run dither [-- width height angle hold out css]

  --width    mask width in pixels; one mask pixel is one dither dot  (${DEFAULTS.width})
  --height   mask height in pixels                                   (${DEFAULTS.height})
  --angle    gradient direction in degrees, y grows downward          (${DEFAULTS.angle})
             0 = left to right, 90 = top to bottom, 270 = bottom to top;
             coverage grows along the angle
  --hold     fraction held solid at the far end of the angle          (${DEFAULTS.hold})
  --out      PNG output path, relative to the repo root               (${DEFAULTS.out})
  --css      CSS output path; holds the inlined data URI              (${DEFAULTS.css})
`;

const STRING_OPTIONS = new Set(["out", "css"]);

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
    opts[key] = STRING_OPTIONS.has(key) ? value : Number(value);
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

function build({ width, height, angle, hold }) {
  const threshold = bayer(8);
  const rad = (angle * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  // Projection onto the angle spans [min, max]; shift and scale it to [0, 1].
  const span = Math.abs(dx) + Math.abs(dy);
  const min = Math.min(0, dx) + Math.min(0, dy);

  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const v = (y + 0.5) / height;
      // Coverage along the angle, then squeeze the ramp so the far end holds
      // at full coverage instead of dithering all the way to the corner.
      const ramp = (u * dx + v * dy - min) / span;
      const t = Math.min(1, ramp / (1 - hold));
      const bias = (threshold[y % 8][x % 8] + 0.5) / 64;
      const i = (y * width + x) * 4 + 3;
      rgba[i] = t > bias ? 255 : 0;
    }
  }

  return { width, height, rgba };
}

const opts = parseArgs(process.argv.slice(2));
const { width, height, rgba } = build(opts);
const png = encodePng(width, height, rgba);

const out = resolve(ROOT, opts.out);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);

const css = resolve(ROOT, opts.css);
mkdirSync(dirname(css), { recursive: true });
writeFileSync(
  css,
  `/* Generated by scripts/generate-dither-mask.mjs — do not edit. */
:root {
  --dither-mask: url("data:image/png;base64,${png.toString("base64")}");
}
`,
);

const summary = `${width}×${height}, gradient ${opts.angle}°, hold ${opts.hold}`;
console.log(`${opts.out} — ${summary}`);
console.log(`${opts.css} — inlined ${png.length} B mask, no request at paint`);
