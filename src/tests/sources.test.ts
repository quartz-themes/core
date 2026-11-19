import test, { describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveTheme } from "../sources";

const REGISTRY = [
  {
    name: "Tokyo Night",
    repo: "tcmmichaelb139/obsidian-tokyonight",
    modes: ["dark", "light"],
  },
  { name: "Catppuccin", repo: "catppuccin/obsidian", modes: ["dark", "light"] },
  { name: "Old One", repo: "someone/old" },
];

function mockFetch(files: Record<string, string>, calls: string[] = []) {
  return (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    const body = files[u];
    return { ok: body !== undefined, text: async () => body ?? "" } as Response;
  }) as typeof fetch;
}

const raw = (repo: string, file: string) =>
  `https://raw.githubusercontent.com/${repo}/HEAD/${file}`;
const registryUrl = raw(
  "obsidianmd/obsidian-releases",
  "community-css-themes.json",
);

describe("resolveTheme", () => {
  let cacheDir: string;
  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "qt-sources-"));
  });

  test("community name → release asset of the manifest version", async () => {
    const repo = "tcmmichaelb139/obsidian-tokyonight";
    const fetch = mockFetch({
      [registryUrl]: JSON.stringify(REGISTRY),
      [raw(repo, "manifest.json")]: JSON.stringify({ version: "1.2.3" }),
      [`https://github.com/${repo}/releases/download/1.2.3/theme.css`]:
        "/* release */",
    });
    const t = await resolveTheme("tokyo night", { cacheDir, fetch });
    assert.equal(t.name, "Tokyo Night");
    assert.equal(t.version, "1.2.3");
    assert.equal(t.css, "/* release */");
  });

  test("falls back to the default branch, then obsidian.css (also for unflagged themes)", async () => {
    const fetch = mockFetch({
      [registryUrl]: JSON.stringify(REGISTRY),
      [raw("someone/old", "obsidian.css")]: "/* legacy */",
    });
    assert.equal(
      (await resolveTheme("Old One", { cacheDir, fetch })).css,
      "/* legacy */",
    );
  });

  test("pre-3.0 ids map to the theme name plus their Style Settings preset", async () => {
    const repo = "catppuccin/obsidian";
    const fetch = mockFetch({
      [registryUrl]: JSON.stringify(REGISTRY),
      [raw(repo, "theme.css")]: "/* ctp */",
    });
    const t = await resolveTheme("catppuccin.frappe", { cacheDir, fetch });
    assert.equal(t.name, "Catppuccin");
    assert.equal(
      t.styleSettings?.["catppuccin-theme-settings@@catppuccin-theme-dark"],
      "ctp-frappe",
    );
  });

  test("works offline from the cache", async () => {
    const repo = "catppuccin/obsidian";
    const files = {
      [registryUrl]: JSON.stringify(REGISTRY),
      [raw(repo, "theme.css")]: "/* ctp */",
    };
    await resolveTheme("Catppuccin", { cacheDir, fetch: mockFetch(files) });
    const offline = mockFetch({});
    const t = await resolveTheme("Catppuccin", {
      cacheDir,
      fetch: offline,
      cacheTtl: 0,
    });
    assert.equal(t.css, "/* ctp */");
  });

  test("unknown names suggest close matches", async () => {
    const fetch = mockFetch({ [registryUrl]: JSON.stringify(REGISTRY) });
    await assert.rejects(
      resolveTheme("Tokio Nite", { cacheDir, fetch }),
      /Did you mean: "Tokyo Night"/,
    );
  });

  test("local paths need no network", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qt-theme-"));
    fs.writeFileSync(path.join(dir, "theme.css"), "body { --x: 1 }");
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({ name: "Mine" }),
    );
    const calls: string[] = [];
    const t = await resolveTheme(dir, {
      cacheDir,
      fetch: mockFetch({}, calls),
    });
    assert.equal(t.name, "Mine");
    assert.deepEqual(calls, []);
  });
});
