export { QuartzTheme } from "./transformer";
export { QuartzTheme as QuartzThemes } from "./transformer";
export { QuartzTheme as quartzThemes } from "./transformer";
export { QuartzTheme as transformer } from "./transformer";
export { QuartzTheme as default } from "./transformer";

export type { ThemeOptions, StyleSettingsExport } from "./types";

// The converter and theme sources are public so tools (the quartz-themes
// fidelity harness, CLIs) can use exactly what sites get.
export {
  convertTheme,
  convertObsidianCss,
  parseStyleSettings,
  resolveStyleSettings,
  resolveIcon,
} from "./convert";
export type {
  ConvertThemeInput,
  ConvertThemeResult,
  ConvertStats,
} from "./convert";
export { resolveTheme, resolveSnippet, getRegistry, slugify } from "./sources";
export type { CommunityTheme, ResolvedTheme, SourceOptions } from "./sources";

export type {
  QuartzTransformerPlugin,
  StaticResources,
} from "@quartz-community/types";
