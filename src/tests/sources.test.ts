import test, { describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSnippet, resolveTheme } from "../sources";

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

  test("default is Obsidian's built-in theme, without a download", async () => {
    const calls: string[] = [];
    const fetch = mockFetch({}, calls);
    for (const spec of ["default", "Default", " obsidian "]) {
      const t = await resolveTheme(spec, { cacheDir, fetch });
      assert.equal(t.css, "");
      assert.deepEqual(t.modes, ["dark", "light"]);
    }
    assert.deepEqual(calls, []);
  });

  test("falls back to the default branch, then obsidian.css (also for unflagged themes)", async () => {
    // No manifest (so no release): the default branch's theme.css.
    const head: string[] = [];
    const t = await resolveTheme("Old One", {
      cacheDir,
      fetch: mockFetch(
        {
          [registryUrl]: JSON.stringify(REGISTRY),
          [raw("someone/old", "theme.css")]: "/* head */",
          [raw("someone/old", "obsidian.css")]: "/* legacy */",
        },
        head,
      ),
    });
    assert.equal(t.css, "/* head */");
    assert.equal(t.source, raw("someone/old", "theme.css"));
    assert.deepEqual(head, [
      registryUrl,
      raw("someone/old", "manifest.json"),
      raw("someone/old", "theme.css"),
    ]);
    // No theme.css on the default branch either (the "Old One" entry has no
    // `legacy` flag): obsidian.css, as Obsidian does.
    const calls: string[] = [];
    const legacy = await resolveTheme("Old One", {
      cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "qt-sources-")),
      fetch: mockFetch(
        {
          [registryUrl]: JSON.stringify(REGISTRY),
          [raw("someone/old", "obsidian.css")]: "/* legacy */",
        },
        calls,
      ),
    });
    assert.equal(legacy.css, "/* legacy */");
    assert.deepEqual(calls, [
      registryUrl,
      raw("someone/old", "manifest.json"),
      raw("someone/old", "theme.css"),
      raw("someone/old", "obsidian.css"),
    ]);
    // An empty theme.css doesn't count.
    const blank = await resolveTheme("Old One", {
      cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "qt-sources-")),
      fetch: mockFetch({
        [registryUrl]: JSON.stringify(REGISTRY),
        [raw("someone/old", "theme.css")]: " \n",
        [raw("someone/old", "obsidian.css")]: "/* legacy */",
      }),
    });
    assert.equal(blank.css, "/* legacy */");
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

  test("works offline from a stale cache", async () => {
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

  test("a fresh cache makes no requests; an expired one refetches the registry and manifest", async () => {
    const repo = "tcmmichaelb139/obsidian-tokyonight";
    const release = (v: string) =>
      `https://github.com/${repo}/releases/download/${v}/theme.css`;
    const online = {
      [registryUrl]: JSON.stringify(REGISTRY),
      [raw(repo, "manifest.json")]: JSON.stringify({ version: "1.2.3" }),
      [release("1.2.3")]: "/* 1.2.3 */",
    };
    await resolveTheme("Tokyo Night", { cacheDir, fetch: mockFetch(online) });
    // An hour later, within the default day.
    const age = (ms: number) => {
      const t = new Date(Date.now() - ms);
      for (const f of fs.readdirSync(cacheDir))
        fs.utimesSync(path.join(cacheDir, f), t, t);
    };
    age(60 * 60 * 1000);
    const fresh: string[] = [];
    const t = await resolveTheme("Tokyo Night", {
      cacheDir,
      fetch: mockFetch({}, fresh),
    });
    assert.equal(t.css, "/* 1.2.3 */");
    assert.deepEqual(fresh, []);
    // Two days later: the registry and manifest are refetched, a new release
    // downloaded; the old release asset would still be cached (immutable).
    age(2 * 24 * 60 * 60 * 1000);
    const expired: string[] = [];
    const updated = await resolveTheme("Tokyo Night", {
      cacheDir,
      fetch: mockFetch(
        {
          ...online,
          [raw(repo, "manifest.json")]: JSON.stringify({ version: "1.3.0" }),
          [release("1.3.0")]: "/* 1.3.0 */",
        },
        expired,
      ),
    });
    assert.equal(updated.css, "/* 1.3.0 */");
    assert.deepEqual(expired, [
      registryUrl,
      raw(repo, "manifest.json"),
      release("1.3.0"),
    ]);
    // Expired again, same version: the release asset never expires.
    age(2 * 24 * 60 * 60 * 1000);
    const again: string[] = [];
    await resolveTheme("Tokyo Night", {
      cacheDir,
      fetch: mockFetch(
        {
          [registryUrl]: JSON.stringify(REGISTRY),
          [raw(repo, "manifest.json")]: JSON.stringify({ version: "1.3.0" }),
        },
        again,
      ),
    });
    assert.deepEqual(again, [registryUrl, raw(repo, "manifest.json")]);
  });

  test("a pinned version fetches only that release's asset", async () => {
    const repo = "tcmmichaelb139/obsidian-tokyonight";
    const asset = `https://github.com/${repo}/releases/download/1.0.0/theme.css`;
    const calls: string[] = [];
    const t = await resolveTheme("Tokyo Night", {
      cacheDir,
      version: "1.0.0",
      fetch: mockFetch(
        { [registryUrl]: JSON.stringify(REGISTRY), [asset]: "/* 1.0.0 */" },
        calls,
      ),
    });
    assert.equal(t.css, "/* 1.0.0 */");
    assert.equal(t.version, "1.0.0");
    assert.deepEqual(calls, [registryUrl, asset]);
  });

  test("GitHub repos: the registry's entry, or any repo", async () => {
    const calls: string[] = [];
    const t = await resolveTheme("me/thing", {
      cacheDir,
      fetch: mockFetch(
        {
          [registryUrl]: JSON.stringify(REGISTRY),
          [raw("me/thing", "manifest.json")]: JSON.stringify({
            version: "2.0.0",
          }),
          "https://github.com/me/thing/releases/download/2.0.0/theme.css":
            "/* thing */",
        },
        calls,
      ),
    });
    assert.deepEqual(
      { name: t.name, css: t.css, version: t.version, modes: t.modes },
      {
        name: "me/thing",
        css: "/* thing */",
        version: "2.0.0",
        modes: undefined,
      },
    );
    assert.deepEqual(calls, [
      registryUrl,
      raw("me/thing", "manifest.json"),
      "https://github.com/me/thing/releases/download/2.0.0/theme.css",
    ]);
    const known = await resolveTheme("Catppuccin/Obsidian", {
      cacheDir,
      fetch: mockFetch({
        [registryUrl]: JSON.stringify(REGISTRY),
        [raw("catppuccin/obsidian", "theme.css")]: "/* ctp */",
      }),
    });
    assert.equal(known.name, "Catppuccin");
    assert.deepEqual(known.modes, ["dark", "light"]);
  });

  test("URLs are downloaded and cached", async () => {
    const url = "https://example.com/theme?v=1";
    const calls: string[] = [];
    const t = await resolveTheme(url, {
      cacheDir,
      fetch: mockFetch({ [url]: "/* url */" }, calls),
    });
    assert.deepEqual(
      { name: t.name, css: t.css, source: t.source },
      { name: url, css: "/* url */", source: url },
    );
    assert.deepEqual(calls, [url]);
    const again = await resolveTheme(url, { cacheDir, fetch: mockFetch({}) });
    assert.equal(again.css, "/* url */");
    await assert.rejects(
      resolveTheme("https://example.com/missing", {
        cacheDir,
        fetch: mockFetch({}),
      }),
      /could not download theme from https:\/\/example\.com\/missing/,
    );
  });

  test("a URL ending in .css is a URL, not a local path", async () => {
    const url = "https://example.com/theme.css";
    const t = await resolveTheme(url, {
      cacheDir,
      fetch: mockFetch({ [url]: "/* url */" }),
    });
    assert.equal(t.css, "/* url */");
    assert.equal(t.source, url);
  });

  test("relative paths resolve against the working directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qt-cwd-"));
    fs.mkdirSync(path.join(root, "site", "mine"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "site", "mine", "theme.css"),
      "/* mine */",
    );
    fs.writeFileSync(path.join(root, "up.css"), "/* up */");
    const cwd = process.cwd();
    process.chdir(path.join(root, "site"));
    try {
      const opts = { cacheDir, fetch: mockFetch({}) };
      for (const spec of [
        "./mine",
        "../site/mine",
        "./mine/theme.css",
        "mine/theme.css",
      ]) {
        const t = await resolveTheme(spec, opts);
        assert.equal(t.css, "/* mine */", spec);
        assert.equal(t.name, "mine", spec);
        assert.equal(
          t.source,
          path.join(fs.realpathSync(root), "site", "mine", "theme.css"),
          spec,
        );
      }
      assert.equal((await resolveTheme("../up.css", opts)).css, "/* up */");
      await assert.rejects(
        resolveTheme("./nope", opts),
        /theme file not found/,
      );
    } finally {
      process.chdir(cwd);
    }
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

describe("resolveSnippet", () => {
  test("URLs are downloaded and cached; paths are read", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "qt-snippets-"));
    const url = "https://x/s.css";
    const calls: string[] = [];
    assert.equal(
      await resolveSnippet(url, {
        cacheDir,
        fetch: mockFetch({ [url]: "/* s */" }, calls),
      }),
      "/* s */",
    );
    assert.deepEqual(calls, [url]);
    assert.equal(
      await resolveSnippet(url, { cacheDir, fetch: mockFetch({}) }),
      "/* s */",
    );
    await assert.rejects(
      resolveSnippet("http://x/missing.css", {
        cacheDir,
        fetch: mockFetch({}),
      }),
      /could not download snippet http:\/\/x\/missing\.css/,
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qt-snippet-"));
    fs.writeFileSync(path.join(dir, "local.css"), "/* local */");
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const none: string[] = [];
      assert.equal(
        await resolveSnippet("local.css", {
          cacheDir,
          fetch: mockFetch({}, none),
        }),
        "/* local */",
      );
      assert.deepEqual(none, []);
    } finally {
      process.chdir(cwd);
    }
  });
});
