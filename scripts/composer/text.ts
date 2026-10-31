import { POSTS_DIR, slugify } from "../../src/lib/post-plain";
import type { Slug } from "./protocol";

const TITLE_LIMIT = 70;
const SLUG_LIMIT = 60;

const DASH_RULE = /^ {0,3}(?:(?:[-–—][ \t]*){2,}|—[ \t]*)$/;
const STAR_RULE = /^ {0,3}(?:\*[ \t]*){3,}$/;
const LOW_RULE = /^ {0,3}(?:_[ \t]*){3,}$/;

export const isRuleLine = (line: string): boolean =>
  DASH_RULE.test(line) || STAR_RULE.test(line) || LOW_RULE.test(line);

type Fence = { mark: string; length: number };

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

const openFence = (line: string): Fence | undefined => {
  const [, run = "", info = ""] = FENCE_OPEN.exec(line) ?? [];
  if (!run) return undefined;
  // A backtick in the info string makes this line inline code.
  if (run.startsWith("`") && info.includes("`")) return undefined;
  return { mark: run.charAt(0), length: run.length };
};

const closesFence = ({ line, fence }: { line: string; fence: Fence }) => {
  const run = FENCE_CLOSE.exec(line)?.[1];
  return (
    run !== undefined &&
    run.charAt(0) === fence.mark &&
    run.length >= fence.length
  );
};

const repairCodeLine = (line: string) =>
  line.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replaceAll("—", "--");

const splitLines = (text: string) => text.split(/\r\n?|\n/);

const isBlank = (line: string | undefined) => !line?.trim();

export const normalizeBody = (body: string): string => {
  const lines: string[] = [];
  let fence: Fence | undefined;
  for (const line of splitLines(body)) {
    if (fence) {
      if (closesFence({ line, fence })) {
        fence = undefined;
        lines.push(line);
      } else {
        lines.push(repairCodeLine(line));
      }
      continue;
    }
    fence = openFence(line);
    if (!fence && isRuleLine(line)) {
      if (!isBlank(lines.at(-1))) lines.push("");
      lines.push(`${/^ */.exec(line)?.[0] ?? ""}---`);
      continue;
    }
    lines.push(line);
  }
  const start = lines.findIndex((line) => !isBlank(line));
  if (start === -1) return "";
  const end = lines.findLastIndex((line) => !isBlank(line));
  return `${lines.slice(start, end + 1).join("\n")}\n`;
};

const capTitle = (line: string) => {
  const chars = [...line];
  if (chars.length <= TITLE_LIMIT) return line;
  const head = chars.slice(0, TITLE_LIMIT).join("");
  const space = head.lastIndexOf(" ");
  const kept =
    space > 0 ? head.slice(0, space) : chars.slice(0, TITLE_LIMIT - 1).join("");
  return `${kept.trimEnd()}…`;
};

/** `title` is null when the first line is code or a rule, so the text has no title line. */
const splitPad = (text: string) => {
  const lines = splitLines(text);
  const start = lines.findIndex((line) => !isBlank(line));
  if (start === -1) return undefined;
  const first = lines[start] ?? "";
  if (openFence(first) || isRuleLine(first)) {
    return { title: null, body: normalizeBody(lines.slice(start).join("\n")) };
  }
  const line = first.trim().replace(/^#+\s+/, "");
  const title = capTitle(line);
  const rest = lines.slice(start + 1);
  return {
    title,
    body: normalizeBody((title === line ? rest : [line, ...rest]).join("\n")),
  };
};

const fitSlug = ({ base, suffix }: { base: string; suffix: string }) =>
  `${base.slice(0, SLUG_LIMIT - suffix.length).replace(/-+$/, "")}${suffix}`;

const freeSlug = ({
  title,
  day,
  taken,
}: {
  title: string;
  day: string;
  taken: readonly string[];
}) => {
  const slug = slugify(title);
  const base = !slug || slug === "index" ? `note-${day}` : slug;
  const used = new Set(taken);
  const first = fitSlug({ base, suffix: "" });
  if (!used.has(first)) return first;
  for (let n = 2; ; n += 1) {
    const candidate = fitSlug({ base, suffix: `-${n}` });
    if (!used.has(candidate)) return candidate;
  }
};

const titleLine = (title: string) => `title: ${JSON.stringify(title)}`;

const tagsLine = (tags: readonly string[]) => {
  const clean = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
  if (clean.length === 0) return undefined;
  return `tags: [${clean.map((tag) => JSON.stringify(tag)).join(", ")}]`;
};

const assemble = ({
  open,
  frontmatter,
  body,
}: {
  open: string;
  frontmatter: readonly string[];
  body: string;
}) => `${open}${frontmatter.join("\n")}\n---\n${body ? `\n${body}` : ""}`;

export const newPostFile = ({
  text,
  tags,
  day,
  taken,
}: {
  text: string;
  tags: readonly string[];
  day: string;
  taken: readonly string[];
}): { slug: Slug; path: string; title: string; source: string } | undefined => {
  const pad = splitPad(text);
  if (!pad) return undefined;
  const title = pad.title ?? `Note ${day}`;
  const slug = freeSlug({ title, day, taken }) as Slug;
  const line = tagsLine(tags);
  return {
    slug,
    path: `${POSTS_DIR}/${slug}.md`,
    title,
    source: assemble({
      open: "---\n",
      frontmatter: [
        titleLine(title),
        `pubDate: ${day}`,
        ...(line ? [line] : []),
      ],
      body: pad.body,
    }),
  };
};

const FRONTMATTER = /^(﻿?---\n)([\s\S]*?)\n---[ \t]*(?:\n|$)/;

const entryEnd = ({ lines, start }: { lines: string[]; start: number }) => {
  let end = start + 1;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^(?:[ \t]|-(?:[ \t]|$))/.test(line)) end = index + 1;
    else if (line !== "") break;
  }
  return end;
};

const findEntries = ({ lines, key }: { lines: string[]; key: string }) => {
  const prefix = new RegExp(`^${key}:(?:[ \\t]+(.*))?$`);
  return lines.flatMap((line, start) => {
    const match = prefix.exec(line);
    if (!match) return [];
    const value = match[1]?.trim() ?? "";
    return [{ start, end: entryEnd({ lines, start }), value }];
  });
};

const QUOTED_SCALAR = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')[ \t]*(?:#.*)?$/;
const PLAIN_SCALAR = /^[^\s"'|>[\]{}&*!%@`#]/;

const isOneLineScalar = (value: string) =>
  QUOTED_SCALAR.test(value) || PLAIN_SCALAR.test(value);

const isEditableTags = ({
  lines,
  value,
}: {
  lines: readonly string[];
  value: string;
}) =>
  !value ||
  (value.startsWith("[") && /\][ \t]*(?:#.*)?$/.test(lines.at(-1) ?? ""));

export const revisedPostFile = ({
  text,
  tags,
  current,
}: {
  text: string;
  tags: readonly string[];
  current: string;
}): { title: string; source: string } | undefined => {
  const pad = splitPad(text);
  const match = FRONTMATTER.exec(current);
  if (!pad || !match) return undefined;
  const [, open = "", frontmatter = ""] = match;
  const lines = frontmatter.split("\n");

  const [title, ...moreTitles] = findEntries({ lines, key: "title" });
  if (!title || moreTitles.length > 0) return undefined;
  if (title.end !== title.start + 1 || !isOneLineScalar(title.value)) {
    return undefined;
  }
  const retitled =
    pad.title === null ? lines : lines.with(title.start, titleLine(pad.title));

  const line = tagsLine(tags);
  const [entry, ...moreTags] = findEntries({ lines: retitled, key: "tags" });
  if (moreTags.length > 0) return undefined;
  if (entry) {
    const old = retitled.slice(entry.start, entry.end);
    if (!isEditableTags({ lines: old, value: entry.value })) return undefined;
  }
  const plate = retitled.findIndex((text) => /^plate:/.test(text));
  const tagged = entry
    ? retitled.toSpliced(
        entry.start,
        entry.end - entry.start,
        ...(line ? [line] : []),
      )
    : retitled.toSpliced(
        plate === -1 ? retitled.length : plate,
        0,
        ...(line ? [line] : []),
      );

  return {
    title: pad.title ?? readScalar(title.value),
    source: assemble({ open, frontmatter: tagged, body: pad.body }),
  };
};

const FLOW_LIST = /^\[((?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\]"'])*)\]/;
const FLOW_ITEM = /"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s,][^,]*/g;

const DOUBLE_QUOTED = /^"(?:[^"\\]|\\.)*"/;
const SINGLE_QUOTED = /^'(?:[^']|'')*'/;

const readDoubleQuoted = (quoted: string) => {
  try {
    const parsed: unknown = JSON.parse(quoted);
    return typeof parsed === "string" ? parsed : quoted.slice(1, -1);
  } catch {
    return quoted.slice(1, -1);
  }
};

const readScalar = (raw: string) => {
  const value = raw.trim();
  const double = DOUBLE_QUOTED.exec(value)?.[0];
  if (double) return readDoubleQuoted(double);
  const single = SINGLE_QUOTED.exec(value)?.[0];
  if (single) return single.slice(1, -1).replaceAll("''", "'");
  return value.replace(/\s+#.*$/, "");
};

export const readTags = (source: string): string[] => {
  const frontmatter = FRONTMATTER.exec(source.replaceAll("\r\n", "\n"))?.[2];
  if (frontmatter === undefined) return [];
  const lines = frontmatter.split("\n");
  const [entry, ...others] = findEntries({ lines, key: "tags" });
  if (!entry || others.length > 0) return [];
  const nested = lines.slice(entry.start + 1, entry.end);
  const items = entry.value
    ? [
        ...(
          FLOW_LIST.exec([entry.value, ...nested].join(" "))?.[1] ?? ""
        ).matchAll(FLOW_ITEM),
      ].map(([item]) => item)
    : nested.flatMap((line) => /^\s*-\s+(.+)$/.exec(line)?.[1] ?? []);
  return items.map(readScalar).filter(Boolean);
};
