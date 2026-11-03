import { describe, expect, test } from "bun:test";
import { markdown } from "@codemirror/lang-markdown";
import {
  EditorSelection,
  EditorState,
  type TransactionSpec,
} from "@codemirror/state";
import {
  cardInsert,
  codeBlockInsert,
  decorate,
  headingCycle,
  linkInsert,
  selectedText,
  separatorInsert,
  imageInsert,
  imageAnchor,
  setImageAnchor,
} from "./editor";

describe("image insertion", () => {
  const image = "![A picture](/post-assets/image.png)";
  test("a blank pad leaves the title line available", () => {
    const state = make("");
    const next = state.update(
      imageInsert(state, { markdown: image, anchor: state.selection.main }),
    ).state;
    expect(next.doc.toString()).toBe(`\n\n${image}`);
    expect(next.selection.main.head).toBe(0);
  });
  test("an image pasted on the title goes into the body", () => {
    const state = make("Title\n\nBody", 2);
    const next = state.update(
      imageInsert(state, { markdown: image, anchor: state.selection.main }),
    ).state;
    expect(next.doc.toString()).toBe(`Title\n\n${image}\n\nBody`);
  });
  test("sequential image-first pastes preserve the blank title and both images", () => {
    let state = make("");
    const first = "![First](/post-assets/first.png)";
    const second = "![Second](/post-assets/second.png)";
    for (const markdown of [first, second]) {
      state = state.update(
        imageInsert(state, { markdown, anchor: state.selection.main }),
      ).state;
      expect(state.selection.main.head).toBe(0);
      expect(state.doc.line(1).text).toBe("");
      expect(state.doc.line(2).text).toBe("");
    }
    expect(state.doc.toString()).toBe(`\n\n${second}\n\n${first}`);
    state = state.update(state.replaceSelection("A title")).state;
    expect(state.doc.toString()).toBe(`A title\n\n${second}\n\n${first}`);
  });
  test("typing maps the captured anchor while cursor movement does not move it", () => {
    let state = EditorState.create({
      doc: "Title\n\nOne\n\nTwo",
      extensions: [markdown(), imageAnchor],
    });
    state = state.update({
      effects: setImageAnchor.of(EditorSelection.range(12, 15)),
    }).state;
    state = state.update({
      changes: { from: 7, insert: "More " },
      selection: EditorSelection.cursor(0),
    }).state;
    const anchor = state.field(imageAnchor);
    expect(anchor?.from).toBe(17);
    expect(anchor?.to).toBe(20);
    if (!anchor) throw new Error("The image anchor was lost");
    state = state.update(imageInsert(state, { markdown: image, anchor })).state;
    expect(state.doc.toString()).toBe(`Title\n\nMore One\n\n${image}\n\n`);
    expect(state.field(imageAnchor)).toBeNull();
  });
  test("cancel and a new editor state invalidate a pending insertion", () => {
    let state = EditorState.create({ doc: "Title", extensions: [imageAnchor] });
    state = state.update({
      effects: setImageAnchor.of(EditorSelection.cursor(3)),
    }).state;
    state = state.update({ effects: setImageAnchor.of(null) }).state;
    expect(state.field(imageAnchor)).toBeNull();
    expect(
      EditorState.create({ extensions: [imageAnchor] }).field(imageAnchor),
    ).toBeNull();
  });
});

const make = (doc: string, cursor = doc.length) =>
  EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown()],
  });

const lineInfo = (state: EditorState, number: number) => {
  const line = state.doc.line(number);
  const classes: string[] = [];
  let replaced = false;
  decorate(state).between(line.from, line.to, (from, to, value) => {
    const spec = value.spec as {
      class?: string;
      attributes?: { class?: string };
      widget?: unknown;
    };
    if (spec.widget && from === line.from && to === line.to) replaced = true;
    const name = spec.attributes?.class ?? spec.class;
    if (name && from === line.from && to === line.from) classes.push(name);
  });
  return { classes, replaced };
};

const selected = (doc: string, from: number, to: number) =>
  EditorState.create({
    doc,
    selection: EditorSelection.range(from, to),
    extensions: [markdown()],
  });

const apply = (
  state: EditorState,
  spec: (state: EditorState) => TransactionSpec,
) => {
  const next = state.update(spec(state)).state;
  return { doc: next.doc.toString(), cursor: next.selection.main.head };
};

describe("rule lines", () => {
  const doc = "Title\n\nBody\n\n---\n\nMore";

  test("the break replaces the line when the cursor is away", () => {
    const info = lineInfo(make(doc), 5);
    expect(info.replaced).toBe(true);
    expect(info.classes).toContain("cm-rule");
    expect(info.classes).not.toContain("cm-rule-raw");
  });

  test("the raw text shows on the cursor line", () => {
    const state = make(doc, doc.indexOf("---") + 1);
    const info = lineInfo(state, 5);
    expect(info.replaced).toBe(false);
    expect(info.classes).toContain("cm-rule");
    expect(info.classes).toContain("cm-rule-raw");
  });

  test.each(["--", "—", "– –", "***", "_ _ _", "----"])(
    "%s draws as a break",
    (rule) => {
      expect(lineInfo(make(`Title\n\n${rule}\n\nMore`), 3).replaced).toBe(true);
    },
  );

  test("a setext underline draws as a break, as the server treats it", () => {
    const state = make("Title\n\nSome text\n---\n\nMore");
    expect(lineInfo(state, 4).replaced).toBe(true);
    expect(lineInfo(state, 3).classes).not.toContain("cm-heading");
  });

  test("a one-dash setext underline draws as a break", () => {
    expect(lineInfo(make("Title\n\nSome text\n-\n\nMore"), 4).replaced).toBe(
      true,
    );
  });

  test("a rule line in a fence stays code", () => {
    const info = lineInfo(make("Title\n\n```\n---\n```\n"), 4);
    expect(info.replaced).toBe(false);
    expect(info.classes).toContain("cm-code");
  });
});

describe("formatting", () => {
  test("the first line is the title", () => {
    const state = make("Title\n\nBody");
    expect(lineInfo(state, 1).classes).toContain("cm-title");
    expect(lineInfo(state, 3).classes).not.toContain("cm-title");
  });

  test("a fenced block has first, last, and dim fence lines", () => {
    const state = make("Title\n\n```sh\ndu -h\n```\n\nEnd");
    const open = lineInfo(state, 3).classes;
    const body = lineInfo(state, 4).classes;
    const close = lineInfo(state, 5).classes;
    expect(open).toEqual(
      expect.arrayContaining(["cm-code", "cm-fence", "cm-code-first"]),
    );
    expect(body).toContain("cm-code");
    expect(body).not.toContain("cm-fence");
    expect(close).toEqual(
      expect.arrayContaining(["cm-code", "cm-fence", "cm-code-last"]),
    );
  });

  test("an unclosed fence runs to the end, and its last line is not a fence", () => {
    const state = make("Title\n\n```\nstill code");
    const last = lineInfo(state, 4).classes;
    expect(last).toEqual(expect.arrayContaining(["cm-code", "cm-code-last"]));
    expect(last).not.toContain("cm-fence");
  });

  test("code gets no token marks", () => {
    const state = make("Title\n\n```js\nconst a = 1;\n```\n");
    const line = state.doc.line(4);
    const marks: string[] = [];
    decorate(state).between(line.from, line.to, (from, to, value) => {
      if (to > from) marks.push(String(value.spec.class));
    });
    expect(marks).toEqual([]);
  });

  test("quote lines have the first and last classes", () => {
    const state = make("Title\n\n> One\n> Two\n\nEnd");
    expect(lineInfo(state, 3).classes).toEqual(
      expect.arrayContaining(["cm-quote", "cm-quote-first"]),
    );
    expect(lineInfo(state, 4).classes).toEqual(
      expect.arrayContaining(["cm-quote", "cm-quote-last"]),
    );
  });

  test("a ## line is a heading", () => {
    expect(lineInfo(make("Title\n\n## Head\n"), 3).classes).toContain(
      "cm-heading",
    );
  });

  test("a blank line looks the same with and without the cursor", () => {
    const doc = "Title\n\nBody";
    expect(lineInfo(make(doc, 6), 2).classes).toEqual([]);
    expect(lineInfo(make(doc), 2).classes).toEqual([]);
  });

  test("the first line of a blank pad is the title", () => {
    expect(lineInfo(make(""), 1).classes).toContain("cm-title");
    expect(lineInfo(make("\n\n"), 1).classes).toContain("cm-title");
  });

  test("the first line with text is the title, as on the server", () => {
    const state = make("\n\nTitle\nA dek\n\nBody");
    expect(lineInfo(state, 1).classes).not.toContain("cm-title");
    expect(lineInfo(state, 3).classes).toContain("cm-title");
    expect(lineInfo(state, 4).classes).toContain("cm-subtitle");
    expect(lineInfo(state, 6).classes).toEqual([]);
  });
});

describe("insert a separator", () => {
  test("at the end of a paragraph", () => {
    const { doc, cursor } = apply(make("Text"), separatorInsert);
    expect(doc).toBe("Text\n\n---\n\n");
    expect(cursor).toBe(doc.length);
  });

  test("in the middle of a line, the line splits", () => {
    const { doc } = apply(make("One two", 4), separatorInsert);
    expect(doc).toBe("One \n\n---\n\ntwo");
  });

  test("after a blank line, no more blank lines come", () => {
    expect(apply(make("Text\n\n"), separatorInsert).doc).toBe(
      "Text\n\n---\n\n",
    );
  });

  test("at the end of a line with text after it", () => {
    const start = "One\nTwo";
    const { doc, cursor } = apply(make(start, 3), separatorInsert);
    expect(doc).toBe("One\n\n---\n\nTwo");
    expect(doc.slice(cursor)).toBe("Two");
  });

  test("before a blank line, the gap is reused", () => {
    const { doc, cursor } = apply(make("One\n\nTwo", 3), separatorInsert);
    expect(doc).toBe("One\n\n---\n\nTwo");
    expect(doc.slice(cursor)).toBe("Two");
  });

  test("in an empty pad", () => {
    expect(apply(make(""), separatorInsert).doc).toBe("---\n\n");
  });

  test("the result is a thematic break, not a heading underline", () => {
    const { doc } = apply(make("Text"), separatorInsert);
    expect(lineInfo(make(doc, 0), 3).replaced).toBe(true);
  });
});

describe("insert a code block", () => {
  test("the cursor goes inside", () => {
    const { doc, cursor } = apply(make("Text"), codeBlockInsert);
    expect(doc).toBe("Text\n\n```\n\n```\n\n");
    expect(doc.slice(0, cursor)).toBe("Text\n\n```\n");
  });

  test("selected text goes in the block", () => {
    const state = EditorState.create({
      doc: "run du now",
      selection: EditorSelection.range(4, 6),
      extensions: [markdown()],
    });
    const { doc, cursor } = apply(state, codeBlockInsert);
    expect(doc).toBe("run \n\n```\ndu\n```\n\n now");
    expect(doc.slice(0, cursor).endsWith("du")).toBe(true);
  });

  test("the result parses as a fence", () => {
    const { doc } = apply(make("Text"), codeBlockInsert);
    expect(lineInfo(make(doc, 0), 3).classes).toContain("cm-code");
  });
});

describe("subtitle and card lines", () => {
  test("the line directly under the title is the subtitle", () => {
    const state = make("Title\nA dek\n\nBody");
    expect(lineInfo(state, 2).classes).toContain("cm-subtitle");
    expect(lineInfo(state, 4).classes).not.toContain("cm-subtitle");
  });

  test("a blank line after the title means no subtitle", () => {
    expect(lineInfo(make("Title\n\nBody"), 3).classes).not.toContain(
      "cm-subtitle",
    );
  });

  test.each(["## Part", "- one", "> said", "https://example.com"])(
    "%p under the title is not a subtitle",
    (line) => {
      expect(lineInfo(make(`Title\n${line}\n`), 2).classes).not.toContain(
        "cm-subtitle",
      );
    },
  );

  test("a blank first line has no subtitle under it", () => {
    expect(lineInfo(make("\nText"), 2).classes).not.toContain("cm-subtitle");
  });

  test("a capped title has no subtitle", () => {
    const state = make(`${"word ".repeat(20)}\nText`);
    expect(lineInfo(state, 2).classes).not.toContain("cm-subtitle");
  });

  test("a URL alone in its paragraph is a card", () => {
    const state = make("Title\n\nhttps://example.com/a\n\nBody");
    expect(lineInfo(state, 3).classes).toContain("cm-card");
  });

  test("a URL under a heading or directly under a subtitle is a card", () => {
    expect(
      lineInfo(make("Title\n\n## Part\nhttps://a.example"), 4).classes,
    ).toContain("cm-card");
    expect(
      lineInfo(make("Title\nA dek\nhttps://a.example\n\nBody"), 3).classes,
    ).toContain("cm-card");
  });

  test("a URL at the end and directly under the title is a card", () => {
    expect(lineInfo(make("Title\n\nhttps://a.example"), 3).classes).toContain(
      "cm-card",
    );
    expect(
      lineInfo(make("Title\nhttps://a.example\n\nBody"), 2).classes,
    ).toContain("cm-card");
  });

  test.each([
    ["inside a paragraph", "Title\n\nSee\nhttps://a.example\n", 4],
    ["with text after it", "Title\n\nhttps://a.example\nmore\n", 3],
    ["inside a fence", "Title\n\n```\nhttps://a.example\n```\n", 4],
    ["as the title", "https://a.example\n\nBody", 1],
    ["as the title after a blank line", "\nhttps://a.example\n\nBody", 2],
    ["indented", "Title\n\n  https://a.example\n", 3],
    ["with an underscore in the host", "Title\n\nhttps://my_site.com\n", 3],
  ])("a URL %s is not a card", (_name, doc, number) => {
    expect(lineInfo(make(doc), number).classes).not.toContain("cm-card");
  });
});

describe("insert a link", () => {
  test("the selection becomes the link text, and the cursor goes after", () => {
    const state = selected("See the docs now", 8, 12);
    const { doc, cursor } = apply(state, (s) =>
      linkInsert(s, { url: "https://a.example", text: "docs" }),
    );
    expect(doc).toBe("See the [docs](https://a.example) now");
    expect(doc.slice(cursor)).toBe(" now");
  });

  test("brackets in the text are escaped", () => {
    const { doc } = apply(make(""), (s) =>
      linkInsert(s, { url: "https://a.example", text: "a [b] c" }),
    );
    expect(doc).toBe("[a \\[b\\] c](https://a.example)");
  });

  test("a backslash in the text is escaped", () => {
    const { doc } = apply(make(""), (s) =>
      linkInsert(s, { url: "https://a.example", text: "C:\\" }),
    );
    expect(doc).toBe("[C:\\\\](https://a.example)");
  });

  test("a URL with parentheses goes in angle brackets", () => {
    const { doc } = apply(make(""), (s) =>
      linkInsert(s, { url: "https://a.example/x_(y)", text: "x" }),
    );
    expect(doc).toBe("[x](<https://a.example/x_(y)>)");
  });

  test("with no text, the link is the URL", () => {
    const { doc, cursor } = apply(make("Go "), (s) =>
      linkInsert(s, { url: "https://a.example", text: " " }),
    );
    expect(doc).toBe("Go <https://a.example>");
    expect(cursor).toBe(doc.length);
  });
});

describe("insert a card", () => {
  const card = (state: EditorState) =>
    apply(state, (s) => cardInsert(s, { url: "https://a.example" }));

  test("the URL becomes its own paragraph, in angle brackets", () => {
    const { doc, cursor } = card(make("Text"));
    expect(doc).toBe("Text\n\n<https://a.example>\n\n");
    expect(cursor).toBe(doc.length);
    expect(lineInfo(make(doc, 0), 3).classes).toContain("cm-card");
  });

  test("mid-line, the card goes after the paragraph and the line stays whole", () => {
    const start = "Then I ran the mover overnight.\nIt took hours.\n\nNext";
    const { doc, cursor } = card(make(start, start.indexOf(" overnight")));
    expect(doc).toBe(
      "Then I ran the mover overnight.\nIt took hours.\n\n<https://a.example>\n\nNext",
    );
    expect(doc.slice(cursor)).toBe("Next");
  });

  test("at the end of a paragraph, the gap before the next one is reused", () => {
    const { doc, cursor } = card(make("One\n\nTwo", 3));
    expect(doc).toBe("One\n\n<https://a.example>\n\nTwo");
    expect(doc.slice(cursor)).toBe("Two");
  });

  test("on a blank line, the card goes there", () => {
    const { doc, cursor } = card(make("One\n\nTwo", 4));
    expect(doc).toBe("One\n\n<https://a.example>\n\nTwo");
    expect(doc.slice(cursor)).toBe("Two");
  });

  test("in the last paragraph, the card goes at the end", () => {
    const { doc, cursor } = card(make("One\n\nTwo three", 7));
    expect(doc).toBe("One\n\nTwo three\n\n<https://a.example>\n\n");
    expect(cursor).toBe(doc.length);
  });

  test("in a code fence, the card goes after the fence", () => {
    const start = "Text\n\n```\na\n\nb\n```\nMore";
    const { doc } = card(make(start, start.indexOf("a")));
    expect(doc).toBe("Text\n\n```\na\n\nb\n```\n\n<https://a.example>\n\nMore");
  });

  test.each(["https://a.example/why?", "https://my_site.com"])(
    "%p is a card in angle brackets",
    (url) => {
      const { doc } = apply(make("Text"), (s) => cardInsert(s, { url }));
      expect(doc).toBe(`Text\n\n<${url}>\n\n`);
      expect(lineInfo(make(doc, 0), 3).classes).toContain("cm-card");
    },
  );

  test("the selected text stays", () => {
    const { doc } = card(selected("One two", 0, 3));
    expect(doc).toBe("One two\n\n<https://a.example>\n\n");
  });

  test.each(["", "\n\n"])(
    "in the blank pad %p, line 1 stays free for the title",
    (start) => {
      const { doc, cursor } = card(make(start, 0));
      expect(doc).toBe(`\n\n<https://a.example>${start}`);
      expect(cursor).toBe(0);
    },
  );

  test("above the title, the card goes after the title", () => {
    const { doc, cursor } = card(make("\n\nTitle\n\nBody", 0));
    expect(doc).toBe("\n\nTitle\n\n<https://a.example>\n\nBody");
    expect(doc.slice(cursor)).toBe("Body");
  });

  test("on the title, the card goes after the title and its subtitle", () => {
    const { doc } = card(make("Title\nA dek\n\nBody", 2));
    expect(doc).toBe("Title\nA dek\n\n<https://a.example>\n\nBody");
  });
});

describe("cycle a heading", () => {
  const cycle = (doc: string, cursor = doc.length) =>
    apply(make(doc, cursor), headingCycle);

  test("plain, then ##, then ###, then plain", () => {
    const one = cycle("Title\n\nPart");
    expect(one.doc).toBe("Title\n\n## Part");
    const two = cycle(one.doc);
    expect(two.doc).toBe("Title\n\n### Part");
    expect(cycle(two.doc).doc).toBe("Title\n\nPart");
  });

  test("the cursor keeps its place in the text", () => {
    const doc = "Title\n\nPart two";
    const { doc: next, cursor } = cycle(doc, doc.indexOf("two"));
    expect(next.slice(cursor)).toBe("two");
  });

  test("on an empty line, the cursor goes after the mark", () => {
    const { doc, cursor } = cycle("Title\n\n");
    expect(doc).toBe("Title\n\n## ");
    expect(cursor).toBe(doc.length);
  });

  test("another heading level becomes ##", () => {
    expect(cycle("Title\n\n# Part").doc).toBe("Title\n\n## Part");
  });

  test("the title line does not change", () => {
    expect(cycle("Title", 2).doc).toBe("Title");
  });

  test("the title after blank lines does not change", () => {
    expect(cycle("\n\nTitle", 4).doc).toBe("\n\nTitle");
    const doc = "\nTitle\n\nPart";
    expect(apply(selected(doc, 0, doc.length), headingCycle).doc).toBe(
      "\nTitle\n\n## Part",
    );
  });

  test("a blank pad gets no heading on its title line", () => {
    expect(cycle("").doc).toBe("");
  });

  test("each selected line changes, and blank lines stay blank", () => {
    const doc = "Title\nOne\n\nTwo";
    const { doc: next } = apply(selected(doc, 0, doc.length), headingCycle);
    expect(next).toBe("Title\n## One\n\n## Two");
  });
});

describe("selected text", () => {
  test("is one trimmed line", () => {
    expect(selectedText(selected("a  one\n two  b", 1, 13))).toBe("one two");
  });

  test("is empty with no selection", () => {
    expect(selectedText(make("text"))).toBe("");
  });
});
