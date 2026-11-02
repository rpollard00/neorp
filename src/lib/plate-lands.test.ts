import { describe, expect, test } from "bun:test";
import {
  Canvas,
  PLATE_HEIGHT,
  PLATE_WIDTH,
  randomStream,
} from "./plate-canvas";
import { LANDS, type Footprint } from "./plate-lands";

const SEEDS = Array.from({ length: 200 }, (_, i) => Math.imul(i + 1, 40503));
const ON_GROUND: Footprint = { on: "ground", width: 15, run: 0 };

const paint = (name: keyof typeof LANDS, seed: number, print = ON_GROUND) => {
  const canvas = new Canvas();
  const stage = LANDS[name](canvas, randomStream(seed, 1), print);
  return { canvas, stage };
};

describe.each(Object.keys(LANDS) as (keyof typeof LANDS)[])("%s", (name) => {
  test("is the same land for the same seed", () => {
    expect(paint(name, 9).canvas.pixels).toEqual(paint(name, 9).canvas.pixels);
  });

  test("keeps the light far from the site", () => {
    for (const seed of SEEDS) {
      const { stage } = paint(name, seed);
      expect(Math.abs(stage.light - stage.x)).toBeGreaterThanOrEqual(24);
    }
  });

  test("levels the site inside the plate", () => {
    for (const seed of SEEDS) {
      const { stage } = paint(name, seed);
      const half = ON_GROUND.width >> 1;
      const site = stage.surface.slice(stage.x - half, stage.x + half + 1);
      expect(stage.x - half).toBeGreaterThanOrEqual(0);
      expect(stage.x + half).toBeLessThan(PLATE_WIDTH);
      expect(new Set(site).size).toBe(1);
      expect(site[0]).toBeLessThan(PLATE_HEIGHT);
    }
  });
});
