import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { postSchema } from "./lib/post";
import { POSTS_DIR, slugFromPath } from "./lib/post-plain";

const posts = defineCollection({
  loader: glob({
    pattern: "**/*.{md,mdx}",
    base: `./${POSTS_DIR}`,
    generateId: ({ entry }) => slugFromPath(entry),
  }),
  schema: postSchema,
});

export const collections = { posts };
