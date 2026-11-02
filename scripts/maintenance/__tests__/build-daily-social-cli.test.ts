import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DailySocialSnapshot } from "@shared/lib/daily-social";
import { main } from "../build-daily-social";
import { assertPosterSnapshotPairing } from "../publish-daily-social";
import { dailySocialSnapshotDigest } from "../../lib/daily-social-snapshot-digest";

const browserState = vi.hoisted(() => ({
  fontsLoaded: true,
  screenshotError: null as Error | null,
  png: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]),
}));

vi.mock("playwright", () => ({
  firefox: {
    launch: async () => ({
      newPage: async () => ({
        route: async () => {},
        goto: async () => {},
        evaluate: async () => browserState.fontsLoaded,
        screenshot: async ({ path }: { path: string }) => {
          if (browserState.screenshotError) throw browserState.screenshotError;
          const { writeFileSync: write } = await import("node:fs");
          write(path, browserState.png);
        },
      }),
      close: async () => {},
    }),
  },
}));

const snapshot: DailySocialSnapshot = {
  schemaVersion: 1,
  editionDate: "2026-09-10",
  scheduledAt: 1789041600,
  capturedAt: 1789041600,
  asOf: 1789041000,
  topic: "market-growth",
  title: "Where stablecoins are growing",
  subtitle: "Seven-day market-cap growth",
  unit: "usd",
  rows: [5, 4, 3, 2, 1].map((n) => ({
    id: `coin-${n}`,
    name: `Stablecoin ${n}`,
    symbol: `USD${n}`,
    value: n * 10_000_000,
    context: `${n}% weekly growth`,
  })),
  highlights: [{ label: "Coverage", value: "Illustrative test data" }],
  source: "Pharos",
  methodology: "Ranked by dollars added over seven days.",
};

const otherSnapshot: DailySocialSnapshot = {
  ...snapshot,
  title: "A different capture",
  subtitle: "Seven-day market-cap growth, re-captured",
};

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "daily-social-build-"));
  return {
    dir,
    snapshotPath: join(dir, "snapshot.json"),
    posterPath: join(dir, "poster.png"),
    digestPath: join(dir, "poster.snapshot.sha256"),
  };
}

afterEach(() => {
  browserState.fontsLoaded = true;
  browserState.screenshotError = null;
});

describe("daily social build artifacts", () => {
  it("writes the poster, alt text and snapshot digest together on success", async () => {
    const { dir, snapshotPath, posterPath, digestPath } = workspace();
    writeFileSync(snapshotPath, JSON.stringify(snapshot));

    await main(["--input", snapshotPath, "--out", posterPath]);

    expect(readFileSync(posterPath)).toEqual(Buffer.from(browserState.png));
    expect(readFileSync(digestPath, "utf8").trim()).toBe(dailySocialSnapshotDigest(snapshot));
    expect(existsSync(join(dir, "poster.svg"))).toBe(true);
    expect(existsSync(join(dir, "poster.html"))).toBe(true);
    expect(existsSync(join(dir, "poster.alt.txt"))).toBe(true);
    expect(() => assertPosterSnapshotPairing(dir, snapshot)).not.toThrow();
  });

  it("keeps the previous poster and digest when a re-capture fails to render", async () => {
    const { dir, snapshotPath, posterPath, digestPath } = workspace();
    writeFileSync(snapshotPath, JSON.stringify(snapshot));
    await main(["--input", snapshotPath, "--out", posterPath]);
    const previousPoster = readFileSync(posterPath);
    const previousDigest = readFileSync(digestPath, "utf8");
    const previousSvg = readFileSync(join(dir, "poster.svg"), "utf8");

    writeFileSync(snapshotPath, JSON.stringify(otherSnapshot));
    browserState.fontsLoaded = false;
    await expect(main(["--input", snapshotPath, "--out", posterPath])).rejects.toThrow("Poster fonts failed to load");

    expect(readFileSync(posterPath)).toEqual(previousPoster);
    expect(readFileSync(digestPath, "utf8")).toBe(previousDigest);
    expect(readFileSync(join(dir, "poster.svg"), "utf8")).toBe(previousSvg);
    // The failure is caught at publication: the new snapshot no longer matches the poster.
    expect(() => assertPosterSnapshotPairing(dir, otherSnapshot)).toThrow(/re-run build-daily-social\.ts/);
  });

  it("fails a publication whose poster digest was written for another snapshot", async () => {
    const { dir, digestPath } = workspace();

    expect(() => assertPosterSnapshotPairing(dir, snapshot)).toThrow(/re-run build-daily-social\.ts/);
    writeFileSync(digestPath, `${dailySocialSnapshotDigest(otherSnapshot)}\n`);
    expect(() => assertPosterSnapshotPairing(dir, snapshot)).toThrow(/re-run build-daily-social\.ts/);
    writeFileSync(digestPath, `${dailySocialSnapshotDigest(snapshot)}\n`);
    expect(() => assertPosterSnapshotPairing(dir, snapshot)).not.toThrow();
  });
});
