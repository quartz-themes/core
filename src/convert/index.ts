/**
 * Obsidian theme (+ Style Settings, snippets) → Quartz stylesheets.
 */
import { OBSIDIAN_APP } from "../generated/obsidian-app";
import { composeStylesheet } from "./compose";
import { convertObsidianCss, type ConvertStats } from "./convert";
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
export type { ConvertStats, StyleSettingsExport };

export interface ConvertThemeInput {
  /** The theme's theme.css ("" for Obsidian's default theme). */
  themeCss: string;
  /** Style Settings export, applied like the Style Settings plugin does. */
  styleSettings?: StyleSettingsExport;
  /** Extra Obsidian CSS snippets, applied after the theme. */
  snippets?: string[];
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
  };
}

export function convertTheme({
  themeCss,
  styleSettings = {},
  snippets = [],
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

  const { main, raw } = composeStylesheet({
    app: app.css,
    theme: [theme.css, ...snips.map((s) => s.css)].join("\n"),
    quarantine: [
      app.quarantine,
      theme.quarantine,
      ...snips.map((s) => s.quarantine),
    ]
      .filter(Boolean)
      .join("\n"),
    settings: settings.css,
  });
  return {
    main,
    raw,
    themeCss: [theme.css, ...snips.map((s) => s.css), settings.css].join("\n"),
    report: {
      theme: theme.stats,
      styleSettings: {
        sections: sections.map((s) => s.id),
        parseErrors: errors,
        bodyClasses: resolved.bodyClasses,
        applied: resolved.applied,
        unknown: resolved.unknown,
      },
    },
  };
}
