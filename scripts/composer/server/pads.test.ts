import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pad } from "../protocol";
import { makePad } from "./fixture";
import { createPads, type Pads } from "./pads";

let dataDir: string;
let pads: Pads;
const dir = () => join(dataDir, "pads");
const fileOf = (pad: Pad) => join(dir(), `${pad.id}.json`);

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "composer-pads-"));
  pads = createPads({ dataDir });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("put", () => {
  test("stores a pad that a new instance can list", async () => {
    const pad = makePad({ tags: ["a"] });
    expect(await pads.put(pad)).toEqual({ rev: 1, same: true });
    expect(await createPads({ dataDir }).list()).toEqual([pad]);
  });

  test("a higher rev replaces the pad", async () => {
    const pad = makePad();
    await pads.put(pad);
    const newer = { ...pad, rev: 2, text: "Newer" };
    expect(await pads.put(newer)).toEqual({ rev: 2, same: true });
    expect(await pads.list()).toEqual([newer]);
  });

  test("a lower rev changes nothing and answers the stored rev", async () => {
    const pad = makePad({ rev: 5 });
    await pads.put(pad);
    expect(await pads.put({ ...pad, rev: 3, text: "Old" })).toEqual({
      rev: 5,
      same: false,
    });
    expect(await pads.list()).toEqual([pad]);
  });

  test("a lower rev of equal text and tags is the same text", async () => {
    const pad = makePad({ rev: 5, tags: ["a"] });
    await pads.put(pad);
    expect(await pads.put({ ...pad, rev: 3 })).toEqual({ rev: 5, same: true });
  });

  test("different tags at an equal rev are not the same", async () => {
    const pad = makePad({ rev: 5, tags: ["a"] });
    await pads.put(pad);
    expect(await pads.put({ ...pad, tags: ["b"] })).toEqual({
      rev: 5,
      same: false,
    });
  });

  test("an equal rev rewrites nothing", async () => {
    const pad = makePad({ rev: 5 });
    await pads.put(pad);
    const before = await stat(fileOf(pad));
    await Bun.sleep(5);
    expect(await pads.put({ ...pad, text: "Replay" })).toEqual({
      rev: 5,
      same: false,
    });
    expect((await stat(fileOf(pad))).mtimeMs).toBe(before.mtimeMs);
    expect(await pads.list()).toEqual([pad]);
  });

  test("writes that arrive at the same time keep the highest rev", async () => {
    const pad = makePad();
    await Promise.all(
      [3, 9, 1, 7, 5].map((rev) => pads.put({ ...pad, rev, text: `r${rev}` })),
    );
    expect(await pads.list()).toEqual([{ ...pad, rev: 9, text: "r9" }]);
  });

  test("a crash mid-write leaves the old pad, and the next put works", async () => {
    const pad = makePad();
    await pads.put(pad);
    await writeFile(`${fileOf(pad)}.tmp`, '{"id":"half');
    expect(await createPads({ dataDir }).list()).toEqual([pad]);
    const newer = { ...pad, rev: 2 };
    await pads.put(newer);
    expect(await pads.list()).toEqual([newer]);
    expect(await readdir(dir())).toEqual([`${pad.id}.json`]);
  });

  test("a corrupt stored pad can be replaced", async () => {
    const pad = makePad({ rev: 2 });
    await pads.put(pad);
    await writeFile(fileOf(pad), "not json");
    const replay = { ...pad, rev: 1 };
    expect(await pads.put(replay)).toEqual({ rev: 1, same: true });
    expect(await pads.list()).toEqual([replay]);
  });
});

describe("list", () => {
  test("is empty before the first put", async () => {
    expect(await pads.list()).toEqual([]);
  });

  test("skips corrupt files and keeps the others", async () => {
    const pad = makePad();
    await pads.put(pad);
    await writeFile(join(dir(), "corrupt-pad.json"), "{");
    await writeFile(join(dir(), "invalid-pad.json"), '{"id":"invalid-pad"}');
    await writeFile(join(dir(), "bad name!.json"), "{}");
    expect(await pads.list()).toEqual([pad]);
  });

  test("skips a pad whose file name is not its id", async () => {
    const pad = makePad();
    await pads.put(pad);
    await writeFile(join(dir(), "other-name.json"), JSON.stringify(pad));
    expect(await pads.list()).toEqual([pad]);
  });
});
