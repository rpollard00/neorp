import { getCollection, type CollectionEntry } from "astro:content";
import { postState, type PostState } from "../lib/post";

export type Post = CollectionEntry<"posts">;

export type PublishedPost = Post & { data: { pubDate: Date } };

export type NumberedPost = {
  post: PublishedPost;
  /** 1 is the oldest post. */
  number: number;
};

type UnpublishedState = Exclude<PostState, { kind: "published" }>;

/** What a post page shows. Only `astro dev` renders drafts and scheduled posts. */
export type PostStatus =
  UnpublishedState | { kind: "published"; date: Date; number: number };

const isPublished = (post: Post, now: Date): post is PublishedPost =>
  postState(post.data, now).kind === "published";

/** Lists, the feed, and the build only ever see these. */
export const getPublishedPosts = async (now: Date) =>
  (await getCollection("posts")).filter((post) => isPublished(post, now));

export const getUnpublishedPosts = async (now: Date) =>
  (await getCollection("posts")).flatMap((post) => {
    const state = postState(post.data, now);
    return state.kind === "published" ? [] : [{ post, state }];
  });

/** Post URLs come from the slug, which is the file path minus the extension. */
export const postUrl = (post: Post) => `/posts/${post.id}/`;

/**
 * `pubDate` is UTC midnight, so format in UTC. Formatting in the
 * build machine's local time shifts the day for anyone off UTC.
 */
const UTC = { timeZone: "UTC" } as const;

/** 14 Sep 2026. */
export const formatDate = (date: Date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    ...UTC,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value;
  return `${part("day")} ${part("month")} ${part("year")}`;
};

/** Machine-readable date for the `datetime` attribute: 2026-09-14. */
export const formatDateAttr = (date: Date) => date.toISOString().slice(0, 10);

/** 14.09.2026. */
export const formatPlateDate = (date: Date) =>
  formatDateAttr(date).split("-").reverse().join(".");

export const formatNumber = (number: number) => String(number).padStart(2, "0");

/**
 * Newest first. Posts with the same date sort by slug, so post numbers do not
 * change between builds.
 */
export const sortPosts = (posts: PublishedPost[]) =>
  [...posts].sort(
    (a, b) =>
      b.data.pubDate.getTime() - a.data.pubDate.getTime() ||
      a.id.localeCompare(b.id),
  );

export const numberPosts = (posts: PublishedPost[]): NumberedPost[] =>
  sortPosts(posts).map((post, index, all) => ({
    post,
    number: all.length - index,
  }));

const WORDS_PER_MINUTE = 230;

export const readingMinutes = (post: Post) => {
  const words = post.body?.split(/\s+/).filter(Boolean).length ?? 0;
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
};
