import {
  assetNameFor,
  scanReservedAssetUrls,
  DEFAULT_IMAGE_EDGE,
  IMAGE_BYTE_LIMIT,
  imageInfo,
  validateAsset,
  type AssetName,
  type ImageAsset,
} from "../images";

export type AssetBlobs = {
  get: (name: AssetName) => Promise<unknown>;
  put: (name: AssetName, blob: Blob) => Promise<void>;
};
export type ImageSyncResult =
  | { kind: "saved" }
  | {
      kind: "failed";
      reason: "denied" | "unreachable" | "server-error";
      message: string;
    };
export type ImageSync = {
  pending: (text: string) => boolean;
  sync: (text: string) => Promise<ImageSyncResult>;
};
export type PastedImage = {
  blob: Blob;
  url: string;
  width: number;
  height: number;
  defaultWidth: number;
  release: () => void;
};

export const createAssetBlobs = (): AssetBlobs => {
  let opening: Promise<IDBDatabase> | undefined;
  const open = () =>
    (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("composer-images", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("blobs");
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          opening = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => {
        opening = undefined;
        reject(request.error ?? new Error("Image storage could not open."));
      };
      request.onblocked = () => {
        opening = undefined;
        reject(new Error("Close the other composer tabs, then try again."));
      };
    }));
  return {
    get: async (name) => {
      const db = await open();
      return new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction("blobs", "readonly");
        const request = tx.objectStore("blobs").get(name);
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () =>
          reject(tx.error ?? new Error("The saved image could not be read."));
      });
    },
    put: async (name, blob) => {
      const db = await open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("blobs", "readwrite");
        tx.objectStore("blobs").put(blob, name);
        tx.oncomplete = () => resolve();
        tx.onabort = () =>
          reject(
            tx.error ??
              new Error("The image could not be saved on this phone."),
          );
      });
    },
  };
};

export const createImageLibrary = ({
  fetch: request,
  blobs = createAssetBlobs(),
}: {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  blobs?: AssetBlobs;
}) => {
  const uploaded = new Set<AssetName>();
  const save = async (bytes: Uint8Array): Promise<ImageAsset> => {
    const info = imageInfo(bytes);
    if (!info)
      throw new Error(
        "The image format, size, or dimensions are not supported.",
      );
    const name = await assetNameFor(bytes, info.ext);
    await blobs.put(
      name,
      new Blob([new Uint8Array(bytes)], { type: info.type }),
    );
    return { name, bytes, info };
  };
  const pending: ImageSync["pending"] = (text) => {
    const references = scanReservedAssetUrls(text);
    return (
      references.kind === "invalid" ||
      references.names.some((name) => !uploaded.has(name))
    );
  };
  const sync: ImageSync["sync"] = async (text) => {
    const references = scanReservedAssetUrls(text);
    if (references.kind === "invalid")
      return {
        kind: "failed",
        reason: "server-error",
        message: references.message,
      };
    for (const name of references.names) {
      if (uploaded.has(name)) continue;
      try {
        const stored = await blobs.get(name);
        let asset =
          stored instanceof Blob
            ? await validateAsset(
                name,
                new Uint8Array(await stored.arrayBuffer()),
              )
            : undefined;
        if (!asset) {
          const response = await request(`/api/assets/${name}`, {
            method: "GET",
            signal: AbortSignal.timeout(20_000),
          });
          if (response.status === 401)
            return {
              kind: "failed",
              reason: "denied",
              message: "Pair this app to save the image.",
            };
          if (!response.ok)
            return {
              kind: "failed",
              reason: "server-error",
              message:
                "The image is missing from this phone and the server. Paste it again.",
            };
          asset = await validateAsset(
            name,
            new Uint8Array(await response.arrayBuffer()),
          );
          if (!asset)
            return {
              kind: "failed",
              reason: "server-error",
              message: "The saved image is not valid. Paste it again.",
            };
          await blobs.put(
            name,
            new Blob([new Uint8Array(asset.bytes)], { type: asset.info.type }),
          );
        }
        const response = await request(`/api/assets/${name}`, {
          method: "PUT",
          body: new Uint8Array(asset.bytes),
          signal: AbortSignal.timeout(20_000),
        });
        if (response.status === 401)
          return {
            kind: "failed",
            reason: "denied",
            message: "Pair this app to save the image.",
          };
        if (!response.ok)
          return {
            kind: "failed",
            reason: "server-error",
            message: `The image upload failed (${response.status}). Try again.`,
          };
        uploaded.add(name);
      } catch (error) {
        return {
          kind: "failed",
          reason: error instanceof TypeError ? "unreachable" : "server-error",
          message:
            error instanceof Error
              ? error.message
              : "The image could not be saved.",
        };
      }
    }
    return { kind: "saved" };
  };
  return { save, sync, pending };
};

export const resizedDimensions = (
  source: { width: number; height: number },
  width: number,
) => {
  if (!Number.isInteger(width) || width < 1 || width > source.width)
    throw new Error(`Enter a width from 1 to ${source.width} px.`);
  return {
    width,
    height: Math.max(1, Math.round((source.height * width) / source.width)),
  };
};

export const decodePastedImage = async (blob: Blob): Promise<PastedImage> => {
  if (blob.size > IMAGE_BYTE_LIMIT)
    throw new Error("The image is larger than 10 MiB. Copy a smaller image.");
  const info = imageInfo(new Uint8Array(await blob.arrayBuffer()));
  if (!info)
    throw new Error(
      "Use a PNG, JPEG, or WebP image, up to 10 MiB and 40 million pixels.",
    );
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    const { naturalWidth: width, naturalHeight: height } = image;
    if (!width || !height) throw new Error("The image has no pixels.");
    const defaultWidth = Math.max(
      1,
      Math.round(
        width * Math.min(1, DEFAULT_IMAGE_EDGE / Math.max(width, height)),
      ),
    );
    return {
      blob,
      url,
      width,
      height,
      defaultWidth,
      release: () => URL.revokeObjectURL(url),
    };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("The image could not be opened. Copy it again.");
  }
};

export const encodePastedImage = async (
  source: PastedImage,
  width: number,
): Promise<Uint8Array> => {
  const size = resizedDimensions(source, width);
  const image = new Image();
  image.src = source.url;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot resize the image.");
  context.drawImage(image, 0, 0, size.width, size.height);
  const type = source.blob.type === "image/jpeg" ? "image/jpeg" : "image/png";
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) =>
        value
          ? resolve(value)
          : reject(new Error("The image could not be resized.")),
      type,
      0.9,
    ),
  );
  if (blob.size > IMAGE_BYTE_LIMIT)
    throw new Error(
      "The resized image is larger than 10 MiB. Choose a smaller width.",
    );
  return new Uint8Array(await blob.arrayBuffer());
};
