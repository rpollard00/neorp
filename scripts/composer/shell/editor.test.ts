import { describe, expect, test } from "bun:test";
import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { codeBlockInsert, decorate, separatorInsert } from "./editor";

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

const apply = (state: EditorState, spec: typeof separatorInsert) => {
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

  test("the first line keeps its class while it is blank", () => {
    expect(lineInfo(make("\nBody"), 1).classes).toContain("cm-title");
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
