import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Pad, PadId, Sha, Target } from "../protocol";
import type { Config } from "./config";

export const TOKEN = "fixture-token-with-enough-random-looking-bytes";
export const APP_HOST = "compose.test";
export const PROOF_HOST = "proof.test:8444";

const BUILD_SCRIPT = (logFile: string) => `
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import pad from "leftpad";

appendFileSync(${JSON.stringify(logFile)}, "build\\n");
const root = "src/content/posts";
mkdirSync("dist", { recursive: true });
writeFileSync("dist/env.json", JSON.stringify(process.env));
writeFileSync("dist/has-git.txt", String(existsSync(".git")));
const probes = {};

for (const entry of readdirSync(root, { recursive: true })) {
  if (!/\\.mdx?$/.test(entry)) continue;
  const slug = entry.replace(/\\.mdx?$/, "").replace(/\\/index$/, "");
  const source = readFileSync(join(root, entry), "utf8");
  for (const [, path] of source.matchAll(/READ_PROBE:(\\S+)/g)) {
    try {
      probes[path] = existsSync(path) && statSync(path).isDirectory() ? readdirSync(path).length >= 0 : readFileSync(path, "utf8").length >= 0;
    } catch {
      probes[path] = false;
    }
  }
  writeFileSync("dist/probe.json", JSON.stringify({ uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(), probes }));
  if (source.includes("BUILD_FAILS")) {
    console.error("\\u001b[31mthe build broke on purpose\\u001b[39m");
    process.exit(1);
  }
  if (source.includes("BUILD_HANGS")) {
    const hangFile = /HANG_FILE:(\\S+)/.exec(source)?.[1];
    if (hangFile) writeFileSync(hangFile, JSON.stringify({ pid: process.pid, uid: process.getuid() }));
    console.log("about to hang");
    await new Promise(() => setInterval(() => {}, 1000));
  }
  if (source.includes("BUILD_IS_SLOW")) await Bun.sleep(11_000);
  if (source.includes("BUILD_LEAVES_DAEMON")) {
    spawn("setsid", ["sleep", "20"], { stdio: "inherit", detached: true }).unref();
  }
  if (source.includes("BUILD_SKIPS_PAGE")) continue;
  const page = join("dist/posts", slug, "index.html");
  const [, frontmatter = "", body = ""] = /^---\\n([\\s\\S]*?)\\n---\\n([\\s\\S]*)$/.exec(source) ?? [];
  const title = /^title: (.*)$/m.exec(frontmatter)?.[1] ?? "";
  const tags = /^tags: (.*)$/m.exec(frontmatter)?.[1] ?? "";
  mkdirSync(dirname(page), { recursive: true });
  writeFileSync(page, \`<html><body><article><p class="meta"><span>\${tags}</span></p><h1>\${title}</h1><div class="prose"><div>\${pad(body)}</div></div><nav>Older</nav></article></body></html>\`);
  const link = /LINK_TO:(\\S+)/.exec(source)?.[1];
  if (link) {
    symlinkSync(link, join(dirname(page), "leak.txt"));
    symlinkSync(dirname(link), join(dirname(page), "leak-dir"));
    symlinkSync(link, "dist/proof.json");
    spawnSync("mkfifo", [join(dirname(page), "pipe")]);
  }
}
`;

const run = async (cmd: string[], cwd?: string) => {
  const child = Bun.spawn(cmd, {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Laptop",
      GIT_AUTHOR_EMAIL: "laptop@example.com",
      GIT_COMMITTER_NAME: "Laptop",
      GIT_COMMITTER_EMAIL: "laptop@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(" ")}: ${stderr}`);
  return stdout.trim();
};

const nodeVersion = async () =>
  (await run(["node", "--version"])).replace(/^v/, "");

const writeTree = async (dir: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
};

export type Fixture = Awaited<ReturnType<typeof createFixture>>;

export const createFixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), "composer-fixture-"));
  const remote = join(dir, "remote.git");
  const seed = join(dir, "seed");
  const laptop = join(dir, "laptop");
  const buildLog = join(dir, "builds.log");
  const installLog = join(dir, "installs.log");
  const shellDir = join(dir, "shell");
  const tokenFile = join(dir, "token");
  const secretFile = join(dir, "secrets", "deploy-key");

  await writeTree(dir, {
    token: `${TOKEN}\n`,
    "secrets/deploy-key": "SECRET-KEY-BYTES\n",
    "shell/index.html": "<!doctype html><title>Composer</title>",
    "shell/sw.js": "self.addEventListener('fetch', () => {});",
    "shell/app.js": "export {};",
  });

  await run([
    "git",
    "init",
    "--quiet",
    "--bare",
    "--initial-branch=main",
    remote,
  ]);
  await run(["git", "init", "--quiet", "--initial-branch=main", seed]);
  await writeTree(seed, {
    ".node-version": `${await nodeVersion()}\n`,
    "package.json": JSON.stringify({
      name: "fixture",
      packageManager: `bun@${Bun.version}`,
      dependencies: { leftpad: "file:./vendor/leftpad" },
      scripts: {
        postinstall: `echo install >> ${installLog}`,
        build: "bun build.mjs",
      },
    }),
    "vendor/leftpad/package.json": JSON.stringify({
      name: "leftpad",
      version: "1.0.0",
      main: "index.js",
    }),
    "vendor/leftpad/index.js": 'module.exports = (text) => "" + text;\n',
    "build.mjs": BUILD_SCRIPT(buildLog),
    "src/content/posts/hello-world.md":
      "---\ntitle: Hello World\ndescription: The first post.\npubDate: 2026-01-02\ntags: [hello_there]\nplate: dawn\n---\n\nThe first body.\n",
  });
  await run(["bun", "install", "--no-summary"], seed);
  await rm(join(seed, "node_modules"), { recursive: true, force: true });
  await writeFile(join(seed, ".gitignore"), "node_modules\n");
  await run(["git", "add", "."], seed);
  await run(["git", "commit", "--quiet", "-m", "seed"], seed);
  await run(["git", "remote", "add", "origin", remote], seed);
  await run(["git", "push", "--quiet", "origin", "main"], seed);
  await run(["git", "clone", "--quiet", remote, laptop]);
  await writeFile(buildLog, "");
  await writeFile(installLog, "");

  const config: Config = {
    dataDir: join(dir, "data"),
    remote,
    appOrigin: `http://${APP_HOST}`,
    proofOrigin: `http://${PROOF_HOST}`,
    appPort: 0,
    proofPort: 0,
    tokenFile,
    tls: { kind: "plain" },
    author: { name: "Composer", email: "composer@example.com" },
    shellDir,
    siteUrl: "https://site.test",
    buildTimeoutSeconds: 30,
  };

  const pushFromLaptop = async (files: Record<string, string>) => {
    await run(
      ["git", "pull", "--quiet", "--ff-only", "origin", "main"],
      laptop,
    );
    await writeTree(laptop, files);
    await run(["git", "add", "."], laptop);
    await run(["git", "commit", "--quiet", "-m", "from the laptop"], laptop);
    await run(["git", "push", "--quiet", "origin", "main"], laptop);
    return (await run(["git", "rev-parse", "HEAD"], laptop)) as Sha;
  };

  const remoteGit = (...args: string[]) =>
    run(["git", `--git-dir=${remote}`, ...args]);

  const cloneGit = (...args: string[]) =>
    run(["git", `--git-dir=${join(config.dataDir, "repo.git")}`, ...args]);

  const remoteMain = async () => (await remoteGit("rev-parse", "main")) as Sha;

  const logCount = async (file: string) =>
    (await Bun.file(file).text()).split("\n").filter(Boolean).length;

  return {
    dir,
    config,
    remote,
    secretFile,
    pushFromLaptop,
    remoteGit,
    cloneGit,
    remoteMain,
    buildCount: () => logCount(buildLog),
    installCount: () => logCount(installLog),
    remove: () => rm(dir, { recursive: true, force: true }),
  };
};

let padCount = 0;

export const makePad = ({
  text = "A title\n\nThe body.",
  tags = [],
  target = { kind: "new" },
  rev = 1,
}: {
  text?: string;
  tags?: string[];
  target?: Target;
  rev?: number;
} = {}): Pad => {
  padCount += 1;
  return {
    id: `pad-fixture-${padCount}` as PadId,
    rev,
    text,
    tags,
    target,
    stage: { kind: "writing" },
    updatedAt: "2026-10-31T00:00:00.000Z",
  };
};
