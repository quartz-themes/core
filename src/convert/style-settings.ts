/**
 * Style Settings support, mirroring obsidian-style-settings' runtime:
 *
 *  - `@settings` YAML blocks are parsed from the theme CSS (same regex and
 *    tab handling as the plugin).
 *  - Class toggles / class selects become body classes: the plugin adds a
 *    toggle's class when the setting is true (or unset with `default: true`),
 *    and a select's value (or default) unless it is "none". Every class a
 *    theme declares is therefore *known* — absent ones are statically false.
 *  - Variable settings produce the same CSS the plugin injects, for keys the
 *    user set (defaults live in the theme CSS):
 *      body.css-settings-manager { … }
 *      body.theme-light.css-settings-manager { … }
 *      body.theme-dark.css-settings-manager { … }
 *    That CSS is Obsidian CSS, so it goes through the same converter.
 *
 * User settings use the plugin's export format: { "section@@setting": value,
 * "section@@setting@@light": "#fff", … }.
 */
import yaml from "js-yaml";

/** A Style Settings export: { "section@@setting": value, "section@@setting@@light": "#fff" }. */
export type StyleSettingsExport = Record<string, unknown>;

export interface StyleSettingDef {
  id: string;
  type: string;
  default?: unknown;
  "default-light"?: string;
  "default-dark"?: string;
  format?: string;
  quotes?: boolean;
  opacity?: boolean;
  "alt-format"?: { id: string; format: string }[];
  options?: (string | { label?: string; value: string })[];
  [key: string]: unknown;
}

export interface StyleSettingsSection {
  id: string;
  name?: string;
  settings: StyleSettingDef[];
}

export interface ResolvedStyleSettings {
  bodyClasses: Record<string, boolean>;
  css: string;
  applied: string[];
  unknown: string[];
}

const SETTINGS_RE = /\/\*!?\s*@settings[\r\n]+?([\s\S]+?)\*\//g;

/**
 * The plugin replaces tabs with the block's indent as `detect-indent` (7)
 * finds it, when that's spaces, else with 4 spaces. detect-indent takes the
 * most frequent change in indentation between lines, not the smallest indent:
 * Micro Mike's block indents with tabs and has a few 4-space steps at 12+.
 */
function detectIndent(src: string): { type?: "s" | "t"; amount: number } {
  const count = (ignoreSingleSpaces: boolean) => {
    const used = new Map<string | undefined, [number, number]>();
    let prevAmount = 0;
    let prevType: string | undefined;
    let key: string | undefined;
    for (const line of src.split(/\n/g)) {
      if (!line) continue;
      const m = /^(?:( )+|\t+)/.exec(line);
      if (m === null) {
        prevAmount = 0;
        prevType = "";
        continue;
      }
      const amount = m[0].length;
      const type = m[1] ? "s" : "t";
      if (ignoreSingleSpaces && type === "s" && amount === 1) continue;
      if (type !== prevType) prevAmount = 0;
      prevType = type;
      let weight = 0;
      const diff = amount - prevAmount;
      prevAmount = amount;
      if (diff === 0) weight++;
      else key = type + String(Math.abs(diff));
      const e = used.get(key);
      used.set(key, e === undefined ? [1, 0] : [e[0] + 1, e[1] + weight]);
    }
    return used;
  };
  let used = count(true);
  if (used.size === 0) used = count(false);
  let best: string | undefined;
  let max = 0;
  let maxWeight = 0;
  for (const [k, [n, w]] of used)
    if (n > max || (n === max && w > maxWeight)) {
      max = n;
      maxWeight = w;
      best = k;
    }
  if (best === undefined) return { amount: 0 };
  return { type: best[0] as "s" | "t", amount: Number(best.slice(1)) };
}

function detabbed(src: string): string {
  const { type, amount } = detectIndent(src);
  return src.replace(
    /\t/g,
    type === "s" && amount ? " ".repeat(amount) : "    ",
  );
}

export function parseStyleSettings(css: string): {
  sections: StyleSettingsSection[];
  errors: string[];
} {
  const sections: StyleSettingsSection[] = [];
  const errors: string[] = [];
  for (const m of css.matchAll(SETTINGS_RE)) {
    try {
      const doc = yaml.load(
        detabbed(m[1]!.trim()),
      ) as Partial<StyleSettingsSection> | null;
      if (
        doc &&
        typeof doc === "object" &&
        doc.id &&
        Array.isArray(doc.settings) &&
        doc.settings.length
      )
        sections.push(doc as StyleSettingsSection);
    } catch (e) {
      errors.push(String((e as Error).message ?? e).split("\n")[0]!);
    }
  }
  return { sections, errors };
}

const optionValue = (o: string | { value: string } | undefined) =>
  typeof o === "string" ? o : o?.value;

const nonEmpty = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

/** Option values as the plugin normalises them; malformed options are left out. */
function validOptions(options: StyleSettingDef["options"]): string[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((o) =>
    nonEmpty(o)
      ? [o]
      : o && typeof o === "object" && nonEmpty(o.label) && nonEmpty(o.value)
        ? [o.value]
        : [],
  );
}

export function resolveStyleSettings(
  sections: StyleSettingsSection[],
  user: StyleSettingsExport = {},
): ResolvedStyleSettings {
  const config: Record<string, Record<string, StyleSettingDef>> = {};
  // The plugin keeps the first section with an id, and within a section the
  // first valid setting with an id (Baseline's "Colorful headings" heading
  // shadows the class-select after it, whose classes Obsidian never applies).
  const sectionIds = new Set<string>();
  for (const s of sections) {
    if (sectionIds.has(s.id)) continue;
    sectionIds.add(s.id);
    for (const st of s.settings) {
      if (!st?.id || config[s.id]?.[st.id]) continue;
      if (st.type === "class-select" || st.type === "variable-select") {
        // The plugin (1.0.9) only accepts non-empty string options, or objects
        // with non-empty string label and value; a select without any is
        // dropped whole (AnuPpuccin's numeric `value: 100` weights).
        const options = validOptions(st.options);
        if (!options.length) continue;
        (config[s.id] ??= {})[st.id] = { ...st, options };
      } else (config[s.id] ??= {})[st.id] = st;
    }
  }
  const get = (sec: string, id: string) => user[`${sec}@@${id}`];

  // --- classes (initClasses) ---
  const bodyClasses: Record<string, boolean> = {};
  for (const [sec, settings] of Object.entries(config)) {
    for (const [id, st] of Object.entries(settings)) {
      if (st.type === "class-toggle") {
        const v = get(sec, id);
        bodyClasses[st.id] =
          v === true || (v === undefined && st.default === true);
      } else if (st.type === "class-select") {
        for (const o of st.options ?? []) {
          const val = optionValue(o as string | { value: string });
          if (val && val !== "none") bodyClasses[val] ??= false;
        }
        let v = get(sec, id);
        if (v === undefined) v = st.default ?? "none";
        if (typeof v === "string" && v && v !== "none") bodyClasses[v] = true;
      }
    }
  }

  // --- variables (gl) ---
  const general: [string, string][] = [];
  const light: [string, string][] = [];
  const dark: [string, string][] = [];
  const applied: string[] = [];
  const unknown: string[] = [];
  for (const [key, raw] of Object.entries(user)) {
    const [sec = "", id = "", variant] = key.split("@@");
    const st = config[sec]?.[id];
    if (!st) {
      unknown.push(key);
      continue;
    }
    switch (st.type) {
      case "variable-number":
      case "variable-number-slider":
        general.push([st.id, `${String(raw ?? st.default)}${st.format ?? ""}`]);
        break;
      case "variable-text":
      case "variable-select": {
        let v = String(raw ?? st.default);
        if (st.quotes) v = v !== '""' ? `'${v}'` : "";
        general.push([st.id, v]);
        break;
      }
      case "variable-color": {
        const v = String(raw ?? st.default ?? "");
        if (v)
          general.push(
            ...colorEntries(st.id, st.format, v, st.opacity, st["alt-format"]),
          );
        break;
      }
      case "variable-themed-color": {
        const v = String(
          raw ??
            st[variant === "light" ? "default-light" : "default-dark"] ??
            "",
        );
        if (v)
          (variant === "light" ? light : dark).push(
            ...colorEntries(st.id, st.format, v, st.opacity, st["alt-format"]),
          );
        break;
      }
      default:
        continue; // class settings handled above; color-gradient not yet supported
    }
    applied.push(key);
  }
  // An id that isn't a valid custom property name (Minimal's
  // `cards-background-hover (hover)`) makes an invalid declaration: the browser
  // drops just that line, but Quartz's minifier rejects the whole block.
  const validName = (k: string) => /^[\w-]+$/.test(k);
  const block = (sel: string, entries: [string, string][]) => {
    const valid = entries.filter(([k]) => validName(k));
    return valid.length
      ? `${sel} {\n${valid.map(([k, v]) => `  --${k}: ${v};`).join("\n")}\n}\n`
      : "";
  };
  const css =
    block("body.css-settings-manager", general) +
    block("body.theme-light.css-settings-manager", light) +
    block("body.theme-dark.css-settings-manager", dark);
  return { bodyClasses, css, applied, unknown };
}

// --- colour formats (St) ---------------------------------------------------

function colorEntries(
  id: string,
  format: string | undefined,
  value: string,
  opacity: boolean | undefined,
  alt: { id: string; format: string }[] = [],
): [string, string][] {
  const c = parseColor(value);
  const extra = (alt ?? []).flatMap((a) =>
    colorEntries(a.id, a.format, value, opacity),
  );
  if (!c) return [[id, value], ...extra];
  const { h, s, l } = rgbToHsl(c);
  const a = c.a;
  switch (format) {
    case "hex":
      return [[id, value], ...extra];
    case "hsl":
      return [
        [
          id,
          a < 1
            ? `hsla(${fmt(h)},${fmt(s * 100)}%,${fmt(l * 100)}%,${a})`
            : `hsl(${fmt(h)},${fmt(s * 100)}%,${fmt(l * 100)}%)`,
        ],
        ...extra,
      ];
    case "hsl-values":
      return [
        [id, `${h},${s * 100}%,${l * 100}%${opacity ? `,${a}` : ""}`],
        ...extra,
      ];
    case "hsl-split":
      return [
        [`${id}-h`, String(h)],
        [`${id}-s`, `${s * 100}%`],
        [`${id}-l`, `${l * 100}%`],
        ...extra,
        ...(opacity ? [[`${id}-a`, String(a)] as [string, string]] : []),
      ];
    case "hsl-split-decimal":
      return [
        [`${id}-h`, String(h)],
        [`${id}-s`, String(s)],
        [`${id}-l`, String(l)],
        ...extra,
        ...(opacity ? [[`${id}-a`, String(a)] as [string, string]] : []),
      ];
    case "rgb":
      return [
        [
          id,
          a < 1
            ? `rgba(${c.r},${c.g},${c.b},${a})`
            : `rgb(${c.r},${c.g},${c.b})`,
        ],
        ...extra,
      ];
    case "rgb-values":
      return [[id, `${c.r},${c.g},${c.b}${opacity ? `,${a}` : ""}`], ...extra];
    case "rgb-split":
      return [
        [`${id}-r`, String(c.r)],
        [`${id}-g`, String(c.g)],
        [`${id}-b`, String(c.b)],
        ...extra,
        ...(opacity ? [[`${id}-a`, String(a)] as [string, string]] : []),
      ];
    default:
      return [[id, value], ...extra];
  }
}

const fmt = (n: number) => +n.toFixed(2);

export function parseColor(
  v: string,
): { r: number; g: number; b: number; a: number } | null {
  v = v.trim();
  let m = v.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let hex = m[1]!;
    if (hex.length <= 4) hex = [...hex].map((ch) => ch + ch).join("");
    const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
    return {
      r: n(0),
      g: n(2),
      b: n(4),
      a: hex.length === 8 ? +(n(6) / 255).toFixed(3) : 1,
    };
  }
  m = v.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1]!.split(/[\s,/]+/).filter(Boolean) as string[];
    return {
      r: Math.round(+p[0]!),
      g: Math.round(+p[1]!),
      b: Math.round(+p[2]!),
      a:
        p[3] !== undefined
          ? parseFloat(p[3]) / (p[3].endsWith("%") ? 100 : 1)
          : 1,
    };
  }
  m = v.match(/^hsla?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1]!.split(/[\s,/]+/).filter(Boolean) as string[];
    const h = parseFloat(p[0]!);
    const s = parseFloat(p[1]!) / 100;
    const l = parseFloat(p[2]!) / 100;
    const k = (n: number) => (n + h / 30) % 12;
    const f = (n: number) =>
      l -
      s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return {
      r: Math.round(f(0) * 255),
      g: Math.round(f(8) * 255),
      b: Math.round(f(4) * 255),
      a: p[3] !== undefined ? parseFloat(p[3]) : 1,
    };
  }
  return null;
}

function rgbToHsl({ r, g, b }: { r: number; g: number; b: number }) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r
      ? (g - b) / d + (g < b ? 6 : 0)
      : max === g
        ? (b - r) / d + 2
        : (r - g) / d + 4;
  return { h: h * 60, s, l };
}
