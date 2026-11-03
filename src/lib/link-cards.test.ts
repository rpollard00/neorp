import { describe, expect, test } from "bun:test";
import { markdownToHtml } from "satteri";
import {
  cardUrls,
  fallbackCard,
  linkCardHtml,
  linkCardsPlugin,
  loneUrl,
  type MdastNode,
} from "./link-cards";

const A = "https://example.com/a";

const CASES: [string, string, string[]][] = [
  ["a lone URL", `Intro.\n\n${A}\n\nOutro.`, [A]],
  ["a lone URL with trailing space", `${A}  \n`, [A]],
  ["an indented URL", `   ${A}\n`, []],
  ["an angle-bracket autolink", `<${A}>\n`, [A]],
  ["an indented angle-bracket autolink", `   <${A}>\n`, [A]],
  ["an autolink with a bad host", "<https://[oops>\n", []],
  ["an autolink with no host", "<https:///>\n", []],
  ["an autolink with a bad port", "<https://example.com:99999/>\n", []],
  [
    "an autolink with an underscore host",
    "<https://my_site.com>\n",
    ["https://my_site.com"],
  ],
  ["an autolink with brackets", `<${A}[1]>\n`, [`${A}[1]`]],
  ["a heading above", `# H\n${A}\n`, [A]],
  ["a heading below", `${A}\n## H\n`, [A]],
  ["a closing fence above", `\`\`\`\ncode\n\`\`\`\n${A}\n`, [A]],
  ["an opening fence below", `${A}\n~~~\ncode\n~~~\n`, [A]],
  ["a star rule above", `***\n${A}\n`, [A]],
  ["a dash rule above", `Text\n\n---\n${A}\n`, [A]],
  ["a star rule below", `${A}\n***\n`, [A]],
  ["a setext underline below", `${A}\n---\n`, []],
  ["a setext heading above", `Title\n---\n${A}\n`, [A]],
  ["an underscore in the host", "https://my_site.com\n", []],
  ["an underscore in a subdomain", "https://a.my_site.com/x\n", []],
  ["an underscore in the path", `${A}_b\n`, [`${A}_b`]],
  ["brackets in the path", `${A}[1]\n`, []],
  ["a closing bracket", `${A}]\n`, []],
  ["a trailing double quote", `${A}"\n`, []],
  ["a trailing single quote", `${A}'\n`, []],
  ["a trailing semicolon", `${A};\n`, []],
  ["a trailing entity", `${A}?a&b;\n`, []],
  ["a trailing &amp;", `${A}?a&amp;\n`, []],
  ["a query with &", `${A}?a=1&b=2\n`, [`${A}?a=1&b=2`]],
  ["a bad port", "https://example.com:99999/\n", []],
  ["a braces path", `${A}{b}\n`, []],
  ["a list item continuation", `- item\n\n  ${A}\n`, []],
  ["an ordered list continuation", `1. item\n\n   ${A}\n`, []],
  ["text before on the line", `See ${A}\n`, []],
  ["text after on the line", `${A} is good.\n`, []],
  ["text on the line above", `See this:\n${A}\n`, []],
  ["text on the line below", `${A}\nis good.\n`, []],
  ["a list item", `- ${A}\n`, []],
  ["a blockquote", `> ${A}\n`, []],
  ["a backtick fence", `\`\`\`\n\n${A}\n\n\`\`\`\n`, []],
  ["a tilde fence", `~~~~\n\n${A}\n\n~~~\n\n~~~~\n`, []],
  ["a link with text", `[a page](${A})\n`, []],
  ["a mailto URL", "mailto:me@example.com\n", []],
  ["an ftp URL", "ftp://example.com/a\n", []],
  ["a www link with no scheme", "www.example.com\n", []],
  ["a URL that ends in a full stop", `${A}.\n`, []],
  ["a URL in balanced parentheses", `${A}_(b)\n`, [`${A}_(b)`]],
  ["a URL with an unbalanced parenthesis", `${A})\n`, []],
  ["an indented code block", `    ${A}\n`, []],
  ["the same URL twice", `${A}\n\n${A}\n`, [A]],
  [
    "two URLs, in order",
    `https://example.com/z\n\n${A}\n`,
    ["https://example.com/z", A],
  ],
  [
    "frontmatter",
    `---\ntitle: t\n\n${A}\n\n---\n\nhttps://example.com/b\n`,
    ["https://example.com/b"],
  ],
];

const renderedCards = (markdown: string) => {
  const { html } = markdownToHtml(markdown, {
    mdastPlugins: [linkCardsPlugin({ cards: {} })],
    features: { gfm: true, frontmatter: true },
  });
  return [
    ...new Set(
      [...html.matchAll(/<a class="link-card" href="([^"]+)"/g)].map(
        ([, url = ""]) => url.replaceAll("&amp;", "&"),
      ),
    ),
  ];
};

describe("cardUrls", () => {
  test.each(CASES)("%s", (_, markdown, expected) => {
    expect(cardUrls(markdown)).toEqual(expected);
  });
});

describe("linkCardsPlugin", () => {
  test.each(CASES)("agrees with cardUrls on %s", (_, markdown, expected) => {
    expect(renderedCards(markdown)).toEqual(expected);
  });

  test("renders a stored card in place of the paragraph", () => {
    const { html } = markdownToHtml(`Intro.\n\n${A}\n`, {
      mdastPlugins: [
        linkCardsPlugin({ cards: { [A]: { site: "Example", title: "A" } } }),
      ],
    });
    expect(html).toBe(
      `<p>Intro.</p>\n<a class="link-card" href="${A}"><span class="link-card-body"><span class="link-card-site">Example</span><span class="link-card-title">A</span></span></a>\n`,
    );
  });
});

describe("loneUrl", () => {
  const paragraph = (...children: MdastNode[]): MdastNode => ({
    type: "paragraph",
    children,
  });
  const at = (start: { offset: number; column: number }) => ({ start });
  const link = (url: string, text = url): MdastNode => ({
    type: "link",
    url,
    position: at({ offset: 0, column: 1 }),
    children: [
      { type: "text", value: text, position: at({ offset: 0, column: 1 }) },
    ],
  });
  const autolink = ({ url, column }: { url: string; column: number }) => ({
    type: "link",
    url,
    position: at({ offset: column - 1, column }),
    children: [
      {
        type: "text",
        value: url,
        position: at({ offset: column, column: column + 1 }),
      },
    ],
  });

  test("reads a bare URL that is the whole paragraph", () => {
    expect(loneUrl(paragraph(link(A)))).toBe(A);
  });

  test("reads an indented autolink", () => {
    expect(loneUrl(paragraph(autolink({ url: A, column: 3 })))).toBe(A);
  });

  test.each([
    ["link text that is not the URL", paragraph(link(A, "a page"))],
    [
      "text beside the link",
      paragraph({ type: "text", value: "See " }, link(A)),
    ],
    ["a mailto link", paragraph(link("mailto:me@example.com"))],
    ["no children", paragraph()],
    [
      "an autolink that is not a URL",
      paragraph(autolink({ url: "https://[oops", column: 1 })),
    ],
    [
      "an indented bare URL",
      paragraph({
        ...link(A),
        position: at({ offset: 2, column: 3 }),
        children: [
          { type: "text", value: A, position: at({ offset: 2, column: 3 }) },
        ],
      }),
    ],
    ["a link with no position", paragraph({ ...link(A), position: undefined })],
    [
      "emphasis in the link",
      paragraph({
        type: "link",
        url: A,
        children: [
          { type: "emphasis", children: [{ type: "text", value: A }] },
        ],
      }),
    ],
  ])("refuses %s", (_, node) => {
    expect(loneUrl(node)).toBeUndefined();
  });
});

describe("linkCardHtml", () => {
  test("escapes text and the URL", () => {
    expect(
      linkCardHtml({
        url: 'https://example.com/?a=1&b="2"',
        card: { site: "A & B", title: "<b>Hi</b>", description: "1 < 2" },
      }),
    ).toBe(
      '<a class="link-card" href="https://example.com/?a=1&amp;b=&quot;2&quot;"><span class="link-card-body"><span class="link-card-site">A &amp; B</span><span class="link-card-title">&lt;b&gt;Hi&lt;/b&gt;</span><span class="link-card-description">1 &lt; 2</span></span></a>',
    );
  });
});

describe("fallbackCard", () => {
  test.each([
    [
      "https://www.example.com/",
      { site: "example.com", title: "www.example.com" },
    ],
    [
      "http://blog.example.com/posts/1/",
      { site: "blog.example.com", title: "blog.example.com/posts/1" },
    ],
    [
      "https://example.com/a?b=c",
      { site: "example.com", title: "example.com/a?b=c" },
    ],
  ])("%s", (url, expected) => {
    expect(fallbackCard(url)).toEqual(expected);
  });
});
