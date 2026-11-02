import { describe, expect, test } from "bun:test";
import { PALETTE_NAMES } from "../../src/lib/palettes";
import { renderPlate } from "../../src/lib/plates";
import { SCENE_NAMES } from "../../src/lib/scenes";
import {
  halfBlockLines,
  pickedFields,
  readKeys,
  type PlateChoice,
} from "./plate-picker";

const plate = renderPlate({ palette: "dusk", scene: "peaks", seed: 42 });

type Cell = { fg: string; bg: string | undefined };

const cellsOf = (line: string): Cell[] => {
  const cells: Cell[] = [];
  let fg = "";
  let bg: string | undefined;
  for (const [, code, char] of line.matchAll(/(\x1b\[[\d;]*m)|(▀)/g)) {
    if (code?.startsWith("\x1b[38;2;")) fg = code;
    else if (code?.startsWith("\x1b[48;2;")) bg = code;
    else if (code === "\x1b[49m") bg = undefined;
    else if (char) cells.push({ fg, bg });
  }
  return cells;
};

const rgb = (x: number, y: number) =>
  [...plate.pixels.subarray((y * 160 + x) * 3, (y * 160 + x) * 3 + 3)].join(
    ";",
  );

describe("halfBlockLines", () => {
  test("draws the full plate as 160 cells by 30 lines when it fits", () => {
    const lines = halfBlockLines(plate, { columns: 200, lines: 50 });
    expect(lines).toHaveLength(30);
    for (const line of lines) expect(cellsOf(line)).toHaveLength(160);
    const [first] = cellsOf(lines[1]);
    expect(first).toEqual({
      fg: `\x1b[38;2;${rgb(0, 2)}m`,
      bg: `\x1b[48;2;${rgb(0, 3)}m`,
    });
  });

  test("keeps every k-th pixel for the smallest k that fits", () => {
    const lines = halfBlockLines(plate, { columns: 100, lines: 50 });
    expect(lines).toHaveLength(15);
    for (const line of lines) expect(cellsOf(line)).toHaveLength(80);
    expect(cellsOf(lines[2])[3]).toEqual({
      fg: `\x1b[38;2;${rgb(6, 8)}m`,
      bg: `\x1b[48;2;${rgb(6, 10)}m`,
    });
  });

  test("leaves the bottom half of the last line empty for an odd row count", () => {
    const lines = halfBlockLines(plate, { columns: 23, lines: 50 });
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(cellsOf(line)).toHaveLength(23);
    expect(cellsOf(lines[4]).every((cell) => cell.bg === undefined)).toBe(true);
  });

  test("shrinks to fit the lines it may use as well as the columns", () => {
    const lines = halfBlockLines(plate, { columns: 200, lines: 20 });
    expect(lines).toHaveLength(15);
    for (const line of lines) expect(cellsOf(line)).toHaveLength(80);
    expect(halfBlockLines(plate, { columns: 200, lines: 30 })).toHaveLength(30);
  });

  test("ends every line with a reset", () => {
    for (const line of halfBlockLines(plate, { columns: 80, lines: 50 })) {
      expect(line.endsWith("\x1b[0m")).toBe(true);
    }
  });
});

describe("readKeys", () => {
  const start: PlateChoice = { palette: "dusk", scene: "sea" };
  const last = SCENE_NAMES[SCENE_NAMES.length - 1];
  const moves: [string, Partial<PlateChoice>][] = [
    ["\x1b[C", { palette: "dawn" }],
    ["\x1bOC", { palette: "dawn" }],
    ["l", { palette: "dawn" }],
    ["\x1b[D", { palette: PALETTE_NAMES[PALETTE_NAMES.length - 1] }],
    ["h", { palette: PALETTE_NAMES[PALETTE_NAMES.length - 1] }],
    ["\x1b[B", { scene: SCENE_NAMES[1] }],
    ["\x1bOB", { scene: SCENE_NAMES[1] }],
    ["j", { scene: SCENE_NAMES[1] }],
    ["\x1b[A", { scene: last }],
    ["\x1bOA", { scene: last }],
    ["k", { scene: last }],
  ];

  test.each(moves)("moves on %j and wraps", (keys, change) => {
    expect(readKeys(keys, start)).toEqual({
      choice: { ...start, ...change },
      outcome: "open",
    });
  });

  test("takes a burst of keys in one chunk", () => {
    expect(readKeys("\x1b[C\x1b[Cjj\x1b[A", start)).toEqual({
      choice: { palette: "day", scene: SCENE_NAMES[1] },
      outcome: "open",
    });
  });

  test("stops at enter, and later keys do nothing", () => {
    expect(readKeys("j\rjj", start)).toEqual({
      choice: { ...start, scene: SCENE_NAMES[1] },
      outcome: "picked",
    });
  });

  test("cancels on esc and interrupts on ctrl-c", () => {
    expect(readKeys("\x1b", start).outcome).toBe("cancelled");
    expect(readKeys("l\x03", start).outcome).toBe("interrupted");
  });

  test("keeps the same choice when no key moves it", () => {
    expect(readKeys("x", start).choice).toBe(start);
  });
});

describe("pickedFields", () => {
  const shown = { palette: "dawn", scene: "peaks" } as const;

  test("leaves out what the slug already gives", () => {
    expect(pickedFields({ picked: shown, shown, data: {} })).toEqual({
      plate: undefined,
      scene: undefined,
    });
  });

  test("keeps what the post has set when the pick does not change it", () => {
    const data = { plate: "dawn", scene: "peaks" } as const;
    expect(pickedFields({ picked: shown, shown, data })).toEqual(data);
  });

  test("writes a value only when the pick changes it", () => {
    const picked = { palette: "dawn", scene: "gate" } as const;
    expect(pickedFields({ picked, shown, data: {} })).toEqual({
      plate: undefined,
      scene: "gate",
    });
  });
});
