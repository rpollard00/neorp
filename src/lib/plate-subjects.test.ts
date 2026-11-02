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

  test("its edge stands apart from what is behind it on every palette", () => {
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
        if (edges > 0) expect(apart / edges).toBeGreaterThanOrEqual(EDGE_FLOOR);
      }
    }
  });
});
