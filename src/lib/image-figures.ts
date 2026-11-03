import {
  ASSET_PREFIX,
  IMAGE_EDGE_LIMIT,
  IMAGE_PIXEL_LIMIT,
  assetUrl,
  parseAssetName,
  type AssetName,
} from "../../scripts/composer/images";

declare const presentationBrand: unique symbol;
export type ImagePresentation = Readonly<{
  width: number;
  height: number;
  size: "compact" | "auto" | "wide";
  frame: "pixel" | "bare";
  alt: string;
  caption: string | null;
  [presentationBrand]: true;
}>;
export type ImageFigure = Readonly<{
  asset: AssetName;
  presentation: ImagePresentation;
}>;
type Invalid = { kind: "invalid"; message: string };
export type FigureDecode =
  { kind: "ordinary" } | { kind: "figure"; figure: ImageFigure } | Invalid;

export const FIGURE_PREFIX = "<!--neorp-figure:";
const FIELDS = ["width", "height", "size", "frame", "alt", "caption"];
const plainText = (value: unknown): value is string =>
  typeof value === "string" &&
  !/[\x00-\x1f\x7f-\x9f\ud800-\udfff]/u.test(value);

export const parseImagePresentation = (
  input: unknown,
): { kind: "valid"; presentation: ImagePresentation } | Invalid => {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { kind: "invalid", message: "The image presentation is not valid." };
  if (
    Object.keys(input).length !== FIELDS.length ||
    Object.keys(input).some((key) => !FIELDS.includes(key)) ||
    !(
      "width" in input &&
      "height" in input &&
      "size" in input &&
      "frame" in input &&
      "alt" in input &&
      "caption" in input
    )
  )
    return {
      kind: "invalid",
      message: "The image presentation fields are not valid.",
    };
  const { width, height, size, frame, alt, caption } = input;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > IMAGE_EDGE_LIMIT ||
    height > IMAGE_EDGE_LIMIT ||
    width * height > IMAGE_PIXEL_LIMIT
  )
    return { kind: "invalid", message: "The image dimensions are not valid." };
  if (size !== "compact" && size !== "auto" && size !== "wide")
    return { kind: "invalid", message: "Choose Compact, Auto, or Wide." };
  if (frame !== "pixel" && frame !== "bare")
    return { kind: "invalid", message: "The image frame is not valid." };
  if (!plainText(alt) || (caption !== null && !plainText(caption)))
    return {
      kind: "invalid",
      message:
        "Alt text and caption must be plain text on one line, without control characters.",
    };
  const presentation = {
    width,
    height,
    size,
    frame,
    alt,
    caption: caption === null || caption.trim() === "" ? null : caption,
  } as ImagePresentation;
  return { kind: "valid", presentation };
};

export const decodeImageFigure = ({
  url,
  alt,
  marker,
}: {
  url: string;
  alt: string;
  marker: string;
}): FigureDecode => {
  if (!marker.startsWith(FIGURE_PREFIX)) return { kind: "ordinary" };
  const match = /^<!--neorp-figure:(\d+) ([^\r\n]*)-->$/.exec(marker);
  if (!match || match[1] !== "1")
    return {
      kind: "invalid",
      message: "Use a complete version 1 image marker.",
    };
  let metadata: unknown;
  try {
    metadata = JSON.parse(match[2] ?? "");
  } catch {
    return {
      kind: "invalid",
      message: "The image marker contains invalid JSON.",
    };
  }
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    "alt" in metadata
  )
    return {
      kind: "invalid",
      message: "The image marker fields are not valid.",
    };
  const parsed = parseImagePresentation({ ...metadata, alt });
  if (parsed.kind === "invalid") return parsed;
  const asset = url.startsWith(ASSET_PREFIX)
    ? parseAssetName(url.slice(ASSET_PREFIX.length))
    : undefined;
  if (!asset)
    return {
      kind: "invalid",
      message: "The figure needs a valid /post-assets/ image URL.",
    };
  return {
    kind: "figure",
    figure: { asset, presentation: parsed.presentation },
  };
};

const escapeAlt = (text: string) =>
  text.replace(/[!-/:-@\[-`{-~]/g, (char) => `&#${char.charCodeAt(0)};`);
const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export const imageFigureMarkdown = ({
  asset,
  presentation,
}: ImageFigure): string => {
  const { size, frame, width, height, caption, alt } = presentation;
  const metadata = JSON.stringify({
    size,
    frame,
    width,
    height,
    caption: caption ?? "",
  }).replace(
    /[<>&/\-]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `![${escapeAlt(alt)}](${assetUrl(asset)})${FIGURE_PREFIX}1 ${metadata}-->`;
};

export const imageFigureView = (presentation: ImagePresentation) => {
  const { width, height, size } = presentation;
  const imageMaxWidthPx =
    size === "compact"
      ? Math.min(width, 240, (180 * width) / height)
      : size === "auto"
        ? Math.min(width, 480, (320 * width) / height)
        : width;
  return { ...presentation, imageMaxWidthPx };
};

export const imageFigureHtml = ({
  asset,
  presentation,
}: ImageFigure): string => {
  const view = imageFigureView(presentation);
  return `<div class="image-stage"><figure class="image-figure" data-frame="${view.frame}" style="--image-cap:${view.imageMaxWidthPx}px"><img src="${assetUrl(asset)}" width="${view.width}" height="${view.height}" alt="${escapeHtml(view.alt)}">${view.caption === null ? "" : `<figcaption class="image-caption">${escapeHtml(view.caption)}</figcaption>`}</figure></div>`;
};
