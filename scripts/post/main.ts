import { parseArgs, styleText } from "node:util";
import { postState, type PostState } from "../../src/lib/post";
import { formatDay } from "../../src/lib/post-plain";
import { plateFor } from "../../src/lib/plates";
import { pickPlate } from "./plate-picker";
import {
  createPost,
  displayPath,
  findPost,
  loadPosts,
  POSTS_PATH,
  type ParsedPost,
  writePost,
} from "./post-file";
import { parseDay, publish } from "./publish";
import { UserError } from "./user-error";

const DEV_URL = "http://localhost:4321";

const usage = (command: CommandName) =>
  new UserError(`Usage: bun post ${COMMANDS[command].usage}`);

const openInEditor = async (path: string) => {
  const editor = (process.env.VISUAL || process.env.EDITOR || "")
    .split(/\s+/)
    .filter(Boolean);
  if (editor.length === 0) return;
  const child = Bun.spawn([...editor, path], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  await child.exited;
};

const newPost = async (argv: string[]) => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      folder: { type: "boolean", default: false },
      "no-edit": { type: "boolean", default: false },
    },
  });
  const title = positionals.join(" ").trim();
  if (!title) throw usage("new");
  const { path, slug } = await createPost({ title, folder: values.folder });
  console.log(`Created ${displayPath(path)}`);
  console.log(`Preview ${DEV_URL}/posts/${slug}/`);
  console.log(
    styleText("dim", `It is a draft until you run bun post publish ${slug}.`),
  );
  if (process.stdout.isTTY && !values["no-edit"]) await openInEditor(path);
};

type Status = PostState | { kind: "invalid" };

const STATUS_ORDER = {
  invalid: 0,
  draft: 1,
  scheduled: 2,
  published: 3,
} satisfies Record<Status["kind"], number>;

const STATUS_COLOUR = {
  invalid: "red",
  draft: "yellow",
  scheduled: "cyan",
  published: "green",
} as const satisfies Record<Status["kind"], string>;

type Row = { status: Status; words: string; slug: string; title: string };

const toRow = (entry: ParsedPost, now: Date): Row => {
  if (entry.kind === "invalid") {
    return {
      status: { kind: "invalid" },
      words: "",
      slug: entry.slug,
      title: entry.problems[0] ?? "",
    };
  }
  const { post } = entry;
  return {
    status: postState(post.data, now),
    words: String(post.body.split(/\s+/).filter(Boolean).length),
    slug: post.slug,
    title: post.data.title,
  };
};

const time = (status: Status) => ("date" in status ? status.date.getTime() : 0);

const compareRows = (a: Row, b: Row) =>
  STATUS_ORDER[a.status.kind] - STATUS_ORDER[b.status.kind] ||
  (a.status.kind === "published"
    ? time(b.status) - time(a.status)
    : time(a.status) - time(b.status)) ||
  a.slug.localeCompare(b.slug);

const list = async (argv: string[]) => {
  parseArgs({ args: argv, options: {} });
  const now = new Date();
  const rows = (await loadPosts())
    .map((entry) => toRow(entry, now))
    .sort(compareRows);
  if (rows.length === 0) {
    console.log(`No posts in ${displayPath(POSTS_PATH)}.`);
    return;
  }
  const cells = rows.map((row) => ({
    kind: row.status.kind,
    date: "date" in row.status ? formatDay(row.status.date) : "",
    words: row.words,
    slug: row.slug,
    title: row.title,
  }));
  const header = {
    kind: "state",
    date: "date",
    words: "words",
    slug: "slug",
    title: "title",
  };
  const width = (key: keyof typeof header) =>
    Math.max(...[header, ...cells].map((cell) => cell[key].length));
  const [kindW, dateW, wordsW, slugW] = [
    width("kind"),
    width("date"),
    width("words"),
    width("slug"),
  ];
  console.log(
    styleText(
      "dim",
      `${header.kind.padEnd(kindW)}  ${header.date.padEnd(dateW)}  ${header.words.padStart(wordsW)}  ${header.slug.padEnd(slugW)}  ${header.title}`,
    ),
  );
  for (const cell of cells) {
    console.log(
      `${styleText(STATUS_COLOUR[cell.kind], cell.kind.padEnd(kindW))}  ${cell.date.padEnd(dateW)}  ${cell.words.padStart(wordsW)}  ${cell.slug.padEnd(slugW)}  ${cell.title}`,
    );
  }
};

const plate = async (argv: string[]) => {
  const { positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {},
  });
  const [arg] = positionals;
  if (arg === undefined || positionals.length > 1) throw usage("plate");
  const post = await findPost(arg);
  const picked = await pickPlate(plateFor({ id: post.slug, data: post.data }));
  if (!picked || picked === post.data.plate) {
    console.log(`${displayPath(post.path)} is unchanged.`);
    return;
  }
  await writePost(post, { ...post.data, plate: picked });
  console.log(`plate: ${picked} in ${displayPath(post.path)}`);
};

const publishCommand = async (argv: string[]) => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      on: { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
    },
  });
  if (positionals.length > 1) throw usage("publish");
  const on = values.on === undefined ? undefined : parseDay(values.on);
  if (values.on !== undefined && !on) {
    throw new UserError(`--on ${values.on} is not a real YYYY-MM-DD date.`);
  }
  await publish({ slug: positionals[0], on, yes: values.yes });
};

const HELP = `Usage: bun post <command>

Commands:
  new <title...> [--folder] [--no-edit]
      Start a draft at src/content/posts/<slug>.md and open it in $VISUAL or
      $EDITOR. --folder makes <slug>/index.md, for posts with images.
  list
      Every post with its state, date, and word count.
  plate <slug>
      Pick the palette for the post's plate.
  publish [slug] [--on YYYY-MM-DD] [--yes]
      Ask for what the post still needs (description, tags, plate, date) and
      write it. Commit the post with jj directly below the working copy, build
      that commit, move main to it, and push. A failed build undoes it all. A
      date after today schedules the post. --yes skips the questions that
      already have answers. Without a slug, pick from the drafts and scheduled
      posts.
  help
      Show this.

A slug can also be the path to the post's file, from the repo root or
absolute (nvim: %:p).

Everything below your working copy ships. Edits in your working copy that
aren't this post stay put.`;

const help = async () => console.log(HELP);

const COMMANDS = {
  new: { usage: "new <title...> [--folder] [--no-edit]", run: newPost },
  list: { usage: "list", run: list },
  plate: { usage: "plate <slug>", run: plate },
  publish: {
    usage: "publish [slug] [--on YYYY-MM-DD] [--yes]",
    run: publishCommand,
  },
  help: { usage: "help", run: help },
} satisfies Record<
  string,
  { usage: string; run: (argv: string[]) => Promise<void> }
>;

type CommandName = keyof typeof COMMANDS;

const isCommandName = (name: string): name is CommandName =>
  Object.hasOwn(COMMANDS, name);

const isParseArgsError = (error: unknown): error is TypeError =>
  error instanceof TypeError &&
  "code" in error &&
  String(error.code).startsWith("ERR_PARSE_ARGS");

const [name, ...argv] = process.argv.slice(2);
if (name === undefined || !isCommandName(name)) {
  if (name !== undefined) console.error(`Unknown command: ${name}\n`);
  console.error(HELP);
  process.exit(1);
}
try {
  await COMMANDS[name].run(argv);
} catch (error) {
  if (!(error instanceof UserError || isParseArgsError(error))) throw error;
  console.error(styleText("red", error.message, { stream: process.stderr }));
  process.exit(1);
}
