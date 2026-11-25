/**
 * Quartz DOM profile: what the converter knows about how Obsidian's DOM
 * relates to Quartz's DOM. This is the single place to edit when Quartz
 * (or a @quartz-community plugin) changes its markup.
 */

/** Obsidian classes that only exist in the app (editor, workspace chrome, settings, …). */
export const APP_ONLY_PREFIXES = [
  "cm-",
  "HyperMD-",
  "workspace-tab",
  "workspace-ribbon",
  "workspace-leaf-resize-handle",
  "workspace-drawer",
  "workspace-sidedock",
  "side-dock",
  "status-bar",
  "titlebar",
  "modal",
  "menu",
  "setting-",
  "vertical-tab",
  "view-header",
  "view-action",
  "mobile-",
  "nav-header",
  "nav-buttons-container",
  "nav-action-button",
  "community-",
  "pdf-",
  "notice",
  "drag-",
  "graph-controls",
  "sidebar-toggle-button",
  "mod-cm6",
  "mod-cta",
  "markdown-source-view",
  "is-live-preview",
  "is-source-mode",
  "cm-s-obsidian",
  "dropdown",
  "checkbox-container",
  "tooltip",
  "inline-title-",
  "metadata-add",
  // Property pills render (note-properties); their editing parts don't.
  "multi-select-input",
  "multi-select-pill-remove",
  "suggestion-container",
  "prompt-instruction",
  "mod-sidedock",
  "mod-top",
  "mod-left-split-",
  "hover-editor",
  "sync-",
  "backlink-pane",
  "outgoing-link-pane",
  "release-notes",
  "is-grabbing",
  "is-being-dragged",
  // Obsidian's UI cards; Quartz's search results and bases cards are `.card-title` too
  "card-title",
  // Pre-1.0 explorer markup, gone from Obsidian (now `.tree-item-icon.collapse-icon`):
  // themes' rules for it are dead there. Quartz's explorer carried the class, so
  // Catppuccin's `display: none` hid the only way to open a folder.
  "nav-folder-collapse-indicator",
  // Obsidian 1.x marks the reading view with `[data-mode="preview"]`; the
  // leaf no longer gets `.is-read-mode`, so app.css's opaque
  // `.is-read-mode .markdown-preview-view` background is dead there. Applied,
  // it hid a theme's main-pane background behind the note (Primary, Border).
  "is-read-mode",
];

/**
 * Classes Quartz renders with its own layout (a plugin's markup shares
 * Obsidian's class names but not its DOM): rules for them keep colours,
 * borders and type, but layout properties are dropped, as for Quartz's
 * structural elements. Obsidian's `.bases-table` is an absolutely positioned,
 * virtualised `<div>`; Quartz's is the `<table>` itself. Quartz's explorer
 * element and its list carry `.nav-files-container`.
 */
export const QUARTZ_LAYOUT_PREFIXES = ["bases-", "nav-files-container"];

/**
 * Obsidian's file explorer (1.12): `.nav-files-container > div > .tree-item`
 * for top-level items, where the `div` is the vault root's plain children
 * wrapper (its first child a spacer, like the `li.overflow-end` that starts
 * Quartz's list, so `:nth-child()` counts agree). Quartz's list holds them
 * directly. Pre-1.0 Obsidian rendered the root as `.nav-folder.mod-root` with a
 * title row (the vault name); current Obsidian doesn't, so rules for it are dead
 * there and dropped here (as ancestors they'd otherwise be elided like a
 * workspace wrapper, and `.mod-root > .nav-folder-title { display: none }`
 * would hide every folder).
 */
export const FILES_CONTAINER = "nav-files-container";
export const TREE_ITEM_CLASSES = ["nav-folder", "tree-item"];
export const TREE_PART_CLASSES = [
  "nav-folder-title",
  "tree-item-self",
  "nav-folder-children",
  "tree-item-children",
];

/**
 * Obsidian layout wrappers. As ancestors they are elided (replaced by
 * specificity-equivalent padding that matches any element). As the subject
 * of a selector they are mapped through SUBJECT_MAP or the selector is dropped.
 */
export const WRAPPER_CLASSES = new Set<string>([
  "app-container",
  "horizontal-main-container",
  "main-content",
  "workspace",
  "workspace-split",
  "mod-root",
  "mod-vertical",
  "mod-horizontal",
  "workspace-tabs",
  "workspace-tab-container",
  "workspace-leaf",
  "workspace-leaf-content",
  "mod-active",
  "mod-stacked",
  "view-content",
  "markdown-reading-view",
  "markdown-preview-sizer",
  "markdown-preview-section",
  "markdown-preview-pusher",
  "is-readable-line-width",
  "allow-fold-headings",
  "allow-fold-lists",
  "show-indentation-guide",
  "show-properties",
  // Obsidian Publish wrappers
  "site-body",
  "site-body-center-column",
  "publish-renderer",
  "render-container",
  "render-container-inner",
  "markdown-rendered-container",
]);

/**
 * Wrappers that hold the note's top-level blocks (`.markdown-preview-sizer >
 * div` is "a block"). Quartz has no such wrapper: its content root
 * (`div.markdown-preview-view.markdown-rendered`) holds the blocks directly,
 * so these map onto the content root instead of being elided.
 */
export const CONTENT_WRAPPERS = new Set<string>([
  "markdown-preview-sizer",
  "markdown-preview-section",
]);
export const CONTENT_ROOT = ".markdown-preview-view";
/** Classes on Quartz's content root element. */
export const CONTENT_ROOT_CLASSES = [
  "markdown-preview-view",
  "markdown-rendered",
];

/**
 * Bare element rules that would reach Quartz chrome. Form controls
 * (`button { … }`) style Obsidian's own UI; in Quartz every button is chrome
 * (dark mode toggle, explorer, copy-code, …), which Quartz styles itself, so
 * bare button/select/textarea rules are dropped and bare input rules (task
 * checkboxes) are scoped to note content. Bare headings are meant for notes
 * (Obsidian's UI has none to speak of), while Quartz's page title, explorer,
 * graph and table-of-contents titles are headings: scoped to note content.
 * So are lists and links: Obsidian's explorer and outline are divs, Quartz's
 * explorer, table of contents, backlinks and tag lists are `ul > li` of `<a>`
 * (a bare `a { color }` would override the theme's explorer row colours).
 * And rules: Quartz draws one above its footer, outside the note.
 */
export const BARE_TAGS: Record<string, "drop" | "content"> = {
  button: "content",
  select: "drop",
  textarea: "drop",
  input: "content",
  h1: "content",
  h2: "content",
  h3: "content",
  h4: "content",
  h5: "content",
  h6: "content",
  ul: "content",
  ol: "content",
  li: "content",
  a: "content",
  hr: "content",
  // Foldable blocks in notes; Quartz's properties block is a <details> too (its
  // heading a <summary>), where Obsidian's is divs that bare rules don't reach.
  details: "content",
  summary: "content",
};

/** Wrapper classes that do have a Quartz counterpart. */
export const WRAPPER_MAP: Record<string, string> = {
  "mod-left-split": ".left.sidebar",
  "mod-right-split": ".right.sidebar",
  "published-container": "body",
  "site-body-left-column": ".left.sidebar",
  "site-body-right-column": ".right.sidebar",
  "site-header": ".page-header",
  "site-footer": "footer",
};

/** `.workspace-leaf-content[data-type=X]` → Quartz container (null = drop). */
export const LEAF_TYPE_MAP: Record<string, string> = {
  markdown: "", // elide
  "file-explorer": ".explorer",
  outline: ".toc",
  backlink: ".backlinks",
  graph: ".graph",
  localgraph: ".graph",
  search: ".search",
  canvas: ".canvas",
  bases: "",
};

/**
 * Obsidian class → Quartz selector, for elements Quartz renders under a
 * different name. Quartz 5.2 renders Obsidian's own classes (tag, nav-file,
 * nav-folder, is-collapsed, markdown-embed, hover-popover, inline-title,
 * task-list-item-checkbox, …) next to its own, so only true differences remain.
 */
export const RENAMES: Record<string, string> = {
  "is-unresolved": ".broken",
  // Code blocks' copy button: Quartz's sits where Obsidian's does (top right of the
  // <pre>, shown while it is hovered).
  "copy-code-button": ".clipboard-button",
  // Search: Quartz's search is Obsidian's quick switcher and command palette
  // (`.prompt`, `.prompt-input`, `.prompt-results`, `.suggestion-*` are on its
  // elements); its overlay is Obsidian's modal container (the dialogs inside it,
  // `.modal`, stay app-only).
  "modal-container": ".search-container",
};

/**
 * Obsidian class → zero-specificity condition added to its compound, for
 * elements Quartz gives more of Obsidian's classes than Obsidian does. Quartz
 * marks tags as internal links too (`a.tag.internal-link`); Obsidian's
 * internal-link rules never reach its tags.
 */
export const CLASS_QUALIFY: Record<string, string> = {
  "internal-link": ":where(:not(.tag))",
};

/** RENAMES that must not apply when the compound also has one of these classes. */
export const RENAME_UNLESS: Record<string, string[]> = {};

/**
 * Element-level differences.
 *  - replace: the type selector is replaced (specificity kept with padding)
 *  - qualify: appended to the compound with zero specificity
 */
export const TAG_REWRITES: Record<
  string,
  { replace?: string; qualify?: string }
> = {
  // Quartz renders ==highlight== as <span class="text-highlight">.
  mark: { replace: ":where(mark, .text-highlight)" },
  // Obsidian renders no <figure>s of its own; Quartz wraps code blocks in one.
  figure: { qualify: ":where(:not([data-rehype-pretty-code-figure]))" },
};

/**
 * Obsidian marks highlighted code (`pre`, `code`) with `language-<lang>`
 * classes; Quartz with `data-language="<lang>"`.
 */
export const LANGUAGE_CLASS_PREFIX = "language-";

/**
 * Prism's token classes (Obsidian's highlighter: `.token.number`) → the
 * `data-token-type` Quartz's syntax highlighting gives the same tokens, by
 * the `--code-*` variable Obsidian's app.css colours each with. Only the
 * class each type is named for: finer ones (`atrule`, `class-name`, `char`)
 * are tokens Quartz files under a broader type, and themes colour them apart.
 */
export const PRISM_TOKENS: Record<string, string> = {
  comment: "comment",
  string: "string",
  regex: "regexp",
  keyword: "keyword",
  important: "important",
  operator: "operator",
  number: "value",
  property: "property",
  function: "function",
  tag: "tag",
  punctuation: "punctuation",
};

/**
 * Body classes of Obsidian in reading view on desktop. true = present,
 * false = absent. Classes not listed and not declared by Style Settings are
 * treated as unknown (kept verbatim).
 */
export const BODY_STATE: Record<string, boolean | "mode"> = {
  "css-settings-manager": true,
  "show-inline-title": true,
  "show-view-header": true,
  "show-ribbon": true,
  "is-focused": true,
  "styled-scrollbars": true,
  "obsidian-app": true,
  "is-hidden-frameless": true,
  "is-frameless": true,
  "theme-dark": "mode",
  "theme-light": "mode",
  "is-mobile": false,
  "is-phone": false,
  "is-tablet": false,
  "is-ios": false,
  "is-android": false,
  "is-translucent": false,
  "is-fullscreen": false,
  "is-popout-window": false,
  "native-scrollbars": false,
  // One platform, and not macOS: themes make the window translucent there
  // (`:not(.mod-windows):not(.mod-linux) { --background-primary: transparent }`),
  // showing the desktop through it, which a web page can't. With no platform
  // at all, such rules would leave the page unpainted (Claudian, Meridian).
  "mod-macos": false,
  "mod-windows": false,
  "mod-linux": true,
  "mod-rtl": false,
  "is-grabbing": false,
  "colorful-frame": false,
  "is-left-sidedock-open": true,
  "is-right-sidedock-open": true,
};

/** Classes Obsidian puts on `.workspace`, as Quartz's layout has them. */
export const WORKSPACE_STATE: Record<string, boolean> = {
  "is-left-sidedock-open": true,
  "is-right-sidedock-open": true,
};

export function isAppOnly(cls: string): boolean {
  return APP_ONLY_PREFIXES.some((p) =>
    p.endsWith("-") ? cls.startsWith(p) : cls === p || cls.startsWith(p + "-"),
  );
}
