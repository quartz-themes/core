/**
 * What's behind the note. In Obsidian that's a stack of boxes, each of which
 * a theme may paint: the reading view, `.view-content`, the leaf, the tab
 * container, the tabs, the main split (`.mod-root`), `.workspace`,
 * `.horizontal-main-container`, `.app-container` and `body`. The innermost
 * opaque one shows; translucent ones (glass themes, gradient overlays) blend
 * over what's beneath. Quartz has one box there, the page.
 *
 * So every layer gets its own slot on `<body>`: a theme's rules for a layer
 * set that layer's colour and image variables (keeping their selectors and
 * specificity, so the cascade within a layer is Obsidian's), and `<body>`
 * paints all layers as background layers, innermost on top.
 *
 * The variables are registered (`@property`) as `<color>` and `<image>`: a
 * value of the wrong type (`background: var(--x)` where `--x` is a gradient,
 * fed to the colour and the tail image) falls back to transparent / none
 * instead of invalidating the whole stack.
 */
import type { Declaration, Root } from "postcss";
import postcss from "postcss";

/** Inner to outer. `body` is the last slot. */
export const BACKDROP_LAYERS = [
  "markdown-reading-view",
  "view-content",
  "workspace-leaf-content",
  "workspace-leaf",
  "workspace-tab-container",
  "workspace-tabs",
  "mod-root",
  "workspace",
  "horizontal-main-container",
  "app-container",
] as const;
export const BODY_LAYER = BACKDROP_LAYERS.length;
const LAYERS = BODY_LAYER + 1;

export const BACKGROUND_PROP =
  /^background(-color|-image|-size|-position|-repeat|-attachment)?$/i;

const v = (i: number, part: string) => `--qt-bg${i}-${part}`;

const IMAGE_FN =
  /^(?:-webkit-|-moz-)?(?:repeating-)?(?:linear|radial|conic)-gradient\(|^url\(|^(?:-webkit-)?image-set\(|^cross-fade\(|^image\(|^element\(/i;
const COLOR_FN =
  /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark|device-cmyk)\(/i;
const NOT_COLOR =
  /^(?:repeat|repeat-x|repeat-y|no-repeat|space|round|scroll|fixed|local|center|top|bottom|left|right|cover|contain|auto|border-box|padding-box|content-box|text|none|-?[\d.]+(?:[a-z%]+)?|calc\(.*|min\(.*|max\(.*|clamp\(.*)$/i;
const WIDE = /^(?:initial|inherit|unset|revert|revert-layer)$/i;

/** Split at top level (outside parentheses and strings). */
function splitTop(value: string, sep: RegExp): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && sep.test(ch)) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The image tokens of a background value's layers. */
function imageTokens(layers: string[]): string[] {
  return layers.flatMap((l) => {
    const toks = splitTop(l, /[\s/]/);
    // Beside an image function, a `var()` is its position, size or box.
    return toks.some((t) => IMAGE_FN.test(t))
      ? toks.filter((t) => IMAGE_FN.test(t))
      : toks.filter((t) => /^var\(/i.test(t));
  });
}

const IMG = "--qt-img";
const COL = "--qt-col";
const LONE_VAR = /^var\((--[\w-]+)\)$/i;

/**
 * Custom properties holding a whole background, images then a colour
 * (AbsolutelyGlass's `--ca-ambient: radial-gradient(…), #e5e2d9`). Used
 * alone (`background: var(--ca-ambient)`) they are neither an image list nor a
 * colour, so each definition gets the two halves alongside it, `--x--qt-img`
 * and `--x--qt-col`, which cascade exactly as `--x` does.
 */
export function splitBackgroundVars(root: Root): Set<string> {
  const defs = new Map<string, Declaration[]>();
  const used = new Set<string>();
  root.walkDecls((d) => {
    if (d.prop.startsWith("--")) {
      if (!defs.has(d.prop)) defs.set(d.prop, []);
      defs.get(d.prop)!.push(d);
    } else if (/^background$/i.test(d.prop)) {
      const layers = splitTop(d.value, /,/);
      if (!layers.length) return;
      const lone = LONE_VAR.exec(layers[layers.length - 1]!.trim());
      if (lone) used.add(lone[1]!);
    }
  });
  const split = new Set<string>();
  for (const name of used)
    if (
      defs.get(name)?.some((d) => {
        const layers = splitTop(d.value, /,/);
        const toks = layers.map((l) => splitTop(l, /[\s/]/));
        const hasImage = (t: string[]) => t.some((x) => IMAGE_FN.test(x));
        return (
          // Images then a colour,
          (layers.length > 1 &&
            toks.slice(0, -1).some(hasImage) &&
            !hasImage(toks[toks.length - 1]!)) ||
          // or a layer with its position, size or repeat (Whim's pattern).
          toks.some((t) => hasImage(t) && t.length > 1)
        );
      })
    )
      split.add(name);
  const halves = (value: string): [string, string] => {
    const lone = LONE_VAR.exec(value.trim());
    if (lone)
      return split.has(lone[1]!)
        ? [`var(${lone[1]}${IMG})`, `var(${lone[1]}${COL})`]
        : [value, value];
    const layers = splitTop(value, /,/);
    // An empty value (`--x:;`, ITS Theme) has no layers.
    if (!layers.length) return ["none", "transparent"];
    const last = splitTop(layers[layers.length - 1]!, /[\s/]/);
    if (last.some((t) => IMAGE_FN.test(t)))
      return [imageTokens(layers).join(", "), "transparent"];
    const images = imageTokens(layers.slice(0, -1));
    const color =
      last.find((t) => !NOT_COLOR.test(t) && !WIDE.test(t)) ?? "transparent";
    return [images.length ? images.join(", ") : "none", color];
  };
  for (const name of split)
    for (const d of defs.get(name)!) {
      const [img, col] = halves(d.value);
      d.after(
        postcss.decl({
          prop: `${name}${COL}`,
          value: col,
          important: d.important,
        }),
      );
      d.after(
        postcss.decl({
          prop: `${name}${IMG}`,
          value: img,
          important: d.important,
        }),
      );
    }
  return split;
}

/**
 * The colour and images of a `background` shorthand. A lone `var()` in the
 * last layer may be either (`var(--vignette), var(--background-primary)`): it
 * goes to the colour and to `tail`, an image slot of its own, so whichever
 * type it turns out to be survives without invalidating the other images.
 * A variable holding images and a colour (`split`) feeds its two halves.
 */
export function splitBackground(
  value: string,
  split: ReadonlySet<string> = new Set(),
): {
  color: string;
  image: string;
  tail: string;
} {
  const layers = splitTop(value, /,/);
  const images: string[] = [];
  let color = "";
  let tail = "";
  layers.forEach((layer, i) => {
    const last = i === layers.length - 1;
    const toks = splitTop(layer, /[\s/]/);
    const vars = toks.filter((t) => /^var\(/i.test(t));
    if (last && vars.length === 1 && !toks.some((t) => IMAGE_FN.test(t))) {
      const name = LONE_VAR.exec(vars[0]!)?.[1];
      if (name && split.has(name)) {
        tail = `var(${name}${IMG})`;
        color = `var(${name}${COL})`;
      } else tail = color = vars[0]!;
      return;
    }
    const withImage = toks.some((t) => IMAGE_FN.test(t));
    for (const tok of toks) {
      if (IMAGE_FN.test(tok)) images.push(tok);
      else if (/^var\(/i.test(tok)) {
        if (!withImage) images.push(tok);
        if (last) color = tok;
      } else if (
        last &&
        !NOT_COLOR.test(tok) &&
        !WIDE.test(tok) &&
        (COLOR_FN.test(tok) ||
          /^#[\da-f]{3,8}$/i.test(tok) ||
          /^[a-z]+$/i.test(tok))
      )
        color = tok;
    }
  });
  return {
    color: color || "transparent",
    image: images.length ? images.join(", ") : "none",
    tail: tail || "none",
  };
}

/** The layer variables a background declaration sets. */
export function layerDecls(
  d: Declaration,
  layer: number,
  split?: ReadonlySet<string>,
): Declaration[] {
  const prop = d.prop.toLowerCase();
  const value = d.value.trim();
  const decl = (part: string, val: string) =>
    postcss.decl({ prop: v(layer, part), value: val, important: d.important });
  if (WIDE.test(value)) {
    if (prop === "background")
      return [
        decl("color", "transparent"),
        decl("image", "none"),
        decl("tail", "none"),
      ];
    if (prop === "background-color") return [decl("color", "transparent")];
    if (prop === "background-image")
      return [decl("image", "none"), decl("tail", "none")];
    return [];
  }
  switch (prop) {
    case "background": {
      const { color, image, tail } = splitBackground(value, split);
      return [decl("color", color), decl("image", image), decl("tail", tail)];
    }
    case "background-color":
      return [decl("color", value)];
    case "background-image":
      return [decl("image", value), decl("tail", "none")];
    default:
      return [decl(prop.slice("background-".length), value)];
  }
}

/** Registrations; before any layer. */
export function backdropProperties(): string {
  const out: string[] = [];
  for (let i = 0; i < LAYERS; i++) {
    out.push(
      `@property ${v(i, "color")} { syntax: "<color>"; inherits: false; initial-value: transparent; }`,
      `@property ${v(i, "image")} { syntax: "none | <image>#"; inherits: false; initial-value: none; }`,
      `@property ${v(i, "tail")} { syntax: "none | <image>#"; inherits: false; initial-value: none; }`,
    );
  }
  return out.join("\n");
}

/** `<body>` paints every layer, innermost first (on top). */
export function backdropCss(): string {
  const images: string[] = [];
  const sizes: string[] = [];
  const positions: string[] = [];
  const repeats: string[] = [];
  const attachments: string[] = [];
  for (let i = 0; i < LAYERS; i++) {
    for (const part of ["image", "tail"]) {
      images.push(`var(${v(i, part)})`);
      sizes.push(`var(${v(i, "size")}, auto)`);
      positions.push(`var(${v(i, "position")}, 0% 0%)`);
      repeats.push(`var(${v(i, "repeat")}, repeat)`);
      attachments.push(`var(${v(i, "attachment")}, scroll)`);
    }
    if (i < BODY_LAYER) {
      const c = `var(${v(i, "color")})`;
      images.push(`linear-gradient(${c}, ${c})`);
      sizes.push("auto");
      positions.push("0% 0%");
      repeats.push("repeat");
      attachments.push("scroll");
    }
  }
  return `body {
  background-color: var(${v(BODY_LAYER, "color")});
  background-image: ${images.join(", ")};
  background-size: ${sizes.join(", ")};
  background-position: ${positions.join(", ")};
  background-repeat: ${repeats.join(", ")};
  background-attachment: ${attachments.join(", ")};
}
`;
}
