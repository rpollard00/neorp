import {
  INK,
  PLATE_HEIGHT as H,
  PLATE_WIDTH as W,
  type Canvas,
  type Ink,
  type Random,
  type Sprite,
} from "./plate-canvas";
import type { Footprint, Stage } from "./plate-lands";
import {
  CABINS,
  FLOCKS,
  LIGHTHOUSES,
  MASTS,
  PYLONS,
  ROAD_POLES,
  SAILBOATS,
  TENTS,
  TREES,
  WAKES,
} from "./plate-sprites";
import type { SubjectName } from "./scenes";

type PlacedSubject = {
  footprint: Footprint;
  draw: (canvas: Canvas, stage: Stage) => void;
};

/** A subject picks its drawing first, so the land can make room for it. */
export type PlanSubject = (random: Random) => PlacedSubject;

const widthOf = (rows: Sprite) => rows[0].length;

const READS = 2.2;
const GLOWS = 1.3;

/** Dark on a light sky and pale on a dark one, in every palette. */
const subjectInks = (canvas: Canvas, { behind: over }: Stage) => {
  const pale = (by: number) =>
    canvas.mix({ from: INK.horizon, to: INK.sun, by });
  const dusky = canvas.mix({ from: INK.horizon, to: INK.back, by: 4 });
  return {
    "#": canvas.legible({ over, from: [INK.front, pale(3)], min: READS }),
    s: canvas.legible({
      over,
      from: [INK.back, INK.front, pale(3)],
      min: READS,
    }),
    l: canvas.legible({
      over: [INK.horizon],
      from: [pale(4), dusky],
      min: GLOWS,
    }),
    "*": INK.sun,
  };
};

const flipFor = ({ x, light }: Stage) => light > x;

/** The lowest surface under `rows`, so that no corner floats. */
const baseRow = (
  { surface }: Stage,
  { x, rows }: { x: number; rows: Sprite },
) => {
  const columns = surface.slice(Math.max(0, x), x + widthOf(rows));
  return Math.min(H - 1, Math.max(...columns));
};

const stand = (canvas: Canvas, stage: Stage, rows: Sprite) => {
  const x = stage.x - (widthOf(rows) >> 1);
  canvas.sprite({
    rows,
    x,
    y: baseRow(stage, { x, rows }) - rows.length + 1,
    inks: subjectInks(canvas, stage),
    flip: flipFor(stage),
  });
};

const standing =
  (drawings: readonly Sprite[]): PlanSubject =>
  (random) => {
    const rows = random.pick(drawings);
    return {
      footprint: { on: "ground", width: widthOf(rows), run: 0 },
      draw: (canvas, stage) => stand(canvas, stage, rows),
    };
  };

const sailboat: PlanSubject = (random) => {
  const rows = random.pick(SAILBOATS);
  return {
    footprint: { on: "water", width: widthOf(rows), run: 0 },
    draw: (canvas, stage) => {
      stand(canvas, stage, rows);
      canvas.sprite({
        rows: WAKES,
        x: stage.x - (widthOf(WAKES) >> 1),
        y: stage.surface[stage.x] + 2,
        inks: { "#": INK.front },
      });
    },
  };
};

const wire = (
  canvas: Canvas,
  {
    x0,
    y0,
    x1,
    y1,
    sag,
    ink,
  }: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    sag: number;
    ink: Ink;
  },
) => {
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
    const t = (x - x0) / (x1 - x0);
    const y = y0 + (y1 - y0) * t + sag * 4 * t * (1 - t);
    canvas.set(x, Math.round(y), ink);
  }
};

const PYLON_LINE = [
  { rows: PYLONS.large, at: 0, arm: 5 },
  { rows: PYLONS.medium, at: 30, arm: 3 },
  { rows: PYLONS.small, at: 50, arm: 3 },
  { rows: PYLONS.tiny, at: 64, arm: 1 },
] as const;

const pylons: PlanSubject = () => ({
  footprint: { on: "ground", width: widthOf(PYLONS.large), run: 64 },
  draw: (canvas, stage) => {
    const dir = stage.light > stage.x ? 1 : -1;
    const inks = subjectInks(canvas, stage);
    const placed = PYLON_LINE.map(({ rows, at, arm }) => {
      const x = stage.x + dir * at;
      const left = x - (widthOf(rows) >> 1);
      const top = baseRow(stage, { x: left, rows }) - rows.length + 1;
      return { rows, x, left, top, tip: (widthOf(rows) >> 1) - 1, arm };
    });
    placed.forEach((tower, i) => {
      const y = tower.top + tower.arm;
      const next = placed[i + 1];
      if (next) {
        wire(canvas, {
          x0: tower.x + dir * tower.tip,
          y0: y,
          x1: next.x - dir * next.tip,
          y1: next.top + next.arm,
          sag: 2.4 - i * 0.7,
          ink: inks["#"],
        });
      }
      if (i === 0) {
        wire(canvas, {
          x0: tower.x - dir * tower.tip,
          y0: y,
          x1: tower.x - dir * 70,
          y1: y + 7,
          sag: 2,
          ink: inks["#"],
        });
      }
    });
    for (const { rows, left, top } of placed) {
      canvas.sprite({ rows, x: left, y: top, inks });
    }
  },
});

const BIRD_SKY = [INK.middle, INK.horizon];

const birds: PlanSubject = (random) => {
  const rows = random.pick(FLOCKS);
  const lift = random.range(7, 10);
  return {
    footprint: { on: "ground", width: 0, run: 0 },
    draw: (canvas, stage) => {
      canvas.sprite({
        rows,
        x: stage.x - (widthOf(rows) >> 1),
        y: stage.surface[stage.x] - lift - rows.length,
        inks: subjectInks(canvas, { ...stage, behind: BIRD_SKY }),
        flip: flipFor(stage),
      });
    },
  };
};

const ROAD_STOPS = [0.08, 0.2, 0.42, 0.8];

const road: PlanSubject = (random) => {
  const bend = random.range(40, 58);
  return {
    footprint: { on: "ground", width: 8, run: 0 },
    draw: (canvas, stage) => {
      const dir = stage.x < W / 2 ? 1 : -1;
      const inks = subjectInks(canvas, stage);
      const top = stage.surface[stage.x] + 1;
      const span = H - top;
      const surface = canvas.mix({ from: INK.horizon, to: INK.back, by: 3 });
      const centre = (t: number) => stage.x + dir * bend * t ** 1.3;
      const half = (t: number) => 0.5 + t * 3 + t * t * 15;
      for (let y = top; y < H; y++) {
        const t = (y - top) / span;
        canvas.hline(
          Math.round(centre(t) - half(t)),
          Math.round(centre(t) + half(t)),
          y,
          surface,
        );
      }
      const poles = ROAD_STOPS.map((t, i) => {
        const rows = ROAD_POLES[i];
        const x = Math.round(centre(t) + dir * (half(t) + 3 + t * 14));
        const y = Math.round(top + t * span) - rows.length + 1;
        return { rows, x, y };
      });
      poles.forEach(({ x, y }, i) => {
        const next = poles[i + 1];
        if (!next) return;
        const [x0, y0, x1, y1] = [x, y, next.x, next.y];
        wire(canvas, { x0, y0, x1, y1, sag: 0.3 + i * 0.5, ink: inks["#"] });
      });
      for (const { rows, x, y } of poles) {
        canvas.sprite({ rows, x: x - (widthOf(rows) >> 1), y, inks });
      }
    },
  };
};

export const SUBJECTS = {
  lighthouse: standing(LIGHTHOUSES),
  cabin: standing(CABINS),
  pylons,
  sailboat,
  mast: standing(MASTS),
  tree: standing(TREES),
  birds,
  road,
  tent: standing(TENTS),
} satisfies Record<SubjectName, PlanSubject>;
