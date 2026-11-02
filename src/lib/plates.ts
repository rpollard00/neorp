import { crc32, deflateSync } from "node:zlib";
import {
  Canvas,
  INK,
  luminance,
  mixColours,
  PLATE_HEIGHT,
  PLATE_WIDTH,
  randomStream,
  resolveInks,
  rgb,
  type Random,
  type Rgb,
} from "./plate-canvas";
import { LANDS } from "./plate-lands";
import { SUBJECTS } from "./plate-subjects";
import { WORLDS } from "./plate-worlds";
import {
  PALETTE_NAMES,
  PALETTES,
  STAR_COLOUR,
  type PaletteName,
} from "./palettes";
import { pickScene, SCENES, type SceneName } from "./scenes";

export { PLATE_HEIGHT, PLATE_WIDTH };

const STREAM = {
  scene: 0x5ce6d,
  shapes: 0x54a9e,
  subject: 0x5b1ec,
  stars: 0x57a25,
};

const fnv1a = (text: string) => {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash = Math.imul(hash ^ byte, 0x01000193);
  }
  return hash >>> 0;
};

const PNG_BIT_DEPTH = 8;
const PNG_COLOUR_TYPE_RGB = 2;
const PNG_FILTER_NONE = 0;

const pngChunk = (type: string, data: Buffer) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

const encodePng = ({
  width,
  height,
  pixels,
}: {
  width: number;
  height: number;
  pixels: Buffer;
}) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = PNG_BIT_DEPTH;
  ihdr[9] = PNG_COLOUR_TYPE_RGB;

  const stride = width * 3;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + stride);
    raw[row] = PNG_FILTER_NONE;
    pixels.copy(raw, row + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

/** The scene and its shapes, in inks. A palette has no way in here. */
export const composeScene = ({
  scene,
  seed,
}: {
  scene: SceneName;
  seed: number;
}) => {
  const canvas = new Canvas();
  const shapes = randomStream(seed, STREAM.shapes);
  const picked = SCENES[scene];
  if (picked.kind === "world") {
    WORLDS[picked.world](canvas, shapes);
    return canvas;
  }
  const subject = picked.subject
    ? SUBJECTS[picked.subject](randomStream(seed, STREAM.subject))
    : null;
  const stage = LANDS[picked.land](canvas, shapes, subject?.footprint ?? null);
  subject?.draw(canvas, stage);
  return canvas;
};

const DARK_SKY = 0.04;

const isOpenSky = ({ pixels }: Canvas, x: number, y: number) => {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const at = (y + dy) * PLATE_WIDTH + x + dx;
      if (y + dy >= 0 && pixels[at] > INK.horizon) return false;
    }
  }
  return true;
};

const starPoints = (
  canvas: Canvas,
  random: Random,
  count: number,
  limit: number,
) => {
  const placed: (readonly [number, number])[] = [];
  for (let tries = 0; placed.length < count && tries < 2000; tries++) {
    const x = random.below(PLATE_WIDTH);
    const y = random.below(limit);
    const apart = placed.every(
      ([a, b]) => Math.abs(a - x) + Math.abs(b - y) >= 7,
    );
    if (apart && isOpenSky(canvas, x, y)) placed.push([x, y]);
  }
  return placed;
};

/** The stars of a palette, on a stream of their own, in open sky only. */
const starsFor = ({
  canvas,
  palette,
  colours,
  seed,
}: {
  canvas: Canvas;
  palette: PaletteName;
  colours: readonly Rgb[];
  seed: number;
}) => {
  const random = randomStream(seed, STREAM.stars);
  const { limit, count, darkSkies } = canvas.stars;
  if (PALETTES[palette].stars) {
    return {
      colour: rgb(STAR_COLOUR),
      points: starPoints(canvas, random, count, limit),
    };
  }
  if (darkSkies && luminance(colours[INK.top]) < DARK_SKY) {
    return {
      colour: mixColours(colours[INK.middle], colours[INK.sun], 5),
      points: starPoints(canvas, random, count >> 1, Math.round(limit * 0.56)),
    };
  }
  return { colour: rgb(STAR_COLOUR), points: [] };
};

/** The plate as raw RGB, three bytes per pixel, row by row. */
export const renderPlate = ({
  palette,
  scene,
  seed,
}: {
  palette: PaletteName;
  scene: SceneName;
  seed: number;
}) => {
  const canvas = composeScene({ scene, seed });
  const colours = resolveInks(canvas, PALETTES[palette]);
  const pixels = Buffer.alloc(PLATE_WIDTH * PLATE_HEIGHT * 3);
  canvas.pixels.forEach((ink, i) => pixels.set(colours[ink], i * 3));
  const stars = starsFor({ canvas, palette, colours, seed });
  for (const [x, y] of stars.points) {
    pixels.set(stars.colour, (y * PLATE_WIDTH + x) * 3);
  }
  return { width: PLATE_WIDTH, height: PLATE_HEIGHT, pixels };
};

export const drawPlate = (plate: Parameters<typeof renderPlate>[0]) =>
  encodePng(renderPlate(plate));

/**
 * The slug seeds the shapes. Without a `plate:` or a `scene:`, it also picks
 * the palette and the scene.
 */
export const plateFor = ({
  id,
  data,
}: {
  id: string;
  data: { plate?: PaletteName; scene?: SceneName };
}) => {
  const seed = fnv1a(id);
  const palette = data.plate ?? PALETTE_NAMES[seed % PALETTE_NAMES.length];
  const scene = data.scene ?? pickScene(randomStream(seed, STREAM.scene).next);
  return { palette, scene, seed, url: `/plates/${id}.png` };
};
