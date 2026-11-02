import { describe, expect, test } from "bun:test";
import {
  Canvas,
  contrast,
  INK,
  luminance,
  PLATE_WIDTH,
  randomStream,
  resolveInks,
  type Sprite,
} from "./plate-canvas";
import { LANDS, type Stage } from "./plate-lands";
import * as DRAWINGS from "./plate-sprites";
import { SUBJECTS } from "./plate-subjects";
import { STREAM } from "./plates";
import { PALETTE_NAMES, PALETTES } from "./palettes";
import { SCENE_NAMES, SCENES } from "./scenes";

/** The seeds a review found weak, then a spread. */
const SEEDS = [
  2026110201,
  3668339987,
  220824524,
  2027808452,
  126989,
  535203442,
  1306789390,
  1353973201,
  2812229512,
  ...Array.from({ length: 3 }, (_, i) => Math.imul(i + 1, 40503)),
];
const TALLEST = 19;

const PAIRS = SCENE_NAMES.flatMap((name) => {
  const scene = SCENES[name];
  return scene.kind === "land" && scene.subject
    ? [{ name, land: scene.land, subject: scene.subject }]
    : [];
});

const draw = ({ land, subject }: (typeof PAIRS)[number], seed: number) => {
  const canvas = new Canvas();
  const placed = SUBJECTS[subject](randomStream(seed, STREAM.subject));
  const stage = LANDS[land](
    canvas,
    randomStream(seed, STREAM.shapes),
    placed.footprint,
  );
  const before = canvas.pixels.slice();
  placed.draw(canvas, stage);
  const added = [...canvas.pixels.keys()].filter(
    (i) => canvas.pixels[i] !== before[i],
  );
  return { canvas, stage, before, added };
};

const drawings = new Map<string, ReturnType<typeof draw>>();

/** Each pairing and seed is drawn once and shared by the checks below. */
const drawn = (pair: (typeof PAIRS)[number], seed: number) => {
  const id = `${pair.name}:${seed}`;
  const found = drawings.get(id) ?? draw(pair, seed);
  drawings.set(id, found);
  return found;
};

/**
 * Below 1.3:1 two flat colours merge at 2×. The edge counts where a subject
 * meets what is behind it above the land; its foot may sit on its own ink.
 */
const EDGE_CONTRAST = 1.3;
const EDGE_FLOOR = 0.7;

const rowOf = (i: number) => Math.floor(i / PLATE_WIDTH);

const sprites: Sprite[] = [
  ...DRAWINGS.LIGHTHOUSES,
  ...DRAWINGS.CABINS,
  ...DRAWINGS.SAILBOATS,
  ...DRAWINGS.TENTS,
  ...DRAWINGS.MASTS,
  ...DRAWINGS.TREES,
  ...DRAWINGS.FLOCKS,
  ...DRAWINGS.ROAD_POLES,
  ...Object.values(DRAWINGS.PYLONS),
  DRAWINGS.WAKES,
];

describe("the drawings", () => {
  test("are rectangular text", () => {
    for (const rows of sprites) {
      expect(new Set(rows.map((row) => row.length)).size).toBe(1);
    }
  });

  test("stay under 20 pixels tall", () => {
    for (const rows of sprites)
      expect(rows.length).toBeLessThanOrEqual(TALLEST);
  });

  test("give each repeated subject at least three variants", () => {
    const { LIGHTHOUSES, CABINS, SAILBOATS, TENTS, TREES } = DRAWINGS;
    for (const group of [LIGHTHOUSES, CABINS, SAILBOATS, TENTS, TREES]) {
      expect(group.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe.each(PAIRS)("$name", (pair) => {
  test("stands on its surface and stays out of the light", () => {
    for (const seed of SEEDS) {
      const { canvas, stage, before, added } = drawn(pair, seed);
      expect(added.length).toBeGreaterThan(0);
      for (const i of added) expect(before[i]).not.toBe(INK.sun);
      if (pair.subject === "birds") continue;
      const lowest = Math.max(...added.map(rowOf));
      expect(lowest).toBeGreaterThanOrEqual(stage.surface[stage.x] - 1);
      expect(canvas.get(stage.x, stage.surface[stage.x] + 1)).not.toBe(
        INK.middle,
      );
    }
  });

  // A telegraph line is dark by design and may hide against dark rock.
  test.skipIf(pair.subject === "road")(
    "its edge stands apart from what is behind it on every palette",
    () => {
      for (const palette of PALETTE_NAMES) {
        for (const seed of SEEDS.slice(0, 6)) {
          const { canvas, stage, before, added } = drawn(pair, seed);
          const colours = resolveInks(canvas, PALETTES[palette]);
          const mine = new Set(added);
          let edges = 0;
          let apart = 0;
          for (const i of added) {
            for (const j of [i - 1, i + 1, i - PLATE_WIDTH]) {
              if (j < 0 || mine.has(j)) continue;
              const row = rowOf(j);
              if (row >= stage.surface[j % PLATE_WIDTH]) continue;
              edges++;
              const pair = [colours[canvas.pixels[i]], colours[before[j]]];
              if (contrast(pair[0], pair[1]) >= EDGE_CONTRAST) apart++;
            }
          }
          if (edges > 0)
            expect(apart / edges).toBeGreaterThanOrEqual(EDGE_FLOOR);
        }
      }
    },
  );
});

/**
 * Each part of a subject, one ink in one piece, must read on its own against
 * what is behind it: a sail, a gable, a second building. A lamp or a door must
 * read against the wall around it. Lines may hide against dark rock.
 */
const PART_CONTRAST = 1.6;
const PART_FLOOR = 0.55;
const LINES: readonly string[] = ["road", "pylons"];

describe.each(PAIRS.filter(({ subject }) => !LINES.includes(subject)))(
  "$name",
  (pair) => {
    test("reads part by part on every palette", () => {
      // A hull sits in the water, and hides in it as a boat's hull does.
      const inWater = pair.subject === "sailboat" ? 3 : 0;
      for (const seed of SEEDS) {
        const { canvas, stage, before, added } = drawn(pair, seed);
        const mine = new Set(added);
        const parts: number[][] = [];
        const seen = new Set<number>();
        for (const start of added) {
          if (seen.has(start)) continue;
          const part = [start];
          seen.add(start);
          for (let k = 0; k < part.length; k++) {
            const i = part[k];
            for (const j of [i - 1, i + 1, i - PLATE_WIDTH, i + PLATE_WIDTH]) {
              const sameRow =
                Math.abs((j % PLATE_WIDTH) - (i % PLATE_WIDTH)) <= 1;
              if (seen.has(j) || !mine.has(j) || !sameRow) continue;
              if (canvas.pixels[j] !== canvas.pixels[start]) continue;
              seen.add(j);
              part.push(j);
            }
          }
          parts.push(part);
        }
        for (const palette of PALETTE_NAMES) {
          const colours = resolveInks(canvas, PALETTES[palette]);
          for (const part of parts) {
            const ink = canvas.pixels[part[0]];
            const inPart = new Set(part);
            const sides = part.flatMap((i) =>
              [i - 1, i + 1, i - PLATE_WIDTH, i + PLATE_WIDTH].filter(
                (j) =>
                  j >= 0 &&
                  j < canvas.pixels.length &&
                  !inPart.has(j) &&
                  (mine.has(j) ||
                    rowOf(j) < stage.surface[j % PLATE_WIDTH] - inWater),
              ),
            );
            const outside = sides.filter((j) => !mine.has(j));
            const recipe = canvas.recipes[ink];
            const lamp =
              recipe.kind === "legible" && recipe.from[0] === INK.sun;
            if (part.length < 3 || (outside.length === 0 && !lamp)) continue;
            const judged = outside.length > 0 ? outside : sides;
            const edges = judged.length;
            const apart = judged.filter((j) => {
              const other = mine.has(j) ? canvas.pixels[j] : before[j];
              return contrast(colours[ink], colours[other]) >= PART_CONTRAST;
            }).length;
            if (edges >= 6) {
              expect({
                palette,
                seed,
                part: apart / edges >= PART_FLOOR,
              }).toEqual({ palette, seed, part: true });
            }
          }
        }
      }
    });
  },
);

describe.each(PAIRS.filter(({ subject }) => subject === "road"))(
  "$name",
  (pair) => {
    test("keeps its surface apart from the land on every palette", () => {
      for (const palette of PALETTE_NAMES) {
        for (const seed of SEEDS) {
          const { canvas, stage, before, added } = drawn(pair, seed);
          const colours = resolveInks(canvas, PALETTES[palette]);
          const surface = added.filter(
            (i) =>
              rowOf(i) > stage.surface[i % PLATE_WIDTH] &&
              canvas.pixels[i] !== INK.front,
          );
          const apart = surface.filter(
            (i) =>
              contrast(colours[canvas.pixels[i]], colours[before[i]]) >= 1.5,
          );
          expect(apart.length / surface.length).toBeGreaterThanOrEqual(0.9);
        }
      }
    });
  },
);

describe("a subject on a stage", () => {
  const sky = () => {
    const canvas = new Canvas();
    canvas.rect(0, 0, PLATE_WIDTH - 1, 59, INK.horizon);
    return canvas;
  };
  const flat = (row: number) => new Array<number>(PLATE_WIDTH).fill(row);

  const drawOn = (subject: keyof typeof SUBJECTS, stage: Stage, seed = 3) => {
    const canvas = sky();
    SUBJECTS[subject](randomStream(seed, 2)).draw(canvas, stage);
    const added = [...canvas.pixels.keys()].filter(
      (i) => canvas.pixels[i] !== INK.horizon,
    );
    return { canvas, added };
  };

  const meanColumn = (cells: readonly number[]) =>
    cells.reduce((sum, i) => sum + (i % PLATE_WIDTH), 0) / cells.length;

  test("turns its lit side toward the light", () => {
    for (const light of [-1000, 1000]) {
      for (let seed = 0; seed < 12; seed++) {
        const { canvas, added } = drawOn(
          "cabin",
          { surface: flat(50), x: 80, light },
          seed,
        );
        const colours = resolveInks(canvas, PALETTES.dusk);
        const lum = (i: number) => luminance(colours[canvas.pixels[i]]);
        const lit = Math.max(...added.map(lum));
        const isLamp = (ink: number) => {
          const recipe = canvas.recipes[ink];
          return recipe.kind === "legible" && recipe.from[0] === INK.sun;
        };
        const body = added.filter((i) => !isLamp(canvas.pixels[i]));
        const bright = body.filter(
          (i) => lum(i) === Math.max(...body.map(lum)),
        );
        const dim = body.filter((i) => lum(i) < Math.max(...body.map(lum)));
        expect(lit).toBeGreaterThan(0);
        const faces = Math.sign(meanColumn(bright) - meanColumn(dim));
        expect(faces).toBe(Math.sign(light));
      }
    }
  });

  test("draws a telegraph line in the dark body ink", () => {
    for (let seed = 0; seed < 12; seed++) {
      const { canvas, added } = drawOn(
        "road",
        { surface: flat(40), x: 50, light: 1000 },
        seed,
      );
      const line = added.filter((i) => rowOf(i) < 40);
      expect(line.length).toBeGreaterThan(0);
      for (const i of line) expect(canvas.pixels[i]).toBe(INK.front);
    }
  });

  test("runs a line of pylons toward the light", () => {
    for (const light of [-1000, 1000]) {
      const { added } = drawOn("pylons", { surface: flat(50), x: 80, light });
      const towers = added.filter((i) => rowOf(i) > 40);
      expect(Math.sign(meanColumn(towers) - 80)).toBe(Math.sign(light));
    }
  });

  test("sinks its foot to the lowest ground under it", () => {
    const slope = Array.from(
      { length: PLATE_WIDTH },
      (_, x) => 40 + ((x - 80) >> 1),
    );
    for (let seed = 0; seed < 12; seed++) {
      const { added } = drawOn(
        "tent",
        { surface: slope, x: 80, light: 1000 },
        seed,
      );
      const columns = added.map((i) => i % PLATE_WIDTH);
      const lowest = Math.max(...columns.map((x) => slope[x]));
      expect(Math.max(...added.map(rowOf))).toBeGreaterThanOrEqual(lowest);
    }
  });
});
