import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const SERVER_ENTRY = join(import.meta.dir, "server/main.ts");
const PLAIN_ENTRY = join(ROOT, "src/lib/post-plain.ts");

const STATIC_IMPORT =
  /\b(?:import|export)\b\s*(type\s+(?!from\s*["']|,))?[\w$\s,*{}]*?\bfrom\s*["']([^"']+)["']/g;
const SIDE_EFFECT_IMPORT = /\bimport\s*["']([^"']+)["']/g;
const CALL_IMPORT = /\b(?:import|require)\s*\(\s*([^)]*?)\s*\)/g;
const STRING_LITERAL = /^["'`]([^"'`$]+)["'`]/;

const CODE_FILE = /\.[cm]?[jt]sx?$/;
const SUFFIXES = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.js"];

/**
 * Every specifier `source` loads at runtime. It reads comments and strings as
 * code, so it can raise a false alarm but can't hide an import. A call with a
 * computed argument counts as that argument, which then fails as a bare import.
 */
const runtimeImports = (source: string) => [
  ...[...source.matchAll(STATIC_IMPORT)].flatMap(([, typeOnly, specifier]) =>
    typeOnly || !specifier ? [] : [specifier],
  ),
  ...[...source.matchAll(SIDE_EFFECT_IMPORT)].flatMap((match) =>
    match.slice(1),
  ),
  ...[...source.matchAll(CALL_IMPORT)].map(
    ([, argument = ""]) => STRING_LITERAL.exec(argument)?.[1] ?? argument,
  ),
];

const isRelative = (specifier: string) => /^\.\.?\//.test(specifier);

const isAllowed = (specifier: string) =>
  specifier === "bun" || specifier.startsWith("node:");

const resolveFile = (path: string) =>
  SUFFIXES.map((suffix) => path + suffix).find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );

/** Walks relative imports from `entry`. A relative import with no file fails too. */
const forbiddenImports = async (entry: string) => {
  const seen = new Set<string>();
  const forbidden: { file: string; specifier: string }[] = [];
  const visit = async (file: string) => {
    if (seen.has(file) || !CODE_FILE.test(file)) return;
    seen.add(file);
    for (const specifier of runtimeImports(await readFile(file, "utf8"))) {
      if (isAllowed(specifier)) continue;
      const target = isRelative(specifier)
        ? resolveFile(resolve(dirname(file), specifier))
        : undefined;
      if (target) await visit(target);
      else forbidden.push({ file, specifier });
    }
  };
  await visit(entry);
  return forbidden;
};

describe("the deploy key's process", () => {
  test.skipIf(!existsSync(SERVER_ENTRY))(
    "the server imports only relative files, node:*, and bun",
    async () => {
      expect(await forbiddenImports(SERVER_ENTRY)).toEqual([]);
    },
  );

  test("post-plain imports only relative files, node:*, and bun", async () => {
    expect(await forbiddenImports(PLAIN_ENTRY)).toEqual([]);
  });
});

describe("runtimeImports", () => {
  test.each([
    ['import a from "x";', ["x"]],
    ['import { a } from "x";', ["x"]],
    ['import {\n  a,\n  type B,\n} from "x";', ["x"]],
    ['import * as a from "x";', ["x"]],
    ['import a, { b } from "x";', ["x"]],
    ['import { type A } from "x";', ["x"]],
    ['import type, { a } from "x";', ["x"]],
    ['import type from "x";', ["x"]],
    ['export { a } from "x";', ["x"]],
    ['export * from "x";', ["x"]],
    ['import "x";', ["x"]],
    ['await import("x");', ["x"]],
    ["await import(`x`);", ["x"]],
    ['require("x");', ["x"]],
    ["await import(name);", ["name"]],
    ['const glob = "**/*.md";\nimport a from "x";', ["x"]],
    ['import type { A } from "x";', []],
    ['import type A from "x";', []],
    ['export type { A } from "x";', []],
    ["const dir = import.meta.dir;", []],
    ['export const from = "x";', []],
  ])("reads %p", (source, expected) => {
    expect(runtimeImports(source)).toEqual(expected);
  });
});

describe("forbiddenImports", () => {
  let dir: string;

  const write = (files: Record<string, string>) =>
    Promise.all(
      Object.entries(files).map(([name, source]) =>
        writeFile(join(dir, name), source),
      ),
    );

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "composer-imports-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("finds a bare import two relative files away, through a cycle", async () => {
    await write({
      "main.ts": 'import { a } from "./a";\nimport "node:fs";\nimport "bun";\n',
      "a.ts": 'import "./b.ts";\nimport "./main";\n',
      "b.ts": 'import type { C } from "types-only";\nimport "yaml";\n',
    });
    expect(await forbiddenImports(join(dir, "main.ts"))).toEqual([
      { file: join(dir, "b.ts"), specifier: "yaml" },
    ]);
  });

  test("passes a graph of relative files", async () => {
    await write({
      "main.ts": 'import page from "./page.html";\nexport * from "./a";\n',
      "page.html": '<script type="module" src="./bundle.js"></script>',
      "a.ts": 'import { readFile } from "node:fs/promises";\n',
    });
    expect(await forbiddenImports(join(dir, "main.ts"))).toEqual([]);
  });

  test("fails a relative import with no file", async () => {
    await write({ "main.ts": 'import "./gone";\n' });
    expect(await forbiddenImports(join(dir, "main.ts"))).toEqual([
      { file: join(dir, "main.ts"), specifier: "./gone" },
    ]);
  });
});
