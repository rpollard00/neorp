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
pubDate: 2026-09-14 # optional; undated posts sort to the bottom
tags: [demo] # optional
---
```

MDX files can import components: `import Foo from "../../components/Foo.astro"`.

## Routes

| Path             | Source                            |
| ---------------- | --------------------------------- |
| `/`              | `src/pages/index.astro`           |
| `/posts/`        | `src/pages/posts/index.astro`     |
| `/posts/<slug>/` | `src/pages/posts/[...slug].astro` |
| `/about/`        | `src/pages/about.astro`           |

Shared chrome (head, nav, base type styles) is in `src/layouts/Layout.astro`.
`src/layouts/PostLayout.astro` wraps a single post. List helpers live in
`src/utils/posts.ts`.

## Background

The page is one solid colour. The header band starts as a second solid colour
and ends in an ordered dither back into the body colour. No pixel of the band
is a blend of the two.

| Token           | Role                                              |
| --------------- | ------------------------------------------------- |
| `--bg`          | body colour; the whole page below the header band |
| `--bg-header`   | solid colour at the top, dithered into `--bg`     |
| `--header-band` | height of the band: solid part plus dither        |

Retheming is only the first two values, in `src/layouts/Layout.astro`.

Dither dots are `--header-band` / 40, so one token sets both dot size and how
far the dither reaches down the page. The mask decides the shape of the ramp
instead, and is generated, not hand-edited:

| Command                         | Effect                                       |
| ------------------------------- | -------------------------------------------- |
| `bun run dither`                | regenerate the shipped mask                  |
| `bun run dither -- --hold 0.4`  | start dithering higher, shorter solid header |
| `bun run dither -- --width 240` | mask tiles half as wide, same dot size       |

`--hold` and `--header-band` are a pair: 0.62 of the band is held solid, which
covers the nav, and the rest dithers into the body colour. `header`'s
`margin-bottom` sets how much room the dither has before the `h1`. Keep the
gradient vertical (the default `--angle 270`): the mask is tiled horizontally,
so a tilted gradient would restart in every tile.

The generator writes two files:

- `src/styles/dither-mask.css` — the mask as a data URI, imported by
  `Layout.astro`. It is inlined in the built HTML, so the band paints on the
  first frame. A `mask-image` is not render-blocking, so fetching the mask as a
  file instead lets the band paint solid for a frame before it dithers.
- `public/dither-mask.png` — the same bytes, for eyeballing at
  `/dither-mask.png`. Nothing loads it at runtime.

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
