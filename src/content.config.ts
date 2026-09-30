import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { POSTS_DIR, postSchema, slugFromPath } from "./lib/post";

const posts = defineCollection({
  loader: glob({
    pattern: "**/*.{md,mdx}",
    base: `./${POSTS_DIR}`,
    generateId: ({ entry }) => slugFromPath(entry),
  }),
  schema: postSchema,
});

export const collections = { posts };
