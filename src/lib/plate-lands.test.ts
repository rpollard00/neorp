import { describe, expect, test } from "bun:test";
import {
  Canvas,
  PLATE_HEIGHT,
  PLATE_WIDTH,
  randomStream,
} from "./plate-canvas";
import { LANDS, type Footprint, type Stage } from "./plate-lands";

const SEEDS = Array.from({ length: 60 }, (_, i) => Math.imul(i + 1, 40503));
const ON_GROUND: Footprint = { on: "ground", width: 15, run: 0 };

const painted = new Map<string, { canvas: Canvas; stage: Stage }>();

/** Each land and seed is painted once and shared by the checks below. */
const paint = (name: keyof typeof LANDS, seed: number) => {
  const id = `${name}:${seed}`;
  const found = painted.get(id);
  if (found) return found;
  const canvas = new Canvas();
  const stage = LANDS[name](canvas, randomStream(seed, 1), ON_GROUND);
  painted.set(id, { canvas, stage });
  return { canvas, stage };
};

describe.each(Object.keys(LANDS) as (keyof typeof LANDS)[])("%s", (name) => {
  test("is the same land for the same seed", () => {
    const again = new Canvas();
    LANDS[name](again, randomStream(9, 1), ON_GROUND);
    expect(paint(name, 9).canvas.pixels).toEqual(again.pixels);
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
