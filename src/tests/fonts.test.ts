import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { convertTheme } from "../convert";
import { extractFontData, pruneFonts } from "../convert/fonts";

const face = (family: string, src: string) =>
  `@font-face { font-family: ${family}; src: ${src}; }`;
const families = (css: string) =>
  [...css.matchAll(/font-family:\s*([^;]+);/g)]
    .map((m) => m[1]!.trim())
    .filter((_, i, a) => a.indexOf(_) === i);
// app.css's src-less "??" placeholder face is always kept.
const faces = (css: string) =>
  [...css.matchAll(/@font-face\s*\{[^}]*font-family:\s*([^;]+);/g)]
    .map((m) => m[1]!.trim())
    .filter((f) => f !== '"??"');

describe("theme fonts", () => {
  test("unused families are pruned; used ones stay however they're named", () => {
    const css = [
      face('"Used Quoted"', 'url("data:font/woff2;base64,AAAA")'),
      face("UsedVar", "url(https://example.com/a.woff2)"),
      face("Shorthand", "url(data:font/woff2;base64,BBBB)"),
      face("Unused", "url(data:font/woff2;base64,CCCC)"),
      face("Used", "url(data:font/woff2;base64,DDDD)"), // prefix of "Used Quoted"
      "body { --font-text-theme: UsedVar, sans-serif; }",
      'p { font-family: "Used Quoted", serif; }',
      "h1 { font: 700 2em/1.2 Shorthand; }",
    ].join("\n");
    const { sheets, report } = pruneFonts([css, ""]);
    assert.deepEqual(faces(sheets[0]!), [
      '"Used Quoted"',
      "UsedVar",
      "Shorthand",
    ]);
    assert.deepEqual(report.unused.sort(), ["unused", "used"]);
    assert.ok(report.bytes > 0);
  });

  test("relative sources can't load on a Quartz site and are dropped", () => {
    const css = [
      face("Gone", 'url("public/fonts/x.woff2") format("woff2")'),
      face(
        "Mixed",
        'url(fonts/y.woff2) format("woff2"), url(data:font/woff;base64,EEEE) format("woff")',
      ),
      face("Local", 'local("Mixed"), url(./z.ttf)'),
      "p { font-family: Gone, Mixed, Local; }",
    ].join("\n");
    const { sheets, report } = pruneFonts([css]);
    assert.deepEqual(faces(sheets[0]!), ["Mixed", "Local"]);
    assert.match(
      sheets[0]!,
      /src: url\(data:font\/woff;base64,EEEE\) format\("woff"\);/,
    );
    assert.match(sheets[0]!, /src: local\("Mixed"\);/);
    assert.deepEqual(report.unresolvable, ["gone"]);
  });

  test("a font only a disabled Style Settings option uses is pruned", () => {
    const themeCss = `
/* @settings
name: Demo
id: demo
settings:
\t- id: demo-serif
\t  type: class-toggle
*/
${face("DemoSerif", "url(data:font/woff2;base64,FFFF)")}
${face("DemoSans", "url(data:font/woff2;base64,GGGG)")}
body { --font-text-theme: DemoSans; }
body.demo-serif { --font-text-theme: DemoSerif; }
`;
    const off = convertTheme({ themeCss });
    assert.deepEqual(faces(off.main), ["DemoSans"]);
    assert.deepEqual(off.report.fonts.unused, ["demoserif"]);
    const on = convertTheme({
      themeCss,
      styleSettings: { "demo@@demo-serif": true },
    });
    assert.deepEqual(faces(on.main), ["DemoSerif", "DemoSans"]);
  });

  test("data URIs become content-addressed files", () => {
    const b64 = Buffer.from("font-bytes").toString("base64");
    const css = [
      face("A", `url("data:font/woff2;base64,${b64}") format("woff2")`),
      face(
        "B",
        `url(data:application/octet-stream;base64,${b64}) format("woff2"), local(B)`,
      ),
      face(
        "C",
        `url(data:application/x-font-ttf;charset=utf-8;base64,${Buffer.from("ttf").toString("base64")})`,
      ),
      face("D", "url(data:image/png;base64,AAAA)"),
      "div { background: url(data:font/woff2;base64,AAAA) }",
    ].join("\n");
    const out = extractFontData(css, "fonts", (d) =>
      Buffer.from(d).toString("hex"),
    );
    const hex = Buffer.from("font-bytes").toString("hex");
    assert.deepEqual(
      out.files.map((f) => f.name),
      [`${hex}.woff2`, `${Buffer.from("ttf").toString("hex")}.ttf`],
    );
    assert.match(
      out.css,
      new RegExp(`src: url\\("fonts/${hex}.woff2"\\) format\\("woff2"\\);`),
    );
    assert.match(
      out.css,
      new RegExp(
        `src: url\\("fonts/${hex}.woff2"\\) format\\("woff2"\\), local\\(B\\);`,
      ),
    );
    // Not a font type, and not in @font-face: left alone.
    assert.match(out.css, /url\(data:image\/png;base64,AAAA\)/);
    assert.match(out.css, /background: url\(data:font\/woff2;base64,AAAA\)/);
  });

  test("themeFonts: false uses the site's Quartz fonts", () => {
    const themeCss = `
@import url("https://fonts.googleapis.com/css2?family=Lora");
${face("Lora", "url(data:font/woff2;base64,HHHH)")}
body { --font-text-theme: Lora; --h1-font: Lora; --h1-color: red; }
.markdown-rendered p { font-family: Lora; color: blue; }
`;
    const out = convertTheme({ themeCss, themeFonts: false });
    assert.doesNotMatch(out.main, /Lora/);
    assert.match(out.main, /--h1-color: red/);
    assert.match(out.main, /color: blue/);
    assert.match(out.main, /--font-text-override: var\(--bodyFont\);/);
    assert.match(out.main, /--font-monospace-override: var\(--codeFont\);/);
    assert.match(out.main, /--h1-font: var\(--headerFont\);/);
    // The bridge no longer points Quartz's fonts at Obsidian's: no cycle. Its
    // colours stay.
    assert.match(
      out.main,
      /:where\(body, #quartz-root, \.center\) \{\n {2}--light: var\(--background-primary\);[^}]*\n {2}--textHighlight: var\(--text-highlight-bg\);\n\}/,
    );
    assert.doesNotMatch(out.main, /--bodyFont: var\(--font-text\)/);
    // Obsidian's own font stack (app.css) is untouched.
    assert.match(out.main, /--font-text: var\(--font-text-override\)/);
    assert.deepEqual(
      families(convertTheme({ themeCss }).main).includes("Lora"),
      true,
    );
  });
});
