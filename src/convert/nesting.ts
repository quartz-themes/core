/**
 * CSS nesting, flattened. Themes nest rules (`body { .view-content { … } }`,
 * `.callout { &[data-callout="tip"] { … } }`, 98 themes); the converter maps
 * plain selectors, so each nested rule becomes the top-level rule the browser
 * would match:
 *
 * - `&` is the parent selector, as `:is(parent)` unless that's the same thing
 *   (`&` leads or the parent is one compound); a parent list is expanded, one
 *   selector per parent at the list's specificity;
 * - a selector without `&` is a descendant of the parent (also after a
 *   leading combinator: `> .x`);
 * - nested at-rules (`@media`, `@supports`, `@container`) wrap the parent's
 *   selector;
 * - declarations after a nested rule stay after it, as their own rule.
 */
import type { AtRule, ChildNode, Container, Root, Rule } from "postcss";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import { pad, specificity, type Spec } from "./convert";

const NO_IS = /::|:(?:before|after|first-line|first-letter)\b/i;

/** Parent lists up to this many combined selectors are expanded. */
const MAX_EXPAND = 64;

/**
 * The nested selector `child` under `parent`. A parent list is expanded, one
 * selector per parent, each padded to the list's specificity (`:is()`
 * semantics), so the converter keeps or drops each alternative on its own
 * (Retroma's checkbox rules nest under a list with an editor-only selector).
 */
function combine(parent: string, child: string): string {
  let parents: string[];
  let childCount = 1;
  try {
    parents = selectorParser()
      .astSync(parent)
      .nodes.map((s) => s.toString().trim());
    childCount = selectorParser().astSync(child).nodes.length;
  } catch {
    parents = [parent];
  }
  if (parents.length > 1 && parents.length * childCount <= MAX_EXPAND) {
    const specs = parents.map((p) =>
      specificity(selectorParser().astSync(p).first),
    );
    const top = specs.reduce((a, b) =>
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
    );
    return parents
      .map((p, i) => {
        // Padding only adds: where it would overshoot (`body` in a list with
        // a class), a single compound counts for nothing instead (the
        // converter maps `:where(body)`, not `:where(li > input)`, so complex
        // alternatives keep the closest padding).
        const exact =
          specs[i]!.every((v, k) => v <= top[k]!) ||
          /[\s>+~]/.test(p.replace(/\([^()]*\)/g, "()"));
        const rest = exact
          ? (top.map((v, k) => Math.max(0, v - specs[i]![k]!)) as Spec)
          : top;
        const base = exact || NO_IS.test(p) ? p : `:where(${p})`;
        const padded = NO_IS.test(p)
          ? p
          : base + pad(rest).map(String).join("");
        return combineOne(padded, child);
      })
      .join(", ");
  }
  return parents.length === 1
    ? combineOne(parents[0]!, child)
    : combineOne(`:is(${parents.join(", ")})`, child, true);
}

function combineOne(parent: string, child: string, grouped = false): string {
  const compound = (s: string) => {
    try {
      return !selectorParser()
        .astSync(s)
        .first.nodes.some((n) => n.type === "combinator");
    } catch {
      return false;
    }
  };
  return selectorParser((sels) => {
    sels.each((sel) => {
      let nests = 0;
      sel.walkNesting(() => {
        nests++;
      });
      if (!nests) {
        sel.prepend(selectorParser.string({ value: `${parent} ` }));
        return;
      }
      sel.walkNesting((n) => {
        const raw =
          grouped || sel.first === n || compound(parent) || NO_IS.test(parent);
        n.replaceWith(
          selectorParser.string({ value: raw ? parent : `:is(${parent})` }),
        );
      });
    });
  }).processSync(child);
}

/** Flatten every nested rule under `container`. */
export function flattenNesting(container: Root | Container): void {
  for (const node of [...(container.nodes ?? [])]) {
    if (node.type === "rule") flattenRule(node);
    else if (
      node.type === "atrule" &&
      node.nodes &&
      !/keyframes$/i.test(node.name)
    )
      flattenNesting(node);
  }
}

function flattenRule(rule: Rule): void {
  if (!rule.nodes?.some((n) => n.type === "rule" || n.type === "atrule"))
    return;
  const out: ChildNode[] = [];
  let decls: Rule | undefined;
  const flush = () => {
    if (decls?.nodes.length) out.push(decls);
    decls = undefined;
  };
  for (const child of [...rule.nodes]) {
    if (child.type === "rule") {
      flush();
      const flat = child.clone({
        selector: combine(rule.selector, child.selector),
      });
      out.push(flat);
    } else if (child.type === "atrule" && child.nodes) {
      flush();
      const at = child.clone({ nodes: [] }) as AtRule;
      const inner = postcss.rule({ selector: rule.selector });
      inner.append(...child.nodes.map((n) => n.clone()));
      at.append(inner);
      out.push(at);
    } else if (child.type === "atrule" || child.type === "decl") {
      decls ??= rule.clone({ nodes: [] });
      decls.append(child.clone());
    }
  }
  flush();
  out.forEach((n, i) => {
    n.raws.before = i ? "\n" : rule.raws.before;
  });
  rule.replaceWith(...out);
  // Rules nested more than one level deep.
  for (const n of out)
    if (n.type === "rule") flattenRule(n);
    else if (n.type === "atrule") flattenNesting(n);
}
