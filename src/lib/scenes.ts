export const SCENE_NAMES = [
  "sea",
  "sea-lighthouse",
  "sea-sailboat",
  "peaks",
  "peaks-cabin",
  "peaks-mast",
  "peaks-tent",
  "dunes",
  "dunes-tent",
  "dunes-mast",
  "dunes-road",
  "forest",
  "forest-cabin",
  "forest-mast",
  "forest-tent",
  "mesas",
  "mesas-road",
  "mesas-pylons",
  "mesas-mast",
  "mesas-tent",
  "lake",
  "lake-sailboat",
  "lake-cabin",
  "lake-tree",
  "fields",
  "fields-tree",
  "fields-pylons",
  "fields-road",
  "fields-cabin",
  "fields-birds",
  "ringed",
  "moons",
  "monolith",
  "gate",
  "hull",
  "colony",
  "mega",
] as const;

export type SceneName = (typeof SCENE_NAMES)[number];

export type LandName =
  "sea" | "peaks" | "dunes" | "forest" | "mesas" | "lake" | "fields";

export type SubjectName =
  | "lighthouse"
  | "cabin"
  | "pylons"
  | "sailboat"
  | "mast"
  | "tree"
  | "birds"
  | "road"
  | "tent";

export type WorldName =
  "ringed" | "moons" | "monolith" | "gate" | "hull" | "colony" | "mega";

export type Scene =
  | { kind: "land"; land: LandName; subject: SubjectName | null }
  | { kind: "world"; world: WorldName };

const land = (land: LandName, subject: SubjectName | null = null): Scene => ({
  kind: "land",
  land,
  subject,
});

const world = (world: WorldName): Scene => ({ kind: "world", world });

export const SCENES = {
  sea: land("sea"),
  "sea-lighthouse": land("sea", "lighthouse"),
  "sea-sailboat": land("sea", "sailboat"),
  peaks: land("peaks"),
  "peaks-cabin": land("peaks", "cabin"),
  "peaks-mast": land("peaks", "mast"),
  "peaks-tent": land("peaks", "tent"),
  dunes: land("dunes"),
  "dunes-tent": land("dunes", "tent"),
  "dunes-mast": land("dunes", "mast"),
  "dunes-road": land("dunes", "road"),
  forest: land("forest"),
  "forest-cabin": land("forest", "cabin"),
  "forest-mast": land("forest", "mast"),
  "forest-tent": land("forest", "tent"),
  mesas: land("mesas"),
  "mesas-road": land("mesas", "road"),
  "mesas-pylons": land("mesas", "pylons"),
  "mesas-mast": land("mesas", "mast"),
  "mesas-tent": land("mesas", "tent"),
  lake: land("lake"),
  "lake-sailboat": land("lake", "sailboat"),
  "lake-cabin": land("lake", "cabin"),
  "lake-tree": land("lake", "tree"),
  fields: land("fields"),
  "fields-tree": land("fields", "tree"),
  "fields-pylons": land("fields", "pylons"),
  "fields-road": land("fields", "road"),
  "fields-cabin": land("fields", "cabin"),
  "fields-birds": land("fields", "birds"),
  ringed: world("ringed"),
  moons: world("moons"),
  monolith: world("monolith"),
  gate: world("gate"),
  hull: world("hull"),
  colony: world("colony"),
  mega: world("mega"),
} satisfies Record<SceneName, Scene>;

const WORLD_CHANCE = 1 / 12;
const SUBJECT_CHANCE = 2 / 3;

const WORLD_SCENES = SCENE_NAMES.filter(
  (name) => SCENES[name].kind === "world",
);
const LAND_SCENES = SCENE_NAMES.filter((name) => {
  const scene: Scene = SCENES[name];
  return scene.kind === "land" && scene.subject === null;
});

const subjectsOf = (name: SceneName) =>
  SCENE_NAMES.filter((other) => other.startsWith(`${name}-`));

export const pickScene = (random: () => number): SceneName => {
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(random() * items.length)];
  if (random() < WORLD_CHANCE) return pick(WORLD_SCENES);
  const land = pick(LAND_SCENES);
  return random() < SUBJECT_CHANCE ? pick(subjectsOf(land)) : land;
};
