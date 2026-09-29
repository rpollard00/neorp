// @ts-check
import { defineConfig } from "astro/config";

import mdx from "@astrojs/mdx";

// https://astro.build/config
export default defineConfig({
  site: "https://reesep.com",
  integrations: [mdx()],
  markdown: {
    shikiConfig: {
      theme: "tokyo-night",
    },
  },
});
