import { createRequire } from "node:module";
import { execSync } from "node:child_process";
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

  if (!variation && theme.includes(".")) {
    const dotIndex = theme.indexOf(".");
    const base = theme.substring(0, dotIndex);
    const impliedVariation = theme.substring(dotIndex + 1);
    return resolveThemeId(base, impliedVariation);
  }

  throw new Error(
    `[QuartzTheme] Unknown theme: "${theme}"${variation ? ` (variation: "${variation}")` : ""}. ` +
      `Available themes: ${Object.keys(themeMetas).join(", ")}`,
  );
}

/**
 * Resolve the npm package name and require path for a theme ID.
 * Dotted IDs (e.g. "catppuccin.frappe") resolve to subpath exports
 * (e.g. @quartz-themes/catppuccin/frappe).
 */
export function resolveThemePackage(themeId: string): {
  packageName: string;
  requirePath: string;
} {
  const dotIndex = themeId.indexOf(".");
  const base = dotIndex !== -1 ? themeId.substring(0, dotIndex) : themeId;
  const variant =
    dotIndex !== -1 ? themeId.substring(dotIndex + 1) : undefined;
  const packageName = `@quartz-themes/${base}`;
  const requirePath = variant ? `${packageName}/${variant}` : packageName;
  return { packageName, requirePath };
}

/**
 * Auto-install a missing @quartz-themes/* package via npm.
 * Returns true if installation succeeded, false otherwise.
 */
export function installThemePackage(packageName: string): boolean {
  console.log(
    `[QuartzTheme] Theme package "${packageName}" is not installed. Installing...`,
  );
  try {
    execSync(`npm install ${packageName}`, {
      stdio: "inherit",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Load theme data from an @quartz-themes/* npm package via createRequire().
 * If the package is not installed, attempts to auto-install it via npm.
 */
export function loadTheme(themeId: string): ThemeData {
  const cached = themeCache.get(themeId);
  if (cached) return cached;

  if (!(themeId in themeMetas)) {
    throw new Error(`[QuartzTheme] No theme data for "${themeId}".`);
  }

  const { packageName, requirePath } = resolveThemePackage(themeId);

  try {
    const theme: ThemeData = _require(requirePath);
    themeCache.set(themeId, theme);
    return theme;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") {
      throw new Error(
        `[QuartzTheme] Failed to load theme "${themeId}" from ${requirePath}: ${err}`,
      );
    }

    if (!installThemePackage(packageName)) {
      throw new Error(
        `[QuartzTheme] Failed to install theme "${themeId}".\n` +
          `  Try manually: npm install ${packageName}`,
      );
    }

    try {
      const theme: ThemeData = _require(requirePath);
      themeCache.set(themeId, theme);
      return theme;
    } catch (retryErr) {
      throw new Error(
        `[QuartzTheme] Theme "${themeId}" was installed but could not be loaded from ${requirePath}: ${retryErr}`,
      );
    }
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
