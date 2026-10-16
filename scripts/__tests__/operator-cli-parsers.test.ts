import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseFreezeStablecoinArgs } from "../maintenance/freeze-stablecoin";

import {
  run as waitForReleaseMarker,
} from "../maintenance/wait-pages-release-marker.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe("priority operator CLI parsers", () => {
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

