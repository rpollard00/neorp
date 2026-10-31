import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePost } from "./post-file";
import { parseDay, preflight } from "./publish";
import { UserError } from "./user-error";

describe("parseDay", () => {
  test("reads a real date as the same instant the frontmatter parser gives", () => {
    const parsed = parsePost({
      path: "/posts/a.md",
      slug: "a",
      source: "---\ntitle: t\npubDate: 2026-10-05\n---\n",
    });
    expect(parsed.kind).toBe("valid");
    if (parsed.kind !== "valid") return;
    expect(parseDay("2026-10-05")).toEqual(parsed.post.data.pubDate);
  });

  test.each([
    "2026-02-29",
    "2026-13-01",
    "2026-04-31",
    "2026-4-01",
    "26-04-01",
    "2026-04-01T00:00",
    "tomorrow",
    "",
  ])("rejects %p", (text) => {
    expect(parseDay(text)).toBeUndefined();
  });

  test("accepts a leap day", () => {
    expect(parseDay("2028-02-29")).toBeDefined();
  });
});

describe("preflight", () => {
  const isolatedEnv = (jjConfig: string) => ({
    JJ_CONFIG: jjConfig,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    JJ_USER: "Test",
    JJ_EMAIL: "test@example.com",
  });
  const callerEnv = Object.keys(isolatedEnv("")).map((key) => ({
    key,
    value: process.env[key],
  }));

  let dir: string;
  let origin: string;
  let work: string;

  const run = ({ cmd, cwd }: { cmd: string[]; cwd: string }) => {
    const result = Bun.spawnSync(cmd, { cwd, env: process.env });
    if (result.exitCode !== 0) {
      throw new Error(`${cmd.join(" ")}: ${result.stderr.toString()}`);
    }
    return result.stdout.toString();
  };

  const pushFromClone = async ({
    name,
    file,
  }: Record<"name" | "file", string>) => {
    const clone = join(dir, name);
    run({ cmd: ["git", "clone", origin, clone], cwd: dir });
    await writeFile(join(clone, file), "from another machine\n");
    run({ cmd: ["git", "add", "."], cwd: clone });
    run({ cmd: ["git", "commit", "-m", file], cwd: clone });
    run({ cmd: ["git", "push", "origin", "HEAD:main"], cwd: clone });
  };

  const workingCopy = async () => ({
    files: (await readdir(work)).sort(),
    draft: await readFile(join(work, "draft.md"), "utf8"),
    commits: run({
      cmd: [
        "jj",
        "log",
        "-r",
        "@ | @-",
        "--no-graph",
        "-T",
        'commit_id ++ "\n"',
      ],
      cwd: work,
    }),
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bun-post-preflight-"));
    const config = join(dir, "jj.toml");
    await writeFile(config, "");
    Object.assign(process.env, isolatedEnv(config));

    origin = join(dir, "origin.git");
    run({ cmd: ["git", "init", "--bare", "-b", "main", origin], cwd: dir });
    await pushFromClone({ name: "seed", file: "first.md" });

    work = join(dir, "work");
    run({ cmd: ["jj", "git", "clone", origin, work], cwd: dir });
    await writeFile(join(work, "draft.md"), "unpublished\n");
  });

  afterEach(async () => {
    for (const { key, value } of callerEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("stops with the rebase message when origin main moved, and changes nothing", async () => {
    await pushFromClone({ name: "other", file: "composer.md" });
    const before = await workingCopy();

    const failure = (() => {
      try {
        preflight({ cwd: work });
      } catch (error) {
        return error;
      }
    })();

    expect(failure).toBeInstanceOf(UserError);
    expect(String(failure)).toContain("jj rebase -d main");
    expect(String(failure)).toContain("Nothing was written.");
    expect(await workingCopy()).toEqual(before);
    expect(before.files).not.toContain("composer.md");
  });

  test("passes when origin main has not moved", () => {
    expect(() => preflight({ cwd: work })).not.toThrow();
  });

  test("says nothing was written when the remote can't be reached", async () => {
    const before = await workingCopy();
    await rename(origin, `${origin}.gone`);

    expect(() => preflight({ cwd: work })).toThrow(
      /connection.*Nothing was written\./,
    );
    expect(await workingCopy()).toEqual(before);
  });

  test("passes with no remote", () => {
    const local = join(dir, "local");
    run({ cmd: ["jj", "git", "init", local], cwd: dir });
    expect(() => preflight({ cwd: local })).not.toThrow();
  });
});
