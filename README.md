# neorp

Personal site. Astro + Markdown/MDX, built static.

## Writing

`bun post` starts, lists, and publishes posts:

```sh
bun post new My post title          # src/content/posts/my-post-title.md, opened in $VISUAL or $EDITOR
bun post new My post title --folder # my-post-title/index.md, for images next to the post
bun post list                       # every post with its state, date, and word count
bun post plate my-post-title        # pick the plate's palette
bun post publish                    # pick a draft, fill in what it needs, and ship it
bun post publish my-post-title --on 2026-10-05
```

A new post is a draft with only a title. `astro dev` shows it at
`/posts/<slug>/`. Any slug argument can also be the path to the post's file,
from the repo root or absolute (`%:p` in nvim).

`bun post publish` asks for the description, tags, plate, and date (today, or
`--on`) and writes them into the frontmatter. Then it moves the post's file out
of the working copy into a new commit directly below it: `post: <title>`, or
`post: revise <title>` for a post that was already live. A post in its own
folder (`<slug>/index.md`) moves with the whole folder. The working copy keeps
its change ID and description.

Next it builds that commit, the one that ships, in a temporary jj workspace. If
the build fails, or the post's page is not in `dist/` when it should be (or is
when it is scheduled), it undoes everything: the post goes back into the working
copy, the file gets its old text back, and the repo is as it was before. If the
build passes, it moves `main` to the commit and pushes `main`. `--yes` skips each
question that already has an answer.

Before it asks anything, it checks that `main` is below your working copy. If
`main` has moved elsewhere, rebase onto it first (`jj rebase -d main`).

Everything below your working copy ships. Edits in your working copy that
aren't this post stay put.

You can also write a `.md` or `.mdx` file in `src/content/posts/` by hand. The
file name is the slug:

| File                               | URL                   |
| ---------------------------------- | --------------------- |
| `src/content/posts/hello-world.md` | `/posts/hello-world/` |
| `src/content/posts/notes/foo.mdx`  | `/posts/notes/foo/`   |

A `slug:` in frontmatter is ignored on purpose — a post can't drift away from
the name of its file. The frontmatter schema is `postSchema` in `src/lib/post.ts`:

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

A scheduled post goes live on the first build on or after its date, in the
site's timezone (`SITE.timeZone` in `src/site.ts`, America/Los_Angeles).

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
`src/lib/plates.ts`. The site name, URL, and description and the feed path are
in `src/site.ts`. `bun post` is in `scripts/post/`.

The RSS feed lists every post with its title, description, date, and tags. Feed
links must be absolute, so the feed uses `site` in `astro.config.mjs`, which
comes from `SITE.url` in `src/site.ts` (`https://reesep.com`). If the domain
changes, change `SITE.url`. The build fails if `site` is not set.

## Hosting on Cloudflare Workers

Astro builds static files into `dist/`. Workers Static Assets serves these files
without a Worker script or an Astro adapter. Missing URLs return HTTP 404 instead
of the home page.

Workers Builds selects Bun from `bun.lock`. The `packageManager` field pins Bun
to 1.4.3, and `.node-version` pins Node to 24.19.0.

Before clicking **Deploy**, commit these deployment files and push them to the
connected production branch. Local changes are not available to Workers Builds.
Use these dashboard values:

| Field           | Value                    |
| --------------- | ------------------------ |
| Project name    | `neorp`                  |
| Root directory  | Repository root          |
| Build command   | `bun run build`          |
| Deploy command  | `bun run deploy`         |
| Preview command | `bun run deploy:preview` |
| Preview builds  | Enabled                  |

Workers initially selects the repository's default branch for production.
After creation, select the production branch under **Settings > Build > Branch control**.
Keep custom domains unconfigured until you verify the temporary `workers.dev` URL.

Both deployment commands use the installed Wrangler and expect an existing build
in `dist/`. For local inspection, run `bun run build`. Then run `bun run preview`.
The Astro preview command serves the build locally. `bun run deploy:preview`
uploads a Cloudflare Preview. Normal builds and previews exclude drafts and
future posts. Scheduled posts require a rebuild on or after their publication date.

References: [Astro deployment](https://docs.astro.build/en/guides/deploy/cloudflare/),
[Workers Static Assets](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/#use-workers-static-assets-for-new-projects),
[SSG routing](https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/),
[Preview builds](https://developers.cloudflare.com/workers/previews/examples/),
[build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/),
and [branch control](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/).

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
| `bun post help`   | Writing and publishing posts   |
| `bun test`        | Tests for `bun post`           |
| `bunx prettier .` | Format                         |

The post route is a rest parameter (`[...slug].astro`) so posts in subfolders of
`src/content/posts/` build too. A plain `[slug].astro` fails the build with
`Missing parameter: slug` as soon as one nested file shows up.
