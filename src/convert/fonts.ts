/**
 * Web fonts in converted themes.
 *
 * - `pruneFonts`: themes bundle fonts they don't use (whole families, often as
 *   megabytes of base64), and fonts whose relative `url()` points at files that
 *   were never shipped with theme.css. Runs on the composed stylesheet, after
 *   Style Settings made disabled options statically false, so a font only a
 *   disabled option uses goes too.
 * - `stripThemeFonts` + `QUARTZ_FONT_BRIDGE` (`themeFonts: false`): the site's
 *   Quartz fonts replace the theme's, through the override variables Obsidian's
 *   own Appearance settings use.
 */
import postcss, { type AtRule, type Root } from "postcss";
import safeParse from "postcss-safe-parser";

/** Converted CSS keeps declarations browsers drop (`color: border-color: x`). */
const parse = (css: string): Root => {
  try {
    return postcss.parse(css);
  } catch {
    return safeParse(css) as Root;
  }
};

/** Quartz's fonts through Obsidian's user-override variables. */
export const QUARTZ_FONT_BRIDGE: Record<string, string> = {
  "--font-text-override": "var(--bodyFont)",
  "--font-interface-override": "var(--bodyFont)",
  "--font-monospace-override": "var(--codeFont)",
  "--h1-font": "var(--headerFont)",
  "--h2-font": "var(--headerFont)",
  "--h3-font": "var(--headerFont)",
  "--h4-font": "var(--headerFont)",
  "--h5-font": "var(--headerFont)",
  "--h6-font": "var(--headerFont)",
  "--inline-title-font": "var(--headerFont)",
};

/** Theme declarations that choose a font family (dropped with `themeFonts: false`). */
const FONT_FAMILY_DECL =
  /^(font-family|--font-(text|interface|monospace)(-theme|-override|-default)?|--font-default|--h[1-6]-font|--inline-title-font)$/i;

const isFontImport = (at: AtRule) =>
  /fonts?\b|\.woff|\.ttf|\.otf/i.test(at.params);

/** Remove a theme's web fonts and font-family choices. */
export function stripThemeFonts(css: string): string {
  if (!css) return css;
  const root = parse(css);
  root.walkAtRules(/^(font-face|import)$/i, (at) => {
    if (at.name.toLowerCase() === "font-face" || isFontImport(at)) at.remove();
  });
  root.walkDecls(FONT_FAMILY_DECL, (d) => {
    d.remove();
  });
  return root.toString();
}

const normalize = (s: string) =>
  s
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .replace(/\s+/g, " ")
    .toLowerCase();
const familyOf = (at: AtRule) => {
  let family = "";
  at.walkDecls(/^font-family$/i, (d) => {
    family = normalize(d.value);
  });
  return family;
};

/** `var(--a, "X Y"), Z` → ["x y", "z"] (quotes kept intact while splitting). */
function fontListItems(value: string): string[] {
  const items: string[] = [];
  let cur = "";
  let quote = "";
  for (const c of value) {
    if (quote) {
      if (c === quote) quote = "";
      cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === "," || c === "(" || c === ")") {
      items.push(cur);
      cur = "";
    } else cur += c;
  }
  items.push(cur);
  return items
    .map((i) => normalize(i.replace(/!important\s*$/i, "")))
    .filter((i) => i && !i.startsWith("--") && i !== "var");
}

/** `src` entries whose url() can't resolve on a Quartz site. */
const RELATIVE_URL =
  /url\(\s*(["']?)(?!data:|https?:|\/\/|\/|#)([^"')]+)\1\s*\)/i;

/**
 * Split a `src` value on top-level commas (data URIs and format() hold none,
 * but quoted strings may).
 */
function splitSources(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) {
      if (c === quote && value[i - 1] !== "\\") quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  out.push(value.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

export interface PruneReport {
  /** Families removed because nothing references them. */
  unused: string[];
  /** @font-face rules removed because none of their sources resolve. */
  unresolvable: string[];
  /** Bytes removed. */
  bytes: number;
}

/**
 * Remove `@font-face` rules that can't load or that no declaration uses.
 * A family counts as used when any declaration outside `@font-face` (a
 * `font-family`, a `font` shorthand, a custom property) names it.
 */
export function pruneFonts(sheets: string[]): {
  sheets: string[];
  report: PruneReport;
} {
  const report: PruneReport = { unused: [], unresolvable: [], bytes: 0 };
  if (!sheets.some((s) => /@font-face/i.test(s))) return { sheets, report };
  const roots = sheets.map(parse);

  // Drop sources that can't resolve; a face without any is dropped.
  for (const root of roots)
    root.walkAtRules(/^font-face$/i, (at) => {
      let srcs = 0;
      let dropped = 0;
      at.walkDecls(/^src$/i, (d) => {
        const kept = splitSources(d.value).filter(
          (s) => !(/^url\(/i.test(s) && RELATIVE_URL.test(s)),
        );
        if (kept.length) {
          srcs++;
          d.value = kept.join(", ");
        } else {
          dropped++;
          d.remove();
        }
      });
      // A face without any `src` (app.css's "??" placeholder) is left alone.
      if (dropped && !srcs) {
        report.unresolvable.push(familyOf(at));
        report.bytes += at.toString().length;
        at.remove();
      }
    });

  const families = new Set<string>();
  for (const root of roots)
    root.walkAtRules(/^font-face$/i, (at) => {
      const f = familyOf(at);
      if (f) families.add(f);
    });
  if (!families.size) return { sheets: roots.map((r) => r.toString()), report };

  // Whole items of a font list (`"Used Quoted", serif`), including var()
  // fallbacks; a `font` shorthand's sizes end up in its first item's prefix.
  const used = new Set<string>();
  for (const root of roots)
    root.walkDecls((d) => {
      if (used.size === families.size) return false;
      const parent = d.parent;
      if (
        parent?.type === "atrule" &&
        /^font-face$/i.test((parent as AtRule).name)
      )
        return;
      if (!/^(font|font-family|--.*)$/i.test(d.prop)) return;
      for (const item of fontListItems(d.value)) {
        if (families.has(item)) used.add(item);
        else if (d.prop.toLowerCase() === "font")
          for (const f of families) if (item.endsWith(` ${f}`)) used.add(f);
      }
    });

  for (const root of roots)
    root.walkAtRules(/^font-face$/i, (at) => {
      const f = familyOf(at);
      if (!f || used.has(f)) return;
      if (!report.unused.includes(f)) report.unused.push(f);
      report.bytes += at.toString().length;
      at.remove();
    });
  return { sheets: roots.map((r) => r.toString()), report };
}

/** Font MIME types (and `format()` hints) → file extensions. */
const FONT_EXT: [RegExp, string][] = [
  [/woff2/i, "woff2"],
  [/woff/i, "woff"],
  [/(truetype|ttf|sfnt)/i, "ttf"],
  [/(opentype|otf)/i, "otf"],
  [/(embedded-opentype|eot|ms-fontobject)/i, "eot"],
  [/svg/i, "svg"],
];
const DATA_URL =
  /url\(\s*(["']?)(data:([^;,"')]*)((?:;[^,"')]*)*),([^"')]*))\1\s*\)/gi;

export interface FontFile {
  /** Content-addressed file name, e.g. `3f2a…c1.woff2`. */
  name: string;
  data: Uint8Array;
}

/**
 * Move `@font-face` data URIs into files, so browsers download only the faces
 * a page renders, once per site rather than inside the render-blocking
 * stylesheet. `url(...)` becomes `url("<base>/<hash>.<ext>")`.
 *
 * @param hash content hash for file names (node:crypto in the transformer)
 */
export function extractFontData(
  css: string,
  base: string,
  hash: (data: Uint8Array) => string,
): { css: string; files: FontFile[] } {
  const files = new Map<string, FontFile>();
  if (!/@font-face/i.test(css) || !/data:/i.test(css))
    return { css, files: [] };
  const root = parse(css);
  root.walkAtRules(/^font-face$/i, (at) => {
    at.walkDecls(/^src$/i, (d) => {
      d.value = splitSources(d.value)
        .map((src) =>
          src.replace(
            DATA_URL,
            (whole, _q, _url, mime: string, params: string, body: string) => {
              const ext =
                FONT_EXT.find(([re]) => re.test(mime))?.[1] ??
                FONT_EXT.find(([re]) =>
                  re.test(src.slice(src.indexOf(whole) + whole.length)),
                )?.[1];
              if (!ext) return whole;
              let data: Uint8Array;
              try {
                data = /;base64/i.test(params)
                  ? Buffer.from(body.replace(/\s+/g, ""), "base64")
                  : Buffer.from(decodeURIComponent(body));
              } catch {
                return whole; // malformed: leave it to the browser
              }
              const name = `${hash(data)}.${ext}`;
              if (!files.has(name)) files.set(name, { name, data });
              return `url("${base}/${name}")`;
            },
          ),
        )
        .join(", ");
    });
  });
  return { css: root.toString(), files: [...files.values()] };
}
