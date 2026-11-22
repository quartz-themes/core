/**
 * QuartzTheme — style a Quartz site with an Obsidian community theme.
 *
 * The factory is async (Quartz 5.2+ awaits it): it resolves the theme,
 * downloads it if needed, and converts it with the static converter before
 * the build starts. CSS is then injected through externalResources().
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  CSSResource,
  JSResource,
  QuartzTransformerPluginInstance,
} from "@quartz-community/types";
import { convertTheme, extractFontData } from "./convert";
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

/**
 * A file Quartz 5.1+ copies to static/plugins/<to> (externalResources().assets).
 * Declared here, like AsyncTransformerPlugin, so core works with older types.
 */
interface StaticAsset {
  from: string;
  to: string;
}

/** Below static/plugins/ (Quartz 5.1+ copies plugin assets there). */
const FONT_ASSET_DIR = "quartz-themes/fonts";

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
  const result = convertTheme({
    themeCss: theme.css,
    styleSettings,
    snippets,
    themeFonts: options.themeFonts !== false,
  });
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

  const f = result.report.fonts;
  if (f.bytes)
    log(
      `dropped ${[
        f.unused.length && `${f.unused.length} unused font families`,
        f.unresolvable.length &&
          `${f.unresolvable.length} fonts whose files aren't part of the theme`,
      ]
        .filter(Boolean)
        .join(" and ")} (${Math.round(f.bytes / 1024)} KB)`,
    );

  // Modes: honour what the theme supports.
  let mode = options.mode;
  const supported = theme.modes;
  if (supported?.length === 1 && mode !== supported[0]) {
    if (mode !== "both")
      log(`"${theme.name}" only supports ${supported[0]} mode; using it.`);
    mode = supported[0]!;
  }

  // Embedded fonts become files next to the stylesheet Quartz extracts the
  // theme CSS into (static/resource-style-*.css → static/plugins/…).
  const fontDir = path.join(
    options.cacheDir ?? path.resolve(".quartz-cache/quartz-themes"),
    "fonts",
  );
  const assets: StaticAsset[] = [];
  const hash = (data: Uint8Array) =>
    crypto.createHash("sha256").update(data).digest("hex").slice(0, 20);
  const extract = (css: string) => {
    const out = extractFontData(css, `plugins/${FONT_ASSET_DIR}`, hash);
    if (out.files.length) fs.mkdirSync(fontDir, { recursive: true });
    for (const f of out.files) {
      const file = path.join(fontDir, f.name);
      if (!fs.existsSync(file)) fs.writeFileSync(file, f.data);
      assets.push({ from: file, to: `${FONT_ASSET_DIR}/${f.name}` });
    }
    return out.css;
  };
  const main = extract(result.main);
  const raw = result.raw && extract(result.raw);
  if (assets.length)
    log(
      `${assets.length} embedded fonts moved to static/plugins/${FONT_ASSET_DIR}`,
    );
  if (options.themeFonts !== false) {
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
      const resources = { css, js, additionalHead: [], assets };
      return resources;
    },
  };
};
