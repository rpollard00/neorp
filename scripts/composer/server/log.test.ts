import {
  afterEach,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Proved, Sha, ShipStatus } from "../protocol";
import {
  APP_HOST,
  createFixture,
  makePad,
  TOKEN,
  type Fixture,
} from "./fixture";

setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "main.ts");
const MARKER = "pad-text-marker";

let fixture: Fixture;

beforeEach(async () => {
  fixture = await createFixture();
});

afterEach(() => fixture.remove());

const startServer = () => {
  const { config } = fixture;
  return Bun.spawn(["bun", "--no-install", MAIN], {
    env: {
      PATH: process.env.PATH,
      COMPOSER_DATA: config.dataDir,
      COMPOSER_REMOTE: config.remote,
      COMPOSER_APP_ORIGIN: config.appOrigin,
      COMPOSER_PROOF_ORIGIN: config.proofOrigin,
      COMPOSER_APP_PORT: "0",
      COMPOSER_PROOF_PORT: "0",
      COMPOSER_TOKEN_FILE: config.tokenFile,
      COMPOSER_AUTHOR_NAME: config.author.name,
      COMPOSER_AUTHOR_EMAIL: config.author.email,
      COMPOSER_SHELL_DIR: config.shellDir,
      COMPOSER_SITE_URL: "http://127.0.0.1:9",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
};

const collect = (stream: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder();
  let text = "";
  const finished = (async () => {
    for await (const chunk of stream) {
      text += decoder.decode(chunk, { stream: true });
    }
  })();
  return { finished, read: () => text };
};

const proofSha = (answer: Proved) => {
  if (answer.kind !== "proved") throw new Error(JSON.stringify(answer));
  return answer.sha;
};

test("the logs of a prove, a ship, a lost push, and a failed prove hold no pad text", async () => {
  const child = startServer();
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  while (!stdout.read().includes("\n")) await Bun.sleep(10);
  const { appPort } = JSON.parse(stdout.read()) as { appPort: number };

  const post = (path: string, body: unknown, cookie = "") =>
    fetch(`http://127.0.0.1:${appPort}${path}`, {
      method: "POST",
      headers: { Host: APP_HOST, cookie },
      body: JSON.stringify(body),
    });

  const paired = await post("/api/pair", { token: TOKEN });
  const cookie = paired.headers.get("set-cookie")?.split(";")[0] ?? "";
  const prove = async (name: string) => {
    const pad = makePad({ text: `${MARKER} ${name}\n\nA body, ${MARKER}.` });
    const answer = await post("/api/prove", { pad }, cookie);
    return (await answer.json()) as Proved;
  };
  const ship = async (sha: Sha) => {
    const answer = await post("/api/ship", { sha }, cookie);
    return (await answer.json()) as ShipStatus;
  };

  const first = proofSha(await prove("one"));
  expect((await ship(first)).kind).toBe("pushed");
  expect(await fixture.remoteGit("show", "main")).toContain(MARKER);

  const lost = proofSha(await prove("two"));
  await fixture.pushFromLaptop({ "laptop.txt": "from the laptop\n" });
  expect((await ship(lost)).kind).toBe("stale");

  const proofDir = join(fixture.config.dataDir, "proof");
  await rm(proofDir, { recursive: true, force: true });
  await writeFile(proofDir, "not a directory");
  const failed = await prove("three");
  expect(failed).toMatchObject({
    kind: "refused",
    why: { kind: "build-failed" },
  });

  child.kill("SIGTERM");
  expect(await child.exited).toBe(0);
  await Promise.all([stdout.finished, stderr.finished]);
  expect(stderr.read()).toBe("");
  const output = stdout.read();
  const events = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).event);
  expect(events).toEqual([
    "started",
    "push-rejected",
    "prove-error",
    "stopping",
  ]);
  expect(output).not.toContain(MARKER);
});
