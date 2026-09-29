# Design

Status: **established**. The user approved this direction from mockups on
2026-09-28 and accepted the rendered site on the same day. Change a rule only
when the user approves the change.

Next open questions: dark mode and typeface choices.

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

Raw values live in `src/layouts/Layout.astro` (`:root`).

| Token            | Meaning                                                               |
| ---------------- | --------------------------------------------------------------------- |
| `--paper`        | Page background.                                                      |
| `--ink`          | Text, rules, header and footer fields, dither.                        |
| `--muted`        | Secondary text: dates, descriptions, labels.                          |
| `--pop`          | Ultramarine. The only interface accent.                               |
| `--on-pop`       | Text on a `--pop` fill. It is paper, because the pop is dark.         |
| `--muted-on-ink` | Secondary text on ink, for example the palette name on a plate label. |

Rules:

- Use `--pop` in these places only: the wordmark tile, the kicker label,
  tags, the "New" tag, plate ID chips, section-heading squares, and link text.
- Put text on `--pop` as a fill with `--on-pop` text (5.75:1). `--pop` as text
  on paper is also 5.75:1. Do not use `--pop` as text or pixels on `--ink`
  (2.6:1).
- Links in prose are `--pop` text with a 2px underline. Do not use a
  highlight fill behind ink text.
- Sky colours (the plate palettes) appear only inside plates. They never
  colour the interface.

## Type

- Display: heavy sans, uppercase (`h1`, `h2`, cover title).
- Body: neutral sans.
- Labels: mono, uppercase, letter-spaced (nav, dates, meta, section labels).
- The font stacks are placeholders. The typeface choice is still open.

## Modules

- **Wordmark** (`src/components/Wordmark.astro`): the word "neorp" drawn on a
  5×7 pixel grid, on an ultramarine tile in paper-coloured pixels. The tile has
  2 grid units of padding at the top and sides and none at the bottom. The
  descender of the "p" runs to the bottom edge of the tile. This is
  intentional: it centres the x-height in the tile.
- **Ink edge**: the header and footer are ink fields. Their inner edge is a
  12-row ordered dither into the paper. It is the dither mask from
  `scripts/generate-dither-mask.mjs`, painted in `--ink`. The footer uses the
  same mask flipped.
- **Checker**: an ink checkerboard with 2px squares. It is the blockquote bar
  (8px wide) and the break under the article intro (8px tall, full column
  width).
- **Plate** (`src/lib/plates.ts`, served at `/plates/<slug>.png`): a 160×60
  pixel landscape made from a named palette and a seed. The build generates one
  for each post. It shows at whole-pixel scales only: 5× for the article plate
  on wide screens, 4× on desktop, 3× on small tablets, 2× on phones. The
  breakpoints are in `src/components/Plate.astro`. Below 360px the plate
  shrinks under 2×. An ink label bar under the plate shows the plate number, a date
  or "Latest", and the palette name.
- **Palettes**: 11 named skies. A post sets one with `plate:` in its
  frontmatter. Without it, the slug selects a palette. The slug also seeds the
  shape of the landscape.

## Composition

- Home: kicker label, title, intro, then the newest post as a cover plate,
  then a numbered list of earlier posts.
- Article: wide plate (wider than the text column on desktop), meta and tags,
  title, dek, checker break, body.
- Section headings in an article have a 12px ultramarine square with no border.
- Rules: 2px ink under section labels, 1px ink between list rows.

## Reference surfaces

- `/` (home, cover plate)
- `/posts/posters-disease/` (article)
- `/posts/` (post list)
