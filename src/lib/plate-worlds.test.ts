import { describe, expect, test } from "bun:test";
import { Canvas, INK, randomStream } from "./plate-canvas";
import { WORLDS } from "./plate-worlds";

const SEEDS = Array.from({ length: 24 }, (_, i) => Math.imul(i + 1, 40503));

const paint = (name: keyof typeof WORLDS, seed: number) => {
  const canvas = new Canvas();
  WORLDS[name](canvas, randomStream(seed, 1));
  return canvas;
};

describe.each(Object.keys(WORLDS) as (keyof typeof WORLDS)[])("%s", (name) => {
  test("is the same world for the same seed", () => {
    expect(paint(name, 5).pixels).toEqual(paint(name, 5).pixels);
  });

  test("keeps a sky, a plain, and room for stars", () => {
    for (const seed of SEEDS) {
      const canvas = paint(name, seed);
      expect(canvas.pixels.subarray(0, 160).includes(INK.top)).toBe(true);
      expect([INK.back, INK.front]).toContain(canvas.get(80, 59) as 4 | 5);
      expect(canvas.stars.darkSkies).toBe(true);
    }
  });
});
