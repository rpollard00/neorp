import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Proved } from "../protocol";
import type { Config } from "./config";
import { APP_HOST, makePad, PROOF_HOST } from "./fixture";
import { createServer } from "./http";
import { createPads } from "./pads";
import { createPipeline } from "./pipeline";

const ROOT = resolve(import.meta.dir, "../../..");
const ENABLED = process.env.COMPOSER_E2E === "1";
const TOKEN = "e2e-token";

const git = (args: string[], cwd = ROOT) => {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};

describe("the real site", () => {
  const made: string[] = [];

  afterAll(async () => {
    await Promise.all(
      made.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  test.skipIf(!ENABLED)(
    "a proof of a clone of this repo renders the rule and the code block",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "composer-e2e-"));
      made.push(dir);
      const remote = join(dir, "remote.git");
      git(["clone", "--quiet", "--bare", "--no-local", ROOT, remote]);
      const head = git(["rev-parse", "HEAD"]);
      git(["update-ref", "refs/heads/main", head], remote);

      const tokenFile = join(dir, "token");
      await writeFile(tokenFile, TOKEN);
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
        shellDir: dir,
        siteUrl: "https://site.test",
        buildTimeoutSeconds: 120,
      };
      const pads = createPads(config);
      const pipeline = createPipeline(config, { pads });
      const server = await createServer(config, pipeline, pads);
      try {
        const pair = await fetch(
          `http://127.0.0.1:${server.appPort}/api/pair`,
          {
            method: "POST",
            headers: { Host: APP_HOST },
            body: JSON.stringify({ token: TOKEN }),
          },
        );
        const cookie = (pair.headers.get("set-cookie") ?? "").split(";")[0];

        const pad = makePad({
          text: "A real proof\n\nA line of text\n---\nAnother line\n\n```sh\necho “double” ‘single’\n```\n",
        });
        const started = performance.now();
        const answer = await fetch(
          `http://127.0.0.1:${server.appPort}/api/prove`,
          {
            method: "POST",
            headers: { Host: APP_HOST, cookie: cookie ?? "" },
            body: JSON.stringify({ pad }),
          },
        );
        const proved = (await answer.json()) as Proved;
        process.stdout.write(
          `${JSON.stringify({ event: "e2e-prove", seconds: (performance.now() - started) / 1000 })}\n`,
        );
        if (proved.kind !== "proved") throw new Error(JSON.stringify(proved));

        const page = await fetch(
          `http://127.0.0.1:${server.proofPort}${new URL(proved.url).pathname}`,
          { headers: { Host: PROOF_HOST, cookie: cookie ?? "" } },
        );
        expect(page.status).toBe(200);
        const html = await page.text();
        expect(html).toMatch(/<hr\s*\/?>/);
        expect(html).not.toMatch(/<h\d[^>]*>A line of text/);
        expect(html).toContain("tokyo-night");

        const code = /<pre[\s\S]*?<\/pre>/.exec(html)?.[0] ?? "";
        const text = code
          .replace(/<[^>]+>/g, "")
          .replaceAll("&quot;", '"')
          .replaceAll("&#39;", "'")
          .replaceAll("&#x27;", "'");
        expect(text).toContain(`"double"`);
        expect(text).toContain(`'single'`);

        const { prose } = JSON.parse(
          await readFile(
            join(config.dataDir, "proof", "current", "proof.json"),
            "utf8",
          ),
        ) as { prose: string };
        expect(prose).toContain("Another line");
        expect(prose).toContain("tokyo-night");
        expect(prose).not.toContain("<footer");
      } finally {
        await server.stop();
        await pipeline.close();
      }
    },
    600_000,
  );
});
