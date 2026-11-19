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
  type Root,
  type Rule,
} from "postcss";

const safeParseRoot = (css: string, opts: { from: string }) =>
  safeParse(css, opts) as Root;
import safeParse from "postcss-safe-parser";
import selectorParser from "postcss-selector-parser";
import * as csstree from "css-tree";
import { transform } from "lightningcss";
import {
  BODY_STATE,
  WRAPPER_CLASSES,
  WRAPPER_MAP,
  LEAF_TYPE_MAP,
  RENAMES,
  RENAME_UNLESS,
  TAG_REWRITES,
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
    try {
      out = selectorParser((selectors) => {
        selectors.each((sel) => {
          stats.selectors.in++;
          const res = processSelector(sel, { bodyState });
          if (res.drop) {
            dropReason ??= res.drop;
            sel.remove();
            changed = true;
          } else {
            if (res.changed) changed = true;
            if (res.structural) structuralSels.push(sel.toString().trim());
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
    if (structuralSels.length)
      stats.layoutStripped += guardLayout(rule, structuralSels);
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
 * gets to style them.
 */
const LAYOUT_PROPS =
  /^(position|display|float|clear|contain|content-visibility|overflow(-[xy])?|overscroll-behavior.*|(min-|max-)?(width|height)|(min-|max-)?(inline|block)-size|inset.*|top|right|bottom|left|flex.*|grid.*|order|align-self|justify-self|place-self|transform|translate|scale|rotate|zoom|visibility|user-select|-webkit-user-select|pointer-events|z-index)$/;

/**
 * Strip layout declarations that apply to structural selectors. Rules whose
 * selector list mixes structural and non-structural selectors are split so
 * only the structural part is affected. Returns the number of stripped decls.
 */
function guardLayout(rule: Rule, structuralSels: string[]): number {
  const layoutDecls = rule.nodes.filter(
    (d) => d.type === "decl" && LAYOUT_PROPS.test(d.prop),
  );
  if (!layoutDecls.length) return 0;
  const all = selectorParser()
    .astSync(rule.selector)
    .nodes.map((s) => s.toString().trim());
  const rest = all.filter((s) => !structuralSels.includes(s));
  if (rest.length) {
    rule.cloneBefore({ selector: rest.join(", ") });
    rule.selector = structuralSels.join(", ");
  }
  for (const d of layoutDecls) d.remove();
  if (!rule.nodes.some((n) => n.type !== "comment")) rule.remove();
  return layoutDecls.length;
}

/** The targets Quartz minifies plugin CSS with (quartz/plugins/emitters/componentResources.ts). */
export const QUARTZ_TARGETS = {
  safari: (15 << 16) | (6 << 8),
  ios_saf: (15 << 16) | (6 << 8),
  edge: 115 << 16,
  firefox: 102 << 16,
  chrome: 109 << 16,
};

function lightningAccepts(css: string): boolean {
  try {
    transform({
      filename: "x.css",
      code: Buffer.from(css),
      minify: true,
      targets: QUARTZ_TARGETS,
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
}

/** Rewrite one complex selector in place. */
function processSelector(sel: SSelector, ctx: Ctx): SelectorResult {
  const compounds: SNode[][] = [[]];
  for (const node of [...sel.nodes]) {
    if (node.type === "combinator") compounds.push([]);
    else compounds[compounds.length - 1]!.push(node);
  }
  let changed = false;
  let anyConcrete = false;
  let anyElided = false;
  let structural = false;
  for (let i = 0; i < compounds.length; i++) {
    const isSubject = i === compounds.length - 1;
    const res = processCompound(compounds[i]!, isSubject, ctx);
    if (res.drop) return { drop: res.drop };
    if (res.changed) changed = true;
    if (res.concrete || res.bodyish) anyConcrete = true;
    if (res.wrapper) anyElided = true;
    if (isSubject) structural = !!res.structural;
  }
  // `.workspace .workspace-tab-container > *` → nothing Quartz-specific left.
  if (anyElided && !anyConcrete) return { drop: "wrapperSubject" };
  return { changed, structural };
}

interface CompoundResult {
  drop?: DropReason;
  changed?: boolean;
  concrete?: boolean;
  wrapper?: boolean;
  bodyish?: boolean;
  structural?: boolean;
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
  const hasClass = (c: string) =>
    nodes.some((n) => n.type === "class" && n.value === c);
  // Replacements keep the compound's position, so its first node is always at this index.
  const container = nodes[0]?.parent;
  const startIdx = container && nodes[0] ? container.index(nodes[0]) : -1;
  const hasLeaf = hasClass("workspace-leaf-content");

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
          else concrete = true;
          structuralTarget = true;
        } else if (WRAPPER_CLASSES.has(v)) {
          replace(node, pad(CLASS_SPEC));
          wrapper = true;
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
          concrete = true;
        } else {
          concrete = true;
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
          if (target) concrete = true;
        } else {
          concrete = true;
        }
        break;
      }
      case "tag": {
        const tag = node.value.toLowerCase();
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
          if (res.concrete) concrete = true;
        } else if (node.value === ":root") {
          concrete = true;
          hasRootish = true;
        }
        break;
      }
      case "id":
      case "nesting":
        concrete = true;
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
  } else if (isSubject && wrapper && !concrete && !bodyish) {
    // e.g. `.workspace-leaf-content { background }` — no Quartz equivalent.
    return { drop: "wrapperSubject" };
  }
  return {
    changed,
    concrete,
    wrapper,
    bodyish,
    structural: isSubject && (bodyish || structuralTarget || hasRootish),
  };
}

/** :not / :is / :where / :has with selector-list arguments. */
function processLogical(node: selectorParser.Pseudo, ctx: Ctx): CompoundResult {
  let changed = false;
  let concrete = false;
  for (const inner of [...node.nodes]) {
    const res = processSelector(inner, ctx);
    if (res.drop) {
      inner.remove();
      changed = true;
    } else {
      concrete = true;
      if (res.changed) changed = true;
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
  return { changed, concrete: concrete && node.value !== ":not" };
}
