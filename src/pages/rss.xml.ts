import rss from "@astrojs/rss";
import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { SITE } from "../site";
import { postUrl, sortPosts } from "../utils/posts";

export const GET: APIRoute = async ({ site }) => {
  if (!site)
    throw new Error(
      "Set `site` in astro.config.mjs: feed links must be absolute.",
    );
  const posts = sortPosts(await getCollection("posts"));
  return rss({
    title: SITE.name,
    description: SITE.description,
    site,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      categories: post.data.tags,
      link: postUrl(post),
    })),
  });
};
