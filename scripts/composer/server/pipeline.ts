import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  formatDay,
  POSTS_DIR,
  siteToday,
  slugFromPath,
} from "../../../src/lib/post-plain";
import {
  isRecord,
  parseSha,
  parseSlug,
  type Pad,
  type Proved,
  type Refusal,
  type Sha,
  type ShipStatus,
  type Slug,
} from "../protocol";
import { newPostFile, readTags, revisedPostFile } from "../text";
import type { Config } from "./config";
import { createRepo } from "./git";
import { log } from "./log";
import { createPads, type Pads } from "./pads";
import { hostPath, run } from "./run";
import { createSandbox } from "./sandbox";

const LIVE_TIMEOUT_MS = 5_000;
const TAGS_FETCH_MS = 60_000;
const INSTALL_TIMEOUT_SECONDS = 300;
const STOP_WAIT_MS = 3_000;
const TAIL_LINES = 40;

export type Proof = {
  sha: Sha;
  parent: Sha;
  intent: string;
  slug: Slug;
  revision: boolean;
  prose: string;
};

export type Pipeline = {
  prove: (args: { pad: Pad }) => Promise<Proved>;
  ship: (args: { sha: Sha }) => Promise<ShipStatus>;
  tags: () => Promise<string[]>;
  close: () => Promise<void>;
};

type Change = {
  slug: Slug;
  path: string;
  source: string;
  message: string;
  revision: boolean;
};

export type FetchSite = (url: string, init: RequestInit) => Promise<Response>;

const refused = (why: Refusal): Proved => ({ kind: "refused", why });

const tailOf = (output: string) =>
  Bun.stripANSI(output).trimEnd().split("\n").slice(-TAIL_LINES).join("\n");

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const slugOfPath = (path: string) =>
  slugFromPath(path.slice(POSTS_DIR.length + 1));

const PROSE_OPEN =
  /<div\b[^>]*\bclass\s*=\s*(?:"[^"]*\bprose\b[^"]*"|'[^']*\bprose\b[^']*'|prose\b)[^>]*>/i;

const proseOf = (html: string) => {
  const open = PROSE_OPEN.exec(html);
  if (!open) return "";
  const start = open.index + open[0].length;
  const tags = /<(\/?)div\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 1;
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    depth += tag[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, tag.index).trim();
  }
  return "";
};

/** A revised post has a page already, so only its prose can show the new text. */
type LiveCheck =
  | { kind: "page-exists" }
  | { kind: "prose-matches"; prose: string }
  | { kind: "unknown-prose" };

const liveCheckOf = ({ revision, prose }: Proof): LiveCheck => {
  if (!revision) return { kind: "page-exists" };
  return prose ? { kind: "prose-matches", prose } : { kind: "unknown-prose" };
};

const parseProof = (value: unknown): Proof | undefined => {
  if (!isRecord(value)) return undefined;
  const { sha, parent, intent, slug, revision, prose } = value;
  const parsedSha = parseSha(sha);
  const parsedParent = parseSha(parent);
  const parsedSlug = parseSlug(slug);
  if (!parsedSha || !parsedParent || !parsedSlug) return undefined;
  if (typeof intent !== "string" || typeof revision !== "boolean") {
    return undefined;
  }
  if (typeof prose !== "string") return undefined;
  return {
    sha: parsedSha,
    parent: parsedParent,
    intent,
    slug: parsedSlug,
    revision,
    prose,
  };
};

const pruneSpecialFiles = async (dir: string) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await pruneSpecialFiles(path);
    else if (!entry.isFile()) await rm(path, { force: true });
  }
};

const readNodeVersion = async () => {
  const { code, stdout } = await run({
    cmd: ["node", "--version"],
    env: { PATH: hostPath() },
  }).catch(() => ({ code: 1, stdout: "" }));
  return code === 0 ? stdout.trim().replace(/^v/, "") : undefined;
};

export const createPipeline = (
  config: Config,
  {
    pads = createPads(config),
    fetchSite = (url, init) => fetch(url, init),
  }: { pads?: Pads; fetchSite?: FetchSite } = {},
): Pipeline => {
  const repo = createRepo(config);
  const sandbox = createSandbox(config);
  const proofDir = join(config.dataDir, "proof");
  const buildsDir = join(config.dataDir, "builds");
  const depsDir = join(config.dataDir, "deps");
  const currentProof = join(proofDir, "current");

  const proofUrl = (proof: Proof) =>
    `${config.proofOrigin}/posts/${proof.slug}/`;
  const publicUrl = (slug: Slug) => `${config.siteUrl}/posts/${slug}/`;

  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const result = tail.then(job, job);
    tail = result.catch(() => undefined);
    return result;
  };

  let fetchedAt = Number.NEGATIVE_INFINITY;
  const fetchMain = async () => {
    const fetched = await repo.fetch();
    if (fetched) fetchedAt = Date.now();
    return fetched;
  };

  const readSlot = async () => {
    try {
      return parseProof(
        JSON.parse(await readFile(join(currentProof, "proof.json"), "utf8")),
      );
    } catch {
      return undefined;
    }
  };

  const toolchainNeed = async (parent: Sha) => {
    const node = (await repo.read({ commit: parent, path: ".node-version" }))
      ?.trim()
      .replace(/^v/, "");
    if (node && node !== (await readNodeVersion())) return `node ${node}`;
    const manifest = await repo.read({ commit: parent, path: "package.json" });
    if (manifest === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(manifest);
      const manager = isRecord(parsed) ? parsed.packageManager : undefined;
      if (typeof manager !== "string") return undefined;
      const bun = /^bun@([^+]+)/.exec(manager)?.[1];
      if (!bun) return manager;
      return bun === Bun.version ? undefined : `bun ${bun}`;
    } catch {
      return "a valid package.json";
    }
  };

  const postPaths = (commit: Sha) => repo.listFiles({ commit, dir: POSTS_DIR });

  const newChange = async ({
    pad,
    parent,
    day,
  }: {
    pad: Pad;
    parent: Sha;
    day: string;
  }): Promise<Change | Refusal> => {
    const taken = (await postPaths(parent)).map(slugOfPath);
    const file = newPostFile({ text: pad.text, tags: pad.tags, day, taken });
    if (!file) return { kind: "blank" };
    return {
      slug: file.slug,
      path: file.path,
      source: file.source,
      message: `post: ${file.title}`,
      revision: false,
    };
  };

  const revisedChange = async ({
    pad,
    parent,
    slug,
    from,
  }: {
    pad: Pad;
    parent: Sha;
    slug: Slug;
    from: Sha;
  }): Promise<Change | Refusal> => {
    const path = (await postPaths(from)).find(
      (candidate) => slugOfPath(candidate) === slug,
    );
    if (!path || !path.endsWith(".md")) return { kind: "not-revisable" };
    const [before, after] = await Promise.all([
      repo.blobId({ commit: from, path }),
      repo.blobId({ commit: parent, path }),
    ]);
    if (before !== after) return { kind: "revise-conflict" };
    const current = await repo.read({ commit: parent, path });
    const file =
      current === undefined
        ? undefined
        : revisedPostFile({ text: pad.text, tags: pad.tags, current });
    if (!file) return { kind: "not-revisable" };
    return {
      slug,
      path,
      source: file.source,
      message: `post: revise ${file.title}`,
      revision: true,
    };
  };

  const planChange = ({
    pad,
    parent,
    day,
  }: {
    pad: Pad;
    parent: Sha;
    day: string;
  }) => {
    const { target } = pad;
    switch (target.kind) {
      case "new":
        return newChange({ pad, parent, day });
      case "revise":
        return revisedChange({
          pad,
          parent,
          slug: target.slug,
          from: target.from,
        });
      default: {
        const exhaustive: never = target;
        return exhaustive;
      }
    }
  };

  const mustRun = async (args: string[], cwd?: string) => {
    const result = await sandbox.run({ args, cwd });
    if (result.code !== 0) {
      throw new Error(`${args[0]} failed: ${tailOf(result.tail)}`);
    }
  };

  const prepareSandbox = async () => {
    await mustRun([
      "mkdir",
      "-p",
      buildsDir,
      join(depsDir, "home"),
      join(depsDir, "cache"),
    ]);
    await mustRun([
      "find",
      buildsDir,
      "-mindepth",
      "1",
      "-maxdepth",
      "1",
      "-exec",
      "rm",
      "-rf",
      "{}",
      "+",
    ]);
  };

  const exportTree = async ({ sha, tree }: { sha: Sha; tree: string }) => {
    await mustRun(["mkdir", "-p", tree]);
    const archive = repo.archive(sha);
    const [unpacked, archived] = await Promise.all([
      sandbox.unpack({ input: archive.output, dir: tree }),
      archive.exited,
    ]);
    if (archived !== 0 || unpacked.code !== 0) {
      throw new Error(`git archive failed: ${tailOf(unpacked.tail)}`);
    }
  };

  const linkDeps = async ({
    sha,
    tree,
  }: {
    sha: Sha;
    tree: string;
  }): Promise<Refusal | undefined> => {
    const lock = await repo.read({ commit: sha, path: "bun.lock" });
    if (lock === undefined) {
      return { kind: "build-failed", tail: "The commit has no bun.lock." };
    }
    const cached = join(depsDir, sha256(lock), "node_modules");
    const inTree = join(tree, "node_modules");
    const { code: missing } = await sandbox.run({
      args: ["test", "-d", cached],
    });
    if (missing !== 0) {
      const install = await sandbox.run({
        args: ["bun", "install", "--frozen-lockfile"],
        cwd: tree,
        timeoutSeconds: INSTALL_TIMEOUT_SECONDS,
      });
      if (install.code !== 0) {
        return { kind: "build-failed", tail: tailOf(install.tail) };
      }
      await mustRun(["mkdir", "-p", inTree, dirname(cached)]);
      await mustRun(["mv", "-T", inTree, cached]);
    }
    await mustRun(["rm", "-rf", inTree]);
    await mustRun(["ln", "-s", cached, inTree]);
    return undefined;
  };

  const build = async (tree: string): Promise<Refusal | undefined> => {
    const { code, tail: output } = await sandbox.run({
      args: ["bun", "run", "--silent", "build"],
      cwd: tree,
      timeoutSeconds: config.buildTimeoutSeconds,
    });
    if (code === 0) return undefined;
    const stopped = code === 124 || code === 137;
    return {
      kind: "build-failed",
      tail: stopped
        ? `${tailOf(output)}\nThe build ran for more than ${config.buildTimeoutSeconds} seconds.`.trimStart()
        : tailOf(output),
    };
  };

  const promote = async ({
    tree,
    proof,
  }: {
    tree: string;
    proof: Omit<Proof, "prose">;
  }): Promise<Proof | Refusal> => {
    await mkdir(proofDir, { recursive: true, mode: 0o700 });
    const stage = join(proofDir, `${proof.sha}.tmp`);
    await rm(stage, { recursive: true, force: true });
    await mkdir(stage, { mode: 0o700 });

    const packed = sandbox.pack(join(tree, "dist"));
    const unpack = Bun.spawn(
      ["tar", "-x", "--no-same-owner", "--no-same-permissions", "-C", stage],
      {
        env: { PATH: hostPath() },
        stdin: packed.output,
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    const [packCode, unpackCode] = await Promise.all([
      packed.exited,
      unpack.exited,
    ]);
    if (packCode !== 0 || unpackCode !== 0) {
      throw new Error("tar could not copy dist");
    }
    await pruneSpecialFiles(stage);

    const page = join(stage, "posts", proof.slug, "index.html");
    const info = await lstat(page).catch(() => undefined);
    if (!info?.isFile()) {
      await rm(stage, { recursive: true, force: true });
      return { kind: "no-page" };
    }

    const full: Proof = {
      ...proof,
      prose: proseOf(await readFile(page, "utf8")),
    };
    await writeFile(join(stage, "proof.json"), JSON.stringify(full));
    await repo.pin(proof.sha);

    const final = join(proofDir, proof.sha);
    await rm(final, { recursive: true, force: true });
    await rename(stage, final);
    const link = `${currentProof}.tmp`;
    await rm(link, { force: true });
    await symlink(proof.sha, link);
    await rename(link, currentProof);

    for (const name of await readdir(proofDir)) {
      if (name === proof.sha || name === "current") continue;
      await rm(join(proofDir, name), { recursive: true, force: true });
    }
    return full;
  };

  const buildProof = async ({
    proof,
  }: {
    proof: Omit<Proof, "prose">;
  }): Promise<Proof | Refusal> => {
    const tree = join(buildsDir, proof.sha);
    try {
      await exportTree({ sha: proof.sha, tree });
      const failure =
        (await linkDeps({ sha: proof.sha, tree })) ?? (await build(tree));
      if (failure) return failure;
      const { code } = await sandbox.run({
        args: ["test", "-f", `dist/posts/${proof.slug}/index.html`],
        cwd: tree,
      });
      if (code !== 0) return { kind: "no-page" };
      return await promote({ tree, proof });
    } finally {
      await sandbox.run({ args: ["rm", "-rf", tree] });
    }
  };

  const proveNow = async ({
    pad,
    intent,
    day,
  }: {
    pad: Pad;
    intent: string;
    day: string;
  }): Promise<Proved> => {
    if (!(await fetchMain())) return refused({ kind: "origin-unreachable" });
    const parent = await repo.lastFetchedMain();
    if (!parent) return refused({ kind: "origin-unreachable" });

    const slot = await readSlot();
    const proved = (proof: Proof): Proved => ({
      kind: "proved",
      sha: proof.sha,
      url: proofUrl(proof),
    });
    if (slot?.parent === parent && slot.intent === intent) return proved(slot);

    const need = await toolchainNeed(parent);
    if (need) return refused({ kind: "toolchain", need });

    const change = await planChange({ pad, parent, day });
    if ("kind" in change) return refused(change);

    const sha = await repo.commitFile({ parent, ...change });
    if (!sha) return refused({ kind: "unchanged" });
    if (slot?.sha === sha) return proved(slot);

    await prepareSandbox();
    const outcome = await buildProof({
      proof: {
        sha,
        parent,
        intent,
        slug: change.slug,
        revision: change.revision,
      },
    });
    return "kind" in outcome ? refused(outcome) : proved(outcome);
  };

  const inFlight = new Map<string, Promise<Proved>>();

  const prove: Pipeline["prove"] = async ({ pad }) => {
    await pads.put(pad);
    if (!pad.text.trim()) return refused({ kind: "blank" });
    const day = formatDay(siteToday(new Date()));
    const intent = sha256(
      JSON.stringify({
        target: pad.target,
        text: pad.text,
        tags: pad.tags,
        day,
      }),
    );
    const joined = inFlight.get(intent);
    if (joined) return joined;
    const started = enqueue(() =>
      proveNow({ pad, intent, day }).catch((error: unknown): Proved => {
        const message = error instanceof Error ? error.message : String(error);
        log("prove-error", { pad: pad.id, message });
        return refused({ kind: "build-failed", tail: message });
      }),
    ).finally(() => inFlight.delete(intent));
    inFlight.set(intent, started);
    return started;
  };

  const isLive = async ({ url, check }: { url: string; check: LiveCheck }) => {
    if (check.kind === "unknown-prose") return false;
    try {
      const response = await fetchSite(url, {
        signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
      });
      if (response.status !== 200) return false;
      if (check.kind === "page-exists") return true;
      return proseOf(await response.text()) === check.prose;
    } catch {
      return false;
    }
  };

  const describeCommit = async (
    sha: Sha,
    slot: Proof | undefined,
  ): Promise<{ slug: Slug; check: LiveCheck } | undefined> => {
    if (slot?.sha === sha) return { slug: slot.slug, check: liveCheckOf(slot) };
    const [change, ...others] = await repo.changes(sha);
    if (!change || others.length > 0) return undefined;
    if (!change.path.startsWith(`${POSTS_DIR}/`)) return undefined;
    const slug = parseSlug(slugOfPath(change.path));
    if (!slug) return undefined;
    return {
      slug,
      check:
        change.status === "A"
          ? { kind: "page-exists" }
          : { kind: "unknown-prose" },
    };
  };

  const shipNow = async (sha: Sha): Promise<ShipStatus> => {
    if (!(await fetchMain())) return { kind: "origin-unreachable" };
    const slot = await readSlot();
    if (await repo.isOnMain(sha)) {
      const post = await describeCommit(sha, slot);
      if (!post) return { kind: "not-proven" };
      const url = publicUrl(post.slug);
      const live = await isLive({ url, check: post.check });
      return { kind: live ? "live" : "pushed", url, slug: post.slug };
    }
    if (slot?.sha !== sha) return { kind: "not-proven" };
    const pushed = await repo.push(sha);
    switch (pushed) {
      case "pushed":
        return { kind: "pushed", url: publicUrl(slot.slug), slug: slot.slug };
      case "rejected":
        log("push-rejected", { sha });
        return { kind: "stale" };
      case "failed":
        return { kind: "origin-unreachable" };
      default: {
        const exhaustive: never = pushed;
        return exhaustive;
      }
    }
  };

  const ship: Pipeline["ship"] = ({ sha }) => enqueue(() => shipNow(sha));

  let tagCache: { sha: Sha; tags: string[] } | undefined;

  const tags: Pipeline["tags"] = () =>
    enqueue(async () => {
      if (Date.now() - fetchedAt >= TAGS_FETCH_MS) await fetchMain();
      const main = await repo.lastFetchedMain();
      if (!main) return [];
      if (tagCache?.sha === main) return tagCache.tags;
      const found: string[] = [];
      for (const path of await postPaths(main)) {
        found.push(
          ...readTags((await repo.read({ commit: main, path })) ?? ""),
        );
      }
      tagCache = { sha: main, tags: [...new Set(found)].sort() };
      return tagCache.tags;
    });

  const close: Pipeline["close"] = async () => {
    sandbox.stop();
    await Promise.race([tail, Bun.sleep(STOP_WAIT_MS)]);
  };

  return { prove, ship, tags, close };
};
