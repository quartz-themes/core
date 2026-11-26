## 3.2.0

### Minor Changes

- Obsidian's per-block wrappers are styled natively. Quartz now renders them
  (`div.el-p > p`, `div.el-h2 > h2`, from `@quartz-community/rehype-obsidian` 1.5.0 through
  `@quartz-community/obsidian-flavored-markdown` 2.4.0), so the converter's wrapper emulation
  is gone. Rules for a wrapper's child reach past Quartz's own elements (the table's scroll
  container, the code block's figure, the diagram box). Counts of the sizer's children
  (`:nth-child`) skip Obsidian's UI around the blocks. A div between the reading view and its
  blocks is the sizer, and universal rules reach the note root as the sizer. Heading anchors
  aren't internal links. A site without the wrappers gets a warning at build time.
- Rules for Obsidian's property inputs reach Quartz's read-only properties, with the same
  specificity: `input.metadata-property-key-input` styles the key's span, and number and date
  inputs style Quartz's divs. Classless inputs under the properties block are mapped by their
  `[type]`, and checkboxes are left alone. Property keys get Obsidian's label colour, size and
  padding.
- Obsidian's fold arrows show only where Quartz folds: `:not(.allow-fold-headings)` and
  `:not(.allow-fold-lists)` test the classes Quartz's fold script puts on the reading view
  (`foldHeadings` / `foldLists` in obsidian-flavored-markdown). As an ancestor, the class is
  still treated as present, as Obsidian folds by default, so themes keep the space they leave
  for the arrows.

### Patch Changes

- Code blocks' copy button: Obsidian's `.copy-code-button` rules style Quartz's clipboard
  button, which sits where Obsidian's does (top right, shown on hover). Bare `button` rules
  apply to buttons in notes, as in Obsidian, and still not to Quartz's own controls.
- Internal-link rules no longer reach tags: Quartz marks tags as internal links too, which
  underlined them and gave them the link colour (Minimal, Things, Border).
- Folded callouts stay folded: Obsidian hides their content with an inline style, which the
  content reset undid in Quartz (every theme showed folded callouts open).
- Note embeds start from UA styles like the rest of the note, so Quartz's transclusion
  padding and border don't show through Obsidian's.
- Search is styled as Obsidian's quick switcher (about 400 themes style it): with
  `@quartz-community/search`'s Obsidian classes, `.prompt`, `.prompt-input`,
  `.prompt-results` and `.suggestion-*` rules apply, and `.modal-container` rules reach its
  overlay. The overlay stays hidden while closed and fixed over the page. Open, it shows
  two windows where Obsidian puts its switcher: the page preview, styled as the theme's
  hover popover and as tall as the switcher, left of the switcher. Result titles and
  matches inherit their text styles as in Obsidian, not Quartz's heading and highlight
  styles.
- Obsidian's `.card-title` (its own UI cards) no longer styles Quartz's search results and
  bases cards, which use the same class.
- The note's own box (`.markdown-preview-view`, `.markdown-rendered`) is painted behind the
  page, as the pane-wide box it is in Obsidian, under the column Quartz's content stands
  for (`.markdown-preview-sizer`). A grid, dots or glow drawn around a paper sheet no
  longer paints over the sheet (Graphite Island Spectrum, Waypoint Atlas, Yosuke Glass).
- The properties block, which Quartz renders above the note, gets the note sheet's colour
  behind it as in Obsidian. It beats app.css's transparent block, still loses to the
  theme's own rules, and works with `color-mix()` colours too.
- Letter and word spacing set on the boxes around the whole app (`.workspace`,
  `.app-container`) reach the note, as in Obsidian (Nytharael, Cordyceps).
- The reset that undoes Quartz's base styles sits below a theme's own cascade layers, so a
  theme's `@layer base` (Tailwind) styles apply: Auger's code font, checkbox icons and
  footnote size.
- Bare `details` and `summary` rules, `details[open]` included, apply to foldable blocks in
  notes only. Quartz's properties block is a `<details>`, which Obsidian's bare rules don't
  reach (Copper Rose, Camena, Majesty, Swak).
- Obsidian's external-link icon (`public/external-link.svg`, a file shipped inside the app)
  is inlined into the bundled app.css; it 404'd on Quartz sites. The bundled app.css is
  regenerated with this release's converter.
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
  plugin adds. Theme rules on code still take precedence. Theme rules for Obsidian's highlighter tokens
  (`.token.number`, `.token.operator`, in ~180 themes) colour the same tokens in Quartz.
- Checked checkboxes show Obsidian's checkmark (and themes' custom ones) instead of Quartz's:
  rules on bare elements with a single-colon pseudo-element (`input:checked:after`) were
  scoped into an invalid selector and dropped.
- Properties rules scoped to the reading view (`.markdown-preview-view .metadata-container`, in
  71 themes and Obsidian's own CSS) apply to Quartz's properties block, which sits above the note
  rather than inside it, and the block starts from browser defaults and the note's text font, like
  note content, so
  Quartz's own properties styles don't show through; property pills (`.multi-select-pill`) are
  styled instead of dropped as app UI. With note-properties' Obsidian markup,
  themes style properties as in Obsidian.
- Rules for Obsidian's block wrappers (`.el-p`, `.el-table`, `.el-pre`, `.el-h1`…, in ~100 themes
  and Obsidian's own CSS) apply to the blocks Quartz renders: `div.el-p > p` is the paragraph,
  `.el-table` Quartz's `.table-container`, `.el-pre` the code block, `.el-hr hr` the note's rules
  (Willemstad) but not the footnotes'; a wrapper's any-child (`div:is(.el-ul, .el-ol) > *`) is its
  block and the `div` a wrapper sits in is the note (Baseline's list spacing). Headings after
  tables and code blocks get Obsidian's spacing again.
- What a theme paints behind the note paints Quartz's page, composited as in Obsidian. Obsidian
  stacks several boxes there (the reading view, `.view-content`, the leaf, the tabs, the main
  split, `.workspace`, `.horizontal-main-container`, `.app-container`, `body`); the innermost
  opaque one shows and translucent ones blend over the rest. Each now gets its own background
  layer on Quartz's `<body>`, so a theme that paints both the app container and the pane shows
  the pane (Composer, Duskstone, Retroma), glass and gradient overlays blend over the backdrop
  (Green Holiday, Agate, Ember Glazz), and Style Settings toggles that gate a pane background
  still apply (Border's "root split background"). Image layers over a colour variable keep
  their images (Imperium's vignette), as do variables that hold a whole background
  (AbsolutelyGlass's `--ca-ambient`); `:is()` lists of boxes paint each box, a bare
  `.workspace-split` is the main split too, and rules for other view types
  (`:not([data-type="markdown"])`) stay out. Obsidian's `.is-read-mode
.markdown-preview-view` background no longer covers it: Obsidian 1.x marks the reading view
  with `data-mode="preview"`, so that rule is dead there.
- Headings and other blocks a theme makes inline stack as in Obsidian, where each sits in its own
  block wrapper: Adrenaline's headings ran together on one line.
- Nested CSS (`body { .view-content { … } }`, `.callout { &[data-callout=tip] { … } }`, in 98
  themes) is converted: nested rules are flattened first, as the browser matches them. They used
  to pass through unconverted, matching Quartz's markup only by accident.
- Variables a theme sets on the boxes around the note (`.app-container`, `.workspace`, the main
  split, the leaf, `.view-content`, in 136 themes) apply: in Obsidian they inherit into the note
  and the boxes' backgrounds (Fantasy's translucent panes), and were dropped with the boxes. They
  go on Quartz's page or main column, which stand for those boxes, so variables `<body>` builds
  from them keep `<body>`'s values as in Obsidian (Kiwi Mono's checkboxes), while Quartz's
  sidebars and title follow them, as Obsidian's sidebars do. Ones
  gated on the box's own `:has()` stay out, as that condition can't be checked on the page. A
  pane rule's body classes keep working when the selector list put a line break before them
  (Micro Mike's gradient panes).
- The properties block inherits the note's text styles, as Obsidian's does from inside the note:
  a theme's letter spacing or font on `.markdown-rendered` (Cairn) reaches it, while rules for
  the block itself still win, also over the note's `!important` ones, and through `:is()` of the
  note's boxes (Blue Topaz's letter spacing).
- Quartz's screen-reader-only footnotes heading stays hidden: a theme's `h2` margins and counters
  made it take up space above the footnotes. Nor do Quartz's own footnotes margin and border
  show through: in Obsidian the space above the footnotes is the theme's `hr`.
- The note's font size is Obsidian's default 16px unless a theme insists: Obsidian writes the
  Appearance font size onto `<body>` as an inline style, so a theme's `body { --font-text-size }`
  has no effect there, only `!important` or a rule on the note itself does (Amber Cathode and ~65
  others rendered larger text than in Obsidian).
- A body class on another element is that element's state: `.multi-select-pill.is-focused` no
  longer styles every pill as focused (Paperglow).
- Platform rules resolve as on Linux: themes that make the window translucent on macOS
  (`:not(.mod-windows):not(.mod-linux) { --background-primary: transparent }`) left the page
  unpainted (Claudian, Meridian), as no platform matched.
- Rules for the reading view's sizer under `:is(.markdown-preview-view, .markdown-rendered)`
  apply to the note (Blue Topaz's letter spacing and line height).
- Style Settings blocks indented with tabs and spaces mixed parse as the plugin parses them: it
  replaces tabs with the indent `detect-indent` finds, the most common step between lines, not the
  smallest indent. Micro Mike, Borealis, Panorama, Lemons, Velocity and Typomagical lost some or
  all of their settings, and with them their defaults (Micro Mike's palette class).
- Style Settings selects whose options aren't strings (AnuPpuccin's numeric font weights) are
  ignored, as Style Settings 1.0.9 ignores them.
- Style Settings with an id that isn't a valid CSS variable name (Minimal's
  `cards-background-hover (hover)`) no longer cost every other colour setting: the invalid
  declaration is left out, as browsers do, instead of the whole block being rejected and lost.
- Variables Quartz itself defines on `:root` (`--font-text`, `--background-primary` and ~50
  others) are unset there, as in Obsidian, which defines them on `<body>`: a theme's
  `:root { --x: var(--font-text, -apple-system) }` took Quartz's font instead of its fallback
  (Elementra).
- Text styles a theme sets on the boxes around the note (`.markdown-reading-view {
letter-spacing }`) reach the note, as they inherit into it in Obsidian (Prose).
- Universal rules (`* { font-family: "JetBrains Mono" }`) reach what blocks inherit, as through
  Obsidian's block wrappers: headings, whose app.css font is `inherit`, took the note's font
  instead (SpectrumPlus).
- The box of Obsidian's block wrappers (`.markdown-preview-section > div`, `.el-hr`,
  `[class^="el-"]`) goes around the block rather than inside it: their padding is margin on the
  block (Discordian's callouts and code blocks were padded 4rem inside, Hidontknow's blocks had
  no space between them), within what the padding leaves of the column, and their zero or
  `auto` margins no longer cancel the block's own; between neighbouring wrappers they leave
  those blocks out of the theme's wrapper margins (Adrenaline's and Brainhack's stacked
  headings), still with their own margins. Their `em`s are the
  note's text size, not the block's. Their background and corners stay behind the block: the
  callouts and code blocks Obsidian paints keep their own (Office Mock).
- A `div` typed onto one of Obsidian's boxes (`.view-content > div:is(.markdown-reading-view) >
div`) is that box, not any div: ITS Theme's container rule sized every nested div of the page,
  and its header buttons ran off a phone's screen.
- Rules that reach a block through the wrapper (`.markdown-preview-section :not(:is(li, ul,
ol)) > h2`) match top-level blocks too (Micro Mike's heading margins).
- A column flexbox on the note is kept: the blocks still stack, and their margins don't
  collapse, as in Obsidian (DarkEmber, Micro Mike).
- Rules with an ancestor `:is()` of Obsidian's boxes (`:is(.markdown-reading-view,
.markdown-source-view) .markdown-preview-sizer`) are no longer dropped.
- Bare headings and rules behind `:is()` (`.cm-header-1, h1 { &:before {…} }`) stay in the note,
  like other bare headings: Lancer's heading ornaments drew on Quartz's titles. So do bare `hr`
  rules: Quartz's rule above the footer took a theme's margins, past the screen's edge (Weave
  Surface, PLN).
- Quartz's sidebars are open docks: rules for a collapsed one
  (`.workspace:not(.is-right-sidedock-open) > .mod-right-split`) no longer apply (Neumorphism's
  negative margins pushed the sidebars off-screen).
- A theme's `position: absolute` on the reading view's sizer no longer takes the note out of
  Quartz's column (Elysian's note covered the right sidebar and ran off the screen).
- The page never scrolls sideways: what a theme hangs past the window's edge is cut off, as in
  Obsidian's window (Lancer, Bureau).
- The properties block sits on the note's background colour, as inside the note in Obsidian
  (Blue Topaz).
- Style Settings with an id used twice in a section resolve as the plugin resolves them: the
  first one counts. Baseline's "Colorful headings" heading shadows the heading indicator after
  it, which no longer shows (~30 themes repeat ids).
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
