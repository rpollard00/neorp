import { describe, expect, test } from "bun:test";
import { pickScene, SCENE_NAMES, SCENES } from "./scenes";

/** A small repeatable generator, so that the odds are measured and not luck. */
const lcg = (seed: number) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

describe("the scene table", () => {
  test("names each scene after what it shows", () => {
    for (const name of SCENE_NAMES) {
      const scene = SCENES[name];
      const expected =
        scene.kind === "world"
          ? scene.world
          : [scene.land, scene.subject].filter(Boolean).join("-");
      expect(name).toBe(expected as typeof name);
    }
  });

  test("has every land alone and with at least one subject", () => {
    const lands = SCENE_NAMES.flatMap((name) => {
      const scene = SCENES[name];
      return scene.kind === "land" && !scene.subject ? [scene.land] : [];
    });
    expect(lands).toHaveLength(7);
    for (const land of lands) {
      const paired = SCENE_NAMES.filter((name) => name.startsWith(`${land}-`));
      expect(paired.length).toBeGreaterThan(0);
    }
  });

  test("has no aurora", () => {
    expect(SCENE_NAMES.join()).not.toContain("aurora");
  });
});

describe("pickScene", () => {
  const random = lcg(7);
  const picks = Array.from({ length: 60000 }, () => pickScene(random));
  const share = (accepts: (name: (typeof SCENE_NAMES)[number]) => boolean) =>
    picks.filter(accepts).length / picks.length;

  test("reaches every scene", () => {
    expect(new Set(picks)).toEqual(new Set(SCENE_NAMES));
  });

  test("makes about 1 plate in 12 a world", () => {
    const worlds = share((name) => SCENES[name].kind === "world");
    expect(worlds).toBeGreaterThan(0.075);
    expect(worlds).toBeLessThan(0.092);
  });

  test("gives about two thirds of the lands a subject", () => {
    const lands = share((name) => SCENES[name].kind === "land");
    const subjects = share((name) => name.includes("-"));
    expect(subjects / lands).toBeGreaterThan(0.63);
    expect(subjects / lands).toBeLessThan(0.7);
  });

  test("gives each land the same chance", () => {
    for (const land of ["sea", "peaks", "fields"]) {
      const odds = share((name) => name.split("-")[0] === land);
      expect(odds).toBeGreaterThan((11 / 12 / 7) * 0.9);
      expect(odds).toBeLessThan((11 / 12 / 7) * 1.1);
    }
  });
});
