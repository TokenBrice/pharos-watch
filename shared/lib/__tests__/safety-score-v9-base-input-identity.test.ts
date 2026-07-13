import { describe, expect, it } from "vitest";
import {
  BASE_INPUT_GENERATION_ID_PREFIX,
  computeBaseInputGenerationId,
  projectBaseInputIdentityV1,
} from "@shared/lib/safety-score-v9/base-input-identity";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const E = "e".repeat(64);

function baseInput() {
  return {
    schemaVersion: 1 as const,
    captureKind: "exact-publication-inputs" as "exact-publication-inputs" | "public-reconstruction",
    publicationClockSec: 1_800_000_000,
    sourceUpdatedAtSec: 1_799_999_900,
    registry: {
      activeAssetIds: ["usdt-tether", "usdc-circle", "usdc-circle"],
      fingerprintSha256: A,
    },
    producers: {
      dex: { generationId: "dex-liquidity-1800000000", payloadSha256: B },
      redemption: { generationId: "redemption-1800000000", payloadSha256: C },
    },
    producerMethodologyVersions: {
      dexLiquidity: ["4.2", "4.1", "4.2"],
      pegScore: ["7.25"],
      redemptionBackstop: ["3.0", "2.9"],
    },
    normalizedSnapshotDigests: {
      scoreBearingFactsSha256: D,
      scoreBearingFreshnessSha256: E,
    },
  };
}

describe("V9 base-input identity", () => {
  it("canonicalizes set-like registry and methodology arrays", () => {
    const projected = projectBaseInputIdentityV1(baseInput());

    expect(projected.registry.activeAssetIds).toEqual(["usdc-circle", "usdt-tether"]);
    expect(projected.producerMethodologyVersions).toEqual({
      dexLiquidity: ["4.1", "4.2"],
      pegScore: ["7.25"],
      redemptionBackstop: ["2.9", "3.0"],
    });
  });

  it("produces an order-invariant prefixed SHA-256 identity", () => {
    const left = baseInput();
    const right = {
      ...baseInput(),
      registry: {
        ...baseInput().registry,
        activeAssetIds: ["usdc-circle", "usdt-tether"],
      },
      producerMethodologyVersions: {
        dexLiquidity: ["4.2", "4.1"],
        pegScore: ["7.25", "7.25"],
        redemptionBackstop: ["2.9", "3.0", "2.9"],
      },
    };

    const generationId = computeBaseInputGenerationId(left);
    expect(generationId).toBe(computeBaseInputGenerationId(right));
    expect(generationId.startsWith(BASE_INPUT_GENERATION_ID_PREFIX)).toBe(true);
    expect(generationId.slice(BASE_INPUT_GENERATION_ID_PREFIX.length)).toMatch(/^[a-f0-9]{64}$/);
    expect(generationId).toBe("report-cards-input:v1:f755e130eaac7816dfeffb7a18893d903308d166b1e22336f37f3a563b48cecd");
  });

  it.each([
    ["capture kind", (input: ReturnType<typeof baseInput>) => (input.captureKind = "public-reconstruction")],
    ["publication clock", (input: ReturnType<typeof baseInput>) => (input.publicationClockSec += 1)],
    ["source updatedAt", (input: ReturnType<typeof baseInput>) => (input.sourceUpdatedAtSec += 1)],
    ["registry universe", (input: ReturnType<typeof baseInput>) => input.registry.activeAssetIds.push("dai-makerdao")],
    ["registry fingerprint", (input: ReturnType<typeof baseInput>) => (input.registry.fingerprintSha256 = B)],
    ["DEX generation", (input: ReturnType<typeof baseInput>) => (input.producers.dex.generationId += "-retry")],
    ["DEX payload", (input: ReturnType<typeof baseInput>) => (input.producers.dex.payloadSha256 = C)],
    [
      "redemption generation",
      (input: ReturnType<typeof baseInput>) => (input.producers.redemption.generationId += "-retry"),
    ],
    ["redemption payload", (input: ReturnType<typeof baseInput>) => (input.producers.redemption.payloadSha256 = D)],
    [
      "producer methodology",
      (input: ReturnType<typeof baseInput>) => input.producerMethodologyVersions.pegScore.push("7.26"),
    ],
    [
      "score-bearing facts",
      (input: ReturnType<typeof baseInput>) => (input.normalizedSnapshotDigests.scoreBearingFactsSha256 = E),
    ],
    [
      "score-bearing freshness",
      (input: ReturnType<typeof baseInput>) => (input.normalizedSnapshotDigests.scoreBearingFreshnessSha256 = A),
    ],
  ])("changes when the %s changes", (_label, mutate) => {
    const original = baseInput();
    const changed = baseInput();
    mutate(changed);

    expect(computeBaseInputGenerationId(changed)).not.toBe(computeBaseInputGenerationId(original));
  });

  it("rejects source clocks later than the publication clock", () => {
    const input = baseInput();
    input.sourceUpdatedAtSec = input.publicationClockSec + 1;

    expect(() => projectBaseInputIdentityV1(input)).toThrow(/publication clock/);
  });

  it.each(["dexLiquidity", "pegScore", "redemptionBackstop"] as const)(
    "rejects an empty %s methodology version set after canonicalization",
    (field) => {
      const input = baseInput();
      input.producerMethodologyVersions[field] = [];

      expect(() => projectBaseInputIdentityV1(input)).toThrow(/At least one producer methodology version/);
    },
  );

  it.each([
    ["safety methodology", { methodologyVersion: "8.17" }],
    ["V9 policy", { v9PolicyDigest: A }],
    ["publication generation", { publicationGenerationId: "report-cards:8.17:1800000000" }],
    ["operator capture time", { capturedAt: "2027-01-15T08:00:00.000Z" }],
    ["operator revision", { registryRevision: "deadbeef" }],
  ])("rejects excluded %s metadata", (_label, extra) => {
    expect(() => projectBaseInputIdentityV1({ ...baseInput(), ...extra })).toThrow();
  });

  it("rejects a safety-score methodology key in the producer version object", () => {
    const input = baseInput() as ReturnType<typeof baseInput> & {
      producerMethodologyVersions: ReturnType<typeof baseInput>["producerMethodologyVersions"] & {
        safetyScore: string[];
      };
    };
    input.producerMethodologyVersions.safetyScore = ["8.17"];

    expect(() => projectBaseInputIdentityV1(input)).toThrow();
  });
});
