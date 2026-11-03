import type {
  MdastPluginDefinition,
  MdastNode,
  MdastVisitorContext,
} from "satteri";
import {
  FIGURE_PREFIX,
  decodeImageFigure,
  imageFigureHtml,
} from "./image-figures";

const repair = (
  node: Readonly<MdastNode>,
  context: MdastVisitorContext,
  message: string,
): never => {
  const at = node.position?.start;
  const file =
    context.fileURL?.pathname.split("/src/content/").at(-1) ?? "Markdown";
  throw new Error(
    `[ImageFigureError] Image figure at ${file}:${at?.line ?? 1}:${at?.column ?? 1}: ${message} Repair the marker beside its image on one line, or remove the marker for an ordinary image.`,
  );
};

const sourceOf = (node: Readonly<MdastNode>, context: MdastVisitorContext) => {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined)
    return repair(node, context, "The image source location is unavailable.");
  return context.source.slice(start, end);
};

const hasImage = (node: Readonly<MdastNode>): boolean =>
  node.type === "image" ||
  node.type === "imageReference" ||
  ("children" in node && (node.children ?? []).some(hasImage));

export const imageFiguresPlugin = (): MdastPluginDefinition => ({
  name: "image-figures",
  options: { position: true },
  before(root, context) {
    if (context.sourceFormat !== "markdown") return;
    const walk = (node: Readonly<MdastNode>) => {
      if (node.type === "paragraph" || node.type === "heading") {
        // Unterminated comments become text. Inspect text-node source spans
        // because smart punctuation can alter the parsed marker prefix.
        const imageContainer = hasImage(node);
        const claimsMarker = (child: Readonly<MdastNode>): boolean =>
          (child.type === "html" && child.value.includes(FIGURE_PREFIX)) ||
          (child.type === "text" &&
            imageContainer &&
            sourceOf(child, context).match(
              /(?:^|[^\\])(?:\\\\)*<!--neorp-figure:/,
            ) !== null) ||
          ("children" in child && (child.children ?? []).some(claimsMarker));
        if (node.children.some(claimsMarker)) {
          const children = node.children.filter(
            (child) => child.type !== "text" || !/^[ \t]*$/.test(child.value),
          );
          const [image, marker] = children;
          if (
            node.type !== "paragraph" ||
            context.parent(node)?.type !== "root" ||
            children.length !== 2 ||
            image?.type !== "image" ||
            image.title != null ||
            marker?.type !== "html"
          )
            return repair(
              node,
              context,
              "Use one image followed by one image marker in its own paragraph.",
            );
          const imageEnd = image.position?.end.offset;
          const markerStart = marker.position?.start.offset;
          if (
            imageEnd === undefined ||
            markerStart === undefined ||
            image.position?.start.line !== marker.position?.end.line ||
            !/^[ \t]*$/.test(context.source.slice(imageEnd, markerStart))
          )
            return repair(
              node,
              context,
              "Keep the image and its marker on one line, separated only by spaces or tabs.",
            );
          const decoded = decodeImageFigure({
            url: image.url,
            alt: image.alt ?? "",
            marker: marker.value,
          });
          if (decoded.kind !== "figure")
            return repair(
              marker,
              context,
              decoded.kind === "invalid"
                ? decoded.message
                : "The image marker is misplaced.",
            );
          context.replaceNode(node, {
            type: "html",
            value: imageFigureHtml(decoded.figure),
          });
          return;
        }
      }
      if (node.type === "html" && node.value.includes(FIGURE_PREFIX))
        repair(node, context, "The image marker is misplaced or incomplete.");
      if ("children" in node) node.children?.forEach(walk);
    };
    walk(root);
  },
});
