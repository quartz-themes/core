import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The published bundle, not src/: bundling can break what the source tests pass
// (e.g. bundled CommonJS dependencies calling require()). CI builds before testing.
const dist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../dist/index.js",
);

test(
  "the built bundle converts a theme",
  { skip: !fs.existsSync(dist) && "dist/ not built" },
  async () => {
    const core = await import(dist);
    const broken =
      ".theme-dark { --h1-color: red } } .callout { padding: 0 } .x { color: blue";
    const result = core.convertTheme({ themeCss: broken });
    assert.equal(result.report.theme.repaired, "css-tree");
    assert.match(result.main, /@layer obsidian/);
    assert.match(result.themeCss, /--h1-color: red/);
  },
);
