import { styleText } from "node:util";
import { PALETTE_NAMES, type PaletteName } from "../../src/lib/palettes";
import { renderPlate } from "../../src/lib/plates";
import { UserError } from "./user-error";

type Plate = ReturnType<typeof renderPlate>;

const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
/** A burst of typing or a held key arrives as one chunk of several keys. */
const KEYS = /\x1b\[[\d;]*[A-Za-z~]|\x1bO[A-Za-z]|[\s\S]/g;
const HINT = "←/→ or h/l to change · enter to pick · esc to cancel";
/** The palette line, the hint, and the shell prompt or next question. */
const RESERVED_LINES = 3;
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

/**
 * Shows the post's plate in each palette until the user picks one. Resolves
 * to `undefined` on esc. Ctrl-C exits the process.
 */
export const pickPlate = ({
  seed,
  palette,
}: {
  seed: number;
  palette: PaletteName;
}): Promise<PaletteName | undefined> => {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new UserError(
      "The plate picker needs a terminal. Set `plate:` in the frontmatter by hand; the names are in src/lib/palettes.ts.",
    );
  }

  let index = PALETTE_NAMES.indexOf(palette);
  let drawn = 0;
  const clear = () => (drawn > 0 ? `${ESC}[${drawn}A\r${ESC}[J` : "");
  const draw = () => {
    const current = PALETTE_NAMES[index];
    const lines = [
      ...halfBlockLines(renderPlate({ palette: current, seed }), {
        columns: stdout.columns,
        lines: stdout.rows - RESERVED_LINES,
      }),
      paletteLine(current),
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
    const finish = (result: PaletteName | undefined) => {
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
    const move = (by: number) => {
      index = (index + by + PALETTE_NAMES.length) % PALETTE_NAMES.length;
    };
    const onKey = (chunk: Buffer) => {
      try {
        const start = index;
        for (const [key] of chunk.toString().matchAll(KEYS)) {
          switch (key) {
            case `${ESC}[D`:
            case `${ESC}OD`:
            case "h":
              move(-1);
              break;
            case `${ESC}[C`:
            case `${ESC}OC`:
            case "l":
              move(1);
              break;
            case "\r":
            case "\n":
              return finish(PALETTE_NAMES[index]);
            case ESC:
              return finish(undefined);
            case "\x03":
              finish(undefined);
              process.exit(130);
          }
        }
        if (index !== start) draw();
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
