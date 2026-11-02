import type { Palette } from "./palettes";

export const PLATE_WIDTH = 160;
export const PLATE_HEIGHT = 60;

const W = PLATE_WIDTH;
const H = PLATE_HEIGHT;

export type Rgb = readonly [number, number, number];

export const rgb = (hex: string): Rgb => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

export const INK = {
  top: 0,
  middle: 1,
  horizon: 2,
  sun: 3,
  back: 4,
  front: 5,
} as const;

type BaseInk = (typeof INK)[keyof typeof INK];
export type Ink = number;

/** What an ink is, without its colour. Only a palette can give the colour. */
type InkRecipe =
  | { kind: "base"; ink: BaseInk }
  | { kind: "mix"; from: BaseInk; to: BaseInk; by: number }
  | {
      kind: "legible";
      over: readonly Ink[];
      from: readonly Ink[];
      min: number;
    };

const BASE_COLOURS = {
  [INK.top]: (p) => p.sky.top,
  [INK.middle]: (p) => p.sky.middle,
  [INK.horizon]: (p) => p.sky.horizon,
  [INK.sun]: (p) => p.sun,
  [INK.back]: (p) => p.hills.back,
  [INK.front]: (p) => p.hills.front,
} satisfies Record<BaseInk, (palette: Palette) => string>;

const MIX_STEPS = 8;

const linear = (channel: number) => {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

export const luminance = ([r, g, b]: Rgb) =>
  0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

export const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((u, v) => v - u);
  return (hi + 0.05) / (lo + 0.05);
};

export const mixColours = (a: Rgb, b: Rgb, by: number): Rgb => {
  const channel = (i: number) =>
    Math.round(a[i] + ((b[i] - a[i]) * by) / MIX_STEPS);
  return [channel(0), channel(1), channel(2)];
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

export type Random = ReturnType<typeof randomStream>;

/** Each purpose has its own stream, so that one cannot disturb another. */
export const randomStream = (seed: number, purpose: number) => {
  const next = mulberry32(seed ^ purpose);
  const below = (n: number) => Math.floor(next() * n);
  return {
    next,
    below,
    range: (min: number, max: number) => min + below(max - min + 1),
    pick: <T>(items: readonly T[]): T => items[below(items.length)],
    chance: (odds: number) => next() < odds,
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

export const threshold = (x: number, y: number) =>
  (BAYER_8[((y % 8) + 8) % 8][((x % 8) + 8) % 8] + 0.5) / 64;

/** The same Bayer matrix stretched along x, for water and ripples. */
export const stretched = (x: number, y: number, by: number) =>
  threshold(Math.floor(x / by), y);

export const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

export const forDisc = (r: number, each: (dx: number, dy: number) => void) => {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r * r + r * 0.6) each(dx, dy);
    }
  }
};

/** Rows of text. `.` is clear, and every other character names an ink. */
export type Sprite = readonly string[];

/** A plate holds ink indices, so a pixel can only be a known flat ink. */
export class Canvas {
  readonly pixels = new Uint8Array(W * H);
  readonly recipes: InkRecipe[] = Object.values(INK).map((ink) => ({
    kind: "base",
    ink,
  }));
  /** How far down the sky stars may fall, and whether dark skies get them. */
  stars = { limit: 0, count: 0, darkSkies: false };
  private readonly known = new Map<string, Ink>();

  private add(recipe: InkRecipe) {
    const key = JSON.stringify(recipe);
    const found = this.known.get(key);
    if (found !== undefined) return found;
    const ink = this.recipes.push(recipe) - 1;
    this.known.set(key, ink);
    return ink;
  }

  /** A fixed mix: `from`, moved `by` eighths toward `to`. */
  mix({ from, to, by }: { from: BaseInk; to: BaseInk; by: number }): Ink {
    return this.add({ kind: "mix", from, to, by });
  }

  /** The first ink of `from` that reaches `min` over `over`, or the best. */
  legible({
    over,
    from,
    min,
  }: {
    over: readonly Ink[];
    from: readonly Ink[];
    min: number;
  }): Ink {
    return this.add({ kind: "legible", over, from, min });
  }

  set(x: number, y: number, ink: Ink) {
    if (x >= 0 && x < W && y >= 0 && y < H) this.pixels[y * W + x] = ink;
  }

  get(x: number, y: number): Ink {
    return this.pixels[clamp(y, 0, H - 1) * W + clamp(x, 0, W - 1)];
  }

  rect(x0: number, y0: number, x1: number, y1: number, ink: Ink) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) this.set(x, y, ink);
    }
  }

  hline(x0: number, x1: number, y: number, ink: Ink) {
    this.rect(x0, y, x1, y, ink);
  }

  vline(x: number, y0: number, y1: number, ink: Ink) {
    this.rect(x, y0, x, y1, ink);
  }

  disc({ x, y, r, ink }: { x: number; y: number; r: number; ink: Ink }) {
    forDisc(r, (dx, dy) => this.set(x + dx, y + dy, ink));
  }

  fillBelow(contour: readonly number[], ink: Ink) {
    for (let x = 0; x < W; x++) this.rect(x, contour[x], x, H - 1, ink);
  }

  sprite({
    rows,
    x,
    y,
    inks,
    flip = false,
  }: {
    rows: Sprite;
    x: number;
    y: number;
    inks: Readonly<Record<string, Ink>>;
    flip?: boolean;
  }) {
    rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) {
        const cell = flip ? row[row.length - 1 - i] : row[i];
        if (cell !== ".") this.set(x + i, y + j, inks[cell]);
      }
    });
  }
}

/** The colour of every ink of `canvas` in `palette`. */
export const resolveInks = (
  { recipes }: Pick<Canvas, "recipes">,
  palette: Palette,
) => {
  const colours: Rgb[] = [];
  for (const recipe of recipes) {
    if (recipe.kind === "base") {
      colours.push(rgb(BASE_COLOURS[recipe.ink](palette)));
    } else if (recipe.kind === "mix") {
      colours.push(
        mixColours(colours[recipe.from], colours[recipe.to], recipe.by),
      );
    } else {
      const worst = (ink: Ink) =>
        Math.min(...recipe.over.map((o) => contrast(colours[ink], colours[o])));
      const best = [...recipe.from].sort((a, b) => worst(b) - worst(a))[0];
      const first = recipe.from.find((i) => worst(i) >= recipe.min);
      colours.push(colours[first ?? best]);
    }
  }
  return colours;
};

/** Monotone cubic through control points, so land never overshoots. */
export const spline = (points: readonly (readonly [number, number])[]) => {
  const n = points.length;
  const d = points
    .slice(0, -1)
    .map(([x, y], i) => (points[i + 1][1] - y) / (points[i + 1][0] - x));
  const m = points.map((_, i) => {
    if (i === 0) return d[0];
    if (i === n - 1) return d[n - 2];
    return d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  });
  const out = new Array<number>(W);
  for (let x = 0; x < W; x++) {
    let i = 0;
    while (i < n - 2 && x > points[i + 1][0]) i++;
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const h = x1 - x0;
    const t = clamp((x - x0) / h);
    const [t2, t3] = [t * t, t * t * t];
    out[x] =
      (2 * t3 - 3 * t2 + 1) * y0 +
      (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * y1 +
      (t3 - t2) * h * m[i + 1];
  }
  return out;
};

/** Rounds a contour and removes one-pixel bumps and notches. */
export const tidy = (raw: readonly number[]) => {
  const h = raw.map(Math.round);
  for (let pass = 0; pass < 3; pass++) {
    for (let x = 1; x < W - 1; x++) {
      if (h[x - 1] === h[x + 1] && h[x] !== h[x - 1]) h[x] = h[x - 1];
    }
  }
  return h;
};

/** Long, slow land: a few alternating knots, nothing like a sum of sines. */
export const rolling = (
  random: Random,
  { base, amp, knots }: { base: number; amp: number; knots: number },
) => {
  const points: [number, number][] = [];
  const step = (W + 40) / knots;
  let up = random.chance(0.5);
  for (let i = 0; i <= knots; i++) {
    const inner = i > 0 && i < knots;
    const x = -20 + i * step + (inner ? (random.next() - 0.5) * step * 0.4 : 0);
    points.push([
      x,
      base + (up ? -1 : 1) * amp * (0.45 + random.next() * 0.55),
    ]);
    up = !up;
  }
  return tidy(spline(points));
};

/** Levels a stretch of ground, easing back into the contour at both sides. */
export const levelled = (
  contour: readonly number[],
  { x0, x1, ease }: { x0: number; x1: number; ease: number },
) => {
  const a = Math.max(0, x0);
  const b = Math.min(W - 1, x1);
  const level = contour[Math.round((a + b) / 2)];
  const out = [...contour];
  for (let x = 0; x < W; x++) {
    const d = x < a ? a - x : x > b ? x - b : 0;
    if (d === 0) out[x] = level;
    else if (d < ease) {
      const t = d / ease;
      out[x] = level + (contour[x] - level) * (t * t * (3 - 2 * t));
    }
  }
  return tidy(out);
};

/** The shared sky: three stops, dithered, measured to the horizon row. */
export const sky = (canvas: Canvas, horizonRow: number) => {
  const stops = [
    [0, INK.top],
    [0.55, INK.middle],
    [0.9, INK.horizon],
    [1, INK.horizon],
  ] as const;
  for (let y = 0; y < H; y++) {
    const t = clamp(y / Math.max(1, horizonRow - 1));
    const i = Math.max(0, stops.findIndex(([stop]) => t <= stop) - 1);
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    const f = (t - t0) / (t1 - t0);
    for (let x = 0; x < W; x++) {
      canvas.set(x, y, f > threshold(x, y) ? c1 : c0);
    }
  }
};

export const crescent = (
  canvas: Canvas,
  {
    x,
    y,
    r,
    ink,
    side,
  }: { x: number; y: number; r: number; ink: Ink; side: 1 | -1 },
) => {
  const cut = Math.max(2, Math.round(r * 0.55));
  forDisc(r, (dx, dy) => {
    const [ox, oy] = [dx - side * cut, dy + 1];
    if (ox * ox + oy * oy > r * r + r * 0.6) {
      canvas.set(x + dx, y + dy, ink);
    }
  });
};
