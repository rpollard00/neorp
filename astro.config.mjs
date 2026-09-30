// @ts-check
import { defineConfig } from "astro/config";

import mdx from "@astrojs/mdx";
import { SITE } from "./src/site.ts";

// https://astro.build/config
export default defineConfig({
  site: SITE.url,
  integrations: [mdx()],
  markdown: {
    shikiConfig: {
      theme: "tokyo-night",
    },
  },
});
