import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildShell } from "./build";

let outdir: string;

beforeEach(async () => {
  outdir = await mkdtemp(join(tmpdir(), "neorp-shell-"));
});

afterEach(async () => {
  await rm(outdir, { recursive: true, force: true });
});

test("the worker names every shell file and the hash", async () => {
  const { hash, urls } = await buildShell(outdir);
  const worker = await readFile(join(outdir, "sw.js"), "utf8");
  expect(worker).toContain(`neorp-composer-${hash}`);
  expect(urls.sort()).toEqual([
    "/",
    "/app.js",
    "/apple-touch-icon.png",
    "/icon.svg",
    "/manifest.webmanifest",
    "/styles.css",
  ]);
  for (const url of urls) expect(worker).toContain(`"${url}"`);
});

test("the service worker does not skip the waiting phase", async () => {
  await buildShell(outdir);
  const worker = await readFile(join(outdir, "sw.js"), "utf8");
  expect(worker).not.toContain("skipWaiting");
});

test("the styles include the band mask", async () => {
  await buildShell(outdir);
  const styles = await readFile(join(outdir, "styles.css"), "utf8");
  expect(styles).toContain("--band-mask");
});

test("the apple-touch-icon is an opaque 180px PNG", async () => {
  await buildShell(outdir);
  const png = await readFile(join(outdir, "apple-touch-icon.png"));
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect(png.readUInt32BE(16)).toBe(180);
  expect(png.readUInt32BE(20)).toBe(180);
  // Color type 2 is RGB with no alpha.
  expect(png[25]).toBe(2);
});

test("the same files give the same cache name", async () => {
  const first = await buildShell(outdir);
  const second = await buildShell(outdir);
  expect(second.hash).toBe(first.hash);
});
