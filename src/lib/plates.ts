import { crc32, deflateSync } from "node:zlib";
import {
  PALETTE_NAMES,
  PALETTES,
  STAR_COLOUR,
  type Palette,
  type PaletteName,
} from "./palettes";

export const PLATE_WIDTH = 160;
export const PLATE_HEIGHT = 60;

type Rgb = readonly [number, number, number];

const rgb = (hex: string): Rgb => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

const fnv1a = (text: string) => {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash = Math.imul(hash ^ byte, 0x01000193);
  }
  return hash >>> 0;
};

const mulberry32 = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const bayer = (size: number): number[][] => {
  if (size === 1) return [[0]];
  const half = bayer(size / 2);
  const n = half.length;
  const out = Array.from({ length: size }, () => new Array<number>(size));
  half.forEach((row, y) =>
    row.forEach((cell, x) => {
      const v = cell * 4;
      out[y][x] = v;
      out[y][x + n] = v + 2;
      out[y + n][x] = v + 3;
      out[y + n][x + n] = v + 1;
    }),
  );
  return out;
};

const BAYER_8 = bayer(8);
const threshold = (x: number, y: number) => (BAYER_8[y % 8][x % 8] + 0.5) / 64;

const skyPixel = ({
  x,
  y,
  t,
  stops,
}: {
  x: number;
  y: number;
  t: number;
  stops: readonly (readonly [number, Rgb])[];
}): Rgb => {
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, c0] = stops[i];
    const [p1, c1] = stops[i + 1];
    if (t <= p1) {
      const f = p1 === p0 ? 0 : (t - p0) / (p1 - p0);
      return f > threshold(x, y) ? c1 : c0;
    }
  }
  return stops[stops.length - 1][1];
};

const ridge = ({
  random,
  width,
  height,
  base,
  amp,
  freq,
}: {
  random: () => number;
  width: number;
  height: number;
  base: number;
  amp: number;
  freq: number;
}) => {
  const phase = [random(), random(), random()].map((r) => r * 6.28);
  return Array.from({ length: width }, (_, x) => {
    const u = (x / width) * 6.28;
    const wave =
      Math.sin(u * freq + phase[0]) * 0.6 +
      Math.sin(u * freq * 2.3 + phase[1]) * 0.3 +
      Math.sin(u * freq * 5.1 + phase[2]) * 0.1;
    return Math.trunc(height * base + height * amp * wave);
  });
};

const PNG_BIT_DEPTH = 8;
const PNG_COLOUR_TYPE_RGB = 2;
const PNG_FILTER_NONE = 0;

const pngChunk = (type: string, data: Buffer) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

const encodePng = ({
  width,
  height,
  pixels,
}: {
  width: number;
  height: number;
  pixels: Buffer;
}) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = PNG_BIT_DEPTH;
  ihdr[9] = PNG_COLOUR_TYPE_RGB;

  const stride = width * 3;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + stride);
    raw[row] = PNG_FILTER_NONE;
    pixels.copy(raw, row + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

/** The plate as raw RGB, three bytes per pixel, row by row. */
export const renderPlate = ({
  palette,
  seed,
  width = PLATE_WIDTH,
  height = PLATE_HEIGHT,
}: {
  palette: PaletteName;
  seed: number;
  width?: number;
  height?: number;
}) => {
  const p: Palette = PALETTES[palette];
  const random = mulberry32(seed);
  const below = (n: number) => Math.floor(random() * n);
  const pixels = Buffer.alloc(width * height * 3);
  const put = (x: number, y: number, [r, g, b]: Rgb) =>
    pixels.set([r, g, b], (y * width + x) * 3);

  const horizon = rgb(p.sky.horizon);
  const stops = [
    [0, rgb(p.sky.top)],
    [0.55, rgb(p.sky.middle)],
    [0.85, horizon],
    [1, horizon],
  ] as const;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      put(x, y, skyPixel({ x, y, t: y / (height - 1), stops }));
    }
  }

  if (p.stars) {
    const star = rgb(STAR_COLOUR);
    const starCount = Math.floor((width * height) / 60);
    for (let i = 0; i < starCount; i++) {
      put(below(width), below(Math.floor(height * 0.5)), star);
    }
  }

  const sun = rgb(p.sun);
  const r = Math.max(3, Math.floor(height / 7));
  const sx = Math.trunc(width * (0.2 + random() * 0.6));
  const sy = Math.trunc(height * (0.38 + random() * 0.14));
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = sx + dx;
      const y = sy + dy;
      const inside = dx * dx + dy * dy <= r * r + r * 0.6;
      if (inside && x >= 0 && x < width && y >= 0 && y < height) {
        put(x, y, sun);
      }
    }
  }

  const back = ridge({
    random,
    width,
    height,
    base: 0.64,
    amp: 0.1,
    freq: 1.3,
  });
  const front = ridge({
    random,
    width,
    height,
    base: 0.8,
    amp: 0.07,
    freq: 2.1,
  });
  const backHill = rgb(p.hills.back);
  const frontHill = rgb(p.hills.front);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      if (y >= front[x]) put(x, y, frontHill);
      else if (y >= back[x]) put(x, y, backHill);
    }
  }

  return { width, height, pixels };
};

export const drawPlate = (plate: Parameters<typeof renderPlate>[0]) =>
  encodePng(renderPlate(plate));

/** The slug seeds the landscape and, without a `plate:`, picks the palette. */
export const plateFor = ({
  id,
  data,
}: {
  id: string;
  data: { plate?: PaletteName };
}) => {
  const seed = fnv1a(id);
  const palette = data.plate ?? PALETTE_NAMES[seed % PALETTE_NAMES.length];
  return { palette, seed, url: `/plates/${id}.png` };
};
