import { describe, expect, it } from "vitest";
import { buildYieldSourceProvenance } from "../provenance";
import type { EvaluatedYieldSource } from "../evaluation";
import { classifyYieldSourceFreshness } from "../../../lib/yield-ranking-helpers";

const now = 1_790_502_000;

describe("yield source provenance observation authority", () => {
  it.each(["rate-derived", "defillama"])("does not renew an old %s observation from a fresh family fetch", (dataSource) => {
    const source = {
      id: "test-coin",
      sourceKey: dataSource,
      dataSource,
      sourceObservedAt: now - 37 * 3600,
      benchmarkMeta: { fetchedAt: now - 60, ageSeconds: 60 },
      previousBestSourceKey: null,
    } as EvaluatedYieldSource;
    const provenance = buildYieldSourceProvenance({
      source,
      isBest: false,
      evaluatedSources: [],
      startSec: now,
      dlPoolsMeta: { mode: "dex-cache", updatedAt: now - 60, ageSeconds: 60, poolCount: 1, fallbackMode: null },
    });
    expect(provenance.sourceObservedAt).toBe(now - 37 * 3600);
    expect(provenance.sourceAgeSeconds).toBe(37 * 3600);
    expect(classifyYieldSourceFreshness({
      dataSource,
      sourceKey: dataSource,
      sourceAgeSeconds: provenance.sourceAgeSeconds as number,
    })).toBe("stale");
  });

  it("does not synthesize a rate observation from a recent benchmark fetch", () => {
    const source = {
      id: "test-coin", sourceKey: "rate-derived", dataSource: "rate-derived",
      benchmarkMeta: { fetchedAt: now, ageSeconds: 0 },
      previousBestSourceKey: null,
    } as EvaluatedYieldSource;
    const provenance = buildYieldSourceProvenance({
      source, isBest: false, evaluatedSources: [], startSec: now,
      dlPoolsMeta: { mode: "unavailable", updatedAt: null, ageSeconds: null, poolCount: 0, fallbackMode: null },
    });
    expect(provenance.sourceObservedAt).toBeNull();
    expect(provenance.sourceAgeSeconds).toBeNull();
    expect(provenance.sourceMaxAgeSeconds).toBe(36 * 3600);
  });
});
