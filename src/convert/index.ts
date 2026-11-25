/**
 * Obsidian theme (+ Style Settings, snippets) → Quartz stylesheets.
 */
import { OBSIDIAN_APP } from "../generated/obsidian-app";
import { composeStylesheet } from "./compose";
import { convertObsidianCss, type ConvertStats } from "./convert";
import {
  extractFontData,
  pruneFonts,
  stripThemeFonts,
  type FontFile,
  type PruneReport,
} from "./fonts";
import { resolveIcon } from "./icons";
import {
  parseStyleSettings,
  resolveStyleSettings,
  type StyleSettingsExport,
} from "./style-settings";

export {
  convertObsidianCss,
  composeStylesheet,
  parseStyleSettings,
  resolveStyleSettings,
  resolveIcon,
};
export { extractFontData };
export type { ConvertStats, FontFile, PruneReport, StyleSettingsExport };

export interface ConvertThemeInput {
  /** The theme's theme.css ("" for Obsidian's default theme). */
  themeCss: string;
  /** Style Settings export, applied like the Style Settings plugin does. */
  styleSettings?: StyleSettingsExport;
  /** Extra Obsidian CSS snippets, applied after the theme. */
  snippets?: string[];
  /**
   * Include the theme's web fonts and font choices. `false`: the site's Quartz
   * fonts (from quartz.config) are used instead. @default true
   */
  themeFonts?: boolean;
  /** Override the bundled, pre-converted Obsidian app.css (for tests/tools). */
  app?: { css: string; quarantine: string };
}

export interface ConvertThemeResult {
  /** Main stylesheet (minifiable by Quartz). */
  main: string;
  /** Rules Quartz's minifier would reject; serve as a separate resource. */
  raw: string;
  /** The converted theme + snippets + Style Settings CSS alone (without app.css). */
  themeCss: string;
  report: {
    theme: ConvertStats;
    styleSettings: {
      sections: string[];
      parseErrors: string[];
      bodyClasses: Record<string, boolean>;
      applied: string[];
      unknown: string[];
    };
    /** Web fonts pruned from the theme (unused families, unresolvable sources). */
    fonts: PruneReport;
  };
}

export function convertTheme({
  themeCss,
  styleSettings = {},
  snippets = [],
  themeFonts = true,
  app = OBSIDIAN_APP,
}: ConvertThemeInput): ConvertThemeResult {
  const { sections, errors } = parseStyleSettings(
    [themeCss, ...snippets].join("\n"),
  );
  const resolved = resolveStyleSettings(sections, styleSettings);
  const opts = { bodyClasses: resolved.bodyClasses, resolveIcon };

  const theme = convertObsidianCss(themeCss, {
    ...opts,
    filename: "theme.css",
  });
  const snips = snippets.map((s, i) =>
    convertObsidianCss(s, { ...opts, filename: `snippet-${i}.css` }),
  );
  const settings = convertObsidianCss(resolved.css, {
    ...opts,
    filename: "style-settings.css",
  });

  // Without theme fonts, the theme's font choices go before composing (the
  // bundled app.css keeps its own, which the Quartz font bridge feeds).
  const own = (css: string) => (themeFonts ? css : stripThemeFonts(css));
  const themeOnly = own([theme.css, ...snips.map((s) => s.css)].join("\n"));
  const settingsCss = own(settings.css);
  const composed = composeStylesheet({
    app: app.css,
    theme: themeOnly,
    quarantine: [
      app.quarantine,
      own(
        [
          theme.quarantine,
          ...snips.map((s) => s.quarantine),
          settings.quarantine,
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    ]
      .filter(Boolean)
      .join("\n"),
    settings: settingsCss,
    quartzFonts: !themeFonts,
  });
  const pruned = pruneFonts([composed.main, composed.raw]);
  const [main, raw] = pruned.sheets as [string, string];
  return {
    main,
    raw,
    themeCss: [themeOnly, settingsCss].join("\n"),
    report: {
      theme: theme.stats,
      styleSettings: {
        sections: sections.map((s) => s.id),
        parseErrors: errors,
        bodyClasses: resolved.bodyClasses,
        applied: resolved.applied,
        unknown: resolved.unknown,
      },
      fonts: pruned.report,
    },
  };
}
