// @ts-check
import { readFileSync } from "node:fs";
import { defineConfig } from "astro/config";

import mdx from "@astrojs/mdx";
import { satteri } from "@astrojs/markdown-satteri";
import { LINK_CARDS_PATH, linkCardsPlugin } from "./src/lib/link-cards.ts";
import { imageFiguresPlugin } from "./src/lib/image-figures-plugin.ts";
import { SITE } from "./src/site.ts";

/** Read on each compile, so `astro dev` sees new cards. @returns {import("./src/lib/link-cards.ts").LinkCards} */
const readLinkCards = () =>
  JSON.parse(readFileSync(new URL(LINK_CARDS_PATH, import.meta.url), "utf8"));

// https://astro.build/config
export default defineConfig({
  site: SITE.url,
  integrations: [mdx()],
  markdown: {
    processor: satteri({
      mdastPlugins: [
        imageFiguresPlugin,
        () => linkCardsPlugin({ cards: readLinkCards() }),
      ],
    }),
    shikiConfig: {
      theme: "tokyo-night",
    },
  },
});
