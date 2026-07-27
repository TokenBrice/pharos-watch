import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { describe, expect, it } from "vitest";
import { buildSafetyScoreV9BaselineExtension } from "../../src/lib/safety-score-v9-extension";
import {
  buildReportCardsFixedInputCacheEntry,
  createReportCardsFixedInput,
} from "../../src/lib/report-cards-fixed-input";
import {
  buildSafetyScoreV9ReplayArtifact,
  parseSafetyScoreV9PublishedAtSec,
  parseSafetyScoreV9ReplayFixedInput,
  runSafetyScoreV9ReplayCli,
  serializeSafetyScoreV9ReplayArtifact,
} from "../replay-safety-score-v9";

const CLOCK_SEC = 1_784_505_600;
const PUBLISHED_AT_SEC = CLOCK_SEC + 10;
const PUBLISHED_AT_ISO = new Date(PUBLISHED_AT_SEC * 1_000).toISOString();

function writeTestFile(path: string, value: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- isolated temporary test path.
  writeFileSync(path, value);
}

function readTestFile(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- isolated temporary test path.
  return readFileSync(path, "utf8");
}

function exactFixedInput() {
  return createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    activeAssetIds: ["usdc-circle"],
    capturedAt: new Date(CLOCK_SEC * 1_000).toISOString(),
    sourceGeneration: "report-cards:fixture:v9-replay",
    dexGenerationId: `dex-liquidity-${CLOCK_SEC - 100}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: "registry:fixture",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec: CLOCK_SEC,
    updatedAt: CLOCK_SEC,
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: CLOCK_SEC - 100, ageSeconds: 100, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    pegDataById: {},
    activeDepegPeakBpsById: {},
    dexLiqMap: {
      "usdc-circle": {
        liquidityScore: 90,
        concentrationHhi: 0.5,
        poolCount: 1,
        chainCount: 1,
        coverageClass: "primary",
        coverageConfidence: 1,
        liquidityEvidenceClass: "measured",
        hasMeasuredLiquidityEvidence: true,
        effectiveTvlUsd: 1_000_000,
        balanceMeasuredTvlUsd: 1_000_000,
        organicMeasuredTvlUsd: 1_000_000,
        methodologyVersion: "dex:fixture-v1",
        updatedAt: CLOCK_SEC - 100,
      },
    },
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: { "usdc-circle": false },
    liveReserveMap: {},
    liveReserveProvenanceMap: {},
    chainCirculatingById: {
      "usdc-circle": {
        ethereum: {
          current: 10_000_000,
          circulatingPrevDay: 10_000_000,
          circulatingPrevWeek: 10_000_000,
          circulatingPrevMonth: 10_000_000,
        },
      },
    },
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
}

describe("Safety Score v9 deterministic replay CLI", () => {
  it("parses raw exact JSON and the production cache envelope through equivalent paths", async () => {
    const fixedInput = exactFixedInput();
    const cacheEntry = await buildReportCardsFixedInputCacheEntry(fixedInput);

    await expect(parseSafetyScoreV9ReplayFixedInput(fixedInput)).resolves.toEqual(fixedInput);
    await expect(parseSafetyScoreV9ReplayFixedInput(JSON.parse(cacheEntry.value))).resolves.toEqual(fixedInput);
    await expect(parseSafetyScoreV9ReplayFixedInput(cacheEntry.value)).resolves.toEqual(fixedInput);
  });

  it("serializes a byte-identical V9 replay artifact from explicit clocks", () => {
    const args = {
      fixedInput: exactFixedInput(),
      publishedAtSec: PUBLISHED_AT_SEC,
    };
    const artifact = buildSafetyScoreV9ReplayArtifact(args);
    const left = serializeSafetyScoreV9ReplayArtifact(artifact);
    const right = serializeSafetyScoreV9ReplayArtifact(buildSafetyScoreV9ReplayArtifact(structuredClone(args)));
    const parsed = JSON.parse(left) as {
      schemaVersion: number;
      kind: string;
      lifecycle: string;
      releaseAuthorization: { authorized: boolean; reason: string };
      pipeline: { candidate: { lifecycle: string; publishedAtSec: number } };
    };

    expect(right).toBe(left);
    expect(left.endsWith("\n")).toBe(true);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      kind: "safety-score-v9-candidate-replay",
      lifecycle: "active",
      releaseAuthorization: { authorized: false, reason: "v9-replay-only" },
      pipeline: {
        candidate: {
          lifecycle: "active",
          publishedAtSec: PUBLISHED_AT_SEC,
        },
      },
    });
    const compiledUsdc = artifact.pipeline.compiledFacts.assets[0]!;
    const incompleteControls = compiledUsdc.controls.filter(
      (control) =>
        control.capSemantics.kind === "unknown" ||
        control.claimImpairment === "unknown" ||
        control.economicLossScope === "unknown",
    );
    expect(compiledUsdc.controlStatus.observationState).toBe("known");
    expect(incompleteControls.length).toBeGreaterThan(0);
    expect(incompleteControls.every((control) => control.status.observationState === "bounded-unknown")).toBe(true);
  });

  it("writes identical canonical output for raw JSON and a cache envelope", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pharos-v9-replay-"));
    try {
      const fixedInput = exactFixedInput();
      const cacheEntry = await buildReportCardsFixedInputCacheEntry(fixedInput);
      const rawPath = resolve(dir, "fixed.json");
      const envelopePath = resolve(dir, "fixed-cache.json");
      const extensionPath = resolve(dir, "extension.json");
      const rawOutput = resolve(dir, "raw-output.json");
      const envelopeOutput = resolve(dir, "envelope-output.json");
      writeTestFile(rawPath, JSON.stringify(fixedInput));
      writeTestFile(envelopePath, cacheEntry.value);
      writeTestFile(extensionPath, JSON.stringify(buildSafetyScoreV9BaselineExtension(fixedInput)));

      const commonArgs = ["--published-at", PUBLISHED_AT_ISO];
      await runSafetyScoreV9ReplayCli([
        "--input",
        rawPath,
        "--output",
        rawOutput,
        "--extension",
        extensionPath,
        ...commonArgs,
      ]);
      await runSafetyScoreV9ReplayCli(["--input", envelopePath, "--output", envelopeOutput, ...commonArgs]);

      expect(readTestFile(envelopeOutput)).toBe(readTestFile(rawOutput));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts only explicit whole-second times and v9-rc-N overrides", async () => {
    expect(parseSafetyScoreV9PublishedAtSec(PUBLISHED_AT_ISO)).toBe(PUBLISHED_AT_SEC);
    expect(parseSafetyScoreV9PublishedAtSec(String(PUBLISHED_AT_SEC))).toBe(PUBLISHED_AT_SEC);
    expect(() => parseSafetyScoreV9PublishedAtSec(new Date(PUBLISHED_AT_SEC * 1_000 + 1).toISOString())).toThrow(
      /whole Unix seconds/,
    );

    const dir = mkdtempSync(resolve(tmpdir(), "pharos-v9-replay-rc-"));
    try {
      const input = resolve(dir, "fixed.json");
      const output = resolve(dir, "output.json");
      writeTestFile(input, JSON.stringify(exactFixedInput()));
      await runSafetyScoreV9ReplayCli([
        "--input",
        input,
        "--output",
        output,
        "--published-at",
        String(PUBLISHED_AT_SEC),
        "--release-candidate-id",
        "v9-rc-2",
      ]);
      expect(JSON.parse(readTestFile(output)).pipeline.candidate.candidateId).toBe("v9-rc-2");

      await expect(
        runSafetyScoreV9ReplayCli([
          "--input",
          input,
          "--output",
          output,
          "--published-at",
          String(PUBLISHED_AT_SEC),
          "--release-candidate-id",
          "candidate-latest",
        ]),
      ).rejects.toThrow(/must match v9-rc-N/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
