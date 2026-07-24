import { createRequire } from "node:module";
import type { ThemeData, ThemeMeta } from "./types";
import { themeMetas } from "./themes/_registry";

const _require = createRequire(import.meta.url);

const themeCache = new Map<string, ThemeData>();

export function resolveThemeId(theme: string, variation?: string): string {
  if (variation) {
    const variantId = `${theme}.${variation}`;
    if (variantId in themeMetas) return variantId;
  }
  if (theme in themeMetas) return theme;
  throw new Error(
    `[QuartzTheme] Unknown theme: "${theme}"${variation ? ` (variation: "${variation}")` : ""}. ` +
      `Available themes: ${Object.keys(themeMetas).join(", ")}`,
  );
}

/**
 * Load theme data from an @quartz-themes/* npm package via createRequire().
 * Dotted IDs (e.g. "catppuccin.frappe") resolve to subpath exports
 * (e.g. @quartz-themes/catppuccin/frappe).
 */
export function loadTheme(themeId: string): ThemeData {
  const cached = themeCache.get(themeId);
  if (cached) return cached;

  if (!(themeId in themeMetas)) {
    throw new Error(`[QuartzTheme] No theme data for "${themeId}".`);
  }

  const dotIndex = themeId.indexOf(".");
  const base = dotIndex !== -1 ? themeId.substring(0, dotIndex) : themeId;
  const variant =
    dotIndex !== -1 ? themeId.substring(dotIndex + 1) : undefined;
  const packageName = `@quartz-themes/${base}`;
  const requirePath = variant ? `${packageName}/${variant}` : packageName;

  try {
    const theme: ThemeData = _require(requirePath);
    themeCache.set(themeId, theme);
    return theme;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") {
      throw new Error(
        `[QuartzTheme] Theme "${themeId}" is not installed.\n` +
          `  Run: npm install ${packageName}`,
      );
    }
    throw new Error(
      `[QuartzTheme] Failed to load theme "${themeId}" from ${requirePath}: ${err}`,
    );
  }
}

export function getThemeMeta(themeId: string): ThemeMeta | undefined {
  return themeMetas[themeId];
}

export function getAvailableThemes(): string[] {
  return Object.keys(themeMetas);
}

export function registerTheme(
  id: string,
  meta: ThemeMeta,
  data: ThemeData,
): void {
  themeCache.set(id, data);
  themeMetas[id] = meta;
}
