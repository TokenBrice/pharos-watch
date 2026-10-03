import { buildSync } from "esbuild";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

const ROOT = resolve(import.meta.dirname, "../../../..");
const TEST_DIRECTORY = resolve(import.meta.dirname);
const HEAP_LIMIT_MIB = 128;
// The 6.75 MB ceiling preserves readable lossless tuples and at least15% raw headroom under8 MB.
// The compile memory probe is the true gate, not a tighter incidental JSON ratio.
const PUBLICATION_BYTE_BUDGET = 6_750_000;
// Frozen pre-Phase-2 BASE from 335ecb0f5, smoke-out/base-20261003-0149.json
// .pipeline.candidate encoded with stableJsonStringifyV1 and gzipCanonicalJson;
// uncompressedBytes/contentSha256 below are the persisted pre-gzip bytes.
const FROZEN_BASE = {
  path: "agents/2026-10-01-curation-pass/nr/smoke-out/base-20261003-0149.json",
  bytes: 5_253_316,
  digest: "2a2c21583cc6f8c5469824042e06af590d8d73e6c6d07b552c6982a455463a93",
  inputGenerationId: "report-cards-input:v1:ffa7cce9ff70b8c7fc050d715ae47d89026e224cc22fb5929e86f978ba230fe8",
} as const;
// Node regression bound only. Gate 0 does not establish 128 MB Worker-isolate safety.
const CONTAGION_HEAP_LIMIT_MIB = 256;
let temporaryDirectory = "";
let bundledProbe = "";

describe("Safety Score V9 canonical publication resource budget", {
  timeout: 60_000,
}, () => {
  beforeAll(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "pharos-v9-resource-"));
    bundledProbe = join(temporaryDirectory, "probe.mjs");
    buildSync({
      stdin: {
        contents: `
          import { readFileSync } from "node:fs";
          import { normalizeFixedInput } from "../report-cards-fixed-input.ts";
          import { buildSafetyScoreV9PublicationFromNormalizedInput } from "../safety-score-v9/candidate.ts";
          import { parseSafetyScoreV9Publication, serializeSafetyScoreV9Publication } from "../safety-score-v9/publication-codec.ts";
          import { buildSafetyScoreV9AcceptedPublicationBaseline } from "../safety-score-v9/publication-assessment.ts";
          import { createSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input.ts";
          import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
          import { buildSafetyScoreV9BaselineExtensionFromNormalizedInput } from "../safety-score-v9/extension.ts";
          import { compileSafetyScoreV9FactSetFromNormalizedInput } from "../safety-score-v9/fact-set.ts";
          import { evaluateV9ContagionScenario } from "@shared/lib/safety-score-v9/contagion";
          import { loadV9CandidateMethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
          import { buildSafetyScoreV9PublicationReplayCapture } from "../safety-score-v9/publication-replay-capture.ts";
          import { createReportCardEvidenceJournalV1 } from "@shared/lib/report-card-evidence-journal";
          import { createSupplyAttributionJournalV1 } from "@shared/lib/safety-score-v9-supply-attribution-journal";
          import { buildSafetyScoreV9PegProvenanceSummary, projectSafetyScoreV9PegScoreResult } from "../safety-score-v9/peg-provenance.ts";
          import { computePegScore } from "@shared/lib/peg-score";

          const capturePath = process.env.SAFETY_SCORE_V9_RESOURCE_CAPTURE;
          const input = capturePath
            ? JSON.parse(readFileSync(capturePath, "utf8")).fixedInput
            : normalizeFixedInput(createSafetyScoreV9FullRegistryInput());
          if (!capturePath) {
          input.evidenceJournalById = Object.fromEntries(input.activeAssetIds.slice(0, 250).map(assetId => [
            assetId, [0, 1].map(index => createReportCardEvidenceJournalV1({
              schemaVersion: 1, lane: "reserve", assetId, attemptId: "resource-reserve:" + index,
              sourceId: "resource-reserve-adapter", sourceOriginClass: "onchain-observation",
              attemptCode: "reserve.collector.attempted", admissionCode: "reserve.admission.accepted",
              fallbackCode: "reserve.fallback.not-used", attemptedAtSec: input.clockSec - 20 + index,
              completedAtSec: input.clockSec - 10 + index, sourceTimestampSec: input.clockSec - 20 + index,
              sourceBlock: null, contentSha256: "a".repeat(64), sidecarMaterializationSha256: null,
            })),
          ]));
          input.supplyAttributionJournalById = {
            "wm-m0": [createSupplyAttributionJournalV1({
              schemaVersion: 1, lane: "supply-attribution", assetId: "wm-m0", attemptId: "resource-supply:1",
              sourceId: "wm.reviewed-deployment-unit-partition.v1", sourceOriginClass: "onchain-observation",
              baseInputGenerationId: input.baseInputGenerationId, sourceGeneration: input.sourceGeneration,
              registryFingerprint: input.registryFingerprint, routeInventoryDigest: "b".repeat(64),
              attemptCode: "supply-attribution.collector.attempted", admissionCode: "supply-attribution.admission.accepted",
              fallbackCode: "supply-attribution.fallback.not-used", attemptedAtSec: input.clockSec - 20,
              completedAtSec: input.clockSec - 10, scoringClockSec: input.clockSec,
              sourceObservedAtSec: input.clockSec - 20, failedRouteId: null, contentSha256: "c".repeat(64),
            })],
          };
          input.pegProvenanceById = Object.fromEntries(input.activeAssetIds.map(assetId => [
            assetId, buildSafetyScoreV9PegProvenanceSummary({
              assetId, events: [], trackingStartSec: input.clockSec - 180 * 86400, clockSec: input.clockSec,
              expectedLegacyInclusive: projectSafetyScoreV9PegScoreResult(computePegScore([], input.clockSec - 180 * 86400, input.clockSec)),
            }),
          ]));
          }
          let extension = buildSafetyScoreV9BaselineExtensionFromNormalizedInput(input, { allowRegistryMismatch: Boolean(capturePath) });
          if (process.env.CONTAGION_MATRIX === "1") {
            const compiled = compileSafetyScoreV9FactSetFromNormalizedInput(input, extension);
            const { v9FactSetDigest, ...rawCompileInput } = compiled;
            extension = null;
            const policy = loadV9CandidateMethodologyPolicy(input.clockSec);
            const counts = [];
            const started = performance.now();
            for (const assetId of ["usdc-circle", "usdt-tether", "usds-sky"]) {
              for (const shock of [
                { kind: "score-limit", assetId, dimension: "final", limit: 40 },
                { kind: "depeg", assetId, activeDepegBps: 1000, template: "one-day-history-and-exit-held" },
                { kind: "mint-control-compromise", assetId },
              ]) {
                const result = evaluateV9ContagionScenario({
                  rawCompileInput, policy, clock: input.clockSec,
                  publicationGenerationId: "resource-fixture",
                }, { id: assetId + ":" + shock.kind, shocks: [shock] });
                counts.push(result.manifest);
                globalThis.gc?.();
              }
            }
            process.stdout.write(JSON.stringify({
              expected: input.activeAssetIds.length, counts,
              wallMs: performance.now() - started,
            }));
            process.exit(0);
          }
          const fixtureMetrics = {
            extensionAssets: extension.assets.length,
            researchEvidenceCount: extension.assets.reduce((count, asset) => count + asset.researchEvidence.length, 0),
            componentEvidenceCount: extension.assets.reduce((count, asset) => count + asset.componentEvidence.length, 0),
          };
          if (capturePath) {
            const result = buildSafetyScoreV9PublicationFromNormalizedInput({
              fixedInput: input, extension, publishedAtSec: input.clockSec,
            });
            const stored = await serializeSafetyScoreV9Publication(result.candidate);
            const metadata = JSON.parse(stored);
            process.stdout.write(JSON.stringify({ baseInputGenerationId: result.candidate.baseInputGenerationId,
              candidateBytes: metadata.uncompressedBytes, compressedBytes: metadata.compressedBytes }));
            process.exit(0);
          }
          let prior = buildSafetyScoreV9PublicationFromNormalizedInput({
            fixedInput: input,
            extension,
            publishedAtSec: input.clockSec,
          });
          extension = null;
          let acceptedStored = await serializeSafetyScoreV9Publication(prior.candidate);
          prior = null;
          await new Promise((resolve) => setImmediate(resolve));
          globalThis.gc?.();
          let accepted = await parseSafetyScoreV9Publication(acceptedStored);
          const acceptedBaseline = buildSafetyScoreV9AcceptedPublicationBaseline(accepted);
          accepted = null;
          acceptedStored = null;
          await new Promise((resolve) => setImmediate(resolve));
          globalThis.gc?.();
          const result = buildSafetyScoreV9PublicationFromNormalizedInput({
            fixedInput: input,
            publishedAtSec: input.clockSec,
          });
          globalThis.gc?.();
          const captureMemoryBefore = process.memoryUsage();
          const captureCpuBefore = process.cpuUsage();
          const capture = await buildSafetyScoreV9PublicationReplayCapture(result.candidate, input, null);
          const captureCpu = process.cpuUsage(captureCpuBefore);
          const captureMemoryAfter = process.memoryUsage();
          const stored = await serializeSafetyScoreV9Publication(result.candidate);
          const metadata = JSON.parse(stored);
          process.stdout.write(JSON.stringify({
            ...fixtureMetrics,
            baseInputGenerationId: result.candidate.baseInputGenerationId,
            expected: input.activeAssetIds.length,
            cards: result.candidate.cards.length,
            rated: result.candidate.completeness.ratedCount,
            factDigest: result.candidate.factSetDigest,
            resultDigest: result.candidate.resultDigest,
            acceptedBaselineBytes: new TextEncoder().encode(
              JSON.stringify(acceptedBaseline),
            ).byteLength,
            candidateBytes: metadata.uncompressedBytes,
            compressedBytes: metadata.compressedBytes,
            storedBytes: new TextEncoder().encode(stored).byteLength,
            replayCaptureStoredBytes: capture.storedBytes,
            replayCaptureUncompressedBytes: capture.uncompressedBytes,
            replayCaptureCpuMs: (captureCpu.user + captureCpu.system) / 1000,
            replayCaptureHeapDeltaBytes: captureMemoryAfter.heapUsed - captureMemoryBefore.heapUsed,
            replayCaptureRssDeltaBytes: captureMemoryAfter.rss - captureMemoryBefore.rss,
          }));
        `,
        loader: "ts",
        resolveDir: TEST_DIRECTORY,
        sourcefile: "safety-score-v9-resource-probe.ts",
      },
      outfile: bundledProbe,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      tsconfig: join(ROOT, "tsconfig.json"),
      logLevel: "silent",
    });
  });

  afterAll(() => {
    if (temporaryDirectory) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });


  it(`publishes the full registry within ${HEAP_LIMIT_MIB} MiB of old-space`, () => {
    const result = spawnSync(
      process.execPath,
      [
        `--max-old-space-size=${HEAP_LIMIT_MIB}`,
        "--expose-gc",
        bundledProbe,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 45_000,
        env: { ...process.env, SAFETY_SCORE_V9_RESOURCE_CAPTURE: "" },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);

    const output = JSON.parse(result.stdout) as {
      expected: number;
      cards: number;
      rated: number;
      factDigest: string;
      resultDigest: string;
      acceptedBaselineBytes: number;
      candidateBytes: number;
      compressedBytes: number;
      storedBytes: number;
      replayCaptureUncompressedBytes: number;
      extensionAssets: number;
      researchEvidenceCount: number;
      componentEvidenceCount: number;
    };
    expect(output.extensionAssets).toBeGreaterThan(300);
    expect(output.researchEvidenceCount).toBeGreaterThan(5_000);
    expect(output.componentEvidenceCount).toBeGreaterThan(3_000);
    expect(output.expected).toBeGreaterThan(300);
    expect(output.replayCaptureUncompressedBytes).toBeGreaterThan(300_000);
    expect(output.cards).toBe(output.expected);
    expect(output.rated).toBeGreaterThan(output.expected / 3);
    expect(output.factDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(output.resultDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(output.acceptedBaselineBytes).toBeLessThan(500_000);
    expect(output.candidateBytes).toBeLessThanOrEqual(PUBLICATION_BYTE_BUDGET);
    expect(output.compressedBytes).toBeLessThan(1_350_000);
    expect(output.storedBytes).toBeGreaterThan(0);
  });

  // Byte-size measurement only: 256 MiB makes no compile/Worker memory claim.
  // The independent full-registry regression above continues to require 128 MiB.
  it.skipIf(!process.env.SAFETY_SCORE_V9_RESOURCE_CAPTURE)("keeps the frozen same-capture production envelope within both byte budgets", () => {
    const result = spawnSync(process.execPath, [
      `--max-old-space-size=${CONTAGION_HEAP_LIMIT_MIB}`, "--expose-gc", bundledProbe,
    ], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as { candidateBytes: number; baseInputGenerationId: string };
    expect(output.baseInputGenerationId).toBe(FROZEN_BASE.inputGenerationId);
    expect(output.candidateBytes).toBeLessThanOrEqual(PUBLICATION_BYTE_BUDGET);
    console.info({ basePath: FROZEN_BASE.path, baseDigest: FROZEN_BASE.digest, baseBytes: FROZEN_BASE.bytes,
      candidateBytes: output.candidateBytes, deltaBytes: output.candidateBytes - FROZEN_BASE.bytes });
  });

  it(`evaluates a bounded nine-scenario matrix within ${CONTAGION_HEAP_LIMIT_MIB} MiB of old-space`, () => {
    const result = spawnSync(process.execPath, [
      `--max-old-space-size=${CONTAGION_HEAP_LIMIT_MIB}`, "--expose-gc", bundledProbe,
    ], {
      cwd: ROOT, encoding: "utf8", timeout: 45_000,
      env: { ...process.env, CONTAGION_MATRIX: "1", SAFETY_SCORE_V9_RESOURCE_CAPTURE: "" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      expected: number; wallMs: number;
      counts: Array<{ evaluated: number; failed: number }>;
    };
    expect(output.counts).toHaveLength(9);
    for (const count of output.counts) {
      expect(count.evaluated).toBe(output.expected);
      expect(count.failed).toBe(0);
    }
    expect(output.wallMs).toBeLessThan(45_000);
  });
});
