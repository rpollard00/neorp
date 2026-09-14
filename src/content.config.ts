import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const slugFromPath = ({ entry }: { entry: string }) =>
  entry
    .replace(/\.mdx?$/i, "") // strip the extension
    .replace(/\/index$/, "") // a folder's index keeps the folder's slug
    .toLowerCase()
    .replace(/\s+/g, "-");

const posts = defineCollection({
  loader: glob({
    pattern: "**/*.{md,mdx}",
    base: "./src/content/posts",
    generateId: slugFromPath,
  }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    pubDate: z.coerce.date(),
    tags: z.array(z.string()).optional(),
  }),
});

export const collections = { posts };
