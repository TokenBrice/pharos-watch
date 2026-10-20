import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const launchBrowser = vi.hoisted(() => vi.fn());
vi.mock("playwright", () => ({ chromium: { launch: launchBrowser } }));
vi.mock("../lib/cli-args.mjs", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  runDirectCli: vi.fn(),
}));

import { runDirectCli } from "../lib/cli-args.mjs";
import { parseFreezeStablecoinArgs } from "../maintenance/freeze-stablecoin";
import { parseD1InsightsArgs } from "../maintenance/capture-d1-insights.mjs";
import { parseSeoRenderBudgetArgs } from "../maintenance/audit-seo-render-budget.mjs";

import {
  run as waitForReleaseMarker,
} from "../maintenance/wait-pages-release-marker.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { force: true, recursive: true });
  vi.unstubAllEnvs();
});

describe("priority operator CLI parsers", () => {
  it("preserves SEO audit defaults and accepts strict route/wait options", () => {
    expect(parseSeoRenderBudgetArgs([])).toMatchObject({ waitMs: 4000, json: false, help: false });
    expect(parseSeoRenderBudgetArgs(["--routes=/,/api/", "--wait-ms=0", "--json"]))
      .toMatchObject({ routes: ["/", "/api/"], waitMs: 0, json: true });
    expect(parseSeoRenderBudgetArgs(["-h"]).help).toBe(true);
  });

  it.each([
    ["--unknown"], ["--url"], ["--wait-ms=invalid"], ["--wait-ms=-1"],
    ["--url=one", "--url=two"], ["extra"], ["--routes=,"],
  ])("rejects invalid SEO audit usage %j", (...argv) => {
    expect(() => parseSeoRenderBudgetArgs(argv)).toThrow(expect.objectContaining({ exitCode: 2 }));
  });

  it.each([
    [undefined, undefined, { headless: true }],
    [" /browser/chromium ", undefined, { executablePath: "/browser/chromium", headless: true }],
    [undefined, " chrome-beta ", { channel: "chrome-beta", headless: true }],
    [" /browser/chromium ", " chrome-beta ", { executablePath: "/browser/chromium", headless: true }],
  ])("preserves SEO launch options for executable=%s channel=%s", async (executablePath, channel, expected) => {
    vi.stubEnv("SEO_AUDIT_BROWSER_EXECUTABLE_PATH", executablePath);
    vi.stubEnv("SEO_AUDIT_BROWSER_CHANNEL", channel);
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("SMOKE_UI_BROWSER_CHANNEL", "chrome");
    vi.stubEnv("SMOKE_UI_BROWSER_EXECUTABLE_PATH", "/unrelated/smoke-browser");
    const main = vi.mocked(runDirectCli).mock.calls
      .find(([url]) => url.endsWith("/audit-seo-render-budget.mjs"))![1];
    const argv = process.argv;
    process.argv = ["node", "audit-seo-render-budget.mjs", "--routes=/", "--wait-ms=0"];
    const failure = new Error("Executable doesn't exist");
    launchBrowser.mockReset().mockRejectedValue(failure);
    try {
      await expect(main()).rejects.toBe(failure);
      expect(launchBrowser).toHaveBeenCalledExactlyOnceWith(expected);
    } finally {
      process.argv = argv;
    }
  });

  it("preserves D1 capture defaults and repeatable period/sort selection", () => {
    expect(parseD1InsightsArgs([])).toMatchObject({
      database: "stablecoin-db", config: "worker/wrangler.toml", limit: 50,
      periods: [], sortBy: [], output: null, dryRun: false,
    });
    expect(parseD1InsightsArgs([
      "--period=7d", "--period", "30d", "--sort-by=reads", "--sort-by", "time", "--dry-run",
    ])).toMatchObject({ periods: ["7d", "30d"], sortBy: ["reads", "time"], dryRun: true });
  });

  it.each([
    ["--unknown"], ["--database"], ["--limit=2x"], ["--limit=0"],
    ["--database=one", "--database=two"], ["extra"],
  ])("rejects invalid D1 insights usage %j", (...argv) => {
    expect(() => parseD1InsightsArgs(argv)).toThrow(expect.objectContaining({ exitCode: 2 }));
  });

  it.each(["--database", "--config", "--limit", "--period", "--sort-by", "--output"])(
    "rejects flag-like values for D1 insights option %s", (flag) => {
      for (const argv of [[flag, "--dry-run"], [`${flag}=--dry-run`]]) {
        expect(() => parseD1InsightsArgs(argv)).toThrow(expect.objectContaining({ exitCode: 2 }));
      }
    },
  );

  it("requires exactly one freeze target and rejects option-like typos", () => {
    expect(parseFreezeStablecoinArgs(["--dry-run", "usdc-circle"])).toEqual({
      coinId: "usdc-circle",
      dryRun: true,
      help: false,
    });
    expect(() => parseFreezeStablecoinArgs([])).toThrow("exactly one <coinId>");
    expect(() => parseFreezeStablecoinArgs(["one", "two"])).toThrow("exactly one <coinId>");
    expect(() => parseFreezeStablecoinArgs(["--coin", "usdc-circle"])).toThrow("Unknown option");
  });

  it("accepts the first cache-busted matching release marker", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pharos-release-marker-"));
    tempDirs.push(directory);
    const markerPath = join(directory, "marker.json");
    writeFileSync(markerPath, JSON.stringify({ commit: "target" }));
    const commits = ["old", "target"];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(new URL(String(input)).searchParams.get("expected")).toBe("target");
      const commit = commits.shift();
      return new Response(JSON.stringify({ commit }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    });

    try {
      await waitForReleaseMarker([
        "--url", "https://one.test/marker.json",
        "--marker", markerPath,
        "--attempts", "2",
        "--delay-ms", "0",
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
  });
});

