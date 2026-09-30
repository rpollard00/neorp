# neorp

Personal site. Astro + Markdown/MDX, built static.

## Writing

Drop a `.md` or `.mdx` file in `src/content/posts/`. The file name is the slug:

| File                               | URL                   |
| ---------------------------------- | --------------------- |
| `src/content/posts/hello-world.md` | `/posts/hello-world/` |
| `src/content/posts/notes/foo.mdx`  | `/posts/notes/foo/`   |

A `slug:` in frontmatter is ignored on purpose — a post can't drift away from
the name of its file. Frontmatter schema lives in `src/content.config.ts`:

```yaml
---
title: Post title # required
description: One line shown in the list and in <meta>
pubDate: 2026-09-14 # optional; see below
tags: [demo] # optional
plate: dusk # optional; the palette of the plate
---
```

`pubDate` sets whether a post is live:

| `pubDate`       | State     | `astro dev`         | Build, lists, RSS, numbering |
| --------------- | --------- | ------------------- | ---------------------------- |
| missing         | draft     | renders, with a tag | left out                     |
| in the future   | scheduled | renders, with a tag | left out until that date     |
| today or before | published | renders             | included                     |

A scheduled post goes live on the first build on or after its date.

Each post has a plate: a 160×60 pixel landscape that the build draws from a
palette and a seed. The palette names are in `src/lib/palettes.ts`. If a post
has no `plate:`, the slug selects the palette. The slug also sets the shape of
the landscape. Posts get numbers by date. The oldest post is 01.

MDX files can import components: `import Foo from "../../components/Foo.astro"`.

## Routes

| Path                 | Source                              |
| -------------------- | ----------------------------------- |
| `/`                  | `src/pages/index.astro`             |
| `/posts/`            | `src/pages/posts/index.astro`       |
| `/posts/<slug>/`     | `src/pages/posts/[...slug].astro`   |
| `/about/`            | `src/pages/about.astro`             |
| `/plates/<slug>.png` | `src/pages/plates/[...slug].png.ts` |
| `/rss.xml`           | `src/pages/rss.xml.ts`              |

Shared chrome (head, header, footer, tokens, base styles) is in
`src/layouts/Layout.astro`. `src/layouts/PostLayout.astro` wraps a single post.
List helpers live in `src/utils/posts.ts`. The plate drawing code is in
`src/lib/plates.ts`. The site name, the site description, and the feed path are
in `src/site.ts`.

The RSS feed lists every post with its title, description, date, and tags. Feed
links must be absolute, so the feed uses `site` in `astro.config.mjs`
(`https://reesep.com`). If the domain changes, change `site`. The build fails if
`site` is not set.

## Header and footer edge

The header and the footer are solid `--chrome` fields on a `--page` background.
Each field ends in an ordered dither into the page. No pixel of the edge is a
blend of the two colours.

The edge is an element that paints `--chrome` through a colourless mask. One mask
pixel is one dither dot of `--px` (4px, or 3px on narrow screens). The mask has
12 rows, so the edge is `12 * --px` tall. The footer uses the same mask, flipped
vertically. The colour tokens are in `:root` in `src/layouts/Layout.astro`.
`DESIGN.md` gives the rules for each token.

The mask is generated, not hand-edited. This command makes the shipped mask:

```sh
bun run dither -- --width 64 --height 12 --hold 0
```

| Argument      | Effect                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--width 64`  | Width of one mask tile, in dots. The dither pattern repeats every 8 dots, so this value sets only the tile size.                                                                             |
| `--height 12` | Number of dither rows. It must match the `12` in the `.edge` height in `Layout.astro`. The mask size there is one row more (`13`), because the SVG repeats its last row once below the mask. |
| `--hold 0`    | No solid rows in the mask. The chrome field is the solid part, so the dither starts on the first row.                                                                                        |
| `--angle`     | Not given, so 270. Coverage increases from bottom to top, and the mask is opaque at the top.                                                                                                 |

Do not run `bun run dither` without arguments. The defaults (480×40, hold 0.62)
make a different mask that does not fit the edge. Keep the gradient vertical.
The mask tiles horizontally, so a tilted gradient starts again in each tile.

The mask is an SVG of square runs, not a PNG. Safari on iOS ignores
`image-rendering` for a mask and smooths a scaled PNG, so a PNG mask shows
blurred dots on an iPhone. Keep `image-rendering: pixelated` on `.edge`:
Chromium needs it to keep the SVG dots sharp at fractional device scales, such
as 2.625 on many Android phones.

The generator writes two files:

- `src/styles/dither-mask.css`: the mask as a data URI in `--dither-mask`.
  `Layout.astro` imports it, so the mask is part of the site stylesheet and
  the edge needs no extra request before it paints.
- `public/dither-mask.svg`: the same markup, for inspection at
  `/dither-mask.svg`. Nothing loads it at runtime.

The checker (the blockquote bar and the break under the article intro) uses the
same method. It paints `--text` through `--checker-mask`, a 2×2 SVG shown at
4px × 4px, so each square is 2px.

## Commands

| Command           | Action                         |
| ----------------- | ------------------------------ |
| `bun dev`         | Dev server at `localhost:4321` |
| `bun run build`   | Production build to `./dist/`  |
| `bun run preview` | Preview the build              |
| `bunx prettier .` | Format                         |

The post route is a rest parameter (`[...slug].astro`) so posts in subfolders of
`src/content/posts/` build too. A plain `[slug].astro` fails the build with
`Missing parameter: slug` as soon as one nested file shows up.
