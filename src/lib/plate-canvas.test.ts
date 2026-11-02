import { describe, expect, test } from "bun:test";
import {
  Canvas,
  contrast,
  INK,
  PLATE_HEIGHT,
  PLATE_WIDTH,
  randomStream,
  resolveInks,
  rgb,
  rolling,
  tidy,
} from "./plate-canvas";
import { PALETTES } from "./palettes";

const dusk = PALETTES.dusk;

describe("inks", () => {
  test("a mix moves by eighths and is registered once", () => {
    const canvas = new Canvas();
    const half = { from: INK.top, to: INK.horizon, by: 4 } as const;
    const ink = canvas.mix(half);
    expect(canvas.mix(half)).toBe(ink);
    const [r, g, b] = resolveInks(canvas, dusk)[ink];
    const [a, c] = [rgb(dusk.sky.top), rgb(dusk.sky.horizon)];
    expect([r, g, b]).toEqual([
      Math.round((a[0] + c[0]) / 2),
      Math.round((a[1] + c[1]) / 2),
      Math.round((a[2] + c[2]) / 2),
    ]);
  });

  test("a legible ink falls through to the first that reads", () => {
    const canvas = new Canvas();
    const ink = canvas.legible({
      over: [[INK.front, 1]],
      from: [INK.front, INK.sun],
      min: 2,
    });
    expect(resolveInks(canvas, dusk)[ink]).toEqual(rgb(dusk.sun));
  });

  test("a legible ink takes the best when none reads", () => {
    const canvas = new Canvas();
    const ink = canvas.legible({
      over: [[INK.sun, 1]],
      from: [INK.sun, INK.front],
      min: 99,
    });
    expect(resolveInks(canvas, dusk)[ink]).toEqual(rgb(dusk.hills.front));
  });

  test("contrast is symmetric and one for one colour", () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21);
    expect(contrast([9, 9, 9], [9, 9, 9])).toBe(1);
  });
});

describe("a canvas", () => {
  test("clips what falls outside the plate", () => {
    const canvas = new Canvas();
    canvas.rect(-5, -5, 500, 500, INK.sun);
    expect(canvas.pixels).toHaveLength(PLATE_WIDTH * PLATE_HEIGHT);
    expect(canvas.pixels.every((ink) => ink === INK.sun)).toBe(true);
  });

  test("a flipped sprite mirrors its rows", () => {
    const canvas = new Canvas();
    canvas.sprite({
      rows: ["#.."],
      x: 0,
      y: 0,
      inks: { "#": INK.sun },
      flip: true,
    });
    expect([...canvas.pixels.subarray(0, 3)]).toEqual([0, 0, INK.sun]);
  });
});

describe("random streams", () => {
  test("differ by purpose and repeat by seed", () => {
    const a = randomStream(5, 1);
    expect(randomStream(5, 1).next()).toBe(a.next());
    expect(randomStream(5, 2).next()).not.toBe(randomStream(5, 1).next());
  });
});

describe("contours", () => {
  test("have no one-pixel bump or notch", () => {
    const contour = tidy(
      rolling(randomStream(11, 3), { base: 40, amp: 4, knots: 4 }),
    );
    for (let x = 1; x < PLATE_WIDTH - 1; x++) {
      const bump = contour[x - 1] === contour[x + 1];
      if (bump) expect(contour[x]).toBe(contour[x - 1]);
    }
  });
});
