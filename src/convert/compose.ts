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
export const CONTENT_RESET = `:where(.markdown-preview-view) :where(p, h1, h2, h3, h4, h5, h6, a, ul, ol, li, blockquote, hr, table, thead, tbody, tr, th, td, code, pre, mark, strong, em, b, i, del, s, sup, sub, img, figure, figcaption, details, summary, kbd, .text-highlight, .callout, .callout-title, .callout-title-inner, .callout-content, .callout-icon, input[type="checkbox"]) {
  all: revert;
}
:where(.markdown-preview-view) :where(figure[data-rehype-pretty-code-figure]) {
  margin: 0;
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
  // :where() keeps specificity at 0 so any theme rule can override it.
  return `:where(body) {\n${decls}\n}\n`;
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
    "@layer obsidian {",
    reset && CONTENT_RESET,
    CALLOUT_ICON_CSS,
    resetCss(),
    bridgeCss(quartzFonts),
    app,
    theme,
    settings,
    quartzFonts && quartzFontsCss(),
    "}",
    EXPLORER_CSS,
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
