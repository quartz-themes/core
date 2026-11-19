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
