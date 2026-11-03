import { describe, expect, test } from "bun:test";
import { crc32, deflateSync } from "node:zlib";
import {
  assetNameFor,
  assetPath,
  assetUrl,
  scanReservedAssetUrls,
  IMAGE_BYTE_LIMIT,
  imageInfo,
  imageMarkdown,
  parseAssetName,
  validateAsset,
} from "./images";
import {
  JPEG_BYTES,
  PNG_BYTES,
  WEBP_BYTES,
  pngWithIdat,
} from "./images.fixture";

describe("immutable images", () => {
  test.each([
    {
      bytes: JPEG_BYTES,
      info: { width: 3, height: 2, ext: "jpg", type: "image/jpeg" },
    },
    {
      bytes: WEBP_BYTES,
      info: { width: 3, height: 2, ext: "webp", type: "image/webp" },
    },
  ] as const)(
    "reads and validates supported raster formats",
    async ({ bytes, info }) => {
      expect(imageInfo(bytes)).toEqual(info);
      expect(
        (await validateAsset(await assetNameFor(bytes, info.ext), bytes))
          ?.bytes,
      ).toEqual(bytes);
    },
  );
  test("names identify the format and every byte", async () => {
    const name = await assetNameFor(PNG_BYTES, "png");
    expect(parseAssetName(name)).toBe(name);
    expect(imageInfo(PNG_BYTES)).toEqual({
      width: 1,
      height: 1,
      ext: "png",
      type: "image/png",
    });
    expect((await validateAsset(name, PNG_BYTES))?.bytes).toEqual(PNG_BYTES);
    const changed = PNG_BYTES.slice();
    changed[45] = 17;
    expect(await validateAsset(name, changed)).toBeUndefined();
    expect(
      await validateAsset(await assetNameFor(PNG_BYTES, "jpg"), PNG_BYTES),
    ).toBeUndefined();
    expect(assetPath(name)).toBe(`public/post-assets/${name}`);
  });

  test.each([
    "../x.png",
    "a.png",
    `${"a".repeat(64)}.svg`,
    `${"A".repeat(64)}.png`,
    `${"a".repeat(64)}.png/other`,
  ])("rejects name %s", (name) => expect(parseAssetName(name)).toBeUndefined());

  test("rejects truncated, unsupported, oversized, and excessive dimensions", () => {
    expect(imageInfo(new Uint8Array(100))).toBeUndefined();
    expect(imageInfo(PNG_BYTES.slice(0, -1))).toBeUndefined();
    expect(imageInfo(new Uint8Array(IMAGE_BYTE_LIMIT + 1))).toBeUndefined();
    const huge = PNG_BYTES.slice();
    const view = new DataView(huge.buffer);
    view.setUint32(16, 12000);
    view.setUint32(29, crc32(huge.subarray(12, 29)));
    expect(imageInfo(huge)?.width).toBe(12000);
    view.setUint32(16, 12001);
    view.setUint32(29, crc32(huge.subarray(12, 29)));
    expect(imageInfo(huge)).toBeUndefined();
    view.setUint32(16, 10000);
    view.setUint32(20, 10000);
    view.setUint32(29, crc32(huge.subarray(12, 29)));
    expect(imageInfo(huge)).toBeUndefined();
    view.setUint32(20, 4000);
    view.setUint32(29, crc32(huge.subarray(12, 29)));
    expect(imageInfo(huge)?.height).toBe(4000);
  });

  test("rejects corrupt IDAT data despite a correct CRC and content hash", async () => {
    const bytes = pngWithIdat({ idat: [new Uint8Array(13)] });
    expect(imageInfo(bytes)).toBeDefined();
    expect(
      await validateAsset(await assetNameFor(bytes, "png"), bytes),
    ).toBeUndefined();
  });

  test("rejects truncated zlib streams and invalid zlib checksums with valid chunk CRCs", async () => {
    const data = deflateSync(new Uint8Array(5));
    const checksum = new Uint8Array(data);
    checksum[checksum.length - 1] ^= 1;
    for (const idat of [data.subarray(0, -1), checksum]) {
      const bytes = pngWithIdat({ idat: [idat] });
      expect(imageInfo(bytes)).toBeDefined();
      expect(
        await validateAsset(await assetNameFor(bytes, "png"), bytes),
      ).toBeUndefined();
    }
  });

  test.each([
    new Uint8Array(4),
    new Uint8Array(6),
    new Uint8Array([5, 0, 0, 0, 0]),
    new Uint8Array(1024 * 1024),
  ])(
    "rejects invalid scanline lengths, filters, and output beyond declared dimensions",
    async (rows) => {
      const bytes = pngWithIdat({ idat: [deflateSync(rows)] });
      expect(imageInfo(bytes)).toBeDefined();
      expect(
        await validateAsset(await assetNameFor(bytes, "png"), bytes),
      ).toBeUndefined();
    },
  );

  test.each([
    { color: 0, depths: [1, 2, 4, 8, 16], channels: 1 },
    { color: 2, depths: [8, 16], channels: 3 },
    { color: 3, depths: [1, 2, 4, 8], channels: 1 },
    { color: 4, depths: [8, 16], channels: 2 },
    { color: 6, depths: [8, 16], channels: 4 },
  ])(
    "accepts legal PNG color types and bit depths",
    async ({ color, depths, channels }) => {
      for (const depth of depths) {
        const width = 3;
        const stride = 1 + Math.ceil((width * depth * channels) / 8);
        const rows = new Uint8Array(stride * 5);
        for (let row = 0; row < 5; row++) rows[row * stride] = row;
        const bytes = pngWithIdat({
          width,
          height: 5,
          color,
          depth,
          palette: color === 3 ? new Uint8Array(3) : undefined,
          idat: [deflateSync(rows)],
        });
        expect(
          await validateAsset(await assetNameFor(bytes, "png"), bytes),
        ).toBeDefined();
      }
    },
  );

  test("accepts Adam7 packed rows, empty passes, and split IDAT chunks", async () => {
    const passes = [
      [2, 2],
      [1, 2],
      [3, 1],
      [2, 3],
      [5, 2],
      [4, 5],
      [9, 4],
    ] as const;
    const rows = Uint8Array.from(
      passes.flatMap(([width, height]) =>
        Array.from({ length: height }, () => [
          4,
          ...new Uint8Array(Math.ceil(width / 8)),
        ]).flat(),
      ),
    );
    const data = deflateSync(rows);
    const bytes = pngWithIdat({
      width: 9,
      height: 9,
      color: 0,
      depth: 1,
      interlace: 1,
      idat: [data.subarray(0, 5), new Uint8Array(), data.subarray(5)],
    });
    expect(
      await validateAsset(await assetNameFor(bytes, "png"), bytes),
    ).toBeDefined();
    const tiny = pngWithIdat({
      interlace: 1,
      idat: [deflateSync(new Uint8Array(5))],
    });
    expect(
      await validateAsset(await assetNameFor(tiny, "png"), tiny),
    ).toBeDefined();
  });

  test("rejects illegal bit depths, methods, interlace, and missing palettes", async () => {
    for (const options of [
      { depth: 2 },
      { color: 3 },
      { color: 1 },
      { interlace: 2 },
    ]) {
      const bytes = pngWithIdat({
        ...options,
        idat: [deflateSync(new Uint8Array(5))],
      });
      expect(
        await validateAsset(await assetNameFor(bytes, "png"), bytes),
      ).toBeUndefined();
    }
    for (const offset of [26, 27]) {
      const bytes = PNG_BYTES.slice();
      bytes[offset] = 1;
      new DataView(bytes.buffer).setUint32(29, crc32(bytes.subarray(12, 29)));
      expect(imageInfo(bytes)).toBeDefined();
      expect(
        await validateAsset(await assetNameFor(bytes, "png"), bytes),
      ).toBeUndefined();
    }
  });

  test("checks filter bytes across streamed output chunks", async () => {
    const stride = 1 + 9000 * 8;
    const rows = new Uint8Array(stride * 2);
    rows[stride] = 4;
    const valid = pngWithIdat({
      width: 9000,
      height: 2,
      depth: 16,
      idat: [deflateSync(rows)],
    });
    expect(
      await validateAsset(await assetNameFor(valid, "png"), valid),
    ).toBeDefined();
    rows[stride] = 5;
    const invalid = pngWithIdat({
      width: 9000,
      height: 2,
      depth: 16,
      idat: [deflateSync(rows)],
    });
    expect(
      await validateAsset(await assetNameFor(invalid, "png"), invalid),
    ).toBeUndefined();
  });

  test("collects unique reserved URLs conservatively, including fences, HTML, and references", async () => {
    const name = await assetNameFor(PNG_BYTES, "png");
    const url = assetUrl(name);
    expect(
      scanReservedAssetUrls(
        `![one](${url})\n\n\`\`\`md\n![code](${url})\n\`\`\`\n<img src="${url}">\n[image]: ${url}`,
      ),
    ).toEqual({ kind: "valid", names: [name] });
    expect(scanReservedAssetUrls("![x](/post-assets/missing.png)").kind).toBe(
      "invalid",
    );
    expect(imageMarkdown(name, "a [b]\\\n<c>")).toBe(
      `![a \\[b\\]\\\\ \\<c\\>](${url})`,
    );
  });
});
