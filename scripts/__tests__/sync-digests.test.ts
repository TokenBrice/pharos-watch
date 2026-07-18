import { describe, expect, it } from "vitest";

import {
  assertDigestArchivePreserved,
  findMissingDigestArchiveDates,
  type DigestEntry,
} from "../maintenance/sync-digests";

function digest(date: string): DigestEntry {
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
});
