import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetchStrict } from "@shared/test-utils/mock-fetch";
import { createTempRepoTracker } from "./helpers/test-state";
import type { DigestContentEntry } from "@shared/types/digest";

import {
  assertDigestArchivePreserved,
  deduplicateDigestEntries,
  findMissingDigestArchiveDates,
  runDigestSync,
} from "../maintenance/sync-digests";

const { cleanup, makeRoot } = createTempRepoTracker("sync-digests");
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function digest(date: string): DigestContentEntry {
  return {
    date,
    title: `Digest ${date}`,
    text: "Summary",
    extended: "Extended summary",
    generatedAt: Date.parse(date.replace(/-weekly$/, "")) / 1000,
    digestType: date.endsWith("-weekly") ? "weekly" : "daily",
    editionNumber: 1,
  };
}

describe("sync-digests archive guard", () => {
  it("detects a missing published slug even when the refreshed count is unchanged", () => {
    const previous = [digest("2026-07-17"), digest("2026-07-16")];
    const current = [digest("2026-07-18"), digest("2026-07-17")];

    expect(findMissingDigestArchiveDates(previous, current)).toEqual(["2026-07-16"]);
    expect(() => assertDigestArchivePreserved(previous, current)).toThrow(
      "Digest archive lost 1 published slug(s): 2026-07-16",
    );
  });

  it("accepts append-only refreshes and an explicit reviewed override", () => {
    const previous = [digest("2026-07-17")];
    const current = [digest("2026-07-18"), ...previous];

    expect(() => assertDigestArchivePreserved(previous, current)).not.toThrow();
    expect(() => assertDigestArchivePreserved(previous, [], true)).not.toThrow();
  });

  it("publishes only the latest digest when an upstream rerun reuses a route date", () => {
    const stale = { ...digest("2026-07-18"), editionNumber: 99 };
    const replacement = { ...stale, title: "Revised digest", generatedAt: stale.generatedAt + 3600, editionNumber: 1 };
    const tied = { ...digest("2026-07-17"), title: "Tie winner", editionNumber: 2 };
    const weekly = { ...digest("2026-07-17-weekly"), generatedAt: tied.generatedAt };

    const entries = [weekly, tied, replacement, digest("2026-07-17"), stale];
    for (const ordered of [entries, [...entries].reverse()]) {
      expect(deduplicateDigestEntries(ordered)).toEqual([replacement, tied, weekly]);
    }
  });

  it("keeps daily and weekly editions on separate durable routes", () => {
    expect(deduplicateDigestEntries([digest("2026-07-18"), digest("2026-07-18-weekly")])).toHaveLength(2);
  });
});

describe("digest mirror publication", () => {
  function serve(digests: Record<string, unknown>[]) {
    return mockFetchStrict([{
      match: (request) => /^https:\/\/api\.example\.com\/api\/digest-archive\?staticSync=\d+$/.test(request.url),
      body: { digests },
    }]);
  }

  it("writes UTC daily and weekly routes without inventing editorial provenance", async () => {
    const output = join(makeRoot(), "digests.json");
    const generatedAt = Date.parse("2026-07-19T00:30:00+02:00") / 1000;
    serve([
      { digestText: "Daily", digestTitle: "Daily title", digestExtended: "Details", generatedAt,
        editionNumber: 8, editorialStyleVersion: "v2", editorialStyleHash: "abc123" },
      { digestText: "Weekly", generatedAt, digestType: "weekly",
        editorialStyleVersion: "pre-policy", editorialStyleHash: "pre-policy" },
    ]);
    await runDigestSync(["--api-url", "https://api.example.com", "--output", output]);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual([
      { date: "2026-07-18", title: "Daily title", text: "Daily", extended: "Details", generatedAt,
        digestType: "daily", editionNumber: 8, editorialStyleVersion: "v2", editorialStyleHash: "abc123" },
      { date: "2026-07-18-weekly", title: "Signal & Noise", text: "Weekly", extended: "", generatedAt,
        digestType: "weekly", editionNumber: 0 },
    ]);
  });

  it("preserves existing bytes during a valid dry run", async () => {
    const output = join(makeRoot(), "digests.json");
    const bytes = JSON.stringify([digest("2026-07-18")]);
    writeFileSync(output, bytes);
    serve([{ digestText: "Updated", generatedAt: digest("2026-07-18").generatedAt }]);
    await runDigestSync(["--api-url", "https://api.example.com", "--output", output, "--dry-run"]);
    expect(readFileSync(output, "utf8")).toBe(bytes);
  });

  it("rejects archive shrink before overwriting the mirror", async () => {
    vi.stubEnv("PAGES_RELEASE_ALLOW_EXISTING_DATA_ON_FETCH_FAILURE", "");
    vi.stubEnv("DIGEST_SYNC_ALLOW_EXISTING_ON_FETCH_FAILURE", "");
    const output = join(makeRoot(), "digests.json");
    const bytes = JSON.stringify([digest("2026-07-17")]);
    writeFileSync(output, bytes);
    serve([{ digestText: "New", generatedAt: digest("2026-07-18").generatedAt }]);
    await expect(runDigestSync(["--api-url", "https://api.example.com", "--output", output]))
      .rejects.toThrow(/2026-07-17/);
    expect(readFileSync(output, "utf8")).toBe(bytes);
  });
});
