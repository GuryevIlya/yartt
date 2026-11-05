# Brand

The mark is a tag with a check, made a rocket — a sharp nose, two fins,
flames behind — taking off: tasks are named
by tags, each has one owner who sees it done, and done tasks are how a
product gets built and shipped (decision 30). Next to the mark goes the
product name in the reader's language: **yartt** in English, **яртт** in
Russian.

## Files

The SVGs are the source; everything else is rendered from them. The text in
the logos is in outlines (Roboto Bold), so it looks the same without the
font.

| What | Light background | Dark background | One color |
|---|---|---|---|
| The mark | [mark.svg](mark.svg) | [mark.svg](mark.svg) | [mark-black.svg](mark-black.svg), [mark-white.svg](mark-white.svg) |
| The logo, English | [logo-en.svg](logo-en.svg) | [logo-en-on-dark.svg](logo-en-on-dark.svg) | [logo-en-black.svg](logo-en-black.svg), [logo-en-white.svg](logo-en-white.svg) |
| The logo, Russian | [logo-ru.svg](logo-ru.svg) | [logo-ru-on-dark.svg](logo-ru-on-dark.svg) | [logo-ru-black.svg](logo-ru-black.svg), [logo-ru-white.svg](logo-ru-white.svg) |

- [png/](png/) — the mark from 16 to 1024 px (`mark-<size>.png`; 180 is the
  iOS icon, 192 and 512 are the Android and PWA ones), the one-color marks
  at 64 and 512, every logo at 64 and 256 px high. Transparent background.
- [pdf/](pdf/) — vector files for print: the mark and the logos, in color
  and in black.
- [favicon.ico](favicon.ico) — 16, 32 and 48 px for old browsers.

The app uses its own copies: `client/public/favicon.svg`, `favicon.ico`,
`apple-touch-icon.png` (on white: iOS fills transparency with black),
`icon-192.png`, `icon-512.png`, `icon-maskable-512.png` (on white, the
rocket within the middle 80% a launcher may crop to) and the `Mark`
component in `client/components/App/Logo.tsx`. Change the mark there and
here together, and the service worker's cache name (`client/public/sw.js`),
or installed apps keep the old icons.

## Colors

| | |
|---|---|
| Blue, the tag | `#1976d2` (the primary color of the interface) |
| Dark blue, the fins | `#1565c0` (the interface's dark primary) |
| Orange, the flames | `#f57c00` |
| Text on light | `#212121` |

## Use

- Leave free space around the mark of at least a quarter of its height.
- One-color versions are for places where color is impossible: a stamp,
  an engraving, a fax, a single-color print. In them the check is cut
  out and shows the background.
- Do not recolor the mark, stretch it, turn it or add effects.

The name and the mark are not covered by the code license (LICENSE.md,
"Trademarks"): it lets you say that software comes from yartt, not to name
a product or a service after it.
