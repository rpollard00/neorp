import { describe, expect, test } from "bun:test";
import { createSatteriMarkdownProcessor } from "@astrojs/markdown-satteri";
import { mdxToJs } from "satteri";
import {
  parseAssetName,
  scanReservedAssetUrls,
} from "../../scripts/composer/images";
import { imageFiguresPlugin } from "./image-figures-plugin";
import { linkCardsPlugin } from "./link-cards";
import {
  decodeImageFigure,
  imageFigureMarkdown,
  imageFigureView,
  parseImagePresentation,
} from "./image-figures";

const asset = parseAssetName(`${"a".repeat(64)}.png`);
if (!asset) throw new Error("Invalid fixture");
const url = `/post-assets/${asset}`;
const fields = {
  width: 1200,
  height: 720,
  size: "auto",
  frame: "pixel",
  alt: "A desk",
  caption: "Sunday light.",
};
const presentation = (changes = {}) => {
  const parsed = parseImagePresentation({ ...fields, ...changes });
  if (parsed.kind === "invalid") throw new Error(parsed.message);
  return parsed.presentation;
};
const figure = (changes = {}) =>
  imageFigureMarkdown({ asset, presentation: presentation(changes) });
const processor = await createSatteriMarkdownProcessor({
  syntaxHighlight: false,
  mdastPlugins: [imageFiguresPlugin, () => linkCardsPlugin({ cards: {} })],
});
const render = async (source: string) => (await processor.render(source)).code;
const line = figure();
const marker = line.slice(line.indexOf("<!--"));
const unfinished = marker.slice(0, -3);
const img = `![A desk](${url})`;

const textOf = (html: string, selector: string, attribute?: string) => {
  let result = "";
  new HTMLRewriter()
    .on(selector, {
      element: (element) => {
        if (attribute) result = element.getAttribute(attribute) ?? "";
      },
      text: (chunk) => {
        if (!attribute) result += chunk.text;
      },
    })
    .transform(html);
  return result;
};

const unescapeHtml = (html: string) =>
  html.replace(/&#(\d+);|&amp;|&lt;|&gt;|&quot;|&#x27;/g, (value, code) =>
    code
      ? String.fromCodePoint(Number(code))
      : ({
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&#x27;": "'",
        }[value] ?? value),
  );

describe("image presentation", () => {
  test.each([
    ["compact", 240],
    ["auto", 480],
    ["wide", 1200],
  ])("%s controls display width", (size, expected) => {
    expect(imageFigureView(presentation({ size })).imageMaxWidthPx).toBe(
      expected,
    );
  });
  test("caps tall and tiny images without rounding up", () => {
    expect(
      imageFigureView(presentation({ width: 600, height: 960 }))
        .imageMaxWidthPx,
    ).toBe(200);
    expect(
      imageFigureView(
        presentation({ width: 600, height: 960, size: "compact" }),
      ).imageMaxWidthPx,
    ).toBe(112.5);
    expect(
      imageFigureView(presentation({ width: 24, height: 14, size: "wide" }))
        .imageMaxWidthPx,
    ).toBe(24);
  });
  test.each([
    { width: 0 },
    { width: 12001 },
    { width: Infinity },
    { height: 2.5 },
    { width: 12000, height: 12000 },
    { size: "huge" },
    { frame: "border" },
    { alt: "\0" },
    { caption: "\ud800" },
    { caption: "\u0080" },
    { alt: "two\nlines" },
    { caption: 12 },
    { surprise: true },
  ])("rejects invalid presentation %j", (changes) => {
    expect(parseImagePresentation({ ...fields, ...changes }).kind).toBe(
      "invalid",
    );
  });
  test("keeps meaningful whitespace and removes blank captions", () => {
    expect(
      presentation({ alt: "  A  desk  ", caption: "  Sunday  light.  " }),
    ).toMatchObject({ alt: "  A  desk  ", caption: "  Sunday  light.  " });
    expect(presentation({ caption: "  " }).caption).toBeNull();
  });
});

describe("real Astro figure processor", () => {
  test("renders a semantic figure and separate caption", async () => {
    const html = await render(line);
    expect(html).toContain('<div class="image-stage"><figure');
    expect(html).toContain('data-frame="pixel" style="--image-cap:480px"');
    expect(html).toContain(
      '<figcaption class="image-caption">Sunday light.</figcaption>',
    );
    expect(html).not.toContain("<p>");
    expect(html).not.toContain("neorp-figure");
  });
  test("preserves literal punctuation, entities, markup and scanner-shaped fields", async () => {
    const alt =
      "\"quote\" 'apostrophe' -- --- ... [brackets] \\ &amp; <b> * _ ` ! /post-assets/nope 😀";
    const caption = '<b>"caption" -- ... &amp; /post-assets/nope</b> --> 😀';
    const source = figure({ alt, caption });
    expect(scanReservedAssetUrls(source)).toEqual({
      kind: "valid",
      names: [asset],
    });
    const html = await render(
      `Unicode 😀 before.\n\n${source}\n\n"ordinary" -- ...`,
    );
    expect(unescapeHtml(textOf(html, "img", "alt"))).toBe(alt);
    expect(unescapeHtml(textOf(html, "figcaption"))).toBe(caption);
    expect(html).not.toContain("<b>");
    expect(html).toContain("“ordinary” – …");
  });
  test("an empty caption has no caption block and bare stays bare", async () => {
    const html = await render(figure({ caption: " ", frame: "bare" }));
    expect(html).not.toContain("figcaption");
    expect(html).toContain('data-frame="bare"');
  });
  test("accepts horizontal spacing, key reordering and separate occurrences", async () => {
    const reordered = `${img} \t<!--neorp-figure:1 {"caption":"other","height":720,"width":1200,"frame":"bare","size":"compact"}-->`;
    const html = await render(`${line}\n\n${reordered}`);
    expect(html.match(/<figure /g)).toHaveLength(2);
    expect(html).toContain("Sunday light.");
    expect(html).toContain(">other</figcaption>");
    expect(html).toContain("--image-cap:240px");
    expect(scanReservedAssetUrls(`${line}\n\n${reordered}`)).toEqual({
      kind: "valid",
      names: [asset],
    });
  });
  test.each([
    ["unterminated text tail", img + marker.slice(0, -3)],
    ["unterminated emphasis", `${img} *${unfinished}*`],
    ["unterminated strong", `${img} **${unfinished}**`],
    ["unterminated link", `${img} [${unfinished}](https://example.com)`],
    [
      "unterminated strong in link",
      `${img} [**${unfinished}**](https://example.com)`,
    ],
    [
      "unterminated linked image",
      `[${img} *${unfinished}*](https://example.com)`,
    ],
    ["unterminated heading", `## ${img}${unfinished}`],
    ["unterminated heading emphasis", `## ${img} *${unfinished}*`],
    ["unterminated setext heading", `${img}${unfinished}\n===`],
    ["heading", `## ${line}`],
    ["emphasized marker", `${img} *${marker}*`],
    ["even backslashes in emphasis", `${img} *\\\\${unfinished}*`],
    ["unterminated JSON", img + "<!--neorp-figure:1 {"],
    ["unknown version", line.replace("figure:1", "figure:2")],
    ["invalid JSON", img + "<!--neorp-figure:1 nope-->"],
    ["invalid dimensions", line.replace('"width":1200', '"width":0')],
    ["extra metadata", line.replace('"caption":', '"alt":"extra","caption":')],
    ["orphan", marker],
    ["incomplete orphan", marker.slice(0, -3)],
    ["line break", img + "\n" + marker],
    ["blank separator", img + "\n\n" + marker],
    ["duplicate", line + marker],
    ["prose before", "Text " + line],
    ["prose after", line + " after"],
    ["list", "- " + line],
    ["quote", "> " + line],
    ["linked image", `[${img}](https://example.com)` + marker],
    ["image title", `![a](${url} "title")` + marker],
    ["reference image", `![a][ref]${marker}\n\n[ref]: ${url}`],
    ["two images", img + line],
    ["external URL", line.replace(url, "https://example.com/a.png")],
    ["query suffix", line.replace(url, url + "?x")],
    ["block HTML", `<div>\n${marker}\n</div>`],
  ])("fails %s with location and repair guidance", async (_, source) => {
    await expect(render(source)).rejects.toThrow(
      /Image figure at Markdown:\d+:\d+:.*Repair the marker/,
    );
  });
  test.each([
    ["escaped tail", `${img} \\${unfinished}`],
    ["escaped emphasis", `${img} *\\${unfinished}*`],
    ["escaped strong", `${img} **\\${unfinished}**`],
    ["escaped link", `${img} [\\${unfinished}](https://example.com)`],
    ["escaped heading", `## ${img} *\\${unfinished}*`],
    ["escaped complete marker", `${img} *\\${marker}*`],
    ["odd backslashes in emphasis", `${img} *\\\\\\${unfinished}*`],
    ["code in emphasis", `${img} *\`${unfinished}\`*`],
    ["code in link", `${img} [\`${unfinished}\`](https://example.com)`],
    ["code in heading", `## ${img} **\`${unfinished}\`**`],
    ["fenced code", `${img}\n\n\`\`\`md\n${img} *${unfinished}*\n\`\`\``],
    ["indented code", `${img}\n\n    ${img} *${unfinished}*`],
    ["separate prose block", `${img}\n\nText *${unfinished}*`],
  ])("does not claim %s", async (_, source) => {
    const html = await render(source);
    expect(html).toContain("<img ");
    expect(html).not.toContain("<figure");
  });
  test("does not claim code or ordinary text/image syntax", async () => {
    const source = `\`\`\`md\n${line}\n\`\`\`\n\n\`${line}\`\n\n${img} \`${marker.slice(0, -3)}\`\n\n![external](https://example.com/photo.jpg "title")\n\n![reference][ref]\n\n[ref]: ${url}\n\n${img}\n\nhttps://example.com/article`;
    const html = await render(source);
    expect(html).not.toContain("<figure");
    expect(html).toContain("<pre>");
    expect(html).toContain("<code>");
    expect(html).toContain('class="link-card"');
    expect(html).toContain('title="title"');
  });
  test("leaves legacy MDX images and components in the MDX path", async () => {
    const source = `![old](${url})\n\n<Component answer={42} />`;
    const ordinary = mdxToJs(source);
    expect(mdxToJs(source, { mdastPlugins: [imageFiguresPlugin] })).toEqual(
      ordinary,
    );
  });
});

test("decoder leaves unrelated comments ordinary", () => {
  expect(decodeImageFigure({ url, alt: "", marker: "<!--hello-->" })).toEqual({
    kind: "ordinary",
  });
});
