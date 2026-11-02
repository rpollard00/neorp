import { styleText } from "node:util";
import { PALETTE_NAMES, type PaletteName } from "../../src/lib/palettes";
import type { PostData } from "../../src/lib/post";
import { renderPlate } from "../../src/lib/plates";
import { SCENE_NAMES, type SceneName } from "../../src/lib/scenes";
import { UserError } from "./user-error";

type Plate = ReturnType<typeof renderPlate>;

export type PlateChoice = { palette: PaletteName; scene: SceneName };

const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
/** A burst of typing or a held key arrives as one chunk of several keys. */
const KEYS = /\x1b\[[\d;]*[A-Za-z~]|\x1bO[A-Za-z]|[\s\S]/g;
const HINT =
  "←/→ or h/l palette · ↑/↓ or k/j scene · enter to pick · esc to cancel";
const RESERVED_LINES = 4;
const SIGNALS = [
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const;

const lineCount = (height: number, step: number) =>
  Math.ceil(Math.ceil(height / step) / 2);

/**
 * The plate as terminal lines, two pixel rows per line through `▀`. A plate
 * bigger than `columns` by `lines` keeps every k-th pixel on both axes, for
 * the smallest k that fits, so each cell is still one flat colour.
 */
export const halfBlockLines = (
  plate: Plate,
  { columns, lines: maxLines }: { columns: number; lines: number },
): string[] => {
  const { width, height, pixels } = plate;
  let step = Math.max(1, Math.ceil(width / Math.max(1, columns)));
  while (step < height && lineCount(height, step) > maxLines) step++;
  const xs = Array.from(
    { length: Math.ceil(width / step) },
    (_, i) => i * step,
  );
  const ys = Array.from(
    { length: Math.ceil(height / step) },
    (_, i) => i * step,
  );
  const sgr = (layer: 38 | 48, x: number, y: number) => {
    const at = (y * width + x) * 3;
    return `${ESC}[${layer};2;${pixels[at]};${pixels[at + 1]};${pixels[at + 2]}m`;
  };

  const lines: string[] = [];
  for (let row = 0; row < ys.length; row += 2) {
    const top = ys[row];
    const bottom = ys.at(row + 1);
    let line = "";
    let fg = "";
    let bg = bottom === undefined ? `${ESC}[49m` : "";
    if (bg) line += bg;
    for (const x of xs) {
      const nextFg = sgr(38, x, top);
      if (nextFg !== fg) line += fg = nextFg;
      if (bottom !== undefined) {
        const nextBg = sgr(48, x, bottom);
        if (nextBg !== bg) line += bg = nextBg;
      }
      line += "▀";
    }
    lines.push(line + RESET);
  }
  return lines;
};

const paletteLine = (current: PaletteName) =>
  PALETTE_NAMES.map((name) =>
    name === current ? styleText("inverse", ` ${name} `) : ` ${name} `,
  ).join("");

const sceneLine = (current: SceneName) =>
  `${styleText("inverse", ` ${current} `)} ${styleText(
    "dim",
    `${SCENE_NAMES.indexOf(current) + 1}/${SCENE_NAMES.length}`,
  )}`;

const next = <T>(names: readonly T[], current: T, by: number) =>
  names[(names.indexOf(current) + by + names.length) % names.length];

type KeyResult = {
  choice: PlateChoice;
  outcome: "open" | "picked" | "cancelled" | "interrupted";
};

export const readKeys = (chunk: string, start: PlateChoice): KeyResult => {
  let choice = start;
  const palette = (by: number) => {
    choice = { ...choice, palette: next(PALETTE_NAMES, choice.palette, by) };
  };
  const scene = (by: number) => {
    choice = { ...choice, scene: next(SCENE_NAMES, choice.scene, by) };
  };
  for (const [key] of chunk.matchAll(KEYS)) {
    switch (key) {
      case `${ESC}[D`:
      case `${ESC}OD`:
      case "h":
        palette(-1);
        break;
      case `${ESC}[C`:
      case `${ESC}OC`:
      case "l":
        palette(1);
        break;
      case `${ESC}[A`:
      case `${ESC}OA`:
      case "k":
        scene(-1);
        break;
      case `${ESC}[B`:
      case `${ESC}OB`:
      case "j":
        scene(1);
        break;
      case "\r":
      case "\n":
        return { choice, outcome: "picked" };
      case ESC:
        return { choice, outcome: "cancelled" };
      case "\x03":
        return { choice, outcome: "interrupted" };
    }
  }
  return { choice, outcome: "open" };
};

/**
 * The frontmatter for a pick. A value the user did not change keeps what the
 * post has, so a plate the slug already gives stays out of the file.
 */
export const pickedFields = ({
  picked,
  shown,
  data,
}: {
  picked: PlateChoice;
  shown: PlateChoice;
  data: Pick<PostData, "plate" | "scene">;
}): Pick<PostData, "plate" | "scene"> => ({
  plate: picked.palette !== shown.palette ? picked.palette : data.plate,
  scene: picked.scene !== shown.scene ? picked.scene : data.scene,
});

/**
 * Shows the post's plate until the user picks a palette and a scene. Resolves
 * to `undefined` on esc. Ctrl-C exits the process.
 */
export const pickPlate = ({
  seed,
  palette,
  scene,
}: PlateChoice & { seed: number }): Promise<PlateChoice | undefined> => {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new UserError(
      "The plate picker needs a terminal. Set `plate:` and `scene:` in the frontmatter by hand; the names are in src/lib/palettes.ts and src/lib/scenes.ts.",
    );
  }

  let choice: PlateChoice = { palette, scene };
  let drawn = 0;
  const clear = () => (drawn > 0 ? `${ESC}[${drawn}A\r${ESC}[J` : "");
  const draw = () => {
    const lines = [
      ...halfBlockLines(renderPlate({ ...choice, seed }), {
        columns: stdout.columns,
        lines: stdout.rows - RESERVED_LINES,
      }),
      paletteLine(choice.palette),
      sceneLine(choice.scene),
      styleText("dim", HINT),
    ];
    stdout.write(clear() + lines.map((line) => `${line}\n`).join(""));
    drawn = lines.length;
  };
  const restore = () => {
    stdout.write(SHOW_CURSOR);
    stdin.setRawMode(false);
  };

  return new Promise((resolve, reject) => {
    const finish = (result: PlateChoice | undefined) => {
      stdin.off("data", onKey);
      stdout.off("resize", draw);
      process.off("exit", restore);
      for (const [signal, handler] of onSignals) process.off(signal, handler);
      stdout.write(clear());
      restore();
      stdin.pause();
      resolve(result);
    };
    const onSignals = SIGNALS.map(
      ([signal, code]) =>
        [
          signal,
          () => {
            finish(undefined);
            process.exit(code);
          },
        ] as const,
    );
    const onKey = (chunk: Buffer) => {
      try {
        const result = readKeys(chunk.toString(), choice);
        const moved = result.choice !== choice;
        choice = result.choice;
        switch (result.outcome) {
          case "picked":
            return finish(choice);
          case "cancelled":
            return finish(undefined);
          case "interrupted":
            finish(undefined);
            process.exit(130);
          case "open":
            if (moved) draw();
        }
      } catch (error) {
        finish(undefined);
        reject(error);
      }
    };

    process.on("exit", restore);
    for (const [signal, handler] of onSignals) process.on(signal, handler);
    stdout.write(HIDE_CURSOR);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onKey);
    stdout.on("resize", draw);
    draw();
  });
};
