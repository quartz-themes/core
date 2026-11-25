/**
 * Static Obsidian → Quartz CSS converter.
 *
 * Takes an Obsidian stylesheet (a community theme.css, or Obsidian's own
 * app.css) and rewrites it to target Quartz's DOM, without running Obsidian.
 *
 * Principles:
 *  - Keep the theme's real rules (states, media queries, :has, cascade) instead
 *    of snapshotting computed values.
 *  - Preserve specificity exactly when rewriting, so the theme's own cascade —
 *    and Style Settings overrides in particular — resolve as they do in Obsidian.
 *    Elided compounds become `:not(.qt-0)` style padding that matches anything
 *    but contributes the same specificity as what it replaced.
 *  - Evaluate body-class state (Style Settings toggles, is-mobile, …) at build
 *    time: statically-false selectors are dropped, statically-true classes are
 *    padded away.
 *  - Never crash on malformed input: strict parse, else postcss-safe-parser,
 *    else LightningCSS error recovery. Rules LightningCSS (Quartz's minifier)
 *    still rejects are quarantined into a separate sheet.
 */
import postcss, {
  type AtRule,
  type ChildNode,
  type Container,
  type Declaration,
  type Root,
  type Rule,
} from "postcss";

const safeParseRoot = (css: string, opts: { from: string }) =>
  safeParse(css, opts) as Root;
import safeParse from "postcss-safe-parser";
import { flattenNesting } from "./nesting";
import selectorParser from "postcss-selector-parser";
// The prebuilt bundle: css-tree's lib/ loads JSON at runtime, which breaks once bundled.
import * as csstree from "css-tree/dist/csstree.esm";
import { Features, transform } from "lightningcss";
import {
  BACKDROP_LAYERS,
  BACKGROUND_PROP,
  BODY_LAYER,
  layerDecls,
  splitBackgroundVars,
} from "./backdrop";
import {
  BODY_STATE,
  WRAPPER_CLASSES,
  WRAPPER_MAP,
  LEAF_TYPE_MAP,
  RENAMES,
  CLASS_QUALIFY,
  RENAME_UNLESS,
  TAG_REWRITES,
  CONTENT_WRAPPERS,
  CONTENT_ROOT,
  CONTENT_ROOT_CLASSES,
  BARE_TAGS,
  LANGUAGE_CLASS_PREFIX,
  PRISM_TOKENS,
  WORKSPACE_STATE,
  QUARTZ_LAYOUT_PREFIXES,
  FILES_CONTAINER,
  TREE_ITEM_CLASSES,
  TREE_PART_CLASSES,
  isAppOnly,
} from "./profile";

type SNode = selectorParser.Node;
type SSelector = selectorParser.Selector;
export type Spec = [number, number, number];

const LOGICAL_PSEUDOS = new Set([
  ":is",
  ":where",
  ":matches",
  ":-webkit-any",
  ":-moz-any",
]);
const MODE_ATTR: Record<string, string> = {
  "theme-dark": "dark",
  "theme-light": "light",
};
const CLASS_SPEC: Spec = [0, 1, 0];

export type DropReason =
  "appOnly" | "staticFalse" | "wrapperSubject" | "unparseable" | "leafType";

export interface ConvertStats {
  rules: number;
  keptVerbatim: number;
  rewritten: number;
  dropped: Record<DropReason, number>;
  selectors: { in: number; out: number };
  layoutStripped: number;
  iconsResolved: number;
  repaired: false | "css-tree" | "safe-parser";
  warnings: string[];
  quarantined: number;
  unmatchedClasses: Record<string, number>;
}

export interface ConvertOptions {
  /** Extra body-class state, e.g. Style Settings class toggles resolved to true/false. */
  bodyClasses?: Record<string, boolean>;
  /** Classes known to exist in Quartz output; only used for reporting. */
  quartzClasses?: Set<string>;
  /**
   * Map an Obsidian icon id (`lucide-flame`, `flame`) to a CSS image value.
   * Used to rewrite `--callout-icon` and friends, which Quartz renders as masks.
   */
  resolveIcon?: (name: string) => string | undefined;
  filename?: string;
}

export interface ConvertResult {
  css: string;
  /** Rules Quartz's minifier would reject, verbatim; serve as a separate resource. */
  quarantine: string;
  stats: ConvertStats;
}

/** Parse a selector snippet and return the nodes of its first compound list. */
function nodesOf(str: string): SNode[] {
  const root = selectorParser().astSync(str);
  return root.first.nodes.map((n) => n.clone() as SNode);
}

/** `::before`, and the single-colon forms CSS2 allowed (`:before`, `:after`…). */
function isPseudoElement(n: SNode): boolean {
  return (
    n.type === "pseudo" &&
    (n.value.startsWith("::") ||
      /^:(before|after|first-line|first-letter)$/i.test(n.value))
  );
}

/** Nodes that match any element and add the given specificity. */
export function pad([a, b, c]: Spec): SNode[] {
  const parts: string[] = [];
  for (let i = 0; i < a; i++) parts.push(":not(#qt-0)");
  for (let i = 0; i < b; i++) parts.push(":not(.qt-0)");
  for (let i = 0; i < c; i++) parts.push(":not(qt-0)");
  return parts.length ? nodesOf(parts.join("")) : [];
}

/**
 * Repair + parse.
 * 1. strict postcss (byte-faithful for valid CSS)
 * 2. css-tree, which tokenizes and recovers from errors exactly as the CSS
 *    Syntax spec (and therefore the browser, and therefore Obsidian) does; its
 *    tree is converted to a postcss tree directly, keeping values verbatim
 * 3. postcss-safe-parser as a last resort
 *
 * Declarations a browser would keep but discard at computed-value time
 * (`background: var(--x) border: 1px solid`, a missing `;`) are kept as-is,
 * exactly like in Obsidian; the quarantine step deals with any that Quartz's
 * minifier rejects.
 */
export function parseTolerant(css: string, filename = "theme.css") {
  try {
    return {
      root: postcss.parse(css, { from: filename }),
      repaired: false as const,
      warnings: [] as string[],
    };
  } catch (strictError) {
    const warnings = [`strict parse: ${errMessage(strictError)}`];
    try {
      const root = parseLikeBrowser(css, warnings);
      return { root, repaired: "css-tree" as const, warnings };
    } catch (treeError) {
      warnings.push(`css-tree: ${errMessage(treeError)}`);
    }
    return {
      root: safeParseRoot(css, { from: filename }),
      repaired: "safe-parser" as const,
      warnings,
    };
  }
}

function errMessage(e: unknown): string {
  const err = e as { reason?: string; message?: string };
  return err.reason ?? err.message ?? String(e);
}

/** Spec-compliant parse (css-tree) → postcss tree. */
function parseLikeBrowser(css: string, warnings: string[]): Root {
  let errors = 0;
  const ast = csstree.parse(css, {
    parseValue: false,
    parseCustomProperty: false,
    parseRulePrelude: false,
    parseAtrulePrelude: false,
    onParseError: () => errors++,
  });
  if (errors)
    warnings.push(`css-tree recovered from ${errors} syntax error(s)`);
  const root = postcss.root();
  const text = (node: csstree.CssNode | null | undefined) =>
    node ? csstree.generate(node).trim() : "";
  const visit = (node: csstree.CssNode, parent: Container) => {
    switch (node.type) {
      case "Rule": {
        const rule = postcss.rule({ selector: text(node.prelude) });
        parent.append(rule);
        node.block.children.forEach((c) => visit(c, rule));
        break;
      }
      case "Atrule": {
        const at = postcss.atRule({
          name: node.name,
          params: text(node.prelude),
        });
        parent.append(at);
        if (node.block) {
          at.nodes = [];
          node.block.children.forEach((c) => visit(c, at));
        }
        break;
      }
      case "Declaration": {
        const value = text(node.value);
        if (!value && !node.property.startsWith("--")) break;
        parent.append(
          postcss.decl({
            prop: node.property,
            value,
            important: node.important === true,
          }),
        );
        break;
      }
      default:
        // Raw garbage the spec discards.
        break;
    }
  };
  if (ast.type === "StyleSheet") ast.children.forEach((c) => visit(c, root));
  return root;
}

/** Custom properties that hold an Obsidian icon id. */
const ICON_PROPS = /^--(callout-icon|checkbox-icon|.*-icon)$/;

/**
 * Rules that paint a box of Obsidian's main pane that isn't the main pane's:
 * a sidebar, a popover, another view type, an editor.
 */
const OTHER_PANE =
  /mod-left-split|mod-right-split|mod-sidedock|side-dock|workspace-drawer|workspace-fake-target|popover|is-sidebar|ribbon|modal|mod-stacked|:not\(\.mod-root\)|:not\(\[data-type\s*=\s*["']?markdown|data-type\s*(?:[~|^$*]?=\s*(?!["']?markdown["'\]\s])|[~|^$*]=)|data-mode\s*=\s*["']?source|markdown-source-view|is-live-preview|is-translucent|is-fullscreen/;

/** Obsidian's backdrop layer a compound is (see backdrop.ts), or -1. */
function backdropLayer(c: Compound): number {
  const classes = classesOf(c);
  if (
    !classes.length ||
    c.nodes.some((n) => n.type === "tag" && n.value !== "div")
  )
    return -1;
  // Only the layer's own classes and wrapper state (`.mod-active`, `.is-focused`…).
  if (
    classes.some(
      (k) =>
        !WRAPPER_CLASSES.has(k) && !/^(mod|is)-/.test(k) && k !== "mod-root",
    )
  )
    return -1;
  for (let i = 0; i < BACKDROP_LAYERS.length; i++)
    if (classes.includes(BACKDROP_LAYERS[i]!)) return i;
  // A bare `.workspace-split` matches the main split too (`.workspace-split
  // .mod-vertical.mod-root`); horizontal ones are sidebars or nested splits.
  if (
    classes.includes("workspace-split") &&
    !classes.includes("mod-horizontal")
  )
    return BACKDROP_LAYERS.indexOf("mod-root");
  return -1;
}

/** Properties an element inherits from its parent. */
const INHERITED =
  /^(?:--.*|color|font(?:-.*)?|letter-spacing|word-spacing|line-height|text-(?:transform|shadow|rendering|align|indent|wrap|underline-offset|decoration-skip-ink)|-webkit-font-smoothing|-moz-osx-font-smoothing|font-smooth|hyphens|tab-size|direction|quotes|caret-color)$/i;
/** The note's own boxes, which hold Obsidian's properties block. */
const NOTE_BOXES = new Set([
  "markdown-preview-view",
  "markdown-rendered",
  "markdown-preview-sizer",
  "markdown-preview-section",
]);

/**
 * Obsidian's properties block sits inside the note's sizer and inherits its
 * text styles (Cairn's `.markdown-rendered { letter-spacing }`); Quartz's sits
 * above the note. Each rule for the note's boxes also gives the block its
 * inherited properties, at zero specificity so that any rule for the block
 * itself wins, as over inheritance.
 */
function propertiesInherit(root: Root): void {
  root.walkRules((rule) => {
    const parent = rule.parent as AtRule | undefined;
    if (parent?.type === "atrule" && /keyframes$/i.test(parent.name)) return;
    const decls = (rule.nodes ?? []).flatMap((n): Declaration[] => {
      if (n.type !== "decl") return [];
      if (INHERITED.test(n.prop)) return [n];
      // Not inherited, but behind the block in Obsidian, where the block
      // sits inside the note (Blue Topaz's coloured note under transparent
      // properties). Just the colour: an image would fit another box.
      const colour = noteBoxColour(n);
      return colour ? [colour] : [];
    });
    if (!decls.length) return;
    const out: string[] = [];
    try {
      selectorParser((selectors) => {
        selectors.each((whole) => {
          // `:is(.markdown-preview-section, .markdown-rendered)`: each box.
          for (const sel of subjectAlternatives(whole)) one(sel);
        });
        function one(sel: SSelector): void {
          if (
            OTHER_PANE.test(String(sel)) ||
            /metadata-|embed|callout/.test(String(sel))
          )
            return;
          const all = splitCompounds(sel);
          const subject = all[all.length - 1]!;
          const classes = classesOf(subject);
          if (
            !classes.some((k) => NOTE_BOXES.has(k)) ||
            classes.some(
              (k) => !NOTE_BOXES.has(k) && !/^(mod|is|allow)-/.test(k),
            ) ||
            subject.nodes.some(
              (n) =>
                (n.type === "tag" && n.value !== "div") ||
                (n.type === "pseudo" && !/^:(not|is|where)$/i.test(n.value)),
            )
          )
            return;
          // The note's boxes as the converter knows them, so they're elided
          // like any content wrapper (Quartz's block is outside the note):
          // Blue Topaz's `:is(.markdown-preview-view,
          // .markdown-rendered).is-readable-line-width` ancestor otherwise
          // stays a condition no ancestor of the block meets.
          const parts = all.map(
            (c, i) =>
              (i > 0
                ? String(
                    c.before!.value.trim()
                      ? ` ${c.before!.value.trim()} `
                      : " ",
                  )
                : "") +
              (i === all.length - 1 || isNoteBox(c)
                ? ".markdown-rendered"
                : c.nodes.map(String).join("").trim()),
          );
          out.push(`:where(${parts.join("")} .metadata-container)`);
        }
      }).processSync(rule.selector);
    } catch {
      return;
    }
    if (!out.length) return;
    const copy = postcss.rule({ selector: out.join(", ") });
    // Inherited values never carry !important: the block's own rules win.
    for (const d of decls) copy.append(d.clone({ important: false }));
    rule.after(copy);
  });
}

/** A note box's background colour, as `background-color`. */
function noteBoxColour(d: Declaration): Declaration | null {
  if (d.prop === "background-color") return d;
  if (d.prop !== "background") return null;
  const v = d.value.trim();
  // A single colour or variable; layered backgrounds, images and positions
  // would need the shorthand parsed.
  if (
    /[\s,]/.test(v.replace(/\([^()]*\)/g, "()")) ||
    /url\(|gradient\(/i.test(v)
  )
    return null;
  return d.clone({ prop: "background-color" });
}

/** One of the note's own boxes, possibly as an `:is()` of them, with states. */
function isNoteBox(c: Compound): boolean {
  let box = false;
  for (const n of c.nodes) {
    if (n.type === "class") {
      if (NOTE_BOXES.has(n.value)) box = true;
      else if (!/^(mod|is|allow)-/.test(n.value)) return false;
    } else if (n.type === "tag") {
      if (n.value.toLowerCase() !== "div") return false;
    } else if (n.type === "pseudo" && /^:(is|where)$/i.test(n.value)) {
      const alts = (n as selectorParser.Pseudo).nodes;
      if (
        !alts.every(
          (a) =>
            a.nodes.length === 1 &&
            a.nodes[0]!.type === "class" &&
            NOTE_BOXES.has(a.nodes[0]!.value),
        )
      )
        return false;
      box = true;
    } else if (!(n.type === "pseudo" && /^:not$/i.test(n.value))) return false;
  }
  return box;
}

/** Tags of the note's blocks, each in its own `div.el-*` in Obsidian. */
const WRAPPED_BLOCKS = /^(h[1-6]|p|ul|ol|blockquote|table|pre|hr)$/i;
/**
 * An inline box alone in a block wrapper, as a block box. Atomic inlines
 * (`inline-block`, `inline-flex`…) are left as they are: their margins don't
 * collapse in the wrapper's line box, which a block box can't match, and
 * they already stack once they fill the line.
 */
const AS_WRAPPED: Record<string, string> = { inline: "block" };

/**
 * Obsidian wraps each of the note's blocks in a `div.el-*`, so a theme that
 * makes headings inline (Adrenaline) still stacks them, one per wrapper; in
 * Quartz they'd run together on one line. Top-level blocks a theme makes
 * inline lay out as alone in a block: fitted to their content, without
 * vertical margins.
 */
function wrappedInlineBlocks(root: Root): void {
  root.walkRules((rule) => {
    const parent = rule.parent as AtRule | undefined;
    if (parent?.type === "atrule" && /keyframes$/i.test(parent.name)) return;
    const display = (rule.nodes ?? []).filter(
      (n): n is Declaration =>
        n.type === "decl" &&
        n.prop.toLowerCase() === "display" &&
        n.value.trim().toLowerCase() in AS_WRAPPED,
    );
    if (!display.length) return;
    const out: string[] = [];
    try {
      selectorParser((selectors) => {
        selectors.each((sel) => {
          const all = splitCompounds(sel);
          const subject = all[all.length - 1]!;
          const tag = subject.nodes.find((n) => n.type === "tag");
          if (!tag || !WRAPPED_BLOCKS.test(tag.value)) return;
          if (subject.nodes.some(isPseudoElement)) return;
          const copy = sel.clone() as SSelector;
          copy.append(
            selectorParser.pseudo({
              value: ":where",
              nodes: [
                selectorParser().astSync(".markdown-preview-view > *").first,
              ],
            }),
          );
          out.push(String(copy).trim());
        });
      }).processSync(rule.selector);
    } catch {
      return;
    }
    if (!out.length) return;
    const copy = postcss.rule({ selector: out.join(", ") });
    for (const d of display) {
      const v = d.value.trim().toLowerCase();
      copy.append(d.clone({ value: AS_WRAPPED[v]! }));
      copy.append(
        postcss.decl({
          prop: "width",
          value: "fit-content",
          important: d.important,
        }),
      );
      // An inline box's vertical margins don't move anything.
      copy.append(
        postcss.decl({ prop: "margin-block", value: "0", important: true }),
      );
    }
    rule.after(copy);
  });
}

/** Inherited text properties a universal rule gives Obsidian's block wrappers. */
const WRAPPER_INHERITED =
  /^(color|font-family|font-weight|font-style|font-stretch|font-feature-settings|font-variation-settings|font-optical-sizing|font-variant(-[a-z]+)?|letter-spacing|word-spacing|line-height|text-shadow|text-transform|-webkit-font-smoothing|text-rendering)$/;

/**
 * Obsidian's blocks sit in wrapper divs that only universal rules reach
 * (`* { font-family: "JetBrains Mono" }`), so what a block inherits, also
 * through app.css's `--h2-font: inherit`, is the universal rule's value. In
 * Quartz they sit in the note root, which app.css's `.markdown-preview-view {
 * font-family: var(--font-text) }` reaches more specifically (SpectrumPlus's
 * headings). The sizer stands in for the wrappers: it gets a copy of the
 * universal rule's inherited properties, above the note's own rules (an id),
 * below any rule for the blocks, which are its children.
 */
function universalWrappers(root: Root): void {
  root.walkRules((rule) => {
    const parent = rule.parent as AtRule | undefined;
    if (parent?.type === "atrule" && /keyframes$/i.test(parent.name)) return;
    const decls = (rule.nodes ?? []).filter(
      (n): n is Declaration =>
        n.type === "decl" && WRAPPER_INHERITED.test(n.prop),
    );
    if (!decls.length) return;
    let sels: string[];
    try {
      sels = selectorParser()
        .astSync(rule.selector)
        .nodes.flatMap((sel) => {
          const all = splitCompounds(sel);
          const subject = all[all.length - 1]!;
          if (
            subject.nodes.length !== 1 ||
            subject.nodes[0]!.type !== "universal" ||
            // Only <body>/<html> conditions above it: `.callout *` is no wrapper.
            all.slice(0, -1).some((c) => {
              const top = c.nodes.some(
                (n) =>
                  (n.type === "tag" && /^(body|html)$/i.test(n.value)) ||
                  (n.type === "pseudo" && /^:root$/i.test(n.value)),
              );
              return c.nodes.some(
                (n) =>
                  !(
                    (n.type === "tag" && /^(body|html)$/i.test(n.value)) ||
                    (n.type === "pseudo" && /^:(root|not)$/i.test(n.value)) ||
                    (n.type === "class" && (top || n.value in BODY_STATE))
                  ),
              );
            })
          )
            return [];
          const head = all
            .slice(0, -1)
            .map((c) => c.nodes.map(String).join("").trim())
            .join(" ");
          return [`${head} .markdown-preview-sizer:not(#qt-0)`.trim()];
        });
    } catch {
      return;
    }
    if (!sels.length) return;
    const copy = postcss.rule({ selector: sels.join(", ") });
    for (const d of decls) copy.append(d.clone());
    rule.after(copy);
  });
}

/**
 * A selector whose subject has an `:is()` / `:where()` of compounds, once per
 * alternative (`.leaf :is(.view-header, .view-content)` paints `.view-content`).
 */
function subjectAlternatives(sel: SSelector): SSelector[] {
  const all = splitCompounds(sel);
  const subject = all[all.length - 1]!;
  const is = subject.nodes.find(
    (n): n is selectorParser.Pseudo =>
      n.type === "pseudo" &&
      /^:(is|where|matches|-webkit-any)$/i.test(n.value) &&
      n.nodes.length > 0 &&
      n.nodes.every((a) => !a.nodes.some((x) => x.type === "combinator")),
  );
  if (!is) return [sel];
  const at = sel.index(is);
  return is.nodes.flatMap((alt) => {
    const copy = sel.clone() as SSelector;
    copy.at(at).replaceWith(...alt.clone().nodes);
    return subjectAlternatives(copy);
  });
}

/**
 * Themes paint the boxes behind the note (Border: `body.theme-dark
 * .workspace-split.mod-root .workspace-tabs`; Agate: `.app-container`). Those
 * boxes don't exist in Quartz, where the page itself is behind the note: each
 * rule is copied onto `<body>` as its layer's variables, at the same
 * specificity, keeping the classes it requires of `<body>` (Style Settings
 * toggles, `.theme-dark`), and the main pass maps it like any body rule.
 * Transparent values are copied too: they override a less specific rule for
 * the same box (Obsidian's own pane backgrounds).
 */
function paneBackgrounds(root: Root, split: ReadonlySet<string>): void {
  const copies: [Rule, Map<number, [string, Spec][]>, Declaration[]][] = [];
  root.walkRules((rule) => {
    const parent = rule.parent as AtRule | undefined;
    if (parent?.type === "atrule" && /keyframes$/i.test(parent.name)) return;
    const decls = (rule.nodes ?? []).filter(
      (n): n is Declaration =>
        n.type === "decl" &&
        (BACKGROUND_PROP.test(n.prop) ||
          n.prop.startsWith("--") ||
          BOX_INHERITED.test(n.prop)),
    );
    if (!decls.length) return;
    const byLayer = new Map<number, [string, Spec][]>();
    try {
      selectorParser((selectors) => {
        selectors.each((whole) => {
          const spec = specificity(whole);
          for (const sel of subjectAlternatives(whole)) paint(sel, spec);
        });
        function paint(sel: SSelector, spec: Spec): void {
          if (OTHER_PANE.test(String(sel))) return;
          const all = splitCompounds(sel);
          const subject = all[all.length - 1]!;
          if (
            subject.nodes.some(
              (n) =>
                n.type === "pseudo" &&
                (isPseudoElement(n) ||
                  /^:(hover|focus|active|focus-within|focus-visible)/.test(
                    n.value,
                  )),
            )
          )
            return;
          const layer = backdropLayer(subject);
          if (layer < 0) return;
          // A box's own conditions (`.markdown-reading-view:has(> .sci-fi)`)
          // can't move to <body>: dropped, they'd always apply.
          if (
            all.some(
              (c, i) =>
                backdropLayer(c) >= 0 &&
                c.nodes.some(
                  (n) => n.type === "pseudo" && /^:has$/i.test(n.value),
                ),
            )
          )
            return;
          // Body conditions: a body-ish first compound, else non-wrapper
          // classes and :not()s of the ancestors (Style Settings toggles live
          // on <body>).
          const first = all[0]!;
          const bodyish =
            all.length > 1 &&
            first.nodes.some(
              (n) =>
                (n.type === "tag" && /^(body|html)$/i.test(n.value)) ||
                (n.type === "class" && /^theme-(dark|light)$/.test(n.value)),
            );
          const conds: SNode[] = [];
          if (bodyish)
            conds.push(...first.nodes.filter((n) => n.type !== "tag"));
          for (const c of all.slice(bodyish ? 1 : 0, -1))
            for (const n of c.nodes)
              if (
                (n.type === "class" &&
                  !WRAPPER_CLASSES.has(n.value) &&
                  !/^mod-/.test(n.value)) ||
                (n.type === "pseudo" &&
                  /^:not$/i.test(n.value) &&
                  backdropLayer(c) < 0 &&
                  !classesOf(c).length)
              )
                conds.push(n);
          // Without the whitespace a node can carry (`\n.dtm08` after a comma
          // in Micro Mike), which would make it a descendant.
          const head = `body${conds
            .map((n) => {
              const c = n.clone() as SNode;
              c.spaces = { before: "", after: "" };
              return String(c);
            })
            .join("")}`;
          const own = specificity(selectorParser().astSync(head).first);
          const rest = spec.map((v, k) => Math.max(0, v - own[k]!)) as Spec;
          if (!byLayer.has(layer)) byLayer.set(layer, []);
          byLayer.get(layer)!.push([head, rest]);
        }
      }).processSync(rule.selector);
    } catch {
      return;
    }
    if (byLayer.size) copies.push([rule, byLayer, decls]);
  });
  const selector = (heads: [string, Spec][], ids = 0) =>
    [
      ...new Set(
        heads.map(
          ([head, [a, b, c]]) =>
            `${head}${pad([a + ids, b, c])
              .map(String)
              .join("")}`,
        ),
      ),
    ].join(", ");
  const painted = backgroundVars(root, [
    ...APP_BOX_BACKGROUNDS,
    ...copies.flatMap(([, , decls]) =>
      decls.filter((d) => BACKGROUND_PROP.test(d.prop)).map((d) => d.value),
    ),
  ]);
  const inside = (heads: [string, Spec][], el: string, ids: number) =>
    selector(
      heads.map(([head, spec]) => [`${head} ${el}`, spec]),
      ids,
    );
  for (const [rule, byLayer, decls] of copies)
    for (const [layer, heads] of byLayer) {
      const bg = postcss.rule({ selector: selector(heads) });
      for (const d of decls)
        if (BACKGROUND_PROP.test(d.prop))
          bg.append(...layerDecls(d, layer, split));
      if (bg.nodes.length) rule.before(bg);
      // Text styles set on a box inside the main split inherit into the note
      // as well (Prose's `.markdown-reading-view { letter-spacing }`), below
      // any rule for the note's own elements, as inherited values are.
      const text =
        layer <= MAIN_COLUMN_LAYER
          ? decls.filter((d) => BOX_INHERITED.test(d.prop))
          : [];
      const own = [...decls.filter((d) => d.prop.startsWith("--")), ...text];
      if (!own.length) continue;
      // Variables set on a box inherit into everything inside it: the note,
      // on the Quartz element that stands for the box (the main column for
      // the main split and its leaf, the page for the app around the
      // sidebars), so that body-level variables built on them don't see them
      // (`--checkbox-size: var(--font-text-size)` against Kiwi Mono's
      // reading-view font size). Inner boxes beat outer ones on the same
      // element, as inheritance would: a few ids, more the further in.
      const [el, top] =
        layer <= MAIN_COLUMN_LAYER
          ? [".center", MAIN_COLUMN_LAYER]
          : ["#quartz-root", BODY_LAYER - 1];
      const vars = postcss.rule({ selector: inside(heads, el, top - layer) });
      for (const d of own) vars.append(d.clone());
      rule.before(vars);
      // The boxes' backgrounds are painted on <body> (Fantasy's translucent
      // `--background-primary` on `.app-container`): the variables they use
      // go there too, above body-level definitions.
      const used = own.filter((d) => painted.has(d.prop));
      if (!used.length) continue;
      const onBody = postcss.rule({
        selector: selector(heads, BODY_LAYER - layer),
      });
      for (const d of used) onBody.append(d.clone());
      rule.before(onBody);
    }
}

/**
 * Inherited text properties a theme sets on the boxes around the note. Not
 * `font-size` (Obsidian sizes the note itself), nor anything Quartz's chrome
 * in the main column would shift with.
 */
const BOX_INHERITED =
  /^(color|font-family|font-weight|font-style|letter-spacing|word-spacing|line-height|font-feature-settings|font-variant(-[a-z]+)?|-webkit-font-smoothing|text-rendering)$/;

/** The main split (`.mod-root`) and the boxes inside it: Quartz's `.center`. */
const MAIN_COLUMN_LAYER = 6;

/** What Obsidian's app.css paints the boxes with (its own conversion is separate). */
const APP_BOX_BACKGROUNDS = [
  "var(--background-primary)",
  "var(--background-secondary)",
  "var(--titlebar-background)",
  "var(--titlebar-background-focused)",
  "var(--workspace-background-translucent)",
];

/** Variables the boxes' backgrounds use, directly or through other variables. */
function backgroundVars(root: Root, values: string[]): Set<string> {
  const refs = (v: string) =>
    [...v.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]!);
  const defs = new Map<string, string[]>();
  root.walkDecls((d) => {
    if (typeof d.value === "string" && d.prop.startsWith("--"))
      defs.set(d.prop, [...(defs.get(d.prop) ?? []), ...refs(d.value)]);
  });
  const used = new Set(values.flatMap(refs));
  const todo = [...used];
  while (todo.length)
    for (const r of defs.get(todo.pop()!) ?? [])
      if (!used.has(r)) {
        used.add(r);
        todo.push(r);
      }
  return used;
}

/**
 * `<body>`'s own backgrounds go to its slot, so the layers above it can paint
 * over them (backdrop.ts). After the main pass: by then every body rule's
 * subject is `body` (`.theme-dark` → `:where(body):is(…)`).
 */
function bodyBackgrounds(root: Root, split: ReadonlySet<string>): void {
  root.walkRules((rule) => {
    const parent = rule.parent as AtRule | undefined;
    if (parent?.type === "atrule" && /keyframes$/i.test(parent.name)) return;
    if (
      !rule.nodes?.some(
        (n) => n.type === "decl" && BACKGROUND_PROP.test(n.prop),
      )
    )
      return;
    const body: string[] = [];
    const other: string[] = [];
    try {
      selectorParser((selectors) => {
        selectors.each((sel) => {
          const all = splitCompounds(sel);
          const subject = all[all.length - 1]!;
          const isBody =
            !subject.nodes.some(
              (n) => n.type === "pseudo" && isPseudoElement(n),
            ) &&
            /(^|[^\w.#-])body(?![\w-])/.test(
              subject.nodes.map(String).join(""),
            );
          (isBody ? body : other).push(String(sel).trim());
        });
      }).processSync(rule.selector);
    } catch {
      return;
    }
    if (!body.length) return;
    const target = other.length
      ? rule.clone({ selector: body.join(", ") })
      : rule;
    if (other.length) {
      rule.selector = other.join(", ");
      rule.after(target);
    }
    target.each((n) => {
      if (n.type === "decl" && BACKGROUND_PROP.test(n.prop))
        n.replaceWith(...layerDecls(n, BODY_LAYER, split));
    });
  });
}

export function convertObsidianCss(
  css: string,
  opts: ConvertOptions = {},
): ConvertResult {
  const bodyState: Record<string, boolean | "mode"> = {
    ...BODY_STATE,
    ...(opts.bodyClasses ?? {}),
  };
  const quartzClasses = opts.quartzClasses ?? new Set<string>();
  const stats: ConvertStats = {
    rules: 0,
    keptVerbatim: 0,
    rewritten: 0,
    dropped: {
      appOnly: 0,
      staticFalse: 0,
      wrapperSubject: 0,
      unparseable: 0,
      leafType: 0,
    },
    selectors: { in: 0, out: 0 },
    layoutStripped: 0,
    iconsResolved: 0,
    repaired: false,
    warnings: [],
    quarantined: 0,
    unmatchedClasses: {},
  };

  const { root, repaired, warnings } = parseTolerant(css, opts.filename);
  stats.repaired = repaired;
  stats.warnings = warnings;
  if (repaired) {
    // safe-parser keeps unparseable leftovers (stray braces, …) in raws;
    // reserialize repaired sheets from the AST only.
    root.walk((n) => {
      n.raws = {};
    });
    root.raws = {};
  }

  root.walkComments((c) => {
    c.remove();
  });
  flattenNesting(root);

  const split = splitBackgroundVars(root);
  paneBackgrounds(root, split);
  propertiesInherit(root);
  universalWrappers(root);

  const wrapperMargins: WrapperMargins = { cancel: new Map(), decls: [] };
  root.walkRules((rule) => {
    const parent = rule.parent as AtRule | undefined;
    if (parent?.type === "atrule" && /keyframes$/i.test(parent.name)) return;
    stats.rules++;
    let changed = false;
    let dropReason: DropReason | null = null;
    let out: string;
    const structuralSels: string[] = [];
    const contentRootSels: string[] = [];
    const mappedRootSels: string[] = [];
    const blockWrapperSels: string[] = [];
    try {
      out = selectorParser((selectors) => {
        if (splitMixedIs(selectors, { bodyState })) changed = true;
        if (wrapperAncestors(selectors)) changed = true;
        selectors.each((sel) => {
          stats.selectors.in++;
          const res = processSelector(sel, { bodyState }, true);
          if (res.drop) {
            dropReason ??= res.drop;
            sel.remove();
            changed = true;
          } else {
            if (res.changed) changed = true;
            if (res.structural) structuralSels.push(sel.toString().trim());
            if (res.contentRoot) contentRootSels.push(sel.toString().trim());
            if (res.mappedRoot) mappedRootSels.push(sel.toString().trim());
            if (res.blockWrapper) blockWrapperSels.push(sel.toString().trim());
          }
        });
      }).processSync(rule.selector, { lossless: false });
    } catch {
      stats.dropped.unparseable++;
      rule.remove();
      return;
    }
    if (!out.trim()) {
      stats.dropped[dropReason ?? "staticFalse"]++;
      rule.remove();
      return;
    }
    if (changed) {
      stats.rewritten++;
      rule.selector = out;
    } else {
      stats.keptVerbatim++;
    }
    const guards: [string[], (d: Declaration) => boolean][] = [
      [structuralSels, (d) => LAYOUT_PROPS.test(d.prop) || isSizeContainer(d)],
      [contentRootSels, isContentRootLayout],
      [mappedRootSels, isMappedRootLayout],
      [blockWrapperSels, isWrapperBox],
    ];
    let parts = [rule];
    for (const [sels, props] of guards)
      if (sels.length)
        parts = parts.flatMap((r) => {
          const res = guardLayout(r, sels, props);
          stats.layoutStripped += res.stripped;
          return res.rules;
        });
    if (blockWrapperSels.length)
      parts = parts.flatMap((r) =>
        wrapperPaint(r, blockWrapperSels, wrapperMargins),
      );
    for (const m of out.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
      const c = m[1]!;
      if (c.startsWith("qt-") || quartzClasses.has(c)) continue;
      stats.unmatchedClasses[c] = (stats.unmatchedClasses[c] ?? 0) + 1;
    }
    stats.selectors.out += out.split(",").length;
  });

  cancelWrapperMargins(wrapperMargins);
  wrappedInlineBlocks(root);
  bodyBackgrounds(root, split);

  if (opts.resolveIcon) {
    root.walkDecls(ICON_PROPS, (decl) => {
      const name = decl.value.trim().replace(/^["']|["']$/g, "");
      if (!/^[a-z0-9-]+$/i.test(name)) return; // already a url(…), var(…), etc.
      const uri = opts.resolveIcon!(name);
      if (uri) {
        decl.value = uri;
        stats.iconsResolved++;
      }
    });
  }

  // Drop empty containers left behind.
  let removed: boolean;
  do {
    removed = false;
    root.walk((node) => {
      if (
        (node.type === "atrule" || node.type === "rule") &&
        node.nodes &&
        node.nodes.length === 0
      ) {
        node.remove();
        removed = true;
      }
    });
  } while (removed);

  // @import / @charset must stay first.
  const hoist: ChildNode[] = [];
  root.walkAtRules(/^(import|charset)$/i, (at) => {
    if (at.parent === root) hoist.push(at.remove());
  });
  root.prepend(...hoist);

  const quarantine = quarantineInvalid(root);
  stats.quarantined = quarantine.count;
  return { css: root.toString(), quarantine: quarantine.css, stats };
}

/**
 * Properties that control page layout. Quartz owns the layout of its
 * structural elements (html, body, sidebars, header, footer); a theme only
 * gets to style them. (Opacity too: themes fade Obsidian's side panels until
 * hovered, but Quartz's left sidebar is the header on phones.) And anything
 * that makes an element the containing block of its fixed-position descendants
 * (`transform`, `filter`, `will-change: transform`, …): Quartz's phone explorer
 * is a fixed overlay inside the explorer.
 */
const LAYOUT_PROPS =
  /^(position|display|float|clear|contain|content-visibility|overflow(-[xy])?|overscroll-behavior.*|(min-|max-)?(width|height)|(min-|max-)?(inline|block)-size|inset.*|top|right|bottom|left|flex.*|grid.*|order|align-self|justify-self|place-self|transform|transform-style|translate|scale|rotate|zoom|perspective|filter|backdrop-filter|-webkit-backdrop-filter|will-change|visibility|opacity|user-select|-webkit-user-select|pointer-events|z-index)$/;

/**
 * A size container ignores its content's height (`container-type: size`, or the
 * `container: name / size` shorthand). Obsidian's panes have fixed sizes, so
 * themes use it freely (Oboro's scroll effects on the file list); Quartz sizes
 * its sidebar elements by their content, which would collapse to nothing.
 */
const isSizeContainer = (d: Declaration) =>
  /^container(-type)?$/i.test(d.prop) && /(^|[\s/])size\b/i.test(d.value);

/**
 * Quartz's content root is laid out by Quartz: the page provides the gutters
 * (Obsidian's file margins, or a theme's own padding or margins on the reading
 * view, would double them) and the page scrolls (in Obsidian the reading view
 * is its own scroll container, whose `scrollbar-gutter: stable` would reserve
 * a themed scrollbar's width).
 */
const CONTENT_ROOT_PROPS =
  /^(padding(-(top|right|bottom|left|inline|block)(-(start|end))?)?|overflow(-[xy])?|scrollbar-gutter)$/;
/**
 * Obsidian's per-block wrapper divs never scroll, but in Quartz some top-level
 * blocks do: `.table-container` scrolls wide tables (Material Ocean's
 * `overflow: visible` on the wrappers would spill them off a phone).
 */
const OVERFLOW_PROPS = /^overflow(-[xy])?$/;
const MARGIN_PROPS =
  /^margin(-(top|right|bottom|left|inline|block)(-(start|end))?)?$/;

/**
 * The box of Obsidian's per-block wrapper div, on the block itself in Quartz
 * (`.markdown-preview-section > div`, `.el-hr`): its padding moves the block
 * in, which on the block is margin (Discordian's `padding-left: 4rem` padded
 * the inside of callouts and code blocks), also vertically, the space themes
 * put between blocks with it (Hidontknow's `[class^="el-"] ~ [class^="el-"]
 * { padding-top }`): exact over the zero block margins such themes use, the
 * larger of the two rather than their sum otherwise. Its zero or `auto`
 * margins (`margin: 0 auto`) would replace the block's own, which in Obsidian
 * collapse through the wrapper: left out.
 */
const WRAPPER_PADDING =
  /^padding(-(top|right|bottom|left|inline|block)(-(start|end))?)?$/;
/**
 * Zero margins between neighbouring wrappers stay: they take back the space
 * the theme's wrapper margins add (Adrenaline's `div.el-h1 + div.el-h2 {
 * margin-top: 0em }` against `div.el-h2 { margin-top: 4em }`).
 */
const isSiblingRule = (d: Declaration) =>
  /[+~]/.test((d.parent as Rule | undefined)?.selector ?? "");
const isZeroSiblingMargin = (d: Declaration) =>
  isSiblingRule(d) && /^0([a-z%]*)?$/i.test(d.value.trim());
/**
 * In Obsidian such a zero margin only takes the wrapper's away: the block's
 * own still collapses through it (Brainhack's headings, its 20px apart;
 * Adrenaline's, inline, none). On the block itself it would replace the
 * block's own, so instead the wrapper margins it cancels leave those blocks
 * out.
 */
interface WrapperMargins {
  cancel: Map<string, string[]>;
  decls: Declaration[];
}
function cancelWrapperMargins({ cancel, decls }: WrapperMargins): void {
  for (const d of decls) {
    const sels = cancel.get(d.prop);
    const rule = d.parent as Rule | undefined;
    if (!sels?.length || !rule || rule.type !== "rule") continue;
    const not = `:where(:not(${sels.join(", ")}))`;
    const selector = selectorParser()
      .astSync(rule.selector)
      .nodes.map((s) => {
        const str = s.toString().trim();
        return str.includes("::") ? str : `${str}${not}`;
      })
      .join(", ");
    if (rule.nodes.every((n) => n === d || n.type === "comment"))
      rule.selector = selector;
    else {
      rule.after(postcss.rule({ selector, nodes: [d.clone()] }));
      d.remove();
    }
  }
}
const isWrapperBox = (d: Declaration) =>
  OVERFLOW_PROPS.test(d.prop) ||
  WRAPPER_PADDING.test(d.prop) ||
  (MARGIN_PROPS.test(d.prop) && !isOffsetMargin(d) && !isSiblingRule(d));
function wrapperAsBlock(d: Declaration): Declaration[] {
  if (!WRAPPER_PADDING.test(d.prop)) return [];
  const side = (prop: string, value: string) =>
    /^0([a-z%]*)?$/i.test(value.trim()) ? [] : [d.clone({ prop, value })];
  const which = d.prop.match(/^padding(?:-(.*))?$/)![1];
  if (which !== undefined && which !== "inline" && which !== "block")
    return side(`margin-${which}`, d.value);
  const parts = d.value.trim().split(/\s+/);
  // One value (`padding: var(--gap)`) is every side; several with functions
  // in them can't be told apart by whitespace.
  if (parts.length > 1 && parts.some((x) => x.includes("("))) return [];
  if (which === "inline" || which === "block")
    return [
      ...side(`margin-${which}-start`, parts[0]!),
      ...side(`margin-${which}-end`, parts[1] ?? parts[0]!),
    ];
  // padding: top right bottom left
  const [top, right = top!, bottom = top!, left = right] = parts;
  return [
    ...side("margin-top", top!),
    ...side("margin-right", right),
    ...side("margin-bottom", bottom),
    ...side("margin-left", left),
  ];
}
/**
 * Its background, and the corners that round it, are behind the block
 * (Office Mock paints the page on the wrappers, `border-radius: 0`): the
 * block's own, the theme's and Obsidian's callout and code backgrounds and
 * corners, stay on top. Without specificity, and not on the blocks Obsidian
 * itself paints.
 */
const WRAPPER_PAINT = (d: Declaration) =>
  BACKGROUND_PROP.test(d.prop) ||
  d.prop === "box-shadow" ||
  /^border(-[a-z]+)*-radius$/.test(d.prop);
const OWN_PAINT =
  ":where(:not(.callout, pre, [data-rehype-pretty-code-figure]))";
function wrapperPaint(
  rule: Rule,
  guarded: string[],
  margins: WrapperMargins,
): Rule[] {
  // Its `em`s are the note's text size, not the block's (a heading's).
  const sels = selectorParser()
    .astSync(rule.selector)
    .nodes.map((s) => s.toString().trim());
  if (sels.every((s) => guarded.includes(s)))
    for (const d of [...rule.nodes])
      if (d.type === "decl" && MARGIN_PROPS.test(d.prop)) {
        if (isZeroSiblingMargin(d)) {
          const own = sels.filter((s) => !s.includes("::"));
          margins.cancel.set(d.prop, [
            ...(margins.cancel.get(d.prop) ?? []),
            ...own,
          ]);
          d.remove();
          continue;
        }
        d.value = d.value.replace(
          /(^|[\s(,])(-?\d*\.?\d+)em\b/g,
          "$1calc($2 * var(--font-text-size))",
        );
        margins.decls.push(d);
      }
  const decls = rule.nodes.filter(
    (d): d is Declaration => d.type === "decl" && WRAPPER_PAINT(d),
  );
  if (!decls.length) return [rule];
  const hit = selectorParser()
    .astSync(rule.selector)
    .nodes.map((s) => s.toString().trim())
    .filter((s) => guarded.includes(s) && !s.includes("::"));
  if (!hit.length) return [rule];
  const paint = rule.cloneBefore({
    selector: hit.map((s) => `:where(${s})${OWN_PAINT}`).join(", "),
    nodes: [],
  });
  for (const d of decls) paint.append(d.clone());
  const rest = selectorParser()
    .astSync(rule.selector)
    .nodes.map((s) => s.toString().trim())
    .filter((s) => !hit.includes(s));
  const rules: Rule[] = [paint];
  if (rest.length) {
    rules.push(rule.cloneBefore({ selector: rest.join(", ") }));
    rule.selector = hit.join(", ");
  }
  for (const d of decls) d.remove();
  if (!rule.nodes.some((n) => n.type !== "comment")) rule.remove();
  else rules.push(rule);
  return rules;
}
/**
 * The wrapper's side padding is inside its width (Discordian's `width:
 * var(--readable-line-length)` with `padding-left: 4rem`); as the block's
 * margins it would push a block of that width past the column: the block is
 * kept within what the padding leaves.
 */
function capWrapperPadding(rule: Rule, decls: Declaration[]) {
  const sides: string[] = [];
  for (const d of decls) {
    if (!WRAPPER_PADDING.test(d.prop)) continue;
    const which = d.prop.match(/^padding(?:-(.*))?$/)![1];
    const parts = d.value.trim().split(/\s+/);
    if (which === "left" || which === "right") sides.push(d.value.trim());
    else if (which === "inline") sides.push(parts[0]!, parts[1] ?? parts[0]!);
    else if (which === undefined) {
      if (parts.length > 1 && parts.some((x) => x.includes("("))) return;
      const right = parts[1] ?? parts[0]!;
      sides.push(right, parts[3] ?? right);
    }
  }
  const used = sides.filter((v) => !/^0([a-z%]*)?$/i.test(v));
  if (!used.length) return;
  const cap = `calc(100% - ${used.join(" - ")})`;
  const own = rule.nodes.filter(
    (n): n is Declaration =>
      n.type === "decl" && /^(max-width|max-inline-size)$/.test(n.prop),
  );
  const last = own.at(-1);
  if (!last) rule.append({ prop: "max-width", value: cap });
  else
    last.value = /^[a-z-]+$/i.test(last.value.trim())
      ? cap
      : `min(${last.value.trim()}, ${cap})`;
}
const WRAPPER_AS_BLOCK = new Map<(d: Declaration) => boolean, boolean>([
  [isWrapperBox, true],
]);

/**
 * A margin that offsets the content root. `auto` and 0 are kept: with a
 * max-width they centre the note in Quartz's column (Minimal, Dedication);
 * lengths push it out of the column (`width: 100%` plus `margin: 0 30px`).
 */
const isOffsetMargin = (d: Declaration) =>
  MARGIN_PROPS.test(d.prop) &&
  d.value
    .trim()
    .split(/\s+/)
    .some(
      (v) =>
        !/^(auto|0([a-z%]*)?|initial|unset|inherit|revert(-layer)?)$/i.test(v),
    );

/**
 * The root's box is Quartz's column: a theme's `display: flex` on the sizer
 * would lay the note's blocks out in a row (SpectrumPlus), and a `min-width`
 * pushes it past a phone's screen (evangelion's `min-width: 80ch`).
 */
const ROOT_BOX_PROPS = /^(display|min-width|min-inline-size)$/;
/**
 * Taking the root out of the flow: in Obsidian the sizer is absolute inside
 * the relatively positioned reading view, in Quartz it is that view, and
 * would size and place itself against the page (Elysian's `position:
 * absolute; width: 100%` covered the right sidebar and ran off the screen).
 */
const isRootPosition = (d: Declaration) =>
  d.prop === "position" && /^(absolute|fixed)\b/i.test(d.value.trim());
/**
 * A column flexbox still stacks the blocks, but their margins no longer
 * collapse (DarkEmber's sizer: twice the space between headings): kept.
 */
const isColumnFlex = (d: Declaration) =>
  d.prop === "display" &&
  /^(inline-)?flex\b/i.test(d.value.trim()) &&
  (d.parent?.nodes ?? []).some(
    (n) =>
      n.type === "decl" &&
      ((n.prop === "flex-direction" && /^column\b/i.test(n.value.trim())) ||
        (n.prop === "flex-flow" && /\bcolumn\b/i.test(n.value))),
  );
const isMappedRootLayout = (d: Declaration) =>
  (ROOT_BOX_PROPS.test(d.prop) && !isColumnFlex(d)) ||
  isOffsetMargin(d) ||
  isRootPosition(d);
const isContentRootLayout = (d: Declaration) =>
  CONTENT_ROOT_PROPS.test(d.prop) || isMappedRootLayout(d);

/**
 * Strip the `props` declarations that apply to the selectors in `guarded`.
 * Rules whose selector list mixes guarded and other selectors are split so
 * only the guarded part is affected. Returns the number of stripped decls and
 * the rules left in the stylesheet.
 */
function guardLayout(
  rule: Rule,
  guarded: string[],
  strip: (d: Declaration) => boolean,
): { stripped: number; rules: Rule[] } {
  const decls = rule.nodes.filter(
    (d): d is Declaration => d.type === "decl" && strip(d),
  );
  if (!decls.length) return { stripped: 0, rules: [rule] };
  const all = selectorParser()
    .astSync(rule.selector)
    .nodes.map((s) => s.toString().trim());
  const hit = all.filter((s) => guarded.includes(s));
  if (!hit.length) return { stripped: 0, rules: [rule] };
  const rules: Rule[] = [];
  const rest = all.filter((s) => !guarded.includes(s));
  if (rest.length) {
    rules.push(rule.cloneBefore({ selector: rest.join(", ") }));
    rule.selector = hit.join(", ");
  }
  const asBlock = WRAPPER_AS_BLOCK.get(strip);
  if (asBlock) capWrapperPadding(rule, decls);
  for (const d of decls) {
    for (const r of asBlock ? wrapperAsBlock(d) : []) d.before(r);
    d.remove();
  }
  if (!rule.nodes.some((n) => n.type !== "comment")) rule.remove();
  else rules.push(rule);
  return { stripped: decls.length, rules };
}

/** The targets Quartz minifies plugin CSS with (quartz/plugins/emitters/componentResources.ts). */
export const QUARTZ_TARGETS = {
  safari: (15 << 16) | (6 << 8),
  ios_saf: (15 << 16) | (6 << 8),
  edge: 115 << 16,
  firefox: 102 << 16,
  chrome: 109 << 16,
};

/** Exactly how Quartz minifies plugin CSS (componentResources.ts): same targets and features. */
function lightningAccepts(css: string): boolean {
  try {
    transform({
      filename: "x.css",
      code: Buffer.from(css),
      minify: true,
      targets: QUARTZ_TARGETS,
      include: Features.MediaQueries,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Move rules LightningCSS rejects into a separate stylesheet, unchanged.
 * Quartz minifies each inline CSS resource independently and passes through
 * any it can't parse, so the main sheet stays minifiable while the browser
 * still applies its own error recovery to the quarantined rules. Nested
 * at-rules are split so only the failing rule moves, wrapped in a clone of
 * its at-rule chain.
 */
function quarantineInvalid(root: Root): { css: string; count: number } {
  if (lightningAccepts(root.toString())) return { css: "", count: 0 };
  const out = postcss.root();
  let count = 0;
  const visit = (container: Container) => {
    for (const node of [...(container.nodes ?? [])]) {
      if (node.type === "comment") continue;
      if (node.type === "decl") {
        // A declaration outside any style rule: browsers ignore it.
        if (!node.parent || node.parent.type !== "rule") node.remove();
        continue;
      }
      if (lightningAccepts(wrapInParents(node).toString())) continue;
      const recurse =
        node.type === "atrule" &&
        /^(media|supports|layer|container|document)$/i.test(node.name) &&
        (node.nodes?.length ?? 0) > 0;
      if (recurse) {
        visit(node as AtRule);
        if ((node as AtRule).nodes?.length === 0) node.remove();
      } else {
        out.append(wrapInParents(node));
        node.remove();
        count++;
      }
    }
  };
  visit(root);
  return { css: out.toString(), count };
}

/** Clone `node` inside clones of its at-rule ancestors (without siblings). */
function wrapInParents(node: ChildNode): ChildNode {
  let wrapped: ChildNode = node.clone();
  for (
    let p = node.parent as Container | undefined;
    p && p.type !== "root";
    p = p.parent as Container | undefined
  ) {
    const shell = (p as AtRule | Rule).clone({ nodes: [] });
    shell.append(wrapped);
    wrapped = shell;
  }
  return wrapped;
}

interface Ctx {
  bodyState: Record<string, boolean | "mode">;
}

interface SelectorResult {
  drop?: DropReason;
  changed?: boolean;
  structural?: boolean;
  /** The subject is Obsidian's reading view itself (`.markdown-preview-view`), i.e. Quartz's content root. */
  contentRoot?: boolean;
  /** As `contentRoot`, also for selectors nested in :is()/:where(). */
  subjectIsRoot?: boolean;
  /** The subject is a content wrapper mapped onto the root (`.markdown-preview-sizer`). */
  mappedRoot?: boolean;
  /** The subject is Obsidian's per-block wrapper div, i.e. a top-level block in Quartz. */
  blockWrapper?: boolean;
  /** Nothing but elided wrappers: "any element", in an ancestor's `:is()`. */
  elidedOnly?: boolean;
}

interface Compound {
  nodes: SNode[];
  /** The combinator before this compound (undefined for the first). */
  before?: selectorParser.Combinator;
}

function splitCompounds(sel: SSelector): Compound[] {
  const out: Compound[] = [{ nodes: [] }];
  for (const node of [...sel.nodes]) {
    if (node.type === "combinator") out.push({ nodes: [], before: node });
    else out[out.length - 1]!.nodes.push(node);
  }
  return out;
}

const isChild = (c?: selectorParser.Combinator) => c?.value.trim() === ">";
const isDescendantOrChild = (c?: selectorParser.Combinator) =>
  c !== undefined && (c.value.trim() === "" || c.value.trim() === ">");

const classesOf = (c: Compound) =>
  c.nodes.flatMap((n) => (n.type === "class" ? [n.value] : []));
/** `.nav-folder.mod-root`, or a bare `.mod-root` whose child is a tree part. */
const isTreeRoot = (c: Compound, next?: Compound) => {
  const classes = classesOf(c);
  if (!classes.includes("mod-root")) return false;
  if (classes.some((v) => TREE_ITEM_CLASSES.includes(v))) return true;
  return (
    classes.length === 1 &&
    !!next &&
    isChild(next.before) &&
    classesOf(next).some((v) => TREE_PART_CLASSES.includes(v))
  );
};

/**
 * Obsidian's explorer → Quartz's (see FILES_CONTAINER): rules for the pre-1.0
 * vault-root folder are dropped; `.nav-files-container > div > .nav-folder` →
 * `.nav-files-container:not(qt-0) > .nav-folder` (same specificity).
 * Returns whether the selector changed, or "drop".
 */
function rewriteExplorer(sel: SSelector): boolean | "drop" {
  let changed = false;
  const all = splitCompounds(sel);
  for (let i = 0; i < all.length; i++)
    if (isTreeRoot(all[i]!, all[i + 1])) return "drop";
  for (let i = all.length - 3; i >= 0; i--) {
    const wrapper = all[i + 1]!;
    if (
      classesOf(all[i]!).includes(FILES_CONTAINER) &&
      isChild(wrapper.before) &&
      isChild(all[i + 2]!.before) &&
      wrapper.nodes.length === 1 &&
      wrapper.nodes[0]!.type === "tag" &&
      wrapper.nodes[0]!.value.toLowerCase() === "div"
    ) {
      const last = all[i]!.nodes[all[i]!.nodes.length - 1]!;
      wrapper.before!.remove();
      wrapper.nodes[0]!.remove();
      for (const p of pad([0, 0, 1])) last.parent!.insertAfter(last, p);
      changed = true;
    }
  }
  return changed;
}

/**
 * Obsidian wraps each top-level block in a div named after it (`div.el-p > p`,
 * `div.el-table > table`); Quartz doesn't. Themes use the wrapper names to
 * mean "the block": `.el-table + div > h2` is "a heading after a table". Each
 * maps to the element Quartz renders for that block, the wrapper's own
 * selector replaced at the same specificity.
 */
const BLOCK_WRAPPERS: Record<string, { block: string; natural: string[] }> = {
  "el-p": { block: "p", natural: ["p"] },
  "el-ul": { block: "ul", natural: ["ul"] },
  "el-ol": { block: "ol", natural: ["ol"] },
  "el-blockquote": { block: "blockquote", natural: ["blockquote"] },
  "el-hr": { block: "hr", natural: ["hr"] },
  "el-h1": { block: "h1", natural: ["h1"] },
  "el-h2": { block: "h2", natural: ["h2"] },
  "el-h3": { block: "h3", natural: ["h3"] },
  "el-h4": { block: "h4", natural: ["h4"] },
  "el-h5": { block: "h5", natural: ["h5"] },
  "el-h6": { block: "h6", natural: ["h6"] },
  // Quartz wraps tables in .table-container and highlighted code in a <figure>.
  "el-table": { block: ".table-container", natural: ["table"] },
  "el-pre": {
    // No `figure` type selector: theme figure rules are kept off this figure.
    block:
      "[data-rehype-pretty-code-figure], :not([data-rehype-pretty-code-figure]) > pre",
    natural: ["pre"],
  },
  // Callouts and raw HTML blocks.
  "el-div": { block: "div", natural: ["div"] },
};

/** The wrapper names in a compound: `div.el-p`, or `div:is(.el-p, .el-table)`. */
function wrapperNames(c: Compound): { names: string[]; nodes: SNode[] } | null {
  const names: string[] = [];
  const nodes: SNode[] = [];
  for (const n of c.nodes) {
    if (n.type === "class" && BLOCK_WRAPPERS[n.value]) {
      names.push(n.value);
      nodes.push(n);
    } else if (
      n.type === "attribute" &&
      n.attribute === "class" &&
      (n.operator === "^=" || n.operator === "*=") &&
      /^el-/.test(n.value ?? "")
    ) {
      // `[class^="el-"]` (Hidontknow): the wrappers whose class it matches.
      const v = n.value!;
      const matched = Object.keys(BLOCK_WRAPPERS).filter((k) =>
        n.operator === "^=" ? k.startsWith(v) : k.includes(v),
      );
      if (!matched.length) continue;
      names.push(...matched);
      nodes.push(n);
    } else if (n.type === "tag" && n.value.toLowerCase() === "div")
      nodes.push(n);
    else if (
      n.type === "pseudo" &&
      (n.value === ":is" || n.value === ":where" || n.value === ":matches") &&
      (n as selectorParser.Pseudo).nodes.length &&
      (n as selectorParser.Pseudo).nodes.every(
        (alt) =>
          alt.nodes.length === 1 &&
          alt.nodes[0]!.type === "class" &&
          !!BLOCK_WRAPPERS[alt.nodes[0]!.value],
      )
    ) {
      for (const alt of (n as selectorParser.Pseudo).nodes)
        names.push(String(alt.nodes[0]!.value));
      nodes.push(n);
    }
  }
  return names.length ? { names, nodes } : null;
}

/** Selectors whose subject was a block wrapper (`.el-h2`), now the block. */
const WRAPPER_SUBJECTS = new WeakSet<SSelector>();

const bareDiv = (c: Compound) =>
  c.nodes.length > 0 &&
  c.nodes.every(
    (n) =>
      (n.type === "tag" && n.value.toLowerCase() === "div") ||
      (n.type === "pseudo" && !isPseudoElement(n) && n.value !== ":is"),
  ) &&
  c.nodes.some((n) => n.type === "tag");

function rewriteBlockWrappers(sel: SSelector): boolean {
  let changed = false;
  // Right to left, so removing compound i+1 keeps earlier indices valid.
  for (let i = splitCompounds(sel).length - 1; i >= 0; i--) {
    const all = splitCompounds(sel);
    const c = all[i]!;
    const found = wrapperNames(c);
    if (!found) continue;
    // `div > .el-ul`: the div is the sizer, Quartz's note root, which the
    // block already sits in (Baseline's `.markdown-rendered div > .el-ul > ul`).
    const prev = all[i - 1];
    if (
      prev &&
      isChild(c.before) &&
      prev.nodes.length === 1 &&
      prev.nodes[0]!.type === "tag" &&
      prev.nodes[0]!.value.toLowerCase() === "div"
    ) {
      prev.nodes[0]!.remove();
      c.before!.remove();
      const last = c.nodes[c.nodes.length - 1]!;
      const kept = pad([0, 0, 1]);
      for (const q of kept.reverse()) last.parent!.insertAfter(last, q);
      c.nodes.push(...kept.reverse());
      changed = true;
    }
    const next = all[i + 1];
    const spec = specificity({ nodes: found.nodes } as unknown as SSelector);
    const others = c.nodes.filter((n) => !found.nodes.includes(n));
    const naturals = found.names.flatMap((n) => BLOCK_WRAPPERS[n]!.natural);
    const nextTag = next?.nodes
      .find((n) => n.type === "tag")
      ?.value.toLowerCase();
    if (
      next &&
      (isChild(next.before) ||
        (isDescendantOrChild(next.before) && found.names[0] !== "el-div")) &&
      found.names.length === 1 &&
      nextTag &&
      naturals.includes(nextTag)
    ) {
      // `div.el-p > p` → `p`: the wrapper's specificity and pseudos move onto
      // it. Also `.el-hr hr` (Willemstad): the block is the wrapper's child.
      const target = next.nodes[next.nodes.length - 1]!;
      const anchor = next.nodes.find(isPseudoElement);
      for (const n of [...pad(spec), ...others]) {
        n.remove();
        if (anchor) anchor.parent!.insertBefore(anchor, n);
        else target.parent!.insertAfter(target, n);
      }
      // Only the note's own block, as only those have a wrapper (not the
      // footnotes' hr, a callout's p).
      if (BLOCK_WRAPPERS[found.names[0]!]!.block === nextTag)
        for (const q of nodesOf(":where(.markdown-preview-view > *)"))
          if (anchor) anchor.parent!.insertBefore(anchor, q);
          else target.parent!.insertAfter(target, q);
      for (const n of found.nodes) n.remove();
      next.before!.remove();
      changed = true;
      continue;
    }
    if (
      next &&
      isChild(next.before) &&
      !nextTag &&
      next.nodes.some((n) => !isPseudoElement(n))
    ) {
      // `.el-ul > *`, `div:is(.el-ul, .el-ol) > *` (Baseline): the wrapper's
      // child is its block, not the block's children.
      const what = nodesOf(`:where(${[...new Set(naturals)].join(", ")})`)[0]!;
      const star = next.nodes.find((n) => n.type === "universal");
      if (star) star.replaceWith(what);
      else next.nodes[0]!.parent!.insertBefore(next.nodes[0]!, what);
      const now = star
        ? next.nodes.map((n) => (n === star ? what : n))
        : [what, ...next.nodes];
      const anchor = now.find(isPseudoElement);
      const target = now.filter((n) => !isPseudoElement(n)).pop()!;
      const moved = [...pad(spec), ...others];
      if (
        found.names.every(
          (n) => BLOCK_WRAPPERS[n]!.block === BLOCK_WRAPPERS[n]!.natural[0],
        )
      )
        moved.push(...nodesOf(":where(.markdown-preview-view > *)"));
      for (const n of moved.reverse()) {
        n.remove();
        if (anchor) anchor.parent!.insertBefore(anchor, n);
        else target.parent!.insertAfter(target, n);
      }
      for (const n of found.nodes) n.remove();
      next.before!.remove();
      changed = true;
      continue;
    }
    // Anywhere else, the wrapper is the block itself.
    if (i === all.length - 1) WRAPPER_SUBJECTS.add(sel);
    const blocks = [
      ...new Set(found.names.map((n) => BLOCK_WRAPPERS[n]!.block)),
    ];
    const first = found.nodes[0]!;
    for (const q of [...nodesOf(`:where(${blocks.join(", ")})`), ...pad(spec)])
      first.parent!.insertBefore(first, q);
    for (const n of found.nodes) n.remove();
    // `.el-table + div > h2`: the sibling's own wrapper goes too.
    const sib = all[i + 1];
    const after = all[i + 2];
    if (
      sib &&
      /^[~+]$/.test(sib.before?.value.trim() ?? "") &&
      bareDiv(sib) &&
      after &&
      isChild(after.before)
    ) {
      const target = after.nodes[after.nodes.length - 1]!;
      const sibSpec = specificity({
        nodes: sib.nodes.filter((n) => n.type === "tag"),
      } as unknown as SSelector);
      const moved = [
        ...pad(sibSpec),
        ...sib.nodes.filter((n) => n.type !== "tag"),
      ];
      for (const n of moved) {
        n.remove();
        target.parent!.insertAfter(target, n);
      }
      for (const n of [...sib.nodes]) n.remove();
      after.before!.remove();
    }
    changed = true;
  }
  return changed;
}

/**
 * `.markdown-preview-pusher` is an empty element Obsidian puts before a note's
 * first block, so `.markdown-preview-pusher + div` is the first block. Quartz
 * has no pusher: `pusher + X` → `X:first-child` (a pseudo-class for a class, same
 * specificity), `pusher ~ X` → `X`, padded. As a plain wrapper it would match
 * any element and turn "the first block" into "every block after another".
 */
function rewritePusher(sel: SSelector): boolean {
  let changed = false;
  const all = splitCompounds(sel);
  for (let i = all.length - 2; i >= 0; i--) {
    const pusher = all[i]!;
    const next = all[i + 1]!;
    const comb = next.before?.value.trim();
    if (comb !== "+" && comb !== "~") continue;
    if (!classesOf(pusher).includes("markdown-preview-pusher")) continue;
    // Only a bare pusher compound (`.markdown-preview-pusher`, `div.…`).
    if (
      !pusher.nodes.every(
        (n) =>
          (n.type === "class" && n.value === "markdown-preview-pusher") ||
          (n.type === "tag" && n.value.toLowerCase() === "div"),
      )
    )
      continue;
    const spec = specificity(pusher as unknown as SSelector);
    for (const n of pusher.nodes) n.remove();
    next.before!.remove();
    const add =
      comb === "+"
        ? [...nodesOf(":first-child"), ...pad([spec[0], spec[1] - 1, spec[2]])]
        : pad(spec);
    const anchor = next.nodes.find(isPseudoElement) ?? undefined;
    const last = next.nodes[next.nodes.length - 1]!;
    for (const q of add.reverse()) {
      if (anchor) anchor.parent!.insertBefore(anchor, q);
      else last.parent!.insertAfter(last, q);
    }
    changed = true;
  }
  return changed;
}

/** The reading view and its wrappers, which hold Obsidian's properties block. */
const READING_VIEW_CLASSES = new Set([
  "markdown-preview-view",
  "markdown-rendered",
  "markdown-reading-view",
  "markdown-preview-sizer",
  "markdown-preview-section",
]);

/**
 * Obsidian renders a note's properties inside the reading view; Quartz's
 * properties block (note-properties) sits above the note, outside it. So
 * `.markdown-preview-view .metadata-container` → `:not(.qt-0) .metadata-container`:
 * the ancestor matches anything, with the same specificity.
 */
function rewriteProperties(sel: SSelector): boolean {
  const all = splitCompounds(sel);
  const subject = all.findIndex((c) =>
    classesOf(c).some((n) => n.startsWith("metadata-")),
  );
  if (subject <= 0) return false;
  let changed = false;
  for (const c of all.slice(0, subject)) {
    for (const n of [...c.nodes]) {
      if (n.type !== "class" || !READING_VIEW_CLASSES.has(n.value)) continue;
      n.replaceWith(...pad([0, 1, 0]));
      changed = true;
    }
  }
  return changed;
}

/**
 * `:is(.nav-files-container, .search-result-container) { container-type: size }`:
 * when only some alternatives of a whole-selector `:is()` are Quartz's own
 * layout elements, the layout guard can't strip their layout without stripping
 * everyone's. Split it into `:is(A), :is(B)` (each keeping its own
 * specificity), so each alternative is guarded on its own.
 */
/** Selectors Level 4 specificity of a complex selector. */
export function specificity(sel: SSelector | SNode): Spec {
  const spec: Spec = [0, 0, 0];
  const add = (s: Spec) => {
    spec[0] += s[0];
    spec[1] += s[1];
    spec[2] += s[2];
  };
  const max = (list: SNode[]): Spec =>
    list
      .map((s) => specificity(s))
      .reduce(
        (a, b) =>
          a[0] !== b[0]
            ? a[0] > b[0]
              ? a
              : b
            : a[1] !== b[1]
              ? a[1] > b[1]
                ? a
                : b
              : a[2] >= b[2]
                ? a
                : b,
        [0, 0, 0] as Spec,
      );
  for (const n of (sel as selectorParser.Container).nodes ?? []) {
    if (n.type === "id") add([1, 0, 0]);
    else if (n.type === "class" || n.type === "attribute") add([0, 1, 0]);
    else if (n.type === "tag") add([0, 0, 1]);
    else if (n.type === "pseudo") {
      if (isPseudoElement(n)) add([0, 0, 1]);
      else if (n.value === ":where") continue;
      else if ([":is", ":not", ":has", ":matches"].includes(n.value))
        add(max(n.nodes as SNode[]));
      else add([0, 1, 0]);
    }
  }
  return spec;
}

/**
 * Does Obsidian's block wrapper div (`div.el-h2`) match this compound? Only
 * judged for `div`, `*` and `:not()` of other tags (`:not(:is(li, ul, ol))`).
 */
function matchesWrapperDiv(c: Compound): boolean {
  const otherTags = (sel: SSelector): boolean =>
    sel.nodes.length === 1 &&
    ((sel.nodes[0]!.type === "tag" &&
      sel.nodes[0]!.value.toLowerCase() !== "div") ||
      (sel.nodes[0]!.type === "pseudo" &&
        /^:(is|where)$/i.test(sel.nodes[0]!.value) &&
        (sel.nodes[0] as selectorParser.Pseudo).nodes.every(otherTags)));
  return (
    c.nodes.length > 0 &&
    c.nodes.every(
      (n) =>
        (n.type === "tag" && n.value.toLowerCase() === "div") ||
        n.type === "universal" ||
        (n.type === "pseudo" &&
          n.value === ":not" &&
          (n as selectorParser.Pseudo).nodes.every(otherTags)),
    )
  );
}

/**
 * `.markdown-preview-section :not(:is(li, ul, ol)) > h2` (Micro Mike's
 * heading margins): in Obsidian the block wrapper is the element in between
 * for every top-level block, and Quartz has none, so top-level blocks never
 * match. When the wrapper would match, a copy of the selector without that
 * compound (its specificity moved onto the note) matches them; the original
 * still matches nested ones.
 */
function wrapperAncestors(selectors: selectorParser.Root): boolean {
  let changed = false;
  for (const sel of [...selectors.nodes]) {
    const all = splitCompounds(sel);
    for (let i = 1; i < all.length - 1; i++) {
      const box = all[i - 1]!;
      const d = all[i]!;
      if (
        !classesOf(box).some(
          (k) => CONTENT_WRAPPERS.has(k) || CONTENT_ROOT_CLASSES.includes(k),
        ) ||
        d.before?.value.trim() !== "" ||
        !matchesWrapperDiv(d) ||
        // `div > .el-ul`: the div is the sizer, rewriteBlockWrappers' case.
        wrapperNames(all[i + 1]!) !== null ||
        !/^[\s>]*$/.test(all[i + 1]!.before?.value ?? "")
      )
        continue;
      const copy = sel.clone() as SSelector;
      const parts = splitCompounds(copy);
      const spec = specificity({
        nodes: parts[i]!.nodes,
      } as unknown as SSelector);
      const last = parts[i - 1]!.nodes.at(-1)!;
      for (const q of pad(spec).reverse()) last.parent!.insertAfter(last, q);
      for (const n of parts[i]!.nodes) n.remove();
      parts[i]!.before!.remove();
      selectors.insertAfter(sel, copy);
      changed = true;
      break;
    }
  }
  return changed;
}

function splitMixedIs(selectors: selectorParser.Root, ctx: Ctx): boolean {
  let split = false;
  for (const sel of [...selectors.nodes]) {
    const only = sel.nodes.length === 1 ? sel.nodes[0] : undefined;
    if (
      only?.type !== "pseudo" ||
      only.value !== ":is" ||
      only.nodes.length < 2
    )
      continue;
    const structural = only.nodes.map(
      (inner) =>
        !!processSelector(inner.clone() as SSelector, ctx, true).structural,
    );
    if (structural.every(Boolean) || !structural.some(Boolean)) continue;
    // `:is()` has its most specific alternative's specificity. Each part keeps
    // it through an alternative that never matches (`:is(body, .qt-0)` matches
    // body at class specificity, as `:is(body, .x)` did).
    const [a, b, c] = specificity(sel);
    const never = [
      ...Array<string>(a).fill("#qt-0"),
      ...Array<string>(b).fill(".qt-0"),
      ...Array<string>(c).fill("qt-0"),
    ].join(" ");
    for (const inner of only.nodes) {
      const own = specificity(inner as SSelector);
      const same = own[0] === a && own[1] === b && own[2] === c;
      const text = inner.toString().trim();
      const part = selectorParser().astSync(
        same || !never ? `:is(${text})` : `:is(${text}, ${never})`,
      ).first as SSelector;
      selectors.insertBefore(sel, part);
    }
    sel.remove();
    split = true;
  }
  return split;
}

/**
 * Rewrite one complex selector in place. `top` is false for selectors nested
 * in :not()/:is()/:has(), where dropping would invert or widen the meaning.
 */
function processSelector(
  sel: SSelector,
  ctx: Ctx,
  top = false,
  // False inside `:is()` / `:where()` of an ancestor (`:is(.markdown-reading-view,
  // .markdown-source-view) p`): a wrapper there is elided, not a wrapper subject.
  inSubject = true,
): SelectorResult {
  const wrappers = rewriteBlockWrappers(sel);
  const pusher = rewritePusher(sel) || wrappers;
  const properties = rewriteProperties(sel) || pusher;
  const explorer = rewriteExplorer(sel);
  if (explorer === "drop") return { drop: "staticFalse" };
  const compounds = splitCompounds(sel);
  let changed = explorer || properties;
  let anyConcrete = false;
  let anyElided = false;
  let structural = false;
  const results: CompoundResult[] = [];
  for (let i = 0; i < compounds.length; i++) {
    const isSubject = inSubject && i === compounds.length - 1;
    const res = processCompound(compounds[i]!.nodes, isSubject, ctx);
    if (res.drop) return { drop: res.drop };
    results.push(res);
    if (res.changed) changed = true;
    if (res.concrete || res.bodyish) anyConcrete = true;
    if (res.wrapper) anyElided = true;
    if (isSubject) structural = !!res.structural;
  }

  // A compound that is only content wrappers maps onto Quartz's content root.
  const toContentRoot = (r: CompoundResult) =>
    !!r.content && !r.named && !r.bodyish;

  // `.view-content > div`: an elided wrapper's *children* have no Quartz
  // counterpart, and padding would turn "child of the wrapper" into "any
  // element with a parent". Keep it only if the child is named on its own.
  if (top)
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1]!;
      const cur = results[i]!;
      if (
        isChild(compounds[i]!.before) &&
        prev.wrapper &&
        !prev.concrete &&
        !prev.bodyish &&
        !toContentRoot(prev) &&
        !cur.named &&
        !cur.wrapper &&
        !toContentRoot(cur)
      )
        return { drop: "wrapperSubject" };
    }

  // `.markdown-preview-view .markdown-preview-sizer > div` → `.markdown-preview-view:not(.qt-0) > div`;
  // `.markdown-preview-sizer > div` → `:where(.markdown-preview-view):not(.qt-0) > div`.
  // Right to left, so merging compound i into i-1 leaves earlier indices valid.
  const subjectMapped = toContentRoot(results[results.length - 1]!);
  let blockSubject = false;
  for (let i = compounds.length - 1; i >= 0; i--) {
    const r = results[i]!;
    if (!toContentRoot(r)) continue;
    const current = splitCompounds(sel);
    // A type selector can't follow other simple selectors; keep its specificity.
    for (const n of current[i]!.nodes) {
      if (n.type === "tag") {
        for (const p of pad([0, 0, 1])) n.parent!.insertBefore(n, p);
        n.remove();
      } else if (n.type === "universal") n.remove();
    }
    const { nodes, before } = splitCompounds(sel)[i]!;
    // `.markdown-preview-view`, or `:is(.markdown-preview-view, .markdown-rendered)`.
    const isRootName = (n: SNode): boolean =>
      (n.type === "class" && CONTENT_ROOT_CLASSES.includes(n.value)) ||
      (n.type === "pseudo" &&
        [":is", ":where", ":matches"].includes(n.value) &&
        (n as selectorParser.Pseudo).nodes.length > 0 &&
        (n as selectorParser.Pseudo).nodes.every(
          (alt) => alt.nodes.length === 1 && isRootName(alt.nodes[0]!),
        ));
    const prevIsRoot =
      current[i - 1]?.nodes.some(isRootName) && isDescendantOrChild(before);
    if (prevIsRoot) before!.remove();
    else if (nodes[0])
      nodes[0].parent!.insertBefore(
        nodes[0],
        nodesOf(`:where(${CONTENT_ROOT})`)[0]!,
      );
    r.named = r.concrete = true;
    changed = anyConcrete = true;

    // Obsidian wraps every block in a div (`div.el-h1 > h1`); Quartz doesn't.
    // `sizer > div` is "a top-level block" → any child of the root;
    // `sizer > div h1` is "a heading in the note" → the wrapper is elided.
    const rootIdx = prevIsRoot ? i - 1 : i;
    const wrapper = splitCompounds(sel)[rootIdx + 1];
    if (!wrapper || !isChild(wrapper.before)) continue;
    // Only a bare `div` / `*`, optionally with pseudos (`:has(img)`, `::before`).
    const bareWrapper = (c: Compound) =>
      c.nodes.every(
        (n) =>
          (n.type === "tag" && n.value.toLowerCase() === "div") ||
          n.type === "universal" ||
          n.type === "pseudo",
      );
    if (!bareWrapper(wrapper)) continue;
    const unwrap = (c: Compound) => {
      for (const n of c.nodes) {
        if (n.type === "tag") {
          for (const p of pad([0, 0, 1])) n.parent!.insertBefore(n, p);
          n.remove();
        } else if (n.type === "universal") n.remove();
      }
    };
    unwrap(wrapper);
    // Its siblings are block wrappers too: `sizer > :nth-child(2) ~ div`.
    const isSibling = (c?: selectorParser.Combinator) =>
      c !== undefined && /^[~+]$/.test(c.value.trim());
    let last = rootIdx + 1;
    for (
      let j = rootIdx + 2, all = splitCompounds(sel);
      j < all.length && isSibling(all[j]!.before) && bareWrapper(all[j]!);
      j++
    )
      unwrap(all[(last = j)]!);
    const fresh = splitCompounds(sel);
    if (last === fresh.length - 1) blockSubject = true;
    const w = fresh[rootIdx + 1]!;
    const isPadding = (n: SNode) =>
      n.type === "pseudo" && n.value === ":not" && /qt-0\)$/.test(String(n));
    if (
      rootIdx + 1 < fresh.length - 1 &&
      !isSibling(fresh[rootIdx + 2]?.before) &&
      w.nodes.every(isPadding)
    ) {
      // Elide: move its specificity onto the root compound, drop `> wrapper`.
      const rootLast = fresh[rootIdx]!.nodes.at(-1)!;
      for (const n of [...w.nodes].reverse()) {
        n.remove();
        rootLast.parent!.insertAfter(rootLast, n);
      }
      w.before!.remove();
    }
  }

  // Bare form controls and headings: in Quartz they would hit chrome.
  if (top) {
    const subject = results[results.length - 1]!;
    // `.callout ul` is specific enough; `body ul > li` is not.
    const ancestorsNamed = results.slice(0, -1).some((r) => r.named);
    const control = (subject.tags ?? []).map((t) => BARE_TAGS[t]).find(Boolean);
    if (control && !subject.named && !ancestorsNamed) {
      if (control === "drop") return { drop: "appOnly" };
      const last = splitCompounds(sel).at(-1)!.nodes;
      // Before a trailing pseudo-element: `input:after:where(…)` is invalid.
      const pseudoEl = last.find(isPseudoElement);
      const q = nodesOf(":where(.markdown-rendered *)")[0]!;
      if (pseudoEl) pseudoEl.parent!.insertBefore(pseudoEl, q);
      else if (last.length)
        last[last.length - 1]!.parent!.insertAfter(last[last.length - 1]!, q);
      changed = true;
    }
  }

  // Obsidian's html and body never scroll; Quartz's do. A theme's scrollbar
  // rules are meant for panes, and on the viewport they turn the overlay
  // scrollbar into a classic one (horizontal overflow on phones).
  if (top) {
    const last = splitCompounds(sel).at(-1)!.nodes;
    const scrollbar = last.find(
      (n) => n.type === "pseudo" && /^::-webkit-scrollbar/i.test(n.value),
    );
    const subject = results[results.length - 1]!;
    if (scrollbar && results.length === 1) {
      if (subject.bodyish || subject.rootish) return { drop: "appOnly" };
      if (!subject.named && !(subject.tags ?? []).length) {
        scrollbar.parent!.insertBefore(
          scrollbar,
          nodesOf(":where(:not(html, body))")[0]!,
        );
        changed = true;
      }
    }
  }

  // `.workspace .workspace-tab-container > *` → nothing Quartz-specific left.
  // An ancestor's `:is(.markdown-reading-view, …)` alternative is just "an
  // ancestor": kept, as the elided wrapper is anywhere else above the subject.
  if (anyElided && !anyConcrete && inSubject) return { drop: "wrapperSubject" };
  // From the original subject compound, so a content wrapper mapped onto the
  // root (`.markdown-preview-sizer`) keeps its own padding: in Obsidian that
  // sits inside the file margins.
  const subject = results[results.length - 1]!;
  const subjectIsRoot = !!subject.contentRoot;
  return {
    changed,
    structural,
    contentRoot: top && subjectIsRoot,
    subjectIsRoot,
    elidedOnly: anyElided && !anyConcrete,
    mappedRoot: top && !subjectIsRoot && subjectMapped,
    blockWrapper: top && (blockSubject || WRAPPER_SUBJECTS.has(sel)),
  };
}

interface CompoundResult {
  drop?: DropReason;
  changed?: boolean;
  concrete?: boolean;
  wrapper?: boolean;
  bodyish?: boolean;
  structural?: boolean;
  /** Narrowed by a class, id or attribute (`[type]` excepted), not just a type. */
  named?: boolean;
  /** Contains an elided content wrapper (CONTENT_WRAPPERS). */
  content?: boolean;
  /** Type selectors in the compound, lowercased. */
  tags?: string[];
  /** Matches the root element (`html`, `:root`). */
  rootish?: boolean;
  /** Matches only Quartz's content root (a content-root class, or :is() of such). */
  contentRoot?: boolean;
}

function processCompound(
  nodes: SNode[],
  isSubject: boolean,
  ctx: Ctx,
): CompoundResult {
  let changed = false;
  let bodyish = false;
  let wrapper = false;
  let concrete = false; // something that actually narrows the match in Quartz
  let hasType = false;
  let divTag = false;
  let structuralTarget = false;
  let hasRootish = false;
  let named = false;
  let content = false;
  let contentRoot = false;
  const tags: string[] = [];
  const hasClass = (c: string) =>
    nodes.some((n) => n.type === "class" && n.value === c);
  // Replacements keep the compound's position, so its first node is always at this index.
  const container = nodes[0]?.parent;
  const startIdx = container && nodes[0] ? container.index(nodes[0]) : -1;
  const hasLeaf = hasClass("workspace-leaf-content");
  // `.workspace-split:not(.mod-root)` is a sidebar split; Quartz's note is
  // always in the root split.
  const sideSplit =
    hasClass("workspace-split") &&
    nodes.some(
      (n) =>
        n.type === "pseudo" &&
        n.value === ":not" &&
        n.nodes.some((s) => String(s).trim() === ".mod-root"),
    );
  if (sideSplit) return { drop: "staticFalse" };

  const replace = (node: SNode, newNodes: SNode[]) => {
    for (const n of newNodes) node.parent!.insertBefore(node, n);
    node.remove();
    changed = true;
  };
  // `.workspace`'s own state: Quartz's sidebars are always-open docks, so
  // `.workspace:not(.is-right-sidedock-open)` (Neumorphism's collapsed-dock
  // margins) never matches and `.workspace.is-left-sidedock-open` always does.
  if (hasClass("workspace")) {
    for (const n of [...nodes]) {
      const state =
        n.type === "class"
          ? WORKSPACE_STATE[n.value]
          : n.type === "pseudo" &&
              n.value === ":not" &&
              n.nodes.length === 1 &&
              String(n.nodes[0]).trim().startsWith(".")
            ? WORKSPACE_STATE[String(n.nodes[0]).trim().slice(1)]
            : undefined;
      if (state === undefined) continue;
      const holds = n.type === "class" ? state : !state;
      if (!holds) return { drop: "staticFalse" };
      replace(n, pad(CLASS_SPEC));
      nodes.splice(nodes.indexOf(n), 1);
    }
  }
  // A body class on another element is that element's own state
  // (`.multi-select-pill.is-focused`), not <body>'s: unknown, kept verbatim.
  const elsewhere =
    !nodes.some((n) => n.type === "tag" && /^(body|html)$/i.test(n.value)) &&
    nodes.some(
      (n) =>
        n.type === "class" &&
        !(n.value in MODE_ATTR) &&
        !(n.value in ctx.bodyState) &&
        WRAPPER_MAP[n.value] === undefined &&
        !WRAPPER_CLASSES.has(n.value),
    );

  for (const node of nodes) {
    switch (node.type) {
      case "class": {
        const v = node.value;
        if (v in MODE_ATTR) {
          replace(node, nodesOf(`:is([saved-theme="${MODE_ATTR[v]}"] *)`));
          bodyish = true;
        } else if (v in ctx.bodyState && !elsewhere) {
          if (ctx.bodyState[v] === false) return { drop: "staticFalse" };
          replace(node, pad(CLASS_SPEC));
          bodyish = true;
        } else if (WRAPPER_MAP[v] !== undefined) {
          const target = WRAPPER_MAP[v]!;
          replace(node, [...nodesOf(`:where(${target})`), ...pad(CLASS_SPEC)]);
          if (target === "body") bodyish = true;
          else concrete = named = true;
          structuralTarget = true;
        } else if (WRAPPER_CLASSES.has(v)) {
          replace(node, pad(CLASS_SPEC));
          wrapper = true;
          if (CONTENT_WRAPPERS.has(v)) content = true;
        } else if (QUARTZ_LAYOUT_PREFIXES.some((p) => v.startsWith(p))) {
          concrete = named = true;
          structuralTarget = true;
        } else if (v.startsWith(LANGUAGE_CLASS_PREFIX)) {
          // `.language-js` → `[data-language="js"]` (same specificity).
          const lang = v.slice(LANGUAGE_CLASS_PREFIX.length);
          replace(node, nodesOf(`[data-language="${lang}"]`));
          concrete = named = true;
        } else if (v === "token") {
          // Prism's `.token.number` → Quartz's `[data-token-type="value"]`.
          replace(node, nodesOf("[data-token-type]"));
          concrete = named = true;
        } else if (hasClass("token") && v in PRISM_TOKENS) {
          replace(node, nodesOf(`[data-token-type="${PRISM_TOKENS[v]}"]`));
          concrete = named = true;
        } else if (hasClass("token")) {
          // A Prism token kind Quartz doesn't mark (`.token.parameter`).
          replace(node, nodesOf(`[data-token-type="prism-${v}"]`));
          concrete = named = true;
        } else if (
          RENAMES[v] !== undefined &&
          !(RENAME_UNLESS[v] ?? []).some(hasClass)
        ) {
          // Before the app-only check: a renamed class may share an app-only
          // prefix (`modal-container`).
          replace(node, [
            ...nodesOf(`:where(${RENAMES[v]})`),
            ...pad(CLASS_SPEC),
          ]);
          concrete = named = true;
        } else if (isAppOnly(v)) {
          return { drop: "appOnly" };
        } else {
          concrete = named = true;
          if (CONTENT_ROOT_CLASSES.includes(v)) contentRoot = true;
          if (CLASS_QUALIFY[v]) {
            const anchor = nodes.find(isPseudoElement);
            const last = nodes[nodes.length - 1]!;
            for (const q of nodesOf(CLASS_QUALIFY[v])) {
              if (anchor) anchor.parent!.insertBefore(anchor, q);
              else last.parent!.insertAfter(last, q);
            }
            changed = true;
          }
        }
        break;
      }
      case "attribute": {
        if (hasLeaf && node.attribute === "data-type") {
          const target = LEAF_TYPE_MAP[node.value ?? ""];
          if (target === undefined) return { drop: "leafType" };
          replace(
            node,
            target
              ? [...nodesOf(`:where(${target})`), ...pad(CLASS_SPEC)]
              : pad(CLASS_SPEC),
          );
          if (target) concrete = named = true;
        } else if (
          node.attribute.toLowerCase() === "class" &&
          node.value?.startsWith(LANGUAGE_CLASS_PREFIX) &&
          ["*=", "^=", "~=", "|=", "="].includes(node.operator ?? "")
        ) {
          // `[class*="language-"]` → `[data-language]`; an exact language
          // (`[class~="language-js"]`) → `[data-language="js"]`.
          const lang = node.value.slice(LANGUAGE_CLASS_PREFIX.length);
          const exact =
            lang &&
            (node.operator === "~=" ||
              node.operator === "=" ||
              node.operator === "|=");
          replace(
            node,
            nodesOf(exact ? `[data-language="${lang}"]` : "[data-language]"),
          );
          concrete = named = true;
        } else {
          concrete = true;
          if (node.attribute.toLowerCase() !== "type") named = true;
        }
        break;
      }
      case "tag": {
        const tag = node.value.toLowerCase();
        tags.push(tag);
        const rw = TAG_REWRITES[tag];
        if (rw?.replace) {
          replace(node, [...nodesOf(rw.replace), ...pad([0, 0, 1])]);
          hasType = true;
          concrete = true;
          break;
        }
        if (rw?.qualify) {
          const last = nodes[nodes.length - 1]!;
          // Insert before a trailing pseudo-element, else at the end.
          const anchor = nodes.find(isPseudoElement);
          for (const q of nodesOf(rw.qualify)) {
            if (anchor) anchor.parent!.insertBefore(anchor, q);
            else last.parent!.insertAfter(last, q);
          }
          changed = true;
        }
        hasType = true;
        if (tag === "html") hasRootish = true;
        if (tag === "body") bodyish = true;
        else if (tag === "div") divTag = true;
        else concrete = true;
        break;
      }
      case "pseudo": {
        if (
          node.value === ":not" ||
          node.value === ":has" ||
          LOGICAL_PSEUDOS.has(node.value)
        ) {
          const res = processLogical(node, ctx, isSubject);
          if (res.drop) return { drop: res.drop };
          if (res.changed) changed = true;
          // `li:not(.task-list-item)` is still any li.
          if (res.concrete && !res.wrapper) {
            concrete = true;
            if (node.value !== ":not" && !res.tags) named = true;
          }
          // `:is(.left.sidebar, .right.sidebar)` is as structural as either.
          if (res.structural) structuralTarget = true;
          if (res.contentRoot) contentRoot = true;
          if (res.wrapper) wrapper = true;
          if (res.tags) tags.push(...res.tags);
        } else if (node.value === ":root") {
          concrete = true;
          hasRootish = true;
        }
        break;
      }
      case "id":
      case "nesting":
        concrete = named = true;
        break;
      default:
        break;
    }
  }

  // `div.markdown-reading-view`, `div:is(.markdown-reading-view)`: the div is
  // the wrapper itself, gone in Quartz, not any div (ITS's `.view-content >
  // div:is(…) > div` sized every nested div of the page as a container).
  if (divTag && !(wrapper && !named)) concrete = true;
  if (bodyish && !hasType && !concrete) {
    // A bare body-class compound (`.theme-dark`, `.css-settings-manager`) must
    // still only match <body>.
    const first =
      container && startIdx >= 0 ? container.at(startIdx) : undefined;
    if (first) {
      container!.insertBefore(first, nodesOf(":where(body)")[0]!);
      changed = true;
    }
  } else if (
    isSubject &&
    wrapper &&
    !content &&
    !named &&
    !bodyish &&
    !structuralTarget
  ) {
    // e.g. `.workspace-leaf-content { background }` — no Quartz equivalent.
    // A type selector doesn't help: `div.workspace-leaf` would be any div.
    return { drop: "wrapperSubject" };
  }
  return {
    changed,
    concrete,
    wrapper,
    bodyish,
    structural: isSubject && (bodyish || structuralTarget || hasRootish),
    named,
    content,
    tags,
    rootish: hasRootish,
    contentRoot,
  };
}

/** :not / :is / :where / :has with selector-list arguments. */
function processLogical(
  node: selectorParser.Pseudo,
  ctx: Ctx,
  inSubject = true,
): CompoundResult {
  let changed = false;
  let concrete = false;
  let allStructural = true;
  let allContentRoot = true;
  let allElided = true;
  // `:is(.cm-header-1, h1)` once the editor's alternative is gone: still a
  // bare `h1`, which the note-only scoping of bare tags must see.
  const altTags: string[] = [];
  let allTags = true;
  for (const inner of [...node.nodes]) {
    // A never-matching specificity placeholder (see splitMixedIs).
    if (
      /^(#qt-0|\.qt-0|qt-0)( (#qt-0|\.qt-0|qt-0))*$/.test(
        inner.toString().trim(),
      )
    )
      continue;
    const res = processSelector(
      inner,
      ctx,
      false,
      inSubject || node.value === ":not" || node.value === ":has",
    );
    if (res.drop) {
      inner.remove();
      changed = true;
    } else {
      concrete = true;
      if (res.changed) changed = true;
      if (!res.structural) allStructural = false;
      if (!res.subjectIsRoot) allContentRoot = false;
      if (!res.elidedOnly) allElided = false;
      const own = inner.nodes.filter((n) => n.type !== "comment");
      if (own.length === 1 && own[0]!.type === "tag")
        altTags.push(own[0]!.value.toLowerCase());
      else allTags = false;
    }
  }
  if (node.nodes.length === 0) {
    if (node.value === ":not") {
      // :not(<never matches>) → always true; keep specificity.
      const parent = node.parent!;
      for (const n of pad(CLASS_SPEC)) parent.insertBefore(node, n);
      node.remove();
      return { changed: true, concrete: false };
    }
    // :is()/:where()/:has() with no matching alternative → never matches.
    return { drop: "staticFalse" };
  }
  // Only alternatives (:is/:where), not :not/:has, say what the subject is.
  const alternatives = node.value !== ":not" && node.value !== ":has";
  return {
    changed,
    concrete: concrete && node.value !== ":not",
    structural: alternatives && concrete && allStructural,
    contentRoot: alternatives && concrete && allContentRoot,
    wrapper: alternatives && concrete && allElided,
    tags: alternatives && allTags && altTags.length ? altTags : undefined,
  };
}
