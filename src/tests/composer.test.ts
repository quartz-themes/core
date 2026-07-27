import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { composeCSS } from "../composer";

describe("themeFonts option", () => {
  test("omitted (default) includes @font-face declarations", () => {
    const result = composeCSS({ theme: "catppuccin", mode: "both" });
    assert.ok(
      result.css.includes("@font-face"),
      "should include @font-face when themeFonts is omitted",
    );
  });

  test("true includes @font-face declarations", () => {
    const result = composeCSS({
      theme: "catppuccin",
      mode: "both",
      themeFonts: true,
    });
    assert.ok(
      result.css.includes("@font-face"),
      "should include @font-face when themeFonts is true",
    );
  });

  test("false excludes regular @font-face but keeps icon fonts", () => {
    const result = composeCSS({
      theme: "catppuccin",
      mode: "both",
      themeFonts: false,
    });

    const fontFaceBlocks = result.css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
    for (const block of fontFaceBlocks) {
      assert.ok(
        block.includes("icons/") ||
          block.includes("lucide") ||
          block.includes("checkbox"),
        `unexpected non-icon @font-face when themeFonts is false: ${block.slice(0, 100)}`,
      );
    }
  });

  test("font URLs use unpkg.com with package name", () => {
    const result = composeCSS({
      theme: "catppuccin",
      mode: "both",
      themeFonts: true,
    });
    assert.ok(
      result.css.includes("unpkg.com/@quartz-themes/catppuccin/fonts/"),
      "font URLs should use unpkg.com/@quartz-themes/<theme>/fonts/ pattern",
    );
    assert.ok(
      !result.css.includes("cdn.jsdelivr.net"),
      "should not reference old jsDelivr CDN",
    );
  });
});
