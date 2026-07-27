import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import {
  resolveThemeId,
  resolveThemePackage,
  installThemePackage,
  loadTheme,
} from "../registry";

describe("resolveThemePackage", () => {
  test("simple theme ID maps to @quartz-themes/<name>", () => {
    const result = resolveThemePackage("tokyo-night");
    assert.equal(result.packageName, "@quartz-themes/tokyo-night");
    assert.equal(result.requirePath, "@quartz-themes/tokyo-night");
  });

  test("dotted theme ID extracts base package and variant subpath", () => {
    const result = resolveThemePackage("catppuccin.frappe");
    assert.equal(result.packageName, "@quartz-themes/catppuccin");
    assert.equal(result.requirePath, "@quartz-themes/catppuccin/frappe");
  });

  test("dotted theme ID with nested variant", () => {
    const result = resolveThemePackage("hidden-grotto.absol");
    assert.equal(result.packageName, "@quartz-themes/hidden-grotto");
    assert.equal(result.requirePath, "@quartz-themes/hidden-grotto/absol");
  });
});

describe("resolveThemeId", () => {
  test("known theme returns its ID", () => {
    assert.equal(resolveThemeId("tokyo-night"), "tokyo-night");
  });

  test("known theme with valid variation returns dotted ID", () => {
    assert.equal(resolveThemeId("catppuccin", "frappe"), "catppuccin.frappe");
  });

  test("dotted string in theme field resolves same as split theme+variation", () => {
    assert.equal(
      resolveThemeId("catppuccin.frappe"),
      resolveThemeId("catppuccin", "frappe"),
    );
  });

  test("dotted string works for hyphenated base themes", () => {
    assert.equal(resolveThemeId("its-theme.blue"), "its-theme.blue");
  });

  test("unknown dotted theme throws with variation in error", () => {
    assert.throws(
      () => resolveThemeId("nonexistent.variant"),
      (err: Error) =>
        err.message.includes("Unknown theme") &&
        err.message.includes("nonexistent"),
    );
  });

  test("unknown theme throws with available themes list", () => {
    assert.throws(
      () => resolveThemeId("this-theme-does-not-exist-xyz"),
      (err: Error) =>
        err.message.includes("Unknown theme") &&
        err.message.includes("Available themes:"),
    );
  });
});

describe("installThemePackage", () => {
  test("returns false for non-existent package (does not throw)", () => {
    const result = installThemePackage(
      "@quartz-themes/this-package-does-not-exist-xyz-12345",
    );
    assert.equal(result, false);
  });
});

describe("loadTheme", () => {
  test("loads an installed theme and returns ThemeData", () => {
    const theme = loadTheme("tokyo-night");
    assert.ok(theme, "loadTheme should return theme data");
    assert.ok(theme.meta, "theme data should have meta");
    assert.ok(theme.meta.name, "theme meta should have a name");
    assert.ok(theme.dark || theme.light, "theme should have dark or light CSS");
  });

  test("throws for theme ID not in registry", () => {
    assert.throws(
      () => loadTheme("this-theme-does-not-exist-xyz"),
      (err: Error) => err.message.includes("No theme data"),
    );
  });

  test("installThemePackage returns false for non-existent npm package", () => {
    const result = installThemePackage(
      "@quartz-themes/zzz-nonexistent-test-pkg",
    );
    assert.equal(result, false, "should return false, not throw");
  });

  test("caches loaded themes on subsequent calls", () => {
    const first = loadTheme("tokyo-night");
    const second = loadTheme("tokyo-night");
    assert.equal(first, second, "should return same cached reference");
  });

  test("loads dotted variant theme", () => {
    const theme = loadTheme("catppuccin.frappe");
    assert.ok(theme, "should load variant theme");
    assert.ok(theme.meta, "variant theme should have meta");
  });
});
