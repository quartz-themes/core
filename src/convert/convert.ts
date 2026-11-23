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
import selectorParser from "postcss-selector-parser";
// The prebuilt bundle: css-tree's lib/ loads JSON at runtime, which breaks once bundled.
import * as csstree from "css-tree/dist/csstree.esm";
import { Features, transform } from "lightningcss";
import {
  BODY_STATE,
  WRAPPER_CLASSES,
  WRAPPER_MAP,
  LEAF_TYPE_MAP,
  RENAMES,
  RENAME_UNLESS,
  TAG_REWRITES,
  CONTENT_WRAPPERS,
  CONTENT_ROOT,
  CONTENT_ROOT_CLASSES,
  BARE_TAGS,
  LANGUAGE_CLASS_PREFIX,
  QUARTZ_LAYOUT_PREFIXES,
  FILES_CONTAINER,
  TREE_ITEM_CLASSES,
  TREE_PART_CLASSES,
  isAppOnly,
} from "./profile";

type SNode = selectorParser.Node;
type SSelector = selectorParser.Selector;
type Spec = [number, number, number];

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

/** Nodes that match any element and add the given specificity. */
function pad([a, b, c]: Spec): SNode[] {
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
      [blockWrapperSels, (d) => OVERFLOW_PROPS.test(d.prop)],
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
const isMappedRootLayout = (d: Declaration) =>
  ROOT_BOX_PROPS.test(d.prop) || isOffsetMargin(d);
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
  /** The subject is Obsidian's per-block wrapper div, i.e. a top-level block in Quartz. */
  blockWrapper?: boolean;
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
 * `:is(.nav-files-container, .search-result-container) { container-type: size }`:
 * when only some alternatives of a whole-selector `:is()` are Quartz's own
 * layout elements, the layout guard can't strip their layout without stripping
 * everyone's. Split it into `:is(A), :is(B)` (each keeping its own
 * specificity), so each alternative is guarded on its own.
 */
/** Selectors Level 4 specificity of a complex selector. */
function specificity(sel: SSelector | SNode): Spec {
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
      if (n.value.startsWith("::")) add([0, 0, 1]);
      else if (n.value === ":where") continue;
      else if ([":is", ":not", ":has", ":matches"].includes(n.value))
        add(max(n.nodes as SNode[]));
      else add([0, 1, 0]);
    }
  }
  return spec;
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
): SelectorResult {
  const explorer = rewriteExplorer(sel);
  if (explorer === "drop") return { drop: "staticFalse" };
  const compounds = splitCompounds(sel);
  let changed = explorer;
  let anyConcrete = false;
  let anyElided = false;
  let structural = false;
  const results: CompoundResult[] = [];
  for (let i = 0; i < compounds.length; i++) {
    const isSubject = i === compounds.length - 1;
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
    const prevIsRoot =
      current[i - 1]?.nodes.some(
        (n) => n.type === "class" && CONTENT_ROOT_CLASSES.includes(n.value),
      ) && isDescendantOrChild(before);
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
      const pseudoEl = last.find(
        (n) => n.type === "pseudo" && n.value.startsWith("::"),
      );
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
  if (anyElided && !anyConcrete) return { drop: "wrapperSubject" };
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
    mappedRoot: top && !subjectIsRoot && subjectMapped,
    blockWrapper: top && blockSubject,
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

  for (const node of nodes) {
    switch (node.type) {
      case "class": {
        const v = node.value;
        if (v in MODE_ATTR) {
          replace(node, nodesOf(`:is([saved-theme="${MODE_ATTR[v]}"] *)`));
          bodyish = true;
        } else if (v in ctx.bodyState) {
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
        } else if (isAppOnly(v)) {
          return { drop: "appOnly" };
        } else if (
          RENAMES[v] !== undefined &&
          !(RENAME_UNLESS[v] ?? []).some(hasClass)
        ) {
          replace(node, [
            ...nodesOf(`:where(${RENAMES[v]})`),
            ...pad(CLASS_SPEC),
          ]);
          concrete = named = true;
        } else {
          concrete = named = true;
          if (CONTENT_ROOT_CLASSES.includes(v)) contentRoot = true;
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
          const anchor = nodes.find(
            (n) => n.type === "pseudo" && n.value.startsWith("::"),
          );
          for (const q of nodesOf(rw.qualify)) {
            if (anchor) anchor.parent!.insertBefore(anchor, q);
            else last.parent!.insertAfter(last, q);
          }
          changed = true;
        }
        hasType = true;
        if (tag === "html") hasRootish = true;
        if (tag === "body") bodyish = true;
        else concrete = true;
        break;
      }
      case "pseudo": {
        if (
          node.value === ":not" ||
          node.value === ":has" ||
          LOGICAL_PSEUDOS.has(node.value)
        ) {
          const res = processLogical(node, ctx);
          if (res.drop) return { drop: res.drop };
          if (res.changed) changed = true;
          // `li:not(.task-list-item)` is still any li.
          if (res.concrete) {
            concrete = true;
            if (node.value !== ":not") named = true;
          }
          // `:is(.left.sidebar, .right.sidebar)` is as structural as either.
          if (res.structural) structuralTarget = true;
          if (res.contentRoot) contentRoot = true;
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
function processLogical(node: selectorParser.Pseudo, ctx: Ctx): CompoundResult {
  let changed = false;
  let concrete = false;
  let allStructural = true;
  let allContentRoot = true;
  for (const inner of [...node.nodes]) {
    // A never-matching specificity placeholder (see splitMixedIs).
    if (
      /^(#qt-0|\.qt-0|qt-0)( (#qt-0|\.qt-0|qt-0))*$/.test(
        inner.toString().trim(),
      )
    )
      continue;
    const res = processSelector(inner, ctx);
    if (res.drop) {
      inner.remove();
      changed = true;
    } else {
      concrete = true;
      if (res.changed) changed = true;
      if (!res.structural) allStructural = false;
      if (!res.subjectIsRoot) allContentRoot = false;
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
  };
}
