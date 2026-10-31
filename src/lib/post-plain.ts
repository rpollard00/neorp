import { SITE } from "../site";

export const POSTS_DIR = "src/content/posts";

export const slugFromPath = (path: string) =>
  path
    .replace(/\.mdx?$/i, "")
    .replace(/\/index$/, "")
    .toLowerCase()
    .replace(/\s+/g, "-");

export const slugify = (title: string) =>
  title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const formatDay = (date: Date) => date.toISOString().slice(0, 10);

export const siteToday = (now: Date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SITE.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return new Date(Date.UTC(part("year"), part("month") - 1, part("day")));
};
