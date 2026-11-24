/**
 * Compose the final stylesheet a Quartz site gets:
 *
 *   @layer quartz-base   — Quartz's own index.css + component CSS (lowest)
 *   @layer obsidian      — converted Obsidian app.css, then the theme, then
 *                          Style Settings, in source order, exactly like
 *                          Obsidian's cascade
 *
 * plus a bridge that points Quartz's own variables at Obsidian's, so
 * Quartz-only components (graph, search, explorer chrome…) follow the theme.
 */
import { backdropCss, backdropProperties } from "./backdrop";
import { QUARTZ_FONT_BRIDGE } from "./fonts";

/** Quartz variable → Obsidian variable. Defined on <body>, where Obsidian defines its vars. */
export const BRIDGE: Record<string, string> = {
  "--light": "var(--background-primary)",
  "--lightgray": "var(--background-modifier-border)",
  "--gray": "var(--text-faint)",
  "--darkgray": "var(--text-normal)",
  "--dark": "var(--text-normal)",
  "--secondary": "var(--text-accent)",
  "--tertiary": "var(--text-accent-hover)",
  "--highlight": "var(--background-modifier-hover)",
  "--textHighlight": "var(--text-highlight-bg)",
  "--bodyFont": "var(--font-text)",
  "--headerFont": "var(--font-text)",
  "--codeFont": "var(--font-monospace)",
};

/**
 * Inside rendered markdown, Quartz's own base styles (layer quartz-base) would
 * show through wherever Obsidian's app.css leaves a property unset, e.g. hr
 * backgrounds or callout borders. Reverting these elements to UA styles at
 * zero specificity — first thing in the obsidian layer — makes Obsidian's
 * rules the only author styles that apply, as in Obsidian. Custom properties
 * are unaffected by `all`. Quartz's code-block <figure> has no counterpart in
 * Obsidian (its `pre` sits in the note directly), so it doesn't get the UA's
 * 40px figure margins.
 */
export const CONTENT_RESET = `:where(.markdown-preview-view) :where(p, h1, h2, h3, h4, h5, h6, a, ul, ol, li, blockquote, hr, section, table, thead, tbody, tr, th, td, code, pre, mark, strong, em, b, i, del, s, sup, sub, img, figure, figcaption, details, summary, kbd, .text-highlight, .callout, .callout-title, .callout-title-inner, .callout-content, .callout-icon, input[type="checkbox"]) {
  all: revert;
}
:where(.markdown-preview-view) :where(figure[data-rehype-pretty-code-figure]) {
  margin: 0;
}
/* Quartz's screen-reader-only elements (the footnotes' "Footnotes" heading)
   have no Obsidian counterpart: hidden, and uncounted, whatever the theme does
   to their element. */
.markdown-preview-view .sr-only {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  padding: 0 !important;
  margin: -1px !important;
  border: 0 !important;
  overflow: hidden !important;
  clip: rect(0, 0, 0, 0) !important;
  white-space: nowrap !important;
  counter-increment: none !important;
  counter-reset: none !important;
}
`;

/**
 * The properties block (note-properties renders Obsidian's `metadata-*`
 * markup): like note content, Quartz's own styles would show through wherever
 * Obsidian's CSS leaves a property unset (the plugin's bold heading, table-like
 * key column, pill shape). Reset it to UA styles first, as Obsidian's CSS
 * expects. Icons keep their size attributes; the `<summary>` marker stays
 * hidden, as Obsidian's heading has none.
 */
export const PROPERTIES_RESET = `:where(.metadata-container, .metadata-container :not(svg, svg *)) {
  all: revert;
}
/* Obsidian's block sits in the reading view and inherits its text font; Quartz's
   sits above the note. */
:where(.metadata-container) {
  font-family: var(--font-text);
  font-size: var(--font-text-size);
  line-height: var(--line-height-normal);
}
:where(.metadata-container > summary) {
  list-style: none;
}
:where(.metadata-container > summary)::-webkit-details-marker {
  display: none;
}
`;

/**
 * Obsidian renders callout icons as an <svg> sized by --icon-size in the
 * callout colour; Quartz renders an empty .callout-icon. Paint the icon the
 * converter resolved into --callout-icon (a data URI) as a mask in
 * currentColor, at zero specificity so themes can restyle it.
 */
export const CALLOUT_ICON_CSS = `:where(.callout-icon) {
  display: flex;
  align-items: center;
}
:where(.callout-icon)::before {
  content: "";
  display: block;
  width: var(--icon-size, 18px);
  height: var(--icon-size, 18px);
  background-color: currentColor;
  -webkit-mask: var(--callout-icon) no-repeat center / contain;
  mask: var(--callout-icon) no-repeat center / contain;
}
`;

/**
 * Code blocks: Obsidian colours tokens with the theme's `--code-*` variables;
 * Quartz highlights with Shiki, whose palette would win. Quartz's
 * syntax-highlighting plugin tags each token span with `data-token-type`,
 * named after those variables. Zero specificity, first in the obsidian layer:
 * themes' own code rules still win.
 */
const CODE_TOKEN_VARS: Record<string, string> = {
  normal: "normal",
  comment: "comment",
  string: "string",
  regexp: "important",
  keyword: "keyword",
  operator: "operator",
  value: "value",
  important: "important",
  property: "property",
  function: "function",
  tag: "tag",
  punctuation: "punctuation",
};
export const CODE_TOKEN_CSS = Object.entries(CODE_TOKEN_VARS)
  .map(
    ([type, v]) =>
      `:where(.markdown-rendered pre) :where(span[data-token-type="${type}"]) { color: var(--code-${v}); }`,
  )
  .join("\n");

/**
 * Quartz (5.1+) defines Obsidian's variables on :root from its own colours
 * (`--text-highlight-bg: var(--textHighlight)`, …) so Obsidian-styled plugins
 * look right without a theme. With a theme those definitions leak: Obsidian's
 * own CSS relies on several being undefined (e.g. Obsidian 1.15 no longer sets
 * `--text-highlight-bg`, so `var(--text-highlight-bg, <default>)` falls back).
 * Resetting them to `initial` (the guaranteed-invalid value, same as undefined)
 * on <body> at zero specificity, before app.css and the theme, restores
 * Obsidian's behaviour; anything Obsidian or the theme defines still wins.
 * Keep in sync with quartz/util/theme.ts.
 */
export const QUARTZ_OBSIDIAN_VARS = [
  "--accent-h",
  "--accent-l",
  "--accent-s",
  "--background-modifier-border",
  "--background-modifier-border-focus",
  "--background-modifier-border-hover",
  "--background-primary",
  "--background-primary-alt",
  "--background-secondary",
  "--background-secondary-alt",
  "--color-base-00",
  "--color-base-05",
  "--color-base-10",
  "--color-base-100",
  "--color-base-20",
  "--color-base-25",
  "--color-base-30",
  "--color-base-35",
  "--color-base-40",
  "--color-base-50",
  "--color-base-60",
  "--color-base-70",
  "--divider-color",
  "--font-interface",
  "--font-monospace",
  "--font-text",
  "--icon-color",
  "--icon-color-active",
  "--icon-color-hover",
  "--interactive-accent",
  "--interactive-accent-hover",
  "--interactive-hover",
  "--interactive-normal",
  "--link-color",
  "--link-color-hover",
  "--nav-item-background-active",
  "--nav-item-background-hover",
  "--nav-item-color",
  "--nav-item-color-active",
  "--nav-item-color-hover",
  "--tag-background",
  "--tag-background-hover",
  "--tag-color",
  "--text-accent",
  "--text-accent-hover",
  "--text-faint",
  "--text-highlight-bg",
  "--text-muted",
  "--text-normal",
  "--text-on-accent",
  "--text-on-accent-inverted",
];

export function resetCss(): string {
  return `:where(body) {\n${QUARTZ_OBSIDIAN_VARS.map((v) => `  ${v}: initial;`).join("\n")}\n}\n`;
}

/** Quartz font variables the bridge points at Obsidian's (not with `quartzFonts`). */
const FONT_BRIDGE_KEYS = new Set(["--bodyFont", "--headerFont", "--codeFont"]);

/**
 * @param quartzFonts the site's Quartz fonts replace the theme's, so Quartz's
 *   font variables mustn't point at Obsidian's (see quartzFontsCss).
 */
export function bridgeCss(quartzFonts = false): string {
  const entries = Object.entries(BRIDGE).filter(
    ([k]) => !quartzFonts || !FONT_BRIDGE_KEYS.has(k),
  );
  const decls = entries.map(([k, v]) => `  ${k}: ${v};`).join("\n");
  // :where() keeps specificity at 0 so any theme rule can override it. Again
  // on the page and the main column, which carry the variables of the boxes
  // around Obsidian's sidebars and note: Quartz's chrome follows them there,
  // as Obsidian's sidebars do (Monokai's page title).
  return `:where(body, #quartz-root, .center) {\n${decls}\n}\n`;
}

/**
 * Quartz's fonts through Obsidian's override variables. After app.css, whose
 * `body` sets each override to a placeholder font, and after the theme (whose
 * font choices were removed).
 */
export function quartzFontsCss(): string {
  const decls = Object.entries(QUARTZ_FONT_BRIDGE)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return `body {\n${decls}\n}\n`;
}

/**
 * Obsidian indents its file explorer with inline styles on every row
 * (`margin-inline-start: -17px·depth; padding-inline-start: 24px + 17px·depth`,
 * both `!important`), which cancel its 17px child indentation: whatever the
 * theme says, a row's content starts 24px past its indent, and the chevron
 * (`.tree-item-icon`, absolutely positioned 20px back) sits inside the row.
 * Quartz indents with its nested lists, so the same holds with 24px at every
 * depth. In the lower layer, `!important` beats a theme's `!important`, as an
 * inline style does (Carbon, Sanctum and others clipped the chevron off the
 * sidebar's edge).
 *
 * Obsidian also takes a collapsed folder's children out of the page; Quartz
 * collapses them to a zero-height grid row, which a theme's padding, borders
 * or heights on `.nav-folder-children` would show through (Apple Notes,
 * Nox Aeterna).
 */
export const EXPLORER_CSS = `@layer quartz-base {
:where(.explorer) :where(.tree-item-self) {
  margin-inline-start: 0 !important;
  padding-inline-start: 24px !important;
}
:where(.explorer) :where(.folder-outer:not(.open)) {
  display: none !important;
}
}`;

/**
 * Obsidian's window never scrolls sideways: what a theme hangs past its edge
 * (Lancer's title ornaments, Bureau's heading markers) is cut off. Quartz's
 * page would scroll instead, on phones by the width of a decoration. On the
 * root element, whose overflow is the viewport's: absolutely positioned
 * ornaments placed against the viewport (Lancer's title flourishes) escape
 * any element's clip below it. The vertical scroll stays as it is.
 */
export const PAGE_CSS = `@layer quartz-base {
:where(:root) {
  overflow-x: clip !important;
}
}`;

/**
 * Obsidian variables Quartz itself defines on `:root` (quartz/util/theme.ts),
 * pointing at its own palette and fonts. Obsidian defines them on `<body>`
 * only, so on `:root` they are unset: a theme's
 * `:root { --x: var(--font-text, -apple-system) }` takes the fallback there
 * (Elementra), and Quartz's font here. Converted app.css defines them on
 * `<body>` again, so only `:root` loses them.
 */
export const QUARTZ_ROOT_VARS = [
  "--background-primary",
  "--background-primary-alt",
  "--background-secondary",
  "--background-secondary-alt",
  "--background-modifier-border",
  "--background-modifier-border-hover",
  "--background-modifier-border-focus",
  "--text-normal",
  "--text-muted",
  "--text-faint",
  "--text-accent",
  "--text-accent-hover",
  "--text-on-accent",
  "--text-on-accent-inverted",
  "--text-highlight-bg",
  "--interactive-normal",
  "--interactive-hover",
  "--interactive-accent",
  "--interactive-accent-hover",
  "--color-base-00",
  "--color-base-05",
  "--color-base-10",
  "--color-base-20",
  "--color-base-25",
  "--color-base-30",
  "--color-base-35",
  "--color-base-40",
  "--color-base-50",
  "--color-base-60",
  "--color-base-70",
  "--color-base-100",
  "--font-text",
  "--font-monospace",
  "--font-interface",
  "--nav-item-color",
  "--nav-item-color-hover",
  "--nav-item-color-active",
  "--nav-item-background-hover",
  "--nav-item-background-active",
  "--tag-background",
  "--tag-color",
  "--tag-background-hover",
  "--icon-color",
  "--icon-color-hover",
  "--icon-color-active",
  "--divider-color",
  "--link-color",
  "--link-color-hover",
  "--accent-h",
  "--accent-s",
  "--accent-l",
];

/**
 * Unset {@link QUARTZ_ROOT_VARS} on `:root`, as in Obsidian, except those the
 * theme sets there itself (which Quartz's unlayered rule overrides either way).
 */
export function rootVarsCss(css: string): string {
  const own = new Set<string>();
  for (const m of css.matchAll(
    /(?:^|[{},;])\s*(?::root|html)\b[^{};]*\{([^{}]*)\}/g,
  ))
    for (const d of m[1]!.matchAll(/(--[\w-]+)\s*:/g)) own.add(d[1]!);
  const unset = QUARTZ_ROOT_VARS.filter((v) => !own.has(v));
  if (!unset.length) return "";
  return `@layer quartz-base {\n:root {\n${unset.map((v) => `  ${v}: initial !important;`).join("\n")}\n}\n}`;
}

export interface ComposeInput {
  app: string;
  theme: string;
  quarantine?: string;
  settings?: string;
  reset?: boolean;
  /** Use the site's Quartz fonts instead of the theme's (`themeFonts: false`). */
  quartzFonts?: boolean;
}

/**
 * Obsidian writes the user's appearance settings onto `<body>` as an inline
 * style, at their defaults `--font-text-size: 16px` (Appearance → Font size).
 * An inline style beats every normal rule for `<body>`, so a theme's
 * `body { --font-text-size: 18px }` loses there; only `!important` wins, or a
 * rule on an element inside, such as the boxes around the note (Mulled Wine's
 * `.app-container`). The class padding gives this rule that reach: above
 * body rules, below the boxes' copies on `<body>`, which carry ids.
 */
export const INLINE_BODY_CSS = `body${":not(.qt-0)".repeat(32)} {
  --zoom-factor: 1;
  --font-text-size: 16px;
  --indent-size: 4;
}`;

/**
 * @returns `main` (minifiable) and `raw`, which must be served as a separate
 *   resource so Quartz's minifier can't reject the main sheet because of it.
 */
export function composeStylesheet({
  app,
  theme,
  quarantine = "",
  settings = "",
  reset = true,
  quartzFonts = false,
}: ComposeInput) {
  const main = [
    "@layer quartz-base, obsidian;",
    backdropProperties(),
    "@layer obsidian {",
    reset && CONTENT_RESET,
    reset && PROPERTIES_RESET,
    CALLOUT_ICON_CSS,
    CODE_TOKEN_CSS,
    resetCss(),
    bridgeCss(quartzFonts),
    app,
    theme,
    settings,
    quartzFonts && quartzFontsCss(),
    INLINE_BODY_CSS,
    backdropCss(),
    "}",
    EXPLORER_CSS,
    PAGE_CSS,
    rootVarsCss(`${theme}\n${settings}`),
  ]
    .filter(Boolean)
    .join("\n");
  const raw = quarantine ? `@layer obsidian {\n${quarantine}\n}` : "";
  return { main: hoistImports(main), raw };
}

/** @import must precede everything except @charset/@layer statements. */
function hoistImports(css: string): string {
  const imports: string[] = [];
  // url()/strings may contain `;` (Google Fonts: `wght@0,400;0,700`), so match them whole.
  const rest = css.replace(
    /@import\s+(?:url\(\s*(?:'[^']*'|"[^"]*"|[^)]*)\s*\)|'[^']*'|"[^"]*")[^;]*;/g,
    (m) => {
      imports.push(m);
      return "";
    },
  );
  return imports.join("\n") + (imports.length ? "\n" : "") + rest;
}
