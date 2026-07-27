import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSafetyScoreV9BaselineExtensionFromNormalizedInput } from "../safety-score-v9-extension";
import { createSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input";

const ROOT = resolve(import.meta.dirname, "../../../..");
const TEST_DIRECTORY = resolve(import.meta.dirname);
const HEAP_LIMIT_MIB = 128;
let temporaryDirectory = "";
let bundledProbe = "";

describe("Safety Score V9 resource budget", { timeout: 60_000 }, () => {
  beforeAll(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "pharos-v9-resource-"));
    bundledProbe = join(temporaryDirectory, "probe.mjs");
    buildSync({
      stdin: {
        contents: `
          import { buildSafetyScoreV8PublicationIdentity } from "@shared/lib/safety-score-v8-publication";
          import { sha256HexFromUtf8Chunks } from "@shared/lib/sha256";
          import { stableJsonStringifyChunksV1 } from "@shared/lib/stable-json";
          import { buildSafetyScoreV9ShadowCandidateFromNormalizedInput } from "../safety-score-v9-candidate.ts";
          import { createSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input.ts";
          import {
            buildReportCardsFixedInputCacheEntry,
            buildReportCardsSnapshotFromFixedInput,
            buildSafetyScoreV9FixedInputCacheEntry,
            normalizeFixedInput,
            parseReportCardsFixedInputCacheArtifact,
          } from "../report-cards-fixed-input.ts";
          import {
            buildSafetyScoreV9PegProvenanceSeedCacheEntry,
            captureSafetyScoreV9PegProvenanceById,
            parseSafetyScoreV9PegProvenanceSeed,
          } from "../safety-score-v9-peg-provenance.ts";
          import {
            buildSafetyScoreV9DiffReport,
            buildSafetyScoreV9ShadowEnvelope,
            computeSafetyScoreV9ShadowEnvelopeDigest,
          } from "../safety-score-v9-shadow.ts";
          import {
            serializeSafetyScoreV9DiffReportCacheValue,
            serializeSafetyScoreV9ShadowEnvelopeCacheValue,
          } from "../safety-score-v9-cache-codec.ts";

          const sourceInput = normalizeFixedInput(createSafetyScoreV9FullRegistryInput());
          const safetyScoreIdentity = buildSafetyScoreV8PublicationIdentity({
            methodologyVersion: sourceInput.methodologyVersion,
            baseInputGenerationId: sourceInput.baseInputGenerationId,
            publicationGenerationId: sourceInput.sourceGeneration,
          });
          const pegProvenanceById = captureSafetyScoreV9PegProvenanceById(
            sourceInput,
            {
              clockSec: sourceInput.clockSec,
              eventsByCoin: new Map(),
            },
          );
          const v8Cache = await buildReportCardsFixedInputCacheEntry(
            sourceInput,
            safetyScoreIdentity,
          );
          const seedCache = buildSafetyScoreV9PegProvenanceSeedCacheEntry({
            sourceGeneration: sourceInput.sourceGeneration,
            clockSec: sourceInput.clockSec,
            safetyScoreIdentity,
            pegProvenanceById,
          });
          const cacheRows = new Map([
            [v8Cache.key, v8Cache.value],
            [seedCache.key, seedCache.value],
          ]);
          const exactSeed = parseSafetyScoreV9PegProvenanceSeed(
            cacheRows.get(seedCache.key),
          );
          cacheRows.delete(seedCache.key);
          const fixedInput = (
            await parseReportCardsFixedInputCacheArtifact(
              cacheRows.get(v8Cache.key),
            )
          ).input;
          cacheRows.delete(v8Cache.key);
          const activeIds = new Set(fixedInput.activeAssetIds);
          const v8Cards = buildReportCardsSnapshotFromFixedInput(fixedInput).cards
            .filter((card) => activeIds.has(card.id));
          const preparedInput = {
            ...fixedInput,
            evidenceJournalById: {},
            supplyAttributionJournalById: {},
            pegProvenanceById: exactSeed.pegProvenanceById,
          };
          const runnerInput = normalizeFixedInput(preparedInput);
          const baseProjection = (input) => {
            const {
              safetyScoreV9SupplyAttributionById: _supply,
              evidenceJournalById: _evidence,
              supplyAttributionJournalById: _supplyJournal,
              pegProvenanceById: _peg,
              ...base
            } = input;
            return base;
          };
          const baseDigest = (input) => sha256HexFromUtf8Chunks(
            stableJsonStringifyChunksV1(baseProjection(input)),
          );
          if (baseDigest(fixedInput) !== baseDigest(runnerInput)) {
            throw new Error("Resource probe V9 preparation changed the V8 base input");
          }
          const shadow = buildSafetyScoreV9ShadowCandidateFromNormalizedInput({
            fixedInput: runnerInput,
            publishedAtSec: runnerInput.clockSec,
          });
          const baseEnvelope = buildSafetyScoreV9ShadowEnvelope({
            candidate: shadow.candidate,
            expectedActiveIds: runnerInput.activeAssetIds,
            compilerFactSchemaDigest: shadow.compilerFactSchemaDigest,
            producerCapabilityDigest: shadow.producerCapabilityDigest,
            coverageFloors: [],
          });
          const v8 = {
            model: "v8",
            publicationGenerationId: fixedInput.sourceGeneration,
            baseInputGenerationId: fixedInput.baseInputGenerationId,
            methodologyVersion: fixedInput.methodologyVersion,
            evaluationBuildDigest: safetyScoreIdentity.evaluationBuildDigest,
            cards: v8Cards.map((card) => ({
              id: card.id,
              score: card.overallScore,
              grade: card.overallGrade,
              bindingCap: card.overallCapped && card.overallScore !== null
                ? { kind: "variant-parent", limit: card.overallScore, source: card.rawInputs.variantParentId ?? null }
                : null,
              reasonCodes: [],
            })),
          };
          const supplies = Object.entries(shadow.supplyUsdById)
            .map(([id, supplyUsd]) => ({ id, supplyUsd }))
            .sort((left, right) => right.supplyUsd - left.supplyUsd || left.id.localeCompare(right.id));
          const cutoff = supplies[Math.min(24, supplies.length - 1)]?.supplyUsd ?? Number.POSITIVE_INFINITY;
          const diffInput = {
            generatedAtSec: runnerInput.clockSec,
            expectedActiveIds: runnerInput.activeAssetIds,
            v8,
            v9: baseEnvelope,
            topCutoffIds: new Set(supplies.filter((entry) => entry.supplyUsd >= cutoff).map((entry) => entry.id)),
            downstreamThresholds: [],
            supplyUsdById: shadow.supplyUsdById,
          };
          let pendingDiff = buildSafetyScoreV9DiffReport(diffInput);
          const reviewKeys = pendingDiff.cards.flatMap((card) =>
            card.review.key === null ? [] : [card.review.key],
          );
          pendingDiff = null;
          const diff = buildSafetyScoreV9DiffReport({
            ...diffInput,
            reviewDispositionsByKey: {},
            reviewCarriesByClassKey: {},
          });
          const unresolvedCriticalMovementIds = diff.cards
            .filter((card) => card.review.status === "pending")
            .map((card) => card.id);
          const envelope = buildSafetyScoreV9ShadowEnvelope({
            candidate: shadow.candidate,
            expectedActiveIds: runnerInput.activeAssetIds,
            compilerFactSchemaDigest: shadow.compilerFactSchemaDigest,
            producerCapabilityDigest: shadow.producerCapabilityDigest,
            coverageFloors: [],
            unresolvedCriticalMovementIds,
          });
          const fixedInputCache = await buildSafetyScoreV9FixedInputCacheEntry(
            runnerInput,
            safetyScoreIdentity,
          );
          const [storedEnvelope, storedDiff] = await Promise.all([
            serializeSafetyScoreV9ShadowEnvelopeCacheValue(envelope),
            serializeSafetyScoreV9DiffReportCacheValue(diff),
          ]);
          const storedEnvelopeMetadata = JSON.parse(storedEnvelope);
          const publicBreakdownLabels = shadow.candidate.cards.flatMap((card) =>
            card.breakdowns === null
              ? []
              : [
                  ...card.breakdowns.backing.components.map((component) => component.label),
                  ...(card.breakdowns.exit.primaryRoute === null
                    ? []
                    : [card.breakdowns.exit.primaryRoute.label]),
                  ...card.breakdowns.exit.alternatives.map((route) => route.label),
                  ...card.breakdowns.control.components.map((component) => component.label),
                ],
          );
          process.stdout.write(JSON.stringify({
            expected: runnerInput.activeAssetIds.length,
            cards: shadow.candidate.cards.length,
            rated: shadow.candidate.completeness.ratedCount,
            supplies: Object.keys(shadow.supplyUsdById).length,
            factDigest: shadow.candidate.factSetDigest,
            resultDigest: shadow.candidate.resultDigest,
            envelopeDigest: computeSafetyScoreV9ShadowEnvelopeDigest(envelope),
            diffDigest: diff.reportDigest,
            reviewKeys: reviewKeys.length,
            v8FixedInputCacheBytes: v8Cache.storedBytes,
            pegProvenanceSeedBytes: seedCache.storedBytes,
            fixedInputCacheBytes: fixedInputCache.storedBytes,
            candidateBytes: new TextEncoder().encode(JSON.stringify(shadow.candidate)).byteLength,
            envelopeCompressedBytes: storedEnvelopeMetadata.compressedBytes,
            storedEnvelopeBytes: storedEnvelope.length,
            storedDiffBytes: storedDiff.length,
            unsafeBreakdownLabels: publicBreakdownLabels.filter(
              (label) => /0x[a-f0-9]{8}|[a-f0-9]{16,}/i.test(label),
            ).length,
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
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it("keeps the deterministic fixture materially representative", () => {
    const fixedInput = createSafetyScoreV9FullRegistryInput();
    const extension = buildSafetyScoreV9BaselineExtensionFromNormalizedInput(fixedInput);
    const researchEvidenceCount = extension.assets.reduce(
      (count, asset) => count + asset.researchEvidence.length,
      0,
    );
    const componentEvidenceCount = extension.assets.reduce(
      (count, asset) => count + asset.componentEvidence.length,
      0,
    );

    expect(extension.assets.length).toBeGreaterThan(300);
    expect(stableJsonStringifyV1(extension).length).toBeGreaterThan(6_500_000);
    expect(researchEvidenceCount).toBeGreaterThan(5_000);
    expect(componentEvidenceCount).toBeGreaterThan(3_000);
  });

  it(`compiles and evaluates the full active registry within ${HEAP_LIMIT_MIB} MiB of old-space`, () => {
    const result = spawnSync(
      process.execPath,
      [`--max-old-space-size=${HEAP_LIMIT_MIB}`, bundledProbe],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 45_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);

    const output = JSON.parse(result.stdout) as {
      expected: number;
      cards: number;
      rated: number;
      supplies: number;
      factDigest: string;
      resultDigest: string;
      envelopeDigest: string;
      diffDigest: string;
      reviewKeys: number;
      v8FixedInputCacheBytes: number;
      pegProvenanceSeedBytes: number;
      fixedInputCacheBytes: number;
      candidateBytes: number;
      envelopeCompressedBytes: number;
      storedEnvelopeBytes: number;
      storedDiffBytes: number;
      unsafeBreakdownLabels: number;
    };
    expect(output.expected).toBeGreaterThan(300);
    expect(output.cards).toBe(output.expected);
    expect(output.rated).toBeGreaterThan(output.expected / 3);
    expect(output.supplies).toBe(output.expected);
    expect(output.factDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(output.resultDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(output.envelopeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(output.diffDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(output.reviewKeys).toBeGreaterThan(0);
    expect(output.v8FixedInputCacheBytes).toBeGreaterThan(0);
    expect(output.pegProvenanceSeedBytes).toBeGreaterThan(0);
    expect(output.fixedInputCacheBytes).toBeGreaterThan(0);
    expect(output.candidateBytes).toBeLessThan(8_000_000);
    expect(output.envelopeCompressedBytes).toBeLessThan(675_000);
    expect(output.storedEnvelopeBytes).toBeGreaterThan(0);
    expect(output.storedDiffBytes).toBeGreaterThan(0);
    expect(output.unsafeBreakdownLabels).toBe(0);
  });
});
