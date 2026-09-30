import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Glob } from "bun";
import { isMap, isScalar, parseDocument, stringify, type Document } from "yaml";
import {
  POSTS_DIR,
  postSchema,
  slugFromPath,
  type PostData,
} from "../../src/lib/post";
import { UserError } from "./user-error";

export const ROOT = resolve(import.meta.dir, "../..");
export const POSTS_PATH = join(ROOT, POSTS_DIR);

/** Astro reads frontmatter with js-yaml, which parses timestamps. Match it. */
const YAML_SCHEMA = { customTags: ["timestamp" as const] };
const YAML_OUTPUT = { lineWidth: 0, flowCollectionPadding: false };

const FRONTMATTER = /^\uFEFF?---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

export type PostFile = {
  path: string;
  slug: string;
  data: PostData;
  doc: Document.Parsed;
  body: string;
};

export type ParsedPost =
  | { kind: "valid"; post: PostFile }
  | { kind: "invalid"; path: string; slug: string; problems: string[] };

export const locate = (entry: ParsedPost): { path: string; slug: string } =>
  entry.kind === "valid" ? entry.post : entry;

export const slugify = (title: string) =>
  title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const parsePost = ({
  path,
  slug,
  source,
}: {
  path: string;
  slug: string;
  source: string;
}): ParsedPost => {
  const invalid = (problems: string[]): ParsedPost => ({
    kind: "invalid",
    path,
    slug,
    problems,
  });
  const match = FRONTMATTER.exec(source);
  if (!match) return invalid(["no frontmatter: start the file with ---"]);

  const doc = parseDocument(match[1] ?? "", YAML_SCHEMA);
  if (doc.errors.length > 0) return invalid(doc.errors.map((e) => e.message));

  const result = postSchema.safeParse(doc.toJS());
  if (!result.success) {
    return invalid(
      result.error.issues.map((issue) =>
        issue.path.length > 0
          ? `${issue.path.join(".")}: ${issue.message}`
          : issue.message,
      ),
    );
  }
  return {
    kind: "valid",
    post: {
      path,
      slug,
      data: result.data,
      doc,
      body: source.slice(match[0].length),
    },
  };
};

const KEY_ORDER: readonly string[] = postSchema.keyof().options;

const keyRank = (key: unknown) => {
  const index = KEY_ORDER.indexOf(String(isScalar(key) ? key.value : key));
  return index === -1 ? KEY_ORDER.length : index;
};

const isEmpty = (value: unknown) =>
  value === undefined ||
  (typeof value === "string" && value.trim() === "") ||
  (Array.isArray(value) && value.length === 0);

/**
 * The file with its frontmatter set to `data`. Keys whose value did not change
 * keep their formatting. Empty values remove their key. The body is copied
 * as is.
 */
export const serializePost = (post: PostFile, data: PostData) => {
  const doc = post.doc.clone();
  for (const key of postSchema.keyof().options) {
    const next = data[key];
    if (JSON.stringify(next) === JSON.stringify(post.data[key])) continue;
    if (isEmpty(next)) doc.delete(key);
    else if (Array.isArray(next))
      doc.set(key, doc.createNode(next, { flow: true }));
    else doc.set(key, next);
  }
  if (isMap(doc.contents)) {
    doc.contents.items.sort((a, b) => keyRank(a.key) - keyRank(b.key));
  }
  return `---\n${doc.toString(YAML_OUTPUT)}---\n${post.body}`;
};

export const displayPath = (path: string) =>
  relative(process.cwd(), path) || path;

const invalidError = ({
  path,
  problems,
}: Extract<ParsedPost, { kind: "invalid" }>) =>
  new UserError(
    `${displayPath(path)} has invalid frontmatter:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
  );

export const loadPosts = async (dir = POSTS_PATH): Promise<ParsedPost[]> => {
  const files = await Array.fromAsync(
    new Glob("**/*.{md,mdx}").scan({ cwd: dir }),
  );
  return Promise.all(
    files.sort().map(async (file) => {
      const path = join(dir, file);
      return parsePost({
        path,
        slug: slugFromPath(file),
        source: await readFile(path, "utf8"),
      });
    }),
  );
};

/** `arg` is a slug, or a path to the post's file or folder. */
export const findPost = async (
  arg: string,
  dir = POSTS_PATH,
): Promise<PostFile> => {
  const path = resolve(arg);
  const posts = (await loadPosts(dir)).map((entry) => ({
    entry,
    ...locate(entry),
  }));
  const paths = posts.map((post) => post.path);
  const found = posts.find(
    (post) =>
      post.slug === arg ||
      post.path === path ||
      shippedPath({ path: post.path, paths, dir }) === path,
  )?.entry;
  if (!found) throw new UserError(`No post "${arg}" in ${displayPath(dir)}.`);
  if (found.kind === "invalid") throw invalidError(found);
  return found.post;
};

export const writePost = (post: PostFile, data: PostData) =>
  writeFile(post.path, serializePost(post, data));

/**
 * What version control ships for the post at `path`: its folder, if the post
 * is the folder's `index.md(x)` and the folder holds no other posts, else the
 * file. `paths` is every post file.
 */
export const shippedPath = ({
  path,
  paths,
  dir = POSTS_PATH,
}: {
  path: string;
  paths: string[];
  dir?: string;
}) => {
  const folder = dirname(path);
  const ownsFolder =
    /^index\.mdx?$/.test(basename(path)) &&
    folder !== dir &&
    paths.every((other) => other === path || !other.startsWith(folder + sep));
  return ownsFolder ? folder : path;
};

export const createPost = async ({
  title,
  folder,
  dir = POSTS_PATH,
}: {
  title: string;
  folder: boolean;
  dir?: string;
}) => {
  const slug = slugify(title);
  if (!slug) {
    throw new UserError(
      `"${title}" has no letters or digits to make a slug from.`,
    );
  }
  if (slug === "index") {
    throw new UserError(
      `"index" can't be a slug: it would read as the posts folder's own index.`,
    );
  }
  const taken = (await loadPosts(dir))
    .map(locate)
    .find((post) => post.slug === slug);
  if (taken) {
    throw new UserError(
      `The slug "${slug}" is taken by ${displayPath(taken.path)}.`,
    );
  }
  const path = folder ? join(dir, slug, "index.md") : join(dir, `${slug}.md`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `---\n${stringify({ title }, { ...YAML_SCHEMA, ...YAML_OUTPUT })}---\n\n`,
    {
      flag: "wx",
    },
  );
  return { path, slug };
};
