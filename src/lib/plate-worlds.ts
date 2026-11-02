import {
  clamp,
  crescent,
  forDisc,
  INK,
  PLATE_HEIGHT as H,
  PLATE_WIDTH as W,
  sky,
  spline,
  threshold,
  pixelContour,
  type Canvas,
  type Ink,
  type Random,
} from "./plate-canvas";
import type { WorldName } from "./scenes";

export type PaintWorld = (canvas: Canvas, random: Random) => void;

const heavens = (canvas: Canvas, row: number, count = 30) => {
  sky(canvas, row);
  canvas.stars = {
    lastRow: Math.round(row * 0.75),
    count,
    alsoOnDarkSky: true,
  };
};

const CLEAR_OF_HORIZON = 1.4;

const planetInks = (canvas: Canvas) => {
  const pale = (by: number) =>
    canvas.mix({ from: INK.horizon, to: INK.sun, by });
  const hill = (by: number) =>
    canvas.mix({ from: INK.back, to: INK.horizon, by });
  const face = canvas.legible({
    over: [[INK.horizon, 1]],
    from: [hill(5), pale(3)],
    min: CLEAR_OF_HORIZON,
  });
  const shade = canvas.legible({
    over: [[face, 1]],
    from: [hill(3), pale(1)],
    min: 1.2,
  });
  return { face, shade };
};

const plain = (
  canvas: Canvas,
  random: Random,
  { row, keepClear = W / 2 }: { row: number; keepClear?: number },
) => {
  canvas.rect(0, row, W - 1, H - 1, INK.back);
  if (random.chance(0.55)) {
    const dir = keepClear < W / 2 ? -1 : 1;
    const edge = dir < 0 ? W : 0;
    const reach = random.range(26, 40);
    const tall = random.range(3, 5);
    const far = canvas.mix({ from: INK.back, to: INK.horizon, by: 2 });
    for (let i = 0; i < reach; i++) {
      const fall = (i - reach * 0.55) / (reach * 0.3);
      const lift =
        i < reach * 0.55 ? tall : Math.max(0, Math.round(tall * (1 - fall)));
      if (lift > 0) {
        canvas.vline(edge + dir * i, row - lift, row - 1, far);
      }
    }
  }
  const a = random.range(-10, 60);
  const near = pixelContour(
    spline([
      [-20, row + 11],
      [a + 20, row + 9],
      [a + 90, row + 13],
      [200, row + 8],
    ]),
  );
  canvas.fillBelow(near, INK.front);
  canvas.clearSpecks({
    rows: [row - 6, H],
    keep: [INK.top, INK.middle, INK.horizon, INK.sun],
  });
};

type Ellipse = {
  x: number;
  y: number;
  a: number;
  b: number;
  tilt: number;
  lower: boolean;
  ink: Ink;
  limit: number;
};

/** Traces an ellipse column by column and fills gaps, so no line breaks. */
const arc = (canvas: Canvas, e: Ellipse) => {
  let last: number | undefined;
  for (let i = -Math.floor(e.a); i <= Math.floor(e.a); i++) {
    const v = e.b * Math.sqrt(Math.max(0, 1 - (i / e.a) ** 2));
    const y = Math.round(e.y + i * e.tilt + (e.lower ? v : -v));
    const from = last ?? y;
    for (let j = Math.min(from, y); j <= Math.max(from, y); j++) {
      if (j < e.limit) canvas.set(e.x + i, j, e.ink);
    }
    last = y;
  }
};

const ringed: PaintWorld = (canvas, random) => {
  const row = random.range(44, 46);
  heavens(canvas, row);
  const left = random.chance(0.5);
  const x = left ? random.range(44, 62) : random.range(98, 116);
  const r = random.range(15, 18);
  const y = row - random.range(4, 8);
  const { face: lit, shade: band } = planetInks(canvas);
  const dark = canvas.legible({
    over: [
      [INK.middle, 0.5],
      [INK.horizon, 0.5],
    ],
    from: [
      canvas.mix({ from: INK.back, to: INK.front, by: 2 }),
      INK.front,
      band,
    ],
    min: CLEAR_OF_HORIZON,
  });
  const ringInk = canvas.mix({ from: INK.horizon, to: INK.sun, by: 4 });
  const tilt = random.pick([0, 1 / 6, -1 / 6, 1 / 5, -1 / 5]);
  const a = Math.round(r * 1.85);
  const b = Math.round(r * 0.36) + 1;
  const side = left ? 1 : -1;
  const ring = (lower: boolean) => {
    const shared = { x, tilt, lower, limit: row };
    arc(canvas, { ...shared, y, a, b, ink: ringInk });
    arc(canvas, {
      ...shared,
      y: y + (lower ? 1 : -1),
      a: a - 1,
      b,
      ink: ringInk,
    });
    arc(canvas, { ...shared, y, a: a - 5, b: b - 1, ink: band });
  };
  ring(false);
  const cut = Math.round(r * 0.45);
  forDisc(r, (dx, dy) => {
    const [ox, oy] = [dx + side * cut, dy + 2];
    const night = ox * ox + oy * oy > r * r + r;
    const stripe = (dy + r + 2) % 9 < 2;
    const ink = night ? dark : stripe ? band : lit;
    if (y + dy < row) canvas.set(x + dx, y + dy, ink);
  });
  ring(true);
  plain(canvas, random, { row, keepClear: x });
};

const moons: PaintWorld = (canvas, random) => {
  const row = random.range(45, 47);
  heavens(canvas, row);
  const left = random.chance(0.5);
  const x = left ? random.range(34, 54) : random.range(106, 126);
  const y = random.range(19, 23);
  const r = 13;
  const { face, shade } = planetInks(canvas);
  const mirror = left ? 1 : -1;
  canvas.disc({ x, y, r, ink: face });
  forDisc(r, (dx, dy) => {
    const [ox, oy] = [dx + mirror * 7, dy + 4];
    if (ox * ox + oy * oy > r * r + 5) canvas.set(x + dx, y + dy, shade);
  });
  for (const [dx, dy, s] of [
    [-4, -5, 2],
    [3, 2, 3],
  ]) {
    canvas.disc({ x: x + mirror * dx, y: y + dy, r: s, ink: shade });
  }
  for (const [dx, dy] of [
    [-8, 4],
    [1, -9],
    [-2, 8],
  ]) {
    const px = x + mirror * dx;
    canvas.rect(px, y + dy, px + 1, y + dy + 1, shade);
  }
  crescent(canvas, {
    x: x + mirror * random.range(30, 42),
    y: y - random.range(4, 9),
    r: 5,
    ink: INK.sun,
    side: left ? -1 : 1,
  });
  plain(canvas, random, { row, keepClear: x });
};

const monolith: PaintWorld = (canvas, random) => {
  const row = random.range(45, 47);
  heavens(canvas, row, 24);
  const left = random.chance(0.5);
  const x = left ? random.range(44, 58) : random.range(98, 112);
  const w = random.range(9, 12);
  const top = random.range(13, 18);
  canvas.disc({ x: left ? x + 60 : x - 50, y: row - 13, r: 6, ink: INK.sun });
  plain(canvas, random, { row, keepClear: x });
  const dir = left ? -1 : 1;
  for (let y = row; y < H; y++) {
    const a = Math.round(x + dir * (y - row) * 2.4);
    canvas.hline(a, a + w, y, INK.front);
  }
  canvas.clearSpecks({
    rows: [row, H],
    keep: [INK.top, INK.middle, INK.horizon, INK.sun],
  });
  canvas.rect(x, top, x + w, row - 1, INK.front);
  canvas.vline(
    left ? x + w : x,
    top,
    row - 1,
    canvas.mix({ from: INK.front, to: INK.sun, by: 4 }),
  );
};

const gate: PaintWorld = (canvas, random) => {
  const row = random.range(46, 48);
  heavens(canvas, row, 24);
  const left = random.chance(0.5);
  const x = left ? random.range(44, 58) : random.range(102, 116);
  const outer = 22;
  const inner = 17;
  const y = row - 17;
  const beyond = canvas.mix({ from: INK.horizon, to: INK.sun, by: 4 });
  const through = canvas.mix({ from: INK.middle, to: INK.horizon, by: 4 });
  forDisc(inner, (dx, dy) => {
    const py = y + dy;
    if (py >= row) return;
    const f = (py - (y - inner)) / (inner * 1.6);
    canvas.set(x + dx, py, f > threshold(x + dx, py) ? beyond : through);
  });
  const edge = canvas.mix({ from: INK.front, to: INK.back, by: 5 });
  for (let dy = -outer; dy <= outer; dy++) {
    for (let dx = -outer; dx <= outer; dx++) {
      const d = dx * dx + dy * dy;
      if (d > outer * outer + outer * 0.6) continue;
      if (d <= inner * inner + inner * 0.6) continue;
      const rim = d <= (inner + 1) ** 2 + inner * 0.6;
      canvas.set(x + dx, y + dy, rim ? edge : INK.front);
    }
  }
  const tick = canvas.mix({ from: INK.front, to: INK.horizon, by: 4 });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    for (const d of [19.5, 20.5]) {
      canvas.set(
        Math.round(x + Math.cos(a) * d),
        Math.round(y + Math.sin(a) * d),
        tick,
      );
    }
  }
  plain(canvas, random, { row, keepClear: x });
  canvas.rect(x - 14, row - 2, x + 14, row, INK.front);
  canvas.rect(x - 19, row, x + 19, row + 1, INK.front);
};

const hoop = (
  canvas: Canvas,
  {
    x,
    base,
    half,
    tall,
    solid,
  }: { x: number; base: number; half: number; tall: number; solid: boolean },
) => {
  let last: number | undefined;
  for (let i = -half; i <= half; i++) {
    const y = Math.round(base - tall * Math.sqrt(1 - (i / half) ** 2));
    if (solid) canvas.vline(x + i, y, base, INK.front);
    const from = last ?? y;
    for (let j = Math.min(from, y); j <= Math.max(from, y); j++) {
      canvas.vline(x + i, j, j + 1, INK.front);
    }
    last = y;
  }
};

const hull: PaintWorld = (canvas, random) => {
  const row = random.range(44, 46);
  heavens(canvas, row);
  const left = random.chance(0.5);
  const x = left ? random.range(30, 46) : random.range(114, 130);
  const dir = left ? 1 : -1;
  plain(canvas, random, { row, keepClear: x + dir * 34 });
  const base = row + 3;
  const seamInk = canvas.mix({ from: INK.front, to: INK.back, by: 3 });
  const ribs = [16, 13, 10];
  ribs.forEach((tall, j) => {
    hoop(canvas, {
      x: x + dir * (j * 14 + 28),
      base,
      half: 6,
      tall,
      solid: false,
    });
  });
  const nose = x - dir * 10;
  hoop(canvas, { x: nose, base, half: 26, tall: 15, solid: true });
  hoop(canvas, { x: x + dir * 12, base, half: 9, tall: 17, solid: true });
  const seam = base - 8;
  canvas.hline(nose - 18, nose + 18, seam, seamInk);
  for (const dx of [-12, -5, 2, 9]) {
    canvas.vline(nose + dx, seam - 4, seam - 1, seamInk);
  }
  canvas.fillBelow(
    pixelContour(
      spline([
        [-20, row + 7],
        [40, row + 6],
        [100, row + 8],
        [190, row + 6],
      ]),
    ),
    INK.front,
  );
};

const dome = (
  canvas: Canvas,
  { x, base, r }: { x: number; base: number; r: number },
) => {
  forDisc(r, (dx, dy) => {
    if (dy <= 0) canvas.set(x + dx, base + dy, INK.front);
  });
  for (let i = -r + 2; i <= r - 2; i += 3) {
    canvas.set(x + i, base - 1, INK.sun);
  }
};

const colony: PaintWorld = (canvas, random) => {
  const row = random.range(45, 47);
  heavens(canvas, row);
  const left = random.chance(0.5);
  const x = left ? random.range(32, 52) : random.range(104, 124);
  plain(canvas, random, { row, keepClear: left ? 120 : 40 });
  const glow = canvas.mix({ from: INK.middle, to: INK.horizon, by: 4 });
  for (let y = row - 16; y < row; y++) {
    for (let i = -44; i <= 44; i++) {
      const d = Math.sqrt((i / 44) ** 2 + ((row - y) / 16) ** 2);
      if ((1 - d) * 0.8 > threshold(x + i, y)) canvas.set(x + i, y, glow);
    }
  }
  dome(canvas, { x: x - 12, base: row - 1, r: 9 });
  dome(canvas, { x: x + 6, base: row - 1, r: 6 });
  dome(canvas, { x: x + 19, base: row - 1, r: 4 });
  canvas.rect(x + 24, row - 3, x + 62, row - 1, INK.front);
  for (let i = 26; i < 62; i += 3) canvas.set(x + i, row - 2, INK.sun);
  canvas.rect(x - 38, row - 2, x - 23, row - 1, INK.front);
  for (let i = -36; i < -23; i += 3) canvas.set(x + i, row - 2, INK.sun);
  const tower = x - 3;
  canvas.vline(tower, row - 20, row - 1, INK.front);
  canvas.rect(tower - 1, row - 21, tower + 1, row - 19, INK.front);
  canvas.set(tower, row - 23, INK.sun);
};

const mega: PaintWorld = (canvas, random) => {
  const row = random.range(42, 45);
  heavens(canvas, row);
  const haze = canvas.legible({
    over: [[INK.horizon, 1]],
    from: [
      canvas.mix({ from: INK.horizon, to: INK.back, by: 5 }),
      canvas.mix({ from: INK.horizon, to: INK.sun, by: 2 }),
    ],
    min: CLEAR_OF_HORIZON,
  });
  const shadow = canvas.mix({ from: INK.back, to: INK.front, by: 1 });
  const peak = random.range(5, 9);
  const span = random.range(120, 150);
  const centre = random.range(60, 100);
  for (let x = 0; x < W; x++) {
    const u = (x - centre) / span;
    const y = Math.round(peak + (row - peak) * u * u * 2.1);
    const thick = Math.round(4 * (1 - clamp(u * u * 3)) + 2);
    canvas.vline(x, y, Math.min(row - 1, y + thick), haze);
    canvas.set(x, y + thick + 1, shadow);
  }
  plain(canvas, random, { row });
};

export const WORLDS = {
  ringed,
  moons,
  monolith,
  gate,
  hull,
  colony,
  mega,
} satisfies Record<WorldName, PaintWorld>;
