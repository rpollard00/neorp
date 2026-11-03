import { describe, expect, test } from "bun:test";
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
import { JPEG_BYTES, PNG_BYTES, WEBP_BYTES } from "./images.fixture";

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
    new DataView(huge.buffer).setUint32(16, 12001);
    expect(imageInfo(huge)).toBeUndefined();
    new DataView(huge.buffer).setUint32(16, 10000);
    new DataView(huge.buffer).setUint32(20, 10000);
    expect(imageInfo(huge)).toBeUndefined();
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
