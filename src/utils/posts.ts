import type { CollectionEntry } from "astro:content";

export type Post = CollectionEntry<"posts">;

/** Post URLs come from the slug, which is the file path minus the extension. */
export const postUrl = (post: Post) => `/posts/${post.id}/`;

/**
 * `pubDate` is coerced to UTC midnight, so format in UTC. Formatting in the
 * build machine's local time shifts the day for anyone off UTC.
 */
const UTC = { timeZone: "UTC" } as const;

export const formatDate = (date: Date) =>
  date.toLocaleDateString("en-US", {
    ...UTC,
    year: "numeric",
    month: "long",
    day: "numeric",
  });

/** Machine-readable date for the `datetime` attribute: 2026-09-14. */
export const formatDateAttr = (date: Date) => date.toISOString().slice(0, 10);

/** Newest first. Undated posts fall to the bottom. */
export const sortPosts = (posts: Post[]) =>
  [...posts].sort(
    (a, b) =>
      (b.data.pubDate?.getTime() ?? 0) - (a.data.pubDate?.getTime() ?? 0),
  );
