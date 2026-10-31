import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord, parsePad, parsePadId, parseSha } from "../protocol";
import type { Config } from "./config";
import { log } from "./log";
import type { Pads } from "./pads";
import type { Pipeline } from "./pipeline";

const BODY_LIMIT = 256 * 1024;
const COOKIE = "composer";
const COOKIE_LABEL = "neorp composer session";
const COOKIE_MAX_AGE = 34_560_000;
const NO_CACHE_FILES = new Set(["index.html", "sw.js"]);

const sameSecret = (a: string, b: string) => {
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(a), hash(b));
};

const plain = (status: number, text: string, headers?: HeadersInit) =>
  new Response(text, { status, headers });

const readJson = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
};

const fieldOf = (value: unknown, name: string): unknown =>
  isRecord(value) ? value[name] : undefined;

const badRequest = () => plain(400, "The request is not valid.");

const findFile = async ({
  root,
  pathname,
}: {
  root: string;
  pathname: string;
}) => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (/[\0\\]/.test(decoded)) return undefined;
  const parts = decoded.split("/").filter(Boolean);
  if (parts.includes("..") || parts.includes(".")) return undefined;

  let path = root;
  let isDirectory = true;
  for (const part of parts) {
    if (!isDirectory) return undefined;
    path = join(path, part);
    const info = await lstat(path).catch(() => undefined);
    if (!info || !(info.isDirectory() || info.isFile())) return undefined;
    isDirectory = info.isDirectory();
  }
  if (!isDirectory) return path;
  const index = join(path, "index.html");
  const info = await lstat(index).catch(() => undefined);
  return info?.isFile() ? index : undefined;
};

export const createServer = async (
  config: Config,
  pipeline: Pipeline,
  pads: Pads,
) => {
  const token = (await readFile(config.tokenFile, "utf8")).trim();
  if (!token) throw new Error(`${config.tokenFile} is empty.`);

  const session = createHmac("sha256", token)
    .update(COOKIE_LABEL)
    .digest("hex");
  const sessionCookie = `${COOKIE}=${session}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
  const refreshed = { "Set-Cookie": sessionCookie };
  const appHost = new URL(config.appOrigin).host;
  const proofHost = new URL(config.proofOrigin).host;

  const isPaired = (request: Request) => {
    const cookie = new Bun.CookieMap(request.headers.get("cookie") ?? "").get(
      COOKIE,
    );
    return cookie !== null && sameSecret(cookie, session);
  };

  const pair = async (request: Request) => {
    const given = fieldOf(await readJson(request), "token");
    if (typeof given !== "string") return badRequest();
    if (!sameSecret(given, token)) return plain(401, "The token is not valid.");
    return Response.json(null, { headers: refreshed });
  };

  const putPad = async (request: Request, rawId: string) => {
    const id = parsePadId(rawId);
    const pad = parsePad(await readJson(request));
    if (!id || !pad || pad.id !== id) return badRequest();
    return Response.json(await pads.put(pad));
  };

  const prove = async (request: Request) => {
    const pad = parsePad(fieldOf(await readJson(request), "pad"));
    if (!pad) return badRequest();
    return Response.json(await pipeline.prove({ pad }));
  };

  const ship = async (request: Request) => {
    const sha = parseSha(fieldOf(await readJson(request), "sha"));
    if (!sha) return badRequest();
    return Response.json(await pipeline.ship({ sha }));
  };

  const api = async ({ request, path }: { request: Request; path: string }) => {
    const { method } = request;
    if (path === "/api/pair") {
      return method === "POST" ? pair(request) : plain(405, "Use POST.");
    }
    if (!isPaired(request)) return plain(401, "Pair this app first.");

    const padId = /^\/api\/pads\/([^/]+)$/.exec(path)?.[1];
    if (padId !== undefined) {
      return method === "PUT" ? putPad(request, padId) : plain(405, "Use PUT.");
    }

    const route = `${method} ${path}`;
    switch (route) {
      case "GET /api/session":
        return Response.json(null, { headers: refreshed });
      case "GET /api/pads":
        return Response.json(await pads.list());
      case "GET /api/tags":
        return Response.json(await pipeline.tags());
      case "POST /api/prove":
        return prove(request);
      case "POST /api/ship":
        return ship(request);
      default:
        return plain(404, "There is no such route.");
    }
  };

  const shell = async ({
    request,
    path,
  }: {
    request: Request;
    path: string;
  }) => {
    if (request.method !== "GET") return plain(405, "Use GET.");
    const file = await findFile({ root: config.shellDir, pathname: path });
    if (!file) return plain(404, "There is no such file.");
    const name = file.split("/").at(-1) ?? "";
    return new Response(Bun.file(file), {
      headers: NO_CACHE_FILES.has(name) ? { "Cache-Control": "no-cache" } : {},
    });
  };

  const handleApp = async (request: Request) => {
    if (request.headers.get("host") !== appHost) {
      return plain(421, "The host is not valid.");
    }
    const fetchSite = request.headers.get("sec-fetch-site");
    if (request.method !== "GET" && fetchSite && fetchSite !== "same-origin") {
      return plain(403, "Cross-site requests are not permitted.");
    }
    const path = new URL(request.url).pathname;
    return path.startsWith("/api/")
      ? api({ request, path })
      : shell({ request, path });
  };

  const proofHeaders = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `frame-ancestors ${config.appOrigin}`,
  };

  const handleProof = async (request: Request) => {
    if (request.headers.get("host") !== proofHost) {
      return plain(421, "The host is not valid.", proofHeaders);
    }
    if (!isPaired(request))
      return plain(401, "Pair this app first.", proofHeaders);
    if (request.method !== "GET") return plain(405, "Use GET.", proofHeaders);
    const file = await findFile({
      root: join(config.dataDir, "proof", "current"),
      pathname: new URL(request.url).pathname,
    });
    if (!file) return plain(404, "There is no such file.", proofHeaders);
    return new Response(Bun.file(file), { headers: proofHeaders });
  };

  const onError = (error: Error) => {
    log("http-error", { message: error.message });
    return plain(500, "The server has an error.");
  };

  const shared = {
    maxRequestBodySize: BODY_LIMIT,
    error: onError,
    ...(config.tls.kind === "files"
      ? {
          tls: {
            cert: Bun.file(config.tls.cert),
            key: Bun.file(config.tls.key),
          },
        }
      : {}),
  };

  const app = Bun.serve({ ...shared, port: config.appPort, fetch: handleApp });
  const proof = Bun.serve({
    ...shared,
    port: config.proofPort,
    fetch: handleProof,
  });

  return {
    appPort: app.port ?? config.appPort,
    proofPort: proof.port ?? config.proofPort,
    stop: async () => {
      await Promise.all([app.stop(true), proof.stop(true)]);
    },
  };
};
