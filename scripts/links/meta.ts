import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fallbackCard, type LinkCard } from "../../src/lib/link-cards";
import { SITE } from "../../src/site";

const TITLE_LIMIT = 120;
const DESCRIPTION_LIMIT = 300;
const BODY_LIMIT = 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = `neorp-link-card (+${SITE.url})`;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type Lookup = (hostname: string) => Promise<string[]>;
export type FetchCard = (url: string) => Promise<LinkCard | undefined>;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
};

const codePoint = (text: string, radix: number) => {
  const value = Number.parseInt(text, radix);
  return value > 0 && value <= 0x10ffff && (value < 0xd800 || value > 0xdfff)
    ? String.fromCodePoint(value)
    : undefined;
};

const decodeEntities = (text: string) =>
  text.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi,
    (entity, decimal?: string, hex?: string, name?: string) =>
      (decimal && codePoint(decimal, 10)) ??
      (hex && codePoint(hex, 16)) ??
      (name && NAMED_ENTITIES[name.toLowerCase()]) ??
      entity,
  );

const clean = (text: string | undefined) => {
  const value = decodeEntities(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return value || undefined;
};

const cap = (text: string, limit: number) => {
  if (text.length <= limit) return text;
  const room = text.slice(0, limit);
  const space = room.lastIndexOf(" ");
  const cut = space > limit / 2 ? room.slice(0, space) : room;
  return `${cut.replace(/[\s,.;:–—-]+$/, "")}…`;
};

const ATTRIBUTE = /([^\s"'=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

const metaTags = (head: string) => {
  const found = new Map<string, string>();
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = new Map(
      [...tag.matchAll(ATTRIBUTE)].map(([, name = "", ...values]) => [
        name.toLowerCase(),
        values.find((value) => value !== undefined) ?? "",
      ]),
    );
    const key = (attributes.get("property") ?? attributes.get("name"))
      ?.trim()
      .toLowerCase();
    const content = attributes.get("content");
    if (key && content !== undefined && !found.has(key)) {
      found.set(key, content);
    }
  }
  return found;
};

export const parseLinkMeta = ({
  html,
  url,
}: {
  html: string;
  url: string;
}): LinkCard => {
  const headEnd = html.search(/<\/head\s*>/i);
  const head = headEnd === -1 ? html : html.slice(0, headEnd);
  const meta = metaTags(head);
  const first = (...keys: string[]) =>
    keys.map((key) => clean(meta.get(key))).find(Boolean);
  const fallback = fallbackCard(url);
  const title =
    first("og:title", "twitter:title") ??
    clean(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1]) ??
    fallback.title;
  const description = first(
    "og:description",
    "description",
    "twitter:description",
  );
  return {
    site: first("og:site_name") ?? fallback.site,
    title: cap(title, TITLE_LIMIT),
    ...(description
      ? { description: cap(description, DESCRIPTION_LIMIT) }
      : {}),
  };
};

const ipv4Bytes = (text: string) => {
  const parts = text.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return undefined;
  }
  const bytes = parts.map(Number);
  return bytes.every((byte) => byte <= 255) ? bytes : undefined;
};

const ipv6Groups = (text: string) => {
  const [, prefix = "", dotted] =
    /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text) ?? [];
  const tail = dotted === undefined ? undefined : ipv4Bytes(dotted);
  if (dotted !== undefined && !tail) return undefined;
  const pair = (high = 0, low = 0) => ((high << 8) | low).toString(16);
  const hex = tail
    ? `${prefix}${pair(tail[0], tail[1])}:${pair(tail[2], tail[3])}`
    : text;
  const [head = "", rest, ...extra] = hex.split("::");
  if (extra.length > 0) return undefined;
  const split = (part: string) => (part ? part.split(":") : []);
  const left = split(head);
  const right = rest === undefined ? [] : split(rest);
  const missing = 8 - left.length - right.length;
  if (rest === undefined ? missing !== 0 : missing < 1) return undefined;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return undefined;
  return groups.map((group) => Number.parseInt(group, 16));
};

const isPrivateIpv4 = ([a = 0, b = 0, c = 0]: number[]) =>
  a === 0 ||
  a === 10 ||
  a === 127 ||
  a >= 224 ||
  (a === 100 && b >= 64 && b < 128) ||
  (a === 169 && b === 254) ||
  (a === 172 && b >= 16 && b < 32) ||
  (a === 192 && b === 0 && c === 0) ||
  (a === 192 && b === 168) ||
  (a === 198 && (b === 18 || b === 19));

const isZero = (group: number) => group === 0;

const bytesOf = (high = 0, low = 0) => [
  high >> 8,
  high & 0xff,
  low >> 8,
  low & 0xff,
];

/** IPv4-mapped, IPv4-translated, NAT64 (64:ff9b::/96), and 6to4 (2002::/16). */
const embeddedIpv4 = (groups: number[]) => {
  const [first, second, , , fifth, sixth, seventh, eighth] = groups;
  const zeroUpTo = (end: number) => groups.slice(0, end).every(isZero);
  if (zeroUpTo(5) && sixth === 0xffff) return bytesOf(seventh, eighth);
  if (zeroUpTo(4) && fifth === 0xffff && sixth === 0) {
    return bytesOf(seventh, eighth);
  }
  if (first === 0x64 && second === 0xff9b && groups.slice(2, 6).every(isZero)) {
    return bytesOf(seventh, eighth);
  }
  if (first === 0x2002) return bytesOf(second, groups[2]);
  return undefined;
};

const isPrivateIpv6 = (groups: number[]) => {
  const [first = 0] = groups;
  if (groups.slice(0, 6).every(isZero)) return true;
  const ipv4 = embeddedIpv4(groups);
  if (ipv4) return isPrivateIpv4(ipv4);
  return (
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00
  );
};

const isPrivateAddress = (address: string) => {
  const v4 = ipv4Bytes(address);
  if (v4) return isPrivateIpv4(v4);
  const v6 = ipv6Groups(address);
  return v6 ? isPrivateIpv6(v6) : true;
};

const LOCAL_NAME = /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/;

export const parseFetchableUrl = (url: string): URL | undefined => {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }
  if (parsed.username || parsed.password) return undefined;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isIP(host)) return isPrivateAddress(host) ? undefined : parsed;
  if (!host.includes(".") || LOCAL_NAME.test(host)) return undefined;
  return parsed;
};

const lookupAll: Lookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true })).map(({ address }) => address);

const resolvesPublic = async ({
  url,
  lookup,
}: {
  url: URL;
  lookup: Lookup;
}) => {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return true;
  // fetch resolves the name again, so a rebinding DNS answer can still differ.
  const addresses = await lookup(host);
  return addresses.length > 0 && !addresses.some(isPrivateAddress);
};

const isHtml = (contentType: string | null) =>
  /^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType ?? "");

const charsetOf = (contentType: string | null) =>
  /;\s*charset="?([\w-]+)/i.exec(contentType ?? "")?.[1] ?? "utf-8";

const decoderFor = (charset: string) => {
  try {
    return new TextDecoder(charset);
  } catch {
    return new TextDecoder();
  }
};

const readHead = async (response: Response) => {
  const decoder = decoderFor(charsetOf(response.headers.get("content-type")));
  const reader = response.body?.getReader();
  if (!reader) return "";
  let text = "";
  let size = 0;
  while (size < BODY_LIMIT) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value.subarray(0, BODY_LIMIT - size);
    size += chunk.byteLength;
    text += decoder.decode(chunk, { stream: true });
  }
  await reader.cancel().catch(() => undefined);
  return text + decoder.decode();
};

const isRedirect = (status: number) => status >= 300 && status < 400;

export const fetchLinkCard = async ({
  url,
  fetch,
  lookup = lookupAll,
  timeoutMs = 6000,
}: {
  url: string;
  fetch: Fetch;
  lookup?: Lookup;
  timeoutMs?: number;
}): Promise<LinkCard | undefined> => {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    let target = parseFetchableUrl(url);
    for (let hop = 0; target && hop <= MAX_REDIRECTS; hop += 1) {
      if (!(await resolvesPublic({ url: target, lookup }))) return undefined;
      const response = await fetch(target.href, {
        signal,
        redirect: "manual",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
        },
      });
      const location = response.headers.get("location");
      if (isRedirect(response.status) && location) {
        await response.body?.cancel();
        target = URL.canParse(location, target)
          ? parseFetchableUrl(new URL(location, target).href)
          : undefined;
        continue;
      }
      if (!response.ok || !isHtml(response.headers.get("content-type"))) {
        await response.body?.cancel();
        return undefined;
      }
      return parseLinkMeta({
        html: await readHead(response),
        url: target.href,
      });
    }
    return undefined;
  } catch {
    return undefined;
  }
};

export const fetchCardFromWeb: FetchCard = (url) =>
  fetchLinkCard({ url, fetch: (input, init) => fetch(input, init) });
