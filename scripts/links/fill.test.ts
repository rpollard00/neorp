import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINK_CARDS_PATH, type LinkCard } from "../../src/lib/link-cards";
import { fillLinkCards, formatLinkCards, parseLinkCards } from "./fill";
import { fetchLinkCard, type FetchCard } from "./meta";

const A = "https://example.com/a";
const B = "https://example.com/b";
const DOWN = "https://down.example.com/";

const MARKDOWN = `---\ntitle: T\n---\n\n${B}\n\nSee ${DOWN} inline.\n\n${A}\n\n${DOWN}\n`;

const pages: Record<string, LinkCard> = {
  [A]: { site: "Example", title: "Page A", description: "About A" },
  [B]: { site: "Example", title: "Page B" },
};

let root: string;
let asked: string[];

const fakeCard: FetchCard = async (url) => {
  asked.push(url);
  return pages[url];
};

const cardsFile = () => join(root, LINK_CARDS_PATH);
const readCards = async () => readFile(cardsFile(), "utf8");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "link-cards-"));
  asked = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("fillLinkCards", () => {
  test("adds the cards it finds, sorted, and leaves out failures", async () => {
    expect(
      await fillLinkCards({ root, markdown: MARKDOWN, fetchCard: fakeCard }),
    ).toEqual({ added: [B, A], failed: [DOWN] });
    expect(await readCards()).toBe(
      `{\n  "${A}": {\n    "site": "Example",\n    "title": "Page A",\n    "description": "About A"\n  },\n  "${B}": {\n    "site": "Example",\n    "title": "Page B"\n  }\n}\n`,
    );
  });

  test("fetches only URLs with no card, and keeps the others", async () => {
    await mkdir(join(root, "src/data"), { recursive: true });
    const kept = { site: "Old", title: "Kept" };
    await writeFile(cardsFile(), formatLinkCards({ [A]: kept }));
    expect(
      await fillLinkCards({ root, markdown: MARKDOWN, fetchCard: fakeCard }),
    ).toEqual({ added: [B], failed: [DOWN] });
    expect(asked.sort()).toEqual([DOWN, B]);
    expect(parseLinkCards(await readCards())).toEqual({
      [A]: kept,
      [B]: pages[B],
    });
  });

  test("writes nothing when nothing is added", async () => {
    expect(
      await fillLinkCards({ root, markdown: `${DOWN}\n`, fetchCard: fakeCard }),
    ).toEqual({ added: [], failed: [DOWN] });
    expect(await stat(cardsFile()).catch(() => undefined)).toBeUndefined();
  });

  test("works with fetchLinkCard and a fake fetch", async () => {
    const fetchCard: FetchCard = (url) =>
      fetchLinkCard({
        url,
        lookup: async () => ["93.184.215.14"],
        fetch: async (input) =>
          input === A
            ? new Response("<title>Fetched A</title>", {
                headers: { "content-type": "text/html" },
              })
            : new Response("", { status: 500 }),
      });
    expect(
      await fillLinkCards({ root, markdown: `${A}\n\n${B}\n`, fetchCard }),
    ).toEqual({ added: [A], failed: [B] });
    expect(parseLinkCards(await readCards())).toEqual({
      [A]: { site: "example.com", title: "Fetched A" },
    });
  });
});

describe("parseLinkCards", () => {
  test("reads a missing file as no cards", () => {
    expect(parseLinkCards(undefined)).toEqual({});
  });

  test.each([
    ["[]"],
    ['{"https://a.com/": {"site": "a"}}'],
    ['{"https://a.com/": {"site": "a", "title": "t", "description": 1}}'],
  ])("refuses %s", (text) => {
    expect(() => parseLinkCards(text)).toThrow(LINK_CARDS_PATH);
  });
});
