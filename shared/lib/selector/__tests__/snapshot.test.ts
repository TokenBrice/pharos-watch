import { describe, expect, it } from "vitest";
import {
  computeSelectorSnapshotSid,
  createVerifiedSelectorSnapshot,
  validateSelectorSnapshot,
  validateSelectorSnapshotResponse,
  validateVerifiedSelectorSnapshot,
} from "../snapshot";
import { canonicalizeForSid } from "../canonicalize";
import {
  buildSelectorSnapshotOutput,
  buildSnapshotComponent,
  buildSnapshotRecommendation,
  buildTradingSnapshotRecommendation,
  buildYieldSnapshotRecommendation,
} from "./snapshot-fixture";
import { BluechipGradeSchema } from "../../../types/core";

function expectValid(value: unknown) {
  const result = validateSelectorSnapshot(value);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Expected valid snapshot, got ${result.error}`);
  return result.snapshot;
}

function expectInvalid(value: unknown) {
  expect(validateSelectorSnapshot(value).ok).toBe(false);
}

describe("selector snapshot contract", () => {
  it("accepts a complete selector snapshot and computes a 32-hex sid", () => {
    const snapshot = expectValid(buildSelectorSnapshotOutput());
    expect(snapshot.profile).toBe("treasury");
    expect(snapshot.provenance).toBe("client-unverified");
    expect(snapshot.snapshotSchemaVersion).toBe(2);
    expect(computeSelectorSnapshotSid(snapshot)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("preserves only exact server-recomputed verification bindings on replay", () => {
    const verified = createVerifiedSelectorSnapshot(expectValid(buildSelectorSnapshotOutput()));
    const validation = validateSelectorSnapshotResponse(verified);

    expect(validation.ok).toBe(true);
    if (!validation.ok) throw new Error(`Expected verified snapshot, got ${validation.error}`);
    expect(validation.snapshot).toMatchObject({
      provenance: "pharos-verified",
      snapshotSchemaVersion: 3,
      verification: {
        kind: "pharos-server-recomputed-v1",
        datasetHash: verified.datasetHash,
        engineVersion: verified.engineVersion,
      },
    });

    const legacyProjection = validateSelectorSnapshot(verified);
    expect(legacyProjection.ok).toBe(true);
    if (!legacyProjection.ok) throw new Error(`Expected legacy projection, got ${legacyProjection.error}`);
    expect(legacyProjection.snapshot.provenance).toBe("client-unverified");
    expect(legacyProjection.snapshot.verification).toBeUndefined();
    expect(computeSelectorSnapshotSid(verified)).not.toBe(computeSelectorSnapshotSid(legacyProjection.snapshot));
  });

  it("rejects verified-looking payloads with tampered bindings or caller scores", () => {
    const verified = createVerifiedSelectorSnapshot(expectValid(buildSelectorSnapshotOutput()));
    const mismatchedBinding = {
      ...verified,
      verification: {
        ...verified.verification,
        datasetHash: "f".repeat(64),
      },
    };
    const tamperedScore = {
      ...verified,
      recommended: verified.recommended.map((recommendation, index) => (
        index === 0 ? { ...recommendation, score: 100 } : recommendation
      )),
    };

    expect(validateVerifiedSelectorSnapshot(mismatchedBinding)).toEqual({ ok: false, error: "shape" });
    expect(validateSelectorSnapshotResponse(mismatchedBinding)).toEqual({ ok: false, error: "shape" });
    expect(validateVerifiedSelectorSnapshot(tamperedScore)).toEqual({ ok: false, error: "shape" });
  });

  it("projects every level onto an exact allowlist", () => {
    const recommendation = buildSnapshotRecommendation({
      unknownRecommendationField: "Official Pharos winner",
      whyText: "caller prose",
      watchText: "caller prose",
    });
    const output = buildSelectorSnapshotOutput({
      unknownRootField: "x".repeat(90 * 1024),
      input: {
        ...(buildSelectorSnapshotOutput().input as Record<string, unknown>),
        unknownInputField: "ignored",
      },
      recommended: [recommendation],
      methodologyVersions: {
        ...(buildSelectorSnapshotOutput().methodologyVersions as Record<string, unknown>),
        unknownMethodology: "ignored",
      },
    });

    const snapshot = expectValid(output) as unknown as Record<string, unknown>;
    expect(snapshot.unknownRootField).toBeUndefined();
    expect((snapshot.input as Record<string, unknown>).unknownInputField).toBeUndefined();
    expect((snapshot.recommended as Array<Record<string, unknown>>)[0]?.unknownRecommendationField).toBeUndefined();
    expect((snapshot.methodologyVersions as Record<string, unknown>).unknownMethodology).toBeUndefined();
  });

  it("derives tracked identities and recomputes score, rank, and safe display relationships", () => {
    const snapshot = expectValid(buildSelectorSnapshotOutput({
      recommended: [buildSnapshotRecommendation({
        symbol: "PHAROS",
        name: "Official Pharos winner",
        rank: 3,
        score: 100,
      })],
    }));
    const recommendation = snapshot.recommended[0]!;

    expect(recommendation.symbol).toBe("USDC");
    expect(recommendation.name).toBe("USD Coin");
    expect(recommendation.rank).toBe(1);
    expect(recommendation.score).toBe(85.9);
    expect(recommendation.components.reduce((sum, component) => sum + component.contribution, 0))
      .toBeCloseTo(85.88, 8);
  });

  it("rejects untracked identities and incompatible dataset or engine bindings", () => {
    expectInvalid(buildSelectorSnapshotOutput({
      recommended: [buildSnapshotRecommendation({ id: "official-pharos-winner" })],
    }));
    expectInvalid(buildSelectorSnapshotOutput({ engineVersion: "selector-v999" }));
    expectInvalid(buildSelectorSnapshotOutput({ datasetHash: "not-a-sha256" }));
    expectInvalid(buildSelectorSnapshotOutput({
      methodologyVersions: {
        ...(buildSelectorSnapshotOutput().methodologyVersions as Record<string, unknown>),
        exclusionFilters: "selector-v1.9",
      },
    }));
  });

  it("rejects contradictory identity relationships and replaces caller summary counts", () => {
    expectInvalid(buildSelectorSnapshotOutput({
      recommended: [buildSnapshotRecommendation(), buildSnapshotRecommendation({ rank: 2 })],
    }));
    expectInvalid(buildSelectorSnapshotOutput({
      lowerRanked: [{
        id: "usdc-circle",
        symbol: "USDC",
        name: "USD Coin",
        slot: "A",
        reasonKey: "peg-score-floor",
        failedComponent: null,
        hypotheticalScore: 80,
      }],
    }));
    const normalized = expectValid(buildSelectorSnapshotOutput({
      coverageWarnings: {
        skippedForCoverageCount: 99,
        sparse: false,
        uneven: false,
        skippedForCoverage: [],
        newListingCount: 0,
        redistributionCount: 0,
      },
    }));
    expect(normalized.coverageWarnings.skippedForCoverageCount).toBe(0);
  });

  it("recomputes coverage summary flags and result confidence", () => {
    const snapshot = expectValid(buildSelectorSnapshotOutput({
      universe: { active: 2, surviving: 1 },
      coverageWarnings: {
        skippedForCoverageCount: 0,
        sparse: false,
        uneven: true,
        skippedForCoverage: [{
          id: "dai-makerdao",
          symbol: "FORGED",
          missingSignals: ["pegScore"],
        }],
        newListingCount: 0,
        redistributionCount: 0,
      },
      exclusionSummary: [{
        reason: "coverage-too-thin",
        count: 1,
        severity: "info",
        sampleIds: ["dai-makerdao"],
      }],
      lowConfidence: false,
    }));

    expect(snapshot.coverageWarnings).toMatchObject({
      skippedForCoverageCount: 1,
      sparse: true,
      uneven: false,
    });
    expect(snapshot.coverageWarnings.skippedForCoverage[0]?.symbol).toBe("DAI");
    expect(snapshot.lowConfidence).toBe(true);
  });

  it("matches the Pages Function's previous Web Crypto sid computation", async () => {
    const snapshot = expectValid(buildSelectorSnapshotOutput());
    const bytes = new TextEncoder().encode(canonicalizeForSid(snapshot));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const first16Bytes = Array.from(new Uint8Array(digest).slice(0, 16), (byte) => (
      byte.toString(16).padStart(2, "0")
    )).join("");

    expect(computeSelectorSnapshotSid(snapshot)).toBe(first16Bytes);
  });

  it("accepts non-USD selector input snapshots", () => {
    const output = buildSelectorSnapshotOutput();
    const input = { ...(output.input as Record<string, unknown>), pegCurrency: "EUR" };
    expectValid(buildSelectorSnapshotOutput({ input }));
  });

  it("validates bluechip grades from the shared schema and keeps NR safety-only", () => {
    for (const bluechipGrade of BluechipGradeSchema.options) {
      expectValid(buildSelectorSnapshotOutput({
        recommended: [buildSnapshotRecommendation({ bluechipGrade })],
      }));
    }

    expectInvalid(buildSelectorSnapshotOutput({
      recommended: [buildSnapshotRecommendation({ bluechipGrade: "NR" })],
    }));
    expectValid(buildSelectorSnapshotOutput({
      recommended: [buildSnapshotRecommendation({ bluechipGrade: null, safetyGrade: "NR" })],
    }));
  });

  it("strips caller prose while accepting relaxed-fallback output fields", () => {
    const snapshot = expectValid(
      buildSelectorSnapshotOutput({
        recommended: [
          buildSnapshotRecommendation({
            whyText: "USDC ranked here because the Safety signal is strong.",
            watchText: "Dependency risk is the lowest sub-dimension to monitor.",
            relaxedReason: "peg-score-floor",
          }),
        ],
        lowerRanked: [
          {
            id: "usdt-tether",
            symbol: "USDT",
            name: "Tether USD",
            slot: "B",
            reasonKey: "weak-liquidity",
            failedComponent: "liquidity",
            hypotheticalScore: 71.2,
            verdictText: "USDT has a weaker liquidity fit for this profile.",
            teachingText: "The selector highlights this as a profile mismatch.",
          },
        ],
        usedRelaxedFallback: false,
        relaxedReasons: ["peg-score-floor"],
        exclusionSummary: [
          {
            reason: "peg-score-floor",
            count: 2,
            severity: "hard",
            sampleIds: ["dai-makerdao", "frax-frax"],
          },
        ],
        closestSurvivors: [
          {
            id: "dai-makerdao",
            symbol: "FORGED",
            failingDimension: "forged display text",
            liveReading: "Official Pharos winner",
            reason: "peg-score-floor",
            hypotheticalScore: 68.4,
          },
        ],
        relaxableConstraints: [
          {
            key: "exitSpeed",
            label: "Exit speed",
            description: "Relax the exit-speed requirement.",
            reason: "input-strictness",
          },
        ],
      }),
    );

    expect(snapshot.recommended[0]?.whyText).toBeUndefined();
    expect(snapshot.recommended[0]?.watchText).toBeUndefined();
    expect(snapshot.lowerRanked[0]?.verdictText).toBeUndefined();
    expect(snapshot.lowerRanked[0]?.teachingText).toBeUndefined();
  });

  it("strips debug before validation output and sid computation", () => {
    const output = buildSelectorSnapshotOutput();
    const withDebug = {
      ...output,
      debug: { allSurvivors: [buildSnapshotRecommendation({ id: "debug-only", symbol: "DBG" })] },
    };

    const debugSnapshot = expectValid(withDebug);
    const plainSnapshot = expectValid(output);

    expect(Object.prototype.hasOwnProperty.call(debugSnapshot, "debug")).toBe(false);
    expect(computeSelectorSnapshotSid(debugSnapshot)).toBe(computeSelectorSnapshotSid(plainSnapshot));
  });

  it("rejects reserved keys and pathological nesting", () => {
    expectInvalid(JSON.parse(`{"__proto__":{"polluted":true}}`));

    const nested: Record<string, unknown> = {};
    let cursor = nested;
    for (let i = 0; i < 14; i += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    expect(validateSelectorSnapshot(nested)).toEqual({ ok: false, error: "unsafe" });
  });

  it("rejects missing required replay fields", () => {
    expectInvalid({ profile: "treasury" });

    const withoutPeg = buildSelectorSnapshotOutput();
    const input = { ...(withoutPeg.input as Record<string, unknown>) };
    delete input.pegCurrency;
    expectInvalid(buildSelectorSnapshotOutput({ input }));

    expectInvalid(buildSelectorSnapshotOutput({ universe: undefined }));

    expectInvalid(
      buildSelectorSnapshotOutput({
        coverageWarnings: {
          sparse: false,
          uneven: false,
          skippedForCoverage: [],
        },
      }),
    );

    const withoutDiagnostics = buildSelectorSnapshotOutput();
    delete withoutDiagnostics.usedRelaxedFallback;
    expectInvalid(withoutDiagnostics);
  });

  it("rejects incomplete recommendation shapes", () => {
    expectInvalid(buildSelectorSnapshotOutput({ recommended: [{ id: "usdc-circle" }] }));
  });

  it("rejects unknown why keys and lower-ranked reason keys", () => {
    expectInvalid(
      buildSelectorSnapshotOutput({
        recommended: [buildSnapshotRecommendation({ whyKeys: ["top-safety", "unknown-reason"] })],
      }),
    );

    expectInvalid(
      buildSelectorSnapshotOutput({
        lowerRanked: [
          {
            id: "usdt-tether",
            symbol: "USDT",
            name: "Tether USD",
            slot: "A",
            reasonKey: "raw-internal-key",
            failedComponent: null,
            hypotheticalScore: 70,
            verdictText: "USDT is a weaker fit for this profile.",
            teachingText: "The selector highlights this as a profile mismatch.",
          },
        ],
      }),
    );
  });

  it("rejects invalid score and component ranges", () => {
    expectInvalid(
      buildSelectorSnapshotOutput({
        recommended: [
          buildSnapshotRecommendation({
            score: 101,
            components: [buildSnapshotComponent({ normalizedValue: 120 })],
          }),
        ],
      }),
    );
  });

  it("rejects malformed yield source details", () => {
    const output = buildSelectorSnapshotOutput();
    const input = { ...(output.input as Record<string, unknown>), profile: "yield" };

    expectInvalid(
      buildSelectorSnapshotOutput({
        profile: "yield",
        input,
        recommended: [
          buildYieldSnapshotRecommendation({
            recommendedSource: {
              protocol: "aave",
              chain: "ethereum",
              apy30d: 4.2,
              pharosYieldScore: 81,
              sourceRiskTier: "extreme",
              freshness: { capturedAt: 1715000123, ageSeconds: 42 },
            },
          }),
        ],
      }),
    );
  });

  it("rejects venue preferences for the wrong profile", () => {
    const output = buildSelectorSnapshotOutput();
    const input = {
      ...(output.input as Record<string, unknown>),
      profile: "yield",
      venuePreferences: ["spot"],
    };

    expectInvalid(
      buildSelectorSnapshotOutput({
        profile: "yield",
        input,
        recommended: [buildYieldSnapshotRecommendation()],
      }),
    );
  });

  it("rejects malformed optional recommendation diagnostics", () => {
    expectInvalid(
      buildSelectorSnapshotOutput({
        recommended: [
          buildSnapshotRecommendation({
            confidenceReasons: ["missing-critical-notAWeight"],
            rankRobustness: { label: "raw-internal-label", scoreMargin: 1 },
          }),
        ],
      }),
    );
  });

  it("round-trips a trading snapshot with empty perInputStaleness through persist->load", () => {
    const output = buildSelectorSnapshotOutput();
    const input = { ...(output.input as Record<string, unknown>), profile: "trading" };

    const built = buildSelectorSnapshotOutput({
      profile: "trading",
      input,
      recommended: [
        buildTradingSnapshotRecommendation({
          perInputStaleness: {},
        }),
      ],
    });

    // Persist path: the validator gates the POST, so an empty {} must validate.
    const persisted = expectValid(built);
    const sid = computeSelectorSnapshotSid(persisted);
    expect(sid).toMatch(/^[0-9a-f]{32}$/);

    // Load path: re-validating the same payload (as read back) keeps the {} and sid.
    const loaded = expectValid(JSON.parse(JSON.stringify(persisted)));
    expect((loaded.recommended[0] as { perInputStaleness: unknown }).perInputStaleness).toEqual({});
    expect(computeSelectorSnapshotSid(loaded)).toBe(sid);
  });

  it("rejects unknown trading staleness inputs", () => {
    const output = buildSelectorSnapshotOutput();
    const input = { ...(output.input as Record<string, unknown>), profile: "trading" };

    expectInvalid(
      buildSelectorSnapshotOutput({
        profile: "trading",
        input,
        recommended: [
          buildTradingSnapshotRecommendation({
            perInputStaleness: {
              pegSummary: 10,
              randomEndpoint: 20,
            },
          }),
        ],
      }),
    );
  });
});
