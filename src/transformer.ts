/**
 * QuartzTheme — style a Quartz site with an Obsidian community theme.
 *
 * The factory is async (Quartz 5.2+ awaits it): it resolves the theme,
 * downloads it if needed, and converts it with the static converter before
 * the build starts. CSS is then injected through externalResources().
 */
import fs from "node:fs";
import postcss from "postcss";
import type {
  CSSResource,
  JSResource,
  QuartzTransformerPluginInstance,
} from "@quartz-community/types";
import { convertTheme } from "./convert";
import { resolveSnippet, resolveTheme } from "./sources";
import type { StyleSettingsExport, ThemeOptions } from "./types";

const defaultOptions: ThemeOptions = { theme: "Tokyo Night", mode: "both" };
const DEPRECATED = ["aspects", "include", "calloutStyle", "fonts"] as const;

/** Font variables shared with other plugins (e.g. Fonts) through globalThis.__quartzFonts. */
const FONT_VAR_NAMES = [
  "--font-text",
  "--font-text-theme",
  "--font-interface",
  "--font-interface-theme",
  "--font-monospace",
  "--font-monospace-theme",
  "--h1-font",
  "--h2-font",
  "--h3-font",
  "--h4-font",
  "--h5-font",
  "--h6-font",
] as const;

export function extractFontVars(css: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of FONT_VAR_NAMES) {
    const m = css.match(new RegExp(`${name}\\s*:\\s*([^;}]+)`));
    const value = m?.[1]?.trim();
    if (value && !value.startsWith("var(") && value !== "inherit")
      result[name] = value;
  }
  return result;
}

export function loadStyleSettings(
  input: StyleSettingsExport | string | undefined,
): StyleSettingsExport {
  if (!input) return {};
  if (typeof input === "string")
    return JSON.parse(fs.readFileSync(input, "utf-8")) as StyleSettingsExport;
  return input;
}

/** Remove the theme's web fonts (themeFonts: false). */
function stripFonts(css: string): string {
  const root = postcss.parse(css);
  root.walkAtRules(/^(font-face|import)$/i, (at) => {
    if (
      at.name.toLowerCase() === "font-face" ||
      /fonts?\b|\.woff|\.ttf|\.otf/i.test(at.params)
    )
      at.remove();
  });
  return root.toString();
}

const log = (msg: string) => console.log(`[QuartzTheme] ${msg}`);

/**
 * An async transformer factory (Quartz 5.2+ awaits it). Declared here rather than taken from
 * @quartz-community/types (`QuartzAsyncTransformerPlugin`, 1.4+) so core works with older types.
 */
type AsyncTransformerPlugin<Options> = (
  opts?: Options,
) => Promise<QuartzTransformerPluginInstance>;

export const QuartzTheme: AsyncTransformerPlugin<
  Partial<ThemeOptions>
> = async (userOptions) => {
  const options: ThemeOptions = { ...defaultOptions, ...userOptions };
  for (const key of DEPRECATED) {
    if (options[key] !== undefined)
      log(
        `option "${key}" was removed in 3.0 and is ignored (themes are converted whole).`,
      );
  }

  const spec = options.variation
    ? `${options.theme}.${options.variation}`
    : options.theme;
  const sourceOpts = {
    cacheDir: options.cacheDir,
    cacheTtl: (options.cacheHours ?? 24) * 60 * 60 * 1000,
    version: options.version,
  };
  const theme = await resolveTheme(spec, sourceOpts);
  const snippets = await Promise.all(
    (options.snippets ?? []).map((s) => resolveSnippet(s, sourceOpts)),
  );
  // A pre-3.0 variant id implies a preset; the user's own settings win.
  const styleSettings = {
    ...theme.styleSettings,
    ...loadStyleSettings(options.styleSettings),
  };

  const t0 = performance.now();
  const result = convertTheme({ themeCss: theme.css, styleSettings, snippets });
  const s = result.report.theme;
  log(
    `${theme.name}${theme.version ? ` ${theme.version}` : ""}: ${s.rules} rules converted in ${Math.round(performance.now() - t0)} ms` +
      (s.repaired ? " (repaired malformed CSS)" : "") +
      (result.report.styleSettings.applied.length
        ? `, ${result.report.styleSettings.applied.length} Style Settings applied`
        : ""),
  );
  if (result.report.styleSettings.unknown.length) {
    log(
      `unknown Style Settings keys (ignored): ${result.report.styleSettings.unknown.join(", ")}`,
    );
  }

  // Modes: honour what the theme supports.
  let mode = options.mode;
  const supported = theme.modes;
  if (supported?.length === 1 && mode !== supported[0]) {
    if (mode !== "both")
      log(`"${theme.name}" only supports ${supported[0]} mode; using it.`);
    mode = supported[0]!;
  }

  let main = result.main;
  let raw = result.raw;
  if (options.themeFonts === false) {
    main = stripFonts(main);
    raw = raw && stripFonts(raw);
  } else {
    (globalThis as Record<string, unknown>).__quartzFonts = {
      themeName: theme.name,
      fonts: extractFontVars(result.themeCss),
    };
  }

  const css: CSSResource[] = [{ content: main, inline: true }];
  if (raw) css.push({ content: raw, inline: true });
  const js: JSResource[] = [];
  if (mode !== "both") {
    css.push({
      content: `button.darkmode { display: none !important; }\n:root { color-scheme: ${mode}; }\n`,
      inline: true,
    });
    js.push({
      loadTime: "beforeDOMReady",
      contentType: "inline",
      script: `document.documentElement.setAttribute("saved-theme", "${mode}");\nlocalStorage.setItem("theme", "${mode}");`,
    });
  }

  return {
    name: "QuartzTheme",
    textTransform(_ctx, src) {
      return src;
    },
    externalResources() {
      return { css, js, additionalHead: [] };
    },
  };
};
