/**
 * Theme sources: resolve the user's `theme` option to theme CSS.
 *
 * Accepted forms, in order:
 *   - a local path        ./themes/My Theme   (directory with theme.css, or a .css file)
 *   - a URL               https://…/theme.css
 *   - a GitHub repo       kepano/obsidian-minimal
 *   - a pre-3.0 id        tokyo-night, catppuccin.frappe  (+ its Style Settings preset)
 *   - a community name    Tokyo Night                     (Obsidian's theme registry)
 *   - `default`           Obsidian's built-in theme (no theme CSS)
 *
 * Community themes are downloaded the way Obsidian installs them: the theme's
 * manifest at HEAD gives its version; theme.css comes from that GitHub release,
 * falling back to the default branch, then `obsidian.css` (pre-1.0 themes), as Obsidian does.
 * Everything is cached in .quartz-cache/quartz-themes, so rebuilds and offline
 * builds work; cached registry/manifest data is refreshed after `cacheTtl`.
 */
import fs from "node:fs";
import path from "node:path";
import { LEGACY_THEMES } from "../generated/legacy-themes";

const REGISTRY_URL =
  "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/community-css-themes.json";
const DAY = 24 * 60 * 60 * 1000;
/** Names for Obsidian's own theme (`default` was its pre-3.0 id). */
const BUILT_IN = new Set(["default", "obsidian", "obsidian default"]);

export interface CommunityTheme {
  name: string;
  author?: string;
  repo: string;
  modes?: ("dark" | "light")[];
  legacy?: boolean;
}

export interface ResolvedTheme {
  /** Display name. */
  name: string;
  css: string;
  /** Modes the theme supports, when known. */
  modes?: ("dark" | "light")[];
  /** Style Settings preset implied by the theme id (pre-3.0 variants). */
  styleSettings?: Record<string, unknown>;
  /** Where the CSS came from, for logs. */
  source: string;
  version?: string;
}

export interface SourceOptions {
  /** Cache directory. Default: .quartz-cache/quartz-themes (relative to cwd). */
  cacheDir?: string;
  /** Refresh cached registry/manifest data after this many ms. Default: 1 day. */
  cacheTtl?: number;
  /** Pin a community theme to a release version. */
  version?: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

class Cache {
  constructor(
    readonly dir: string,
    readonly ttl: number,
  ) {}
  private file(key: string) {
    return path.join(this.dir, key.replace(/[^\w.@-]+/g, "_"));
  }
  read(key: string, maxAge = Infinity): string | undefined {
    const f = this.file(key);
    try {
      if (Date.now() - fs.statSync(f).mtimeMs > maxAge) return undefined;
      return fs.readFileSync(f, "utf8");
    } catch {
      return undefined;
    }
  }
  write(key: string, value: string) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file(key), value);
  }
}

async function get(f: typeof fetch, url: string): Promise<string | undefined> {
  try {
    const res = await f(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { "user-agent": "quartz-themes" },
    });
    return res.ok ? await res.text() : undefined;
  } catch {
    return undefined;
  }
}

/** Fetch with cache: fresh cache → network → stale cache. */
async function cached(
  cache: Cache,
  f: typeof fetch,
  key: string,
  url: string,
  maxAge: number,
): Promise<string | undefined> {
  const fresh = cache.read(key, maxAge);
  if (fresh !== undefined) return fresh;
  const body = await get(f, url);
  if (body !== undefined) {
    cache.write(key, body);
    return body;
  }
  return cache.read(key); // offline: any cached copy
}

export const slugify = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export async function getRegistry(
  opts: SourceOptions = {},
): Promise<CommunityTheme[]> {
  const cache = new Cache(
    opts.cacheDir ?? path.resolve(".quartz-cache/quartz-themes"),
    opts.cacheTtl ?? DAY,
  );
  const body = await cached(
    cache,
    opts.fetch ?? fetch,
    "community-css-themes.json",
    REGISTRY_URL,
    cache.ttl,
  );
  if (!body)
    throw new Error(
      "could not load Obsidian's community theme registry (offline and no cached copy)",
    );
  return JSON.parse(body) as CommunityTheme[];
}

async function fetchCommunityTheme(
  entry: CommunityTheme,
  opts: SourceOptions,
  cache: Cache,
): Promise<ResolvedTheme> {
  const f = opts.fetch ?? fetch;
  const raw = (file: string) =>
    `https://raw.githubusercontent.com/${entry.repo}/HEAD/${file}`;
  let version = opts.version;
  if (!version) {
    const manifest = await cached(
      cache,
      f,
      `${entry.repo}@HEAD.manifest.json`,
      raw("manifest.json"),
      cache.ttl,
    );
    try {
      version = manifest
        ? (JSON.parse(manifest) as { version?: string }).version
        : undefined;
    } catch {
      version = undefined;
    }
  }
  const tryUrls: [string, string][] = [];
  if (version)
    tryUrls.push([
      `${entry.repo}@${version}.theme.css`,
      `https://github.com/${entry.repo}/releases/download/${version}/theme.css`,
    ]);
  // The default branch moves, so it is cached under the manifest version (or refreshed by ttl).
  tryUrls.push([
    `${entry.repo}@HEAD${version ? `-${version}` : ""}.theme.css`,
    raw("theme.css"),
  ]);
  // Like Obsidian: themes without a theme.css (pre-1.0, or unflagged in the
  // registry) ship an obsidian.css.
  tryUrls.push([`${entry.repo}@HEAD.obsidian.css`, raw("obsidian.css")]);

  for (const [key, url] of tryUrls) {
    // Release assets are immutable: cache forever. HEAD files: honour the ttl.
    const css = await cached(
      cache,
      f,
      key,
      url,
      key.includes("@HEAD") && !version ? cache.ttl : Infinity,
    );
    if (css && css.trim())
      return {
        name: entry.name,
        css,
        modes: entry.modes,
        source: url,
        version,
      };
  }
  throw new Error(
    `could not download theme "${entry.name}" from github.com/${entry.repo} (offline and not cached?)`,
  );
}

function closest(input: string, names: string[], n = 3): string[] {
  const a = slugify(input);
  const dist = (b: string) => {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [
      i,
      ...Array(b.length).fill(0),
    ]);
    for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        dp[i]![j] = Math.min(
          dp[i - 1]![j]! + 1,
          dp[i]![j - 1]! + 1,
          dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
    return dp[a.length]![b.length]!;
  };
  return names
    .map((name) => [name, dist(slugify(name))] as const)
    .sort((x, y) => x[1] - y[1])
    .slice(0, n)
    .map(([name]) => name);
}

export async function resolveTheme(
  spec: string,
  opts: SourceOptions = {},
): Promise<ResolvedTheme> {
  const cache = new Cache(
    opts.cacheDir ?? path.resolve(".quartz-cache/quartz-themes"),
    opts.cacheTtl ?? DAY,
  );
  const trimmed = spec.trim();

  // Obsidian's built-in theme: app.css only. Checked first, so it works offline.
  if (BUILT_IN.has(trimmed.toLowerCase()))
    return {
      name: "Obsidian default",
      css: "",
      modes: ["dark", "light"],
      source: "built-in",
    };

  // URL (before local paths: a URL can end in .css too)
  if (/^https?:\/\//.test(trimmed)) {
    const css = await cached(
      cache,
      opts.fetch ?? fetch,
      `url-${trimmed}`,
      trimmed,
      cache.ttl,
    );
    if (!css) throw new Error(`could not download theme from ${trimmed}`);
    return { name: trimmed, css, source: trimmed };
  }

  // Local path
  const local = path.resolve(trimmed);
  // Explicit paths only, so a theme name never collides with a folder in cwd.
  if (
    /^(\.{1,2}[\\/]|\/|~|[A-Za-z]:[\\/])/.test(trimmed) ||
    trimmed.endsWith(".css")
  ) {
    const file =
      fs.existsSync(local) && fs.statSync(local).isDirectory()
        ? path.join(local, "theme.css")
        : local;
    if (!fs.existsSync(file)) throw new Error(`theme file not found: ${file}`);
    let name = path.basename(path.dirname(file));
    try {
      name =
        (
          JSON.parse(
            fs.readFileSync(
              path.join(path.dirname(file), "manifest.json"),
              "utf8",
            ),
          ) as { name?: string }
        ).name ?? name;
    } catch {
      /* no manifest */
    }
    return { name, css: fs.readFileSync(file, "utf8"), source: file };
  }

  const registry = await getRegistry(opts);

  // GitHub repo
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    const entry = registry.find(
      (t) => t.repo.toLowerCase() === trimmed.toLowerCase(),
    ) ?? { name: trimmed, repo: trimmed };
    return fetchCommunityTheme(entry, opts, cache);
  }

  // Pre-3.0 id → name + preset
  const legacy = LEGACY_THEMES[trimmed.toLowerCase()];
  const name = legacy?.name ?? trimmed;
  const entry =
    registry.find((t) => t.name === name) ??
    registry.find((t) => t.name.toLowerCase() === name.toLowerCase()) ??
    registry.find((t) => slugify(t.name) === slugify(name));
  if (!entry) {
    const hint = closest(
      trimmed,
      registry.map((t) => t.name),
    );
    throw new Error(
      `theme "${trimmed}" is not in Obsidian's community theme registry` +
        (legacy
          ? ` (it was "${legacy.name}", which may have been removed or renamed)`
          : "") +
        `. Did you mean: ${hint.map((h) => `"${h}"`).join(", ")}? ` +
        `A theme outside the registry can be used by GitHub repo ("owner/repo"), URL, or local path.`,
    );
  }
  const theme = await fetchCommunityTheme(entry, opts, cache);
  return {
    ...theme,
    modes: theme.modes ?? (legacy?.modes as ResolvedTheme["modes"]),
    styleSettings: legacy?.styleSettings,
  };
}

/** Snippets: local paths or URLs. */
export async function resolveSnippet(
  spec: string,
  opts: SourceOptions = {},
): Promise<string> {
  if (/^https?:\/\//.test(spec)) {
    const cache = new Cache(
      opts.cacheDir ?? path.resolve(".quartz-cache/quartz-themes"),
      opts.cacheTtl ?? DAY,
    );
    const css = await cached(
      cache,
      opts.fetch ?? fetch,
      `url-${spec}`,
      spec,
      cache.ttl,
    );
    if (!css) throw new Error(`could not download snippet ${spec}`);
    return css;
  }
  return fs.readFileSync(path.resolve(spec), "utf8");
}
