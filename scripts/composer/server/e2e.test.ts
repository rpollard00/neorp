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
import { assetNameFor, assetPath, assetUrl, imageMarkdown } from "../images";
import {
  imageFigureMarkdown,
  parseImagePresentation,
} from "../../../src/lib/image-figures";
import { PNG_BYTES } from "../images.fixture";
import { refusalNotice } from "../shell/screen";
import { createRepo } from "./git";

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
    "a real proof renders figures and legacy content, and rejects damaged figure source",
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

        const imageName = await assetNameFor(PNG_BYTES, "png");
        const upload = await fetch(
          `http://127.0.0.1:${server.appPort}/api/assets/${imageName}`,
          {
            method: "PUT",
            headers: { Host: APP_HOST, cookie: cookie ?? "" },
            body: PNG_BYTES,
          },
        );
        expect(upload.status).toBe(204);
        const presentation = parseImagePresentation({
          width: 1,
          height: 1,
          size: "auto",
          frame: "pixel",
          alt: '"Literal" -- ... &amp;',
          caption: "A separate <caption> /post-assets/not-an-asset",
        });
        if (presentation.kind !== "valid")
          throw new Error(presentation.message);
        const figure = imageFigureMarkdown({
          asset: imageName,
          presentation: presentation.presentation,
        });
        const pad = makePad({
          text: `A real proof\n\nA line of text\n---\nAnother line\n\n\`\`\`sh\necho “double” ‘single’\n\`\`\`\n\n${imageMarkdown(imageName, "A pasted pixel")}\n\n${figure}\n`,
          tags: ["e2e-tag"],
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
        expect(html).toContain(assetUrl(imageName));
        expect(html).toContain('class="image-figure" data-frame="pixel"');
        expect(html).toContain('style="--image-cap:1px"');
        expect(html).toContain(
          "A separate &#60;caption&#62; /post-assets/not-an-asset",
        );
        expect(html).toContain('alt="&#34;Literal&#34; -- ... &#38;amp;"');
        expect(html).not.toContain("<!--neorp-figure:");
        const image = await fetch(
          `http://127.0.0.1:${server.proofPort}${assetUrl(imageName)}`,
          { headers: { Host: PROOF_HOST, cookie: cookie ?? "" } },
        );
        expect(image.status).toBe(200);
        expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG_BYTES);
        expect(
          await createRepo(config).readBytes({
            commit: proved.sha,
            path: assetPath(imageName),
          }),
        ).toEqual(PNG_BYTES);

        const code = /<pre[\s\S]*?<\/pre>/.exec(html)?.[0] ?? "";
        const text = code
          .replace(/<[^>]+>/g, "")
          .replaceAll("&quot;", '"')
          .replaceAll("&#39;", "'")
          .replaceAll("&#x27;", "'");
        expect(text).toContain(`"double"`);
        expect(text).toContain(`'single'`);

        const { fingerprint } = JSON.parse(
          await readFile(
            join(config.dataDir, "proof", "current", "proof.json"),
            "utf8",
          ),
        ) as { fingerprint: string };
        expect(fingerprint).toContain("A real proof");
        expect(fingerprint).toContain("e2e-tag");
        expect(fingerprint).toContain("Another line");
        expect(fingerprint).toContain("tokyo-night");
        expect(fingerprint).not.toContain("<footer");
        expect(fingerprint).not.toContain("post-nav");
        for (const [index, { name, source }] of [
          {
            name: "direct unfinished marker",
            source: `${pad.text}\n\n${figure}`.replace("-->", ""),
          },
          {
            name: "unfinished marker in emphasis",
            source: `${pad.text}\n\n${figure.replace("<!--", " *<!--").replace("-->", "*")}`,
          },
          {
            name: "unfinished marker in image heading",
            source: `${pad.text}\n\n## ${figure.replace("-->", "")}`,
          },
        ].entries()) {
          const broken = { ...pad, rev: pad.rev + index + 1, text: source };
          const refused = await pipeline.prove({ pad: broken });
          expect(refused).toMatchObject({
            kind: "refused",
            why: { kind: "build-failed" },
          });
          if (refused.kind !== "refused" || refused.why.kind !== "build-failed")
            throw new Error("Expected a figure repair error");
          expect(refused.why.tail).toContain("Image figure at");
          expect(refused.why.tail).toContain("Repair the marker");
          expect(refusalNotice(refused.why).text).toContain(
            "Repair the marker",
          );
          expect(refusalNotice(refused.why).text).toContain("Image figure at");
          expect(
            (await pads.list()).find((saved) => saved.id === pad.id)?.text,
          ).toBe(broken.text);
          process.stdout.write(
            `${JSON.stringify({ event: "e2e-refused", name })}\n`,
          );
        }
      } finally {
        await server.stop();
        await pipeline.close();
      }
    },
    600_000,
  );
});
