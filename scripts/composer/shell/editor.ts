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
import { isRuleLine } from "../text";

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

const lineDecorations = (state: EditorState, lines: LineSets) => {
  const out: Range<Decoration>[] = [];
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
    if (number === 1) add("cm-title");
    if (lines.heading.has(number)) add("cm-heading");
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

const chrome = EditorView.theme({
  "&.cm-focused": { outline: "none" },
});

export const createEditor = (args: {
  parent: HTMLElement;
  onChange: (text: string) => void;
}) => {
  const lock = new Compartment();

  const makeState = (text: string) =>
    EditorState.create({
      doc: text,
      selection: EditorSelection.cursor(text.length),
      extensions: [
        history(),
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
    load: (text: string) => view.setState(makeState(text)),

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

    focus: () => view.focus(),

    blur: () => view.contentDOM.blur(),

    /** The editor cannot measure while it is hidden. */
    shown: () => view.requestMeasure(),
  };
};
