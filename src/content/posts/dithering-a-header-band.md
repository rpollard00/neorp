---
title: Dithering a header band in plain CSS
description: One mask, two colour tokens, and not a single blended pixel.
pubDate: 2026-09-16
tags: [css, pixels]
plate: dusk
---

I wanted the top of this site to fade into the page the way old games faded a sky into the ground. A CSS gradient can't do that. It blends, and a blended pixel is the exact thing I was trying to avoid.

So the header is two flat colours and a mask. Every pixel is one colour or the other. The fade comes from how many pixels of each you get per row.

## The mask

The mask is a 1-bit ordered dither of a vertical ramp. A script builds it from a Bayer matrix, writes a PNG, and inlines the same bytes as a data URI, so the edge paints on the first frame.

```css
.edge {
  background: var(--ink);
  mask-image: var(--dither-mask);
  mask-size: auto calc(12 * var(--px));
  mask-repeat: repeat-x;
  image-rendering: pixelated;
}
```

One mask pixel is one dot on screen. Change `--px` and the dots grow with it, so a single token sets the dot size and how far the dither reaches.

## What went wrong first

- I fetched the mask as a file, which cost an extra request for something about 100 bytes long.
- I tilted the gradient. The mask tiles sideways, so every tile restarted the ramp and the seams showed.
- I put `image-rendering: pixelated` on the wrong element and spent an evening arguing with antialiasing.

> No pixel of the edge is a blend of the two.

That line is in the README now, mostly so I stop breaking it.

---

## Retheming

Swap two tokens and the whole edge changes colour. The mask has no colour of its own, which is the only reason this stayed simple:

1. Pick the two colours.
2. Point `background` at one and let the page show through as the other.
3. Leave the mask alone.

The generator is about a hundred lines of Node with no dependencies, and [the source is on GitHub](https://github.com/) if you want to take it.
