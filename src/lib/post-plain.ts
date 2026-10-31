// No bare imports: the composer server process that holds the deploy key loads
// this file.
import { SITE } from "../site";

/** The site's content collection and `bun post` both read posts from here. */
export const POSTS_DIR = "src/content/posts";

/** The slug is the file path minus the extension, so it can't drift from the file name. */
export const slugFromPath = (path: string) =>
  path
    .replace(/\.mdx?$/i, "")
    .replace(/\/index$/, "") // a folder's index keeps the folder's slug
    .toLowerCase()
    .replace(/\s+/g, "-");

export const slugify = (title: string) =>
  title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** YYYY-MM-DD of a date at UTC midnight, such as `pubDate`. */
export const formatDay = (date: Date) => date.toISOString().slice(0, 10);

/** Today's date in the site's timezone, as UTC midnight like `pubDate`. */
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
