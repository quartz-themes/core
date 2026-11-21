import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { convertObsidianCss } from "../convert/convert";
import { resolveIcon } from "../convert/icons";
import { composeStylesheet } from "../convert/compose";

const conv = (css: string, opts = {}) =>
  convertObsidianCss(css, opts).css.replace(/\s+/g, " ").trim();

describe("selector rewriting", () => {
  test("mode classes become saved-theme with the same specificity", () => {
    assert.equal(
      conv(".theme-dark { --x: 1 }"),
      ':where(body):is([saved-theme="dark"] *) { --x: 1 }',
    );
    assert.equal(
      conv(".theme-light .markdown-rendered h1 { color: red }"),
      ':where(body):is([saved-theme="light"] *) .markdown-rendered h1 { color: red }',
    );
  });

  test("statically true body classes are padded, false ones dropped", () => {
    assert.equal(
      conv("body.css-settings-manager { --x: 1 }"),
      "body:not(.qt-0) { --x: 1 }",
    );
    assert.equal(conv(".is-mobile .markdown-rendered p { color: red }"), "");
    assert.equal(
      conv("body:not(.is-mobile) p { color: red }"),
      "body:not(.qt-0) p { color: red }",
    );
  });

  test("Style Settings classes follow the provided body state", () => {
    const css = ".my-toggle h1 { color: red } .my-other h1 { color: blue }";
    assert.equal(
      conv(css, { bodyClasses: { "my-toggle": true, "my-other": false } }),
      ":where(body):not(.qt-0) h1 { color: red }",
    );
  });

  test("workspace wrappers are elided as ancestors, kept specificity", () => {
    assert.equal(
      conv(
        ".workspace-leaf-content[data-type=markdown] .markdown-preview-view h2 { color: red }",
      ),
      ":not(.qt-0):not(.qt-0) .markdown-preview-view h2 { color: red }",
    );
  });

  test("editor-only and fully elided selectors are dropped", () => {
    assert.equal(conv(".cm-s-obsidian .cm-header { color: red }"), "");
    assert.equal(
      conv(".workspace .workspace-tab-container > * { position: sticky }"),
      "",
    );
    assert.equal(conv(".cm-line, p { color: red }"), "p { color: red }");
  });

  test("content wrappers map onto Quartz's content root, not any element", () => {
    assert.equal(
      conv(
        ".markdown-preview-view .markdown-preview-sizer > div { width: 1px }",
      ),
      ".markdown-preview-view:not(.qt-0)>:not(qt-0) { width: 1px }",
    );
    assert.equal(
      conv(".markdown-preview-section > div:has(img) { width: 1px }"),
      ":where(.markdown-preview-view):not(.qt-0)>:not(qt-0):has(img) { width: 1px }",
    );
    assert.equal(
      conv("div.markdown-preview-sizer > div::before { color: red }"),
      ":where(.markdown-preview-view):not(qt-0):not(.qt-0)>:not(qt-0)::before { color: red }",
    );
    // Obsidian's per-block wrapper div doesn't exist in Quartz.
    assert.equal(
      conv(".markdown-preview-section > div h1 { color: red }"),
      ":where(.markdown-preview-view):not(.qt-0):not(qt-0) h1 { color: red }",
    );
    assert.equal(
      conv(".markdown-preview-sizer > div > p { color: red }"),
      ":where(.markdown-preview-view):not(.qt-0):not(qt-0)>p { color: red }",
    );
  });

  test("children of other elided wrappers need a name of their own", () => {
    assert.equal(conv(".view-content > div { color: red }"), "");
    assert.equal(
      conv(".workspace > .workspace-split.mod-root hr { color: red }"),
      ":not(.qt-0)>:not(.qt-0):not(.qt-0) hr { color: red }",
    );
    assert.equal(
      conv(".markdown-reading-view > .markdown-preview-view { color: red }"),
      ":not(.qt-0)>.markdown-preview-view { color: red }",
    );
    assert.equal(
      conv("p:not(button) { color: red }"),
      "p:not(button) { color: red }",
    );
  });

  test("bare form controls don't reach Quartz chrome", () => {
    assert.equal(conv("button { display: inline-flex }"), "");
    assert.equal(
      conv(".theme-dark button:not(.clickable-icon):hover { color: red }"),
      "",
    );
    assert.equal(
      conv(".search button { color: red }"),
      ".search button { color: red }",
    );
    assert.equal(
      conv("input[type=checkbox]::after { color: red }"),
      "input[type=checkbox]:where(.markdown-rendered *)::after { color: red }",
    );
  });

  test("scrollbar rules stay off the viewport", () => {
    assert.equal(
      conv("::-webkit-scrollbar { width: 8px }"),
      ":where(:not(html, body))::-webkit-scrollbar { width: 8px }",
    );
    assert.equal(
      conv(":hover::-webkit-scrollbar-thumb { color: red }"),
      ":hover:where(:not(html, body))::-webkit-scrollbar-thumb { color: red }",
    );
    assert.equal(conv("body::-webkit-scrollbar { width: 8px }"), "");
    assert.equal(
      conv("body ::-webkit-scrollbar { width: 8px }"),
      "body ::-webkit-scrollbar { width: 8px }",
    );
  });

  test("element rewrites: mark → text-highlight", () => {
    assert.equal(
      conv("mark { background: yellow }"),
      ":where(mark, .text-highlight):not(qt-0) { background: yellow }",
    );
    assert.equal(
      conv("blockquote { border-left: 2px solid }"),
      "blockquote { border-left: 2px solid }",
      "callouts are <div> in Quartz 5.2",
    );
    assert.equal(
      conv("a.tag { color: red }"),
      "a.tag { color: red }",
      "Quartz 5.2 renders Obsidian's tag class",
    );
  });

  test("layout guard strips page layout from structural selectors only", () => {
    assert.equal(
      conv("body, .foo { overflow: hidden; color: red }"),
      ".foo { overflow: hidden; color: red } body { color: red }",
    );
    assert.equal(conv("html, body { height: 100% }"), "");
  });
});

describe("robustness", () => {
  test("recovers from syntax errors like a browser", () => {
    // Per the CSS Syntax spec a stray `}` joins the next rule's prelude
    // (`} .a`, an invalid selector the browser drops — here: quarantined, so the
    // browser still decides); later rules survive and an unclosed block at EOF
    // is closed.
    const res = convertObsidianCss(
      "p { color: red; } } .a { color: blue } .b { color: green",
    );
    assert.equal(res.stats.repaired, "css-tree");
    assert.match(res.css, /p \{\s*color: red/);
    assert.doesNotMatch(res.css, /color: blue/);
    assert.match(res.quarantine, /\} \.a/);
    assert.match(res.css, /\.b \{\s*color: green/);
  });

  test("a missing semicolon stays one declaration, as in the browser", () => {
    const res = convertObsidianCss(
      ".x { background: var(--x) border: 1px solid red; color: red } }",
    );
    assert.match(
      res.css + res.quarantine,
      /background: var\(--x\) border: 1px solid red/,
    );
    assert.match(res.css + res.quarantine, /color: red/);
  });

  test("quarantines rules Quartz's minifier rejects", () => {
    const res = convertObsidianCss(
      "p { color: red } p:nth-child(foo) { height: 4px }",
    );
    assert.match(res.css, /p \{/);
    assert.equal(res.stats.quarantined, 1);
    assert.match(res.quarantine, /nth-child\(foo\)/);
  });
});

describe("icons", () => {
  test("resolves current and legacy lucide ids", () => {
    assert.match(
      resolveIcon("lucide-flame") ?? "",
      /^url\("data:image\/svg\+xml/,
    );
    assert.ok(resolveIcon("alert-triangle"), "legacy alias");
    assert.equal(resolveIcon("definitely-not-an-icon"), undefined);
  });

  test("rewrites --callout-icon ids to data URIs", () => {
    const out = conv(
      '.callout[data-callout="note"] { --callout-icon: lucide-flame }',
      { resolveIcon },
    );
    assert.match(out, /--callout-icon: url\("data:image\/svg\+xml/);
  });
});

describe("compose", () => {
  test("hoists @import with semicolons inside the URL intact", () => {
    const url =
      "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@0,400;0,700&display=swap');";
    const { main } = composeStylesheet({
      app: "",
      theme: `${url}\nbody { color: red }`,
    });
    assert.ok(main.startsWith(url), main.slice(0, 120));
    assert.match(main, /@layer obsidian \{[\s\S]*body \{ color: red \}/);
  });
});
