import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { postSchema } from "./lib/post";
import { POSTS_DIR, slugFromPath } from "./lib/post-plain";

const posts = defineCollection({
  loader: glob({
    pattern: "**/*.{md,mdx}",
    base: `./${POSTS_DIR}`,
    // Eager Markdown rendering logs errors but can build an empty article.
    deferRender: true,
    generateId: ({ entry }) => slugFromPath(entry),
  }),
  schema: postSchema,
});

export const collections = { posts };
