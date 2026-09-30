import { z } from "astro/zod";
import { SITE } from "../site";
import { PALETTE_NAMES } from "./palettes";

/** The site's content collection and `bun post` both read posts from here. */
export const POSTS_DIR = "src/content/posts";

/** The slug is the file path minus the extension, so it can't drift from the file name. */
export const slugFromPath = (path: string) =>
  path
    .replace(/\.mdx?$/i, "")
    .replace(/\/index$/, "") // a folder's index keeps the folder's slug
    .toLowerCase()
    .replace(/\s+/g, "-");

export const postSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  /**
   * No date is a draft. A date after today is scheduled. An empty `pubDate:`
   * counts as no date. YAML parses a date as UTC midnight; any other string
   * fails here instead of becoming a guess.
   */
  pubDate: z.preprocess((value) => value ?? undefined, z.date().optional()),
  tags: z.array(z.string()).optional(),
  plate: z.enum(PALETTE_NAMES).optional(),
});

export type PostData = z.infer<typeof postSchema>;

export type PostState =
  | { kind: "draft" }
  | { kind: "scheduled"; date: Date }
  | { kind: "published"; date: Date };

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

/**
 * A post goes live on the first build on or after its date, in the site's
 * timezone.
 */
export const postState = (
  { pubDate }: Pick<PostData, "pubDate">,
  now: Date,
): PostState => {
  if (!pubDate) return { kind: "draft" };
  if (formatDay(pubDate) > formatDay(siteToday(now)))
    return { kind: "scheduled", date: pubDate };
  return { kind: "published", date: pubDate };
};
