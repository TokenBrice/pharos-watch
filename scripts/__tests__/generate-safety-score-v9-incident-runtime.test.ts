import { describe, expect, it } from "vitest";
import source from "../../shared/data/safety-score-v9/incident-reviews-v1.json";
import { projectNegativeIncidentReview } from "../lib/safety-score-v9-incident-runtime";
import { readFileSync } from "node:fs";
import { buildIncidentRuntime } from "../build-data/generate-safety-score-v9-incident-runtime";
import { expandReviewedRegistryReferences } from "../../shared/lib/safety-score-v9/reviewed-registry";
import { V9ReviewedIncidentRegistrySchema } from "../../shared/types/safety-score-v9-incidents";
import { sha256Hex } from "../../shared/lib/sha256";
import { stableJsonStringifyV1 } from "../../shared/lib/stable-json";

const expanded = expandReviewedRegistryReferences(source, "negativeReviews", {
  sources: "sourceObservations", searchedSurfaces: "searchedSurfaceObservations",
});
const reviews = V9ReviewedIncidentRegistrySchema.parse(expanded).negativeReviews!;

describe("incident runtime projection", () => {
  it("fails closed on missing research surfaces and future observations", () => {
    expect(() => projectNegativeIncidentReview({ ...reviews[0], searchedSurfaces: [] })).toThrow();
    expect(() => projectNegativeIncidentReview({ ...reviews[0], windowEndSec: Number.MAX_SAFE_INTEGER })).toThrow();
  });

  it("pins the full expanded-review identity and exact generated runtime bytes", () => {
    // Ordered pre-normalization authored identity; deliberate curation rotates this pin.
    expect(sha256Hex(stableJsonStringifyV1(expanded))).toBe("c6dfda6370220ac28f1003ab72a1a421e214bb03ef248ba902bec13ed24d5b43");
    const runtime = readFileSync(new URL("../../shared/data/safety-score-v9/incident-runtime-v1.generated.json", import.meta.url), "utf8");
    expect(`${JSON.stringify(buildIncidentRuntime(source))}\n`).toBe(runtime);
  });

  it("preserves reference order and exact observations, not URL-only identity", () => {
    const first = { url: "https://example.com/source", excerpt: "First observation" };
    const second = { ...first, excerpt: "Independently dated observation" };
    const authored = { schemaVersion: 1, entries: [{ assetId: "fixture", sourcesRefs: ["second", "first", "first:2"] }],
      sourceObservations: [{ id: "first", value: first }, { id: "second", value: second }, { id: "first:2", value: first }] };
    expect(expandReviewedRegistryReferences(authored, "entries", { sources: "sourceObservations" }))
      .toEqual({ schemaVersion: 1, entries: [{ assetId: "fixture", sources: [second, first, first] }] });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(authored.sourceObservations)).toBe(true);
  });

  it("rejects missing or duplicate references and duplicate table IDs without an inline fallback", () => {
    const authored = { entries: [{ assetId: "fixture", sourcesRefs: ["source"] }],
      sourceObservations: [{ id: "source", value: { url: "https://example.com/source" } }] };
    for (const refs of [["missing"], ["source", "source"]]) {
      expect(() => expandReviewedRegistryReferences({ ...authored, entries: [{ assetId: "fixture", sourcesRefs: refs }] },
        "entries", { sources: "sourceObservations" })).toThrow(/observation reference/);
    }
    expect(() => expandReviewedRegistryReferences({ ...authored, sourceObservations: [...authored.sourceObservations, ...authored.sourceObservations] },
      "entries", { sources: "sourceObservations" })).toThrow(/Duplicate observation reference/);
    expect(() => expandReviewedRegistryReferences({ ...authored, entries: [{ ...authored.entries[0], sources: [] }] },
      "entries", { sources: "sourceObservations" })).toThrow(/not inline/);
  });

  it("rejects even unused duplicate table IDs during offline envelope generation", () => {
    const duplicates = [{ id: "unused", value: {} }, { id: "unused", value: {} }];
    expect(() => expandReviewedRegistryReferences({ entries: [], sourceObservations: duplicates },
      "entries", { sources: "sourceObservations" })).toThrow(/Duplicate observation reference: unused/);
    expect(() => buildIncidentRuntime({ ...source, sourceObservations: [...source.sourceObservations, ...duplicates] }))
      .toThrow(/Duplicate observation reference: unused/);
  });
});
