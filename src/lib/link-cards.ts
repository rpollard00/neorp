export type LinkCard = {
  site: string;
  title: string;
  description?: string;
};

export type LinkCards = Record<string, LinkCard>;

export const LINK_CARDS_PATH = "src/data/link-cards.json";

const AUTOLINK_LINE = /^ {0,3}<(https?:\/\/[^\s<>]+)>[ \t]*$/i;
const BARE_LINE = /^(https?:\/\/\S+)[ \t]*$/i;
/** Only what GFM links whole: no `_` in the host, no `[]{}|^"`, and no backslash. */
const BARE_URL =
  /^https?:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d+)?(?:[/?#][\w\-.~/?#@!$&'()*+,;=%:]*)?$/i;
/** GFM leaves these off the end of a bare URL, so the line is not a lone link. */
const TRAILING_PUNCTUATION = /[?!.,:*_~'";]$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const FRONTMATTER_FENCE = /^---[ \t]*$/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const THEMATIC_BREAK =
  /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
/** Under a paragraph line, this makes the line a heading. */
const SETEXT_UNDERLINE = /^ {0,3}(?:-+|=+)[ \t]*$/;

type Fence = { mark: string; length: number };

const openFence = (line: string): Fence | undefined => {
  const [, run = "", info = ""] = FENCE_OPEN.exec(line) ?? [];
  if (!run || (run.startsWith("`") && info.includes("`"))) return undefined;
  return { mark: run.charAt(0), length: run.length };
};

const closesFence = ({ line, fence }: { line: string; fence: Fence }) => {
  const run = FENCE_CLOSE.exec(line)?.[1];
  return run?.charAt(0) === fence.mark && run.length >= fence.length;
};

const isBlank = (line: string | undefined) =>
  line === undefined || line.trim() === "";

const unbalancedParen = (url: string) =>
  url.endsWith(")") && url.split("(").length < url.split(")").length;

const isWebUrl = (url: string) =>
  URL.canParse(url) && /^https?:$/.test(new URL(url).protocol);

/** `<url>` always links the whole URL; a bare URL is linked whole only when it is plain. */
const isCardUrl = ({ url, bare }: { url: string; bare: boolean }) =>
  isWebUrl(url) &&
  (!bare ||
    (BARE_URL.test(url) &&
      !TRAILING_PUNCTUATION.test(url) &&
      !unbalancedParen(url)));

const cardUrlOfLine = (line: string) => {
  const autolink = AUTOLINK_LINE.exec(line)?.[1];
  if (autolink !== undefined) {
    return isCardUrl({ url: autolink, bare: false }) ? autolink : undefined;
  }
  // An indented bare URL can be the next paragraph of a list item.
  const bare = BARE_LINE.exec(line)?.[1];
  return bare !== undefined && isCardUrl({ url: bare, bare: true })
    ? bare
    : undefined;
};

const endsParagraph = (line: string) =>
  isBlank(line) || ATX_HEADING.test(line) || THEMATIC_BREAK.test(line);

const startsBlock = (line: string | undefined) =>
  line === undefined ||
  isBlank(line) ||
  ATX_HEADING.test(line) ||
  openFence(line) !== undefined ||
  (THEMATIC_BREAK.test(line) && !SETEXT_UNDERLINE.test(line));

const bodyStart = (lines: readonly string[]) => {
  if (!FRONTMATTER_FENCE.test(lines[0]?.replace(/^\uFEFF/, "") ?? "")) return 0;
  const close = lines.findIndex(
    (line, index) => index > 0 && FRONTMATTER_FENCE.test(line),
  );
  return close === -1 ? 0 : close + 1;
};

/** The URL of each line that shows as a card, by line index, in markdown with no frontmatter. */
export const cardLines = (lines: readonly string[]): Map<number, string> => {
  const found = new Map<number, string>();
  let fence: Fence | undefined;
  let afterBoundary = true;
  for (const [index, line] of lines.entries()) {
    if (fence) {
      if (closesFence({ line, fence })) {
        fence = undefined;
        afterBoundary = true;
      }
      continue;
    }
    fence = openFence(line);
    if (fence) continue;
    const url = cardUrlOfLine(line);
    if (url && afterBoundary && startsBlock(lines[index + 1])) {
      found.set(index, url);
    }
    afterBoundary = endsParagraph(line);
  }
  return found;
};

export const cardUrls = (markdown: string): string[] => {
  const lines = markdown.split(/\r\n?|\n/);
  return [...new Set(cardLines(lines.slice(bodyStart(lines))).values())];
};

export const fallbackCard = (url: string): LinkCard => ({
  site: new URL(url).hostname.replace(/^www\./, ""),
  title: url.replace(/^https?:\/\//i, "").replace(/\/$/, ""),
});

const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export const linkCardHtml = ({ url, card }: { url: string; card: LinkCard }) =>
  [
    `<a class="link-card" href="${escapeHtml(url)}"><span class="link-card-body">`,
    `<span class="link-card-site">${escapeHtml(card.site)}</span>`,
    `<span class="link-card-title">${escapeHtml(card.title)}</span>`,
    card.description
      ? `<span class="link-card-description">${escapeHtml(card.description)}</span>`
      : "",
    "</span></a>",
  ].join("");

type Position = { start: { offset?: number; column: number } };

export type MdastNode = {
  type: string;
  url?: string;
  value?: string;
  position?: Position;
  children?: readonly MdastNode[];
};

/**
 * GFM autolink literals and `<https://...>` both parse to a link whose text is its URL.
 * In `<url>` the text starts one character after the link.
 */
export const loneUrl = (paragraph: MdastNode): string | undefined => {
  const [link, ...rest] = paragraph.children ?? [];
  if (link?.type !== "link" || rest.length > 0 || !link.url) return undefined;
  const [text, ...more] = link.children ?? [];
  if (text?.type !== "text" || more.length > 0 || text.value !== link.url) {
    return undefined;
  }
  const linkStart = link.position?.start;
  const textStart = text.position?.start.offset;
  if (linkStart?.offset === undefined || textStart === undefined) {
    return undefined;
  }
  const bare = textStart === linkStart.offset;
  if (bare && linkStart.column !== 1) return undefined;
  return isCardUrl({ url: link.url, bare }) ? link.url : undefined;
};

type PluginContext = {
  sourceFormat: string;
  parent: (node: MdastNode) => { type: string } | undefined;
};

/** MDX is left alone: it cannot hold a raw `html` node. */
export const linkCardsPlugin = ({ cards }: { cards: LinkCards }) => ({
  name: "link-cards",
  options: { position: true },
  paragraph(node: MdastNode, context: PluginContext) {
    if (context.sourceFormat !== "markdown") return undefined;
    if (context.parent(node)?.type !== "root") return undefined;
    const url = loneUrl(node);
    if (!url) return undefined;
    return {
      type: "html" as const,
      value: linkCardHtml({ url, card: cards[url] ?? fallbackCard(url) }),
    };
  },
});
