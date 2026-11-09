# @quartz-themes/core

A Quartz transformer plugin that styles your site with an Obsidian community theme from [Quartz Themes](https://github.com/saberzero1/quartz-themes): hundreds of themes, converted from their Obsidian CSS, with per-aspect mix-and-match. The theme's CSS is added to every page, and Quartz's dark mode toggle switches between its light and dark variants.

A theme colours the page through Obsidian's CSS variables, so `configuration.theme.colors` then has little or no effect. With `@quartz-community/quartz-fonts` enabled, the theme's fonts are used as defaults (Quartz Themes runs first, at order `10`).

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
      theme: tokyo-night
      mode: both
```

Mixing aspects from other themes:

```yaml title="quartz.config.yaml"
plugins:
  - source: "@quartz-themes/core"
    enabled: true
    options:
      theme: tokyo-night
      mode: both
      aspects:
        callouts: anuppuccin
        tables: minimal
        code: false
```

## Configuration

| Option          | Type                                                    | Default         | Description                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `theme`         | `string`                                                | `"tokyo-night"` | The theme's id, e.g. `tokyo-night`, `catppuccin`, `minimal`.                                                                                                                                                                |
| `mode`          | `"both" \| "light" \| "dark"`                           | `"both"`        | Which mode(s) to include. With a single mode (or a theme that only has one), the dark mode toggle is hidden and the site stays in that mode.                                                                                |
| `variation`     | `string`                                                | —               | A variation of the theme, if it has any (e.g. `frappe` for `catppuccin`).                                                                                                                                                   |
| `aspects`       | `Record<aspect, string \| false>`                       | —               | Take single aspects from other themes, or leave them out with `false`.                                                                                                                                                      |
| `include`       | `aspect[]`                                              | all aspects     | Only include these aspects (plus those set in `aspects`).                                                                                                                                                                   |
| `themeFonts`    | `boolean`                                               | `true`          | Whether to include the theme's fonts (`@font-face` declarations; font files are loaded from unpkg).                                                                                                                         |
| `styleSettings` | `Record<string, string \| number \| boolean> \| string` | —               | For themes that support the Obsidian [Style Settings](https://github.com/mgmeyers/obsidian-style-settings) plugin: an export from that plugin, or the path to a JSON file holding one. Keys look like `minimal-style@@bg1`. |

Aspects: `base`, `headings`, `typography`, `callouts`, `tables`, `code`, `links`, `blockquotes`, `checkboxes`, `images`, `embeds`, `cards`, `search`, `scrollbars`, `explorer`, `toc`, `graph`, `popover`, `footer`, `recentNotes`, `listPage`, `darkmode`, `breadcrumbs`, `lists`, `canvas`, `bases`, `properties`, `stacked`, `misc`.

The options `fonts` and `calloutStyle` are declared in the types but not implemented yet; setting them has no effect.

## Documentation

See the [Quartz documentation](https://quartz.jzhao.xyz/plugins/ThemesCore) for more information.

## License

MIT
