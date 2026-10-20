import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetchStrict } from "@shared/test-utils/mock-fetch";
import { createTempRepoTracker } from "./helpers/test-state";
import { DigestStoredSnapshotSchema, type DigestContentEntry } from "@shared/types/digest";
import { SnapshotIntegrityError } from "../lib/sync-from-api";

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

});

describe("digest mirror publication", () => {
  function serve(digests: Record<string, unknown>[]) {
    return mockFetchStrict([{
      match: (request) => {
        const url = new URL(request.url);
        return url.origin === "https://api.example.com" && url.pathname === "/api/digest-archive"
          && url.searchParams.get("history") === "all" && /^\d+$/.test(url.searchParams.get("staticSync") ?? "");
      },
      body: { digests, pagination: { horizon: digests.length, total: digests.length, scanned: digests.length, nextCursor: null } },
    }]);
  }

  it("writes UTC daily and weekly routes without inventing editorial provenance", async () => {
    const output = join(makeRoot(), "digests.json");
    const generatedAt = Date.parse("2026-07-19T00:30:00+02:00") / 1000;
    serve([
      { digestText: "Daily", digestTitle: "Daily title", digestExtended: "Details", generatedAt,
        editionNumber: 8, llm: { servedModel: "claude-sonnet-5" }, editorialStyleVersion: "v2", editorialStyleHash: "abc123" },
      { digestText: "Weekly", generatedAt, digestType: "weekly",
        editorialStyleVersion: "pre-policy", editorialStyleHash: "pre-policy" },
    ]);
    await runDigestSync(["--api-url", "https://api.example.com", "--output", output]);
    const stored = JSON.parse(readFileSync(output, "utf8"));
    expect(DigestStoredSnapshotSchema.safeParse(stored).success).toBe(true);
    expect(stored).toEqual([
      { date: "2026-07-18", title: "Daily title", text: "Daily", extended: "Details", generatedAt,
        digestType: "daily", editionNumber: 8, llm: { servedModel: "claude-sonnet-5" }, editorialStyleVersion: "v2", editorialStyleHash: "abc123" },
      { date: "2026-07-18-weekly", title: "Signal & Noise", text: "Weekly", extended: "", generatedAt,
        digestType: "weekly", editionNumber: 0 },
    ]);
  });

  it.each([
    { digestText: 42 },
    { digestTitle: false },
    { digestExtended: {} },
    { generatedAt: "yesterday" },
    { generatedAt: 1e100 },
    { generatedAt: Date.UTC(10000, 0, 1) / 1000 },
    { digestType: "monthly" },
    { editionNumber: "8" },
    { llm: { servedModel: 42 } },
  ])("rejects malformed API fields %j without using the fetch fallback", async (invalidFields) => {
    const output = join(makeRoot(), "digests.json");
    // Legacy stored editions may lack optional edition metadata.
    const bytes = JSON.stringify([{ date: "2026-07-17", title: "Legacy", text: "Summary",
      extended: "", generatedAt: digest("2026-07-17").generatedAt }]);
    writeFileSync(output, bytes);
    serve([{ digestText: "New", generatedAt: digest("2026-07-17").generatedAt, ...invalidFields }]);
    await expect(runDigestSync([
      "--api-url", "https://api.example.com", "--output", output, "--allow-existing-on-fetch-failure",
    ])).rejects.toThrow(SnapshotIntegrityError);
    expect(readFileSync(output, "utf8")).toBe(bytes);
  });

  it.each([
    { total: -1 },
    { total: "1" },
    { scanned: 0.5 },
    { nextCursor: 123 },
    { nextCursor: "bad-cursor" },
  ])("rejects invalid pagination %j before writing with fallback enabled", async (invalidPagination) => {
    const output = join(makeRoot(), "digests.json");
    const bytes = JSON.stringify([digest("2026-07-17")]);
    writeFileSync(output, bytes);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      digests: [{ digestText: "New", generatedAt: digest("2026-07-17").generatedAt }],
      pagination: { horizon: 1, total: 1, scanned: 1, nextCursor: null, ...invalidPagination },
    })));
    await expect(runDigestSync([
      "--api-url", "https://api.example.com", "--output", output, "--allow-existing-on-fetch-failure",
    ])).rejects.toThrow(SnapshotIntegrityError);
    expect(readFileSync(output, "utf8")).toBe(bytes);
  });

  it("rejects malformed JSON as integrity failure rather than a fetch outage", async () => {
    const output = join(makeRoot(), "digests.json");
    const bytes = JSON.stringify([digest("2026-07-17")]);
    writeFileSync(output, bytes);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{invalid")));
    await expect(runDigestSync([
      "--api-url", "https://api.example.com", "--output", output, "--allow-existing-on-fetch-failure",
    ])).rejects.toThrow(SnapshotIntegrityError);
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


  it.each(["missing-pagination", "premature-end", "changed-horizon", "repeated-cursor", "http-failure"])(
    "refuses %s traversal without replacing the existing artifact, even with shrink override",
    async (failure) => {
      vi.stubEnv("PAGES_RELEASE_ALLOW_EXISTING_DATA_ON_FETCH_FAILURE", "");
      vi.stubEnv("DIGEST_SYNC_ALLOW_EXISTING_ON_FETCH_FAILURE", "");
      const output = join(makeRoot(), "digests.json");
      const bytes = JSON.stringify([digest("2026-07-17")]);
      writeFileSync(output, bytes);
      let page = 0;
      vi.stubGlobal("fetch", vi.fn(async () => {
        page++;
        if (failure === "http-failure" && page === 2) return new Response("Forbidden", { status: 401 });
        return Response.json({
          digests: [],
          ...(failure === "missing-pagination" ? {} : { pagination: {
            horizon: failure === "changed-horizon" && page === 2 ? 3 : 2,
            total: 2,
            scanned: page,
            nextCursor: failure === "premature-end" || page === 2
              ? (failure === "repeated-cursor" ? "2.2.1.100.1" : null) : "2.2.1.100.1",
          } }),
        });
      }));
      await expect(runDigestSync([
        "--api-url", "https://api.example.com", "--output", output, "--allow-archive-shrink",
      ])).rejects.toThrow(/traversal|API returned/);
      expect(readFileSync(output, "utf8")).toBe(bytes);
    },
  );
});
