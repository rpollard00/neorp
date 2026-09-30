# Design

Status: **established**. The user approved this direction from mockups on
2026-09-28 and accepted the rendered site on the same day. Change a rule only
when the user approves the change.

Next open question: typeface choices.

## Character

- Writing first. The reading column is calm. Decoration stays at the edges
  of the page and in one image per post.
- Graphic, not soft. Flat colour, hard edges, square corners, uppercase
  display type, mono labels. The influence is the graphic design of Marathon
  (2026), without its density.
- Pixel art with no blended pixels. Every pixel is one flat colour. Fades use
  an ordered (Bayer) dither. The influence is Michael Micasso's dithered light.
- Clean dither only. Use regular ordered patterns (the header and footer edges,
  the checker). Do not use ragged or noisy fades.

## Colour

Raw values live in `src/layouts/Layout.astro` (`:root`). The site has two
themes:

- Light: a paper page, ink text, and an ultramarine accent.
- Dark: a graphite page, light text, and a magenta accent. The influence is the
  menu screens of Marathon (2026), which use mid graphite, not black.

| Token               | Light     | Dark      | Meaning                                                           |
| ------------------- | --------- | --------- | ----------------------------------------------------------------- |
| `--page`            | `#f5f0e6` | `#3b3a45` | Page background.                                                  |
| `--text`            | `#1c1a24` | `#e9e8ee` | Text, rules, the checker, and the focus outline on the page.      |
| `--muted`           | `#5f596b` | `#b9b8c8` | Secondary text: dates, descriptions, labels.                      |
| `--pop`             | `#2b3dff` | `#cc0078` | The accent as a fill. Ultramarine in light, magenta in dark.      |
| `--on-pop`          | `#f5f0e6` | `#f5f0e6` | Text on a `--pop` fill.                                           |
| `--pop-text`        | `#2b3dff` | `#ff85c2` | The accent as text on the page: links and hover titles.           |
| `--chrome`          | `#1c1a24` | `#1c1a24` | The header, the footer, the dither edge, and the plate label bar. |
| `--on-chrome`       | `#f5f0e6` | `#f5f0e6` | Text and focus outlines on `--chrome`.                            |
| `--muted-on-chrome` | `#a7a1b3` | `#a7a1b3` | Secondary text on `--chrome`, for example the plate palette name. |

Rules:

- Each theme has one interface accent. Use `--pop` in these places only: the
  wordmark tile, the kicker label, tags, the "New" tag, plate ID chips, and
  section-heading squares. Use `--pop-text` for link text and hover titles.
- The chrome fields are the same in both themes. Only the page changes. Fills
  on the chrome (the wordmark tile, the plate ID chip) follow the accent.
- Overscroll past the header or footer shows `--chrome`, so a bounce continues
  the chrome field. A page that does not scroll keeps a `--page` canvas, so the
  empty scrollbar gutter stays page-coloured.
- Put text on `--pop` as a fill with `--on-pop` text: 5.75:1 in light, 4.82:1
  in dark. `--pop-text` on the page is 5.75:1 in light and 5.00:1 in dark.
- Do not use `--pop` as text or pixels on `--chrome` (2.6:1 in light). Do not
  use `--pop` as text on the page in dark (2.04:1). Use `--pop-text`.
- Do not use Marathon's raw magenta `#ea027e`. Paper text on it is 3.85:1.
- Links in prose are `--pop-text` with a 2px underline. On hover they become a
  `--pop` fill with `--on-pop` text. Do not use a highlight fill behind body
  text.
- Sky colours (the plate palettes) appear only inside plates. They never
  colour the interface.
- Code blocks use the Shiki `tokyo-night` theme in both themes. On the graphite
  page, a code block is a dark panel.

## Theme

- The site follows the colour scheme of the operating system
  (`prefers-color-scheme`). Each themed token is one `light-dark()` value.
- The theme toggle stores an override in `localStorage` under the key `theme`.
  The override is `data-theme="light"` or `data-theme="dark"` on `<html>`, and
  it sets `color-scheme`.
- An inline script at the top of `<head>` applies a stored override before the
  first paint.
- When the user toggles back to the scheme of the system, the site removes the
  override. The site then follows the system again.
- Browsers without `light-dark()` get the light theme and no toggle.

## Type

- Display: heavy sans, uppercase (`h1`, `h2`, cover title).
- Body: neutral sans.
- Labels: mono, uppercase, letter-spaced (nav, dates, meta, section labels).
- The font stacks are placeholders. The typeface choice is still open.

## Modules

- **Wordmark** (`src/components/Wordmark.astro`): the word "neorp" drawn on a
  5×7 pixel grid, on a `--pop` tile in `--on-pop` pixels. The tile has 2 grid
  units of padding at the top and sides and none at the bottom. The
  descender of the "p" runs to the bottom edge of the tile. This is
  intentional: it centres the x-height in the tile.
- **Chrome edge**: the header and footer are `--chrome` fields. Their inner
  edge is a 12-row ordered dither into the page. It is the dither mask from
  `scripts/generate-dither-mask.mjs`, painted in `--chrome`. The footer uses the
  same mask flipped.
- **Checker**: a `--text` checkerboard with 2px squares. It is the blockquote bar
  (8px wide) and the break under the article intro (8px tall, full column
  width).
- **Plate** (`src/lib/plates.ts`, served at `/plates/<slug>.png`): a 160×60
  pixel landscape made from a named palette and a seed. The build generates one
  for each post. It shows at whole-pixel scales only: 5× for the article plate
  on wide screens, 4× on desktop, 3× on small tablets, 2× on phones. The
  breakpoints are in `src/components/Plate.astro`. Below 360px the plate
  shrinks under 2×. A `--chrome` label bar under the plate shows the plate
  number, a date or "Latest", and the palette name.
- **Theme toggle** (`src/components/ThemeToggle.astro`): a 7×7 pixel circle
  with the right half filled, at 2px for each cell. It is the last item in the
  masthead nav. When the dark theme is on, the icon is mirrored.
  `aria-pressed` gives the state, and the accessible name is "Dark mode". The
  button stays hidden without JavaScript.
- **Palettes**: 11 named skies. A post sets one with `plate:` in its
  frontmatter. Without it, the slug selects a palette. The slug also seeds the
  shape of the landscape.

## Composition

- Home: kicker label, title, intro, then the newest post as a cover plate,
  then a numbered list of earlier posts.
- Article: wide plate (wider than the text column on desktop), meta and tags,
  title, dek, checker break, body.
- Section headings in an article have a 12px `--pop` square with no border.
- Rules: 2px `--text` under section labels, 1px `--text` between list rows.

## Reference surfaces

Check each surface in both themes.

- `/` (home, cover plate)
- `/posts/posters-disease/` (article)
- `/posts/` (post list)
