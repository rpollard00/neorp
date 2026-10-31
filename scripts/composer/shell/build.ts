import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const SHELL = import.meta.dir;

const POP = "#2b3dff";
const ON_POP = "#f5f0e6";
const ICON_GRID = 9;
const ICON_SCALE = 20;

const ICON_GLYPH = [
  ".........",
  ".........",
  "..#.##...",
  "..##..#..",
  "..#...#..",
  "..#...#..",
  "..#...#..",
  ".........",
  ".........",
];

const iconSvg = () => {
  const path = ICON_GLYPH.flatMap((row, y) =>
    [...row].flatMap((cell, x) => (cell === "#" ? [`M${x} ${y}h1v1h-1z`] : [])),
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ICON_GRID} ${ICON_GRID}" shape-rendering="crispEdges"><rect width="${ICON_GRID}" height="${ICON_GRID}" fill="${POP}"/><path fill="${ON_POP}" d="${path}"/></svg>\n`;
};

const rgb = (hex: string) =>
  [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Uint8Array) => {
  const named = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(named));
  return Buffer.concat([length, named, crc]);
};

/** An opaque RGB PNG, as iOS needs for `apple-touch-icon`. */
const iconPng = () => {
  const size = ICON_GRID * ICON_SCALE;
  const pixels = Buffer.alloc((size * 3 + 1) * size);
  const pop = rgb(POP);
  const onPop = rgb(ON_POP);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    const cells = ICON_GLYPH[Math.floor(y / ICON_SCALE)] ?? "";
    for (let x = 0; x < size; x++) {
      const on = cells[Math.floor(x / ICON_SCALE)] === "#";
      pixels.set(on ? onPop : pop, row + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", new Uint8Array()),
  ]);
};

const bundle = async (args: {
  entry: string;
  outdir: string;
  define?: Record<string, string>;
}) => {
  const result = await Bun.build({
    entrypoints: [join(SHELL, args.entry)],
    outdir: args.outdir,
    target: "browser",
    minify: true,
    naming: "[name].[ext]",
    define: args.define,
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `Cannot build ${args.entry}`);
  }
};

const shellHash = async (outdir: string, files: readonly string[]) => {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    hash.update(file);
    hash.update(await readFile(join(outdir, file)));
  }
  return hash.digest("hex").slice(0, 16);
};

export const buildShell = async (outdir: string) => {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  await bundle({ entry: "app.ts", outdir });
  await copyFile(join(SHELL, "index.html"), join(outdir, "index.html"));
  await copyFile(
    join(SHELL, "manifest.webmanifest"),
    join(outdir, "manifest.webmanifest"),
  );
  await copyFile(join(SHELL, "styles.css"), join(outdir, "styles.css"));
  await writeFile(join(outdir, "icon.svg"), iconSvg());
  await writeFile(join(outdir, "apple-touch-icon.png"), iconPng());

  const files = await readdir(outdir);
  const hash = await shellHash(outdir, files);
  const urls = files.map((file) => (file === "index.html" ? "/" : `/${file}`));
  await bundle({
    entry: "sw.ts",
    outdir,
    define: {
      CACHE_NAME: JSON.stringify(`neorp-composer-${hash}`),
      SHELL_FILES: JSON.stringify(urls),
    },
  });
  return { hash, urls };
};

if (import.meta.main) {
  const { hash, urls } = await buildShell(join(SHELL, "dist"));
  console.log(`shell ${hash}: ${urls.length} files`);
}
