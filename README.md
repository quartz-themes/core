# @quartz-themes/core

A Quartz transformer plugin that styles your site with **any Obsidian community theme**. You name the theme; at build time the plugin downloads it (the same file Obsidian installs) and converts its CSS for Quartz's markup. Quartz's dark mode toggle switches between the theme's light and dark variants, and [Style Settings](https://github.com/mgmeyers/obsidian-style-settings) exports work as they do in Obsidian.

Requires Quartz 5.2 or later.

## Installation

```bash
npx quartz plugin add @quartz-themes/core
```

Quartz's default configuration has a disabled entry for this plugin; set `enabled: true` to use it.

## Usage

```yaml title="quartz.config.yaml"
plugins:
  - source: "@quartz-themes/core"
    enabled: true
    options:
      theme: Tokyo Night
      mode: both
```

`theme` accepts:

- a community theme name, as listed in Obsidian's theme browser: `Minimal`, `AnuPpuccin`, `Tokyo Night`;
- a GitHub repository, for themes outside the registry: `kepano/obsidian-minimal`;
- a URL to a `theme.css`, or a local path: `./themes/My Theme` (a folder with `theme.css`) or `./my-theme.css`;
- an id from earlier versions (`tokyo-night`, `catppuccin.frappe`), which maps to the theme plus the Style Settings preset it used.
- `default`, for Obsidian's built-in theme (no community theme).

With Style Settings and a snippet:

```yaml title="quartz.config.yaml"
plugins:
  - source: "@quartz-themes/core"
    enabled: true
    options:
      theme: Minimal
      styleSettings: ./style-settings.json # an export from the Style Settings plugin
      snippets:
        - ./snippets/wide-tables.css
```

## Configuration

| Option          | Type                          | Default                       | Description                                                                                                                                                         |
| --------------- | ----------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `theme`         | `string`                      | `"Tokyo Night"`               | The theme: a community name, `owner/repo`, URL, local path, or pre-3.0 id (see above).                                                                              |
| `mode`          | `"both" \| "light" \| "dark"` | `"both"`                      | Which mode(s) to include. With a single mode (or a theme that only has one), the dark mode toggle is hidden and the site stays in that mode.                        |
| `styleSettings` | `object \| string`            | —                             | A Style Settings export, or the path to a JSON file holding one. Keys look like `minimal-style@@h1-color@@dark`.                                                    |
| `snippets`      | `string[]`                    | —                             | Obsidian CSS snippets (paths or URLs), applied after the theme.                                                                                                     |
| `version`       | `string`                      | latest                        | Pin a community theme to a release version.                                                                                                                         |
| `themeFonts`    | `boolean`                     | `true`                        | Use the theme's fonts. `false` uses your Quartz fonts (`theme.typography` or the Fonts plugin) instead. Fonts the theme bundles but never uses are always left out. |
| `cacheDir`      | `string`                      | `.quartz-cache/quartz-themes` | Where downloaded themes are cached. Builds work offline from the cache.                                                                                             |
| `cacheHours`    | `number`                      | `24`                          | How long before checking for a new theme version.                                                                                                                   |

## How it works

The theme's real CSS is kept — hover states, media queries, `:has()`, and the theme's own cascade — and rewritten for Quartz:

- editor and app-only rules (CodeMirror, workspace chrome, settings) are dropped;
- Obsidian's layout wrappers are removed from selectors without changing specificity, so overrides (including Style Settings) resolve exactly as in Obsidian;
- body classes (`.theme-dark`, Style Settings toggles, `.is-mobile`) are evaluated at build time;
- Obsidian's own reading-view stylesheet ships with the plugin, so the variables themes set (`--h1-color`, `--callout-border-width`, …) take effect;
- malformed CSS is recovered the way a browser does; rules Quartz's minifier rejects are passed through unchanged in a separate stylesheet.

Everything is placed in `@layer obsidian`, above Quartz's own styles. Page layout stays Quartz's.

## Migrating from 2.x

- Themes are downloaded and converted at build time; the per-theme `@quartz-themes/<theme>` packages are no longer needed and can be removed.
- `aspects`, `include`, `calloutStyle` and `fonts` were removed (themes are converted whole). `variation` still works for the old variants, but prefer `styleSettings`.
- Theme ids from 2.x keep working.

## Documentation

See the [Quartz documentation](https://quartz.jzhao.xyz/plugins/ThemesCore).

## License

MIT
