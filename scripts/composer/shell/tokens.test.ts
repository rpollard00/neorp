import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");

const rootTokens = (source: string) => {
  const block = /:root\s*\{([^}]*)\}/.exec(source)?.[1];
  if (block === undefined) throw new Error("No :root block");
  return Object.fromEntries(
    block
      .split(";")
      .map((part) => part.trim().replace(/\s+/g, " "))
      .filter(Boolean)
      .map((part) => {
        const colon = part.indexOf(":");
        return [part.slice(0, colon), part.slice(colon + 1).trim()];
      }),
  );
};

test("the band mask is the approved 4-row pattern in vector runs", async () => {
  const shell = await readFile(join(import.meta.dir, "styles.css"), "utf8");
  const path = /--band-mask:.*? d='([^']+)'/.exec(shell)?.[1] ?? "";
  const rows = Array.from({ length: 5 }, () => [..."...."]);
  for (const [, x, y, width] of path.matchAll(/M(\d) (\d)h(\d)v1h-\d+z/g)) {
    for (let i = 0; i < Number(width); i++) {
      const row = rows[Number(y)];
      if (row) row[Number(x) + i] = "#";
    }
  }
  expect(rows.map((row) => row.join(""))).toEqual([
    "###.",
    ".#.#",
    "#.#.",
    "...#",
    "...#",
  ]);
});

test("the shell's :root tokens equal the site's", async () => {
  const site = await readFile(join(ROOT, "src/layouts/Layout.astro"), "utf8");
  const shell = await readFile(join(import.meta.dir, "styles.css"), "utf8");
  const tokens = rootTokens(site);
  expect(Object.keys(tokens).length).toBeGreaterThan(10);
  expect(rootTokens(shell)).toEqual(tokens);
});
