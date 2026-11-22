export type {
  BuildCtx,
  QuartzTransformerPlugin,
  QuartzTransformerPluginInstance,
  StaticResources,
} from "@quartz-community/types";

import type { StyleSettingsExport } from "./convert/style-settings";

export type { StyleSettingsExport };

/** User-facing configuration for the QuartzTheme plugin. */
export interface ThemeOptions {
  /**
   * The Obsidian theme to use:
   *  - a community theme name, as listed in Obsidian (`"Tokyo Night"`, `"Minimal"`)
   *  - a GitHub repo (`"kepano/obsidian-minimal"`), for themes outside the registry
   *  - a URL to a theme.css, or a local path (`"./themes/My Theme"`)
   *  - a pre-3.0 id (`"tokyo-night"`, `"catppuccin.frappe"`), kept for compatibility
   *
   * The theme is downloaded at build time (cached in `.quartz-cache/quartz-themes`).
   */
  theme: string;
  /** Which mode(s) to include: "dark", "light", or "both". */
  mode: "dark" | "light" | "both";
  /**
   * Style Settings — a JSON export from Obsidian's Style Settings plugin, or a path
   * to a JSON file holding one. Keys look like `"minimal-style@@h1-color@@dark"`.
   */
  styleSettings?: StyleSettingsExport | string;
  /** Obsidian CSS snippets (paths or URLs), applied after the theme like in Obsidian. */
  snippets?: string[];
  /** Pin a community theme to a release version (e.g. `"7.7.19"`). Default: latest. */
  version?: string;
  /**
   * Use the theme's fonts. `false`: the theme's web fonts and font choices are
   * removed and the site's Quartz fonts (quartz.config `theme.typography`, or
   * the Fonts plugin) are used for text, headings and code. @default true
   */
  themeFonts?: boolean;
  /** Cache directory for downloaded themes. @default ".quartz-cache/quartz-themes" */
  cacheDir?: string;
  /** Re-check cached theme versions after this many hours. @default 24 */
  cacheHours?: number;

  /** @deprecated 3.0: use a pre-3.0 id (`"catppuccin.frappe"`) or `styleSettings` instead. */
  variation?: string;
  /** @deprecated 3.0: themes are converted whole; mixing aspects was removed. */
  aspects?: unknown;
  /** @deprecated 3.0: themes are converted whole. */
  include?: unknown;
  /** @deprecated 3.0: removed. */
  calloutStyle?: unknown;
  /** @deprecated 3.0: removed; theme fonts come with the theme's CSS. */
  fonts?: unknown;
}
