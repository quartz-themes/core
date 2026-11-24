import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseStyleSettings,
  resolveStyleSettings,
} from "../convert/style-settings";

const THEME = `
/* @settings
name: Demo
id: demo
settings:
\t- id: toggle-on
\t  type: class-toggle
\t  default: true
\t- id: toggle-off
\t  type: class-toggle
\t- id: flavour
\t  type: class-select
\t  default: demo-mocha
\t  options:
\t    - demo-latte
\t    - value: demo-mocha
\t      label: Mocha
\t- id: accent
\t  type: variable-themed-color
\t  format: hsl-split
\t  default-light: '#'
\t  default-dark: '#'
\t- id: radius
\t  type: variable-number
\t  default: 4
\t  format: px
\t- id: font
\t  type: variable-text
\t  quotes: true
\t  default: Inter
*/
body { --x: 1 }
`;

describe("parse", () => {
  test("parses tab-indented @settings blocks like the plugin", () => {
    const { sections, errors } = parseStyleSettings(THEME);
    assert.deepEqual(errors, []);
    assert.equal(sections[0]?.id, "demo");
    assert.equal(sections[0]?.settings.length, 6);
  });

  test("tabs mixed with a few space-indented lines (Micro Mike)", () => {
    const block = [
      "/* @settings",
      "name: Mixed",
      "id: mixed",
      "settings:",
      "\t-",
      "\t\tid: palette",
      "\t\ttype: class-select",
      "\t\tdefault: b",
      "\t\toptions:",
      "\t\t\t- a",
      "\t\t\t- b",
      "\t-",
      "\t\tid: align",
      "\t\ttype: class-select",
      "\t\tdefault: c",
      "\t\toptions:",
      "\t\t\t- ",
      "                label: C",
      "                value: c",
      "            - ",
      "                label: D",
      "                value: d",
      "*/",
    ].join("\n");
    const { sections, errors } = parseStyleSettings(block);
    assert.deepEqual(errors, []);
    assert.equal(sections[0]?.settings.length, 2);
  });
});

describe("resolve", () => {
  const { sections } = parseStyleSettings(THEME);

  test("defaults become body classes; every declared class is known", () => {
    const { bodyClasses, css } = resolveStyleSettings(sections);
    assert.deepEqual(bodyClasses, {
      "toggle-on": true,
      "toggle-off": false,
      "demo-latte": false,
      "demo-mocha": true,
    });
    assert.equal(css, "", "defaults live in the theme CSS; nothing is emitted");
  });

  test("the first setting with an id wins, as in the plugin", () => {
    // Baseline: a heading and a class-select share `colorful-headings`.
    const { bodyClasses } = resolveStyleSettings(
      [
        {
          id: "s",
          name: "S",
          settings: [
            { id: "dup", title: "Heading", type: "heading", level: 3 },
            {
              id: "dup",
              title: "Select",
              type: "class-select",
              default: "dup-off",
              options: ["dup-off", "dup-side"],
            },
          ],
        },
      ] as never,
      { "s@@dup": "dup-side" },
    );
    assert.equal(bodyClasses["dup-side"], undefined);
    assert.equal(bodyClasses["dup-off"], undefined);
  });

  test("user values override classes and emit the plugin's CSS", () => {
    const { bodyClasses, css, unknown } = resolveStyleSettings(sections, {
      "demo@@toggle-on": false,
      "demo@@flavour": "demo-latte",
      "demo@@accent@@dark": "#ff0000",
      "demo@@radius": 12,
      "demo@@font": "Fira Sans",
      "demo@@nope": 1,
    });
    assert.equal(bodyClasses["toggle-on"], false);
    assert.equal(bodyClasses["demo-latte"], true);
    assert.equal(bodyClasses["demo-mocha"], false);
    assert.match(
      css,
      /body\.css-settings-manager \{\s+--radius: 12px;\s+--font: 'Fira Sans';/,
    );
    assert.match(
      css,
      /body\.theme-dark\.css-settings-manager \{\s+--accent-h: 0;\s+--accent-s: 100%;\s+--accent-l: 50%;/,
    );
    assert.deepEqual(unknown, ["demo@@nope"]);
  });
});

describe("invalid setting ids", () => {
  // Minimal declares `cards-background-hover (hover)`: Style Settings writes it
  // as is, the browser drops that one declaration, and Quartz's minifier would
  // reject the whole block (every other colour with it).
  const ODD = `
/* @settings
name: Odd
id: odd
settings:
\t- id: good
\t  type: variable-themed-color
\t  format: hex
\t  default-light: '#'
\t  default-dark: '#'
\t- id: bad (hover)
\t  type: variable-themed-color
\t  format: hex
\t  default-light: '#'
\t  default-dark: '#'
*/
`;
  test("only the invalid declaration is left out", () => {
    const { sections } = parseStyleSettings(ODD);
    const { css } = resolveStyleSettings(sections, {
      "odd@@good@@dark": "#123456",
      "odd@@bad (hover)@@dark": "#654321",
    });
    assert.match(css, /--good: #123456;/);
    assert.doesNotMatch(css, /bad|#654321/);
  });
});

describe("malformed select options", () => {
  // AnuPpuccin: `value: 100` is a number; Style Settings 1.0.9 drops options
  // that aren't non-empty strings, and a select without valid options entirely.
  const SEL = `
/* @settings
name: Sel
id: sel
settings:
\t- id: weight
\t  type: variable-select
\t  default: '400'
\t  options:
\t    - label: Light
\t      value: 100
\t    - label: Bold
\t      value: 700
\t- id: font
\t  type: variable-select
\t  default: a
\t  options:
\t    - a
\t    - b
*/
`;
  test("a select with no valid options doesn't apply", () => {
    const { sections } = parseStyleSettings(SEL);
    const { css, unknown } = resolveStyleSettings(sections, {
      "sel@@weight": 100,
      "sel@@font": "b",
    });
    assert.doesNotMatch(css, /--weight/);
    assert.match(css, /--font: b;/);
    assert.deepEqual(unknown, ["sel@@weight"]);
  });
});
