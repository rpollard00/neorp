import { expect, test } from "bun:test";
import { assetNameFor, imageMarkdown, type AssetName } from "../images";
import { PNG_BYTES } from "../images.fixture";
import {
  createImageLibrary,
  resizedDimensions,
  type AssetBlobs,
} from "./images";

const memoryBlobs = () => {
  const data = new Map<AssetName, Blob>();
  const blobs: AssetBlobs = {
    get: async (name) => data.get(name),
    put: async (name, blob) => {
      data.set(name, blob);
    },
  };
  return { blobs, data };
};

test("resize preserves proportions and cannot upscale", () => {
  expect(resizedDimensions({ width: 400, height: 300 }, 200)).toEqual({
    width: 200,
    height: 150,
  });
  expect(resizedDimensions({ width: 1, height: 100 }, 1)).toEqual({
    width: 1,
    height: 100,
  });
  for (const width of [0, -1, 401, 0.5, NaN])
    expect(() =>
      resizedDimensions({ width: 400, height: 300 }, width),
    ).toThrow();
});

test("insertion awaits durable blob storage and a new library recovers the same bytes", async () => {
  const { blobs, data } = memoryBlobs();
  let complete: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const delayed: AssetBlobs = {
    get: blobs.get,
    put: async (name, blob) => {
      await waiting;
      await blobs.put(name, blob);
    },
  };
  const fetch = async (_url: string, init: RequestInit) => {
    expect(init.method).toBe("PUT");
    expect(init.body).toEqual(PNG_BYTES);
    return new Response(null, { status: 204 });
  };
  const library = createImageLibrary({ blobs: delayed, fetch });
  let saved = false;
  const saving = library.save(PNG_BYTES).then((asset) => {
    saved = true;
    return asset;
  });
  await Bun.sleep(0);
  expect(saved).toBe(false);
  complete?.();
  const asset = await saving;
  expect(data.has(asset.name)).toBe(true);
  const reloaded = createImageLibrary({ blobs, fetch });
  const text = imageMarkdown(asset.name, "");
  expect(reloaded.pending(text)).toBe(true);
  expect(await reloaded.sync(text)).toEqual({ kind: "saved" });
  expect(reloaded.pending(text)).toBe(false);
});

test("storage failures do not yield an insertable asset", async () => {
  const library = createImageLibrary({
    blobs: {
      get: async () => undefined,
      put: async () => {
        throw new Error("Quota exceeded");
      },
    },
    fetch,
  });
  expect(library.save(PNG_BYTES)).rejects.toThrow("Quota exceeded");
});

test("failed uploads remain pending and retry, including authorization failures", async () => {
  const { blobs } = memoryBlobs();
  let status = 503;
  let puts = 0;
  const library = createImageLibrary({
    blobs,
    fetch: async () => {
      puts++;
      return new Response(null, { status });
    },
  });
  const asset = await library.save(PNG_BYTES);
  const text = imageMarkdown(asset.name, "");
  expect((await library.sync(text)).kind).toBe("failed");
  expect(library.pending(text)).toBe(true);
  status = 401;
  expect(await library.sync(text)).toMatchObject({
    kind: "failed",
    reason: "denied",
  });
  status = 204;
  expect(await library.sync(text)).toEqual({ kind: "saved" });
  expect(library.pending(text)).toBe(false);
  await library.sync(text);
  expect(puts).toBe(3);
});

test("another device recovers and validates bytes before marking them saved", async () => {
  const name = await assetNameFor(PNG_BYTES, "png");
  const text = imageMarkdown(name, "");
  const { blobs, data } = memoryBlobs();
  const methods: string[] = [];
  const library = createImageLibrary({
    blobs,
    fetch: async (_url, init) => {
      methods.push(init.method ?? "GET");
      return init.method === "GET"
        ? new Response(PNG_BYTES)
        : new Response(null, { status: 204 });
    },
  });
  expect(await library.sync(text)).toEqual({ kind: "saved" });
  expect(data.has(name)).toBe(true);
  expect(methods).toEqual(["GET", "PUT"]);
  const corrupt = createImageLibrary({
    blobs: memoryBlobs().blobs,
    fetch: async () => new Response("bad bytes"),
  });
  expect(await corrupt.sync(text)).toMatchObject({
    kind: "failed",
    reason: "server-error",
  });
  expect(corrupt.pending(text)).toBe(true);
  const missing = createImageLibrary({
    blobs: memoryBlobs().blobs,
    fetch: async () => new Response(null, { status: 404 }),
  });
  expect(await missing.sync(text)).toMatchObject({
    kind: "failed",
    message:
      "The image is missing from this phone and the server. Paste it again.",
  });
});
