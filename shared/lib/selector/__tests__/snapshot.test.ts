import { describe, expect, it } from "vitest";
import {
  computeSelectorSnapshotSid,
  validateSelectorSnapshot,
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
    expect(computeSelectorSnapshotSid(snapshot)).toMatch(/^[0-9a-f]{32}$/);
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

  it("accepts engine prose and relaxed-fallback output fields", () => {
    expectValid(
      buildSelectorSnapshotOutput({
        recommended: [
          buildSnapshotRecommendation({
            whyText: "USDC ranked here because the Safety signal is strong.",
            watchText: "Dependency risk is the lowest sub-dimension to monitor.",
            relaxedReason: "coverage-too-thin",
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
        relaxedReasons: ["coverage-too-thin"],
        exclusionSummary: [
          {
            reason: "coverage-too-thin",
            count: 2,
            severity: "info",
            sampleIds: ["coverage-thin-test"],
          },
        ],
        closestSurvivors: [
          {
            id: "near-fit",
            symbol: "NEAR",
            failingDimension: "liquidity",
            liveReading: "Liquidity 62",
            reason: "liquidity-floor",
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
