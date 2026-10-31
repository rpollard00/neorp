import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postSchema } from "../../src/lib/post";
import { slugify } from "../../src/lib/post-plain";
import {
  createPost,
  findPost,
  loadPosts,
  parsePost,
  serializePost,
  shippedPath,
  writePost,
  type PostFile,
} from "./post-file";

const BODY =
  "\nFirst line.  Two spaces.\r\n\n```yaml\n---\nnot: frontmatter\n---\n```\n\ttrailing tab\t";

const parsed = (source: string, path = "/posts/a.md"): PostFile => {
  const result = parsePost({ path, slug: "a", source });
  if (result.kind === "invalid") throw new Error(result.problems.join("; "));
  return result.post;
};

const frontmatterOf = (file: string) => file.split("---\n")[1];

describe("slugify", () => {
  test.each([
    ["Hello, World!", "hello-world"],
    ["  Crème brûlée à la carte ", "creme-brulee-a-la-carte"],
    ["ﬁve ﬂoors", "five-floors"],
    ["C++ & Rust: 2026 edition", "c-rust-2026-edition"],
    ["---", ""],
    ["日本語", ""],
  ])("%p → %p", (title, slug) => {
    expect(slugify(title)).toBe(slug);
  });
});

describe("serializePost", () => {
  const source = [
    "---",
    "plate: dusk",
    'title: "Quoted: title" # a comment',
    "x-extra: keep me",
    "tags: [css, pixels]",
    "description: Old",
    "---",
  ].join("\n");

  test("copies the body byte for byte", () => {
    const post = parsed(`${source}\n${BODY}`);
    const file = serializePost(post, {
      ...post.data,
      description: "New",
      pubDate: new Date("2026-10-01"),
    });
    expect(file.endsWith(`\n---\n${BODY}`)).toBe(true);
    expect(parsed(file).body).toBe(BODY);
  });

  test("puts keys in schema order, unknown keys last, and keeps untouched formatting", () => {
    const post = parsed(`${source}\n`);
    const file = serializePost(post, {
      ...post.data,
      pubDate: new Date("2026-10-01"),
    });
    expect(frontmatterOf(file)).toBe(
      [
        'title: "Quoted: title" # a comment',
        "description: Old",
        "pubDate: 2026-10-01",
        "tags: [css, pixels]",
        "plate: dusk",
        "x-extra: keep me",
        "",
      ].join("\n"),
    );
  });

  test("writes changed tags as a flow sequence and removes empty keys", () => {
    const post = parsed(`${source}\n`);
    const retagged = serializePost(post, {
      ...post.data,
      tags: ["css", "new tag"],
    });
    expect(retagged).toContain("tags: [css, new tag]\n");

    const emptied = serializePost(post, {
      ...post.data,
      tags: [],
      description: "",
      plate: undefined,
    });
    expect(frontmatterOf(emptied)).toBe(
      'title: "Quoted: title" # a comment\nx-extra: keep me\n',
    );
  });

  test("quotes values that YAML would read as something else", () => {
    const post = parsed("---\ntitle: plain\n---\n");
    const file = serializePost(post, {
      ...post.data,
      title: "2026-01-01",
      description: "Colons: and # hashes",
    });
    expect(parsed(file).data).toMatchObject({
      title: "2026-01-01",
      description: "Colons: and # hashes",
    });
  });

  test("round-trips through postSchema", () => {
    const post = parsed(`${source}\n${BODY}`);
    const data = {
      title: "New title",
      description: "A description",
      pubDate: new Date("2026-09-14"),
      tags: ["demo"],
      plate: "sea" as const,
    };
    const again = parsed(serializePost(post, data));
    expect(again.data).toEqual(data);
    expect(postSchema.parse(again.doc.toJS())).toEqual(data);
  });

  test("leaves the file alone when nothing changed and keys are in order", () => {
    const file = `---\ntitle:   Spaced\ntags:\n  - block\n---\n${BODY}`;
    const post = parsed(file);
    expect(serializePost(post, post.data)).toBe(file.replace("   ", " "));
  });
});

describe("shippedPath", () => {
  const dir = "/posts";

  test("ships the folder of an index post that has the folder to itself", () => {
    const path = "/posts/pics/index.mdx";
    expect(shippedPath({ path, paths: [path, "/posts/a.md"], dir })).toBe(
      "/posts/pics",
    );
  });

  test("ships only the file when the folder holds other posts", () => {
    const path = "/posts/notes/index.md";
    expect(
      shippedPath({ path, paths: [path, "/posts/notes/deep/b.md"], dir }),
    ).toBe(path);
  });

  test("ships only the file for an index in the posts folder itself", () => {
    const path = "/posts/index.md";
    expect(shippedPath({ path, paths: [path], dir })).toBe(path);
  });

  test("ships a plain post as its file", () => {
    expect(shippedPath({ path: "/posts/a.md", paths: [], dir })).toBe(
      "/posts/a.md",
    );
  });
});

describe("parsePost", () => {
  test("names every schema problem", () => {
    const result = parsePost({
      path: "/posts/a.md",
      slug: "a",
      source: "---\ndescription: 1\nplate: neon\n---\n",
    });
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.problems.map((p) => p.split(":")[0])).toEqual([
      "title",
      "description",
      "plate",
    ]);
  });

  test("reads a date the way Astro does", () => {
    const result = parsePost({
      path: "/posts/a.md",
      slug: "a",
      source: "---\ntitle: 2026-01-01\n---\n",
    });
    expect(result.kind).toBe("invalid");
  });

  test("rejects a quoted pubDate instead of guessing", () => {
    const result = parsePost({
      path: "/posts/a.md",
      slug: "a",
      source: '---\ntitle: t\npubDate: "2026-10-01"\n---\n',
    });
    expect(result.kind).toBe("invalid");
  });

  test("rejects a file without frontmatter", () => {
    expect(
      parsePost({ path: "/posts/a.md", slug: "a", source: "# Hi\n" }).kind,
    ).toBe("invalid");
  });
});

describe("post files", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bun-post-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  test("creates a draft with only a title", async () => {
    const { path, slug } = await createPost({
      title: "Hello: world",
      folder: false,
      dir,
    });
    expect(slug).toBe("hello-world");
    expect(path).toBe(join(dir, "hello-world.md"));
    expect(await readFile(path, "utf8")).toBe(
      '---\ntitle: "Hello: world"\n---\n\n',
    );
  });

  test("creates the folder form and refuses a taken slug in either form", async () => {
    const { path } = await createPost({ title: "Pics", folder: true, dir });
    expect(path).toBe(join(dir, "pics", "index.md"));
    expect(createPost({ title: "pics", folder: false, dir })).rejects.toThrow(
      /taken/,
    );
  });

  test("refuses the slug index", async () => {
    expect(createPost({ title: "Index", folder: true, dir })).rejects.toThrow(
      /index/,
    );
  });

  test("finds a post by slug, file path, or folder, and writes it back", async () => {
    await createPost({ title: "Pics", folder: true, dir });
    const bySlug = await findPost("pics", dir);
    expect((await findPost(join(dir, "pics", "index.md"), dir)).path).toBe(
      bySlug.path,
    );
    expect((await findPost(join(dir, "pics"), dir)).path).toBe(bySlug.path);

    await writePost(bySlug, { ...bySlug.data, plate: "sea" });
    expect((await findPost("pics", dir)).data.plate).toBe("sea");
  });

  test("lists invalid files instead of failing", async () => {
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "nested", "bad.mdx"), "---\nplate: neon\n---\n");
    await createPost({ title: "Good", folder: false, dir });
    const entries = await loadPosts(dir);
    expect(entries.map((entry) => entry.kind)).toEqual(["valid", "invalid"]);
    expect(findPost("nested/bad", dir)).rejects.toThrow(/invalid frontmatter/);
  });
});
