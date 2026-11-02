import { describe, expect, test } from "bun:test";
import {
  Canvas,
  contrast,
  INK,
  PLATE_WIDTH,
  randomStream,
  resolveInks,
  type Sprite,
} from "./plate-canvas";
import { LANDS } from "./plate-lands";
import * as DRAWINGS from "./plate-sprites";
import { SUBJECTS } from "./plate-subjects";
import { PALETTE_NAMES, PALETTES } from "./palettes";
import { SCENE_NAMES, SCENES } from "./scenes";

const SEEDS = Array.from({ length: 16 }, (_, i) => Math.imul(i + 1, 40503));
const TALLEST = 19;

const PAIRS = SCENE_NAMES.flatMap((name) => {
  const scene = SCENES[name];
  return scene.kind === "land" && scene.subject
    ? [{ name, land: scene.land, subject: scene.subject }]
    : [];
});

const drawn = ({ land, subject }: (typeof PAIRS)[number], seed: number) => {
  const canvas = new Canvas();
  const placed = SUBJECTS[subject](randomStream(seed, 2));
  const stage = LANDS[land](canvas, randomStream(seed, 1), placed.footprint);
  const before = canvas.pixels.slice();
  placed.draw(canvas, stage);
  const added = [...canvas.pixels.keys()].filter(
    (i) => canvas.pixels[i] !== before[i],
  );
  return { canvas, stage, before, added };
};

const SILHOUETTES: readonly string[] = ["pylons", "mast", "tree", "birds"];

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

  test("reads against what is behind it on every palette", () => {
    const needed = SILHOUETTES.includes(pair.subject) ? 1.8 : 1.3;
    for (const palette of PALETTE_NAMES) {
      for (const seed of SEEDS.slice(0, 6)) {
        const { canvas, before, added } = drawn(pair, seed);
        const colours = resolveInks(canvas, PALETTES[palette]);
        const shown = added.filter((i) => before[i] <= INK.horizon);
        const reads = shown.filter(
          (i) =>
            contrast(colours[canvas.pixels[i]], colours[before[i]]) >= needed,
        );
        if (shown.length > 0) {
          expect(reads.length / shown.length).toBeGreaterThan(0.45);
        }
      }
    }
  });
});
