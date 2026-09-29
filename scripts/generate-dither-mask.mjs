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
// Writes the mask twice: an SVG for eyeballing, and a CSS data URI that the site
// actually paints through. Both come from one run, so they cannot drift.
//
// The mask is vector, not a PNG: Safari on iOS ignores image-rendering for a
// mask and smooths a scaled raster, which blurs every dot.

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
  // The SVG is the inspectable copy of the mask. The CSS holds the same markup
  // as a data URI, because a mask-image is not render-blocking: a separate
  // request would let the band paint solid for a frame before it dithers.
  out: "public/dither-mask.svg",
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
  --out      SVG output path, relative to the repo root               (${DEFAULTS.out})
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

function build({ width, height, angle, hold }) {
  const threshold = bayer(8);
  const rad = (angle * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  // Projection onto the angle spans [min, max]; shift and scale it to [0, 1].
  const span = Math.abs(dx) + Math.abs(dy);
  const min = Math.min(0, dx) + Math.min(0, dy);

  const opaque = Array.from({ length: height }, () => new Array(width));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const v = (y + 0.5) / height;
      // Coverage along the angle, then squeeze the ramp so the far end holds
      // at full coverage instead of dithering all the way to the corner.
      const ramp = (u * dx + v * dy - min) / span;
      const t = Math.min(1, ramp / (1 - hold));
      const bias = (threshold[y % 8][x % 8] + 0.5) / 64;
      opaque[y][x] = t > bias;
    }
  }

  return opaque;
}

/** One rectangle per horizontal run of opaque dots. */
function encodeSvg(opaque) {
  const height = opaque.length;
  const width = opaque[0].length;
  const runs = opaque.flatMap((row, y) =>
    row.flatMap((on, x) => {
      if (!on || row[x - 1]) return [];
      let end = x;
      while (row[end]) end++;
      return [`M${x} ${y}h${end - x}v1h-${end - x}z`];
    }),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges"><path d="${runs.join("")}"/></svg>`;
}

const opts = parseArgs(process.argv.slice(2));
// One extra copy of the last row sits below the mask. At fractional device
// scales the renderer samples one row past the tile and wraps to the opaque
// first row; the copy takes that bleed, and the element clips it.
const mask = build(opts);
const svg = encodeSvg([...mask, mask[mask.length - 1]]);

const out = resolve(ROOT, opts.out);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${svg}\n`);

const css = resolve(ROOT, opts.css);
mkdirSync(dirname(css), { recursive: true });
writeFileSync(
  css,
  `/* Generated by scripts/generate-dither-mask.mjs — do not edit. */
:root {
  --dither-mask: url("data:image/svg+xml,${encodeURIComponent(svg)}");
}
`,
);

const summary = `${opts.width}×${opts.height}, gradient ${opts.angle}°, hold ${opts.hold}`;
console.log(`${opts.out} — ${summary}`);
console.log(`${opts.css} — inlined ${svg.length} B mask, no request at paint`);
