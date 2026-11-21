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
  "multi-select",
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
  "is-read-mode", // the leaf is in reading view — always true for Quartz pages
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
 * Bare form-control rules (`button { … }`) style Obsidian's own UI. In Quartz,
 * every button is Quartz chrome (dark mode toggle, explorer, copy-code, …),
 * which Quartz styles itself, so bare button/select/textarea rules are dropped
 * and bare input rules (task checkboxes) are scoped to note content.
 */
export const FORM_CONTROLS: Record<string, "drop" | "content"> = {
  button: "drop",
  select: "drop",
  textarea: "drop",
  input: "content",
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
  "mod-macos": false,
  "mod-windows": false,
  "mod-linux": false,
  "mod-rtl": false,
  "is-grabbing": false,
  "colorful-frame": false,
  "is-left-sidedock-open": true,
  "is-right-sidedock-open": true,
};

export function isAppOnly(cls: string): boolean {
  return APP_ONLY_PREFIXES.some((p) =>
    p.endsWith("-") ? cls.startsWith(p) : cls === p || cls.startsWith(p + "-"),
  );
}
