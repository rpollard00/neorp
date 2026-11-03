import type { LinkPreview, Pad, Sha } from "../protocol";
import { parsePadId } from "../protocol";
import { webUrl } from "../text";
import { createEditor } from "./editor";
import {
  imageFigureMarkdown,
  imageFigureView,
  parseImagePresentation,
  type ImagePresentation,
} from "../../../src/lib/image-figures";
import {
  createImageLibrary,
  decodePastedImage,
  type PastedImage,
} from "./images";
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
  canDiscard,
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
const LINK_PREVIEW_DELAY_MS = 400;

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
const discardedGroup = required("discarded");
const discardedRows = required("discarded-rows");
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
const tagsToggle = required("tags-toggle");
const linkPop = required("link-pop");
const linkToggle = required("link-toggle");
const linkForm = elementOf("link-form", HTMLFormElement);
const linkUrl = elementOf("link-url", HTMLInputElement);
const linkText = elementOf("link-text", HTMLInputElement);
const linkPreview = required("link-preview");
const linkSite = required("link-site");
const linkTitle = required("link-title");
const linkCard = elementOf("link-card", HTMLButtonElement);
const linkInsert = elementOf("link-insert", HTMLButtonElement);
const previewButton = elementOf("preview-button", HTMLButtonElement);
const shippingLine = required("shipping-line");
const shippingQuiet = required("shipping-quiet");
const shippingActions = required("shipping-actions");
const settledState = required("settled-state");
const settledWhere = required("settled-where");
const openPost = elementOf("open-post", HTMLAnchorElement);
const bars = [...document.querySelectorAll<HTMLElement>("[data-bar]")];
const imagePop = required("image-pop");
const imageForm = elementOf("image-form", HTMLFormElement);
const imagePreview = elementOf("image-preview", HTMLImageElement);
const imageFields = required("image-fields");
const imageStage = required("image-stage");
const imageFigure = required("image-figure");
const imageSizes = [
  ...document.querySelectorAll<HTMLInputElement>('input[name="image-size"]'),
];
const imageSizeHelp = required("image-size-help");
const imageCaption = elementOf("image-caption", HTMLInputElement);
const imageFrame = elementOf("image-frame", HTMLInputElement);
const imageAlt = elementOf("image-alt", HTMLInputElement);
const imageMessage = required("image-message");
const imageInsertButton = elementOf("image-insert", HTMLButtonElement);
const imageCancel = elementOf("image-cancel", HTMLButtonElement);
const imageSaveProblem = required("image-save-problem");

type ImagePasteState =
  | { kind: "closed" }
  | { kind: "loading"; token: symbol }
  | {
      kind: "ready";
      token: symbol;
      image: PastedImage;
      fields: ReturnType<typeof parseImagePresentation>;
      problem: string;
    }
  | {
      kind: "saving";
      token: symbol;
      image: PastedImage;
      presentation: ImagePresentation;
    }
  | { kind: "failed"; token: symbol; message: string };
let imagePaste: ImagePasteState = { kind: "closed" };
const ownsImagePaste = (token: symbol) =>
  imagePaste.kind !== "closed" && imagePaste.token === token;
const images = createImageLibrary({ fetch: (url, init) => fetch(url, init) });

let screen: Screen = { kind: "write", popover: "closed", problem: null };
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let renderedTags = "";
let renderedRows = "";
let linkPreviewTimer: ReturnType<typeof setTimeout> | undefined;
let linkTextTyped = false;

const send = (event: ScreenEvent) => {
  screen = reduce(screen, event);
  render();
};

const store = createStore({
  images,
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
    currentForked: () => {
      closeImagePaste(false);
      send({ kind: "pad-forked" });
    },
  },
});

const editor = createEditor({
  parent: editorHost,
  onImagePaste: (files) => void openImagePaste(files),
  onLoad: () => closeImagePaste(false),
  onChange: (text) => {
    store.edit(text);
    send({ kind: "edited" });
  },
});

const imagePasteMessage = (state: ImagePasteState): string => {
  switch (state.kind) {
    case "closed":
      return "";
    case "loading":
      return "Opening image…";
    case "saving":
      return "Saving image on this phone…";
    case "failed":
      return state.message;
    case "ready":
      return state.fields.kind === "invalid"
        ? state.fields.message
        : state.problem;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
};

const readImageFields = (image: PastedImage) =>
  parseImagePresentation({
    width: image.width,
    height: image.height,
    size: imageSizes.find((input) => input.checked)?.value,
    frame: imageFrame.checked ? "pixel" : "bare",
    alt: imageAlt.value,
    caption: imageCaption.value,
  });

const renderImagePaste = () => {
  const state = imagePaste;
  imagePop.hidden = state.kind === "closed";
  const hasImage = state.kind === "ready" || state.kind === "saving";
  imageStage.hidden = !hasImage;
  imageFields.hidden = !hasImage;
  imageInsertButton.disabled =
    state.kind !== "ready" || state.fields.kind === "invalid";
  for (const input of [...imageSizes, imageAlt, imageCaption, imageFrame])
    input.disabled = state.kind === "saving";
  imageMessage.textContent = imagePasteMessage(state);
  imageMessage.hidden = imageMessage.textContent === "";
  if (!hasImage) {
    imagePreview.removeAttribute("src");
    return;
  }
  imagePreview.src = state.image.url;
  const presentation =
    state.kind === "saving"
      ? state.presentation
      : state.fields.kind === "valid"
        ? state.fields.presentation
        : null;
  if (!presentation) return;
  const view = imageFigureView(presentation);
  imageFigure.dataset.frame = view.frame;
  imageFigure.style.setProperty("--image-cap", `${view.imageMaxWidthPx}px`);
  imagePreview.width = view.width;
  imagePreview.height = view.height;
  imagePreview.alt = view.alt;
  const caption = imageFigure.querySelector("figcaption");
  if (view.caption === null) caption?.remove();
  else {
    const node = caption ?? document.createElement("figcaption");
    node.className = "image-caption";
    node.textContent = view.caption;
    if (!caption) imageFigure.append(node);
  }
  imageSizeHelp.textContent = {
    compact: "A smaller image that leaves more room for the text.",
    auto: "Fits the space and keeps tall images shorter.",
    wide: "Uses the available width, up to the original image size.",
  }[view.size];
};

const closeImagePaste = (clearAnchor = true) => {
  if (imagePaste.kind === "ready" || imagePaste.kind === "saving")
    imagePaste.image.release();
  imagePaste = { kind: "closed" };
  renderImagePaste();
  if (clearAnchor) editor.cancelImage();
};

const openImagePaste = async (files: File[]) => {
  closeImagePaste(false);
  closePopover();
  const token = Symbol();
  imageAlt.value = "";
  imageCaption.value = "";
  imageFrame.checked = true;
  for (const input of imageSizes) input.checked = input.value === "auto";
  imagePaste = { kind: "loading", token };
  renderImagePaste();
  const [file] = files;
  if (files.length !== 1 || !file) {
    imagePaste = {
      kind: "failed",
      token,
      message: `The clipboard has ${files.length} images. Paste one image at a time. No images were inserted.`,
    };
    renderImagePaste();
    imageCancel.focus();
    return;
  }
  try {
    const image = await decodePastedImage(file);
    if (!ownsImagePaste(token)) {
      image.release();
      return;
    }
    imagePaste = {
      kind: "ready",
      token,
      image,
      fields: readImageFields(image),
      problem: "",
    };
    renderImagePaste();
    imageSizes.find((input) => input.checked)?.focus();
  } catch (error) {
    if (!ownsImagePaste(token)) return;
    imagePaste = {
      kind: "failed",
      token,
      message:
        error instanceof Error
          ? error.message
          : "The image could not be opened.",
    };
    renderImagePaste();
    imageCancel.focus();
  }
};

const insertPastedImage = async () => {
  if (imagePaste.kind !== "ready") return;
  const { token, image } = imagePaste;
  const fields = readImageFields(image);
  if (fields.kind === "invalid") {
    imagePaste = { ...imagePaste, fields };
    renderImagePaste();
    return;
  }
  const { presentation } = fields;
  imagePaste = { kind: "saving", token, image, presentation };
  renderImagePaste();
  try {
    const bytes = new Uint8Array(await image.blob.arrayBuffer());
    const asset = await images.save(bytes);
    if (imagePaste.kind !== "saving" || imagePaste.token !== token) return;
    if (
      !editor.insertImage(
        imageFigureMarkdown({ asset: asset.name, presentation }),
      )
    ) {
      closeImagePaste();
      editor.focus();
      return;
    }
    closeImagePaste();
  } catch (error) {
    if (imagePaste.kind !== "saving" || imagePaste.token !== token) return;
    imagePaste = {
      kind: "ready",
      token,
      image,
      fields,
      problem:
        error instanceof Error
          ? error.message
          : "The image could not be saved on this phone.",
    };
    renderImagePaste();
  }
};

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
  const pad = store.current();
  if (isBlank(pad)) return;
  const source = { pad: pad.id, rev: pad.rev };
  send({ kind: "prove-started", source });
  settle({
    outcome: await store.prove(),
    answered: (answer) => ({ kind: "prove-answered", source, answer }),
    failed: (problem) => ({ kind: "prove-failed", source, problem }),
  });
};

const publish = () => {
  if (screen.kind !== "preview") return;
  const { sha } = screen;
  send({ kind: "ship-started" });
  store.beginShip(sha);
};

const closePopover = () => send({ kind: "popover-closed" });

const showLinkPreview = (preview: LinkPreview | undefined) => {
  linkPreview.hidden = preview === undefined;
  linkSite.textContent = preview?.site ?? "";
  linkTitle.textContent = preview?.title ?? "";
};

const fetchLinkPreview = async (url: string) => {
  const outcome = await store.linkPreview(url);
  if (outcome.kind !== "answer" || linkPop.hidden) return;
  if (webUrl(linkUrl.value) !== url) return;
  showLinkPreview(outcome.answer);
  if (!linkTextTyped) linkText.value = outcome.answer.title;
};

const linkUrlChanged = () => {
  const url = webUrl(linkUrl.value);
  linkCard.disabled = url === undefined;
  linkInsert.disabled = url === undefined;
  showLinkPreview(undefined);
  clearTimeout(linkPreviewTimer);
  if (url === undefined) return;
  linkPreviewTimer = setTimeout(
    () => void fetchLinkPreview(url),
    LINK_PREVIEW_DELAY_MS,
  );
};

/** This runs inside the tap, so iOS lets the field take focus and read the clipboard. */
const openLink = () => {
  linkUrl.value = "";
  linkText.value = editor.selectedText();
  linkTextTyped = linkText.value !== "";
  linkUrlChanged();
  linkUrl.focus();
  navigator.clipboard?.readText().then(
    (text) => {
      const url = webUrl(text);
      if (url === undefined || linkUrl.value || linkPop.hidden) return;
      linkUrl.value = url;
      linkUrlChanged();
      if (document.activeElement === linkUrl) linkText.focus();
    },
    () => undefined,
  );
};

const insertLink = () => {
  const url = webUrl(linkUrl.value);
  if (url === undefined) return;
  editor.insertLink({ url, text: linkText.value });
  closePopover();
};

const insertCard = () => {
  const url = webUrl(linkUrl.value);
  if (url === undefined) return;
  editor.insertCard({ url });
  closePopover();
};

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
  "toggle-link": () => {
    send({ kind: "link-toggled" });
    if (screen.kind === "write" && screen.popover === "link") openLink();
  },
  "insert-card": insertCard,
  "cycle-heading": () => editor.cycleHeading(),
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
      if (canDiscard(pad)) {
        line.append(
          rowButton({
            label: "Discard",
            className: "link",
            run: () => store.discard(pad.id),
          }),
        );
      }
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
    case "discarded":
      item.append(textNode("span", "row-title", titleOf(pad)));
      line.append(
        rowButton({
          label: "Restore",
          className: "link",
          run: () => store.restore(pad.id),
        }),
      );
      break;
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
  const unpublished = rows.filter(
    (row) => row.kind === "draft" || row.kind === "sending",
  );
  const published = rows.filter((row) => row.kind === "published");
  const discarded = rows.filter((row) => row.kind === "discarded");
  unpublishedGroup.hidden = unpublished.length === 0 && rows.length > 0;
  publishedGroup.hidden = published.length === 0;
  discardedGroup.hidden = discarded.length === 0;
  unpublishedRows.replaceChildren(
    ...(rows.length === 0
      ? [textNode("li", "row-title", "No earlier text.")]
      : unpublished.map(rowElement)),
  );
  publishedRows.replaceChildren(...published.map(rowElement));
  discardedRows.replaceChildren(...discarded.map(rowElement));
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
  const popover = current.kind === "write" ? current.popover : "closed";
  metaLine.hidden = notice !== null;
  tagLine.hidden = notice !== null;
  msg.hidden = notice === null;
  saveBeside.hidden = notice === null;
  save.textContent = status;
  saveBeside.textContent = status;
  msgLabel.hidden = !notice?.label;
  msgLabel.textContent = notice?.label ?? "";
  msgText.textContent = notice?.text ?? "";
  tagPop.hidden = popover !== "tags";
  tagsToggle.setAttribute("aria-expanded", String(popover === "tags"));
  linkPop.hidden = popover !== "link";
  linkToggle.setAttribute("aria-expanded", String(popover === "link"));
  imageSaveProblem.textContent = store.imageProblem();
  imageSaveProblem.hidden = !store.imageProblem();
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
  if (current.kind !== "write" && imagePaste.kind !== "closed")
    closeImagePaste();
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
  editor.setLocked(current.kind !== "write" && current.kind !== "building");
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

const isPolling = (sha: Sha) => screen.kind === "pushed" && screen.sha === sha;

const poll = async (sha: Sha) => {
  const outcome = await store.poll(sha);
  if (!isPolling(sha)) return;
  settle({
    outcome,
    answered: (answer) => ({ kind: "ship-answered", answer }),
    failed: (problem) => ({ kind: "ship-failed", problem }),
  });
};

const armPoll = () => {
  if (
    screen.kind !== "pushed" ||
    !isWatching(screen) ||
    document.visibilityState !== "visible"
  ) {
    clearTimeout(pollTimer);
    pollTimer = undefined;
    return;
  }
  if (pollTimer !== undefined) return;
  const { sha } = screen;
  pollTimer = setTimeout(() => {
    pollTimer = undefined;
    if (isPolling(sha)) void poll(sha);
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
  imageForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void insertPastedImage();
  });
  imageCancel.addEventListener("click", () => {
    closeImagePaste();
    editor.focus();
  });
  imageForm.addEventListener("input", () => {
    if (imagePaste.kind !== "ready") return;
    imagePaste = {
      ...imagePaste,
      fields: readImageFields(imagePaste.image),
      problem: "",
    };
    renderImagePaste();
  });
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
    const inside = [tagPop, tagsToggle, linkPop, linkToggle].some((element) =>
      element.contains(target),
    );
    if (!inside) closePopover();
  });
  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
    if (action && imagePaste.kind !== "closed") closeImagePaste();
    if (action) actions[action]?.();
  });
  addTagForm.addEventListener("submit", (event) => {
    event.preventDefault();
    addTag(newTagInput.value);
    newTagInput.value = "";
  });
  linkForm.addEventListener("submit", (event) => {
    event.preventDefault();
    insertLink();
  });
  linkUrl.addEventListener("input", linkUrlChanged);
  linkText.addEventListener("input", () => {
    linkTextTyped = linkText.value !== "";
  });
  pairForm.addEventListener("submit", (event) => void onPair(event));
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (imagePaste.kind !== "closed") {
      closeImagePaste();
      editor.focus();
      return;
    }
    const inLink = linkPop.contains(document.activeElement);
    closePopover();
    if (inLink) editor.focus();
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
