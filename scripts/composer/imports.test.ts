import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

const possibleRuntimeImports = (source: string) => [
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

const SERVER_DIR = join(import.meta.dir, "server");
const PROCESS_OWNERS = new Set(["sandbox.ts", "git.ts", "run.ts"]);
/** The smoke test proves that these two are not in the image. */
const TEST_SUPPORT = new Set(["fixture.ts", "uid-check.ts"]);
/**
 * cert.ts: lego needs the Cloudflare token, so it cannot run in the sandbox.
 * pipeline.ts: `node --version` reads the host, and uid 0 must run `tar -x` to
 * write to the proof directory, which uid 1001 cannot enter.
 */
const OTHER_PROCESSES: Record<string, string[]> = {
  "cert.ts": ["...LEGO_LIMIT"],
  "pipeline.ts": ["node", "tar"],
};
const PROCESS_START =
  /(?:\bBun\.spawn(?:Sync)?\b|\brun\(\{\s*cmd:)(?:\(?\s*\[?\s*"?([.\w]+))?|\bBun\.\$|\bchild_process\b|\bfrom\s*"bun"|"git"/g;

const processStarts = (source: string) =>
  [...source.matchAll(PROCESS_START)].map(
    ([match, command]) => command ?? match,
  );

const isRelative = (specifier: string) => /^\.\.?\//.test(specifier);

const isAllowed = (specifier: string) =>
  specifier === "bun" || specifier.startsWith("node:");

const resolveFile = (path: string) =>
  SUFFIXES.map((suffix) => path + suffix).find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );

const forbiddenImports = async (entry: string) => {
  const seen = new Set<string>();
  const forbidden: { file: string; specifier: string }[] = [];
  const visit = async (file: string) => {
    if (seen.has(file) || !CODE_FILE.test(file)) return;
    seen.add(file);
    for (const specifier of possibleRuntimeImports(
      await readFile(file, "utf8"),
    )) {
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
  test("the server imports only relative files, node:*, and bun", async () => {
    expect(await forbiddenImports(SERVER_ENTRY)).toEqual([]);
  });

  test("post-plain imports only relative files, node:*, and bun", async () => {
    expect(await forbiddenImports(PLAIN_ENTRY)).toEqual([]);
  });
});

test("the image starts the server with bun --no-install", async () => {
  const dockerfile = await readFile(
    join(import.meta.dir, "Dockerfile"),
    "utf8",
  );
  const entrypoint = /^ENTRYPOINT (.+)$/m.exec(dockerfile)?.[1];
  expect(JSON.parse(entrypoint ?? "[]")).toEqual([
    "bun",
    "--no-install",
    "scripts/composer/server/main.ts",
  ]);
});

describe("the code that starts a process", () => {
  test("build trees and repo code go through sandbox.ts, and git through git.ts", async () => {
    const names = await readdir(SERVER_DIR);
    const scanned = names.filter(
      (name) =>
        name.endsWith(".ts") &&
        !name.endsWith(".test.ts") &&
        !PROCESS_OWNERS.has(name) &&
        !TEST_SUPPORT.has(name),
    );
    expect(scanned).toContain("pipeline.ts");
    const starts = await Promise.all(
      scanned.map(async (name) => [
        name,
        processStarts(await readFile(join(SERVER_DIR, name), "utf8")),
      ]),
    );
    expect(
      Object.fromEntries(starts.filter(([, found]) => found?.length)),
    ).toEqual(OTHER_PROCESSES);
  });

  test.each([
    ['Bun.spawn(["tar"]);', ["tar"]],
    ['Bun.spawn(\n  ["tar"],\n  {});', ["tar"]],
    ["Bun.spawn(argv);", ["argv"]],
    ['Bun.spawnSync(["tar"]);', ["tar"]],
    ["const start = Bun.spawn;", ["Bun.spawn"]],
    ["await Bun.$`tar`;", ["Bun.$"]],
    ['import { spawn } from "node:child_process";', ["child_process"]],
    ['import { $ } from "bun";', ['from "bun"']],
    ['await run({ cmd: ["node"], env });', ["node"]],
    ['await sandbox.run({ args: ["git", "log"] });', ['"git"']],
    ['await sandbox.run({ args: ["test"] });', []],
  ])("reads %p", (source, expected) => {
    expect(processStarts(source)).toEqual(expected);
  });
});

describe("possibleRuntimeImports", () => {
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
    expect(possibleRuntimeImports(source)).toEqual(expected);
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
