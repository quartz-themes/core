import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QuartzTheme } from "../transformer";

function localTheme(css: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qt-transformer-"));
  fs.writeFileSync(path.join(dir, "theme.css"), css);
  return dir;
}

const THEME = `
/* @settings
name: Demo
id: demo
settings:
  - id: big-h1
    type: class-toggle
*/
.theme-dark { --h1-color: #ff757f; --font-text-theme: "Inter"; }
.big-h1 h1 { font-size: 3.33em }
.cm-line { color: red }
`;

describe("QuartzTheme", () => {
  test("is an async factory producing layered, converted CSS", async () => {
    const plugin = await QuartzTheme({
      theme: localTheme(THEME),
      mode: "both",
    });
    const res = plugin.externalResources!({} as never);
    const main = String(
      (res as { css: { content: string }[] }).css[0]!.content,
    );
    assert.match(main, /^@layer quartz-base, obsidian;/m);
    assert.match(
      main,
      /:where\(body\):is\(\[saved-theme="dark"\] \*\) \{\s*--h1-color: #ff757f;/,
    );
    assert.doesNotMatch(
      main,
      /\.cm-line \{ color: red/,
      "editor rules are dropped",
    );
    assert.doesNotMatch(
      main,
      /3\.33em/,
      "disabled Style Settings toggles are statically false",
    );
    assert.match(
      main,
      /:where\(figure\[data-rehype-pretty-code-figure\]\) \{\s*margin: 0;/,
      "the content reset doesn't give code blocks the UA's figure margins",
    );
  });

  test("applies Style Settings from options", async () => {
    const plugin = await QuartzTheme({
      theme: localTheme(THEME),
      mode: "both",
      styleSettings: { "demo@@big-h1": true },
    });
    const main = String(
      (plugin.externalResources!({} as never) as { css: { content: string }[] })
        .css[0]!.content,
    );
    assert.match(
      main,
      /:where\(body\):not\(\.qt-0\) h1:where\(\.markdown-rendered \*\) \{\s*font-size: 3\.33em/,
    );
  });

  test("single mode hides the toggle and pins saved-theme", async () => {
    const plugin = await QuartzTheme({
      theme: localTheme(THEME),
      mode: "dark",
    });
    const res = plugin.externalResources!({} as never) as {
      css: { content: string }[];
      js: { script: string }[];
    };
    assert.ok(
      res.css.some((c) =>
        c.content.includes("button.darkmode { display: none"),
      ),
    );
    assert.match(res.js[0]!.script, /saved-theme", "dark"/);
  });

  test("shares the theme's fonts with other plugins", async () => {
    await QuartzTheme({ theme: localTheme(THEME), mode: "both" });
    const fonts = (
      globalThis as { __quartzFonts?: { fonts: Record<string, string> } }
    ).__quartzFonts;
    assert.equal(fonts?.fonts["--font-text-theme"], '"Inter"');
  });

  test("ships embedded fonts as files, not inside the stylesheet", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "qt-cache-"));
    const woff2 = Buffer.from("wOF2 not really a font").toString("base64");
    const plugin = await QuartzTheme({
      theme: localTheme(
        `@font-face { font-family: Embedded; src: url(data:font/woff2;base64,${woff2}) format("woff2"); }
body { --font-text-theme: Embedded; }`,
      ),
      mode: "both",
      cacheDir,
    });
    const res = plugin.externalResources!({} as never) as {
      css: { content: string }[];
      assets?: { from: string; to: string }[];
    };
    const main = res.css[0]!.content;
    assert.doesNotMatch(main, /data:font/);
    const m = main.match(
      /url\("plugins\/(quartz-themes\/fonts\/[0-9a-f]{20}\.woff2)"\) format\("woff2"\)/,
    );
    assert.ok(m, "the source points at the shipped file");
    assert.equal(res.assets?.length, 1);
    assert.equal(res.assets![0]!.to, m![1]);
    assert.equal(
      fs.readFileSync(res.assets![0]!.from, "utf8"),
      "wOF2 not really a font",
    );
  });
});
