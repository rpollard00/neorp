export type AssetName = string & { readonly __brand: "AssetName" };
export type ImageInfo = { width: number; height: number } & (
  | { type: "image/png"; ext: "png" }
  | { type: "image/jpeg"; ext: "jpg" }
  | { type: "image/webp"; ext: "webp" }
);
export type ImageAsset = {
  name: AssetName;
  bytes: Uint8Array;
  info: ImageInfo;
};
export type AssetReferences =
  { kind: "valid"; names: AssetName[] } | { kind: "invalid"; message: string };

export const IMAGE_BYTE_LIMIT = 10 * 1024 * 1024;
export const IMAGE_EDGE_LIMIT = 12000;
export const IMAGE_PIXEL_LIMIT = 40_000_000;
export const DEFAULT_IMAGE_EDGE = 1600;
export const ASSET_PREFIX = "/post-assets/";
export const parseAssetName = (value: unknown): AssetName | undefined =>
  typeof value === "string" && /^[a-f0-9]{64}\.(?:png|jpg|webp)$/.test(value)
    ? (value as AssetName)
    : undefined;
export const assetUrl = (name: AssetName) => `${ASSET_PREFIX}${name}`;
export const assetPath = (name: AssetName) => `public${assetUrl(name)}`;

export const scanReservedAssetUrls = (text: string): AssetReferences => {
  const names = new Set<AssetName>();
  for (const match of text.matchAll(/\/post-assets\/([^\s<>"'()\]\\]*)/g)) {
    const name = parseAssetName(match[1]);
    if (!name)
      return {
        kind: "invalid",
        message: "An image URL is not valid. Paste the image again.",
      };
    names.add(name);
  }
  return { kind: "valid", names: [...names] };
};

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  new TextDecoder().decode(bytes.subarray(start, end));

const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

export const imageInfo = (bytes: Uint8Array): ImageInfo | undefined => {
  if (bytes.length < 12 || bytes.length > IMAGE_BYTE_LIMIT) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let info: ImageInfo | undefined;
  if (bytes[0] === 137 && ascii(bytes, 1, 8) === "PNG\r\n\x1a\n") {
    let at = 8;
    let data = false;
    while (at + 12 <= bytes.length) {
      const size = view.getUint32(at);
      const type = ascii(bytes, at + 4, at + 8);
      if (at + size + 12 > bytes.length) return undefined;
      if (
        crc32(bytes.subarray(at + 4, at + 8 + size)) !==
        view.getUint32(at + 8 + size)
      )
        return undefined;
      if (at === 8) {
        if (type !== "IHDR" || size !== 13) return undefined;
        info = {
          width: view.getUint32(at + 8),
          height: view.getUint32(at + 12),
          type: "image/png",
          ext: "png",
        };
      }
      if (type === "IDAT") data = true;
      if (type === "IHDR" && at !== 8) return undefined;
      at += size + 12;
      if (type === "IEND") {
        if (size !== 0 || at !== bytes.length || !data) return undefined;
        break;
      }
      if (at === bytes.length) return undefined;
    }
    if (at !== bytes.length || ascii(bytes, at - 8, at - 4) !== "IEND")
      return undefined;
  } else if (
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes.at(-2) === 255 &&
    bytes.at(-1) === 217
  ) {
    let at = 2;
    let scanned = false;
    while (at + 4 <= bytes.length) {
      if (bytes[at] !== 255) return undefined;
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === undefined || marker === 217) break;
      const size = view.getUint16(at);
      if (size < 2 || at + size > bytes.length) return undefined;
      if (marker === 218) {
        if (!info || size < 6 || at + size >= bytes.length - 2)
          return undefined;
        scanned = true;
        break;
      }
      if ([192, 193, 194].includes(marker)) {
        if (size < 8) return undefined;
        info = {
          width: view.getUint16(at + 5),
          height: view.getUint16(at + 3),
          type: "image/jpeg",
          ext: "jpg",
        };
      }
      at += size;
    }
    if (!scanned) return undefined;
  } else if (
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP" &&
    view.getUint32(4, true) + 8 === bytes.length
  ) {
    const chunk = ascii(bytes, 12, 16);
    if (bytes.length < 30 || view.getUint32(16, true) + 20 > bytes.length)
      return undefined;
    let width: number;
    let height: number;
    if (chunk === "VP8X") {
      width = 1 + (view.getUint32(24, true) & 0xffffff);
      height = 1 + (view.getUint32(26, true) >>> 8);
    } else if (chunk === "VP8L" && bytes[20] === 47) {
      const bits = view.getUint32(21, true);
      width = 1 + (bits & 0x3fff);
      height = 1 + ((bits >>> 14) & 0x3fff);
    } else if (
      chunk === "VP8 " &&
      bytes[23] === 157 &&
      bytes[24] === 1 &&
      bytes[25] === 42
    ) {
      width = view.getUint16(26, true) & 0x3fff;
      height = view.getUint16(28, true) & 0x3fff;
    } else return undefined;
    let at = 12;
    let frame = false;
    while (at + 8 <= bytes.length) {
      const type = ascii(bytes, at, at + 4);
      const length = view.getUint32(at + 4, true);
      if (at + 8 + length > bytes.length) return undefined;
      if (
        (type === "VP8 " && length >= 10) ||
        (type === "VP8L" && length >= 5) ||
        (type === "ANMF" && length > 16)
      )
        frame = true;
      at += 8 + length + (length % 2);
    }
    if (!frame || at !== bytes.length) return undefined;
    info = { width, height, type: "image/webp", ext: "webp" };
  }
  return info &&
    info.width > 0 &&
    info.height > 0 &&
    info.width <= IMAGE_EDGE_LIMIT &&
    info.height <= IMAGE_EDGE_LIMIT &&
    info.width * info.height <= IMAGE_PIXEL_LIMIT
    ? info
    : undefined;
};

export const assetNameFor = async (
  bytes: Uint8Array,
  ext: ImageInfo["ext"],
): Promise<AssetName> => {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const name = parseAssetName(`${hash}.${ext}`);
  if (!name) throw new Error("The image hash is not valid.");
  return name;
};

const PNG_FORMATS: Record<
  number,
  { channels: number; depths: number[] } | undefined
> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};

const validPngPayload = async (
  bytes: Uint8Array,
  info: ImageInfo,
): Promise<boolean> => {
  const depth = bytes[24];
  const color = bytes[25];
  const format = PNG_FORMATS[color];
  if (
    !format ||
    !format.depths.includes(depth) ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    ![0, 1].includes(bytes[28])
  )
    return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [];
  let phase: "before" | "data" | "after" = "before";
  let palette = false;
  for (let at = 8; at < bytes.length;) {
    const size = view.getUint32(at);
    const type = ascii(bytes, at + 4, at + 8);
    if (type === "IDAT") {
      if (phase === "after" || (color === 3 && !palette)) return false;
      phase = "data";
      parts.push(bytes.subarray(at + 8, at + 8 + size));
    } else {
      if (phase === "data") phase = "after";
      if (type === "PLTE") {
        if (
          phase !== "before" ||
          palette ||
          ![2, 3, 6].includes(color) ||
          size === 0 ||
          size % 3 !== 0 ||
          size > 768 ||
          (color === 3 && size / 3 > 2 ** depth)
        )
          return false;
        palette = true;
      }
    }
    at += size + 12;
  }
  const layout: [number, number, number, number][] =
    bytes[28] === 0
      ? [[0, 0, 1, 1]]
      : [
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2],
        ];
  const passes = layout.flatMap(([x, y, dx, dy]) => {
    const width = Math.max(0, Math.ceil((info.width - x) / dx));
    const rows = Math.max(0, Math.ceil((info.height - y) / dy));
    return width && rows
      ? [{ length: 1 + Math.ceil((width * format.channels * depth) / 8), rows }]
      : [];
  });
  const expected = passes.reduce(
    (total, pass) => total + pass.length * pass.rows,
    0,
  );
  let part = 0;
  let offset = 0;
  const compressed = new ReadableStream<BufferSource>({
    pull(controller) {
      while (parts[part]?.length === offset) {
        part++;
        offset = 0;
      }
      const bytes = parts[part];
      if (!bytes) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.length, offset + 1024);
      controller.enqueue(new Uint8Array(bytes.subarray(offset, end)));
      offset = end;
    },
  });
  const reader = compressed
    .pipeThrough(new DecompressionStream("deflate"))
    .getReader();
  let total = 0;
  let nextFilter = 0;
  let pass = 0;
  let row = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return total === expected;
      const end = total + chunk.value.length;
      if (end > expected) return false;
      while (nextFilter < end) {
        const scan = passes[pass];
        if (!scan || chunk.value[nextFilter - total] > 4) return false;
        nextFilter += scan.length;
        if (++row === scan.rows) {
          pass++;
          row = 0;
        }
      }
      total = end;
    }
  } catch {
    return false;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

export const validateAsset = async (
  name: AssetName,
  bytes: Uint8Array,
): Promise<ImageAsset | undefined> => {
  const info = imageInfo(bytes);
  if (!info || (await assetNameFor(bytes, info.ext)) !== name) return undefined;
  if (info.ext === "png" && !(await validPngPayload(bytes, info)))
    return undefined;
  return { name, bytes, info };
};

export const imageMarkdown = (name: AssetName, alt: string) =>
  `![${alt.replace(/\s+/g, " ").replace(/[\\[\]<>]/g, "\\$&")}](${assetUrl(name)})`;
