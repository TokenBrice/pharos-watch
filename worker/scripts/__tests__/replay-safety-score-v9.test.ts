import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { describe, expect, it } from "vitest";
import { buildSafetyScoreV9InputIdentity } from "@shared/lib/safety-score-v9-input-identity";
import { buildSafetyScoreV9BaselineExtension } from "../../src/lib/safety-score-v9-extension";
import { buildNativeV9InputCacheEntry } from "../../src/lib/safety-score-v9-native-input";
import { createNativeSafetyScoreV9FullRegistryInput } from "../../src/lib/__tests__/fixtures/safety-score-v9-full-registry-input";
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

  it("parses the native v4 capture and its v2 cache envelope through equivalent paths", async () => {
    const native = createNativeSafetyScoreV9FullRegistryInput();
    const cacheEntry = await buildNativeV9InputCacheEntry(
      native,
      buildSafetyScoreV9InputIdentity({
        methodologyVersion: native.methodologyVersion,
        baseInputGenerationId: native.baseInputGenerationId,
        publicationGenerationId: native.sourceGeneration,
      }),
    );

    await expect(parseSafetyScoreV9ReplayFixedInput(native)).resolves.toEqual(native);
    await expect(parseSafetyScoreV9ReplayFixedInput(JSON.parse(cacheEntry.value))).resolves.toEqual(native);
    await expect(parseSafetyScoreV9ReplayFixedInput(cacheEntry.value)).resolves.toEqual(native);
  });

  it("keeps the two capture generations on their own parsers", async () => {
    const legacy = exactFixedInput();
    const native = createNativeSafetyScoreV9FullRegistryInput();
    const legacyEnvelope = JSON.parse((await buildReportCardsFixedInputCacheEntry(legacy)).value) as {
      schemaVersion: number;
    };
    const nativeEnvelope = JSON.parse(
      (
        await buildNativeV9InputCacheEntry(
          native,
          buildSafetyScoreV9InputIdentity({
            methodologyVersion: native.methodologyVersion,
            baseInputGenerationId: native.baseInputGenerationId,
            publicationGenerationId: native.sourceGeneration,
          }),
        )
      ).value,
    ) as { schemaVersion: number };

    expect(legacyEnvelope.schemaVersion).toBe(1);
    expect(nativeEnvelope.schemaVersion).toBe(2);
    expect((await parseSafetyScoreV9ReplayFixedInput(legacy)).schemaVersion).toBe(3);
    expect((await parseSafetyScoreV9ReplayFixedInput(native)).schemaVersion).toBe(4);
    // A v2 envelope can never carry a V8-shaped capture.
    await expect(parseSafetyScoreV9ReplayFixedInput({ ...nativeEnvelope, schemaVersion: 1 })).rejects.toThrow();
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

  it("replays a registry-fingerprint mismatch only behind --allow-registry-mismatch", async () => {
    // A capture frozen before a curation commit carries the registry
    // fingerprint of the tree it was captured from. Simulate that by rewriting
    // the fingerprint and dropping the derived base identity so the normalizer
    // re-derives it from the rewritten payload, exactly like a real capture
    // replayed after the registry moved.
    const { baseInputGenerationId: _derived, ...capture } = exactFixedInput();
    const staleCapture = { ...capture, registryFingerprint: "b".repeat(64) };

    const dir = mkdtempSync(resolve(tmpdir(), "pharos-v9-replay-registry-"));
    try {
      const input = resolve(dir, "stale-registry.json");
      const output = resolve(dir, "output.json");
      writeTestFile(input, JSON.stringify(staleCapture));
      const args = ["--input", input, "--output", output, "--published-at", String(PUBLISHED_AT_SEC)];

      await expect(runSafetyScoreV9ReplayCli(args)).rejects.toThrow(
        /registry fingerprint .* does not match fixed input/,
      );

      await runSafetyScoreV9ReplayCli([...args, "--allow-registry-mismatch"]);
      const replayed = JSON.parse(readTestFile(output)) as {
        pipeline: {
          extension: { registryFingerprint: string };
          candidate: { cards: { id: string }[] };
        };
      };
      // The override makes the replay adopt the capture's registry identity, so
      // the trusted compile path's extension-vs-input equality check still holds.
      expect(replayed.pipeline.extension.registryFingerprint).toBe("b".repeat(64));
      expect(replayed.pipeline.candidate.cards.map((card) => card.id)).toEqual(["usdc-circle"]);
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
