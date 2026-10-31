import type { Pad, Sha } from "../protocol";
import { parsePadId } from "../protocol";
import { createEditor } from "./editor";
import {
  barOf,
  buildingNotice,
  earlierLabel,
  isWatching,
  liveLine,
  notSeenCopy,
  pairFailureCopy,
  POLL_MS,
  reduce,
  screenForPad,
  shippingCopy,
  surfaceOf,
  writeNotice,
  type Event as ScreenEvent,
  type Notice,
  type Screen,
} from "./screen";
import {
  chipTags,
  createStore,
  earlierCount,
  earlierRows,
  isBlank,
  normalizeTag,
  saveCopy,
  titleOf,
  type EarlierRow,
  type Outcome,
} from "./store";

const KEYBOARD_MIN_PX = 80;

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const elementOf = <T extends HTMLElement>(id: string, type: new () => T) => {
  const element = document.getElementById(id);
  if (element instanceof type) return element;
  throw new Error(`The shell has no ${type.name} #${id}`);
};

const required = (id: string) => elementOf(id, HTMLElement);

const root = required("root");
const band = required("band");
const editorHost = required("editor");
const page = elementOf("page", HTMLIFrameElement);
const earlierSection = required("earlier");
const unpublishedGroup = required("unpublished");
const unpublishedRows = required("unpublished-rows");
const publishedGroup = required("published");
const publishedRows = required("published-rows");
const pairForm = elementOf("pair", HTMLFormElement);
const tokenInput = elementOf("token", HTMLInputElement);
const pairFailure = required("pair-failure");
const metaLine = required("meta-line");
const tagLine = required("tag-line");
const save = required("save");
const saveBeside = required("save-beside");
const msg = required("msg");
const msgLabel = required("msg-label");
const msgText = required("msg-text");
const tagPop = required("tag-pop");
const chips = required("chips");
const addTagForm = elementOf("add-tag", HTMLFormElement);
const newTagInput = elementOf("new-tag", HTMLInputElement);
const earlierLink = elementOf("earlier-link", HTMLButtonElement);
const tools = required("tools");
const tagsToggle = required("tags-toggle");
const previewButton = elementOf("preview-button", HTMLButtonElement);
const shippingLine = required("shipping-line");
const shippingQuiet = required("shipping-quiet");
const shippingActions = required("shipping-actions");
const settledState = required("settled-state");
const settledWhere = required("settled-where");
const openPost = elementOf("open-post", HTMLAnchorElement);
const bars = [...document.querySelectorAll<HTMLElement>("[data-bar]")];

let screen: Screen = { kind: "write", popover: "closed", problem: null };
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let renderedTags = "";
let renderedRows = "";

const send = (event: ScreenEvent) => {
  screen = reduce(screen, event);
  render();
};

const store = createStore({
  storage: localStorage,
  fetch: (url, init) => fetch(url, init),
  online: () => navigator.onLine,
  now: () => Date.now(),
  newId: () => {
    const id = parsePadId(crypto.randomUUID());
    if (!id) throw new Error("randomUUID gave an id that the protocol rejects");
    return id;
  },
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (timer) => {
    if (typeof timer === "number") clearTimeout(timer);
  },
  persist: () => void navigator.storage?.persist?.(),
  events: {
    changed: () => render(),
    denied: () => send({ kind: "denied" }),
    serverBack: () => send({ kind: "server-back" }),
    shipAnswered: (id, answer) => {
      if (id === store.current().id) send({ kind: "ship-answered", answer });
    },
    shipFailed: (id, problem) => {
      if (id === store.current().id) send({ kind: "ship-failed", problem });
    },
    currentReplaced: (pad) => {
      editor.load(pad.text);
      send({ kind: "pad-opened", pad });
    },
  },
});

const editor = createEditor({
  parent: editorHost,
  onChange: (text) => {
    store.edit(text);
    send({ kind: "edited" });
  },
});

const openPad = (pad: Pad) => {
  editor.load(pad.text);
  send({ kind: "pad-opened", pad });
};

const settle = <T>(args: {
  outcome: Outcome<T>;
  answered: (answer: T) => ScreenEvent;
  failed: (problem: "no-server" | "server-error") => ScreenEvent;
}) => {
  const { outcome } = args;
  switch (outcome.kind) {
    case "answer":
      send(args.answered(outcome.answer));
      return;
    case "denied":
      return;
    case "unreachable":
      send(args.failed("no-server"));
      return;
    case "server-error":
      send(args.failed("server-error"));
      return;
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
};

const preview = async () => {
  if (isBlank(store.current())) return;
  send({ kind: "prove-started" });
  settle({
    outcome: await store.prove(),
    answered: (answer) => ({ kind: "prove-answered", answer }),
    failed: (problem) => ({ kind: "prove-failed", problem }),
  });
};

const publish = () => {
  if (screen.kind !== "preview") return;
  const { sha } = screen;
  send({ kind: "ship-started" });
  store.beginShip(sha);
};

const closeTags = () => send({ kind: "tags-closed" });

const addTag = (raw: string) => {
  const tag = normalizeTag(raw);
  const { tags } = store.current();
  if (tag && !tags.includes(tag)) store.setTags([...tags, tag]);
};

const toggleTag = (tag: string) => {
  const { tags } = store.current();
  store.setTags(
    tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag],
  );
};

const actions: Record<string, () => void> = {
  "open-earlier": () => send({ kind: "earlier-opened" }),
  "close-earlier": () => send({ kind: "earlier-closed" }),
  "toggle-tags": () => send({ kind: "tags-toggled" }),
  "insert-separator": () => editor.insertSeparator(),
  "insert-code": () => editor.insertCodeBlock(),
  preview: () => void preview(),
  "back-to-editing": () => {
    send({ kind: "back-to-editing" });
    editor.focus();
  },
  publish,
  "retry-ship": () => store.sync(),
  "new-thought": () => {
    openPad(store.newPad());
    editor.focus();
  },
  fix: () => {
    openPad(store.current());
    editor.focus();
  },
  "pair-dismiss": () => openPad(store.current()),
};

const textNode = (tag: string, className: string, text: string) => {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
};

const rowButton = (args: {
  label: string;
  className: string;
  run: () => void;
}) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = args.className;
  button.textContent = args.label;
  button.addEventListener("click", args.run);
  return button;
};

const openRow = (pad: Pad) => {
  const fresh = store.openPad(pad.id);
  if (fresh) openPad(fresh);
};

const rowElement = (row: EarlierRow) => {
  const { pad } = row;
  const item = document.createElement("li");
  const date = textNode(
    "span",
    "row-date",
    dateFormat.format(new Date(pad.updatedAt)),
  );
  const line = document.createElement("div");
  line.className = "row-line";
  line.append(date);
  switch (row.kind) {
    case "draft":
      item.append(
        rowButton({
          label: titleOf(pad),
          className: "row-open",
          run: () => openRow(pad),
        }),
      );
      line.append(
        rowButton({
          label: "Discard",
          className: "link",
          run: () => store.discard(pad.id),
        }),
      );
      break;
    case "sending":
      item.append(textNode("span", "row-title", titleOf(pad)));
      line.append(textNode("span", "label save", "Publishing"));
      break;
    case "published": {
      item.append(textNode("span", "row-title", titleOf(pad)));
      const link = textNode("a", "link", "Open");
      link.setAttribute("href", row.url);
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener");
      line.append(
        rowButton({
          label: "Fix",
          className: "link",
          run: () => {
            openRow(pad);
            editor.focus();
          },
        }),
        link,
      );
      break;
    }
    default: {
      const _exhaustive: never = row;
      return _exhaustive;
    }
  }
  item.append(line);
  return item;
};

/** Builds the rows only on a change, so the render on `pointerdown` cannot end a tap. */
const renderEarlier = (rows: readonly EarlierRow[]) => {
  const key = JSON.stringify(rows);
  if (key === renderedRows) return;
  renderedRows = key;
  const unpublished = rows.filter((row) => row.kind !== "published");
  const published = rows.filter((row) => row.kind === "published");
  unpublishedGroup.hidden = unpublished.length === 0 && published.length > 0;
  publishedGroup.hidden = published.length === 0;
  unpublishedRows.replaceChildren(
    ...(rows.length === 0
      ? [textNode("li", "row-title", "No earlier text.")]
      : unpublished.map(rowElement)),
  );
  publishedRows.replaceChildren(...published.map(rowElement));
};

const chipElement = (tag: string, selected: boolean) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip";
  button.setAttribute("aria-pressed", String(selected));
  button.append(textNode("span", "", tag));
  button.addEventListener("click", () => toggleTag(tag));
  return button;
};

/** Builds the chips only on a change, so a sync answer cannot end a tap. */
const renderTags = (pad: Pad) => {
  const key = JSON.stringify([pad.tags, store.tags()]);
  if (key === renderedTags) return;
  renderedTags = key;
  tagLine.replaceChildren(
    ...pad.tags.map((tag) => textNode("span", "tag", tag)),
  );
  chips.replaceChildren(
    ...chipTags({ known: store.tags(), selected: pad.tags }).map((tag) =>
      chipElement(tag, pad.tags.includes(tag)),
    ),
  );
};

const noticeOf = (current: Screen): Notice | null => {
  if (current.kind === "building") return buildingNotice;
  if (current.kind === "write" && current.problem) {
    return writeNotice(current.problem);
  }
  return null;
};

const renderWriteBar = (current: Screen, rows: readonly EarlierRow[]) => {
  const notice = noticeOf(current);
  const status = saveCopy[store.saveStatus()];
  const blank = isBlank(store.current());
  const popoverOpen = current.kind === "write" && current.popover === "open";
  metaLine.hidden = notice !== null;
  tools.hidden = notice !== null;
  msg.hidden = notice === null;
  saveBeside.hidden = notice === null;
  save.textContent = status;
  saveBeside.textContent = status;
  msgLabel.hidden = !notice?.label;
  msgLabel.textContent = notice?.label ?? "";
  msgText.textContent = notice?.text ?? "";
  tagPop.hidden = !popoverOpen;
  tagsToggle.setAttribute("aria-expanded", String(popoverOpen));
  earlierLink.textContent = earlierLabel(earlierCount(rows));
  earlierLink.disabled = current.kind === "building";
  previewButton.textContent = notice?.action ?? "Preview";
  previewButton.classList.toggle("outlined", notice?.outlined ?? false);
  previewButton.disabled = blank || current.kind === "building";
  renderTags(store.current());
};

const renderPostBar = (current: Screen) => {
  switch (current.kind) {
    case "shipping": {
      const copy = shippingCopy(current.problem);
      shippingLine.textContent = copy.line;
      shippingQuiet.textContent = copy.quiet;
      shippingActions.hidden = current.problem === null;
      return;
    }
    case "pushed": {
      if (isWatching(current)) return;
      settledState.hidden = true;
      settledWhere.textContent = notSeenCopy;
      openPost.href = current.url;
      return;
    }
    case "live":
      settledState.hidden = false;
      settledWhere.textContent = liveLine(current.url);
      openPost.href = current.url;
      return;
    default:
      return;
  }
};

const pageUrlOf = (current: Screen): string | null => {
  switch (current.kind) {
    case "preview":
      return current.url;
    case "shipping":
    case "pushed":
    case "live":
      return current.page;
    default:
      return null;
  }
};

const renderPage = (url: string | null) => {
  if (url === null) {
    page.removeAttribute("src");
    return;
  }
  // Setting the same value reloads the frame.
  if (page.getAttribute("src") !== url) page.src = url;
};

const render = () => {
  const current = screen;
  const surface = surfaceOf(current);
  const rows = earlierRows({
    pads: store.all(),
    current: store.current().id,
  });
  const wasHidden = editorHost.hidden;
  root.dataset.screen = current.kind;
  band.hidden = surface === "page";
  editorHost.hidden = surface !== "editor";
  page.hidden = surface !== "page";
  earlierSection.hidden = surface !== "earlier";
  pairForm.hidden = surface !== "pair";
  for (const bar of bars) bar.hidden = bar.dataset.bar !== barOf(current);
  editor.setLocked(current.kind !== "write");
  if (wasHidden && surface === "editor") editor.shown();
  if (surface !== "editor") editor.blur();
  renderWriteBar(current, rows);
  renderPostBar(current);
  renderPage(pageUrlOf(current));
  if (surface === "earlier") renderEarlier(rows);
  if (current.kind === "pair") {
    pairFailure.hidden = current.failure === null;
    pairFailure.textContent = current.failure
      ? pairFailureCopy[current.failure.kind]
      : "";
  }
  armPoll();
};

const poll = async (sha: Sha) =>
  settle({
    outcome: await store.poll(sha),
    answered: (answer) => ({ kind: "ship-answered", answer }),
    failed: (problem) => ({ kind: "ship-failed", problem }),
  });

const armPoll = () => {
  if (pollTimer !== undefined) return;
  if (screen.kind !== "pushed" || !isWatching(screen)) return;
  if (document.visibilityState !== "visible") return;
  const { sha } = screen;
  pollTimer = setTimeout(() => {
    pollTimer = undefined;
    if (screen.kind === "pushed" && document.visibilityState === "visible") {
      void poll(sha);
    }
  }, POLL_MS);
};

/** The root follows the visual viewport, so the bar stays above the keyboard. */
const fitViewport = () => {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const covered = window.innerHeight - viewport.height;
  root.style.setProperty("--root-height", `${viewport.height}px`);
  root.style.setProperty("--root-top", `${viewport.offsetTop}px`);
  if (covered > KEYBOARD_MIN_PX) root.dataset.keyboard = "open";
  else delete root.dataset.keyboard;
};

const onPair = async (event: SubmitEvent) => {
  event.preventDefault();
  const result = await store.pair(tokenInput.value.trim());
  switch (result.kind) {
    case "paired":
      tokenInput.value = "";
      openPad(store.current());
      return;
    case "wrong-token":
    case "no-server":
      send({ kind: "pair-failed", failure: result });
      return;
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
};

const wire = () => {
  for (const type of ["pointerdown", "mousedown"] as const) {
    root.addEventListener(type, (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const keep = target.closest("[data-keep-focus]");
      if (keep && !target.closest("input")) event.preventDefault();
    });
  }
  root.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (!tagPop.contains(target) && !tagsToggle.contains(target)) closeTags();
  });
  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
    if (action) actions[action]?.();
  });
  addTagForm.addEventListener("submit", (event) => {
    event.preventDefault();
    addTag(newTagInput.value);
    newTagInput.value = "";
  });
  pairForm.addEventListener("submit", (event) => void onPair(event));
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeTags();
  });

  window.visualViewport?.addEventListener("resize", fitViewport);
  window.visualViewport?.addEventListener("scroll", fitViewport);
  window.addEventListener("resize", fitViewport);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      store.flush();
      return;
    }
    store.sync();
    armPoll();
  });
  window.addEventListener("pagehide", () => store.flush());
  window.addEventListener("online", () => store.sync());
};

const launch = () => {
  wire();
  fitViewport();
  const pad = store.current();
  editor.load(pad.text);
  screen = screenForPad(pad);
  render();
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js", { scope: "/" });
  }
  store.start();
};

launch();
