## 3.0.1

### Patch Changes

- Page layout stays Quartz's: Obsidian's file margins no longer add 32px of padding inside
  Quartz's gutters, and the content no longer reserves a scrollbar gutter (Obsidian's reading
  view scrolls on its own; in Quartz the page does).
- The same goes for a theme's own padding, margins, `display` or `min-width` on the reading
  view, `.markdown-rendered` or `.markdown-preview-sizer`, including behind body-class
  `:is()`; `auto` margins still centre a readable line width.
- Code blocks span the note column: the UA's 40px `<figure>` margins no longer apply, theme
  `figure` rules skip Quartz's code-block figure, and `.language-*` / `[class*="language-"]`
  selectors match Quartz's `[data-language]`.
- Theme rules can no longer hide or restyle Quartz's chrome: bare `h1`–`h6` rules apply inside
  the note only (the page title keeps Quartz's styling), side-panel rules behind `:is()` and
  `opacity` are guarded like other layout properties, and `div.workspace-leaf`-style rules no
  longer match every `div`.
- Rules for Obsidian's per-block wrappers apply to Quartz's top-level blocks, including through
  sibling combinators, without stopping wide tables from scrolling; rules for notes open in a
  sidebar split are dropped.

## 3.0.0

### Major Changes

- Use any Obsidian community theme. The `theme` option takes a community name (`Tokyo Night`),
  a GitHub repository (`owner/repo`), a URL or a local path; the theme is downloaded at build
  time (cached in `.quartz-cache/quartz-themes`, so offline builds work) and converted from its
  real CSS: hover states, media queries, `:has()` and the theme's cascade are kept, editor-only
  rules dropped, and Obsidian's reading-view stylesheet is bundled so the variables themes set
  take effect.
- Style Settings exports and Obsidian CSS snippets apply as they do in Obsidian.
- Requires Quartz 5.2 (async plugin factories, Obsidian-compatible markup).
- Removed `aspects`, `include`, `calloutStyle` and `fonts`: themes are converted whole.
  Pre-3.0 theme ids (`tokyo-night`, `catppuccin.frappe`) keep working, including the Style
  Settings presets of the old variants. The per-theme `@quartz-themes/<theme>` packages are no
  longer needed.

## 2.0.1

### Patch Changes

- Lucide icons render at the right size with `@lucide/icons` 1.70+, whose icon data no longer
  always includes a size: a missing size falls back to Lucide's 24-unit grid. Also fixes the
  typecheck against those versions.

## 2.0.0

### Major Changes

- Upgrade to `@quartz-community/types@^1.0.0`.

  This package re-exports types from `@quartz-community/types`, so the dependency is part
  of its public type surface. The move from `0.x` to `1.0.0` is therefore a breaking change
  for consumers and requires a major version bump.
