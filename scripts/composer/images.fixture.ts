import { crc32 } from "node:zlib";

const pngChunk = (type: string, data: Uint8Array) => {
  const chunk = new Uint8Array(data.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(chunk.length - 4, crc32(chunk.subarray(4, -4)));
  return chunk;
};

export const pngWithIdat = ({
  width = 1,
  height = 1,
  depth = 8,
  color = 6,
  interlace = 0,
  idat,
  palette,
}: {
  width?: number;
  height?: number;
  depth?: number;
  color?: number;
  interlace?: number;
  idat: Uint8Array[];
  palette?: Uint8Array;
}) => {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([depth, color, 0, 0, interlace], 8);
  return new Uint8Array(
    Buffer.concat([
      PNG_BYTES.subarray(0, 8),
      pngChunk("IHDR", header),
      ...(palette ? [pngChunk("PLTE", palette)] : []),
      ...idat.map((part) => pngChunk("IDAT", part)),
      pngChunk("IEND", new Uint8Array()),
    ]),
  );
};

export const PNG_BYTES = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z9DwHwAGAAJ/IQJzOwAAAABJRU5ErkJggg==",
    "base64",
  ),
);
export const JPEG_BYTES = new Uint8Array(
  Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==",
    "base64",
  ),
);
export const WEBP_BYTES = new Uint8Array(
  Buffer.from(
    "UklGRjgAAABXRUJQVlA4ICwAAACQAQCdASoDAAIAAgA0JaACdLoAA5gA/vmTb/+QH/+QH/+QH/8gP+IXeyAwAA==",
    "base64",
  ),
);
