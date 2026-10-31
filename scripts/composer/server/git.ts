import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Sha } from "../protocol";
import type { Config } from "./config";
import { hostPath, run } from "./run";

/** `timeout` signals the process group, so ssh stops with git. */
const NETWORK_LIMIT = ["timeout", "--kill-after=5", "60"];

type PushResult = "pushed" | "rejected" | "failed";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const sshCommand = ({
  sshKeyFile,
  knownHostsFile,
}: Pick<Config, "sshKeyFile" | "knownHostsFile">) =>
  [
    "ssh",
    ...(sshKeyFile ? ["-i", shellQuote(sshKeyFile)] : []),
    "-o IdentitiesOnly=yes",
    "-o StrictHostKeyChecking=yes",
    "-o BatchMode=yes",
    "-o ConnectTimeout=10",
    ...(knownHostsFile
      ? [`-o UserKnownHostsFile=${shellQuote(knownHostsFile)}`]
      : []),
  ].join(" ");

export const createRepo = ({
  dataDir,
  remote,
  author,
  sshKeyFile,
  knownHostsFile,
}: Config) => {
  const gitDir = join(dataDir, "repo.git");
  const baseEnv: Record<string, string> = {
    PATH: hostPath(),
    GIT_DIR: gitDir,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const networkEnv = {
    ...baseEnv,
    ...(sshKeyFile
      ? { GIT_SSH_COMMAND: sshCommand({ sshKeyFile, knownHostsFile }) }
      : {}),
  };

  const tryGit = ({
    args,
    env = baseEnv,
    stdin,
    limit = [],
  }: {
    args: string[];
    env?: Record<string, string>;
    stdin?: string;
    limit?: string[];
  }) => run({ cmd: [...limit, "git", ...args], env, stdin });

  const git = async (args: string[], env?: Record<string, string>) => {
    const { code, stdout, stderr } = await tryGit({ args, env });
    if (code !== 0) {
      throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
    }
    return stdout.trim();
  };

  let ready: Promise<void> | undefined;
  const ensureClone = () => {
    ready ??= (async () => {
      await mkdir(gitDir, { recursive: true, mode: 0o700 });
      await git(["init", "--quiet", "--bare"]);
      await git(["config", "remote.origin.url", remote]);
    })().catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    return ready;
  };

  const fetch = async () => {
    await ensureClone();
    const { code } = await tryGit({
      args: [
        "fetch",
        "--quiet",
        "--no-tags",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
      ],
      env: networkEnv,
      limit: NETWORK_LIMIT,
    });
    return code === 0;
  };

  const lastFetchedMain = async () => {
    await ensureClone();
    const { code, stdout } = await tryGit({
      args: ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"],
    });
    return code === 0 ? (stdout.trim() as Sha) : undefined;
  };

  const isOnMain = async (sha: Sha) => {
    const { code } = await tryGit({
      args: ["merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"],
    });
    return code === 0;
  };

  const read = async ({ commit, path }: { commit: Sha; path: string }) => {
    const { code, stdout } = await tryGit({
      args: ["cat-file", "blob", `${commit}:${path}`],
    });
    return code === 0 ? stdout : undefined;
  };

  const blobId = async ({ commit, path }: { commit: Sha; path: string }) => {
    const { code, stdout } = await tryGit({
      args: ["rev-parse", "--verify", "--quiet", `${commit}:${path}`],
    });
    return code === 0 ? stdout.trim() : undefined;
  };

  const listFiles = async ({ commit, dir }: { commit: Sha; dir: string }) => {
    const { code, stdout } = await tryGit({
      args: ["ls-tree", "-r", "--name-only", "-z", commit, "--", dir],
    });
    return code === 0 ? stdout.split("\0").filter(Boolean) : [];
  };

  const commitFile = async ({
    parent,
    path,
    source,
    message,
  }: {
    parent: Sha;
    path: string;
    source: string;
    message: string;
  }): Promise<Sha | undefined> => {
    const index = join(gitDir, "composer-index");
    const env = {
      ...baseEnv,
      GIT_INDEX_FILE: index,
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
    };
    const clearIndex = () =>
      Promise.all(
        [index, `${index}.lock`].map((file) => rm(file, { force: true })),
      );
    await clearIndex();
    try {
      await git(["read-tree", parent], env);
      const hashed = await tryGit({
        args: ["hash-object", "-w", "--stdin"],
        stdin: source,
      });
      if (hashed.code !== 0) throw new Error("git hash-object failed");
      await git(
        [
          "update-index",
          "--add",
          "--cacheinfo",
          `100644,${hashed.stdout.trim()},${path}`,
        ],
        env,
      );
      const tree = await git(["write-tree"], env);
      if (tree === (await git(["rev-parse", `${parent}^{tree}`]))) {
        return undefined;
      }
      const sha = await git(
        ["commit-tree", tree, "-p", parent, "-m", message],
        env,
      );
      return sha as Sha;
    } finally {
      await clearIndex();
    }
  };

  /** Keeps the commit of the proof safe from `git gc`. */
  const pin = async (sha: Sha) => {
    await git(["update-ref", "refs/composer/proof", sha]);
  };

  const archive = (sha: Sha) => {
    const child = Bun.spawn(["git", "archive", sha], {
      env: baseEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    return { output: child.stdout, exited: child.exited };
  };

  const push = async (sha: Sha): Promise<PushResult> => {
    const { code, stdout, stderr } = await tryGit({
      args: ["push", "--porcelain", "origin", `${sha}:refs/heads/main`],
      env: networkEnv,
      limit: NETWORK_LIMIT,
    });
    if (code === 0) return "pushed";
    return /\brejected\b/.test(`${stdout}\n${stderr}`) ? "rejected" : "failed";
  };

  const changes = async (sha: Sha) => {
    const { code, stdout } = await tryGit({
      args: ["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", sha],
    });
    if (code !== 0) return [];
    const fields = stdout.split("\0").filter(Boolean);
    return fields.flatMap((status, index) =>
      index % 2 === 0 ? [{ status, path: fields[index + 1] ?? "" }] : [],
    );
  };

  return {
    fetch,
    lastFetchedMain,
    isOnMain,
    read,
    blobId,
    listFiles,
    commitFile,
    pin,
    archive,
    push,
    changes,
  };
};
