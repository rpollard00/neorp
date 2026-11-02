import {
  INK,
  PLATE_HEIGHT as H,
  PLATE_WIDTH as W,
  type Backdrop,
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

export type PlanSubject = (random: Random) => PlacedSubject;

const widthOf = (rows: Sprite) => rows[0].length;

type Mark = { rows: Sprite; x: number; y: number; flip?: boolean };
type Cell = readonly [x: number, y: number];

const cellsOf = ({ rows, x, y, flip }: Mark) =>
  rows.flatMap((row, j) =>
    [...row].flatMap((_, i) => {
      const role = row[flip ? row.length - 1 - i : i];
      return role === "." ? [] : [{ role, cell: [x + i, y + j] as Cell }];
    }),
  );

const keyOf = ([x, y]: Cell) => y * W + x;

const shares = (counts: ReadonlyMap<Ink, number>): Backdrop => {
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  return [...counts].map(([ink, n]) => [ink, n / total]);
};

const READS = 2;
const SETS_OFF = 1.5;
const GLOWS = 1.3;

/**
 * Inks for what is about to be drawn, from what the canvas holds around it.
 * Only what shows above the land counts: a mark stands on the land, and its
 * silhouette is what reads.
 */
const inksOver = (
  canvas: Canvas,
  stage: Stage,
  marks: readonly Mark[],
  wires: readonly Cell[] = [],
) => {
  const cells = marks.flatMap(cellsOf);
  const taken = new Set([
    ...cells.map(({ cell }) => keyOf(cell)),
    ...wires.map(keyOf),
  ]);
  const seen = new Map<string, Map<Ink, number>>();
  const look = (role: string, [x, y]: Cell) => {
    if (taken.has(keyOf([x, y]))) return;
    if (y >= stage.surface[Math.min(W - 1, Math.max(0, x))]) return;
    const counts = seen.get(role) ?? new Map<Ink, number>();
    const ink = canvas.get(x, y);
    seen.set(role, counts.set(ink, (counts.get(ink) ?? 0) + 1));
  };
  for (const {
    role,
    cell: [x, y],
  } of cells) {
    look(role, [x - 1, y]);
    look(role, [x + 1, y]);
    look(role, [x, y - 1]);
  }
  for (const [x, y] of wires) {
    look("#", [x, y - 1]);
    look("#", [x, y + 1]);
  }
  const over = (role: string) => shares(seen.get(role) ?? new Map());
  const pale = (by: number) =>
    canvas.mix({ from: INK.horizon, to: INK.sun, by });
  const dusky = (by: number) =>
    canvas.mix({ from: INK.horizon, to: INK.back, by });
  return {
    "#": canvas.legible({
      over: over("#"),
      from: [INK.front, pale(3)],
      min: READS,
    }),
    s: canvas.legible({
      over: over("s"),
      from: [INK.back, INK.front, pale(3)],
      min: SETS_OFF,
    }),
    l: canvas.legible({
      over: over("l"),
      from: [pale(4), dusky(4), dusky(7)],
      min: GLOWS,
    }),
    "*": INK.sun,
  };
};

const flipFor = ({ x, light }: Stage) => light > x;

const baseRow = (
  { surface }: Stage,
  { x, rows }: { x: number; rows: Sprite },
) => {
  const columns = surface.slice(Math.max(0, x), x + widthOf(rows));
  return Math.min(H - 1, Math.max(...columns));
};

const stand = (canvas: Canvas, stage: Stage, rows: Sprite) => {
  const x = stage.x - (widthOf(rows) >> 1);
  const mark = {
    rows,
    x,
    y: baseRow(stage, { x, rows }) - rows.length + 1,
    flip: flipFor(stage),
  };
  canvas.sprite({ ...mark, inks: inksOver(canvas, stage, [mark]) });
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

const wire = ({
  x0,
  y0,
  x1,
  y1,
  sag,
}: {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  sag: number;
}): Cell[] =>
  Array.from({ length: Math.abs(x1 - x0) + 1 }, (_, i) => {
    const x = Math.min(x0, x1) + i;
    const t = (x - x0) / (x1 - x0);
    return [x, Math.round(y0 + (y1 - y0) * t + sag * 4 * t * (1 - t))];
  });

const paint = (canvas: Canvas, cells: readonly Cell[], ink: Ink) => {
  for (const [x, y] of cells) canvas.set(x, y, ink);
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
    const towers = PYLON_LINE.map(({ rows, at, arm }) => {
      const x = stage.x + dir * at;
      const left = x - (widthOf(rows) >> 1);
      const top = baseRow(stage, { x: left, rows }) - rows.length + 1;
      return { rows, x, left, top, tip: (widthOf(rows) >> 1) - 1, arm };
    });
    const wires = towers.flatMap((tower, i) => {
      const y = tower.top + tower.arm;
      const next = towers[i + 1];
      const onward = next
        ? wire({
            x0: tower.x + dir * tower.tip,
            y0: y,
            x1: next.x - dir * next.tip,
            y1: next.top + next.arm,
            sag: 2.4 - i * 0.7,
          })
        : [];
      const back =
        i === 0
          ? wire({
              x0: tower.x - dir * tower.tip,
              y0: y,
              x1: tower.x - dir * 70,
              y1: y + 7,
              sag: 2,
            })
          : [];
      return [...onward, ...back];
    });
    const marks = towers.map(({ rows, left, top }) => ({
      rows,
      x: left,
      y: top,
    }));
    const inks = inksOver(canvas, stage, marks, wires);
    paint(canvas, wires, inks["#"]);
    for (const mark of marks) canvas.sprite({ ...mark, inks });
  },
});

const birds: PlanSubject = (random) => {
  const rows = random.pick(FLOCKS);
  const lift = random.range(7, 10);
  return {
    footprint: { on: "ground", width: 0, run: 0 },
    draw: (canvas, stage) => {
      const mark = {
        rows,
        x: stage.x - (widthOf(rows) >> 1),
        y: stage.surface[stage.x] - lift - rows.length,
        flip: flipFor(stage),
      };
      canvas.sprite({ ...mark, inks: inksOver(canvas, stage, [mark]) });
    },
  };
};

/** Rows below the horizon of each pole's foot: nearer, they spread apart. */
const POLE_DEPTHS = [2, 3.5, 5.5, 9];
/** How far a pole's top stands above the horizon, for its foot's depth. */
const POLE_RISE = 1;

const road: PlanSubject = (random) => {
  const bend = random.range(40, 58);
  return {
    footprint: { on: "ground", width: 8, run: 0 },
    draw: (canvas, stage) => {
      const dir = stage.x < W / 2 ? 1 : -1;
      const horizon = stage.surface[stage.x];
      const top = horizon + 1;
      const span = H - top;
      const centre = (t: number) => stage.x + dir * bend * t ** 1.3;
      const half = (t: number) => 0.5 + t * 3 + t * t * 15;
      const surfaceCells = Array.from({ length: span }, (_, row) => {
        const t = row / span;
        const from = Math.round(centre(t) - half(t));
        const to = Math.round(centre(t) + half(t));
        return { y: top + row, from, to };
      });
      const under = new Map<Ink, number>();
      for (const { y, from, to } of surfaceCells) {
        for (const x of [from - 1, to + 1]) {
          const ink = canvas.get(x, y);
          under.set(ink, (under.get(ink) ?? 0) + 1);
        }
      }
      const surface = canvas.legible({
        over: shares(under),
        from: [
          canvas.mix({ from: INK.horizon, to: INK.back, by: 3 }),
          canvas.mix({ from: INK.back, to: INK.front, by: 4 }),
          canvas.mix({ from: INK.horizon, to: INK.sun, by: 3 }),
        ],
        min: GLOWS,
      });
      for (const { y, from, to } of surfaceCells) {
        canvas.hline(from, to, y, surface);
      }
      const poles = POLE_DEPTHS.map((depth) => {
        const t = depth / span;
        const tall = Math.round(depth * (1 + POLE_RISE));
        const rows = ROAD_POLES.reduce((a, b) =>
          Math.abs(b.length - tall) < Math.abs(a.length - tall) ? b : a,
        );
        const x = Math.round(centre(t) + dir * (half(t) + 2 + t * 10));
        return { rows, x, y: Math.round(top + depth) - rows.length + 1 };
      });
      const wires = poles.flatMap(({ x, y }, i) => {
        const next = poles[i + 1];
        if (!next) return [];
        return wire({
          x0: x,
          y0: y,
          x1: next.x,
          y1: next.y,
          sag: 0.2 + i * 0.5,
        });
      });
      const marks = poles.map(({ rows, x, y }) => ({
        rows,
        x: x - (widthOf(rows) >> 1),
        y,
      }));
      const inks = inksOver(canvas, stage, marks, wires);
      paint(canvas, wires, inks["#"]);
      for (const mark of marks) canvas.sprite({ ...mark, inks });
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
