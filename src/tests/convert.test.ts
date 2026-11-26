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
      ".markdown-preview-view:not(.qt-0)>div { width: 1px }",
    );
    assert.equal(
      conv(".markdown-preview-section > div:has(img) { width: 1px }"),
      ":where(.markdown-preview-view):not(.qt-0)>div:has(img) { width: 1px }",
    );
    assert.equal(
      conv("div.markdown-preview-sizer > div::before { color: red }"),
      ":where(.markdown-preview-view):not(qt-0):not(.qt-0)>div::before { color: red }",
    );
    // The divs are Obsidian's per-block wrappers, which Quartz renders too.
    assert.equal(
      conv(".markdown-preview-section > div h1 { color: red }"),
      ":where(.markdown-preview-view):not(.qt-0)>div h1 { color: red }",
    );
    assert.equal(
      conv(".markdown-preview-sizer > div > p { color: red }"),
      ":where(.markdown-preview-view):not(.qt-0)>div>p { color: red }",
    );
  });

  test("children of other elided wrappers need a name of their own", () => {
    assert.equal(conv(".view-content > div { color: red }"), "");
    assert.equal(
      conv(".workspace > .workspace-split.mod-root hr { color: red }"),
      ":not(.qt-0)>:not(.qt-0):not(.qt-0) hr:where(.markdown-rendered *) { color: red }",
    );
    assert.equal(
      conv(".markdown-reading-view > .markdown-preview-view { color: red }"),
      ":not(.qt-0)>.markdown-preview-view { color: red } :where(:not(.qt-0)>:not(.qt-0) .metadata-container) { color: red }",
    );
    assert.equal(
      conv("p:not(button) { color: red }"),
      "p:not(button) { color: red }",
    );
  });

  test("bare form controls don't reach Quartz chrome", () => {
    // Buttons in notes (the code block's copy button) get Obsidian's button rules.
    assert.equal(
      conv("button { display: inline-flex }"),
      "button:where(.markdown-rendered *) { display: inline-flex }",
    );
    assert.equal(
      conv(".theme-dark button:not(.clickable-icon):hover { color: red }"),
      ':where(body):is([saved-theme="dark"] *) button:not(.clickable-icon):hover:where(.markdown-rendered *) { color: red }',
    );
    assert.equal(conv(".modal button { color: red }"), "");
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

  test("a sizer under :is() of root names is the root itself", () => {
    // Blue Topaz's letter spacing and line height.
    assert.equal(
      conv(
        ":is(.markdown-preview-view,.markdown-rendered) .markdown-preview-sizer { letter-spacing: 2px }",
      ),
      ":is(.markdown-preview-view,.markdown-rendered):not(.qt-0) { letter-spacing: 2px } :where(:not(.qt-0) :not(.qt-0) .metadata-container) { letter-spacing: 2px }",
    );
  });

  test("the boxes behind the note paint Quartz's page, each in its layer", () => {
    // Border's "root split background" option: the tabs' layer, with the
    // rule's body conditions and specificity. A lone `var()` may be a colour
    // or an image: it feeds the colour and the tail image.
    assert.match(
      conv(
        "body.theme-dark .workspace-split.mod-root .workspace-tabs:not(.mod-top) { background: var(--x) }",
      ),
      /^body[^ ]*:is\(\[saved-theme="dark"\] \*\)[^ ]* \{ --qt-bg6-color: var\(--x\); --qt-bg6-image: none; --qt-bg6-tail: var\(--x\) \}/,
    );
    // Outer boxes get their own (outer) layers; a shorthand splits into colour and images.
    assert.equal(
      conv(".app-container { background: #111 linear-gradient(red, blue) }"),
      "body:not(.qt-0) { --qt-bg10-color: #111; --qt-bg10-image: linear-gradient(red, blue); --qt-bg10-tail: none }",
    );
    assert.match(
      conv(".workspace { background-color: red }"),
      /\{ --qt-bg8-color: red \}/,
    );
    // Every leaf includes the main one (Obsidian's own `.workspace-tabs .workspace-leaf`).
    assert.match(
      conv(".workspace-tabs .workspace-leaf { background-color: red }"),
      /\{ --qt-bg4-color: red \}/,
    );
    // Body classes the rule requires stay (Style Settings toggles).
    assert.match(
      conv(".my-toggle .view-content { background-color: red }"),
      /^body\.my-toggle[^ ]* \{ --qt-bg2-color: red \}/,
    );
    // Transparent still overrides a less specific rule for the same box.
    assert.match(
      conv(".mod-root .view-content { background: transparent }"),
      /--qt-bg2-color: transparent; --qt-bg2-image: none/,
    );
    // Body's own backgrounds go to the bottom slot.
    assert.equal(
      conv("body { background: url(x.png) center / cover; color: red }"),
      "body { --qt-bg11-color: transparent; --qt-bg11-image: url(x.png); --qt-bg11-tail: none; color: red }",
    );
    assert.equal(
      conv("body { background-size: cover }"),
      "body { --qt-bg11-size: cover }",
    );
    // The note's own view type counts (Trailside, DDLC, Green Holiday).
    assert.match(
      conv(
        '.workspace-leaf-content[data-type="markdown"] .view-content { background-color: red }',
      ),
      /\{ --qt-bg2-color: red \}/,
    );
    // Images over a colour variable keep the images (Imperium's vignette).
    assert.match(
      conv(".view-content { background: var(--vignette), var(--bg) }"),
      /--qt-bg2-color: var\(--bg\); --qt-bg2-image: var\(--vignette\); --qt-bg2-tail: var\(--bg\)/,
    );
    // A variable holding images and a colour feeds both halves (AbsolutelyGlass).
    const glass = conv(
      ":root { --amb: radial-gradient(red, blue), #eee } body { background: var(--amb) }",
    );
    assert.match(
      glass,
      /--amb--qt-img: radial-gradient\(red, blue\); --amb--qt-col: #eee/,
    );
    assert.match(
      glass,
      /--qt-bg11-color: var\(--amb--qt-col\); --qt-bg11-image: none; --qt-bg11-tail: var\(--amb--qt-img\)/,
    );
    // Also a single layer with its box, position and size (Whim).
    assert.match(
      conv(
        ":root { --pat: repeating-radial-gradient(red, blue) content-box 50% / 10px repeat } .workspace { background: var(--pat) }",
      ),
      /--pat--qt-img: repeating-radial-gradient\(red, blue\); --pat--qt-col: transparent/,
    );
    // Beside an image, a var() is its position or size, not another image.
    assert.match(
      conv(
        ".view-content { background: linear-gradient(red, blue) var(--pos) / var(--size) }",
      ),
      /--qt-bg2-image: linear-gradient\(red, blue\);/,
    );
    // Font stacks and other comma lists are left alone.
    assert.doesNotMatch(
      conv(":root { --f: Inter, sans-serif } body { font-family: var(--f) }"),
      /--qt-img/,
    );
    // An `:is()` of boxes paints each (Glassfelt's transparent panes).
    assert.match(
      conv(
        ".mod-root :is(.view-header, .view-content, .markdown-source-view) { background: transparent }",
      ),
      /\{ --qt-bg2-color: transparent/,
    );
    // A bare `.workspace-split` is also the main split (Byrcen Breathe).
    assert.match(
      conv(".workspace-split { background: transparent }"),
      /\{ --qt-bg7-color: transparent/,
    );
    assert.doesNotMatch(
      conv(".workspace-split.mod-horizontal { background: red }"),
      /--qt-bg/,
    );
    // The note's own box fills the pane, around the column Quartz's content root
    // stands for: its backgrounds go behind the page, under the column's
    // (Graphite Island's grid under its paper sheet, Yosuke Glass's glows under
    // its glass card), and off the content root.
    const box = conv(
      ".markdown-preview-view { background-color: #111; background-image: linear-gradient(red, blue); color: blue }",
    );
    assert.match(
      box,
      /^body:not\(\.qt-0\) \{ --qt-bg0-color: #111; --qt-bg0-image: linear-gradient\(red, blue\); --qt-bg0-tail: none \}/,
    );
    assert.doesNotMatch(box, /\.markdown-preview-view[^{]*\{[^}]*background/);
    assert.match(box, /\.markdown-preview-view[^{]*\{ color: blue \}/);
    // The column's own background stays on the content root.
    assert.match(
      conv(".markdown-preview-sizer { background-color: #222 }"),
      /\{ background-color: #222 \}/,
    );
    // `.markdown-rendered` is the note box too (Forgotten Golden Sanctuary).
    assert.match(
      conv(".markdown-rendered { background-color: transparent }"),
      /--qt-bg0-color: transparent/,
    );
    // Not inside an embed or a popover, which have a note box of their own.
    const embed = conv(
      ".markdown-embed .markdown-preview-view { background: none }",
    );
    assert.doesNotMatch(embed, /--qt-bg/);
    assert.match(embed, /background: none/);
    // In a selector list, only the note box's selectors lose their backgrounds.
    const list = conv(
      ".markdown-preview-view, .callout { background-color: red }",
    );
    assert.match(list, /--qt-bg0-color: red/);
    assert.match(list, /\.callout[^{]*\{ background-color: red \}/);
    // Variables on a box inherit into the note: on the Quartz element that
    // stands for the box, inner boxes ahead of outer.
    assert.equal(
      conv("body .app-container { --x: red }"),
      "body #quartz-root:not(.qt-0) { --x: red }",
    );
    assert.match(
      conv(".view-content { --x: red }"),
      /^body \.center(:not\(#qt-0\)){5}:not\(.qt-0\) \{ --x: red \}$/,
    );
    // Those a box's background uses also go to <body>, where the boxes are
    // painted (Fantasy's translucent panes); others don't (Dracula + LYT's
    // main-split border colour, which <body>'s --hr-color is built from).
    assert.match(
      conv(".app-container { --background-primary: red }"),
      /^body #quartz-root[^}]*\}\s*body:not\(#qt-0\)/,
    );
    assert.doesNotMatch(
      conv(
        ".mod-root { --background-modifier-border: red } button { background: var(--background-modifier-border) }",
      ),
      /body:not\(#qt-0\)/,
    );
    assert.match(
      conv(
        ".app-container { --bp: red } .workspace-leaf { background: var(--bp) }",
      ),
      /body:not\(#qt-0\):not\(\.qt-0\) \{ --bp: red \}/,
    );
    assert.equal(conv(".mod-left-split .workspace-tabs { --x: red }"), "");
    // The outer boxes' letter and word spacing reach the note (and Quartz's
    // chrome, as Obsidian's sidebars), not their font or colour, which the
    // note sets itself (Nytharael's `.workspace { letter-spacing }`).
    assert.match(
      conv(".workspace { letter-spacing: 0.01em; font-family: X; color: red }"),
      /^body #quartz-root[^{]*\{ letter-spacing: 0\.01em \}$/,
    );
    // Body classes from the selector's first compound, whatever whitespace
    // the list left on them (Micro Mike).
    assert.match(
      conv(
        ".a .x,\n.dtm08 .workspace-tabs .workspace-leaf { background: red }",
      ),
      /body\.dtm08:not\(\.qt-0\)[^{]*\{ --qt-bg4-color: red/,
    );
    // A box's own :has() condition can't move to <body> (Fancy-a-Story).
    assert.doesNotMatch(
      conv(".markdown-reading-view:has(> .sci-fi) { --skin: on }"),
      /^body/,
    );
    // Sidebars, popovers and other view types are left alone.
    assert.equal(
      conv(".mod-left-split .workspace-tabs { background: red }"),
      "",
    );
    assert.doesNotMatch(
      conv('.workspace-leaf-content[data-type="graph"] { background: red }'),
      /--qt-bg/,
    );
    // Any other view type, also by prefix (Kakano's plugin tabs).
    assert.doesNotMatch(
      conv(
        '.workspace-leaf-content[data-type^="swar8080"] .view-content { background: red }',
      ),
      /--qt-bg/,
    );
    assert.doesNotMatch(
      conv(
        '.workspace-leaf-content:not([data-type="markdown"]) > .view-content { background: red }',
      ),
      /--qt-bg/,
    );
  });

  test("a body class on another element is that element's state", () => {
    // Paperglow's focused pill isn't every pill.
    assert.equal(
      conv(".multi-select-pill.is-focused { color: red }"),
      ".multi-select-pill.is-focused { color: red }",
    );
    assert.equal(
      conv("body.is-focused .x { color: red }"),
      "body:not(.qt-0) .x { color: red }",
    );
  });

  test("an empty variable among a background's definitions (ITS Theme)", () => {
    assert.doesNotThrow(() =>
      conv(
        ".a { --x:; } .b { --x: url(a.png) 0 0 / 10px; } body { background: var(--x) } .c { background: ; }",
      ),
    );
  });

  test("the properties block inherits the note's text styles", () => {
    // Obsidian's block is inside the note; Quartz's above it (Cairn).
    assert.match(
      conv(".markdown-rendered { letter-spacing: 1px; padding: 4px }"),
      /:where\(:not\(\.qt-0\) \.metadata-container\) \{ letter-spacing: 1px \}/,
    );
    // Through :is() (Blue Topaz's readable-width letter spacing).
    assert.match(
      conv(
        ".markdown-preview-view :is(.markdown-preview-section, .markdown-rendered) { letter-spacing: 1px }",
      ),
      /\.metadata-container\)[^{]*\{ letter-spacing: 1px \}/,
    );
    // As inherited values: the block's own rules win over !important (Techwear).
    assert.match(
      conv(".markdown-rendered { color: red !important }"),
      /:where\(:not\(\.qt-0\) \.metadata-container\) \{ color: red \}/,
    );
    // Not from other boxes, nor layout.
    assert.doesNotMatch(
      conv(".markdown-rendered h1 { letter-spacing: 1px }"),
      /metadata-container/,
    );
    assert.doesNotMatch(
      conv(".markdown-rendered { padding: 4px }"),
      /metadata-container/,
    );
    // The note's colour, behind Obsidian's block, is on Quartz's: ahead of the
    // theme's rules, beating app.css's transparent block but not the theme's
    // own (Waypoint Atlas's sheet under its properties).
    assert.equal(
      conv(
        ".metadata-container { background: red } .markdown-preview-view .markdown-preview-sizer { background-color: #eee }",
      ),
      ".metadata-container { background-color: #eee } .metadata-container { background: red } .markdown-preview-view:not(.qt-0) { background-color: #eee }",
    );
    // Body toggles stay conditions.
    assert.match(
      conv("body.my-toggle .markdown-preview-sizer { background: blue }"),
      /^:where\(body\.my-toggle\) \.metadata-container \{ background-color: blue \}/,
    );
  });

  test("nested rules are flattened before conversion", () => {
    const flat = (css: string) => conv(css).replace(/\s+/g, " ");
    // Descendants of the parent (dashboard's `body { .view-content { … } }`).
    assert.match(
      conv(
        'body { color: red; .workspace-leaf-content[data-type="markdown"] .view-content { background-image: linear-gradient(red, blue) } }',
      ),
      /--qt-bg2-image: linear-gradient\(red, blue\)/,
    );
    // `&` is the parent; declarations after a nested rule keep their place.
    assert.equal(
      flat(
        ".callout { color: red; &[data-callout=tip] { color: blue } margin: 0 }",
      ),
      flat(
        ".callout { color: red } .callout[data-callout=tip] { color: blue } .callout { margin: 0 }",
      ),
    );
    // A parent list is expanded at the list's specificity; a leading
    // combinator is a child.
    assert.equal(
      flat("h1, .x h2 { > a { color: red } }"),
      flat("h1:not(.qt-0) > a, .x h2 > a { color: red }"),
    );
    // Exactly: an alternative padding can't reach counts for nothing (evangelion's
    // `body, .theme-dark { * { … } }` mustn't outrank `.markdown-rendered p`).
    assert.equal(
      flat(".a, body { * { margin: 0 } }"),
      flat(".a *, :where(body):not(.qt-0) * { margin: 0 }"),
    );
    // An editor-only alternative doesn't take the others with it (Retroma).
    assert.match(
      conv(
        ".is-live-preview input[type=checkbox], li > input[type=checkbox] { &:checked { background: none } }",
      ),
      /li ?> ?input\[type=checkbox\][^{]*:checked/,
    );
    // Nested at-rules wrap the parent.
    assert.equal(
      flat(".callout { @media (max-width: 600px) { color: red } }"),
      flat("@media (max-width: 600px) { .callout { color: red } }"),
    );
  });

  test("Quartz's sidebars are open docks", () => {
    // Neumorphism: a collapsed dock's negative margins pushed the sidebar off-screen.
    assert.equal(
      conv(
        "body:not(.is-mobile) .workspace:not(.is-right-sidedock-open) > .workspace-split.mod-right-split { margin-inline: -4px }",
      ),
      "",
    );
    assert.match(
      conv(".workspace.is-left-sidedock-open .mod-left-split { color: red }"),
      /\.left\.sidebar/,
    );
  });

  test("Prism's token classes are Quartz's token types", () => {
    assert.equal(
      conv(".token.number { color: red }"),
      '[data-token-type][data-token-type="value"] { color: red }',
    );
    // Prism's finer classes are tokens Quartz lumps in with a broader type:
    // a theme's colour for them (Desert's `.token.atrule`) is not its keywords'.
    assert.match(
      conv(".token.atrule { color: red }"),
      /data-token-type="prism-atrule"/,
    );
    assert.match(
      conv(".language-css .token.string { color: red }"),
      /\[data-language="css"\] \[data-token-type\]\[data-token-type="string"\]/,
    );
    // Not Quartz's own tags.
    assert.match(conv(".tag { color: red }"), /^\.tag/);
  });

  test("inline headings stack, each alone in its block as in Obsidian", () => {
    // Adrenaline: each heading is alone in its wrapper, in Quartz as in
    // Obsidian, so an inline heading needs nothing of its own.
    assert.equal(
      conv(".markdown-rendered h1 { display: inline }"),
      ".markdown-rendered h1 { display: inline }",
    );
  });

  test("a block in its wrapper behind Quartz's own element", () => {
    // The table's scroll container, always there.
    assert.equal(
      conv(".el-table > table { width: 100% }"),
      ".el-table>:where(.table-container) > table { width: 100% }",
    );
    // Syntax highlighting's figure, or a bare pre without it.
    assert.equal(
      conv(".el-pre > pre { margin: 0 }"),
      ".el-pre>pre,.el-pre>:where([data-rehype-pretty-code-figure]) > pre { margin: 0 }",
    );
    // The diagram's expand controls.
    assert.equal(
      conv(".el-pre > .mermaid { margin: 0 }"),
      ".el-pre>:where(.mermaid-diagram) > .mermaid { margin: 0 }",
    );
  });

  test("Obsidian's block wrappers (.el-*) are Quartz's too", () => {
    // Quartz renders Obsidian's per-block wrappers (rehype-obsidian): rules
    // for them stay as they are.
    for (const css of [
      "div.el-p > p { margin: 0 }",
      ".el-p + div:is(.el-ul, .el-ol) > * { margin-top: 20px }",
      ".el-hr hr { margin: 0 }",
      ".el-table + div > h2 { margin-top: 3em }",
      ".el-pre { border: 1px solid red }",
      "div:is(.el-p, .el-table) + div > h3 { color: red }",
      ".el-hr { padding: 12px 0 }",
    ])
      assert.equal(conv(css), css);
    assert.equal(
      conv(
        '.markdown-preview-sizer > [class^="el-"] ~ [class^="el-"] { padding-top: 28px }',
      ),
      ':where(.markdown-preview-view):not(.qt-0)>[class^="el-"]~[class^="el-"] { padding-top: 28px }',
    );
  });

  test("the block after Obsidian's pusher is the note's first block", () => {
    // Obsidian: only the first block loses its top margin. Not every block's
    // first child (Quartz's table inside .table-container).
    const out = conv(
      ".markdown-rendered > .markdown-preview-section > .markdown-preview-pusher + div:not(.mod-ui) > :first-child { margin-top: 0 }",
    );
    assert.match(out, /:first-child/);
    assert.doesNotMatch(out, /\+/);
    assert.doesNotMatch(out, /pusher/);
  });

  test("a count of the sizer's children skips Obsidian's UI around the blocks", () => {
    // Material Ocean: every block after the header gets a top margin.
    assert.equal(
      conv(
        ".markdown-preview-section > :nth-child(2) ~ div { margin-block-start: 15px }",
      ),
      ":where(.markdown-preview-view):not(.qt-0)>div:not(.qt-0) { margin-block-start: 15px }",
    );
    // The third child is the first block; every fourth from the second, shifted.
    assert.equal(
      conv(".markdown-preview-sizer > div:nth-child(3) { color: red }"),
      ":where(.markdown-preview-view):not(.qt-0)>div:nth-child(1) { color: red }",
    );
    assert.equal(
      conv(".markdown-preview-sizer > div:nth-child(4n+2) { color: red }"),
      ":where(.markdown-preview-view):not(.qt-0)>div:nth-child(4n+0) { color: red }",
    );
    // The first child is the pusher, the last the footer: nothing in Quartz.
    assert.equal(
      conv(".markdown-preview-sizer > div:first-child { color: red }"),
      "",
    );
    assert.equal(
      conv(".markdown-preview-section > div:last-child { color: red }"),
      "",
    );
    // The last block, a count of another type, and a filtered count are kept.
    assert.equal(
      conv(".markdown-preview-sizer > div:nth-last-child(2) { color: red }"),
      ":where(.markdown-preview-view):not(.qt-0)>div:nth-last-child(1) { color: red }",
    );
    assert.match(
      conv(
        ".markdown-preview-sizer > div:nth-last-child(1 of div.el-p) { color: red }",
      ),
      /nth-last-child\(1 of div\.el-p\)/,
    );
  });

  test("a div between the reading view and its blocks is the sizer", () => {
    // Baseline: lists move up a half line in their wrappers. The original stays
    // for an embedded note's blocks, in the embed's div.
    assert.equal(
      conv(".markdown-rendered div > .el-ul > ul { margin-top: -5px }"),
      ".markdown-rendered div>.el-ul>ul,.markdown-rendered:not(qt-0)>.el-ul>ul { margin-top: -5px }",
    );
    assert.equal(
      conv(".markdown-rendered div > ul { margin-top: -5px }"),
      ".markdown-rendered div > ul { margin-top: -5px }",
    );
  });

  test("any child of a block wrapper is the block, past Quartz's element around it", () => {
    // Hidontknow: blocks lose their margins, the code block's `pre` in syntax
    // highlighting's figure too.
    assert.equal(
      conv(".el-table > * { margin: 0 }"),
      ".el-table>*:where(:not(.table-container)),.el-table>:where(.table-container) > * { margin: 0 }",
    );
    assert.equal(
      conv(".el-pre > :first-child { margin: 0 }"),
      ".el-pre>:first-child:where(:not([data-rehype-pretty-code-figure], .mermaid-diagram)),.el-pre>:where([data-rehype-pretty-code-figure]) > :first-child,.el-pre>:where(.mermaid-diagram) > :first-child:where(.mermaid) { margin: 0 }",
    );
    // A paragraph's children are Obsidian's too.
    assert.equal(conv(".el-p > * { margin: 0 }"), ".el-p > * { margin: 0 }");
  });

  test("a child that isn't a table isn't the table's container either", () => {
    // Seamless View: no space above a heading after a table.
    assert.equal(
      conv("div:has(> :not(h2, table)) + div { margin-top: 1em }"),
      "div:has(>:not(h2,table,:where(.table-container)))+div { margin-top: 1em }",
    );
    assert.equal(
      conv(".callout :not(table) { color: red }"),
      ".callout :not(table) { color: red }",
    );
  });

  test("property pills are styled; their editing parts are app-only", () => {
    assert.equal(
      conv(".multi-select-pill { border-radius: 9px }"),
      ".multi-select-pill { border-radius: 9px }",
    );
    assert.equal(conv(".multi-select-pill-remove-button { color: red }"), "");
    assert.equal(conv(".multi-select-input { color: red }"), "");
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
    // Quartz's rule above the footer is outside the note (Weave Surface's margins).
    assert.equal(
      conv("hr { margin: 0 1.5em }"),
      "hr:where(.markdown-rendered *) { margin: 0 1.5em }",
    );
    // Quartz's properties block is a <details> with a <summary> heading, which
    // Obsidian's bare rules for foldable blocks in notes don't reach (Copper Rose).
    assert.equal(
      conv("summary { color: red; font-weight: 600 }"),
      "summary:where(.markdown-rendered *) { color: red; font-weight: 600 }",
    );
    assert.equal(
      conv("details[open] { background-color: #fff !important }"),
      "details[open]:where(.markdown-rendered *) { background-color: #fff !important }",
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
    // As an ancestor, a typed wrapper is no more than the wrapper (ITS).
    assert.equal(
      conv(
        ".view-content > div:is(.markdown-source-view, .markdown-reading-view) > div { container: note/inline-size }",
      ),
      "",
    );
    assert.equal(conv("div.markdown-reading-view > div { color: red }"), "");
    // Block wrappers are Quartz's elements too.
    assert.equal(
      conv(".markdown-preview-sizer > :nth-child(2) ~ div { margin-top: 1em }"),
      ":where(.markdown-preview-view):not(.qt-0)>div:not(.qt-0) { margin-top: 1em }",
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
      ".callout { padding-inline: 2em; padding-top: 1em; color: red } .markdown-preview-view:not(.qt-0) { color: red } :where(:not(.qt-0) .metadata-container) { color: red }",
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
      ".markdown-preview-view { color: red } body { padding: 1em; color: red } :where(:not(.qt-0) .metadata-container) { color: red }",
    );
    // Themes set the file margins on .markdown-rendered too (same element), as
    // margins, or behind a body class, which nests the subject in :is().
    assert.equal(
      conv(
        ".markdown-rendered { padding: 24px 32px; margin: 0 15px; color: red }",
      ),
      ".markdown-rendered { color: red } :where(:not(.qt-0) .metadata-container) { color: red }",
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
      ".markdown-preview-view { max-width: 50%; color: red } :where(:not(.qt-0) .metadata-container) { color: red }",
    );
  });

  test("bare headings behind :is() stay in the note", () => {
    // Lancer: `.cm-header-1, h1 { &:before {…} }` drew on Quartz's titles.
    assert.equal(
      conv(".cm-header-1, h1 { &:before { content: '' } }"),
      ":where(h1):not(.qt-0):where(.markdown-rendered *):before { content: '' }",
    );
  });

  test("the block wrapper can be the element between the note and a block", () => {
    // Micro Mike: `:not(:is(li, ul, ol))` is the block wrapper for top-level
    // blocks, in Quartz as in Obsidian.
    assert.equal(
      conv(
        ".markdown-preview-section :not(:is(li, ul, ol)) > h2 { margin-top: 20px }",
      ),
      ":where(.markdown-preview-view):not(.qt-0) :not(:is(li,ul,ol))>h2 { margin-top: 20px }",
    );
    assert.equal(
      conv(".markdown-rendered .callout > p { color: red }"),
      ".markdown-rendered .callout > p { color: red }",
    );
  });

  test("wrappers in an ancestor's :is() are any ancestor", () => {
    // Micro Mike's column sizer was dropped along with the editor's alternative.
    assert.equal(
      conv(
        ":is(.markdown-reading-view, .markdown-source-view) p { color: red }",
      ),
      ":is(:not(.qt-0)) p { color: red }",
    );
    // Their children still need a name of their own.
    assert.equal(
      conv(":is(.workspace-leaf-content, .view-content) > div { color: red }"),
      "",
    );
  });

  test("a column flexbox on the note keeps its margins apart", () => {
    // DarkEmber: flex items' margins don't collapse.
    assert.equal(
      conv(
        ".markdown-preview-view.is-readable-line-width .markdown-preview-sizer { display: flex; flex-direction: column }",
      ),
      ".markdown-preview-view:not(.qt-0):not(.qt-0) { display: flex; flex-direction: column }",
    );
  });

  test("universal rules reach the note root as Obsidian's sizer", () => {
    // Museifu, SpectrumPlus: the sizer's text has the universal rule's font;
    // Quartz's root is also the view, which app.css gives a font of its own.
    assert.equal(
      conv('* { font-family: "JetBrains Mono"; margin: 0 }'),
      '* { font-family: "JetBrains Mono"; margin: 0 } :where(.markdown-preview-view):not(.qt-0):not(#qt-0) { font-family: "JetBrains Mono" }',
    );
    // Not the descendants of anything else.
    assert.equal(
      conv(".callout * { color: red }"),
      ".callout * { color: red }",
    );
  });

  test("a block wrapper's box is around the block, not inside it", () => {
    // Discordian: the wrapper's padding and margins are its own, around the
    // block, in Quartz as in Obsidian.
    assert.equal(
      conv(
        ".markdown-preview-section > div { padding-left: 4rem; padding-right: 2rem; margin: 0 auto 0 auto; max-width: 100% }",
      ),
      ":where(.markdown-preview-view):not(.qt-0)>div { padding-left: 4rem; padding-right: 2rem; margin: 0 auto 0 auto; max-width: 100% }",
    );
  });

  test("block wrappers don't stop Quartz's table container scrolling", () => {
    // The wrapper is around Quartz's scroll container, not the container itself.
    assert.equal(
      conv(
        ".markdown-preview-sizer > :nth-child(2) ~ div { overflow: visible; color: red }",
      ),
      ":where(.markdown-preview-view):not(.qt-0)>div:not(.qt-0) { overflow: visible; color: red }",
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
    // Nor `.is-read-mode` on the leaf (it uses `[data-mode="preview"]`).
    assert.equal(
      conv(
        ".workspace-leaf-content.is-read-mode .markdown-preview-view { background-color: var(--background-primary) }",
      ),
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

  test("the properties block starts from UA styles in the obsidian layer", () => {
    const { main } = composeStylesheet({ app: "", theme: "" });
    assert.match(
      main,
      /@layer obsidian \{[\s\S]*:where\(\.metadata-container, \.metadata-container :not\(svg, svg \*\)\) \{\n {2}all: revert;/,
    );
    assert.equal(
      composeStylesheet({ app: "", theme: "", reset: false }).main.includes(
        "metadata-container",
      ),
      false,
    );
  });

  test("body keeps Obsidian's inline font size against normal theme rules", () => {
    const { main } = composeStylesheet({
      app: "",
      theme: "body { --font-text-size: 18px }",
    });
    assert.match(
      main,
      /body { --font-text-size: 18px }[\s\S]*body(:not\(\.qt-0\)){32} \{\n {2}--zoom-factor: 1;\n {2}--font-text-size: 16px;/,
    );
    // Below a box's variables, which in Obsidian sit inside <body> (Mulled Wine).
    assert.match(
      conv(".app-container { --font-text-size: 14px }"),
      /^body #quartz-root/,
    );
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

describe("renamed elements", () => {
  test("internal-link rules leave tags and heading anchors alone, which Quartz also marks as internal links", () => {
    assert.equal(
      conv(".markdown-rendered .internal-link { color: red }"),
      '.markdown-rendered .internal-link:where(:not(.tag, [role="anchor"])) { color: red }',
    );
    assert.equal(
      conv("a.internal-link:hover::after { content: 'x' }"),
      "a.internal-link:hover:where(:not(.tag, [role=\"anchor\"]))::after { content: 'x' }",
    );
  });
  test("folded callouts hide their content as Obsidian's inline style does; embeds start from UA styles", () => {
    const { main } = composeStylesheet({ app: "", theme: "" });
    assert.match(
      main,
      /:where\(\.markdown-preview-view \.callout\.is-collapsed > \.callout-content\) \{\n {2}display: none !important;/,
    );
    assert.match(
      main,
      /\.callout-icon, \.markdown-embed, input\[type="checkbox"\]\) \{\n {2}all: revert;/,
    );
  });
  test("code blocks' copy button is Quartz's clipboard button, same specificity", () => {
    assert.equal(
      conv(
        ".markdown-rendered pre:not(:hover)>button.copy-code-button { display: none }",
      ),
      ".markdown-rendered pre:not(:hover)>button:where(.clipboard-button):not(.qt-0) { display: none }",
    );
  });
  test("search is Obsidian's prompt: its classes stay, the overlay is the modal container", () => {
    assert.equal(
      conv(".prompt .suggestion-item.is-selected { color: red }"),
      ".prompt .suggestion-item.is-selected { color: red }",
    );
    assert.equal(
      conv(".modal-container.mod-dim .prompt { color: red }"),
      ":where(.search-container):not(.qt-0).mod-dim .prompt { color: red }",
    );
    assert.equal(conv(".modal-container .modal { color: red }"), "");
    assert.equal(conv(".card-title { font-size: 20px }"), "");
    const { main } = composeStylesheet({ app: "", theme: "" });
    assert.match(
      main,
      /:where\(\.search > \.search-container:not\(\.active\)\) \{\n {2}display: none !important;/,
    );
  });

  test("the search button's label and Bases group properties are the theme's faint text, below its own rules", () => {
    const { main } = composeStylesheet({
      app: "",
      theme: ".search-button p { color: red }",
    });
    const reset = main.indexOf(
      ":where(.search > .search-button > p, .bases-table-group-property) {\n  color: var(--text-faint);",
    );
    assert.ok(reset > 0);
    assert.ok(reset < main.indexOf(".search-button p { color: red }"));
  });
});

describe("property inputs", () => {
  test("rules for Obsidian's property inputs reach Quartz's elements, with the same specificity", () => {
    assert.equal(
      conv("input.metadata-property-key-input { color: red }"),
      ":is(input, span).metadata-property-key-input { color: red }",
    );
    assert.equal(
      conv(
        ".metadata-property-value input.metadata-input-number { color: red }",
      ),
      ".metadata-property-value :is(input, div).metadata-input-number { color: red }",
    );
    assert.equal(
      conv(".metadata-property-key input { color: red }"),
      ".metadata-property-key :is(input, :where(.metadata-property-key-input, .metadata-input)) { color: red }",
    );
    assert.equal(
      conv(
        '.metadata-property-value input[type="number"]:focus { color: red }',
      ),
      '.metadata-property-value :is(input[type="number"], :where(.metadata-input-number)):focus { color: red }',
    );
    assert.equal(
      conv(".metadata-property-value input[type=date] { color: red }"),
      ".metadata-property-value :is(input[type=date], :where(.mod-date)) { color: red }",
    );
  });

  test("checkboxes, other inputs and inputs outside the properties are left alone", () => {
    for (const sel of [
      ".metadata-property input[type=checkbox]",
      ".metadata-property-value > input.metadata-input-checkbox:checked",
      ".search-input-container input",
    ])
      assert.equal(conv(`${sel} { color: red }`), `${sel} { color: red }`);
  });
});

describe("folding", () => {
  test("`:not(.allow-fold-headings)` tests Quartz's fold script; as an ancestor the class is elided", () => {
    assert.equal(
      conv(
        ".markdown-preview-view:not(.allow-fold-headings) .heading-collapse-indicator { display: none }",
      ),
      ".markdown-preview-view:not(.allow-fold-headings) .heading-collapse-indicator { display: none }",
    );
    assert.equal(
      conv(
        ".markdown-preview-view:not(.allow-fold-lists) .list-collapse-indicator { display: none }",
      ),
      ".markdown-preview-view:not(.allow-fold-lists) .list-collapse-indicator { display: none }",
    );
    assert.equal(
      conv(".markdown-preview-view.allow-fold-headings h2 { color: red }"),
      ".markdown-preview-view:not(.qt-0) h2 { color: red }",
    );
  });
});
