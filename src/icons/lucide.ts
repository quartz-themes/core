/**
 * Lucide icon utilities — builds SVG strings and CSS data URIs from @lucide/icons data.
 *
 * @lucide/icons exports icon objects shaped as:
 *   { name: string, size: number, node: LucideIconNode[] }
 * where LucideIconNode = [tag, attrs] | [tag, attrs, children]
 *
 * We convert these to SVG markup and then to CSS-ready `url('data:image/svg+xml,...')` values,
 * matching the format Quartz uses in callouts.scss for --callout-icon-* variables.
 */

import type { LucideIconData, LucideIconNode } from "@lucide/icons";

function renderNodes(nodes: LucideIconNode[]): string {
  return nodes
    .map((node) => {
      const [tag, attrs, children] = node;
      const attrStr = Object.entries(attrs)
        .filter(([k]) => k !== "key") // "key" is a React internal, not a valid SVG attribute
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ");
      if (children?.length) {
        return `<${tag} ${attrStr}>${renderNodes(children)}</${tag}>`;
      }
      return `<${tag} ${attrStr}/>`;
    })
    .join("");
}

/** Lucide icons are drawn on a 24×24 grid; since @lucide/icons 1.70 the size fields are optional. */
const LUCIDE_GRID = 24;

function getIconSize(icon: LucideIconData): { width: number; height: number } {
  if (icon.size !== undefined) return { width: icon.size, height: icon.size };
  return {
    width: icon.width ?? LUCIDE_GRID,
    height: icon.height ?? LUCIDE_GRID,
  };
}

export function buildSvgString(icon: LucideIconData): string {
  const { width, height } = getIconSize(icon);
  const children = renderNodes(icon.node);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" ` +
    `viewBox="0 0 ${width} ${height}" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `${children}</svg>`
  );
}

export function svgToDataUri(svg: string): string {
  const encoded = svg
    .replace(/"/g, "'")
    .replace(/#/g, "%23")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E");
  return `url("data:image/svg+xml;utf8,${encoded}")`;
}

export function iconToDataUri(icon: LucideIconData): string {
  return svgToDataUri(buildSvgString(icon));
}

export type { LucideIconData, LucideIconNode };
