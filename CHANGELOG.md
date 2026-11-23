## 3.1.2

### Patch Changes

- Bases render again: Obsidian lays out its tables as absolutely positioned, virtualised
  `<div>`s, and those layout rules no longer apply to Quartz's `<table>`. Themes still colour
  and border them.
- Explorer rules follow Obsidian 1.12's file tree. Rules for the pre-1.0 vault-root folder
  (`.nav-folder.mod-root`, whose title row was the vault name) are dead in Obsidian and are
  dropped; they used to apply to every folder, hiding all folders (Apex, Firefly, Coding
  Agent) or their icons (Catppuccin), in ~140 themes. `.nav-files-container > div > …` rules
  for top-level folders apply to Quartz's list (Blue Topaz's coloured folders, 67 themes).
- Bare `ul`, `ol`, `li` and `a` rules only apply inside notes, as bare headings already did:
  in Obsidian they style notes, in Quartz they also hit the explorer, table of contents and
  backlinks (Blue Topaz's list borders, app.css's link colour on folder names).
- Rules for the pre-1.0 `.nav-folder-collapse-indicator`, which Obsidian no longer renders,
  are dropped: Catppuccin and others hid the explorer's chevron with them, leaving no way to
  open a folder.
- Explorer rows follow Obsidian's indentation: a row's content starts 24px past its indent
  whatever the theme sets, as Obsidian's inline styles enforce, so the chevron stays inside
  the row (Carbon, Sanctum and others clipped it off the sidebar, and clicks on it opened the
  folder page). A collapsed folder's children are hidden outright, as Obsidian removes them
  (Apple Notes, Hidontknow and Nox Aeterna showed them through their padding).
- A theme's size container (`container-type: size`) no longer collapses Quartz's explorer to one
  row (Oboro), also when the rule is shared with other elements through `:is()`.
- The phone explorer opens again with themes that set `will-change`, `transform` or `filter`
  on the file list (Book and Quill, Bamboo China): those properties made the list the
  containing block of Quartz's fixed overlay.
- Code blocks use the theme's syntax colours (`--code-keyword`, `--code-string`, …) instead
  of Shiki's palette, through the `data-token-type` attributes Quartz's syntax-highlighting
  plugin adds. Theme rules on code still take precedence.
- Checked checkboxes show Obsidian's checkmark (and themes' custom ones) instead of Quartz's:
  rules on bare elements with a single-colon pseudo-element (`input:checked:after`) were
  scoped into an invalid selector and dropped.
- Properties rules scoped to the reading view (`.markdown-preview-view .metadata-container`, in
  71 themes and Obsidian's own CSS) apply to Quartz's properties block, which sits above the note
  rather than inside it. With note-properties' Obsidian markup, themes style properties as in
  Obsidian.
- Tables keep the space above them: Obsidian's "no top margin for the note's first block" rule
  (`.markdown-preview-pusher + div > :first-child`) applied to the first child of every block,
  including the table inside Quartz's `.table-container`.

## 3.1.1

### Patch Changes

- `theme: default` (Obsidian's built-in theme, as in the Quartz Obsidian template) works
  again: 3.0 looked it up in the community theme registry and failed to initialise.
- No more "dropped 1 fonts whose files aren't part of the theme" on every build: Obsidian's
  placeholder font face is left alone.

## 3.1.0

### Minor Changes

- `themeFonts: false` uses the site's Quartz fonts (`theme.typography`, or the Fonts plugin)
  for text, headings and code: the theme's web fonts and font choices are removed and
  Obsidian's font override variables point at Quartz's.
- A theme's embedded (base64) fonts ship as separate files in
  `static/plugins/quartz-themes/fonts/` instead of inside the stylesheet, so browsers download
  only the fonts a page uses, once per site. Latsidian's stylesheet goes from 44.8 MB to 330 KB.

### Patch Changes

- Fonts a theme bundles but never uses are left out, after Style Settings apply, so a font only
  a disabled option uses goes too. So are fonts whose relative `url()` points at files that
  aren't part of the theme (no more 404s on Subtlegold, Sandstorm and others).

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
