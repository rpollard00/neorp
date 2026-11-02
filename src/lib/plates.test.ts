import { describe, expect, test } from "bun:test";
import {
  Canvas,
  INK,
  mixColours,
  randomStream,
  resolveInks,
  rgb,
  type Rgb,
} from "./plate-canvas";
import { LANDS } from "./plate-lands";
import { SUBJECTS } from "./plate-subjects";
import {
  composeScene,
  drawPlate,
  plateFor,
  PLATE_HEIGHT,
  STREAM,
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
  test.each([
    { palette: "dusk", scene: "peaks-cabin", seed: 7 },
    { palette: "night", scene: "fields", seed: 7 },
    { palette: "dusk", scene: "ringed", seed: 7 },
  ] as const)("gives the same pixels for $palette $scene", (plate) => {
    const pixels = renderPlate(plate).pixels;
    expect(renderPlate(plate).pixels).toEqual(pixels);
    if (plate.scene !== "peaks-cabin") {
      expect(pixelColours(pixels)).toContain(
        plate.palette === "night"
          ? key(rgb(STAR_COLOUR))
          : key(
              mixColours(
                rgb(PALETTES.dusk.sky.middle),
                rgb(PALETTES.dusk.sun),
                5,
              ),
            ),
      );
    }
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
      pairs.size === new Set([...pairs].map((p) => p.split("|")[0])).size &&
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

describe("composeScene", () => {
  test("gives each purpose its own random stream", () => {
    expect(new Set(Object.values(STREAM)).size).toBe(
      Object.keys(STREAM).length,
    );
  });

  const pairs = SCENE_NAMES.flatMap((name) => {
    const scene = SCENES[name];
    return scene.kind === "land" && scene.subject
      ? [{ name, land: scene.land, subject: scene.subject }]
      : [];
  });

  test.each(pairs)(
    "draws the subject of $name over its land",
    ({ name, land, subject }) => {
      for (const seed of SEEDS) {
        const bare = new Canvas();
        const placed = SUBJECTS[subject](randomStream(seed, STREAM.subject));
        const stage = LANDS[land](
          bare,
          randomStream(seed, STREAM.shapes),
          placed.footprint,
        );
        const levelled = bare.pixels.slice();
        placed.draw(bare, stage);
        const whole = composeScene({ scene: name, seed }).pixels;
        expect(whole).toEqual(bare.pixels);
        const added = whole.filter((ink, i) => ink !== levelled[i]);
        expect(added.length).toBeGreaterThan(0);
      }
    },
  );
});

/** The land of a scene with its subject's site made, before the subject. */
const landOf = (scene: SceneName, seed: number) => {
  const picked = SCENES[scene];
  const canvas = new Canvas();
  if (picked.kind === "world") {
    return composeScene({ scene, seed });
  }
  const footprint = picked.subject
    ? SUBJECTS[picked.subject](randomStream(seed, STREAM.subject)).footprint
    : null;
  LANDS[picked.land](canvas, randomStream(seed, STREAM.shapes), footprint);
  return canvas;
};

const OPEN: readonly number[] = [INK.top, INK.middle, INK.horizon, INK.sun];
const SWEEP = [
  3668339987,
  ...Array.from({ length: 60 }, (_, i) => Math.imul(i + 1, 40503)),
];

describe("land without dither", () => {
  /** Where every shape is flat colour, nothing clips down to a speck. */
  const FLAT = SCENE_NAMES.filter((scene) => {
    const picked = SCENES[scene];
    return picked.kind === "world"
      ? ["hull", "mega", "moons", "monolith"].includes(picked.world)
      : ["peaks", "dunes", "fields"].includes(picked.land);
  });

  /** Dunes overlap, so a clipped shadow may not even leave a thin sliver. */
  const longest = (scene: SceneName) => (scene.startsWith("dunes") ? 12 : 2);

  test.each([...FLAT])("%s has no speck or clipped sliver", (scene) => {
    const limit = longest(scene);
    for (const seed of SWEEP) {
      const canvas = landOf(scene, seed);
      const specks: string[] = [];
      for (let y = 0; y < PLATE_HEIGHT; y++) {
        for (let x = 0; x < PLATE_WIDTH; x++) {
          const ink = canvas.get(x, y);
          if (OPEN.includes(ink)) continue;
          const piece = [[x, y]];
          for (let i = 0; i < piece.length && piece.length <= limit; i++) {
            const [px, py] = piece[i];
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const [nx, ny] = [px + dx, py + dy];
                const inside =
                  nx >= 0 && nx < PLATE_WIDTH && ny >= 0 && ny < PLATE_HEIGHT;
                if (!inside || canvas.get(nx, ny) !== ink) continue;
                if (piece.some(([qx, qy]) => qx === nx && qy === ny)) continue;
                piece.push([nx, ny]);
              }
            }
          }
          const thin =
            new Set(piece.map(([, py]) => py)).size === 1 ||
            new Set(piece.map(([px]) => px)).size === 1;
          const speck = piece.length <= 2 || (piece.length <= limit && thin);
          if (speck) specks.push(`${seed}@${x},${y}`);
        }
      }
      expect(specks).toEqual([]);
    }
  });
});

describe("the light", () => {
  const LAND_SCENES = SCENE_NAMES.filter(
    (scene) => SCENES[scene].kind === "land",
  );
  const CLEAR_AIR = 4;

  test.each([...LAND_SCENES])("keeps clear air around it in %s", (scene) => {
    for (let i = 0; i < 150; i++) {
      const seed = Math.imul(i + 1, 2654435761) >>> 0;
      const canvas = landOf(scene, seed);
      for (let y = 0; y < PLATE_HEIGHT; y++) {
        for (let x = 0; x < PLATE_WIDTH; x++) {
          if (canvas.get(x, y) !== INK.sun) continue;
          const inSky = [
            [x - 1, y],
            [x + 1, y],
            [x, y - 1],
            [x, y + 1],
          ].some(([nx, ny]) => canvas.get(nx, ny) <= INK.horizon);
          if (!inSky) continue;
          for (let dy = -CLEAR_AIR; dy <= CLEAR_AIR; dy++) {
            for (let dx = -CLEAR_AIR; dx <= CLEAR_AIR; dx++) {
              const ink = canvas.get(x + dx, y + dy);
              if (ink > INK.horizon && ink !== INK.sun) {
                throw new Error(
                  `${scene} ${seed}: land at ${x + dx},${y + dy}`,
                );
              }
            }
          }
        }
      }
    }
  });
});
describe("a cloud", () => {
  const CLOUDED = SCENE_NAMES.filter((scene) => {
    const picked = SCENES[scene];
    return picked.kind === "land" && picked.land !== "sea";
  });

  test.each([...CLOUDED])("keeps clear air under it in %s", (scene) => {
    for (const seed of SWEEP) {
      const canvas = landOf(scene, seed);
      const cloud = canvas.recipes.findIndex(
        (r) =>
          r.kind === "mix" &&
          r.from === INK.horizon &&
          r.to === INK.sun &&
          r.by === 4,
      );
      if (cloud < 0) continue;
      for (let y = 0; y < PLATE_HEIGHT; y++) {
        for (let x = 0; x < PLATE_WIDTH; x++) {
          if (canvas.get(x, y) !== cloud || canvas.get(x, y + 1) === cloud) {
            continue;
          }
          // The row under a cloud's lowest strip is its shadow strip.
          for (let dy = 2; dy <= 4; dy++) {
            const ink = canvas.get(x, y + dy);
            if (ink > INK.horizon && ink !== cloud) {
              throw new Error(`${scene} ${seed}: land under ${x},${y}`);
            }
          }
        }
      }
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
  }, 30_000);
});

describe("plateFor", () => {
  test("lets the slug decide without frontmatter", () => {
    const plate = plateFor({ id: "hello-world", data: {} });
    expect(plateFor({ id: "hello-world", data: {} })).toEqual(plate);
    expect(plate.url).toBe("/plates/hello-world.png");
    expect(PALETTE_NAMES).toContain(plate.palette);
    expect(SCENE_NAMES).toContain(plate.scene);
  });

  test("keeps the scene when `plate:` is set, and the palette when `scene:` is", () => {
    for (let i = 0; i < 40; i++) {
      const id = `post-${i}`;
      const own = plateFor({ id, data: {} });
      for (const plate of PALETTE_NAMES) {
        expect(plateFor({ id, data: { plate } }).scene).toBe(own.scene);
      }
      for (const scene of SCENE_NAMES) {
        expect(plateFor({ id, data: { scene } }).palette).toBe(own.palette);
      }
    }
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
