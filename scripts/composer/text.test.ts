import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import {
  newPostFile,
  normalizeBody,
  readTags,
  isRuleLine,
  revisedPostFile,
} from "./text";

const DAY = "2026-10-31";

const post = (text: string, tags: string[] = [], taken: string[] = []) => {
  const file = newPostFile({ text, tags, day: DAY, taken });
  if (!file) throw new Error("expected a post file");
  return file;
};

const frontmatterOf = (source: string): Record<string, unknown> =>
  parse(/^---\n([\s\S]*?)\n---\n/.exec(source)?.[1] ?? "");

describe("isRuleLine", () => {
  test.each([
    "--",
    "---",
    "------",
    "–-",
    "——",
    "—",
    "- - -",
    "***",
    "* * *",
    "___",
    "_ _ _",
    "   ---",
    "--- ",
  ])("%p is a rule", (line) => {
    expect(isRuleLine(line)).toBe(true);
  });

  test.each([
    "",
    "-",
    "–",
    "**",
    "__",
    "--text",
    "- item",
    "*-*",
    "-_-",
    "    ---",
    "# ---",
  ])("%p is not a rule", (line) => {
    expect(isRuleLine(line)).toBe(false);
  });
});

describe("normalizeBody", () => {
  test("puts a blank line before a rule that sits under text", () => {
    expect(normalizeBody("one\n---\ntwo")).toBe("one\n\n---\ntwo\n");
  });

  test("keeps a rule that already has a blank line above it", () => {
    expect(normalizeBody("one\n\n---\n\ntwo")).toBe("one\n\n---\n\ntwo\n");
  });

  test.each(["—", "——", "–-", "--", "—-"])(
    "changes the dash line %p to a rule",
    (line) => {
      expect(normalizeBody(`one\n${line}\ntwo`)).toBe("one\n\n---\ntwo\n");
    },
  );

  test("keeps curly quotes and em dashes in prose", () => {
    const text = "“Quoted” — it’s prose\n";
    expect(normalizeBody(text)).toBe(text);
  });

  test("repairs quotes and dashes inside a fence, and nothing else", () => {
    expect(
      normalizeBody("```sh\nsay “hi” ‘there’ cmd —flag\n---\n—\n```\nafter\n"),
    ).toBe("```sh\nsay \"hi\" 'there' cmd --flag\n---\n--\n```\nafter\n");
  });

  test("repairs code fenced with tildes", () => {
    expect(normalizeBody("~~~\n“a”\n~~~\n“b”\n")).toBe('~~~\n"a"\n~~~\n“b”\n');
  });

  test("needs a closing fence at least as long as the opening fence", () => {
    expect(normalizeBody("````\n```\n“a”\n````\n“b”\n")).toBe(
      '````\n```\n"a"\n````\n“b”\n',
    );
  });

  test("a fence of the other mark does not close the fence", () => {
    expect(normalizeBody("```\n~~~\n“a”\n```\n")).toBe('```\n~~~\n"a"\n```\n');
  });

  test("an unclosed fence runs to the end", () => {
    expect(normalizeBody("```\n“a”\n---\n")).toBe('```\n"a"\n---\n');
  });

  test("a backtick in the info string is not a fence", () => {
    expect(normalizeBody("``` not `a` fence\n“a”\n")).toBe(
      "``` not `a` fence\n“a”\n",
    );
  });

  test("drops blank lines at the ends and uses one final newline", () => {
    expect(normalizeBody("\n \none\ntwo\r\n\n\n")).toBe("one\ntwo\n");
  });

  test("gives an empty result for a blank body", () => {
    expect(normalizeBody(" \n\n")).toBe("");
  });

  test.each([
    "one\n---\ntwo",
    "one\n—\n—\ntwo\n",
    "```\n“a” —\n```\n—\n",
    "````\n```\n—\n",
    "~~~\n—\n~~\n~~~~\n--",
    "  —\ntext\n  ---\n",
    "\n\n---\n\n",
    "***\n___\n- - -\n",
    "a\r\nb\r\n--\r\n",
  ])("is idempotent on %p", (body) => {
    const once = normalizeBody(body);
    expect(normalizeBody(once)).toBe(once);
  });
});

describe("newPostFile", () => {
  test("writes the frontmatter in schema order with the body after a blank line", () => {
    expect(post("Hello there\n\nBody text.", ["a", "b"]).source).toBe(
      '---\ntitle: "Hello there"\npubDate: 2026-10-31\ntags: ["a", "b"]\n---\n\nBody text.\n',
    );
  });

  test("leaves out empty tags", () => {
    expect(post("Hello\n\nBody").source).toBe(
      '---\ntitle: "Hello"\npubDate: 2026-10-31\n---\n\nBody\n',
    );
  });

  test("trims tags, and drops blank and repeated tags", () => {
    expect(
      frontmatterOf(post("Hi", [" a ", "", "a", "b"]).source).tags,
    ).toEqual(["a", "b"]);
  });

  test("a title with no body ends after the frontmatter", () => {
    expect(post("Hello").source).toBe(
      '---\ntitle: "Hello"\npubDate: 2026-10-31\n---\n',
    );
  });

  test("returns the slug, path, and title", () => {
    expect(post("Hello there")).toMatchObject({
      slug: "hello-there",
      path: "src/content/posts/hello-there.md",
      title: "Hello there",
    });
  });

  test.each(["   \n\t\n", ""])("refuses the blank text %p", (text) => {
    expect(
      newPostFile({ text, tags: [], day: DAY, taken: [] }),
    ).toBeUndefined();
  });

  test("the first non-blank line is the title", () => {
    expect(post("\n\n  Title  \nBody")).toMatchObject({ title: "Title" });
  });

  test.each(["# Title", "### Title"])(
    "strips the heading marks of %p",
    (text) => {
      expect(post(text).title).toBe("Title");
    },
  );

  test("keeps a # with no space", () => {
    expect(post("#hashtag").title).toBe("#hashtag");
  });

  test("a title with YAML characters survives a real YAML parser", () => {
    const title = `Quotes " and : colons \\ # hash 'single'`;
    expect(frontmatterOf(post(title).source).title).toBe(title);
  });

  test("a line of exactly 70 characters is the whole title", () => {
    const line = "a".repeat(70);
    const file = post(line);
    expect(file.title).toBe(line);
    expect(file.source).not.toContain("…");
    expect(file.source.endsWith("---\n")).toBe(true);
  });

  test("caps a long title at a word boundary, and keeps the line in the body", () => {
    const line = `${"word ".repeat(20)}end`;
    const file = post(`${line}\nsecond`);
    expect(file.title).toBe(`${"word ".repeat(13).trimEnd()} word…`);
    expect([...file.title].length).toBeLessThanOrEqual(70);
    expect(file.source).toEndWith(`---\n\n${line}\nsecond\n`);
  });

  test("cuts a long title with no spaces", () => {
    const file = post("a".repeat(90));
    expect(file.title).toBe(`${"a".repeat(69)}…`);
    expect(file.source).toContain(`\n${"a".repeat(90)}\n`);
  });

  test("does not cut an emoji in half", () => {
    const file = post("😀".repeat(90));
    expect(file.title).toBe(`${"😀".repeat(69)}…`);
  });

  test("caps the slug at 60 with no trailing hyphen", () => {
    const { slug } = post(`${"a".repeat(59)} bbbbb`);
    expect(slug as string).toBe("a".repeat(59));
  });

  test.each(["!!!", "こんにちは", "index", "Index"])(
    "uses a dated slug for %p",
    (text) => {
      expect(post(text).slug as string).toBe(`note-${DAY}`);
    },
  );

  test("adds -2 and -3 to a taken slug", () => {
    expect(post("Hi", [], ["hi"]).slug as string).toBe("hi-2");
    expect(post("Hi", [], ["hi", "hi-2"]).slug as string).toBe("hi-3");
  });

  test("a dated slug can be taken too", () => {
    expect(post("!!!", [], [`note-${DAY}`]).slug as string).toBe(
      `note-${DAY}-2`,
    );
  });

  test("a numbered slug stays within the cap", () => {
    const base = "a".repeat(60);
    const { slug } = post(base, [], [base]);
    expect(slug as string).toBe(`${"a".repeat(58)}-2`);
  });

  test("normalizes the body", () => {
    expect(post("T\ntext\n---\n```\n“a”\n```").source).toEndWith(
      '---\n\ntext\n\n---\n```\n"a"\n```\n',
    );
  });
});

describe("revisedPostFile", () => {
  const current = `---
title: Old title
description: "Keep: this"
pubDate: 2026-01-02
tags: [old]
plate: dawn
---

Old body.
`;

  const revise = (
    args: Partial<Parameters<typeof revisedPostFile>[0]>,
  ): string | undefined =>
    revisedPostFile({ text: "New\n\nNew body", tags: [], current, ...args })
      ?.source;

  test("replaces the title, tags, and body, and keeps other bytes", () => {
    expect(revise({ tags: ["new"] })).toBe(`---
title: "New"
description: "Keep: this"
pubDate: 2026-01-02
tags: ["new"]
plate: dawn
---

New body
`);
  });

  test("returns the new title", () => {
    expect(
      revisedPostFile({ text: "# New\nb", tags: [], current })?.title,
    ).toBe("New");
  });

  test("drops the tags line when no tags remain", () => {
    expect(revise({})).not.toContain("tags");
  });

  test("replaces a block list of tags", () => {
    const source = revise({
      tags: ["z"],
      current: "---\ntitle: T\ntags:\n  - a\n  - b\nplate: dawn\n---\nx\n",
    });
    expect(source).toBe(
      '---\ntitle: "New"\ntags: ["z"]\nplate: dawn\n---\n\nNew body\n',
    );
  });

  test("replaces a block list at column zero", () => {
    expect(
      revise({
        tags: ["z"],
        current: "---\ntitle: T\ntags:\n- a\n- b\n---\nx\n",
      }),
    ).toBe('---\ntitle: "New"\ntags: ["z"]\n---\n\nNew body\n');
  });

  test("replaces a flow list that spans lines", () => {
    expect(
      revise({
        tags: ["z"],
        current: "---\ntitle: T\ntags: [a,\n  b]\n---\nx\n",
      }),
    ).toBe('---\ntitle: "New"\ntags: ["z"]\n---\n\nNew body\n');
  });

  test("adds tags before the plate, the schema position", () => {
    expect(
      revise({
        tags: ["z"],
        current: "---\ntitle: T\npubDate: 2026-01-02\nplate: dawn\n---\nx\n",
      }),
    ).toBe(
      '---\ntitle: "New"\npubDate: 2026-01-02\ntags: ["z"]\nplate: dawn\n---\n\nNew body\n',
    );
  });

  test("adds tags at the end when there is no plate", () => {
    expect(
      revise({
        tags: ["z"],
        current: "---\ntitle: T\npubDate: 2026-01-02\n---\nx\n",
      }),
    ).toBe(
      '---\ntitle: "New"\npubDate: 2026-01-02\ntags: ["z"]\n---\n\nNew body\n',
    );
  });

  test("keeps a block scalar in another key", () => {
    const description = "description: |\n  title: not a title\n  more";
    expect(
      revise({ current: `---\ntitle: T\n${description}\n---\nx\n` }),
    ).toContain(description);
  });

  test("keeps a --- in the old body out of the frontmatter", () => {
    expect(revise({ current: "---\ntitle: T\n---\n\na\n\n---\n\nb\n" })).toBe(
      '---\ntitle: "New"\n---\n\nNew body\n',
    );
  });

  test("handles a quoted title with a # inside it", () => {
    expect(
      revise({ current: `---\ntitle: "A # B" # note\n---\nx\n` }),
    ).toStartWith('---\ntitle: "New"\n');
  });

  test.each([
    ["no frontmatter", "Just text\n"],
    ["no closing fence", "---\ntitle: T\n"],
    ["CRLF frontmatter", "---\r\ntitle: T\r\n---\r\nx\r\n"],
    ["no title", "---\npubDate: 2026-01-02\n---\nx\n"],
    ["a multi-line plain title", "---\ntitle: one\n  two\n---\nx\n"],
    ["a title with a blank line inside", "---\ntitle: one\n\n  two\n---\nx\n"],
    ["a title on the next line", "---\ntitle:\n  one\n---\nx\n"],
    ["a literal block scalar", "---\ntitle: |\n  one\n---\nx\n"],
    ["a folded block scalar", "---\ntitle: >-\n  one\n---\nx\n"],
    ["an open quote", '---\ntitle: "one\n  two"\n---\nx\n'],
    ["an anchor", "---\ntitle: &a one\n---\nx\n"],
    ["a block scalar in tags", "---\ntitle: T\ntags: |\n  a\n---\nx\n"],
    ["an open flow list", "---\ntitle: T\ntags: [a,\nb]\n---\nx\n"],
    ["two titles", "---\ntitle: A\ntitle: B\n---\nx\n"],
  ])("refuses %s", (_, file) => {
    expect(revise({ current: file })).toBeUndefined();
  });

  test("refuses blank text", () => {
    expect(revise({ text: "  \n" })).toBeUndefined();
  });

  test("the result parses, and a second revision keeps the same bytes", () => {
    const once = revise({ tags: ["a"] }) ?? "";
    expect(frontmatterOf(once)).toMatchObject({
      title: "New",
      description: "Keep: this",
      tags: ["a"],
      plate: "dawn",
    });
    expect(revise({ tags: ["a"], current: once })).toBe(once);
  });
});

describe("readTags", () => {
  test.each<[string, string[]]>([
    ["tags: [a, b]", ["a", "b"]],
    ["tags: []", []],
    ["tags: [\"a b\", 'c''d', e]", ["a b", "c'd", "e"]],
    ['tags: ["a, b", "c]d"]', ["a, b", "c]d"]],
    ['tags: ["\\u00e9"]', ["é"]],
    ["tags: [a, b] # note, here", ["a", "b"]],
    ["tags: [a,\n  b]", ["a", "b"]],
    ["tags:\n  - a\n  - b", ["a", "b"]],
    ["tags:\n- a\n- b", ["a", "b"]],
    ["tags:\n  - \"a b\"\n  - 'c' # note\n  - d # note", ["a b", "c", "d"]],
  ])("reads %p", (entry, expected) => {
    expect(
      readTags(`---\ntitle: T\n${entry}\nplate: dawn\n---\nbody\n`),
    ).toEqual(expected);
  });

  test("reads CRLF frontmatter", () => {
    expect(readTags("---\r\ntags: [a]\r\n---\r\n")).toEqual(["a"]);
  });

  test("reads the tags that newPostFile writes", () => {
    expect(readTags(post("Hi", ['a "b"', "c, d"]).source)).toEqual([
      'a "b"',
      "c, d",
    ]);
  });

  test("ignores a tags line in the body", () => {
    expect(readTags("---\ntitle: T\n---\ntags: [a]\n")).toEqual([]);
  });

  test("ignores a nested tags key", () => {
    expect(readTags("---\nextra:\n  tags: [a]\n---\n")).toEqual([]);
  });

  test.each([
    "no frontmatter\n",
    "---\ntitle: T\n---\n",
    "---\ntags: [oops\n---\n",
  ])("finds no tags in %p", (source) => {
    expect(readTags(source)).toEqual([]);
  });
});
