import { z } from "astro/zod";
import { PALETTE_NAMES } from "./palettes";
import { formatDay, siteToday } from "./post-plain";

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
