import {
  clamp,
  crescent,
  forDisc,
  INK,
  levelled,
  PLATE_HEIGHT as H,
  PLATE_WIDTH as W,
  rolling,
  sky,
  spline,
  stretched,
  threshold,
  pixelContour,
  type Canvas,
  type Ink,
  type Random,
  type Sprite,
} from "./plate-canvas";
import type { LandName } from "./scenes";

export type Footprint = {
  on: "ground" | "water";
  /** Columns of level surface. */
  width: number;
  /** Columns the subject runs on past its site, toward the light. */
  run: number;
};

export type Stage = {
  /** The top row of the surface in each column. */
  surface: readonly number[];
  /** The middle column of the site. */
  x: number;
  /** The column of the light. It is off the plate when no disc shows. */
  light: number;
};

export type PaintLand = (
  canvas: Canvas,
  random: Random,
  footprint: Footprint | null,
) => Stage;

type Side = -1 | 1;
const SIDES: readonly Side[] = [-1, 1];

type LightKind = "sun" | "low" | "moon" | "clouds" | "bare";
const OFF_PLATE = 1000;
const SKY_AND_LIGHT = [INK.top, INK.middle, INK.horizon, INK.sun];

const flat = (row: number) => new Array<number>(W).fill(row);

const siteColumn = (random: Random, side: Side, run: number) => {
  const spot = random.below(23);
  const inset = run > 0 ? 24 + (spot >> 2) : 30 + spot;
  return side < 0 ? inset : W - 1 - inset;
};

type Cloud = {
  x: number;
  y: number;
  width: number;
  /** Where the upper strips start and the under strip begins, in columns. */
  cuts: readonly [number, number, number];
};

const cloudShape = (
  random: Random,
  { x, y, width }: { x: number; y: number; width: number },
): Cloud => ({
  x,
  y,
  width,
  cuts: [
    Math.round(width * (0.1 + random.next() * 0.14)),
    Math.round(width * (0.55 + random.next() * 0.2)),
    Math.round(width * (0.3 + random.next() * 0.25)),
  ],
});

/** Long thin streaks, as a woodblock print draws a high cloud. */
const cloudStrips = ({ x, y, width, cuts: [a, b, c] }: Cloud) =>
  [
    [x + a + 2, x + b - 1, y - 2, "ink"],
    [x + a, x + width - Math.round(width * 0.12), y - 1, "ink"],
    [x, x + width, y, "ink"],
    [x + c, x + width + Math.round(width * 0.1), y + 1, "under"],
  ] as const;

const strata = (
  canvas: Canvas,
  { cloud, ink, under }: { cloud: Cloud; ink: Ink; under: Ink },
) => {
  for (const [x0, x1, y, role] of cloudStrips(cloud)) {
    canvas.hline(x0, x1, y, role === "ink" ? ink : under);
  }
};

const glitter = (
  canvas: Canvas,
  { x, row, half }: { x: number; row: number; half: number },
) => {
  const rows = H - row;
  for (let k = 0; row + 1 + k < H; k += 2) {
    const taper = 1 - (k / rows) * 0.7;
    const swing = k % 4 === 0 ? 1 : -1;
    const w = Math.max(1, Math.round(half * taper) + swing);
    const offset = k % 8 === 2 ? 1 : k % 8 === 6 ? -1 : 0;
    canvas.hline(x + offset - w, x + offset + w, row + 1 + k, INK.sun);
  }
};

/** Pixels of sky kept clear between the light and the land. */
const CLEAR_AIR = 4;
/** Columns between the light and the nearest summit. */
const SADDLE = 20;

type Cell = readonly [x: number, y: number];

const isClearAir = (canvas: Canvas, cells: readonly Cell[]) =>
  cells.every(([x, y]) => {
    if (y < 1 || x < 0 || x >= W) return false;
    for (let dy = -CLEAR_AIR; dy <= CLEAR_AIR; dy++) {
      for (let dx = -CLEAR_AIR; dx <= CLEAR_AIR; dx++) {
        const [nx, ny] = [x + dx, y + dy];
        const inside = nx >= 0 && nx < W && ny >= 0 && ny < H;
        if (inside && canvas.get(nx, ny) > INK.horizon) return false;
      }
    }
    return true;
  });

const discCells = (x: number, y: number, r: number) => {
  const cells: Cell[] = [];
  forDisc(r, (dx, dy) => cells.push([x + dx, y + dy]));
  return cells;
};

/** Picks the light and where it hangs. Nothing is drawn until the land is. */
const lights = (
  canvas: Canvas,
  random: Random,
  {
    row,
    kinds,
    siteSide,
  }: { row: number; kinds: readonly LightKind[]; siteSide: Side },
) => {
  const kind = random.pick(kinds);
  const x = siteSide < 0 ? random.range(106, 130) : random.range(30, 54);
  const shows = kind === "sun" || kind === "low" || kind === "moon";
  canvas.stars = {
    lastRow: Math.round(row * 0.7),
    count: 34,
    alsoOnDarkSky: false,
  };
  const wide = kind === "clouds" ? random.range(38, 56) : 0;
  const narrow = kind === "clouds" ? random.range(24, 34) : 0;
  const clouds =
    kind === "clouds"
      ? [
          cloudShape(random, {
            x:
              siteSide > 0
                ? random.range(14, 40)
                : W - wide - random.range(14, 40),
            y: random.range(9, 13),
            width: wide,
          }),
          cloudShape(random, {
            x:
              siteSide > 0
                ? random.range(66, 74)
                : W - narrow - random.range(66, 74),
            y: random.range(18, 23),
            width: narrow,
          }),
        ]
      : [];
  const disc =
    kind === "sun"
      ? { y: Math.round(row * 0.5), r: 7 }
      : kind === "low"
        ? { y: row - 3, r: 9 }
        : kind === "moon"
          ? { y: Math.min(11, Math.round(row * 0.3)), r: 6 }
          : null;
  return {
    kind,
    shows,
    disc: disc && { x, ...disc },
    clouds,
    x: shows ? x : siteSide < 0 ? OFF_PLATE : -OFF_PLATE,
  };
};

type Light = ReturnType<typeof lights>;

/** A cloud hangs as low as planned, but only in clear air, or not at all. */
const hangCloud = (
  canvas: Canvas,
  { cloud: planned, ink, under }: { cloud: Cloud; ink: Ink; under: Ink },
) => {
  for (let y = planned.y; y >= 3; y--) {
    const cloud = { ...planned, y };
    const cells = cloudStrips(cloud).flatMap(([x0, x1, row]) =>
      Array.from({ length: x1 - x0 + 1 }, (_, i): Cell => [x0 + i, row]),
    );
    if (
      isClearAir(
        canvas,
        cells.filter(([cx]) => cx >= 0 && cx < W),
      )
    ) {
      strata(canvas, { cloud, ink, under });
      return;
    }
  }
};

/** As low as planned, and as near its column, as clear air allows. */
const findClearSpot = (
  canvas: Canvas,
  disc: { x: number; y: number; r: number },
) => {
  for (let y = disc.y; y > disc.r; y--) {
    for (const shift of [0, -6, 6, -12, 12]) {
      const x = disc.x + shift;
      if (isClearAir(canvas, discCells(x, y, disc.r))) return { x, y };
    }
  }
  return null;
};

/**
 * Hangs the light once the land is drawn: as low as it was planned, but only
 * where clear air surrounds it. A cloud that has no clear air is left out.
 */
const showLight = (canvas: Canvas, { kind, disc, clouds }: Light) => {
  const spot = disc && findClearSpot(canvas, disc);
  if (disc && spot) {
    if (kind === "moon") {
      crescent(canvas, {
        ...spot,
        r: disc.r,
        ink: INK.sun,
        side: spot.x < W / 2 ? 1 : -1,
      });
    } else {
      canvas.disc({ ...spot, r: disc.r, ink: INK.sun });
    }
  }
  const ink = canvas.mix({ from: INK.horizon, to: INK.sun, by: 4 });
  const under = canvas.mix({ from: INK.horizon, to: INK.back, by: 4 });
  for (const cloud of clouds) hangCloud(canvas, { cloud, ink, under });
};

const swell = (
  contour: readonly number[],
  { x, top, reach }: { x: number; top: number; reach: number },
) =>
  pixelContour(
    contour.map((v, i) => {
      const d = (i - x) / reach;
      return v + (top - v) * Math.exp(-d * d);
    }),
  );

const levelSite = (
  contour: readonly number[],
  { x, width }: { x: number; width: number },
) =>
  levelled(contour, {
    x0: x - (width >> 1) - 1,
    x1: x + (width >> 1) + 1,
    ease: 8,
  });

const paintWater = (canvas: Canvas, row: number) => {
  const near = canvas.mix({ from: INK.horizon, to: INK.back, by: 4 });
  for (let y = row; y < H; y++) {
    const d = (y - row) / (H - row);
    for (let x = 0; x < W; x++) {
      const t = stretched(x, y, 5);
      const ink = d * 2.1 > t ? (d * 2.1 - 1 > t ? INK.front : INK.back) : near;
      canvas.set(x, y, ink);
    }
  }
};

const sea: PaintLand = (canvas, random, footprint) => {
  const side = random.pick(SIDES);
  const row = footprint ? random.range(40, 43) : random.range(36, 39);
  sky(canvas, row);
  const light = lights(canvas, random, {
    row,
    kinds: ["low", "low", "sun", "moon", "clouds"],
    siteSide: side,
  });
  paintWater(canvas, row);
  if (light.shows) {
    glitter(canvas, { x: light.x, row, half: light.kind === "moon" ? 2 : 6 });
  }

  const open = side > 0;
  if (footprint?.on === "ground") {
    const rise = spline([
      [-20, row - 6],
      [28, row - 7],
      [44, row - 4],
      [52, row + 2],
      [64, row + 6],
      [84, row + 11],
      [120, 64],
      [190, 68],
    ]);
    const x = side < 0 ? random.range(18, 30) : random.range(129, 141);
    const headland = levelSite(
      pixelContour(rise.map((_, i) => rise[side < 0 ? i : W - 1 - i])),
      { x, width: footprint.width },
    );
    canvas.fillBelow(headland, INK.front);
    showLight(canvas, light);
    return { surface: headland, x, light: light.x };
  }

  const spit = spline([
    [-20, 50],
    [open ? 40 : 16, 52],
    [open ? 110 : 60, 57],
    [open ? 140 : 100, 53],
    [180, open ? 46 : 64],
  ]);
  const shore = pixelContour(spit.map((v, x) => (open ? spit[W - 1 - x] : v)));
  const foam = canvas.mix({ from: INK.horizon, to: INK.back, by: 2 });
  for (let x = 0; x < W; x++) {
    if (shore[x] < H) canvas.set(x, shore[x] - 1, foam);
    canvas.rect(x, shore[x], x, H - 1, INK.front);
  }
  showLight(canvas, light);
  return {
    surface: flat(row + random.range(5, 7)),
    x: siteColumn(random, side, 0),
    light: light.x,
  };
};

const flank = (random: Random, drop: number) => {
  const out: number[] = [];
  let y = 0;
  while (y < drop) {
    const slope = random.pick([0.5, 0.5, 1, 1, 1, 2 / 3, 1.5]);
    const run = random.range(4, 9);
    for (let i = 0; i < run && y < drop; i++) {
      y += slope;
      out.push(y);
    }
  }
  return out;
};

const zigzag = (
  random: Random,
  { length, amp }: { length: number; amp: number },
) => {
  const out: number[] = [];
  let v = 0;
  let dir = 1;
  while (out.length < length) {
    const run = random.range(2, amp + 1);
    for (let i = 0; i < run && out.length < length; i++) {
      out.push(v);
      v = clamp(v + dir, 0, amp);
    }
    dir = -dir;
  }
  return out;
};

type Mountain = {
  x: number;
  y: number;
  base: number;
  lit: Ink;
  shade: Ink;
  lightSide: Side;
  snow?: { lit: Ink; shade: Ink; rows: number };
};

const mountain = (canvas: Canvas, random: Random, m: Mountain) => {
  const { x: ax, y: ay, base, snow } = m;
  const drop = base - ay;
  const left = flank(random, drop);
  const right = flank(random, drop);
  const spine: number[] = [];
  let sx = 0;
  let out = true;
  for (let i = 0; i <= drop;) {
    const run = out ? random.range(4, 7) : random.range(2, 3);
    for (let j = 0; j < run && i <= drop; j++, i++) {
      spine.push(sx);
      if (out && j % 3 !== 2) sx += 1;
      else if (!out) sx += j === 0 ? -1 : 0;
    }
    out = !out;
  }
  const teeth = zigzag(random, { length: 80, amp: 3 });
  const edge = (dx: number) => {
    const f = dx < 0 ? left : right;
    const i = Math.abs(dx) - 1;
    return i < 0 ? 0 : i < f.length ? f[i] : Number.POSITIVE_INFINITY;
  };
  for (let x = ax - left.length; x <= ax + right.length; x++) {
    const dx = x - ax;
    const top = ay + Math.floor(edge(dx));
    for (let y = top; y <= base; y++) {
      const row = y - ay;
      const shaded = -dx * m.lightSide > (spine[row] ?? 0);
      const tooth = teeth[clamp(x - (ax - 40), 0, 79)];
      const { lit, shade } = snow && row < snow.rows + tooth ? snow : m;
      canvas.set(x, y, shaded ? shade : lit);
    }
  }
};

const peaks: PaintLand = (canvas, random, footprint) => {
  const side = random.pick(SIDES);
  const x = siteColumn(random, side, footprint?.run ?? 0);
  sky(canvas, 46);
  const light = lights(canvas, random, {
    row: 36,
    kinds: ["sun", "moon", "clouds", "bare", "bare"],
    siteSide: side,
  });
  const faces = (peak: number): Side => (light.x < peak ? -1 : 1);
  // No summit stands under the sun or the moon: a saddle does.
  const clearOfLight = (at: number) =>
    Math.abs(at - light.x) < SADDLE
      ? light.x + (at < light.x ? -SADDLE : SADDLE)
      : at;
  const far = canvas.mix({ from: INK.horizon, to: INK.back, by: 3 });
  const mid = canvas.mix({ from: INK.horizon, to: INK.back, by: 6 });
  const midShade = canvas.mix({ from: INK.back, to: INK.front, by: 3 });
  const snow = canvas.mix({ from: INK.horizon, to: INK.sun, by: 5 });
  const snowShade = far;

  for (const at of [12, 58, 106, 150]) {
    const peak = clearOfLight(at + random.range(-6, 6));
    mountain(canvas, random, {
      x: peak,
      y: random.range(25, 31),
      base: 50,
      lit: far,
      shade: far,
      lightSide: faces(peak),
    });
  }
  // The main peaks leave a saddle at the site, so a subject has pale land
  // behind it and not a dark flank.
  const spots = [x - side * 34, x - side * 88, x + side * 40].map(clearOfLight);
  const byDistance = [...spots].sort(
    (a, b) => Math.abs(a - light.x) - Math.abs(b - light.x),
  );
  byDistance.forEach((at, i) => {
    const peak = clearOfLight(at + random.range(-5, 5));
    const y =
      i === byDistance.length - 1 ? random.range(14, 18) : random.range(20, 27);
    mountain(canvas, random, {
      x: peak,
      y,
      base: 56,
      lit: mid,
      shade: midShade,
      lightSide: faces(peak),
      snow: { lit: snow, shade: snowShade, rows: Math.round((42 - y) * 0.42) },
    });
  });

  canvas.fillBelow(rolling(random, { base: 50, amp: 3, knots: 4 }), INK.back);
  const foot = rolling(random, { base: 55, amp: 2, knots: 3 });
  const ground = footprint
    ? levelSite(swell(foot, { x, top: 45, reach: 26 }), {
        x,
        width: footprint.width,
      })
    : foot;
  canvas.fillBelow(ground, INK.front);
  canvas.clearSpecks({ keep: SKY_AND_LIGHT });
  showLight(canvas, light);
  return { surface: ground, x, light: light.x };
};

type Dune = {
  x: number;
  y: number;
  span: number;
  lit: Ink;
  shade: Ink;
  dir: Side;
  crestWidth?: number;
};

const dune = (canvas: Canvas, d: Dune) => {
  const { x: xc, y: yc, span, dir, crestWidth = 0 } = d;
  const windward = span * 4.2;
  const away = span * 7;
  const crestRun = span * 3.6;
  const crestDrop = span * 1.25;
  const along = (x: number) => {
    const dx = (x - xc) * dir;
    return Math.sign(dx) * Math.max(0, Math.abs(dx) - (crestWidth >> 1));
  };
  const h = new Array<number>(W);
  for (let x = 0; x < W; x++) {
    const dx = along(x);
    const v =
      dx <= 0 ? span * (-dx / windward) ** 1.9 : span * (dx / away) ** 1.55;
    h[x] = Math.round(yc + v);
  }
  for (let x = 0; x < W; x++) {
    canvas.rect(x, h[x], x, H - 1, d.lit);
    const dx = along(x);
    if (dx <= 0) continue;
    const t = clamp(dx / crestRun);
    const s = t ** 0.8 * (1 - 0.35 * Math.cos(t * Math.PI * 2) * (1 - t));
    const crest = yc + crestDrop * (t < 1 ? s : 1 + (t - 1) * 0.35);
    for (let y = h[x]; y < Math.round(crest) && y < H; y++) {
      canvas.set(x, y, d.shade);
    }
  }
  return h;
};

const dunes: PaintLand = (canvas, random, footprint) => {
  const side = random.pick(SIDES);
  const x = siteColumn(random, side, footprint?.run ?? 0);
  sky(canvas, 41);
  const light = lights(canvas, random, {
    row: 34,
    kinds: ["low", "sun", "moon", "bare"],
    siteSide: side,
  });
  const dir: Side = light.x < W / 2 ? 1 : -1;
  const a = random.range(0, 34);
  const farLit = canvas.mix({ from: INK.horizon, to: INK.back, by: 3 });
  const farShade = canvas.mix({ from: INK.horizon, to: INK.back, by: 6 });
  const midLit = canvas.mix({ from: INK.back, to: INK.horizon, by: 3 });
  const nearShade = canvas.mix({ from: INK.back, to: INK.front, by: 5 });
  canvas.fillBelow(flat(47), farLit);
  const row = (
    xs: readonly number[],
    { y, span, lit, shade }: Omit<Dune, "x" | "dir">,
  ) =>
    [...xs]
      .sort((u, v) => (v - u) * dir)
      .forEach((at, i) =>
        dune(canvas, {
          x: at + random.range(-6, 6),
          y: y + (i % 2) * 2,
          span,
          lit,
          shade,
          dir,
        }),
      );
  row([a - 40, a + 44, a + 128], {
    y: 34,
    span: 9,
    lit: farLit,
    shade: farShade,
  });
  row([a - 70, a + 10, a + 96, a + 182], {
    y: 41,
    span: 11,
    lit: midLit,
    shade: INK.back,
  });
  row([a - 16, a + 62, a + 150], {
    y: 50,
    span: 13,
    lit: INK.back,
    shade: nearShade,
  });
  const surface = footprint
    ? dune(canvas, {
        x,
        y: 44,
        span: 13,
        lit: INK.back,
        shade: nearShade,
        dir,
        crestWidth: footprint.width + 4,
      })
    : flat(50);
  canvas.clearSpecks({ keep: SKY_AND_LIGHT, slivers: 12 });
  showLight(canvas, light);
  return { surface, x, light: light.x };
};

const PINES: Record<number, readonly number[]> = {
  5: [1, 3, 1, 3, 5],
  7: [1, 1, 3, 3, 5, 3, 5],
  9: [1, 1, 3, 3, 5, 3, 5, 7, 7],
  12: [1, 1, 3, 3, 5, 3, 5, 7, 5, 7, 9, 9],
  16: [1, 1, 3, 3, 5, 5, 3, 5, 7, 7, 5, 7, 9, 9, 11, 11],
  21: [1, 1, 3, 3, 5, 5, 3, 5, 7, 7, 5, 7, 9, 9, 7, 9, 11, 11, 13, 13, 13],
};

const pine = (
  canvas: Canvas,
  { x, base, size, ink }: { x: number; base: number; size: number; ink: Ink },
) => {
  const rows = PINES[size];
  rows.forEach((w, i) =>
    canvas.hline(x - (w >> 1), x + (w >> 1), base - rows.length + i, ink),
  );
  canvas.rect(x, base, x, base + 1, ink);
};

const forest: PaintLand = (canvas, random, footprint) => {
  const side = random.pick(SIDES);
  const site = siteColumn(random, side, 0);
  sky(canvas, 37);
  const light = lights(canvas, random, {
    row: 34,
    kinds: ["moon", "moon", "low", "sun", "bare"],
    siteSide: side,
  });
  const mist = canvas.mix({ from: INK.horizon, to: INK.back, by: 2 });
  const far = canvas.mix({ from: INK.horizon, to: INK.back, by: 5 });
  const mid = canvas.mix({ from: INK.back, to: INK.front, by: 4 });

  const ridge = rolling(random, { base: 37, amp: 4, knots: 4 });
  for (let x = 0; x < W; x++) canvas.rect(x, ridge[x], x, H - 1, far);
  for (let x = 2; x < W; x += random.range(3, 6)) {
    pine(canvas, {
      x,
      base: ridge[x] + 1,
      size: random.pick([5, 7]),
      ink: far,
    });
  }
  for (let y = 42; y < H; y++) {
    const f = clamp((y - 42) / 7);
    for (let x = 0; x < W; x++) {
      if (f > threshold(x, y)) canvas.set(x, y, mist);
    }
  }
  const midRidge = rolling(random, { base: 48, amp: 3, knots: 3 });
  canvas.fillBelow(midRidge, mid);
  // The middle trees leave a gap behind a subject, so it stands against the
  // far forest and not against dark trees.
  for (let x = 1; x < W; x += random.range(5, 8)) {
    const size = random.pick([7, 9, 12]);
    if (footprint && Math.abs(x - site) < 16) continue;
    pine(canvas, { x, base: midRidge[x] + 1, size, ink: mid });
  }

  const low = pixelContour(
    spline([
      [-10, 56],
      [80, 58],
      [170, 55],
    ]),
  );
  const clearing = random.range(50, 110);
  const open = footprint ? site : clearing;
  const ground = footprint
    ? levelSite(swell(low, { x: site, top: 43, reach: 19 }), {
        x: site,
        width: footprint.width,
      })
    : low;
  canvas.fillBelow(ground, INK.front);
  for (let x = random.range(0, 6); x < W;) {
    const gap = Math.abs(x - open);
    if (gap > 26) {
      const size = gap > 45 ? random.pick([16, 21, 21]) : random.pick([12, 16]);
      pine(canvas, { x, base: ground[x] + 1, size, ink: INK.front });
      x += random.range(9, 13);
    } else {
      if (gap > 12 && !footprint) {
        pine(canvas, { x, base: ground[x] + 1, size: 7, ink: INK.front });
      }
      x += random.range(7, 12);
    }
  }
  showLight(canvas, light);
  return {
    surface: ground,
    x: site,
    light: light.x,
  };
};

type Mesa = {
  x0: number;
  x1: number;
  top: number;
  floor: number;
  lit: Ink;
  shade: Ink;
  band?: Ink;
  shadeLeft: boolean;
};

const MESA_FLARE = [0, 1, 1, 2, 2, 2, 3, 3, 5, 7, 10];

const mesa = (canvas: Canvas, random: Random, m: Mesa) => {
  const { top, floor } = m;
  // A mesa that nearly meets the plate's edge runs past it, so no sliver of
  // sky stays between them.
  const x0 = m.x0 < 3 ? -4 : m.x0;
  const x1 = m.x1 > W - 4 ? W + 3 : m.x1;
  const span = floor - top;
  const flareAt = (row: number, scale: number) => {
    const t = (row / span) * (MESA_FLARE.length - 1);
    const i = Math.floor(t);
    const from = MESA_FLARE[i];
    const to = MESA_FLARE[Math.min(i + 1, MESA_FLARE.length - 1)];
    return Math.round((from + (to - from) * (t - i)) * scale);
  };
  const leftFlare = 0.7 + random.next() * 0.8;
  const rightFlare = 0.7 + random.next() * 0.8;
  const bands = [random.range(3, 4), random.range(7, 9), random.range(12, 14)];
  const shadeWidth = Math.round((x1 - x0) * 0.3);
  for (let row = 0; row <= span; row++) {
    const y = top + row;
    const a = x0 - flareAt(row, leftFlare);
    const b = x1 + flareAt(row, rightFlare);
    canvas.hline(a, b, y, m.lit);
    if (m.band !== undefined && bands.includes(row)) {
      canvas.hline(a + 2, b - 2, y, m.band);
    }
    const jog = row % 7 > 3 ? 1 : 0;
    if (m.shadeLeft) canvas.hline(a, x0 + shadeWidth - jog, y, m.shade);
    else canvas.hline(x1 - shadeWidth + jog, b, y, m.shade);
  }
  canvas.hline(x0 - 1, x1 + 1, top, m.lit);
};

const mesas: PaintLand = (canvas, random, footprint) => {
  const side = random.pick(SIDES);
  sky(canvas, 45);
  const light = lights(canvas, random, {
    row: 36,
    kinds: ["sun", "sun", "moon", "bare"],
    siteSide: side,
  });
  const shadeLeft = light.x > W / 2;
  const floor = 49;
  const far = canvas.mix({ from: INK.horizon, to: INK.back, by: 4 });
  const farShade = canvas.mix({ from: INK.horizon, to: INK.back, by: 6 });
  for (const [x0, x1] of [
    [random.range(6, 16), random.range(50, 62)],
    [random.range(116, 124), random.range(146, 170)],
  ]) {
    mesa(canvas, random, {
      x0,
      x1,
      top: random.range(31, 35),
      floor,
      lit: far,
      shade: farShade,
      shadeLeft,
    });
  }

  // The tall mesa and the butte stand far apart. The site is the open sky
  // between them, and the butte stands out past the light.
  const mirror = (x: number) => (side < 0 ? x : W - 1 - x);
  const lit = canvas.mix({ from: INK.back, to: INK.horizon, by: 2 });
  const shade = canvas.mix({ from: INK.back, to: INK.front, by: 4 });
  const width = random.range(28, 36);
  const inset = random.range(16, 28);
  const [x0, x1] = [mirror(inset), mirror(inset + width)].sort((a, b) => a - b);
  mesa(canvas, random, {
    x0,
    x1,
    top: random.range(20, 25),
    floor,
    lit,
    shade,
    band: INK.back,
    shadeLeft,
  });
  const butte = random.range(146, 152);
  const butteWide = random.range(6, 9);
  const [bx0, bx1] = [mirror(butte), mirror(butte + butteWide)].sort(
    (a, b) => a - b,
  );
  mesa(canvas, random, {
    x0: bx0,
    x1: bx1,
    top: random.range(29, 33),
    floor,
    lit,
    shade,
    band: INK.back,
    shadeLeft,
  });
  const x = mirror(inset + width + random.range(14, 18));

  const plain = rolling(random, { base: 48, amp: 1, knots: 3 });
  const surface = footprint
    ? levelSite(plain, { x, width: footprint.width })
    : plain;
  canvas.fillBelow(surface, INK.back);
  canvas.clearSpecks({ rows: [0, floor], keep: SKY_AND_LIGHT });
  const ground = canvas.mix({ from: INK.back, to: INK.front, by: 2 });
  for (let y = 48; y < H; y++) {
    const f = (y - 48) / 12;
    for (let col = 0; col < W; col++) {
      if (canvas.get(col, y) === INK.back && f > stretched(col, y, 3)) {
        canvas.set(col, y, ground);
      }
    }
  }
  canvas.fillBelow(
    pixelContour(
      spline([
        [-10, 59],
        [50, 56],
        [120, 59],
        [170, 54],
      ]),
    ),
    INK.front,
  );
  showLight(canvas, light);
  return { surface, x, light: light.x };
};

const lake: PaintLand = (canvas, random, footprint) => {
  const side = random.pick(SIDES);
  const row = random.range(37, 40);
  sky(canvas, row);
  const light = lights(canvas, random, {
    row: row - 8,
    kinds: ["low", "sun", "moon", "clouds", "bare"],
    siteSide: side,
  });
  const far = canvas.mix({ from: INK.horizon, to: INK.back, by: 4 });
  // A boat sails the open water, and anything else stands on the hill.
  const onLeft = (footprint?.on === "water" ? -side : side) < 0;
  const back = rolling(random, { base: row - 6, amp: 4, knots: 4 });
  // A hill that carries a subject stays low, so the subject meets a lit sky.
  const crest = footprint?.on === "ground" ? 10 : 15;
  const hill = pixelContour(
    spline(
      onLeft
        ? [
            [-10, row - crest],
            [30, row - crest + 2],
            [84, row - 1],
            [170, row + 2],
          ]
        : [
            [-10, row + 2],
            [76, row - 1],
            [130, row - crest + 2],
            [170, row - crest],
          ],
    ),
  );
  const spot = random.range(0, 16);
  const hillSite = onLeft ? 16 + spot : W - 17 - spot;
  const near =
    footprint?.on === "ground"
      ? levelSite(hill, { x: hillSite, width: footprint.width })
      : hill;
  for (let x = 0; x < W; x++) {
    canvas.rect(x, Math.min(back[x], row), x, row - 1, far);
    canvas.rect(x, Math.min(near[x], row), x, row - 1, INK.back);
  }
  const waterFar = canvas.mix({ from: INK.horizon, to: INK.middle, by: 2 });
  const waterNear = canvas.mix({ from: INK.horizon, to: INK.middle, by: 6 });
  const nearMirror = canvas.mix({ from: INK.back, to: INK.front, by: 3 });
  const rise = (contour: readonly number[], x: number) =>
    row - Math.min(contour[x], row);
  for (let y = row; y < H; y++) {
    const d = (y - row) / (H - row);
    for (let x = 0; x < W; x++) {
      const depth = y - row;
      let ink = d > stretched(x, y, 6) ? waterNear : waterFar;
      if (depth < rise(back, x)) ink = far;
      if (depth < rise(near, x)) ink = nearMirror;
      canvas.set(x, y, ink);
    }
  }
  canvas.hline(0, W - 1, row, waterFar);
  if (light.shows) {
    glitter(canvas, { x: light.x, row, half: light.kind === "moon" ? 2 : 5 });
  }
  for (let i = 0; i < 9; i++) {
    const y = random.range(row + 3, H - 4);
    const x = random.below(W - 20);
    const ink = canvas.get(x + 4, y) === nearMirror ? far : waterFar;
    canvas.hline(x, x + random.range(6, 14), y, ink);
  }
  canvas.fillBelow(
    pixelContour(
      spline(
        onLeft
          ? [
              [-10, 63],
              [60, 62],
              [116, 58],
              [170, 52],
            ]
          : [
              [-10, 52],
              [44, 58],
              [100, 62],
              [170, 63],
            ],
      ),
    ),
    INK.front,
  );
  showLight(canvas, light);
  return footprint?.on === "water"
    ? {
        surface: flat(row + random.range(7, 9)),
        x: siteColumn(random, side, 0),
        light: light.x,
      }
    : {
        surface: near,
        x: hillSite,
        light: light.x,
      };
};

const HEDGE_HEIGHTS = [
  "1122211112223321111222111000000111222233322111122111222211110000111223",
  "3322211112211122221111222333322111122111112221110000111222211112223332",
  "2211122111122221111222332211100011122221",
].join("");

const HEDGE_TREES: readonly Sprite[] = [
  ["...####....", ".########..", "###########", ".#########.", "...#####..."],
  ["..#####.", "########", "########", "..####.."],
  ["....###....", "..#######..", ".#########.", "###########", "..#######.."],
];

const hedgerow = (
  canvas: Canvas,
  random: Random,
  { line, ink }: { line: readonly number[]; ink: Ink },
) => {
  const start = random.below(HEDGE_HEIGHTS.length - W);
  const top = pixelContour(
    line.map((y, x) => y - Number(HEDGE_HEIGHTS[start + x])),
  );
  for (let x = 0; x < W; x++) canvas.vline(x, top[x], line[x], ink);
  let x = random.range(8, 40);
  const first = random.below(HEDGE_TREES.length);
  for (let i = 0; i < HEDGE_TREES.length; i++) {
    const rows = HEDGE_TREES[(first + i) % HEDGE_TREES.length];
    canvas.sprite({
      rows,
      x,
      y: line[Math.min(W - 1, x + (rows[0].length >> 1))] - rows.length,
      inks: { "#": ink },
    });
    x += random.range(44, 58);
  }
};

const fields: PaintLand = (canvas, random, footprint) => {
  const side = random.pick(SIDES);
  const x = siteColumn(random, side, footprint?.run ?? 0);
  const row = random.range(37, 40);
  sky(canvas, row);
  canvas.stars = { lastRow: 18, count: 26, alsoOnDarkSky: false };
  const bright = canvas.mix({ from: INK.horizon, to: INK.sun, by: 4 });
  const far = canvas.mix({ from: INK.horizon, to: INK.back, by: 4 });
  canvas.fillBelow(rolling(random, { base: row - 3, amp: 2, knots: 3 }), far);
  // A subject keeps its own stretch of sky, so no cloud runs behind it.
  const clear = footprint && [
    x - 14 - (side > 0 ? footprint.run : 0),
    x + 14 + (side < 0 ? footprint.run : 0),
  ];
  const cloud = ({
    x: from,
    y,
    width,
  }: Record<"x" | "y" | "width", number>) => {
    const to = from + Math.round(width * 1.1);
    if (clear && from <= clear[1] && to >= clear[0]) return;
    hangCloud(canvas, {
      cloud: cloudShape(random, { x: from, y, width }),
      ink: bright,
      under: far,
    });
  };
  const shift = random.range(0, 24);
  cloud({ x: shift - 10, y: row - 4, width: random.range(56, 76) });
  cloud({ x: 84 + shift, y: row - 2, width: random.range(44, 70) });
  cloud({
    x: side < 0 ? random.range(70, 96) : random.range(10, 40),
    y: row - 13,
    width: random.range(40, 56),
  });

  const lift = canvas.mix({ from: INK.back, to: INK.horizon, by: 3 });
  const pale = canvas.mix({ from: INK.back, to: INK.horizon, by: 1 });
  const deep = canvas.mix({ from: INK.back, to: INK.front, by: 3 });
  const ramp = [lift, pale, INK.back, deep, INK.front];
  const skyline = rolling(random, { base: row, amp: 1, knots: 3 });
  const edges = [
    footprint ? levelSite(skyline, { x, width: footprint.width }) : skyline,
    rolling(random, { base: row + 5, amp: 1, knots: 3 }),
    rolling(random, { base: row + 11, amp: 2, knots: 3 }),
  ];
  const vanish = random.range(40, 120);
  const walls = edges.map((_, band) => {
    const out: number[] = [];
    for (
      let w = random.range(-30, 10);
      w < W + 40;
      w += 52 + band * 14 + random.below(24)
    ) {
      out.push(w);
    }
    return out;
  });
  const start = random.below(3);
  const crop = random.range(1, 3);
  for (let col = 0; col < W; col++) {
    for (let y = row - 3; y < H; y++) {
      let band = -1;
      edges.forEach((e, i) => {
        if (y >= e[col]) band = i;
      });
      if (band < 0) continue;
      const lean = ((col - vanish) / 30) * (y - edges[band][col]);
      const cell = walls[band].filter((w) => w <= col - lean).length;
      const step = (start + band + (cell % 3)) % 3;
      const rowInBand = y - edges[band][col];
      const striped =
        (cell + band) % 3 === crop % 3 && band > 0 && rowInBand % 2 === 1;
      const tone = step + band + (striped ? 1 : 0);
      canvas.set(col, y, ramp[Math.min(ramp.length - 1, tone)]);
    }
  }
  hedgerow(canvas, random, { line: edges[1], ink: INK.front });
  canvas.clearSpecks({ keep: SKY_AND_LIGHT });
  return {
    surface: edges[0],
    x,
    light: side < 0 ? OFF_PLATE : -OFF_PLATE,
  };
};

export const LANDS = {
  sea,
  peaks,
  dunes,
  forest,
  mesas,
  lake,
  fields,
} satisfies Record<LandName, PaintLand>;
