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
        !WRAPPER_CLASSES.has(k) &&
        !CONTENT_ROOT_CLASSES.includes(k) &&
        !/^(mod|is|allow|show)-/.test(k) &&
        k !== "mod-root",
    )
  )
    return -1;
  for (let i = 0; i < BACKDROP_LAYERS.length; i++)
    if (classes.includes(BACKDROP_LAYERS[i]!)) return i;
  // The note box carries `.markdown-rendered` too (Forgotten Golden Sanctuary's
  // `.markdown-rendered { background-color: transparent }` clears its colour).
  if (classes.includes("markdown-rendered")) return NOTE_BOX_LAYER;
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
  // The note boxes' colours, behind the block in Obsidian: ahead of the theme's
  // rules, at the specificity of app.css's transparent `.metadata-container`
  // (which they beat, coming after it) and below the theme's own rules for
  // the block (which come after them).
  const colours: postcss.Rule[] = [];
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
    // For the colours: the conditions outside the note's boxes (body toggles).
    const conds: string[] = [];
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
          const outer = all
            .slice(0, -1)
            .filter((c) => !isNoteBox(c))
            .map((c) => c.nodes.map(String).join("").trim());
          conds.push(
            outer.length
              ? `:where(${outer.join(" ")}) .metadata-container`
              : ".metadata-container",
          );
        }
      }).processSync(rule.selector);
    } catch {
      return;
    }
    if (!out.length) return;
    const inherited = decls.filter((d) => INHERITED.test(d.prop));
    const colour = decls.filter((d) => !INHERITED.test(d.prop));
    // Inherited values never carry !important: the block's own rules win.
    if (inherited.length) {
      const copy = postcss.rule({ selector: out.join(", ") });
      for (const d of inherited) copy.append(d.clone({ important: false }));
      rule.after(copy);
    }
    if (colour.length) {
      const atTop = rule.parent?.type === "root";
      const copy = postcss.rule({
        selector: [...new Set(atTop ? conds : out)].join(", "),
      });
      for (const d of colour) copy.append(d.clone({ important: false }));
      if (atTop) colours.push(copy);
      else rule.after(copy);
    }
  });
  if (!colours.length) return;
  const first = root.nodes.find(
    (n) =>
      !(
        n.type === "atrule" &&
        /^(charset|import|layer|namespace)$/i.test(n.name)
      ),
  );
  if (first) first.before(colours);
  else root.append(colours);
}

/** A note box's background colour, as `background-color`. */
function noteBoxColour(d: Declaration): Declaration | null {
  if (d.prop === "background-color") return d;
  if (d.prop !== "background") return null;
  const v = d.value.trim();
  // A single colour or variable (`color-mix(in srgb, var(--x) 90%, transparent)`
  // included: nested parentheses collapse); layered backgrounds, images and
  // positions would need the shorthand parsed.
  let flat = v;
  for (let prev = ""; prev !== flat;) {
    prev = flat;
    flat = flat.replace(/\([^()]*\)/g, "");
  }
  if (/[\s,]/.test(flat) || /url\(|gradient\(/i.test(v)) return null;
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

/** Inherited text properties a universal rule gives Obsidian's sizer. */
const SIZER_INHERITED =
  /^(color|font-family|font-weight|font-style|font-stretch|font-feature-settings|font-variation-settings|font-optical-sizing|font-variant(-[a-z]+)?|letter-spacing|word-spacing|line-height|text-shadow|text-transform|-webkit-font-smoothing|text-rendering)$/;

/**
 * Quartz's note root is Obsidian's reading view and its sizer in one box.
 * Obsidian's sizer is reached by universal rules only (`* { font-family:
 * "JetBrains Mono" }`), so the text in it, also through app.css's `--h2-font:
 * inherit`, has the universal rule's font. Quartz's root is the view too, which
 * app.css's `.markdown-preview-view { font-family: var(--font-text) }` reaches
 * more specifically (Museifu, SpectrumPlus). The root gets a copy of the
 * universal rule's inherited properties, above the view's own rules (an id),
 * below any rule for the blocks, which are its children.
 */
function universalSizer(root: Root): void {
  root.walkRules((rule) => {
    const parent = rule.parent as AtRule | undefined;
    if (parent?.type === "atrule" && /keyframes$/i.test(parent.name)) return;
    const decls = (rule.nodes ?? []).filter(
      (n): n is Declaration =>
        n.type === "decl" && SIZER_INHERITED.test(n.prop),
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
            // Only <body>/<html> conditions above it: `.callout *` is not the sizer.
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
  // Rules for the note's own box: their selectors, and which of them are only that box
  // (their backgrounds leave the content root, which stands for the column).
  const noteBox = new Map<Rule, { all: string[]; box: Set<string> }>();
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
          const text = String(whole).trim();
          let alts = 0;
          let boxes = 0;
          for (const sel of subjectAlternatives(whole)) {
            alts++;
            if (paint(sel, spec) === NOTE_BOX_LAYER) boxes++;
          }
          const entry = noteBox.get(rule) ?? { all: [], box: new Set() };
          entry.all.push(text);
          if (alts && boxes === alts) entry.box.add(text);
          noteBox.set(rule, entry);
        });
        function paint(sel: SSelector, spec: Spec): number | void {
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
          // The note's own box only in the main pane: not inside an embed, a
          // popover or another view (`.markdown-embed .markdown-preview-view`),
          // whose classes aren't boxes, wrappers or <body>'s.
          if (
            layer === NOTE_BOX_LAYER &&
            all
              .slice(0, -1)
              .some(
                (c, i) =>
                  backdropLayer(c) < 0 &&
                  !(
                    i === 0 &&
                    c.nodes.some(
                      (n) =>
                        (n.type === "tag" && /^(body|html)$/i.test(n.value)) ||
                        (n.type === "class" &&
                          /^theme-(dark|light)$/.test(n.value)),
                    )
                  ) &&
                  classesOf(c).some(
                    (k) => !WRAPPER_CLASSES.has(k) && !/^(mod|is)-/.test(k),
                  ),
              )
          )
            return;
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
          return layer;
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
      // The note's own box is Quartz's content root: its rule already applies
      // there, apart from its backgrounds (below).
      if (layer === NOTE_BOX_LAYER) continue;
      // Text styles set on a box inside the main split inherit into the note
      // as well (Prose's `.markdown-reading-view { letter-spacing }`), below
      // any rule for the note's own elements, as inherited values are.
      // From the boxes around the sidebars too (`.workspace`, `.app-container`),
      // the spacing the note doesn't set itself, as Obsidian's note doesn't
      // (Nytharael, Cordyceps): its font, colour and line height it does set.
      const text = decls.filter((d) =>
        layer <= MAIN_COLUMN_LAYER
          ? BOX_INHERITED.test(d.prop)
          : /^(letter|word)-spacing$/.test(d.prop),
      );
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
  // The note box's backgrounds are painted behind the page now: off the content
  // root, which keeps the column's (the sizer's) own.
  for (const [rule, , decls] of copies) {
    const entry = noteBox.get(rule);
    if (!entry?.box.size) continue;
    const bgs = decls.filter((d) => BACKGROUND_PROP.test(d.prop));
    if (!bgs.length) continue;
    const rest = entry.all.filter((sel) => !entry.box.has(sel));
    if (rest.length) {
      const others = rule.clone({ selector: rest.join(", ") });
      rule.after(others);
      rule.selector = [...entry.box].join(", ");
    }
    for (const d of bgs) d.remove();
    if (!rule.nodes?.length) rule.remove();
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
const MAIN_COLUMN_LAYER = 7;
/** The note's own box (`.markdown-preview-view`): Quartz's content root, but a pane-wide backdrop layer. */
const NOTE_BOX_LAYER = 0;

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
  universalSizer(root);

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
    try {
      out = selectorParser((selectors) => {
        if (splitMixedIs(selectors, { bodyState })) changed = true;
        if (propertyInputs(selectors)) changed = true;
        if (wrapperInner(selectors)) changed = true;
        if (sizerDiv(selectors)) changed = true;
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
    ];
    let parts = [rule];
    for (const [sels, props] of guards)
      if (sels.length)
        parts = parts.flatMap((r) => {
          const res = guardLayout(r, sels, props);
          stats.layoutStripped += res.stripped;
          return res.rules;
        });
    for (const m of out.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
      const c = m[1]!;
      if (c.startsWith("qt-") || quartzClasses.has(c)) continue;
      stats.unmatchedClasses[c] = (stats.unmatchedClasses[c] ?? 0) + 1;
    }
    stats.selectors.out += out.split(",").length;
  });

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
const MARGIN_PROPS =
  /^margin(-(top|right|bottom|left|inline|block)(-(start|end))?)?$/;

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
  for (const d of decls) d.remove();
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

/**
 * Obsidian's sizer holds the note's blocks between UI: `div.markdown-preview-
 * pusher` and `div.mod-header` before them, `div.mod-footer` after. Quartz's note
 * root holds only the blocks, so a theme that counts the sizer's children
 * (`sizer > div:nth-child(3)`, the first block; `sizer > :nth-child(2) ~ div`,
 * every block; `sizer > div:last-child`, the footer) counts two fewer from the
 * start and one fewer from the end. A count that lands on the UI matches
 * nothing; the header followed by `~` / `+` is the start of the blocks.
 */
const SIZER_BEFORE: string[][] = [
  ["markdown-preview-pusher"],
  ["mod-header", "mod-ui"],
];
const SIZER_AFTER: string[][] = [["mod-footer", "mod-ui"]];
const SIZER_CLASSES = ["markdown-preview-sizer", "markdown-preview-section"];

/** `An+B` of a structural pseudo, or undefined (an `of S` filter, or unparsable). */
function anPlusB(arg: string): [number, number] | undefined {
  const v = arg.replace(/\s+/g, "").toLowerCase();
  if (v === "odd") return [2, 1];
  if (v === "even") return [2, 0];
  const m = /^(?:([+-]?\d*)n)?([+-]?\d+)?$/.exec(v);
  if (!m || v === "") return undefined;
  const a =
    m[1] === undefined
      ? 0
      : m[1] === "" || m[1] === "+"
        ? 1
        : m[1] === "-"
          ? -1
          : Number(m[1]);
  return [a, m[2] ? Number(m[2]) : 0];
}

const formatAnB = (a: number, b: number) =>
  a === 0
    ? String(b)
    : `${a === 1 ? "" : a === -1 ? "-" : a}n${b < 0 ? b : `+${b}`}`;

function rewriteSizerChildren(sel: SSelector): "drop" | boolean {
  let changed = false;
  for (let i = splitCompounds(sel).length - 2; i >= 0; i--) {
    const all = splitCompounds(sel);
    const child = all[i + 1]!;
    if (!isChild(child.before)) continue;
    if (!classesOf(all[i]!).some((c) => SIZER_CLASSES.includes(c))) continue;
    // Divs both sides: a count of another type (`h1:first-child`) is left alone.
    const tag = child.nodes.find((n) => n.type === "tag");
    if (tag && tag.value.toLowerCase() !== "div") continue;
    if (classesOf(child).includes("markdown-preview-pusher")) continue;
    const counts = child.nodes.filter(
      (n): n is selectorParser.Pseudo =>
        n.type === "pseudo" &&
        /^:(first|last|only|nth|nth-last)-(child|of-type)$/i.test(n.value),
    );
    if (!counts.length) continue;
    // Where in Obsidian's sizer the compound lands: a block, or the UI around it.
    let ui: "before" | "after" | undefined;
    let uiIndex = 0;
    for (const n of counts) {
      const name = n.value.toLowerCase();
      if (/^:only-/.test(name)) return "drop";
      const fromEnd = /^:(last|nth-last)-/.test(name);
      const shift = fromEnd ? SIZER_AFTER.length : SIZER_BEFORE.length;
      const ab: [number, number] | undefined = /^:(first|last)-/.test(name)
        ? [0, 1]
        : anPlusB(n.nodes.map(String).join(","));
      if (!ab) continue;
      const [a, b] = ab;
      const nb = b - shift;
      if (a === 0 && nb <= 0) {
        ui = fromEnd ? "after" : "before";
        uiIndex = b;
        continue;
      }
      const ofType = /-of-type$/.test(name);
      const fresh = selectorParser.pseudo({
        value: `:nth-${fromEnd ? "last-" : ""}${ofType ? "of-type" : "child"}`,
      });
      fresh.append(
        selectorParser.selector({
          value: "",
          nodes: [selectorParser.string({ value: formatAnB(a, nb) })],
        } as never),
      );
      n.replaceWith(fresh);
      changed = true;
    }
    if (!ui) continue;
    const list = ui === "before" ? SIZER_BEFORE : SIZER_AFTER;
    const el = list[ui === "before" ? uiIndex - 1 : list.length - uiIndex];
    const fits =
      el !== undefined &&
      child.nodes.every(
        (n) =>
          counts.includes(n as selectorParser.Pseudo) ||
          n.type === "combinator" ||
          (n.type === "tag" && n.value.toLowerCase() === "div") ||
          n.type === "universal" ||
          (n.type === "class" && el.includes(n.value)),
      );
    const next = all[i + 2];
    const comb = next?.before?.value.trim();
    if (!fits || ui === "after" || !next || (comb !== "~" && comb !== "+"))
      return "drop";
    // `+` after the header is the first block; after the pusher, the header.
    if (comb === "+" && uiIndex !== list.length) return "drop";
    const spec = specificity(child as unknown as SSelector);
    for (const n of [...child.nodes]) if (n.type !== "combinator") n.remove();
    child.before!.remove();
    next.before!.replaceWith(selectorParser.combinator({ value: ">" }));
    const add =
      comb === "+"
        ? [...nodesOf(":first-child"), ...pad([spec[0], spec[1] - 1, spec[2]])]
        : pad(spec);
    const anchor = next.nodes.find(isPseudoElement);
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
 * Obsidian's per-block wrappers hold their block directly (`div.el-table >
 * table`); Quartz renders the same wrappers (rehype-obsidian) with an element
 * of its own in between for some blocks: the scroll container around tables,
 * the `<figure>` syntax highlighting puts code blocks in, the expand controls'
 * box around diagrams. `.el-table > table` gets that element in between, with
 * no specificity; where Quartz may render the block without it (code blocks
 * without syntax highlighting), the original selector stays too.
 */
const WRAPPER_INNER: {
  wrapper: string;
  block: (c: Compound) => boolean;
  between: string;
  only: boolean;
}[] = [
  {
    wrapper: "el-table",
    block: (c) =>
      c.nodes.some(
        (n) => n.type === "tag" && n.value.toLowerCase() === "table",
      ),
    between: ":where(.table-container)",
    only: true,
  },
  {
    wrapper: "el-pre",
    block: (c) =>
      c.nodes.some((n) => n.type === "tag" && n.value.toLowerCase() === "pre"),
    between: ":where([data-rehype-pretty-code-figure])",
    only: false,
  },
  {
    wrapper: "el-pre",
    block: (c) => classesOf(c).includes("mermaid"),
    between: ":where(.mermaid-diagram)",
    only: true,
  },
];

/** `.el-p`, `[class^="el-"]`: Obsidian's block wrapper. */
const isWrapperCompound = (c: Compound) =>
  classesOf(c).some((v) => /^el-[a-z0-9]+$/.test(v)) ||
  c.nodes.some(
    (n) =>
      n.type === "attribute" &&
      n.attribute === "class" &&
      /^el-/.test(n.value ?? ""),
  );

/**
 * `.markdown-rendered div > .el-p`: in Obsidian the div is the sizer, between
 * the reading view and its blocks. Quartz's note root is both, so the rule also
 * goes to the root's blocks (`.markdown-rendered > .el-p`, the div's specificity
 * kept). The original stays for blocks of an embedded note, in the embed's div.
 */
function sizerDiv(selectors: selectorParser.Root): boolean {
  let changed = false;
  for (const sel of [...selectors.nodes]) {
    const all = splitCompounds(sel);
    for (let i = 1; i < all.length - 1; i++) {
      const div = all[i]!;
      if (!isDescendantOrChild(div.before)) continue;
      if (!isChild(all[i + 1]!.before) || !isWrapperCompound(all[i + 1]!))
        continue;
      if (!classesOf(all[i - 1]!).some((v) => READING_VIEW_CLASSES.has(v)))
        continue;
      if (
        !div.nodes.length ||
        !div.nodes.every(
          (n) =>
            n.type === "combinator" ||
            (n.type === "tag" && n.value.toLowerCase() === "div") ||
            n.type === "universal",
        )
      )
        continue;
      const copy = sel.clone() as SSelector;
      const call = splitCompounds(copy);
      const cdiv = call[i]!;
      const spec = specificity(cdiv as unknown as SSelector);
      for (const n of [...cdiv.nodes]) if (n.type !== "combinator") n.remove();
      cdiv.before!.remove();
      const prev = call[i - 1]!;
      const anchor = prev.nodes[prev.nodes.length - 1]!;
      for (const q of pad(spec).reverse())
        anchor.parent!.insertAfter(anchor, q);
      selectors.insertAfter(sel, copy);
      changed = true;
      break;
    }
  }
  return changed;
}

/**
 * Quartz's element between a wrapper and its block, by the wrapper it's in
 * (`undefined`: a wrapper of any block, `[class^="el-"]`, the sizer's `div`).
 */
const QUARTZ_INNER: { wrappers: string[]; between: string; block: string }[] = [
  {
    wrappers: ["el-pre"],
    between: ":where([data-rehype-pretty-code-figure])",
    block: "",
  },
  { wrappers: ["el-table"], between: ":where(.table-container)", block: "" },
  {
    wrappers: ["el-pre"],
    between: ":where(.mermaid-diagram)",
    block: ":where(.mermaid)",
  },
];

/** A child compound that names no element: `*`, `:first-child`. */
const isAnyChild = (c: Compound) =>
  c.nodes.every(
    (n) =>
      n.type === "combinator" ||
      n.type === "universal" ||
      (n.type === "pseudo" &&
        (isPseudoElement(n) ||
          /^:(first|last|only|nth|nth-last)-(child|of-type)$/i.test(n.value))),
  );

/**
 * `.el-pre > *` / `[class^="el-"] > *`: in Obsidian the wrapper's child is the
 * block; in Quartz it's an element of Quartz's around the block (syntax
 * highlighting's figure, the table's scroll container, the diagram's box). The
 * rule goes past it to the block, and no longer to it (Hidontknow's blocks lose
 * their margins: the code block's `pre` too).
 */
function wrapperAnyChild(sel: SSelector, all: Compound[], i: number): boolean {
  const wrapper = all[i]!;
  const next = all[i + 1]!;
  if (!isChild(next.before) || !isAnyChild(next)) return false;
  const classes = classesOf(wrapper);
  const named = classes.filter((v) => /^el-[a-z0-9]+$/.test(v));
  const isSizerDiv =
    i > 0 &&
    isChild(wrapper.before) &&
    classesOf(all[i - 1]!).some((v) => SIZER_CLASSES.includes(v)) &&
    wrapper.nodes.every(
      (n) =>
        n.type === "combinator" ||
        n.type === "universal" ||
        (n.type === "tag" && n.value.toLowerCase() === "div"),
    );
  if (!named.length && !isWrapperCompound(wrapper) && !isSizerDiv) return false;
  const inner = QUARTZ_INNER.filter(
    (q) => !named.length || q.wrappers.some((w) => named.includes(w)),
  );
  if (!inner.length) return false;
  const selectors = sel.parent as unknown as selectorParser.Root;
  const at = sel.index(next.before!);
  const addTo = (s: SSelector, at: number, nodes: SNode[]) => {
    const compound = splitCompounds(s)[at]!;
    const anchor = compound.nodes.find(isPseudoElement);
    const last = compound.nodes[compound.nodes.length - 1]!;
    for (const q of [...nodes].reverse()) {
      if (anchor) anchor.parent!.insertBefore(anchor, q);
      else last.parent!.insertAfter(last, q);
    }
  };
  let after: SSelector = sel;
  for (const q of inner) {
    const copy = sel.clone() as SSelector;
    const comb = copy.at(at) as selectorParser.Combinator;
    const child = selectorParser().astSync("a > b").first.nodes[1]!;
    for (const n of [...nodesOf(q.between), child.clone() as SNode].reverse())
      copy.insertAfter(comb, n as selectorParser.Combinator);
    if (q.block) addTo(copy, i + 2, nodesOf(q.block));
    selectors.insertAfter(after, copy);
    after = copy;
  }
  addTo(
    sel,
    i + 1,
    nodesOf(
      `:where(:not(${inner.map((q) => q.between.slice(7, -1)).join(", ")}))`,
    ),
  );
  return true;
}

/** Quartz's element in place of Obsidian's block as a child: `table` → its container. */
const QUARTZ_STAND_IN: Record<string, string> = {
  table: ":where(.table-container)",
  pre: ":where([data-rehype-pretty-code-figure])",
};

/**
 * `div:has(> :not(h2, table))`: a child that isn't a table. In Quartz the
 * table's child stand-in is its scroll container (code: syntax highlighting's
 * figure), which isn't one either; the `:not()` excludes it too, with the same
 * specificity (Seamless View's space above a heading after a table).
 */
function notStandIns(sel: SSelector): boolean {
  let changed = false;
  sel.walkPseudos((p) => {
    if (p.value.toLowerCase() !== ":not") return;
    const parent = p.parent;
    if (!parent) return;
    let prev = parent.at(parent.index(p) - 1);
    while (prev && prev.type !== "combinator")
      prev = parent.at(parent.index(prev) - 1);
    if (!isChild(prev as selectorParser.Combinator | undefined)) return;
    const args = p.nodes.map((a) => String(a).trim().toLowerCase());
    for (const [tag, standIn] of Object.entries(QUARTZ_STAND_IN)) {
      if (!args.includes(tag) || args.includes(standIn)) continue;
      p.append(selectorParser().astSync(standIn).first.clone() as never);
      changed = true;
    }
  });
  return changed;
}

/** Classes of Obsidian's properties block: an `input` under one is a property's. */
const METADATA_SCOPE =
  /^metadata-(container|content|properties|property|property-key|property-value)$/;

/**
 * Obsidian's property inputs, and Quartz's element for each. Obsidian edits
 * properties in place: the key is `input.metadata-property-key-input`
 * (`type="text"`), a number `input.metadata-input-number`, a date
 * `input.metadata-input-text.mod-date` (`type="date"`, `"datetime-local"`).
 * Quartz shows them read-only: the key in a span, numbers and dates in divs,
 * with the same classes (text, lists and checkboxes are Obsidian's elements).
 */
const PROPERTY_INPUT_TYPES: Record<string, string> = {
  text: ".metadata-property-key-input",
  number: ".metadata-input-number",
  date: ".mod-date",
  "datetime-local": ".mod-date",
};

/**
 * `input.metadata-property-key-input`, `.metadata-property-value input`: rules
 * for Obsidian's property inputs reach Quartz's element for each, with the
 * same specificity. `input.x` → `:is(input, span).x`; a classless `input`
 * under the properties block → `:is(input, :where(…))`, by its `[type]` (the
 * attribute moves into the `:is()`). Checkboxes are inputs in both.
 */
function propertyInputs(selectors: selectorParser.Root): boolean {
  let changed = false;
  for (const sel of selectors.nodes) {
    let scoped = false;
    sel.walkClasses((c) => {
      if (METADATA_SCOPE.test(c.value)) scoped = true;
    });
    // Collected first: the replacement holds an `input` too.
    const inputs: selectorParser.Tag[] = [];
    sel.walkTags((tag) => {
      if (tag.value.toLowerCase() === "input") inputs.push(tag);
    });
    for (const tag of inputs) {
      const parent = tag.parent as SSelector | undefined;
      if (!parent) continue;
      const nodes = parent.nodes;
      let from = parent.index(tag);
      while (from > 0 && nodes[from - 1]!.type !== "combinator") from--;
      let to = parent.index(tag);
      while (to < nodes.length - 1 && nodes[to + 1]!.type !== "combinator")
        to++;
      const compound = nodes.slice(from, to + 1);
      const classes = compound.flatMap((n) =>
        n.type === "class" ? [n.value] : [],
      );
      let stand: string | undefined;
      if (classes.includes("metadata-property-key-input"))
        stand = ":is(input, span)";
      else if (
        !classes.includes("metadata-input-checkbox") &&
        classes.some((c) => /^metadata-input(-text|-number)?$/.test(c))
      )
        stand = ":is(input, div)";
      else if (!classes.length && scoped) {
        const types = compound.filter(
          (n): n is selectorParser.Attribute =>
            n.type === "attribute" && n.attribute.toLowerCase() === "type",
        );
        if (types.length > 1) continue;
        const type = types[0];
        if (!type)
          stand =
            ":is(input, :where(.metadata-property-key-input, .metadata-input))";
        else {
          const value = type.value?.toLowerCase();
          const where =
            value && type.operator === "=" && PROPERTY_INPUT_TYPES[value];
          if (!where) continue;
          stand = `:is(input${String(type).trim()}, :where(${where}))`;
          type.remove();
        }
      }
      if (!stand) continue;
      tag.replaceWith(...(nodesOf(stand) as never[]));
      changed = true;
    }
  }
  return changed;
}

function wrapperInner(selectors: selectorParser.Root): boolean {
  let changed = false;
  for (const sel of [...selectors.nodes]) {
    if (notStandIns(sel)) changed = true;
    const all = splitCompounds(sel);
    for (let i = all.length - 2; i >= 0; i--) {
      const next = all[i + 1]!;
      if (!isChild(next.before)) continue;
      const inner = WRAPPER_INNER.find(
        (w) => classesOf(all[i]!).includes(w.wrapper) && w.block(next),
      );
      if (!inner) {
        if (wrapperAnyChild(sel, all, i)) {
          changed = true;
          break;
        }
        continue;
      }
      const copy = sel.clone() as SSelector;
      const at = sel.index(next.before!);
      const comb = copy.at(at) as selectorParser.Combinator;
      const child = selectorParser().astSync("a > b").first.nodes[1]!;
      for (const n of [
        ...nodesOf(inner.between),
        child.clone() as SNode,
      ].reverse())
        copy.insertAfter(comb, n as selectorParser.Combinator);
      if (inner.only) sel.replaceWith(copy);
      else selectors.insertAfter(sel, copy);
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
  const sizerChildren = rewriteSizerChildren(sel);
  if (sizerChildren === "drop") return { drop: "staticFalse" };
  const pusher = rewritePusher(sel) || sizerChildren;
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
          // Generic HTML attributes don't name one of Obsidian's elements:
          // `details[open]` is any open <details> (Swak's, which reached
          // Quartz's properties block, also a <details>).
          if (!/^(type|open|checked|disabled)$/i.test(node.attribute))
            named = true;
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
