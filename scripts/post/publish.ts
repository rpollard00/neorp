import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  outro,
  select,
  spinner,
  text,
  type CANCEL_SYMBOL,
} from "@clack/prompts";
import {
  formatDay,
  postState,
  siteToday,
  type PostData,
} from "../../src/lib/post";
import { plateFor } from "../../src/lib/plates";
import { SITE } from "../../src/site";
import { pickPlate } from "./plate-picker";
import {
  findPost,
  loadPosts,
  locate,
  ROOT,
  shippedPath,
  writePost,
  type PostFile,
} from "./post-file";
import { UserError } from "./user-error";

/** A YYYY-MM-DD date as UTC midnight, which is how the site reads `pubDate`. */
export const parseDay = (text: string): Date | undefined => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) return undefined;
  const [day, year, month, date] = match;
  const parsed = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(date)),
  );
  return formatDay(parsed) === day ? parsed : undefined;
};

const parseTags = (input: string) => [
  ...new Set(
    input
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
  ),
];

const answer = <T>(value: T | typeof CANCEL_SYMBOL): T => {
  if (isCancel(value)) {
    cancel("Nothing was written.");
    process.exit(0);
  }
  return value;
};

const jj = (args: string[]) => {
  const result = Bun.spawnSync(["jj", ...args], { cwd: ROOT });
  if (result.exitCode !== 0) {
    throw new UserError(
      `jj ${args.join(" ")} failed:\n${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString().trim();
};

type Gate =
  | { kind: "passed" }
  | { kind: "build-failed"; output: string }
  | { kind: "page-mismatch"; page: string };

const checkBuild = async ({
  cwd,
  slug,
  goesLive,
}: {
  cwd: string;
  slug: string;
  goesLive: boolean;
}): Promise<Gate> => {
  const child = Bun.spawn(["bun", "run", "--silent", "build"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) return { kind: "build-failed", output: stdout + stderr };
  const page = join("dist/posts", slug, "index.html");
  if (existsSync(join(cwd, page)) !== goesLive) {
    return { kind: "page-mismatch", page };
  }
  return { kind: "passed" };
};

const GATE_WORKSPACE = "bun-post-gate-";

/** Builds `revision` in a throwaway workspace, so the gate sees what ships. */
const checkRevision = async ({
  revision,
  slug,
  goesLive,
}: {
  revision: string;
  slug: string;
  goesLive: boolean;
}) => {
  const dir = await mkdtemp(join(tmpdir(), GATE_WORKSPACE));
  const name = basename(dir);
  let added = false;
  try {
    jj(["workspace", "add", "--name", name, "-r", revision, dir]);
    added = true;
    await symlink(join(ROOT, "node_modules"), join(dir, "node_modules"));
    return await checkBuild({ cwd: dir, slug, goesLive });
  } finally {
    if (added) jj(["workspace", "forget", name]);
    await rm(dir, { recursive: true, force: true });
  }
};

const gateError = ({
  gate,
  goesLive,
  outcome,
}: {
  gate: Exclude<Gate, { kind: "passed" }>;
  goesLive: boolean;
  outcome: string;
}) => {
  switch (gate.kind) {
    case "build-failed":
      log.message(gate.output.trimEnd().split("\n").slice(-40).join("\n"));
      return new UserError(`The build failed. ${outcome}`);
    case "page-mismatch":
      return new UserError(
        goesLive
          ? `The build has no ${gate.page}, so the post would not go live. ${outcome}`
          : `The build has ${gate.page}, but the post is scheduled. ${outcome}`,
      );
    default: {
      const exhaustive: never = gate;
      return exhaustive;
    }
  }
};

/** Fails before anything is written if `main` could not move to the post. */
const preflight = () => {
  const stale = jj(["workspace", "list", "-T", 'name ++ "\n"'])
    .split("\n")
    .filter((name) => name.startsWith(GATE_WORKSPACE));
  if (stale.length > 0) jj(["workspace", "forget", ...stale]);

  const [moved] = jj([
    "log",
    "-r",
    "present(main) ~ ::@-",
    "--no-graph",
    "-T",
    'change_id.shortest(8) ++ "\n"',
  ]).split("\n");
  if (moved) {
    throw new UserError(
      `main (${moved}) is not below your working copy, so it can't move to the post. Rebase your work onto it first (jj rebase -d main), then publish again. Nothing was written.`,
    );
  }
};

/** Moves the post's changes out of @ into a new commit directly below it. */
const commitPost = ({
  fileset,
  message,
}: {
  fileset: string;
  message: string;
}) => {
  if (!jj(["diff", "-r", "@", "--summary", "--", fileset])) return false;
  jj(["new", "--no-edit", "--insert-before", "@", "-m", message]);
  jj([
    "squash",
    "--from",
    "@",
    "--into",
    "@-",
    "--keep-emptied",
    "--use-destination-message",
    "--",
    fileset,
  ]);
  return true;
};

const uncommitPost = (fileset: string) =>
  jj([
    "squash",
    "--from",
    "@-",
    "--into",
    "@",
    "--use-destination-message",
    "--",
    fileset,
  ]);

const choosePost = async (now: Date) => {
  const waiting = (await loadPosts()).flatMap((entry) => {
    if (entry.kind === "invalid") return [];
    const state = postState(entry.post.data, now);
    return state.kind === "published" ? [] : [{ post: entry.post, state }];
  });
  if (waiting.length === 0) {
    outro("No drafts or scheduled posts to publish.");
    process.exit(0);
  }
  return answer(
    await select({
      message: "Which post?",
      options: waiting.map(({ post, state }) => ({
        value: post,
        label: post.data.title,
        hint:
          state.kind === "scheduled"
            ? `scheduled ${formatDay(state.date)} · ${post.slug}`
            : `draft · ${post.slug}`,
      })),
    }),
  );
};

const askDescription = async (post: PostFile, yes: boolean) => {
  const current = post.data.description;
  if (yes) {
    if (current) return current;
    throw new UserError(
      `${post.slug} has no description, and --yes skips the prompt. Run without --yes, or add description: to the frontmatter.`,
    );
  }
  const value = answer(
    await text({
      message: "Description",
      initialValue: current,
      validate: (value) =>
        value?.trim() ? undefined : "A post needs a description.",
    }),
  );
  return value.trim();
};

const askTags = async (post: PostFile, knownTags: string[]) => {
  const value = answer(
    await text({
      message:
        knownTags.length > 0
          ? `Tags, comma-separated (in use: ${knownTags.join(", ")})`
          : "Tags, comma-separated",
      initialValue: post.data.tags?.join(", "),
    }),
  );
  return parseTags(value);
};

const askPlate = async (post: PostFile) => {
  const { seed, palette } = plateFor({ id: post.slug, data: post.data });
  log.step("Plate");
  const picked = await pickPlate({ seed, palette });
  const plate = picked && picked !== palette ? picked : post.data.plate;
  log.info(`Plate: ${plate ?? `${palette} (from the slug)`}`);
  return plate;
};

const askDate = async (initial: Date) => {
  const value = answer(
    await text({
      message: "Publish date (YYYY-MM-DD)",
      initialValue: formatDay(initial),
      validate: (value) =>
        parseDay(value ?? "") ? undefined : "Use a real date, as YYYY-MM-DD.",
    }),
  );
  const date = parseDay(value);
  if (!date) throw new UserError(`"${value}" is not a date.`);
  return date;
};

const moveMain = (): { pushed: boolean } => {
  jj(["bookmark", "set", "main", "-r", "@-"]);
  const change = jj([
    "log",
    "-r",
    "main",
    "--no-graph",
    "-T",
    "change_id.shortest(8)",
  ]);
  if (!jj(["git", "remote", "list"])) {
    log.warn(
      `main is at ${change}. There is no remote yet; push later with jj git push --bookmark main.`,
    );
    return { pushed: false };
  }
  const push = spinner();
  push.start("Pushing main");
  try {
    jj(["git", "push", "--bookmark", "main"]);
  } catch (error) {
    push.error(`main is at ${change}, but the push failed.`);
    throw error;
  }
  push.stop(`Pushed main (${change}).`);
  return { pushed: true };
};

export const publish = async ({
  slug,
  on,
  yes,
}: {
  slug?: string;
  on?: Date;
  yes: boolean;
}) => {
  const now = new Date();
  intro("bun post publish");
  const versioned = existsSync(join(ROOT, ".jj"));
  if (versioned) preflight();
  const post = slug ? await findPost(slug) : await choosePost(now);
  const revision = postState(post.data, now).kind === "published";
  const posts = (await loadPosts()).map((entry) => ({
    entry,
    ...locate(entry),
  }));
  const knownTags = [
    ...new Set(
      posts.flatMap(({ entry }) =>
        entry.kind === "valid" ? (entry.post.data.tags ?? []) : [],
      ),
    ),
  ].sort();

  const description = await askDescription(post, yes);
  const tags = yes ? post.data.tags : await askTags(post, knownTags);
  const plate = yes ? post.data.plate : await askPlate(post);
  const initialDate = post.data.pubDate ?? siteToday(now);
  const pubDate = on ?? (yes ? initialDate : await askDate(initialDate));

  const data: PostData = { ...post.data, description, tags, plate, pubDate };
  const goesLive = postState(data, now).kind === "published";
  const url = `${SITE.url}/posts/${post.slug}/`;
  const palette = plateFor({ id: post.slug, data }).palette;
  note(
    [
      `title        ${data.title}`,
      `description  ${description}`,
      `tags         ${tags?.length ? tags.join(", ") : "none"}`,
      `plate        ${palette}${plate ? "" : " (from the slug)"}`,
      `date         ${formatDay(pubDate)}`,
      "",
      goesLive
        ? "Publishes now."
        : `Scheduled: goes live on the first build on or after ${formatDay(pubDate)}.`,
    ].join("\n"),
    post.slug,
  );
  if (!yes && !answer(await confirm({ message: "Publish?" }))) {
    cancel("Nothing was written.");
    process.exit(0);
  }

  const original = await readFile(post.path, "utf8");
  await writePost(post, data);
  const building = spinner();

  if (!versioned) {
    building.start("Building the site");
    const gate = await checkBuild({ cwd: ROOT, slug: post.slug, goesLive });
    if (gate.kind !== "passed") {
      building.error("The build did not pass.");
      throw gateError({
        gate,
        goesLive,
        outcome: "The frontmatter is saved, but nothing was committed.",
      });
    }
    building.stop("Built.");
    outro(`No .jj in ${ROOT}, so nothing was committed. The post is saved.`);
    return;
  }

  const path = shippedPath({
    path: post.path,
    paths: posts.map((p) => p.path),
  });
  const fileset = `root:${JSON.stringify(relative(ROOT, path))}`;
  const message = `post: ${revision ? "revise " : ""}${data.title}`;
  const committed = commitPost({ fileset, message });
  const undo = async () => {
    if (committed) uncommitPost(fileset);
    await writeFile(post.path, original);
  };

  building.start("Building what ships (@-)");
  let gate: Gate;
  try {
    gate = await checkRevision({ revision: "@-", slug: post.slug, goesLive });
  } catch (error) {
    building.error("The build could not run.");
    await undo();
    throw error;
  }
  if (gate.kind !== "passed") {
    building.error("The build did not pass.");
    await undo();
    throw gateError({
      gate,
      goesLive,
      outcome:
        "Publishing was undone: the post file and the repo are as they were before.",
    });
  }
  building.stop("Built what ships.");
  if (committed) log.success(`Committed "${message}".`);
  else log.warn(`${relative(ROOT, path)} has no changes in the working copy.`);

  const { pushed } = moveMain();
  const later = pushed ? "" : " once main is pushed";
  outro(
    goesLive
      ? `Live at ${url}${later}`
      : `Scheduled for ${formatDay(pubDate)}${later}: ${url}`,
  );
};
