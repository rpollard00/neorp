import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  cardUrls,
  LINK_CARDS_PATH,
  type LinkCard,
  type LinkCards,
} from "../../src/lib/link-cards";
import type { FetchCard } from "./meta";

const CONCURRENCY = 4;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseCard = (value: unknown): LinkCard | undefined => {
  if (!isRecord(value)) return undefined;
  const { site, title, description } = value;
  if (typeof site !== "string" || typeof title !== "string") return undefined;
  if (typeof description === "string") return { site, title, description };
  return description === undefined ? { site, title } : undefined;
};

export const parseLinkCards = (text: string | undefined): LinkCards => {
  if (text === undefined) return {};
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed))
    throw new Error(`${LINK_CARDS_PATH} is not an object.`);
  const cards: LinkCards = {};
  for (const [url, value] of Object.entries(parsed)) {
    const card = parseCard(value);
    if (!card) throw new Error(`${LINK_CARDS_PATH} has a bad card for ${url}.`);
    cards[url] = card;
  }
  return cards;
};

export const formatLinkCards = (cards: LinkCards) =>
  `${JSON.stringify(
    Object.fromEntries(
      Object.entries(cards).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    null,
    2,
  )}\n`;

export const addLinkCards = async ({
  cards,
  markdown,
  fetchCard,
}: {
  cards: LinkCards;
  markdown: string;
  fetchCard: FetchCard;
}): Promise<{ cards: LinkCards; added: string[]; failed: string[] }> => {
  const missing = cardUrls(markdown).filter(
    (url) => !Object.hasOwn(cards, url),
  );
  const found = new Map<string, LinkCard | undefined>();
  const queue = [...missing];
  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      found.set(url, await fetchCard(url));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const fetched = missing.flatMap((url) => {
    const card = found.get(url);
    return card ? [[url, card] as const] : [];
  });
  return {
    cards: { ...cards, ...Object.fromEntries(fetched) },
    added: fetched.map(([url]) => url),
    failed: missing.filter((url) => !found.get(url)),
  };
};

const readIfPresent = async (path: string) => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
};

export const fillLinkCards = async ({
  root,
  markdown,
  fetchCard,
}: {
  root: string;
  markdown: string;
  fetchCard: FetchCard;
}): Promise<{ added: string[]; failed: string[] }> => {
  const path = join(root, LINK_CARDS_PATH);
  const { cards, added, failed } = await addLinkCards({
    cards: parseLinkCards(await readIfPresent(path)),
    markdown,
    fetchCard,
  });
  if (added.length > 0) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, formatLinkCards(cards));
  }
  return { added, failed };
};
