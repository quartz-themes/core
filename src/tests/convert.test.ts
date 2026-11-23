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
      ":where(body):not(.qt-0) h1:where(.markdown-rendered *) { color: red }",
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
    // Single-colon pseudo-elements too: `:checked:after:where(…)` is invalid
    // and dropped the rule (Obsidian's checkmark).
    assert.equal(
      conv("input[type=checkbox]:checked:after { content: '' }"),
      "input[type=checkbox]:checked:where(.markdown-rendered *):after { content: '' }",
    );
  });

  test("properties rules scoped to the reading view reach Quartz's properties block", () => {
    // Quartz renders properties above the note, outside .markdown-preview-view.
    assert.equal(
      conv(".markdown-preview-view .metadata-container { background: red }"),
      ":not(.qt-0) .metadata-container { background: red }",
    );
    assert.equal(
      conv(
        ".theme-dark .markdown-rendered.is-readable .metadata-property-key { color: red }",
      ),
      ':where(body):is([saved-theme="dark"] *) :not(.qt-0).is-readable .metadata-property-key { color: red }',
    );
    // Unscoped and unrelated rules are untouched.
    assert.equal(
      conv(".metadata-container { background: red }"),
      ".metadata-container { background: red }",
    );
  });

  test("bare list and link rules style notes, not Quartz's explorer or table of contents", () => {
    // Blue Topaz: meant for note lists; Quartz's explorer is `ul > li`.
    assert.equal(
      conv(
        "body:not(.x) ul > li:not(.task-list-item) { border-left: none !important }",
      ),
      "body:not(.x) ul>li:not(.task-list-item):where(.markdown-rendered *) { border-left: none !important }",
    );
    assert.equal(
      conv("ol li::marker { color: red }"),
      "ol li:where(.markdown-rendered *)::marker { color: red }",
    );
    assert.equal(
      conv("a { color: var(--link-color) }"),
      "a:where(.markdown-rendered *) { color: var(--link-color) }",
    );
    // Named ancestors are specific enough already.
    assert.equal(
      conv(".callout ul { margin: 0 }"),
      ".callout ul { margin: 0 }",
    );
  });

  test("bare headings style notes, not Quartz's chrome headings", () => {
    assert.equal(
      conv("h2 { color: var(--h2-color) }"),
      "h2:where(.markdown-rendered *) { color: var(--h2-color) }",
    );
    assert.equal(
      conv(".theme-dark h3::before { content: '#' }"),
      ":where(body):is([saved-theme=\"dark\"] *) h3:where(.markdown-rendered *)::before { content: '#' }",
    );
    assert.equal(
      conv(".markdown-rendered h2 { color: red }"),
      ".markdown-rendered h2 { color: red }",
    );
  });

  test("code blocks: Obsidian's language classes, Quartz's figures", () => {
    assert.equal(
      conv('pre[class*="language-"] { padding: 1em }'),
      "pre[data-language] { padding: 1em }",
    );
    assert.equal(
      conv(
        '.markdown-rendered pre:not([class*="language-"]) { width: fit-content }',
      ),
      ".markdown-rendered pre:not([data-language]) { width: fit-content }",
    );
    assert.equal(
      conv("code.language-js { color: red }"),
      'code[data-language="js"] { color: red }',
    );
    assert.equal(
      conv("figure { margin: 1em 40px }"),
      "figure:where(:not([data-rehype-pretty-code-figure])) { margin: 1em 40px }",
    );
  });

  test("Obsidian wrappers as subjects stay dropped, even with a type", () => {
    assert.equal(
      conv(
        ".mod-vertical > .workspace-tab-container > div.workspace-leaf { min-width: 50vw }",
      ),
      "",
    );
    // The block wrapper's siblings are block wrappers too.
    assert.equal(
      conv(".markdown-preview-sizer > :nth-child(2) ~ div { margin-top: 0 }"),
      ":where(.markdown-preview-view):not(.qt-0)>:nth-child(2)~:not(qt-0) { margin-top: 0 }",
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

  test("the content root keeps Quartz's gutters and page scrolling", () => {
    assert.equal(
      conv(
        ".markdown-preview-view { padding: var(--file-margins); overflow-y: auto; scrollbar-gutter: stable; width: 100% }",
      ),
      ".markdown-preview-view { width: 100% }",
    );
    assert.equal(
      conv(
        ".markdown-preview-view.is-readable-line-width, .callout { padding-inline: 2em; padding-top: 1em; color: red }",
      ),
      ".callout { padding-inline: 2em; padding-top: 1em; color: red } .markdown-preview-view:not(.qt-0) { color: red }",
    );
    // Descendants keep theirs.
    assert.equal(
      conv(".markdown-preview-view p { padding: 1em; overflow: auto }"),
      ".markdown-preview-view p { padding: 1em; overflow: auto }",
    );
    // Both guards on one rule.
    assert.equal(
      conv(
        "body, .markdown-preview-view { padding: 1em; overflow: hidden; color: red }",
      ),
      ".markdown-preview-view { color: red } body { padding: 1em; color: red }",
    );
    // Themes set the file margins on .markdown-rendered too (same element), as
    // margins, or behind a body class, which nests the subject in :is().
    assert.equal(
      conv(
        ".markdown-rendered { padding: 24px 32px; margin: 0 15px; color: red }",
      ),
      ".markdown-rendered { color: red }",
    );
    assert.equal(
      conv(
        "body:not(.is-mobile) .markdown-preview-view { padding-left: 40px }",
      ),
      "",
    );
  });

  test("the content root keeps Quartz's display and minimum width", () => {
    assert.equal(
      conv(
        ".markdown-preview-view.is-readable-line-width .markdown-preview-sizer { max-width: 100%; display: flex }",
      ),
      ".markdown-preview-view:not(.qt-0):not(.qt-0) { max-width: 100% }",
    );
    assert.equal(
      conv(
        ".markdown-preview-view { min-width: 80ch; max-width: 50%; color: red }",
      ),
      ".markdown-preview-view { max-width: 50%; color: red }",
    );
  });

  test("block wrappers don't stop Quartz's table container scrolling", () => {
    assert.equal(
      conv(
        ".markdown-preview-sizer > :nth-child(2) ~ div { overflow: visible; color: red }",
      ),
      ":where(.markdown-preview-view):not(.qt-0)>:nth-child(2)~:not(qt-0) { color: red }",
    );
  });

  test("sidebar splits never hold the note", () => {
    // Blue Topaz shrinks notes opened in a sidebar split.
    assert.equal(
      conv(
        "body:not(.default-split-style) .workspace>.workspace-split:not(.mod-root) .markdown-preview-sizer { font-size: 0.85em }",
      ),
      "",
    );
  });

  test("margins that offset the content root are dropped; centring stays", () => {
    // A content wrapper mapped onto the root (Nier's readable-width fix).
    assert.equal(
      conv(
        ".markdown-preview-view.is-readable-line-width .markdown-preview-sizer { max-width: 700px; margin-left: 30px; margin-right: 30px }",
      ),
      ".markdown-preview-view:not(.qt-0):not(.qt-0) { max-width: 700px }",
    );
    assert.equal(
      conv(".markdown-preview-view { max-width: 40rem; margin: 0 auto }"),
      ".markdown-preview-view { max-width: 40rem; margin: 0 auto }",
    );
    assert.equal(conv(".markdown-preview-view { margin: 1em auto }"), "");
  });

  test("structural guard sees through :is() and covers opacity", () => {
    assert.equal(
      conv(
        "@media (max-width: 800px) { body :is(.mod-left-split, .mod-right-split) { display: none; color: red } }",
      ),
      "@media (max-width: 800px) { body :is(:where(.left.sidebar):not(.qt-0),:where(.right.sidebar):not(.qt-0)) { color: red } }",
    );
    assert.equal(conv(".mod-left-split { opacity: 0 }"), "");
  });

  test("bases keep Quartz's table layout, and the theme's colours", () => {
    // Obsidian's .bases-table is an absolutely positioned, virtualised div.
    assert.equal(
      conv(
        ".bases-table { position: absolute; display: flex; width: 0; color: red }",
      ),
      ".bases-table { color: red }",
    );
    assert.equal(
      conv(
        ".bases-view .bases-tr { height: 30px; border-bottom: 1px solid red }",
      ),
      ".bases-view .bases-tr { border-bottom: 1px solid red }",
    );
  });

  test("explorer rules follow Obsidian 1.12's tree, not every folder", () => {
    // Pre-1.0 Obsidian's vault-root folder (and its vault-name row) is gone:
    // its rules are dead in Obsidian and would hit every folder here.
    assert.equal(
      conv(".nav-folder.mod-root > .nav-folder-title { display: none }"),
      "",
    );
    assert.equal(
      conv(
        ".nav-folder.mod-root > .nav-folder-children > .nav-folder { color: red }",
      ),
      "",
    );
    assert.equal(conv(".nav-folder.mod-root { display: none }"), "");
    // Firefly leaves out `.nav-folder`.
    assert.equal(conv(".mod-root > .nav-folder-title { display: none }"), "");
    // Catppuccin hides the root's folder icon, not every folder's.
    assert.equal(
      conv(
        ".nav-folder-collapse-indicator, .nav-folder.mod-root > .nav-folder-title .nav-folder-title-content::before, .nav-folder-title .nav-folder-title-content::before { display: none }",
      ),
      ".nav-folder-title .nav-folder-title-content::before { display: none }",
    );
    // Obsidian 1.x no longer renders `.nav-folder-collapse-indicator`.
    assert.equal(
      conv(".nav-folder-collapse-indicator svg { display: none }"),
      "",
    );
    // Every folder is "not the root".
    assert.equal(
      conv(".nav-folder:not(.mod-root) > .nav-folder-title { color: red }"),
      ".nav-folder:not(.qt-0)>.nav-folder-title { color: red }",
    );
    // Top-level items: Obsidian wraps them in a plain div, Quartz's list doesn't
    // (Blue Topaz's coloured top-level folders).
    assert.equal(
      conv(
        ".nav-files-container > div > .nav-folder:nth-child(8n+2) > .nav-folder-title { border-left: 2px solid red }",
      ),
      ".nav-files-container:not(qt-0)>.nav-folder:nth-child(8n+2)>.nav-folder-title { border-left: 2px solid red }",
    );
    assert.equal(
      conv(".nav-files-container > div.foo > .nav-folder { color: red }"),
      ".nav-files-container > div.foo > .nav-folder { color: red }",
    );
    // Oboro: a size container's height ignores its content (the explorer
    // list would collapse); inline-size is harmless.
    assert.equal(
      conv(
        ".nav-files-container { container-type: size scroll-state; container-name: x; color: red }",
      ),
      ".nav-files-container { container-name: x; color: red }",
    );
    // Behind a shared :is(), only Quartz's element loses it.
    assert.equal(
      conv(
        ":is(.nav-files-container, .search-result-container) { container-type: size; color: red }",
      ),
      ":is(.search-result-container) { container-type: size; color: red } :is(.nav-files-container) { color: red }",
    );
    // Each part keeps the whole :is()'s specificity (Bog Oak's accent).
    assert.equal(
      conv(":is(body, .some-toggle) { overflow: hidden; --x: 1 }"),
      ":is(.some-toggle) { overflow: hidden; --x: 1 } :is(body, .qt-0) { --x: 1 }",
    );
    assert.equal(
      conv(".nav-files-container { container: x / inline-size }"),
      ".nav-files-container { container: x / inline-size }",
    );
    // Book and Quill: `will-change: transform` would trap the phone
    // explorer's fixed overlay inside the explorer.
    assert.equal(
      conv(".nav-files-container { will-change: transform; padding-top: 4px }"),
      ".nav-files-container { padding-top: 4px }",
    );
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

  test("code tokens take the theme's --code-* colours, below theme rules", () => {
    const { main } = composeStylesheet({ app: "", theme: "" });
    assert.match(
      main,
      /@layer obsidian \{[\s\S]*:where\(\.markdown-rendered pre\) :where\(span\[data-token-type="keyword"\]\) \{ color: var\(--code-keyword\); \}/,
    );
    assert.match(
      main,
      /data-token-type="regexp"\]\) \{ color: var\(--code-important\)/,
    );
  });

  test("explorer rows keep Obsidian's inline indentation, collapsed children are gone", () => {
    const { main } = composeStylesheet({
      app: "",
      theme: ".nav-folder-title { padding-left: 4px !important }",
    });
    // In the lower layer, so its !important wins, like Obsidian's inline style.
    assert.match(
      main,
      /\}\n@layer quartz-base \{\n:where\(\.explorer\) :where\(\.tree-item-self\) \{\n {2}margin-inline-start: 0 !important;\n {2}padding-inline-start: 24px !important;/,
    );
    assert.match(
      main,
      /:where\(\.folder-outer:not\(\.open\)\) \{\n {2}display: none !important;/,
    );
  });
});
