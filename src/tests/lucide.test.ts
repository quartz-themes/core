import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import type { LucideIconData } from "@lucide/icons";
import { buildSvgString } from "../icons/lucide";

const node = [["path", { d: "M0 0h1", key: "k" }]] as LucideIconData["node"];

describe("buildSvgString", () => {
  test("uses the icon's size for the viewBox and drops React keys", () => {
    const svg = buildSvgString({ name: "a", size: 24, node } as LucideIconData);
    assert.ok(svg.includes('viewBox="0 0 24 24"'));
    assert.ok(svg.includes('<path d="M0 0h1"/>'));
    assert.ok(!svg.includes("key="));
  });

  test("uses width and height when the icon has them", () => {
    const svg = buildSvgString({
      name: "b",
      width: 32,
      height: 16,
      node,
    } as LucideIconData);
    assert.ok(svg.includes('viewBox="0 0 32 16"'));
  });

  test("falls back to Lucide's 24×24 grid when the icon has no size (optional since @lucide/icons 1.70)", () => {
    const svg = buildSvgString({ name: "c", node } as LucideIconData);
    assert.ok(svg.includes('viewBox="0 0 24 24"'));
  });
});
