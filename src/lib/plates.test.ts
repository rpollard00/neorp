import { describe, expect, test } from "bun:test";
import { INK, mixColours, resolveInks, rgb, type Rgb } from "./plate-canvas";
import {
  composeScene,
  drawPlate,
  plateFor,
  PLATE_HEIGHT,
  PLATE_WIDTH,
  renderPlate,
} from "./plates";
import {
  PALETTE_NAMES,
  PALETTES,
  STAR_COLOUR,
  type PaletteName,
} from "./palettes";
import { SCENE_NAMES, SCENES, type SceneName } from "./scenes";

const SEEDS = [1, 42, 0x9e3779b1, 0xdeadbeef, 305419896];
const COLOUR_CAP = 12;
const SUBJECT_COLOUR_CAP = 14;

const key = ([r, g, b]: Rgb) => `${r},${g},${b}`;

const pixelColours = (pixels: Uint8Array) => {
  const out: string[] = [];
  for (let i = 0; i < pixels.length; i += 3) {
    out.push(key([pixels[i], pixels[i + 1], pixels[i + 2]]));
  }
  return out;
};

const baseColours = (palette: PaletteName) => {
  const { sky, sun, hills } = PALETTES[palette];
  return [sky.top, sky.middle, sky.horizon, sun, hills.back, hills.front].map(
    rgb,
  );
};

const allowedColours = (palette: PaletteName) => {
  const base = baseColours(palette);
  const mixes = base.flatMap((a) =>
    base.flatMap((b) =>
      [1, 2, 3, 4, 5, 6, 7].map((by) => mixColours(a, b, by)),
    ),
  );
  return new Set([...base, ...mixes, rgb(STAR_COLOUR)].map(key));
};

const colourCap = (scene: SceneName) => {
  const picked = SCENES[scene];
  return picked.kind === "land" && picked.subject
    ? SUBJECT_COLOUR_CAP
    : COLOUR_CAP;
};

describe("renderPlate", () => {
  test("gives the same pixels for the same input", () => {
    const plate = { palette: "dusk", scene: "peaks-cabin", seed: 7 } as const;
    expect(renderPlate(plate).pixels).toEqual(renderPlate(plate).pixels);
  });

  test.each([...SCENE_NAMES])(
    "%s fits the plate and the colour rules",
    (scene) => {
      for (const palette of PALETTE_NAMES) {
        const allowed = allowedColours(palette);
        for (const seed of SEEDS) {
          const plate = renderPlate({ palette, scene, seed });
          expect([plate.width, plate.height]).toEqual([
            PLATE_WIDTH,
            PLATE_HEIGHT,
          ]);
          expect(plate.pixels).toHaveLength(PLATE_WIDTH * PLATE_HEIGHT * 3);
          const colours = new Set(pixelColours(plate.pixels));
          expect(colours.size).toBeLessThanOrEqual(colourCap(scene));
          for (const colour of colours) expect(allowed.has(colour)).toBe(true);
        }
      }
    },
  );

  test("drawPlate writes the plate as a PNG", () => {
    const png = drawPlate({ palette: "sea", scene: "gate", seed: 3 });
    expect([...png.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    expect(png.readUInt32BE(16)).toBe(PLATE_WIDTH);
    expect(png.readUInt32BE(20)).toBe(PLATE_HEIGHT);
  });
});

describe("the palette changes colour only", () => {
  const SKY_INKS: readonly number[] = [INK.top, INK.middle, INK.horizon];

  test.each([...SCENE_NAMES])("%s has one ink map for all", (scene) => {
    for (const seed of SEEDS) {
      const canvas = composeScene({ scene, seed });
      for (const palette of PALETTE_NAMES) {
        const colours = resolveInks(canvas, PALETTES[palette]).map(key);
        const rendered = pixelColours(
          renderPlate({ palette, scene, seed }).pixels,
        );
        const stars = rendered.filter(
          (colour, i) => colour !== colours[canvas.pixels[i]],
        );
        rendered.forEach((colour, i) => {
          if (colour !== colours[canvas.pixels[i]]) {
            expect(SKY_INKS).toContain(canvas.pixels[i]);
          }
        });
        expect(new Set(stars).size).toBeLessThanOrEqual(1);
      }
    }
  });

  const sameShapes = (a: PaletteName, b: PaletteName, scene: SceneName) => {
    const seed = 0xc0ffee;
    const [left, right] = [a, b].map((palette) =>
      pixelColours(renderPlate({ palette, scene, seed }).pixels),
    );
    const star = key(rgb(STAR_COLOUR));
    const pairs = new Set(
      left.flatMap((colour, i) =>
        colour === star || right[i] === star ? [] : [`${colour}|${right[i]}`],
      ),
    );
    return (
      pairs.size === new Set([...pairs].map((p) => p.split("|")[0])).size ||
      pairs.size === new Set([...pairs].map((p) => p.split("|")[1])).size
    );
  };

  test("plain lands keep their shapes as rendered pixels", () => {
    const lands = SCENE_NAMES.filter((scene) => !scene.includes("-")).filter(
      (scene) => SCENES[scene].kind === "land",
    );
    for (const scene of lands) {
      for (const palette of ["dawn", "night", "ember", "sea"] as const) {
        expect(sameShapes("day", palette, scene)).toBe(true);
      }
    }
  });
});

describe("land without dither", () => {
  /** Where every shape is flat colour, a pixel always has a neighbour of its ink. */
  const FLAT: readonly SceneName[] = [
    "peaks",
    "dunes",
    "fields",
    "hull",
    "mega",
    "moons",
    "monolith",
  ];
  const OPEN: readonly number[] = [INK.top, INK.middle, INK.horizon, INK.sun];

  test.each([...FLAT])("%s has no lone pixel", (scene) => {
    for (let seed = 0; seed < 40; seed++) {
      const canvas = composeScene({ scene, seed: Math.imul(seed + 1, 40503) });
      const lone: string[] = [];
      for (let y = 0; y < PLATE_HEIGHT; y++) {
        for (let x = 0; x < PLATE_WIDTH; x++) {
          const ink = canvas.get(x, y);
          if (OPEN.includes(ink)) continue;
          let alone = true;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const [nx, ny] = [x + dx, y + dy];
              const inside =
                nx >= 0 && nx < PLATE_WIDTH && ny >= 0 && ny < PLATE_HEIGHT;
              if ((dx || dy) && inside && canvas.get(nx, ny) === ink) {
                alone = false;
              }
            }
          }
          if (alone) lone.push(`${x},${y}`);
        }
      }
      expect(lone).toEqual([]);
    }
  });
});

describe("peaks", () => {
  test("shade the side away from the light", () => {
    const palette = "day";
    const lit = key(mixColours(rgb("#eef0e6"), rgb("#6f9199"), 6));
    const shade = key(mixColours(rgb("#6f9199"), rgb("#355560"), 3));
    const sun = key(rgb(PALETTES[palette].sun));
    let toward = 0;
    let away = 0;
    for (let seed = 1; seed < 400; seed++) {
      const colours = pixelColours(
        renderPlate({ palette, scene: "peaks", seed }).pixels,
      );
      const sunAt = colours.flatMap((c, i) => (c === sun ? [i] : []));
      if (sunAt.length < 100) continue;
      const sunX =
        sunAt.reduce((sum, i) => sum + (i % PLATE_WIDTH), 0) / sunAt.length;
      colours.forEach((colour, i) => {
        if (i % PLATE_WIDTH === PLATE_WIDTH - 1) return;
        const pair = [colour, colours[i + 1]];
        const litOnRight = pair[0] === shade && pair[1] === lit;
        const litOnLeft = pair[0] === lit && pair[1] === shade;
        if (!litOnRight && !litOnLeft) return;
        const faces = i % PLATE_WIDTH < sunX ? litOnRight : litOnLeft;
        if (faces) toward++;
        else away++;
      });
    }
    expect(toward + away).toBeGreaterThan(200);
    expect(toward / (toward + away)).toBeGreaterThan(0.9);
  });
});

describe("plateFor", () => {
  test("lets the slug decide without frontmatter", () => {
    const plate = plateFor({ id: "hello-world", data: {} });
    expect(plateFor({ id: "hello-world", data: {} })).toEqual(plate);
    expect(plate.url).toBe("/plates/hello-world.png");
    expect(PALETTE_NAMES).toContain(plate.palette);
    expect(SCENE_NAMES).toContain(plate.scene);
  });

  test("honours `plate:` and `scene:`", () => {
    const data = { plate: "storm", scene: "monolith" } as const;
    expect(plateFor({ id: "hello-world", data })).toMatchObject({
      palette: "storm",
      scene: "monolith",
      seed: plateFor({ id: "hello-world", data: {} }).seed,
    });
  });

  test("picks the scene apart from the palette", () => {
    const plates = Array.from({ length: 20000 }, (_, i) =>
      plateFor({ id: `post-${i}`, data: {} }),
    );
    const scenes = new Set(plates.map(({ scene }) => scene));
    expect(scenes).toEqual(new Set(SCENE_NAMES));
    const worlds = plates.filter(({ scene }) => SCENES[scene].kind === "world");
    expect(worlds.length / plates.length).toBeGreaterThan(0.07);
    expect(worlds.length / plates.length).toBeLessThan(0.097);
    for (const palette of PALETTE_NAMES) {
      const own = worlds.filter((plate) => plate.palette === palette);
      expect(own.length).toBeGreaterThan(worlds.length / 11 / 2);
    }
  });
});
