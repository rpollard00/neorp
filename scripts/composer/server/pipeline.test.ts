import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createPads } from "./pads";
import { createPipeline, type FetchSite, type Pipeline } from "./pipeline";
import { createFixture, makePad, type Fixture } from "./fixture";
import type { Proved, Sha, Slug } from "../protocol";

setDefaultTimeout(30_000);

let fixture: Fixture;
let pipeline: Pipeline;
const pipelines: Pipeline[] = [];

const newPipeline = (
  args?: Parameters<typeof createPipeline>[1],
  config = fixture.config,
) => {
  const created = createPipeline(config, args);
  pipelines.push(created);
  return created;
};

const notFound: FetchSite = async () => new Response("", { status: 404 });

const proved = async (run: Promise<Proved>) => {
  const answer = await run;
  if (answer.kind !== "proved") {
    throw new Error(`expected a proof, got ${JSON.stringify(answer)}`);
  }
  return answer;
};

const slotSha = async () =>
  (await readlink(join(fixture.config.dataDir, "proof", "current"))) as Sha;

const proofFile = (path: string) =>
  join(fixture.config.dataDir, "proof", "current", path);

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const isEmptyDir = async (path: string) =>
  (await readdir(path).catch(() => [])).length === 0;

beforeEach(async () => {
  fixture = await createFixture();
  pipeline = newPipeline({ fetchSite: notFound });
});

afterEach(async () => {
  await Promise.all(pipelines.splice(0).map((created) => created.close()));
  await fixture.remove();
});

describe("prove", () => {
  test("builds the exact commit, as its parent plus one file", async () => {
    const parent = await fixture.remoteMain();
    const { sha, url } = await proved(
      pipeline.prove({
        pad: makePad({ text: "My post\n\nHello.", tags: ["a"] }),
      }),
    );
    expect(url).toBe("http://proof.test:8444/posts/my-post/");

    expect(
      await fixture.cloneGit("rev-list", "--parents", "-n", "1", sha),
    ).toBe(`${sha} ${parent}`);
    expect(
      await fixture.cloneGit(
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-r",
        sha,
      ),
    ).toBe("A\tsrc/content/posts/my-post.md");
    expect(
      await fixture.cloneGit("log", "-1", "--format=%s|%an|%ae|%cn", sha),
    ).toBe("post: My post|Composer|composer@example.com|Composer");

    const source = await fixture.cloneGit(
      "show",
      `${sha}:src/content/posts/my-post.md`,
    );
    expect(source).toContain('title: "My post"');
    expect(source).toContain('tags: ["a"]');
    expect(
      await readFile(proofFile("posts/my-post/index.html"), "utf8"),
    ).toContain("Hello.");
    expect(await slotSha()).toBe(sha);
  });

  test("a build tree has no git directory, and goes away after the build", async () => {
    await proved(pipeline.prove({ pad: makePad() }));
    expect(await readFile(proofFile("has-git.txt"), "utf8")).toBe("false");
    expect(await isEmptyDir(join(fixture.config.dataDir, "builds"))).toBe(true);
  });

  test("the same intent on the same main returns the slot with no new build", async () => {
    const pad = makePad();
    const first = await proved(pipeline.prove({ pad }));
    const second = await proved(pipeline.prove({ pad: { ...pad, rev: 2 } }));
    expect(second.sha).toBe(first.sha);
    expect(await fixture.buildCount()).toBe(1);
  });

  test("a new pipeline on the same data reuses the slot", async () => {
    const pad = makePad();
    const first = await proved(pipeline.prove({ pad }));
    const restarted = newPipeline({ fetchSite: notFound });
    expect((await proved(restarted.prove({ pad }))).sha).toBe(first.sha);
    expect(await fixture.buildCount()).toBe(1);
  });

  test("concurrent calls with the same intent join one build", async () => {
    const pad = makePad({ text: "Joined\n\nBUILD_FAILS" });
    const answers = await Promise.all([
      pipeline.prove({ pad }),
      pipeline.prove({ pad }),
      pipeline.prove({ pad }),
    ]);
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(
      1,
    );
    expect(answers[0]?.kind).toBe("refused");
    expect(await fixture.buildCount()).toBe(1);
  });

  test("concurrent calls with different intents run one at a time", async () => {
    const answers = await Promise.all([
      pipeline.prove({ pad: makePad({ text: "One" }) }),
      pipeline.prove({ pad: makePad({ text: "Two" }) }),
    ]);
    expect(answers.map((answer) => answer.kind)).toEqual(["proved", "proved"]);
    expect(await fixture.buildCount()).toBe(2);
    const [, last] = answers;
    expect(last?.kind === "proved" && last.sha).toBe(await slotSha());
  });

  test("builds again when main moved", async () => {
    const pad = makePad();
    const first = await proved(pipeline.prove({ pad }));
    const laptop = await fixture.pushFromLaptop({ "note.txt": "x" });
    const second = await proved(pipeline.prove({ pad }));
    expect(second.sha).not.toBe(first.sha);
    expect(await fixture.cloneGit("rev-parse", `${second.sha}^`)).toBe(laptop);
  });

  test("builds again when the tags change", async () => {
    const first = await proved(pipeline.prove({ pad: makePad() }));
    const second = await proved(
      pipeline.prove({ pad: makePad({ tags: ["new"] }) }),
    );
    expect(second.sha).not.toBe(first.sha);
    expect(await fixture.buildCount()).toBe(2);
  });

  test("a blank pad is refused and saved", async () => {
    const pad = makePad({ text: " \n\n" });
    expect(await pipeline.prove({ pad })).toEqual({
      kind: "refused",
      why: { kind: "blank" },
    });
    expect(await createPads(fixture.config).list()).toEqual([pad]);
    expect(await fixture.buildCount()).toBe(0);
  });

  test("an unreachable origin is refused, and the pad stays", async () => {
    await rename(fixture.remote, `${fixture.remote}.gone`);
    const pad = makePad();
    expect(await pipeline.prove({ pad })).toEqual({
      kind: "refused",
      why: { kind: "origin-unreachable" },
    });
    expect(await createPads(fixture.config).list()).toEqual([pad]);
  });

  test("a different node on main is refused before a build", async () => {
    await fixture.pushFromLaptop({ ".node-version": "1.2.3\n" });
    expect(await pipeline.prove({ pad: makePad() })).toEqual({
      kind: "refused",
      why: { kind: "toolchain", need: "node 1.2.3" },
    });
    expect(await fixture.buildCount()).toBe(0);
  });

  test("a different bun on main is refused before a build", async () => {
    const manifest = await fixture.remoteGit("show", "main:package.json");
    await fixture.pushFromLaptop({
      "package.json": JSON.stringify({
        ...JSON.parse(manifest),
        packageManager: "bun@0.0.1+sha512.abc",
      }),
    });
    expect(await pipeline.prove({ pad: makePad() })).toEqual({
      kind: "refused",
      why: { kind: "toolchain", need: "bun 0.0.1" },
    });
    expect(await fixture.buildCount()).toBe(0);
  });

  test("a failed build keeps the old slot and the pad", async () => {
    const good = await proved(pipeline.prove({ pad: makePad() }));
    const pad = makePad({ text: "Bad\n\nBUILD_FAILS" });
    const answer = await pipeline.prove({ pad });
    expect(answer.kind === "refused" && answer.why.kind).toBe("build-failed");
    expect(JSON.stringify(answer)).toContain("the build broke on purpose");
    expect(JSON.stringify(answer)).not.toContain("\\u001b");
    expect(await slotSha()).toBe(good.sha as Sha);
    expect(await exists(proofFile("posts/a-title/index.html"))).toBe(true);
    expect(
      (await createPads(fixture.config).list()).map(({ id }) => id),
    ).toContain(pad.id);
    expect(await isEmptyDir(join(fixture.config.dataDir, "builds"))).toBe(true);
  });

  test("a build with no page is refused, and keeps the slot", async () => {
    const good = await proved(pipeline.prove({ pad: makePad() }));
    expect(
      await pipeline.prove({
        pad: makePad({ text: "Gone\n\nBUILD_SKIPS_PAGE" }),
      }),
    ).toEqual({ kind: "refused", why: { kind: "no-page" } });
    expect(await slotSha()).toBe(good.sha as Sha);
  });

  test("the timeout stops a hung build, and the queue goes on", async () => {
    const hurried = newPipeline(
      { fetchSite: notFound },
      { ...fixture.config, buildTimeoutSeconds: 1 },
    );
    const good = await proved(pipeline.prove({ pad: makePad() }));
    const started = Date.now();
    const answer = await hurried.prove({
      pad: makePad({ text: "Stuck\n\nBUILD_HANGS" }),
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(answer.kind === "refused" && answer.why.kind).toBe("build-failed");
    expect(
      answer.kind === "refused" &&
        answer.why.kind === "build-failed" &&
        answer.why.tail.split("\n").at(-1),
    ).toContain("more than 1 seconds");
    expect(await slotSha()).toBe(good.sha as Sha);
    await proved(pipeline.prove({ pad: makePad({ text: "After" }) }));
  });

  test("a daemon that holds the build's pipes cannot hold the queue", async () => {
    const started = Date.now();
    await proved(
      pipeline.prove({
        pad: makePad({ text: "Daemon\n\nBUILD_LEAVES_DAEMON" }),
      }),
    );
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("installs once for each bun.lock", async () => {
    await proved(pipeline.prove({ pad: makePad({ text: "One" }) }));
    await proved(pipeline.prove({ pad: makePad({ text: "Two" }) }));
    expect(await fixture.installCount()).toBe(1);
    expect(await fixture.buildCount()).toBe(2);
  });

  const hashDirs = async () =>
    (await readdir(join(fixture.config.dataDir, "deps")))
      .filter((name) => /^[0-9a-f]{64}$/.test(name))
      .sort();

  const pushNewLock = async (lock: string) => {
    await fixture.pushFromLaptop({ "bun.lock": lock });
    return new Bun.CryptoHasher("sha256").update(lock).digest("hex");
  };

  test("a new bun.lock keeps its install and the newest one before it", async () => {
    const lock = await fixture.remoteGit("show", "main:bun.lock");
    await proved(pipeline.prove({ pad: makePad({ text: "One" }) }));
    const [oldest] = await hashDirs();
    const previous = await pushNewLock(`${lock}\n\n`);
    await proved(pipeline.prove({ pad: makePad({ text: "Two" }) }));
    const newest = await pushNewLock(`${lock}\n\n\n`);
    await proved(pipeline.prove({ pad: makePad({ text: "Three" }) }));
    expect(await hashDirs()).toEqual([previous, newest].sort());
    expect(oldest).toBeDefined();
    const deps = join(fixture.config.dataDir, "deps");
    expect(await exists(join(deps, "cache"))).toBe(true);
    expect(await exists(join(deps, "home"))).toBe(true);
  });

  test("a bun.lock that has an install prunes nothing", async () => {
    const lock = await fixture.remoteGit("show", "main:bun.lock");
    await proved(pipeline.prove({ pad: makePad({ text: "One" }) }));
    await pushNewLock(`${lock}\n\n`);
    await proved(pipeline.prove({ pad: makePad({ text: "Two" }) }));
    await proved(pipeline.prove({ pad: makePad({ text: "Three" }) }));
    expect(await hashDirs()).toHaveLength(2);
    expect(await fixture.installCount()).toBe(2);
  });

  test("the build sees no secret in its environment", async () => {
    process.env.COMPOSER_TEST_SECRET = "must-not-leak";
    try {
      const keyed = newPipeline(
        { fetchSite: notFound },
        { ...fixture.config, sshKeyFile: fixture.secretFile },
      );
      await proved(keyed.prove({ pad: makePad() }));
    } finally {
      delete process.env.COMPOSER_TEST_SECRET;
    }
    const env = JSON.parse(
      await readFile(proofFile("env.json"), "utf8"),
    ) as Record<string, string>;
    expect(env).toMatchObject({ CI: "1", ASTRO_TELEMETRY_DISABLED: "1" });
    const text = JSON.stringify(env);
    expect(text).not.toContain("must-not-leak");
    expect(text).not.toContain(fixture.secretFile);
    expect(
      Object.keys(env).filter((key) => /^(GIT_|COMPOSER_)/.test(key)),
    ).toEqual([]);
    expect(env.BUN_INSTALL_CACHE_DIR).toBe(
      join(fixture.config.dataDir, "deps", "cache"),
    );
  });

  test("the proof keeps no symlink, no fifo, and no build copy of proof.json", async () => {
    const { sha } = await proved(
      pipeline.prove({
        pad: makePad({ text: `Links\n\nLINK_TO:${fixture.secretFile}` }),
      }),
    );
    const page = proofFile("posts/links");
    expect(await exists(join(page, "index.html"))).toBe(true);
    expect(await readdir(page)).toEqual(["index.html"]);
    const proof = JSON.parse(
      await readFile(proofFile("proof.json"), "utf8"),
    ) as {
      sha: string;
    };
    expect(proof.sha as string).toBe(sha);
  });

  test("converges after a crash left a partial proof and a build tree", async () => {
    const data = fixture.config.dataDir;
    const good = await proved(pipeline.prove({ pad: makePad() }));
    await mkdir(join(data, "builds", "left-behind"), { recursive: true });
    await writeFile(join(data, "builds", "left-behind", "x"), "x");
    await mkdir(join(data, "proof", `${"a".repeat(40)}.tmp`));
    await mkdir(join(data, "proof", "b".repeat(40)));
    await writeFile(join(data, "proof", "current.tmp"), "x");
    const restarted = newPipeline({ fetchSite: notFound });
    const next = await proved(
      restarted.prove({ pad: makePad({ text: "Next" }) }),
    );
    expect((await readdir(join(data, "proof"))).sort()).toEqual(
      [next.sha, "current"].sort(),
    );
    expect(await isEmptyDir(join(data, "builds"))).toBe(true);
    expect(next.sha).not.toBe(good.sha);
  });

  test("a taken slug gets a number, also for a folder post", async () => {
    await fixture.pushFromLaptop({
      "src/content/posts/my-post/index.md": "---\ntitle: X\n---\n",
    });
    expect(
      (await proved(pipeline.prove({ pad: makePad({ text: "My post" }) }))).url,
    ).toEndWith("/posts/my-post-2/");
  });
});

describe("revise", () => {
  const SLUG = "hello-world" as Slug;

  const revisePad = async ({
    text = "New title\n\nNew body.",
    tags = ["fresh"],
    slug = SLUG,
  }: { text?: string; tags?: string[]; slug?: Slug } = {}) =>
    makePad({
      text,
      tags,
      target: { kind: "revise", slug, from: await fixture.remoteMain() },
    });

  test("keeps the slug, the date, and other frontmatter", async () => {
    const { sha, url } = await proved(
      pipeline.prove({ pad: await revisePad() }),
    );
    expect(url).toEndWith("/posts/hello-world/");
    expect(
      await fixture.cloneGit("show", `${sha}:src/content/posts/hello-world.md`),
    ).toBe(
      '---\ntitle: "New title"\ndescription: The first post.\npubDate: 2026-01-02\ntags: ["fresh"]\nplate: dawn\n---\n\nNew body.',
    );
    expect(await fixture.cloneGit("log", "-1", "--format=%s", sha)).toBe(
      "post: revise New title",
    );
    expect(
      await fixture.cloneGit(
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-r",
        sha,
      ),
    ).toBe("M\tsrc/content/posts/hello-world.md");
  });

  test("works when other files moved on main", async () => {
    const pad = await revisePad();
    await fixture.pushFromLaptop({ "note.txt": "x" });
    await proved(pipeline.prove({ pad }));
  });

  test("refuses when the post changed on main after `from`", async () => {
    const pad = await revisePad();
    await fixture.pushFromLaptop({
      "src/content/posts/hello-world.md":
        "---\ntitle: Changed\n---\n\nLaptop edit.\n",
    });
    expect(await pipeline.prove({ pad })).toEqual({
      kind: "refused",
      why: { kind: "revise-conflict" },
    });
    expect(await fixture.buildCount()).toBe(0);
  });

  test("refuses a file that it cannot safely edit", async () => {
    await fixture.pushFromLaptop({
      "src/content/posts/block.md": "---\ntitle: |\n  Block\n---\n\nBody\n",
    });
    expect(
      await pipeline.prove({ pad: await revisePad({ slug: "block" as Slug }) }),
    ).toEqual({ kind: "refused", why: { kind: "not-revisable" } });
  });

  test("refuses an mdx post", async () => {
    await fixture.pushFromLaptop({
      "src/content/posts/rich.mdx": "---\ntitle: Rich\n---\n\nBody\n",
    });
    expect(
      await pipeline.prove({ pad: await revisePad({ slug: "rich" as Slug }) }),
    ).toEqual({ kind: "refused", why: { kind: "not-revisable" } });
  });

  test("refuses a slug with no post", async () => {
    expect(
      await pipeline.prove({
        pad: await revisePad({ slug: "absent" as Slug }),
      }),
    ).toEqual({ kind: "refused", why: { kind: "not-revisable" } });
  });

  test("a revision that changes nothing has no commit", async () => {
    const pad = await revisePad();
    const { sha } = await proved(pipeline.prove({ pad }));
    await fixture.cloneGit("push", "origin", `${sha}:refs/heads/main`);
    const again = await revisePad();
    expect(await pipeline.prove({ pad: again })).toEqual({
      kind: "refused",
      why: { kind: "unchanged" },
    });
  });
});

describe("ship", () => {
  test("pushes the proven commit to main", async () => {
    const { sha } = await proved(pipeline.prove({ pad: makePad() }));
    expect(await pipeline.ship({ sha: sha })).toEqual({
      kind: "pushed",
      url: "https://site.test/posts/a-title/",
      slug: "a-title" as Slug,
    });
    expect(await fixture.remoteMain()).toBe(sha);
  });

  test("refuses a commit that is not the proof", async () => {
    await proved(pipeline.prove({ pad: makePad() }));
    const before = await fixture.remoteMain();
    expect(await pipeline.ship({ sha: "c".repeat(40) as Sha })).toEqual({
      kind: "not-proven",
    });
    expect(await fixture.remoteMain()).toBe(before);
  });

  test("refuses with no proof at all", async () => {
    expect(await pipeline.ship({ sha: "c".repeat(40) as Sha })).toEqual({
      kind: "not-proven",
    });
  });

  test("a replaced proof cannot ship", async () => {
    const old = await proved(pipeline.prove({ pad: makePad({ text: "Old" }) }));
    await proved(pipeline.prove({ pad: makePad({ text: "New" }) }));
    const before = await fixture.remoteMain();
    expect(await pipeline.ship({ sha: old.sha })).toEqual({
      kind: "not-proven",
    });
    expect(await fixture.remoteMain()).toBe(before);
  });

  test("a stale push leaves main alone, and a second proof ships", async () => {
    const pad = makePad();
    const { sha } = await proved(pipeline.prove({ pad }));
    const laptop = await fixture.pushFromLaptop({ "note.txt": "x" });
    expect(await pipeline.ship({ sha })).toEqual({ kind: "stale" });
    expect(await fixture.remoteMain()).toBe(laptop);

    const second = await proved(pipeline.prove({ pad }));
    expect((await pipeline.ship({ sha: second.sha })).kind).toBe("pushed");
    expect(await fixture.remoteGit("rev-parse", "main^")).toBe(laptop);
  });

  test("a push that loses the race after the fetch is stale", async () => {
    const { sha } = await proved(pipeline.prove({ pad: makePad() }));
    const hook = join(fixture.remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    const before = await fixture.remoteMain();
    expect(await pipeline.ship({ sha })).toEqual({ kind: "stale" });
    expect(await fixture.remoteMain()).toBe(before);
  });

  test("a double ship is safe, one after the other", async () => {
    const { sha } = await proved(pipeline.prove({ pad: makePad() }));
    const first = await pipeline.ship({ sha });
    const second = await pipeline.ship({ sha });
    expect(first.kind).toBe("pushed");
    expect(second).toEqual(first);
    expect(await fixture.remoteGit("rev-list", "--count", "main")).toBe("2");
  });

  test("a double ship is safe, at the same time", async () => {
    const { sha } = await proved(pipeline.prove({ pad: makePad() }));
    const answers = await Promise.all([
      pipeline.ship({ sha }),
      pipeline.ship({ sha }),
    ]);
    expect(answers.map(({ kind }) => kind)).toEqual(["pushed", "pushed"]);
    expect(await fixture.remoteMain()).toBe(sha);
  });

  test("a restart between the push and the answer gives the right state", async () => {
    const { sha } = await proved(pipeline.prove({ pad: makePad() }));
    await fixture.cloneGit(
      "push",
      "--quiet",
      "origin",
      `${sha}:refs/heads/main`,
    );
    const restarted = newPipeline({ fetchSite: notFound });
    expect(await restarted.ship({ sha })).toEqual({
      kind: "pushed",
      url: "https://site.test/posts/a-title/",
      slug: "a-title" as Slug,
    });
    expect(await fixture.remoteGit("rev-list", "--count", "main")).toBe("2");
  });

  test("an unreachable origin is reported, and a retry works", async () => {
    const { sha } = await proved(pipeline.prove({ pad: makePad() }));
    await rename(fixture.remote, `${fixture.remote}.gone`);
    expect(await pipeline.ship({ sha })).toEqual({
      kind: "origin-unreachable",
    });
    await rename(`${fixture.remote}.gone`, fixture.remote);
    expect((await pipeline.ship({ sha })).kind).toBe("pushed");
  });

  test("a commit of main that is not a post is not proven", async () => {
    expect(await pipeline.ship({ sha: await fixture.remoteMain() })).toEqual({
      kind: "not-proven",
    });
  });

  describe("live check", () => {
    const site =
      (status: number, body = ""): FetchSite =>
      async () =>
        new Response(body, { status });

    test("a new post is live on a 200", async () => {
      const live = newPipeline({ fetchSite: site(200) });
      const { sha } = await proved(live.prove({ pad: makePad() }));
      expect((await live.ship({ sha })).kind).toBe("pushed");
      expect(await live.ship({ sha })).toEqual({
        kind: "live",
        url: "https://site.test/posts/a-title/",
        slug: "a-title" as Slug,
      });
    });

    test("a failed fetch is pushed, never an error", async () => {
      const failing = newPipeline({
        fetchSite: async () => {
          throw new Error("no network");
        },
      });
      const { sha } = await proved(failing.prove({ pad: makePad() }));
      await failing.ship({ sha });
      expect((await failing.ship({ sha })).kind).toBe("pushed");
    });

    test("a new post is still live after the slot moved on", async () => {
      const live = newPipeline({ fetchSite: site(200) });
      const { sha } = await proved(live.prove({ pad: makePad() }));
      await live.ship({ sha });
      await proved(live.prove({ pad: makePad({ text: "Another" }) }));
      expect(await live.ship({ sha })).toEqual({
        kind: "live",
        url: "https://site.test/posts/a-title/",
        slug: "a-title" as Slug,
      });
    });

    test("a revision is live only when the public page matches the proof", async () => {
      let html =
        '<p class="meta"></p><h1>Hello World</h1><div class="prose"><div>The first body.</div></div>';
      const live = newPipeline({
        fetchSite: async () => new Response(html, { status: 200 }),
      });
      const { sha } = await proved(
        live.prove({
          pad: makePad({
            text: "Fixed\n\nFixed body.",
            target: {
              kind: "revise",
              slug: "hello-world" as Slug,
              from: await fixture.remoteMain(),
            },
          }),
        }),
      );
      expect((await live.ship({ sha })).kind).toBe("pushed");
      expect((await live.ship({ sha })).kind).toBe("pushed");
      html = await readFile(proofFile("posts/hello-world/index.html"), "utf8");
      html = html.replace("<html>", '<html data-public="yes">');
      expect((await live.ship({ sha })).kind).toBe("live");
    });

    const fixOf = async (text: string, tags: string[] = []) =>
      makePad({
        text,
        tags,
        target: {
          kind: "revise",
          slug: "hello-world" as Slug,
          from: await fixture.remoteMain(),
        },
      });

    test.each([
      [
        "title",
        "Hello World\n\nThe first body.",
        "A new title\n\nThe first body.",
        [],
      ],
      [
        "tags",
        "Hello World\n\nThe first body.",
        "Hello World\n\nThe first body.",
        ["fresh"],
      ],
    ] as const)(
      "a fix of only the %s is not live while the site serves the old page",
      async (_name, before, after, tags) => {
        const start = await proved(
          pipeline.prove({ pad: await fixOf(before, ["start"]) }),
        );
        await pipeline.ship({ sha: start.sha });
        const old = await readFile(
          proofFile("posts/hello-world/index.html"),
          "utf8",
        );
        const live = newPipeline({
          fetchSite: async () => new Response(old, { status: 200 }),
        });
        const { sha } = await proved(
          live.prove({ pad: await fixOf(after, [...tags]) }),
        );
        await live.ship({ sha });
        expect((await live.ship({ sha })).kind).toBe("pushed");
      },
    );

    test("the links after the post are not part of the check", async () => {
      let html = "";
      const live = newPipeline({
        fetchSite: async () => new Response(html, { status: 200 }),
      });
      const { sha } = await proved(
        live.prove({ pad: await fixOf("Fixed\n\nFixed body.") }),
      );
      await live.ship({ sha });
      html = (
        await readFile(proofFile("posts/hello-world/index.html"), "utf8")
      ).replace("<nav>Older</nav>", "<nav>A newer post</nav>");
      expect((await live.ship({ sha })).kind).toBe("live");
    });

    test("the slug of an old revision comes from the commit", async () => {
      const live = newPipeline({ fetchSite: site(200) });
      const { sha } = await proved(
        live.prove({
          pad: makePad({
            text: "Fixed",
            target: {
              kind: "revise",
              slug: "hello-world" as Slug,
              from: await fixture.remoteMain(),
            },
          }),
        }),
      );
      await live.ship({ sha });
      await proved(live.prove({ pad: makePad({ text: "Another" }) }));
      expect(await live.ship({ sha })).toEqual({
        kind: "pushed",
        url: "https://site.test/posts/hello-world/",
        slug: "hello-world" as Slug,
      });
    });
  });
});

describe("tags", () => {
  test("reads the sorted unique tags of main, in both YAML forms", async () => {
    await fixture.pushFromLaptop({
      "src/content/posts/block.md":
        "---\ntitle: B\ntags:\n  - zebra\n  - hello_there\n---\n",
      "src/content/posts/flow.md": '---\ntitle: F\ntags: ["apple pie"]\n---\n',
      "src/content/posts/none.md": "---\ntitle: N\n---\n",
    });
    expect(await pipeline.tags()).toEqual([
      "apple pie",
      "hello_there",
      "zebra",
    ]);
  });

  test("fetches at most once a minute", async () => {
    expect(await pipeline.tags()).toEqual(["hello_there"]);
    await fixture.pushFromLaptop({
      "src/content/posts/new.md": "---\ntitle: N\ntags: [fresh]\n---\n",
    });
    expect(await pipeline.tags()).toEqual(["hello_there"]);
    await proved(pipeline.prove({ pad: makePad() }));
    expect(await pipeline.tags()).toEqual(["fresh", "hello_there"]);
  });

  test("answers from the last fetch when origin is gone", async () => {
    await pipeline.tags();
    await rename(fixture.remote, `${fixture.remote}.gone`);
    expect(await newPipeline({ fetchSite: notFound }).tags()).toEqual([
      "hello_there",
    ]);
  });
});

test("the deploy key reaches ssh with the strict options", async () => {
  const bin = join(fixture.dir, "bin");
  const record = join(fixture.dir, "ssh-args");
  await mkdir(bin);
  await writeFile(
    join(bin, "ssh"),
    `#!/bin/sh\necho "$@" > ${record}\nexit 1\n`,
  );
  await chmod(join(bin, "ssh"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const keyed = newPipeline(
      { fetchSite: notFound },
      {
        ...fixture.config,
        remote: "git@github.invalid:owner/repo.git",
        sshKeyFile: "/run/keys/deploy key",
        knownHostsFile: "/run/keys/known_hosts",
      },
    );
    expect(await keyed.prove({ pad: makePad() })).toEqual({
      kind: "refused",
      why: { kind: "origin-unreachable" },
    });
  } finally {
    process.env.PATH = path;
  }
  const args = await readFile(record, "utf8");
  expect(args).toContain("-i /run/keys/deploy key");
  expect(args).toContain("IdentitiesOnly=yes");
  expect(args).toContain("StrictHostKeyChecking=yes");
  expect(args).toContain("UserKnownHostsFile=/run/keys/known_hosts");
});
