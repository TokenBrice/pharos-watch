import { describe, expect, it } from "vitest";
import {
  CATEGORY_ORDER,
  classifyPath,
  classifyTrackedEntries,
  countPhysicalLines,
  digestRecordSet,
  generatedBinaryRuleForPath,
  generatedRuleForPath,
  isBinary,
  snapshotsMatch,
} from "../maintenance/capture-simplification-baseline";

describe("simplification baseline capture", () => {
  it("uses the documented fixed classification precedence", () => {
    expect(classifyPath("shared/data/stablecoins/coins.generated.json")).toMatchObject({
      category: "generated",
      reproducibility: "deterministic",
    });
    expect(classifyPath("worker/migrations/__fixtures__/0010_example.sql").category).toBe("migrations");
    expect(classifyPath("src/__tests__/fixtures/example.ts").category).toBe("test-fixtures");
    expect(classifyPath("scripts/__tests__/capture.test.ts").category).toBe("tests");
    expect(classifyPath("shared/data/stablecoins/coins/usdc.json").category).toBe("stablecoin-authored-data");
    expect(classifyPath("src/app/page.tsx").category).toBe("production-runtime");
    expect(classifyPath("scripts/maintenance/task.ts").category).toBe("tooling-scripts");
    expect(classifyPath("docs/guide.md").category).toBe("docs-guidance");
    expect(classifyPath("shared/data/digests/latest.json").category).toBe("other-authored-static-data");
    expect(classifyPath("package.json").category).toBe("root-config-automation-static-text");
    expect(CATEGORY_ORDER).toHaveLength(10);
  });

  it("counts physical lines, preserves symlink targets, and excludes binary blobs", () => {
    expect(countPhysicalLines(Buffer.from(""))).toBe(0);
    expect(countPhysicalLines(Buffer.from("one\ntwo\n"))).toBe(2);
    expect(countPhysicalLines(Buffer.from("one\ntwo"))).toBe(2);
    expect(isBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);

    const entries = [
      { path: "z.txt", sha: "z", bytes: 3, mode: "100644", type: "blob" },
      { path: "a-link", sha: "a", bytes: 8, mode: "120000", type: "blob" },
      { path: "binary.png", sha: "b", bytes: 3, mode: "100644", type: "blob" },
    ] as const;
    const result = classifyTrackedEntries(entries, new Map([
      ["z", Buffer.from("a\nb")],
      ["a", Buffer.from("target/a")],
      ["b", Buffer.from([0x61, 0x00, 0x62])],
    ]));

    expect(result.files.map((file) => file.path)).toEqual(["a-link", "z.txt"]);
    expect(result.files[0]).toMatchObject({ mode: "120000", symlinkTarget: "target/a", lines: 1 });
    expect(result.binaryFiles).toEqual([{ path: "binary.png", bytes: 3, sha: "b", mode: "100644" }]);
  });

  it("covers generated registry output paths with an explicit manifest", () => {
    expect(generatedRuleForPath("shared/data/stablecoins/coins.prevalidated.generated.ts")?.reproducibility).toBe("deterministic");
    expect(generatedRuleForPath("shared/types/stablecoin-client-meta.ts")).toBeUndefined();
    expect(classifyPath("shared/types/stablecoin-client-meta.ts").category).toBe("production-runtime");
    expect(generatedRuleForPath("src/app/learn/case-studies/content/client-index.ts")?.reproducibility).toBe("deterministic");
    expect(generatedRuleForPath("src/generated/docs-metadata.json.d.ts")?.reproducibility).toBe("deterministic");
    expect(generatedRuleForPath("src/generated/sitemap-dates.json")?.id).toBe("sitemap-dates");
    expect(generatedRuleForPath("src/generated/depeg-event-search-data.json.d.ts")?.reproducibility).toBe("pinned-input");
    expect(generatedRuleForPath("src/generated/depeg-event-related-data.json")?.reproducibility).toBe("pinned-input");
    expect(generatedRuleForPath("src/generated/homepage-bootstrap.json")?.reproducibility).toBe("network-derived");
    expect(generatedRuleForPath("public/datasets/top-stablecoins/latest.json")?.reproducibility).toBe("network-derived");
    expect(generatedRuleForPath("public/sheets/scores-latest.csv")?.reproducibility).toBe("network-derived");
    expect(generatedRuleForPath("data/digests.json")?.id).toBe("remote-digests");
    expect(generatedRuleForPath("data/logos.json")?.reproducibility).toBe("mixed");
    expect(generatedRuleForPath("public/openapi.json")?.id).toBe("openapi");
    expect(generatedRuleForPath("public/postman/pharos-api.postman_collection.json")?.id).toBe("postman");
    expect(generatedRuleForPath("public/llms.txt")?.reproducibility).toBe("network-derived");
    expect(generatedRuleForPath("docs/agent-code-map.md")?.id).toBe("agent-code-map");
    expect(generatedRuleForPath("public/maps/world-countries.svg")?.reproducibility).toBe("deterministic");
    expect(generatedRuleForPath("public/og-card.svg")?.reproducibility).toBe("deterministic");
    expect(classifyPath("docs/api-reference.md").category).toBe("docs-guidance");
    expect(generatedRuleForPath("public/logos/usdc.svg")).toBeUndefined();
    expect(generatedBinaryRuleForPath("public/logos/compact/usdc.webp")?.reproducibility).toBe("deterministic");
    expect(generatedBinaryRuleForPath("public/og-editorial-digest.png")?.id).toBe("og-images");
    expect(generatedBinaryRuleForPath("public/og-card.svg")).toBeUndefined();
    expect(generatedBinaryRuleForPath("public/logos/usdc.svg")).toBeUndefined();
  });

  it("compares deterministic content while ignoring only observational data", () => {
    const baseline = {
      pinnedRef: "e668",
      trackedInventory: { text: { lines: 12 } },
      surfaces: { generatedArtifacts: 18 },
      source: { paths: ["a.ts"], hashes: { classificationScript: "old" } },
      observational: { node: "v1", ignoredBuildOutputs: { out: { files: 1 } } },
    };
    const sameRepository = {
      ...baseline,
      surfaces: { generatedArtifacts: 20 },
      source: { paths: ["a.ts"], hashes: { classificationScript: "new" } },
      observational: { node: "v2", ignoredBuildOutputs: { out: { files: 99 } } },
    };
    expect(snapshotsMatch(baseline, sameRepository)).toBe(true);
    expect(snapshotsMatch(baseline, { ...sameRepository, pinnedRef: "other" })).toBe(false);
    expect(snapshotsMatch(baseline, { ...sameRepository, source: { paths: ["b.ts"] } })).toBe(false);
  });

  it("uses sorted SHA-256 digest sets that detect membership and content changes", () => {
    const digest = digestRecordSet(["z\t100644\tsha-z", "a\t100644\tsha-a"]);
    expect(digest).toBe(digestRecordSet(["a\t100644\tsha-a", "z\t100644\tsha-z"]));
    expect(digest).not.toBe(digestRecordSet(["a\t100644\tsha-a", "z\t100755\tsha-z"]));
    expect(digest).not.toBe(digestRecordSet(["a\t100644\tsha-a"]));
  });
});
