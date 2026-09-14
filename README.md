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
