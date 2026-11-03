import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { Pad, Proved, Sha, ShipStatus } from "../protocol";
import {
  APP_HOST,
  createFixture,
  makePad,
  PROOF_HOST,
  TOKEN,
  type Fixture,
} from "./fixture";
import { createServer } from "./http";
import { createPads } from "./pads";
import { createPipeline } from "./pipeline";
import {
  assetNameFor,
  assetUrl,
  IMAGE_BYTE_LIMIT,
  imageMarkdown,
} from "../images";
import { PNG_BYTES, pngWithIdat } from "../images.fixture";

setDefaultTimeout(30_000);

let fixture: Fixture;
let server: Awaited<ReturnType<typeof createServer>>;
let pipeline: ReturnType<typeof createPipeline>;
let cookie: string;

type Call = RequestInit & { host?: string };

const app = (path: string, { host = APP_HOST, headers, ...init }: Call = {}) =>
  fetch(`http://127.0.0.1:${server.appPort}${path}`, {
    ...init,
    redirect: "manual",
    headers: { Host: host, ...headers },
  });

const proof = (
  path: string,
  { host = PROOF_HOST, headers, ...init }: Call = {},
) =>
  fetch(`http://127.0.0.1:${server.proofPort}${path}`, {
    ...init,
    redirect: "manual",
    headers: { Host: host, ...headers },
  });

const paired = (extra?: Record<string, string>) => ({
  cookie,
  ...extra,
});

const json = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "Content-Type": "application/json", ...paired() },
});

/** Sends the bytes as typed, because `fetch` cleans a path before it sends. */
const rawGet = ({
  port,
  path,
  host,
  cookie: value,
}: {
  port: number;
  path: string;
  host: string;
  cookie?: string;
}) =>
  new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${value ? `Cookie: ${value}\r\n` : ""}Connection: close\r\n\r\n`,
      );
    });
    let answer = "";
    socket.on("data", (chunk) => {
      answer += chunk.toString();
    });
    socket.on("end", () => resolve(answer));
    socket.on("error", reject);
  });

beforeAll(async () => {
  fixture = await createFixture();
});

afterAll(async () => {
  await fixture.remove();
});

const API_ROUTES: [string, string][] = [
  ["PUT", `/api/assets/${"a".repeat(64)}.png`],
  ["GET", `/api/assets/${"a".repeat(64)}.png`],
  ["GET", "/api/session"],
  ["GET", "/api/pads"],
  ["PUT", "/api/pads/pad-abcdefgh"],
  ["GET", "/api/tags"],
  ["POST", "/api/prove"],
  ["POST", "/api/ship"],
  ["GET", "/api/link-preview?url=https%3A%2F%2Fexample.com%2F"],
  ["GET", "/api/unknown"],
];

const PREVIEWED = "https://example.com/page";
let previewsAsked: string[] = [];

beforeEach(async () => {
  const pads = createPads(fixture.config);
  pipeline = createPipeline(fixture.config, {
    pads,
    fetchSite: async () => new Response("", { status: 404 }),
  });
  previewsAsked = [];
  server = await createServer(fixture.config, pipeline, pads, {
    fetchCard: async (url) => {
      previewsAsked.push(url);
      return url === PREVIEWED
        ? { site: "Example", title: "A page", description: "About it" }
        : undefined;
    },
  });
  const answer = await app("/api/pair", {
    method: "POST",
    body: JSON.stringify({ token: TOKEN }),
  });
  cookie = (answer.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
});

afterEach(async () => {
  await server.stop();
  await pipeline.close();
});

describe("image uploads", () => {
  test.each([
    new Uint8Array(13),
    deflateSync(new Uint8Array(4)),
    deflateSync(new Uint8Array([5, 0, 0, 0, 0])),
  ])("rejects correctly hashed PNGs with corrupt pixel data", async (data) => {
    const bytes = pngWithIdat({ idat: [data] });
    const name = await assetNameFor(bytes, "png");
    const path = `/api/assets/${name}`;
    expect(
      (await app(path, { method: "PUT", headers: paired(), body: bytes }))
        .status,
    ).toBe(400);
    expect((await app(path, { headers: paired() })).status).toBe(404);
  });

  test("the image allowance is separate from the smaller JSON cap", async () => {
    const text = new Uint8Array(300 * 1024).fill(120);
    const type = new TextEncoder().encode("tEXt");
    const chunk = new Uint8Array(text.length + 12);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, text.length);
    chunk.set(type, 4);
    chunk.set(text, 8);
    view.setUint32(chunk.length - 4, crc32(chunk.subarray(4, -4)));
    const bytes = new Uint8Array(PNG_BYTES.length + chunk.length);
    bytes.set(PNG_BYTES.subarray(0, -12));
    bytes.set(chunk, PNG_BYTES.length - 12);
    bytes.set(PNG_BYTES.subarray(-12), bytes.length - 12);
    const name = await assetNameFor(bytes, "png");
    expect(
      (
        await app(`/api/assets/${name}`, {
          method: "PUT",
          headers: paired(),
          body: bytes,
        })
      ).status,
    ).toBe(204);
    const response = await app(`/api/assets/${name}`, { headers: paired() });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  test("authenticated binary PUT is idempotent and GET returns identical bytes", async () => {
    const name = await assetNameFor(PNG_BYTES, "png");
    const path = `/api/assets/${name}`;
    const answers = await Promise.all(
      [1, 2].map(() =>
        app(path, { method: "PUT", headers: paired(), body: PNG_BYTES }),
      ),
    );
    expect(answers.map((answer) => answer.status)).toEqual([204, 204]);
    const answer = await app(path, { headers: paired() });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await answer.arrayBuffer())).toEqual(PNG_BYTES);
    expect(
      (await app(path, { method: "POST", headers: paired() })).status,
    ).toBe(405);
  });

  test("invalid names, bytes, hashes, and missing images fail visibly", async () => {
    expect(
      (
        await app("/api/assets/not-a-hash.png", {
          method: "PUT",
          headers: paired(),
          body: PNG_BYTES,
        })
      ).status,
    ).toBe(400);
    const wrong = `/api/assets/${"0".repeat(64)}.png`;
    expect(
      (await app(wrong, { method: "PUT", headers: paired(), body: PNG_BYTES }))
        .status,
    ).toBe(400);
    expect(
      (
        await app(wrong, {
          method: "PUT",
          headers: paired(),
          body: "bad bytes",
        })
      ).status,
    ).toBe(400);
    expect((await app(wrong, { headers: paired() })).status).toBe(404);
  });

  test("cross-site and oversized image uploads are refused", async () => {
    const name = await assetNameFor(PNG_BYTES, "png");
    const path = `/api/assets/${name}`;
    expect(
      (
        await app(path, {
          method: "PUT",
          headers: paired({ "Sec-Fetch-Site": "cross-site" }),
          body: PNG_BYTES,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app(path, {
          method: "PUT",
          headers: paired(),
          body: new Uint8Array(IMAGE_BYTE_LIMIT + 1),
        })
      ).status,
    ).toBe(413);
    const stream = new ReadableStream({
      start(controller) {
        for (let n = 0; n < 11; n++)
          controller.enqueue(new Uint8Array(1024 * 1024));
        controller.close();
      },
    });
    expect(
      (await app(path, { method: "PUT", headers: paired(), body: stream }))
        .status,
    ).toBe(413);
  });

  test("a proof serves exactly the uploaded image", async () => {
    const name = await assetNameFor(PNG_BYTES, "png");
    await app(`/api/assets/${name}`, {
      method: "PUT",
      headers: paired(),
      body: PNG_BYTES,
    });
    const pad = makePad({
      text: `Image over HTTP\n\n${imageMarkdown(name, "One pixel")}`,
    });
    const answer: unknown = await (
      await app("/api/prove", json({ pad }))
    ).json();
    expect(answer).toMatchObject({ kind: "proved" });
    const image = await proof(assetUrl(name), { headers: paired() });
    expect(image.status).toBe(200);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG_BYTES);
  });
});

describe("host check", () => {
  test.each([
    ["app", "evil.test"],
    ["app", PROOF_HOST],
    ["proof", "evil.test"],
    ["proof", APP_HOST],
  ])("the %s port refuses the host %s", async (port, host) => {
    const call = port === "app" ? app : proof;
    const answer = await call("/", {
      host,
      headers: paired(),
    });
    expect(answer.status).toBe(421);
  });
});

describe("pairing", () => {
  test.each(API_ROUTES)("%s %s needs the cookie", async (method, path) => {
    expect((await app(path, { method })).status).toBe(401);
  });

  test.each(API_ROUTES)(
    "%s %s refuses a wrong cookie",
    async (method, path) => {
      const answer = await app(path, {
        method,
        headers: { cookie: "composer=0123" },
      });
      expect(answer.status).toBe(401);
    },
  );

  test("the proof port needs the cookie", async () => {
    expect((await proof("/")).status).toBe(401);
    expect((await proof("/posts/a/")).status).toBe(401);
    expect((await proof("/", { method: "POST" })).status).toBe(401);
  });

  test("a wrong token sets no cookie", async () => {
    const answer = await app("/api/pair", {
      method: "POST",
      body: JSON.stringify({ token: `${TOKEN}x` }),
    });
    expect(answer.status).toBe(401);
    expect(answer.headers.get("set-cookie")).toBeNull();
  });

  test("the right token sets a strict cookie that holds no token", async () => {
    const answer = await app("/api/pair", {
      method: "POST",
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(answer.status).toBe(200);
    const value = answer.headers.get("set-cookie") ?? "";
    expect(value).toMatch(
      /^composer=[0-9a-f]{64}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=34560000$/,
    );
    expect(value).not.toContain(TOKEN);
  });

  test("the cookie opens the API", async () => {
    const answer = await app("/api/session", { headers: paired() });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("set-cookie")).toContain(cookie);
  });

  test("a cookie stays valid after a restart", async () => {
    const pads = createPads(fixture.config);
    const second = await createServer(fixture.config, pipeline, pads);
    const answer = await fetch(`http://127.0.0.1:${second.appPort}/api/pads`, {
      headers: { Host: APP_HOST, cookie },
    });
    await second.stop();
    expect(answer.status).toBe(200);
  });
});

describe("cross-site requests", () => {
  test.each(["cross-site", "same-site", "none"])(
    "refuses a POST marked %s",
    async (site) => {
      const answer = await app("/api/pair", {
        method: "POST",
        body: JSON.stringify({ token: TOKEN }),
        headers: { "Sec-Fetch-Site": site },
      });
      expect(answer.status).toBe(403);
      expect(answer.headers.get("set-cookie")).toBeNull();
    },
  );

  test("refuses a paired ship and PUT from another site", async () => {
    const init = json({ sha: "a".repeat(40) });
    const headers = paired({ "Sec-Fetch-Site": "cross-site" });
    expect((await app("/api/ship", { ...init, headers })).status).toBe(403);
    expect(
      (await app("/api/pads/pad-abcdefgh", { ...init, method: "PUT", headers }))
        .status,
    ).toBe(403);
  });

  test("accepts same-origin and a client with no header", async () => {
    const init = json({ token: TOKEN });
    expect((await app("/api/pair", init)).status).toBe(200);
    expect(
      (
        await app("/api/pair", {
          ...init,
          headers: { "Sec-Fetch-Site": "same-origin" },
        })
      ).status,
    ).toBe(200);
  });
});

describe("pads", () => {
  const put = (pad: Pad, id: string = pad.id) =>
    app(`/api/pads/${id}`, { ...json(pad), method: "PUT" });

  test("a PUT replay and an old rev keep the highest rev", async () => {
    const pad = makePad({ rev: 4 });
    expect(await (await put(pad)).json()).toEqual({ rev: 4, same: true });
    expect(await (await put(pad)).json()).toEqual({ rev: 4, same: true });
    expect(await (await put({ ...pad, rev: 2, text: "Old" })).json()).toEqual({
      rev: 4,
      same: false,
    });
    const list = (await (
      await app("/api/pads", { headers: paired() })
    ).json()) as Pad[];
    expect(list.find(({ id }) => id === pad.id)).toEqual(pad);
  });

  test("bad JSON gets 400", async () => {
    const answer = await app("/api/pads/pad-abcdefgh", {
      method: "PUT",
      body: "{",
      headers: paired(),
    });
    expect(answer.status).toBe(400);
  });

  test("a bad pad gets 400", async () => {
    const pad = makePad();
    expect((await put({ ...pad, rev: -1 })).status).toBe(400);
    expect((await put({ ...pad, tags: "x" as never })).status).toBe(400);
  });

  test("an id that differs from the body gets 400", async () => {
    expect((await put(makePad(), "pad-other-id")).status).toBe(400);
  });

  test.each(["..%2f..%2fescape", "%2e%2e", "UPPER-CASE-ID", "short"])(
    "the id %s cannot name a file",
    async (id) => {
      const pad = { ...makePad(), id: decodeURIComponent(id) } as Pad;
      expect((await put(pad, id)).status).toBeOneOf([400, 401, 404]);
      expect(await Bun.file(join(fixture.dir, "escape.json")).exists()).toBe(
        false,
      );
    },
  );

  test("a body over 256 KB is refused", async () => {
    const pad = makePad({ text: "x".repeat(257 * 1024) });
    expect((await put(pad)).status).toBe(413);
  });

  test("a body just under the limit is accepted", async () => {
    const pad = makePad({ text: "x".repeat(255 * 1024) });
    expect((await put(pad)).status).toBe(200);
  });
});

describe("prove and ship", () => {
  test("a bad pad gets 400", async () => {
    expect((await app("/api/prove", json({ pad: { id: "x" } }))).status).toBe(
      400,
    );
    expect((await app("/api/prove", json(null))).status).toBe(400);
  });

  test("a bad sha gets 400", async () => {
    expect((await app("/api/ship", json({ sha: "main" }))).status).toBe(400);
    expect((await app("/api/ship", json({}))).status).toBe(400);
  });

  test("a pad goes from prove to a served page to main", async () => {
    const pad = makePad({ text: "Through http\n\nServed body." });
    const proved = (await (
      await app("/api/prove", json({ pad }))
    ).json()) as Proved;
    if (proved.kind !== "proved") throw new Error(JSON.stringify(proved));
    const page = new URL(proved.url);
    const answer = await proof(page.pathname, { headers: paired() });
    expect(await answer.text()).toContain("Served body.");

    const shipped = (await (
      await app("/api/ship", json({ sha: proved.sha }))
    ).json()) as ShipStatus;
    expect(shipped.kind).toBe("pushed");
    expect(await fixture.remoteMain()).toBe(proved.sha as Sha);
  });

  test("a build longer than the idle limit still answers", async () => {
    const pad = makePad({ text: "Slow one\n\nBUILD_IS_SLOW" });
    const proved = (await (
      await app("/api/prove", json({ pad }))
    ).json()) as Proved;
    expect(proved.kind).toBe("proved");
  });

  test("tags come from main", async () => {
    const answer = await app("/api/tags", { headers: paired() });
    expect(await answer.json()).toContain("hello_there");
  });
});

describe("link preview", () => {
  const preview = (url?: string) =>
    app(
      url === undefined
        ? "/api/link-preview"
        : `/api/link-preview?url=${encodeURIComponent(url)}`,
      { headers: paired() },
    );

  test("answers with the card and the normalized URL", async () => {
    const answer = await preview("HTTPS://Example.com/page");
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      url: PREVIEWED,
      site: "Example",
      title: "A page",
      description: "About it",
    });
  });

  test.each([
    ["no URL", undefined],
    ["a URL that does not parse", "not a url"],
    ["a LAN address", "http://192.168.88.16/"],
    ["localhost", "http://localhost:8444/"],
    ["another scheme", "file:///etc/passwd"],
  ])("refuses %s with 400 and no fetch", async (_, url) => {
    expect((await preview(url)).status).toBe(400);
    expect(previewsAsked).toEqual([]);
  });

  test("a page that cannot be read gets 502", async () => {
    expect((await preview("https://example.com/gone")).status).toBe(502);
    expect(previewsAsked).toEqual(["https://example.com/gone"]);
  });

  test("only GET has the route", async () => {
    const answer = await app(
      `/api/link-preview?url=${encodeURIComponent(PREVIEWED)}`,
      json({}),
    );
    expect(answer.status).toBe(404);
  });
});

describe("the shell", () => {
  test("/ serves index.html with no cookie", async () => {
    const answer = await app("/");
    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain("Composer");
    expect(answer.headers.get("cache-control")).toBe("no-cache");
  });

  test("sw.js has no-cache, and other files do not", async () => {
    expect((await app("/sw.js")).headers.get("cache-control")).toBe("no-cache");
    expect((await app("/app.js")).headers.get("cache-control")).toBeNull();
  });

  test("a missing file is a 404", async () => {
    expect((await app("/nothing.js")).status).toBe(404);
  });

  test("a POST to the shell is refused", async () => {
    expect((await app("/", { method: "POST" })).status).toBe(405);
  });

  test.each(["/../token", "/..%2ftoken", "/%2e%2e/token", "/.%2e/token"])(
    "%s cannot leave the shell",
    async (path) => {
      const answer = await rawGet({
        port: server.appPort,
        path,
        host: APP_HOST,
      });
      expect(answer).not.toContain(TOKEN);
      expect(answer).not.toMatch(/^HTTP\/1.1 200/);
    },
  );
});

describe("the proof port", () => {
  let secret: string;

  beforeEach(async () => {
    secret = fixture.secretFile;
    const answer = await pipeline.prove({
      pad: makePad({ text: `Proof page\n\nLINK_TO:${secret}` }),
    });
    expect(answer.kind).toBe("proved");
  });

  test("serves the page of a directory with safe headers", async () => {
    const answer = await proof("/posts/proof-page/", { headers: paired() });
    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain("LINK_TO:");
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
    expect(answer.headers.get("content-security-policy")).toBe(
      `frame-ancestors http://${APP_HOST}`,
    );
  });

  test("a missing file is a 404 with the same headers", async () => {
    const answer = await proof("/missing", { headers: paired() });
    expect(answer.status).toBe(404);
    expect(answer.headers.get("cache-control")).toBe("no-store");
  });

  test("accepts GET only", async () => {
    const answer = await proof("/", { method: "POST", headers: paired() });
    expect(answer.status).toBe(405);
  });

  test("a symlink in dist is gone, so the secret cannot be read", async () => {
    for (const path of [
      "/posts/proof-page/leak.txt",
      "/posts/proof-page/leak-dir/deploy-key",
    ]) {
      const answer = await proof(path, { headers: paired() });
      expect(answer.status).toBe(404);
      expect(await answer.text()).not.toContain("SECRET-KEY-BYTES");
    }
  });

  test("a symlink placed after the build is not served", async () => {
    const current = join(fixture.config.dataDir, "proof", "current");
    const file = join(current, "late-link.txt");
    const dir = join(current, "late-dir");
    await symlink(secret, file);
    await symlink(join(fixture.dir, "secrets"), dir);
    try {
      expect(
        (await proof("/late-link.txt", { headers: paired() })).status,
      ).toBe(404);
      expect(
        (await proof("/late-dir/deploy-key", { headers: paired() })).status,
      ).toBe(404);
    } finally {
      await rm(file);
      await rm(dir);
    }
  });

  test("index.html as a symlink is not served for a directory", async () => {
    const current = join(fixture.config.dataDir, "proof", "current");
    const dir = join(current, "linked-page");
    await mkdir(dir);
    await symlink(secret, join(dir, "index.html"));
    const answer = await proof("/linked-page/", { headers: paired() });
    expect(answer.status).toBe(404);
    await rm(dir, { recursive: true });
  });

  test.each([
    "/../../token",
    "/..%2f..%2ftoken",
    "/%2e%2e/%2e%2e/token",
    "/posts/..%2f..%2f..%2f..%2ftoken",
    "/%00",
    "/..%5c..%5ctoken",
    "/%ff",
  ])("%s cannot leave the proof", async (path) => {
    const answer = await rawGet({
      port: server.proofPort,
      path,
      host: PROOF_HOST,
      cookie,
    });
    expect(answer).not.toContain(TOKEN);
    expect(answer).not.toMatch(/^HTTP\/1.1 200/);
  });

  test("a positive control: the same request shape can read a file", async () => {
    await writeFile(
      join(fixture.config.dataDir, "proof", "current", "open.txt"),
      "open",
    );
    const answer = await rawGet({
      port: server.proofPort,
      path: "/open.txt",
      host: PROOF_HOST,
      cookie,
    });
    expect(answer).toMatch(/^HTTP\/1.1 200/);
  });
});
