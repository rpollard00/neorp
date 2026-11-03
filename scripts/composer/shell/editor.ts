// It keeps native iOS editing: no drawn selection and no custom cursor.

import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import {
  Compartment,
  EditorSelection,
  EditorState,
  StateField,
  StateEffect,
  type SelectionRange,
  type Line,
  type Range,
  type TransactionSpec,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  RectangleMarker,
  WidgetType,
  keymap,
  layer,
  type DecorationSet,
} from "@codemirror/view";
import { cardLines } from "../../../src/lib/link-cards";
import { isRuleLine, subtitleOf } from "../text";

export const setImageAnchor = StateEffect.define<SelectionRange | null>();
export const imageAnchor = StateField.define<SelectionRange | null>({
  create: () => null,
  update(value, transaction) {
    let next = value?.map(transaction.changes, 1) ?? null;
    for (const effect of transaction.effects)
      if (effect.is(setImageAnchor)) next = effect.value;
    return next;
  },
});

class BreakWidget extends WidgetType {
  override eq() {
    return true;
  }

  override toDOM() {
    const element = document.createElement("span");
    element.className = "cm-break";
    element.setAttribute("aria-hidden", "true");
    return element;
  }

  override ignoreEvent() {
    return false;
  }
}

const breakWidget = Decoration.replace({ widget: new BreakWidget() });

const lineClass = (name: string) => Decoration.line({ class: name });
const codeLine = Decoration.line({
  attributes: {
    class: "cm-code",
    spellcheck: "false",
    autocorrect: "off",
    autocapitalize: "none",
  },
});

const markClass = (name: string) => Decoration.mark({ class: name });
const dim = markClass("cm-dim");
const bold = markClass("cm-bold");
const italic = markClass("cm-italic");
const inlineCode = markClass("cm-inline-code");
const quoteMark = markClass("cm-quote-mark");

const lineSets = () => ({
  code: new Set<number>(),
  fence: new Set<number>(),
  codeFirst: new Set<number>(),
  codeLast: new Set<number>(),
  quote: new Set<number>(),
  quoteFirst: new Set<number>(),
  quoteLast: new Set<number>(),
  heading: new Set<number>(),
  underline: new Set<number>(),
});

type LineSets = ReturnType<typeof lineSets>;

const addBlock = (args: {
  state: EditorState;
  node: { from: number; to: number };
  all: Set<number>;
  first: Set<number>;
  last: Set<number>;
}) => {
  const first = args.state.doc.lineAt(args.node.from).number;
  const last = args.state.doc.lineAt(args.node.to).number;
  for (let number = first; number <= last; number++) args.all.add(number);
  args.first.add(first);
  args.last.add(last);
};

const hasCursor = (state: EditorState, line: Line) =>
  state.selection.ranges.some(
    (range) => range.from <= line.to && range.to >= line.from,
  );

const readTree = (state: EditorState) => {
  const lines = lineSets();
  const marks: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      switch (node.name) {
        case "FencedCode":
        case "CodeBlock":
          addBlock({
            state,
            node,
            all: lines.code,
            first: lines.codeFirst,
            last: lines.codeLast,
          });
          return undefined;
        case "CodeMark":
          if (lines.code.has(state.doc.lineAt(node.from).number)) {
            lines.fence.add(state.doc.lineAt(node.from).number);
          } else {
            marks.push(dim.range(node.from, node.to));
          }
          return undefined;
        case "CodeInfo":
          lines.fence.add(state.doc.lineAt(node.from).number);
          return undefined;
        case "Blockquote":
          addBlock({
            state,
            node,
            all: lines.quote,
            first: lines.quoteFirst,
            last: lines.quoteLast,
          });
          return undefined;
        case "QuoteMark": {
          const end = state.doc.sliceString(node.to, node.to + 1) === " ";
          marks.push(quoteMark.range(node.from, node.to + (end ? 1 : 0)));
          return undefined;
        }
        case "SetextHeading2":
          lines.underline.add(state.doc.lineAt(node.to).number);
          return undefined;
        case "ATXHeading1":
        case "ATXHeading2":
        case "ATXHeading3":
        case "ATXHeading4":
        case "ATXHeading5":
        case "ATXHeading6":
          lines.heading.add(state.doc.lineAt(node.from).number);
          return undefined;
        case "HeaderMark":
          if (lines.heading.has(state.doc.lineAt(node.from).number)) {
            marks.push(dim.range(node.from, node.to));
          }
          return undefined;
        case "StrongEmphasis":
          marks.push(bold.range(node.from, node.to));
          return undefined;
        case "Emphasis":
          marks.push(italic.range(node.from, node.to));
          return undefined;
        case "EmphasisMark":
          marks.push(dim.range(node.from, node.to));
          return undefined;
        case "InlineCode":
          marks.push(inlineCode.range(node.from, node.to));
          return undefined;
        default:
          return undefined;
      }
    },
  });
  return { lines, marks };
};

/** As on the server, the first line with text is the title. A blank pad's title goes on line 1. */
const titleLine = (state: EditorState): Line | undefined => {
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    if (line.text.trim()) return /^\s*!\[/.test(line.text) ? undefined : line;
  }
  return undefined;
};

const hasSubtitle = (state: EditorState, title: Line) =>
  title.number < state.doc.lines &&
  subtitleOf({
    first: title.text,
    next: state.doc.line(title.number + 1).text,
  }) !== null;

/** The title and subtitle leave the body, so the line after them starts it. */
const cardLineNumbers = (
  state: EditorState,
  head: { title: Line | undefined; subtitle: boolean },
) => {
  const lines = state.doc.toJSON();
  if (head.title) {
    const end = head.title.number + (head.subtitle ? 1 : 0);
    lines.fill("", head.title.number - 1, end);
  }
  return new Set([...cardLines(lines).keys()].map((index) => index + 1));
};

const lineDecorations = (state: EditorState, lines: LineSets) => {
  const out: Range<Decoration>[] = [];
  const title = titleLine(state);
  const titleNumber = title?.number ?? 1;
  const subtitle = title !== undefined && hasSubtitle(state, title);
  const cards = cardLineNumbers(state, { title, subtitle });
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    const add = (name: string) => out.push(lineClass(name).range(line.from));
    if (lines.code.has(number)) {
      out.push(codeLine.range(line.from));
      if (lines.fence.has(number)) add("cm-fence");
      if (lines.codeFirst.has(number)) add("cm-code-first");
      if (lines.codeLast.has(number)) add("cm-code-last");
      continue;
    }
    if (isRuleLine(line.text) || lines.underline.has(number)) {
      add("cm-rule");
      if (hasCursor(state, line)) add("cm-rule-raw");
      else out.push(breakWidget.range(line.from, line.to));
      continue;
    }
    if (lines.quote.has(number)) {
      add("cm-quote");
      if (lines.quoteFirst.has(number)) add("cm-quote-first");
      if (lines.quoteLast.has(number)) add("cm-quote-last");
      if (hasCursor(state, line)) add("cm-quote-cursor");
    }
    if (number === titleNumber) add("cm-title");
    if (number === titleNumber + 1 && subtitle) add("cm-subtitle");
    if (lines.heading.has(number)) add("cm-heading");
    if (cards.has(number)) add("cm-card");
  }
  return out;
};

export const decorate = (state: EditorState): DecorationSet => {
  const { lines, marks } = readTree(state);
  return Decoration.set([...lineDecorations(state, lines), ...marks], true);
};

const decorations = StateField.define<DecorationSet>({
  create: decorate,
  update(value, transaction) {
    const treeMoved =
      syntaxTree(transaction.state) !== syntaxTree(transaction.startState);
    return transaction.docChanged || transaction.selection || treeMoved
      ? decorate(transaction.state)
      : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const quoteBars = layer({
  above: false,
  class: "cm-quote-bars",
  update: (update) =>
    update.docChanged || update.viewportChanged || update.geometryChanged,
  markers(view) {
    const base = view.scrollDOM.getBoundingClientRect();
    const origin = view.documentTop - base.top + view.scrollDOM.scrollTop;
    const content = view.contentDOM.getBoundingClientRect();
    const left =
      content.left -
      base.left +
      Number.parseFloat(getComputedStyle(view.contentDOM).paddingLeft);
    const bars: RectangleMarker[] = [];
    syntaxTree(view.state).iterate({
      enter(node) {
        if (node.name !== "Blockquote") return undefined;
        const top = view.lineBlockAt(node.from).top;
        const bottom = view.lineBlockAt(node.to).bottom;
        bars.push(
          new RectangleMarker(
            "cm-quote-bar",
            left,
            Math.round(origin + top),
            null,
            Math.round(bottom - top),
          ),
        );
        return false;
      },
    });
    return bars;
  },
});

const gaps = (args: { before: string; after: string }) => {
  const { before, after } = args;
  const lead = () => {
    if (before === "" || before.endsWith("\n\n")) return "";
    return before.endsWith("\n") ? "\n" : "\n\n";
  };
  const trail = () => {
    if (after.startsWith("\n\n")) return "";
    return after.startsWith("\n") ? "\n" : "\n\n";
  };
  const skipped = /^\n{0,2}/.exec(after)?.[0].length ?? 0;
  return { lead: lead(), trail: trail(), skipped };
};

const around = (state: EditorState) => {
  const { from, to } = state.selection.main;
  return {
    from,
    to,
    selected: state.sliceDoc(from, to),
    ...gaps({ before: state.sliceDoc(0, from), after: state.sliceDoc(to) }),
  };
};

export const separatorInsert = (state: EditorState): TransactionSpec => {
  const { from, to, lead, trail, skipped } = around(state);
  const insert = `${lead}---${trail}`;
  return {
    changes: { from, to, insert },
    selection: EditorSelection.cursor(from + insert.length + skipped),
    scrollIntoView: true,
    userEvent: "input",
  };
};

export const codeBlockInsert = (state: EditorState): TransactionSpec => {
  const { from, to, selected, lead, trail } = around(state);
  const open = `${lead}\`\`\`\n`;
  return {
    changes: { from, to, insert: `${open}${selected}\n\`\`\`${trail}` },
    selection: EditorSelection.cursor(from + open.length + selected.length),
    scrollIntoView: true,
    userEvent: "input",
  };
};

const linkText = (text: string) => text.replace(/[\\[\]]/g, "\\$&");

const linkTarget = (url: string) => (/[\s()]/.test(url) ? `<${url}>` : url);

export const linkInsert = (
  state: EditorState,
  link: { url: string; text: string },
): TransactionSpec => {
  const { from, to } = state.selection.main;
  const text = link.text.trim();
  const insert = text
    ? `[${linkText(text)}](${linkTarget(link.url)})`
    : `<${link.url}>`;
  return {
    changes: { from, to, insert },
    selection: EditorSelection.cursor(from + insert.length),
    scrollIntoView: true,
    userEvent: "input",
  };
};

const CODE_BLOCKS = new Set(["FencedCode", "CodeBlock"]);

const blockEnd = (state: EditorState, pos: number) => {
  const line = state.doc.lineAt(pos);
  if (!line.text.trim()) return line.from;
  for (const side of [-1, 1] as const) {
    let node = syntaxTree(state).resolveInner(pos, side);
    while (!CODE_BLOCKS.has(node.name) && node.parent) node = node.parent;
    if (CODE_BLOCKS.has(node.name)) return state.doc.lineAt(node.to).to;
  }
  let last = line;
  while (last.number < state.doc.lines) {
    const next = state.doc.line(last.number + 1);
    if (!next.text.trim()) break;
    last = next;
  }
  return last.to;
};

/** `<url>` is a card whenever the URL parses, so the editor need not check it. */
export const cardInsert = (
  state: EditorState,
  card: { url: string },
): TransactionSpec => {
  const url = `<${card.url}>`;
  const title = titleLine(state);
  if (!title) {
    return {
      changes: { from: 0, insert: `\n\n${url}` },
      selection: EditorSelection.cursor(0),
      scrollIntoView: true,
      userEvent: "input",
    };
  }
  const at = blockEnd(state, Math.max(state.selection.main.head, title.from));
  const { lead, trail, skipped } = gaps({
    before: state.sliceDoc(0, at),
    after: state.sliceDoc(at),
  });
  const insert = `${lead}${url}${trail}`;
  return {
    changes: { from: at, insert },
    selection: EditorSelection.cursor(at + insert.length + skipped),
    scrollIntoView: true,
    userEvent: "input",
  };
};

export const imageInsert = (
  state: EditorState,
  args: { markdown: string; anchor: SelectionRange },
): TransactionSpec => {
  const title = titleLine(state);
  if (!state.doc.toString().trim())
    return {
      changes: { from: 0, insert: `\n\n${args.markdown}` },
      selection: EditorSelection.cursor(0),
      effects: setImageAnchor.of(null),
      userEvent: "input.paste",
    };
  const from =
    title && args.anchor.from <= title.to ? title.to : args.anchor.from;
  const to = Math.max(from, args.anchor.to);
  const { lead, trail } = gaps({
    before: state.sliceDoc(0, from),
    after: state.sliceDoc(to),
  });
  const insert = `${lead}${args.markdown}${trail}`;
  return {
    changes: { from, to, insert },
    selection: EditorSelection.cursor(from + insert.length),
    effects: setImageAnchor.of(null),
    scrollIntoView: true,
    userEvent: "input.paste",
  };
};

const HEADING_MARK = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;

const headingStep = (text: string) => {
  const [mark = "", level = ""] = HEADING_MARK.exec(text) ?? [];
  if (level === "##") return { mark, next: "### " };
  if (level === "###") return { mark, next: "" };
  return { mark, next: "## " };
};

export const headingCycle = (state: EditorState): TransactionSpec => {
  const { from, to } = state.selection.main;
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;
  const bodyStart = (titleLine(state)?.number ?? state.doc.lines) + 1;
  const changes = [];
  for (let number = Math.max(first, bodyStart); number <= last; number++) {
    const line = state.doc.line(number);
    if (first !== last && !line.text.trim()) continue;
    const { mark, next } = headingStep(line.text);
    changes.push({
      from: line.from,
      to: line.from + mark.length,
      insert: next,
    });
  }
  if (changes.length === 0) return {};
  const set = state.changes(changes);
  return {
    changes: set,
    selection: state.selection.map(set, 1),
    userEvent: "input",
  };
};

export const selectedText = (state: EditorState): string => {
  const { from, to } = state.selection.main;
  return state.sliceDoc(from, to).replace(/\s+/g, " ").trim();
};

const chrome = EditorView.theme({
  "&.cm-focused": { outline: "none" },
});

export const createEditor = (args: {
  parent: HTMLElement;
  onChange: (text: string) => void;
  onImagePaste?: (files: File[]) => void;
  onLoad?: () => void;
}) => {
  const lock = new Compartment();

  const makeState = (text: string) =>
    EditorState.create({
      doc: text,
      selection: EditorSelection.cursor(text.length),
      extensions: [
        history(),
        imageAnchor,
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        markdown(),
        decorations,
        quoteBars,
        chrome,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          "aria-label": "Text",
          autocapitalize: "sentences",
          autocorrect: "on",
          spellcheck: "true",
        }),
        lock.of(EditorState.readOnly.of(false)),
        EditorView.domEventHandlers({
          paste(event, view) {
            if (view.state.readOnly || !args.onImagePaste) return false;
            const files = [...(event.clipboardData?.files ?? [])].filter(
              (file) => file.type.startsWith("image/"),
            );
            if (files.length === 0) return false;
            event.preventDefault();
            view.dispatch({
              effects: setImageAnchor.of(view.state.selection.main),
            });
            args.onImagePaste(files);
            return true;
          },
        }),
        // This listener runs inside the dispatch, with no async step first.
        EditorView.updateListener.of((update) => {
          if (update.docChanged) args.onChange(update.state.doc.toString());
        }),
      ],
    });

  const view = new EditorView({
    parent: args.parent,
    state: makeState(""),
  });

  return {
    /** This does not call `onChange`. */
    load: (text: string) => {
      args.onLoad?.();
      view.setState(makeState(text));
    },

    cancelImage: () => view.dispatch({ effects: setImageAnchor.of(null) }),
    insertImage: (markdown: string) => {
      const anchor = view.state.field(imageAnchor);
      if (!anchor) return false;
      view.dispatch(imageInsert(view.state, { markdown, anchor }));
      view.focus();
      return true;
    },

    /** The keyboard stays open, and the text does not change. */
    setLocked: (locked: boolean) => {
      if (view.state.readOnly === locked) return;
      view.dispatch({
        effects: lock.reconfigure(EditorState.readOnly.of(locked)),
      });
    },

    insertSeparator: () => {
      view.dispatch(separatorInsert(view.state));
      view.focus();
    },

    insertCodeBlock: () => {
      view.dispatch(codeBlockInsert(view.state));
      view.focus();
    },

    insertLink: (link: { url: string; text: string }) => {
      view.dispatch(linkInsert(view.state, link));
      view.focus();
    },

    insertCard: (card: { url: string }) => {
      view.dispatch(cardInsert(view.state, card));
      view.focus();
    },

    cycleHeading: () => {
      view.dispatch(headingCycle(view.state));
      view.focus();
    },

    selectedText: () => selectedText(view.state),

    focus: () => view.focus(),

    blur: () => view.contentDOM.blur(),

    /** The editor cannot measure while it is hidden. */
    shown: () => view.requestMeasure(),
  };
};
