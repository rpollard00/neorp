import { describe, expect, test } from "bun:test";
import { renderPlate } from "../../src/lib/plates";
import { halfBlockLines } from "./plate-picker";

const plate = renderPlate({ palette: "dusk", seed: 42 });

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
