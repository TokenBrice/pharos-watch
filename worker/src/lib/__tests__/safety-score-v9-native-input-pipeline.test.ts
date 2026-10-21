import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { buildSafetyScoreV9InputIdentity } from "@shared/lib/safety-score-v9-input-identity";
import { loadV9CandidateMethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import {
  canonicalizeLenderBookObservation,
  deriveLenderBookObservationIdentity,
  lenderBookAdmissionReason,
  resolveLenderTokenIds,
} from "@shared/lib/safety-score-v9/lender-book-registry";
import {
  LenderBookObservationSchema,
  LenderCollateralBookPolicySchema,
  type LenderBookObservation,
  LenderCollateralBackingSchema,
  type LenderCollateralBacking,
  type LenderMarketObservation,
} from "@shared/types/safety-score-v9-lender-book";
import { LiveReserveSnapshotMetadataSchema } from "@shared/types/live-reserves";
import { LIVE_RESERVE_ADAPTER_DESCRIPTOR_DECLARATIONS } from "@shared/types/live-reserve-adapter-declarations";
import type { V9PublicationHealth } from "@shared/types/report-cards-v9";
import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { resolveCauseGapId } from "@shared/types/safety-score-v9-public-cause-gaps";
import { resolveV9EffectiveScoringWeight } from "@shared/types/safety-score-v9-public-causes";
import { iterateEvidenceResponsibilityFacts } from "@shared/types/safety-score-v9-public-evidence-facts";
import {
  createNativeSafetyScoreV9FullRegistryInput,
  createSafetyScoreV9FullRegistryInput,
} from "./fixtures/safety-score-v9-full-registry-input";
import { buildSafetyScoreV9Candidate, type SafetyScoreV9CandidatePipelineResult } from "../safety-score-v9/candidate";
import {
  buildNativeV9InputCacheEntry,
  computeNativeDexLiquidityPayloadFingerprint,
  normalizeNativeV9Input,
  NativeSafetyScoreV9InputSchema,
  parseNativeV9InputCacheArtifact,
  type NativeSafetyScoreV9Input,
} from "../safety-score-v9/native-input";
import { buildNativeSafetyScoreV9Capture, captureLenderCollateralBacking } from "../safety-score-v9/capture";
import * as acceptedProjectionReaders from "../safety-score-v9/accepted-projection-readers";
import * as lenderRegistry from "@shared/lib/safety-score-v9/lender-book-registry";
import {
  buildSafetyScoreV9PublicationReplayCapture,
  parseSafetyScoreV9PublicationReplayCapture,
} from "../safety-score-v9/publication-replay-capture";
import { parseSafetyScoreV9Publication, serializeSafetyScoreV9Publication } from "../safety-score-v9/publication-codec";
import { loadFreshIndependentLiveReserveMap } from "../live-reserves/store-overview";
import { reserveCompositionRow, reserveSyncRow } from "./live-reserves-store.test-support";
import * as snapshotInputs from "../report-cards-snapshot-inputs";
import * as snapshot from "../report-cards-snapshot";
import * as pegAnalytics from "../peg-analytics";
import * as pegCache from "../peg-analytics-cache";
import * as evidenceJournalStore from "../report-card-evidence-journal-store";
import { buildSafetyScoreV9LenderCollateralProjection } from "../safety-score-v9/accepted-projections";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { compareCodeUnits } from "@shared/lib/compare";
import { createV9CaptureDexSnapshot } from "./safety-score-v9-capture.test-support";

// The shared setup evaluates both capture lanes. Preserve the coverage budget
// for two full-registry compile/evaluate passes without repeating the native pass;
// v10.05's Sky liability book made each pass ~40% costlier, which exceeded 60s
// under V8 coverage on the two-core CI runner. On the v10.17 registry the
// coverage-lane setup measured 102s and 151s in consecutive runs (plain lane: 34s).
const V9_EVALUATION_TEST_TIMEOUT_MS = 240_000;

function cardsById(candidate: SafetyScoreV9CandidatePipelineResult["candidate"]) {
  return new Map(candidate.cards.map((card) => [card.id, {
    grade: card.grade, score: card.score, ratingStatus: card.ratingStatus, partialEvidence: card.partialEvidence,
  }]));
}

const PRIME = "kpkusdcprime-kpk";
const YIELD = "kpkusdcyield-kpk";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const CORE = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb";
const IRM = "0x870ac11d48b15db9a138cf899d20f13f79ba00bc";
const SAVUSD = "0xb8d89678e75a973e74698c976716308abb8a46a4";
const FTUSD = "0xf7d85ec4e7710f71992752eac2111312e73e9c9c";
const WEETH = "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee";
const WORD = `0x${"a".repeat(64)}`;

// Synthetic current observations, not re-dated production pins. Exact market
// identities are the reviewed KPK deployments; amounts intentionally include
// one raw-unit claim to prove display-rounded dust still contributes to Backing.
function book(assetId: string, clockSec: number): LenderBookObservation {
  const prime = assetId === PRIME;
  const vault = ACTIVE_META_BY_ID.get(assetId)!.contracts!.find(row => row.chain === "ethereum")!.address.toLowerCase();
  const account = prime ? "0x1d511811aca9d8817a3e50f29cadff6243a02902" : "0x4f74895557bea2de5d51d8c06e944da92dbc8550";
  const row = (marketId: string, collateralToken: string, oracle: string, includedAssetsRaw: string, lltvRaw: string): LenderMarketObservation => ({
    account, adapter: account, morpho: CORE, marketId, loanToken: USDC, collateralToken, oracle, irm: IRM, lltvRaw,
    supplySharesRaw: "1000000", positionBorrowSharesRaw: "0", positionCollateralRaw: "0",
    marketSupplyAssetsRaw: "1000000", marketSupplySharesRaw: "1000000000000",
    marketBorrowAssetsRaw: "500000", marketBorrowSharesRaw: "500000000000",
    marketLastUpdateSec: clockSec - 120, marketFeeRaw: "0", includedAssetsRaw,
    accruedMethod: "adapter-expected-supply-assets", collateralMode: "collateralized",
  });
  const payload = {
    schemaVersion: 1 as const, assetId, acquiredAtSec: clockSec - 60, maxAgeSec: 28800,
    status: "ok" as const, censusScope: "complete-nav-accounted-current-book" as const,
    deployments: [{
      chain: "ethereum", vault, kind: "vault-v2" as const,
      pin: { chain: "ethereum", number: 26191269, hash: WORD, timestampSec: clockSec - 100, finality: "finalized" as const },
      loanToken: USDC, loanDecimals: 6, totalAssetsRaw: "1000000", totalSupplyRaw: "1000000000000000000",
      idleAssetsRaw: "0", reconciledAssetsRaw: "1000000", reconciliationResidualRaw: "0",
      codeHashes: { [vault]: WORD, [account]: WORD, [CORE]: WORD },
      selectorsRead: ["0x01e1d114", "0x38d52e0f"],
      markets: [
        prime
          ? row("0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64", "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", "0xa6d6950c9f177f1de7f7757fb33539e3ec60182a", "799999", "860000000000000000")
          : row("0xe07d416323a1afbfe0bf2fe27ffb549ff565cf5c86d21b79fc60664038e597c9", SAVUSD, "0x839940de5043e7c6edaf063714afe7f20de5ff12", "799999", "915000000000000000"),
        prime
          ? row("0xb8fef900b383db2dbbf4458c7f46acf5b140f26d603a6d1829963f241b82510e", "0x856c4efb76c1d1ae02e20ceb03a2a6a08b0b8dc3", "0xe8adff9117151fb5ad7313873780b87cc56eedb0", "200000", "860000000000000000")
          : row("0x88ab06d43b089e574bbe312deee6cdb292702c3a2e765059492c34b1cd298acf", FTUSD, "0x7887afbe7581eb01b3d91d80c198b0275feab779", "200000", "860000000000000000"),
        row("0x34377fc4f617c51818e92c79df31ff270c6a91bc94ad32e367fdf59b9f4ac5dd", WEETH, "0xa3a7a3cefee206f9d7fe00ec3c83324ed4228411", "1", "770000000000000000"),
      ],
    }],
  };
  return LenderBookObservationSchema.parse(canonicalizeLenderBookObservation({
    ...payload, ...deriveLenderBookObservationIdentity(payload),
  }));
}

function unavailableBook(assetId: string, clockSec: number, reason: "rpc-unavailable" | "unreconciled"): LenderBookObservation {
  const payload = {
    schemaVersion: 1 as const, assetId, acquiredAtSec: clockSec - 60, maxAgeSec: 28800,
    status: "unavailable" as const, reason, failedDeploymentKey: `ethereum:${ACTIVE_META_BY_ID.get(assetId)!.contracts![0]!.address.toLowerCase()}`,
    deployments: null, contentSha256: "0".repeat(64), sourceGenerationId: "fixture",
  };
  return LenderBookObservationSchema.parse({ ...payload, ...deriveLenderBookObservationIdentity(payload) });
}

function acceptedBundle(input: NativeSafetyScoreV9Input): LenderCollateralBacking {
  return {
    schemaVersion: 1, status: "ok", reason: null, publicationGenerationId: "report-cards:v9:v1:" + "b".repeat(64),
    publishedAtSec: input.clockSec - 1, policyDigest: "c".repeat(64), evaluationBuildDigest: "d".repeat(64),
    registryFingerprint: input.registryFingerprint, maxAgeSec: 3600,
    tokenToAssetId: { [`ethereum:${SAVUSD}`]: "savusd-avant", [`ethereum:${FTUSD}`]: "ftusd-flying-tulip" },
    byAssetId: {
      "savusd-avant": { assetId: "savusd-avant", backingScore: 52.5, cardSha256: "e".repeat(64), sourceCause: null, sourceGapIds: [] },
      "ftusd-flying-tulip": { assetId: "ftusd-flying-tulip", backingScore: 59.61669994438998, cardSha256: "f".repeat(64), sourceCause: null, sourceGapIds: [] },
    },
  };
}

function subsetInput(template: NativeSafetyScoreV9Input, observations: Record<string, unknown> = {}, bundle?: LenderCollateralBacking): NativeSafetyScoreV9Input {
  const ids = [PRIME, YIELD, "usdc-circle"];
  const pick = <T>(map: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(map).filter(([id]) => ids.includes(id)));
  const { baseInputGenerationId: _base, ...draft } = template;
  const dexLiqMap = pick(template.dexLiqMap);
  return normalizeNativeV9Input({
    ...draft, activeAssetIds: ids, pegDataById: pick(template.pegDataById),
    dexLiqMap, dexPayloadFingerprint: computeNativeDexLiquidityPayloadFingerprint(dexLiqMap, template.dexGenerationId),
    chainCirculatingById: pick(template.chainCirculatingById),
    // The lender-book lane adjusts an independently admitted denomination
    // reserve, not a reserve made known by the collateral-book observation.
    liveReserveMap: Object.fromEntries([PRIME, YIELD].map(id => [id, [{
      name: "Synthetic USDC denomination reserve", pct: 100, risk: "high",
      coinId: "usdc-circle", depType: "wrapper", assetClass: "stablecoin",
    }]])),
    liveReserveProvenanceMap: Object.fromEntries([PRIME, YIELD].map(id => [id, {
      source: "erc4626-single-asset", fetchedAt: template.clockSec - 60,
      ...(observations[id] === undefined ? {} : { lenderBookObservation: observations[id] }),
    }])),
    ...(bundle === undefined ? {} : { lenderCollateralBacking: bundle }),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("native v4 input through the V9 candidate pipeline", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  const input = createNativeSafetyScoreV9FullRegistryInput();
  const legacy = createSafetyScoreV9FullRegistryInput();
  let pipeline: Readonly<SafetyScoreV9CandidatePipelineResult>;
  let legacyCandidate: SafetyScoreV9CandidatePipelineResult["candidate"];
  beforeAll(() => {
    pipeline = buildSafetyScoreV9Candidate({ fixedInput: input, publishedAtSec: input.clockSec });
    legacyCandidate = buildSafetyScoreV9Candidate({ fixedInput: legacy, publishedAtSec: legacy.clockSec }).candidate;
  }, V9_EVALUATION_TEST_TIMEOUT_MS);

  it("compiles, evaluates, and projects a full publication end to end", () => {

    expect(pipeline.compiledFacts.assets.length).toBe(input.activeAssetIds.length);
    expect(pipeline.candidate.cards.length).toBe(input.activeAssetIds.length);
    // The published id format is a namespace shared with the retained v3 lane.
    expect(pipeline.compiledFacts.baseInputGenerationId).toMatch(/^report-cards-input:v1:[a-f0-9]{64}$/);
    expect(pipeline.compiledFacts.baseInputGenerationId).toBe(input.baseInputGenerationId);
    expect(pipeline.compilerFactSchemaIdentity.fixedInputSchemaVersion).toBe(4);
    expect(pipeline.producerCapabilityIdentity.inputContractVersions.fixedInput).toBe(4);

    const baseDollarCard = pipeline.candidate.cards.find((card) => card.id === "bd-basedollar");
    const baseDollarFacts = pipeline.compiledFacts.assets.find((asset) => asset.assetId === "bd-basedollar");
    expect(baseDollarCard?.grade).not.toBe("NR");
    expect(baseDollarCard?.score).not.toBeNull();
    expect(baseDollarFacts?.gaps.map((gap) => gap.reasonCode)).not.toContain("missing-mechanism-review");
    expect(baseDollarFacts?.gaps.map((gap) => gap.reasonCode)).not.toContain("missing-oracle-review");
    expect(baseDollarFacts?.mechanismRiskReview.status.observationState).toBe("known");
    expect(baseDollarFacts?.controlStatus.observationState).toBe("known");
    expect(baseDollarFacts?.cdpStressCoverage).toMatchObject({
      complete: true,
      exactReplayPassed: true,
    });
    expect(baseDollarFacts?.cdpStressCoverage?.stressLiquidationCoverageRatio).toBeGreaterThan(0);
    expect(baseDollarFacts?.cdpStressCoverage?.stressLiquidationCoverageRatio).toBeLessThan(1);
  });

  it("scores the native projection identically to the exact input it projects from", () => {

    // Dropping bluechip, blacklist, drift, the non-current chain buckets, and
    // the V8 DEX row fields must not move a single grade or score.
    expect(cardsById(pipeline.candidate)).toEqual(cardsById(legacyCandidate));
  });

  describe("v10.19 complete same-parent two-slice books", () => {
    // Exact deployed/idle shapes from the council's pinned smoke. Books below
    // are synthetic current observations, not re-dated smoke acquisitions.
    const shapes = [
      ["bbqusdc-steakhouse", "usdc-circle", .99999999963835, "Smokehouse USDC", true],
      ["senpyusdmain-sentora", "pyusd-paypal", .95020676091051, "Paypal USD Main", false],
      ["senpyusdprimev2-sentora", "pyusd-paypal", .97307414633756, "Sentora PRIME Main", true],
      ["senrlusdv2-sentora", "rlusd-ripple", .9500723688575201, "Sentora RLUSD Main", false],
    ] as const;
    let previous: Readonly<SafetyScoreV9CandidatePipelineResult>;
    let current: Readonly<SafetyScoreV9CandidatePipelineResult>;
    beforeAll(() => {
      const ids: string[] = [...new Set(shapes.flatMap(([id, parent]) => [id, parent]))];
      const pick = <T>(map: Record<string, T>): Record<string, T> =>
        Object.fromEntries(Object.entries(map).filter(([id]) => ids.includes(id)));
      const { baseInputGenerationId: _base, ...draft } = input;
      const dexLiqMap = pick(input.dexLiqMap);
      const liveReserveMap = Object.fromEntries(shapes.map(([id, parent, deployed, name]) => [id, [
        { name: `${name} deployed strategy positions`, pct: deployed * 100, risk: "high",
          coinId: parent, depType: "wrapper", assetClass: "protocol-position" },
        { name: `${name} idle underlying`, pct: (1 - deployed) * 100, risk: "high",
          coinId: parent, depType: "wrapper", assetClass: "stablecoin" },
      ]]));
      const observations = Object.fromEntries(shapes.map(([id, parent, , , weakBook]) => {
        const source = book(PRIME, input.clockSec);
        if (source.status !== "ok") throw new Error("Expected complete synthetic book");
        const vault = ACTIVE_META_BY_ID.get(id)!.contracts!.find(row => row.chain === "ethereum")!.address.toLowerCase();
        const loanToken = ACTIVE_META_BY_ID.get(parent)!.contracts!.find(row => row.chain === "ethereum")!.address.toLowerCase();
        const kind = loadV9CandidateMethodologyPolicy().policy.semantic.backing.lenderCollateralBook.admittedAssets
          .find(row => row.assetId === id)!.deployments[0]!.kind;
        const payload = { ...source, assetId: id, deployments: source.deployments.map(deployment => ({
          ...deployment, vault, loanToken, kind,
          codeHashes: { ...deployment.codeHashes, [vault]: WORD },
          markets: deployment.markets.map(market => ({
            ...market, loanToken, collateralToken: weakBook ? "0xcd9f5907f92818bc06c9ad70217f089e190d2a32" : market.collateralToken,
            lltvRaw: weakBook ? "1000000000000000000" : "0",
          })),
        })) };
        return [id, LenderBookObservationSchema.parse(canonicalizeLenderBookObservation({
          ...payload, ...deriveLenderBookObservationIdentity(payload),
        }))];
      }));
      const fixed = {
        ...draft, activeAssetIds: ids, pegDataById: pick(input.pegDataById),
        dexLiqMap, dexPayloadFingerprint: computeNativeDexLiquidityPayloadFingerprint(dexLiqMap, input.dexGenerationId),
        chainCirculatingById: pick(input.chainCirculatingById), liveReserveMap,
      };
      const provenance = (withBooks: boolean) => Object.fromEntries(shapes.map(([id]) => [id, {
        source: "erc4626-single-asset", fetchedAt: input.clockSec - 60,
        ...(withBooks ? { lenderBookObservation: observations[id] } : {}),
      }]));
      previous = buildSafetyScoreV9Candidate({
        fixedInput: normalizeNativeV9Input({ ...fixed, liveReserveProvenanceMap: provenance(false) }), publishedAtSec: input.clockSec,
      });
      current = buildSafetyScoreV9Candidate({
        fixedInput: normalizeNativeV9Input({ ...fixed, liveReserveProvenanceMap: provenance(true) }), publishedAtSec: input.clockSec,
      });
    });

    it.each(shapes)("consumes %s book without lifting its former generic Backing", (id, parent, deployed, _name, weakBook) => {
      expect(current.quarantines).toEqual([]);
      const facts = current.compiledFacts.assets.find(row => row.assetId === id)!;
      expect(facts.reserveExposures).toHaveLength(2);
      expect(facts.reserveExposures.every(row => row.trackedAssetId === parent && row.provenance === "live" &&
        row.status.observationState === "known" && row.status.applicability.state === "required")).toBe(true);
      expect(facts.reserveExposures.find(row => row.assetClass === "protocol-position")!.weight).toBeCloseTo(deployed, 12);
      expect(facts.lenderBook?.status.observationState).toBe("known");
      const before = previous.candidate.cards.find(row => row.id === id)!;
      const after = current.candidate.cards.find(row => row.id === id)!;
      expect(after.ratingStatus).toBe("rated");
      expect(after.pillars.backing.score!).toBeLessThanOrEqual(before.pillars.backing.score!);
      const reserve = after.breakdowns!.backing.groups.find(row => row.key === "reserves")!;
      const oldReserve = before.breakdowns!.backing.groups.find(row => row.key === "reserves")!;
      const parentBacking = current.candidate.cards.find(row => row.id === parent)!.pillars.backing.score!;
      expect(reserve.score).toBeCloseTo(Math.min(oldReserve.score!, parentBacking * (weakBook ? .35 : 1)), 7);
      const factors = after.breakdowns!.backing.components.flatMap(row => row.factors ?? [])
        .filter(row => row.componentKey.includes(":lender-book:"));
      expect(factors.length).toBeGreaterThan(0);
      if (weakBook) {
        expect(after.pillars.backing.score!).toBeLessThan(before.pillars.backing.score!);
        expect(factors.some(row => resolveV9EffectiveScoringWeight(row) > 0)).toBe(true);
      } else {
        expect(after.pillars.backing.score).toBe(before.pillars.backing.score);
        expect(factors.every(row => resolveV9EffectiveScoringWeight(row) === 0)).toBe(true);
      }
      expect(facts.dependencies.edges).toEqual(previous.compiledFacts.assets.find(row => row.assetId === id)!.dependencies.edges);
    });
  });
  describe("v10.19 frozen lender-book capture and publication", () => {
    const observations = { [PRIME]: book(PRIME, input.clockSec), [YIELD]: book(YIELD, input.clockSec) };
    const frozen = subsetInput(input, observations, acceptedBundle(input));
    let baseline: Readonly<SafetyScoreV9CandidatePipelineResult>;
    let admitted: Readonly<SafetyScoreV9CandidatePipelineResult>;
    const failed = new Map<string, Readonly<SafetyScoreV9CandidatePipelineResult>>();

    beforeAll(() => {
      baseline = buildSafetyScoreV9Candidate({ fixedInput: subsetInput(input), publishedAtSec: input.clockSec });
      admitted = buildSafetyScoreV9Candidate({ fixedInput: frozen, publishedAtSec: input.clockSec });
      for (const reason of ["rpc-unavailable", "unreconciled"] as const) {
        const unavailable = Object.fromEntries([PRIME, YIELD].map(id => [id, unavailableBook(id, input.clockSec, reason)]));
        failed.set(reason, buildSafetyScoreV9Candidate({
          fixedInput: subsetInput(input, unavailable, acceptedBundle(input)), publishedAtSec: input.clockSec,
        }));
      }
    });

    it("differentiates admitted books through normalization, facts, scoring and public factor projection", () => {
      expect(admitted.quarantines).toEqual([]);
      const parent = admitted.candidate.cards.find(card => card.id === "usdc-circle")!;
      const prime = admitted.candidate.cards.find(card => card.id === PRIME)!;
      const yieldCard = admitted.candidate.cards.find(card => card.id === YIELD)!;
      const parentBacking = parent.pillars.backing.score!;
      const primeQuality = .799999 * (100 - .86 ** 2 * 15) + .2 * (100 - .86 ** 2 * 20) + .000001 * (100 - .77 ** 2 * 20);
      const yieldQuality = .799999 * (100 - .915 ** 2 * 47.5) + .2 * (100 - .86 ** 2 * (100 - 59.61669994438998)) + .000001 * (100 - .77 ** 2 * 20);
      for (const [card, quality] of [[prime, primeQuality], [yieldCard, yieldQuality]] as const) {
        const asset = admitted.compiledFacts.assets.find(row => row.assetId === card.id)!;
        expect(asset.lenderBook?.status.observationState).toBe("known");
        expect(asset.lenderBook?.observation).toEqual(observations[card.id as keyof typeof observations]);
        expect(card.ratingStatus).toBe("rated");
        expect(card.breakdowns).not.toBeNull();
        const backing = card.breakdowns!.backing;
        const reserve = backing.groups.find(group => group.key === "reserves")!;
        expect(reserve.score).toBeCloseTo(parentBacking * quality / 100, 7);
        expect(card.pillars.backing.score!).toBeLessThan(baseline.candidate.cards.find(row => row.id === card.id)!.pillars.backing.score!);
        const inherited = backing.components.find(component => component.key.startsWith("reserve:inherited-backing:"))!;
        expect(inherited.score).toBeCloseTo(reserve.score!, 7);
        const factors = inherited.factors!;
        expect(factors.reduce((sum, factor) => sum + (factor.normalizedWeight ?? 0), 0)).toBeCloseTo(1, 12);
        expect(factors.reduce((sum, factor) => sum + (factor.score ?? 0) * (factor.normalizedWeight ?? 0), 0)).toBeCloseTo(reserve.score!, 7);
        expect(factors.filter(factor => factor.componentKey.includes(":lender-book:"))).toHaveLength(4);
        expect(factors.find(factor => factor.componentKey.includes(WEETH))?.normalizedWeight).toBe(.000001);
        const mirror = backing.components.find(component => component.source === "reserve-concentration")!;
        expect(mirror.score).toBeCloseTo(reserve.score!, 7);
        expect(asset.dependencies.edges.map(edge => edge.upstreamAssetId)).toEqual(["usdc-circle"]);
        expect(asset.dependencies.edges).toEqual(baseline.compiledFacts.assets.find(row => row.assetId === card.id)!.dependencies.edges);
        for (const [, , reference, , , , references] of iterateEvidenceResponsibilityFacts(card.scoreTrace.evidenceResponsibility)) {
          for (const ref of reference === null ? references : [reference]) {
            expect(resolveCauseGapId(admitted.candidate, card, ref)).toBeTruthy();
          }
        }
      }
      expect(prime.pillars.backing.score!).toBeGreaterThan(yieldCard.pillars.backing.score!);
      expect(cardsById(admitted.candidate).get(parent.id)).toEqual(cardsById(baseline.candidate).get(parent.id));
      const baselineParent = baseline.candidate.cards.find(card => card.id === parent.id)!;
      for (const pillar of ["backing", "exit", "control"] as const) {
        expect(parent.pillars[pillar].score).toBe(baselineParent.pillars[pillar].score);
      }
      expect(admitted.compiledFacts.assets.find(row => row.assetId === YIELD)!.lenderBook!.collaterals).toContainEqual(expect.objectContaining({
        trackedAssetId: "savusd-avant", qualitySource: "previous-accepted-backing", quality: 52.5,
      }));
    });

    it.each(["rpc-unavailable", "unreconciled"])("retains inherited Backing with a zero-weight A diagnostic for %s", reason => {
      const result = failed.get(reason)!;
      expect(result.quarantines).toEqual([]);
      for (const id of [PRIME, YIELD]) {
        const asset = result.compiledFacts.assets.find(row => row.assetId === id)!;
        expect(asset.lenderBook?.observation).toMatchObject({ status: "unavailable", reason, deployments: null });
        expect(asset.lenderBook?.status.observationState).not.toBe("known");
        const card = result.candidate.cards.find(row => row.id === id)!;
        const previous = baseline.candidate.cards.find(row => row.id === id)!;
        expect(card.pillars.backing.score).toBe(previous.pillars.backing.score);
        expect(card.ratingStatus).toBe(previous.ratingStatus);
        expect(card.breakdowns).not.toBeNull();
        const diagnostic = card.breakdowns!.backing.components.flatMap(component => component.factors ?? [])
          .find(factor => factor.componentKey.endsWith(":lender-book:unavailable"));
        expect(diagnostic).toMatchObject({
          score: null, cause: "A", scoringDisposition: "excluded-pipeline",
        });
        // The public wire omits zero normalized weights and default excluded
        // effective weights; assert their decoded meaning, not redundant bytes.
        expect(diagnostic!.normalizedWeight ?? 0).toBe(0);
        expect(resolveV9EffectiveScoringWeight(diagnostic!)).toBe(0);
      }
    });

    it("keeps published Backing unchanged for retained books with failed latest attempts", () => {
      const retainedInput = normalizeNativeV9Input({
        ...frozen, baseInputGenerationId: undefined,
        liveReserveProvenanceMap: Object.fromEntries([PRIME, YIELD].map(id => [id, {
          ...frozen.liveReserveProvenanceMap[id],
          lenderBookLatestAttemptFailure: unavailableBook(id, input.clockSec, "rpc-unavailable"),
        }])),
      });
      const retained = buildSafetyScoreV9Candidate({ fixedInput: retainedInput, publishedAtSec: input.clockSec });
      expect(retained.quarantines).toEqual([]);
      for (const id of [PRIME, YIELD]) {
        const before = admitted.candidate.cards.find(card => card.id === id)!;
        const after = retained.candidate.cards.find(card => card.id === id)!;
        expect(after.pillars.backing.score).toBe(before.pillars.backing.score);
        expect(after.score).toBe(before.score);
        expect(after.grade).toBe(before.grade);
        expect(retained.compiledFacts.assets.find(asset => asset.assetId === id)!.lenderBook!.observation)
          .toEqual(frozen.liveReserveProvenanceMap[id]!.lenderBookObservation);
        const diagnostic = after.breakdowns!.backing.components.flatMap(component => component.factors ?? [])
          .find(factor => factor.componentKey.endsWith(":latest-attempt"))!;
        expect(diagnostic).toBeDefined();
        expect(diagnostic.score).toBeNull();
        expect(diagnostic.cause).toBe("A");
        expect(resolveV9EffectiveScoringWeight(diagnostic)).toBe(0);
      }
    });

    it.each([
      ["null", null],
      ["missing rows", {}],
      ["null rows", { byAssetId: null }],
      ["array rows", { byAssetId: [] }],
      ["scalar rows", { byAssetId: "unavailable" }],
    ])("rejects a malformed accepted-source container: %s", (_label, bundle) => {
      const parsed = NativeSafetyScoreV9InputSchema.safeParse({ ...frozen, lenderCollateralBacking: bundle });
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error("Malformed accepted-source container was admitted");
      expect(parsed.error.issues.some(issue => issue.path[0] === "lenderCollateralBacking")).toBe(true);
    });

    it.each([
      ["null row", null],
      ["missing gaps", {}],
      ["null gaps", { sourceGapIds: null }],
      ["non-string gaps", { sourceGapIds: [1] }],
    ])("rejects malformed accepted collateral rows without sanitizing them: %s", (_label, row) => {
      const bundle = { ...acceptedBundle(input), byAssetId: { "savusd-avant": row } };
      const parsed = NativeSafetyScoreV9InputSchema.safeParse({ ...frozen, lenderCollateralBacking: bundle });
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error("Malformed accepted collateral row was admitted");
      expect(parsed.error.issues.some(issue =>
        issue.path[0] === "lenderCollateralBacking" && issue.path[1] === "byAssetId" && issue.path[2] === "savusd-avant",
      )).toBe(true);
    });

    it("retains legacy absence and original base identities without fabricating a successful book", async () => {
      const oldInput = subsetInput(input);
      const identity = buildSafetyScoreV9InputIdentity({
        methodologyVersion: oldInput.methodologyVersion, baseInputGenerationId: oldInput.baseInputGenerationId,
        publicationGenerationId: oldInput.sourceGeneration,
      });
      const stored = await buildNativeV9InputCacheEntry(oldInput, identity);
      const restored = await parseNativeV9InputCacheArtifact(stored.value);
      expect(restored.input.baseInputGenerationId).toBe(oldInput.baseInputGenerationId);
      expect(restored.input.lenderCollateralBacking).toBeUndefined();
      expect(restored.input.liveReserveProvenanceMap).toEqual(oldInput.liveReserveProvenanceMap);
      for (const id of [PRIME, YIELD]) {
        expect(restored.input.liveReserveProvenanceMap[id]).not.toHaveProperty("lenderBookObservation");
        expect(baseline.compiledFacts.assets.find(asset => asset.assetId === id)!.lenderBook?.observation).toBeNull();
        expect(baseline.compiledFacts.assets.find(asset => asset.assetId === id)!.gaps.some(gap => gap.message.includes("legacy-unobserved"))).toBe(true);
      }
    });

    it("roundtrips stored metadata through the explicit whitelist, frozen source and native codec", async () => {
      const meta = ACTIVE_META_BY_ID.get(YIELD)!;
      const config = meta.liveReservesConfig!;
      const failedAttempt = unavailableBook(YIELD, input.clockSec, "rpc-unavailable");
      const metadata = LiveReserveSnapshotMetadataSchema.parse({
        freshnessMode: "not-applicable", lenderBookObservation: observations[YIELD],
        lenderBookLatestAttemptFailure: failedAttempt, details: { contextualOnly: true },
      });
      const fetchedAt = input.clockSec - 60;
      const composition = reserveCompositionRow({
        stablecoin_id: YIELD, source: config.adapter, fetched_at: fetchedAt,
        slices: JSON.stringify(meta.reserves), metadata: JSON.stringify(metadata),
        config_fingerprint: computeLiveReserveConfigFingerprint(config), attempt_id: "lender-book:success",
        adapter_source_model: "dynamic-mix", adapter_evidence_class: "independent", warnings: "[]", warning_count: 0,
      });
      const state = reserveSyncRow({
        stablecoin_id: YIELD, adapter_key: config.adapter, last_attempted_at: fetchedAt, last_success_at: fetchedAt,
        last_success_attempt_id: "lender-book:success", config_fingerprint: composition.config_fingerprint,
      });
      const db = mockD1([
        { match: "FROM reserve_composition", rows: [composition] },
        { match: "FROM reserve_sync_state", rows: [state] },
      ]);
      const live = await loadFreshIndependentLiveReserveMap(db, input.clockSec);
      expect(live.get(YIELD)).toEqual(meta.reserves);
      expect(live.provenanceById?.get(YIELD)?.lenderBookObservation).toEqual(observations[YIELD]);
      expect(live.provenanceById?.get(YIELD)?.lenderBookLatestAttemptFailure).toEqual(failedAttempt);
      expect(live.provenanceById?.get(YIELD)).not.toHaveProperty("details");
      const previous = pipeline.candidate;
      const health: V9PublicationHealth = {
        schemaVersion: 2, status: "current", acceptedPublicationGenerationId: previous.publicationGenerationId,
        acceptedAtSec: previous.publishedAtSec, attemptedAtSec: previous.publishedAtSec, heldSinceSec: null, reasons: [],
      };
      vi.spyOn(acceptedProjectionReaders, "loadSafetyScoreV9LenderCollateralState").mockResolvedValue({
        kind: "accepted", projection: buildSafetyScoreV9LenderCollateralProjection(previous), health,
      });
      const captured = await captureLenderCollateralBacking(mockD1(), live.provenanceById!, input.registryFingerprint, input.clockSec + 1);
      expect(captured.status).toBe("ok");
      expect(Object.keys(captured.tokenToAssetId).sort()).toEqual([`ethereum:${SAVUSD}`, `ethereum:${FTUSD}`].sort());
      expect(captured.byAssetId["savusd-avant"]).toBeDefined();
      for (const [id, row] of Object.entries(captured.byAssetId)) {
        expect(row.backingScore).toBe(previous.cards.find(card => card.id === id)!.pillars.backing.score);
        expect(row.cardSha256).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(captured.byAssetId).not.toHaveProperty("usdc-circle");
      // Independent full-source extraction oracle: no projection builder on this side.
      const byAssetId: LenderCollateralBacking["byAssetId"] = {};
      for (const card of previous.cards) {
        if (!Object.values(captured.tokenToAssetId).includes(card.id)) continue;
        const backing = card.pillars.backing;
        if (card.ratingStatus !== "rated" || backing.aggregationDisposition === "excluded-a-b" ||
            backing.score === null || !Number.isFinite(backing.score) || backing.score < 0 || backing.score > 100) continue;
        const sourceCause = (["D", "C", "U"] as const).find(cause => backing.limitedEvidenceCauses?.includes(cause)) ?? null;
        const sourceGapIds = [...new Set((backing.causeGapRefs ?? []).map(ref => resolveCauseGapId(previous, card, ref)))].sort(compareCodeUnits);
        if ((sourceCause === "C" || sourceCause === "U") && sourceGapIds.length === 0) continue;
        byAssetId[card.id] = { assetId: card.id, backingScore: backing.score,
          cardSha256: sha256Hex(stableJsonStringifyV1(card)), sourceCause, sourceGapIds };
      }
      const oracle = LenderCollateralBackingSchema.parse({
        schemaVersion: 1, status: "ok", reason: null,
        publicationGenerationId: previous.publicationGenerationId, publishedAtSec: previous.publishedAtSec,
        policyDigest: previous.policy.semanticDigest, evaluationBuildDigest: previous.evaluationBuildDigest,
        registryFingerprint: input.registryFingerprint, maxAgeSec: 3600, tokenToAssetId: captured.tokenToAssetId,
        byAssetId: Object.fromEntries(Object.entries(byAssetId).sort(([a], [b]) => compareCodeUnits(a, b))),
      });
      expect(captured).toEqual(oracle);
      const base = subsetInput(input, { [YIELD]: live.provenanceById!.get(YIELD)!.lenderBookObservation }, captured);
      const native = normalizeNativeV9Input({
        ...base, baseInputGenerationId: undefined,
        liveReserveProvenanceMap: { ...base.liveReserveProvenanceMap, [YIELD]: live.provenanceById!.get(YIELD)! },
      });
      expect(native.baseInputGenerationId).not.toBe(base.baseInputGenerationId);
      expect(native).toEqual(normalizeNativeV9Input({
        ...base, baseInputGenerationId: undefined, lenderCollateralBacking: oracle,
        liveReserveProvenanceMap: { ...base.liveReserveProvenanceMap, [YIELD]: live.provenanceById!.get(YIELD)! },
      }));
      const identity = buildSafetyScoreV9InputIdentity({
        methodologyVersion: native.methodologyVersion, baseInputGenerationId: native.baseInputGenerationId,
        publicationGenerationId: native.sourceGeneration,
      });
      const stored = await buildNativeV9InputCacheEntry(native, identity);
      expect(stored.key).toBe("report-cards:fixed-input:exact");
      expect(JSON.parse(stored.value).schemaVersion).toBe(2);
      const restored = await parseNativeV9InputCacheArtifact(stored.value);
      expect(restored.input).toEqual(native);
      expect(restored.safetyScoreIdentity).toEqual(identity);
      expect(LiveReserveSnapshotMetadataSchema.safeParse(JSON.parse(String(composition.metadata))).success).toBe(true);
    });

    it("binds every consumed market, score, pin and exact-token resolution to base identity", () => {
      const mutations: Array<(draft: NativeSafetyScoreV9Input) => void> = [
        draft => { draft.lenderCollateralBacking!.byAssetId["savusd-avant"]!.backingScore += 1; },
        draft => { draft.lenderCollateralBacking!.tokenToAssetId[`ethereum:${FTUSD}`] = "savusd-avant"; delete draft.lenderCollateralBacking!.byAssetId["ftusd-flying-tulip"]; },
        draft => {
          const observation = draft.liveReserveProvenanceMap[YIELD]!.lenderBookObservation!;
          if (observation.status !== "ok") throw new Error("Expected complete fixture");
          observation.deployments[0]!.pin.hash = `0x${"b".repeat(64)}`;
          Object.assign(observation, deriveLenderBookObservationIdentity(observation));
        },
        draft => {
          const observation = draft.liveReserveProvenanceMap[YIELD]!.lenderBookObservation!;
          if (observation.status !== "ok") throw new Error("Expected complete fixture");
          observation.deployments[0]!.markets[0]!.marketBorrowAssetsRaw = "500001";
          Object.assign(observation, deriveLenderBookObservationIdentity(observation));
        },
      ];
      for (const mutate of mutations) {
        const draft = structuredClone(frozen);
        mutate(draft);
        const { baseInputGenerationId: _base, ...payload } = draft;
        const changed = normalizeNativeV9Input(payload);
        expect(changed.baseInputGenerationId).not.toBe(frozen.baseInputGenerationId);
        expect(() => normalizeNativeV9Input({ ...changed, baseInputGenerationId: frozen.baseInputGenerationId })).toThrow(/does not match payload/);
      }
    });

    it("canonicalizes market/selector/map ordering without changing captured identity", () => {
      const draft = structuredClone(frozen);
      const observation = draft.liveReserveProvenanceMap[YIELD]!.lenderBookObservation!;
      if (observation.status !== "ok") throw new Error("Expected complete fixture");
      observation.deployments[0]!.markets.reverse();
      observation.deployments[0]!.selectorsRead.reverse();
      draft.lenderCollateralBacking!.tokenToAssetId = Object.fromEntries(Object.entries(draft.lenderCollateralBacking!.tokenToAssetId).reverse());
      draft.lenderCollateralBacking!.byAssetId = Object.fromEntries(Object.entries(draft.lenderCollateralBacking!.byAssetId).reverse());
      expect(normalizeNativeV9Input(draft)).toEqual(frozen);
    });

    it.each([
      ["held", "accepted-source-held"],
      ["stale", "accepted-source-stale"],
      ["future-publication", "future-dated"],
      ["future-attempt", "future-dated"],
      ["negative-clock", "malformed"],
      ["fractional-clock", "malformed"],
      ["negative-publication", "malformed"],
      ["fractional-publication", "malformed"],
      ["negative-attempt", "malformed"],
      ["fractional-attempt", "malformed"],
      ["identity-mismatch", "accepted-source-unavailable"],
      ["read-failed", "accepted-source-unavailable"],
      ["read-threw", "accepted-source-unavailable"],
      ["missing", "accepted-source-unavailable"],
    ])("freezes %s accepted-source failure without fabricating score zero", async (scenario, reason) => {
      const previous: SafetyScoreV9CurrentResponse = structuredClone(pipeline.candidate);
      const health: V9PublicationHealth = {
        schemaVersion: 2, status: "current", acceptedPublicationGenerationId: previous.publicationGenerationId,
        acceptedAtSec: previous.publishedAtSec, attemptedAtSec: previous.publishedAtSec, heldSinceSec: null, reasons: [],
      };
      const sourceRead = vi.spyOn(acceptedProjectionReaders, "loadSafetyScoreV9LenderCollateralState");
      let clock = input.clockSec + 1;
      if (scenario === "held") Object.assign(health, { status: "held", heldSinceSec: previous.publishedAtSec, reasons: [{ code: "dex-stale" }] });
      if (scenario === "stale") clock = input.clockSec + 3601;
      if (scenario === "future-publication") {
        previous.publishedAtSec = clock + 1;
        health.acceptedAtSec = previous.publishedAtSec;
        health.attemptedAtSec = previous.publishedAtSec;
      }
      if (scenario === "future-attempt") health.attemptedAtSec = clock + 1;
      if (scenario === "negative-clock") clock = -1;
      if (scenario === "fractional-clock") clock += 0.5;
      if (scenario === "negative-attempt") health.attemptedAtSec = -1;
      if (scenario === "fractional-attempt") health.attemptedAtSec += 0.5;
      const projection = buildSafetyScoreV9LenderCollateralProjection(previous);
      if (scenario === "negative-publication") projection.publishedAtSec = -1;
      if (scenario === "fractional-publication") projection.publishedAtSec += 0.5;
      sourceRead.mockResolvedValue({ kind: "accepted", projection, health });
      if (scenario === "identity-mismatch") sourceRead.mockResolvedValue({ kind: "unavailable", reason: "health-mismatch" });
      if (scenario === "read-failed") sourceRead.mockResolvedValue({ kind: "unavailable", reason: "read-failed" });
      if (scenario === "missing") sourceRead.mockResolvedValue({ kind: "bootstrap", health: null });
      if (scenario === "read-threw") sourceRead.mockRejectedValue(new Error("Accepted projection read interrupted"));
      const provenance = new Map([[YIELD, frozen.liveReserveProvenanceMap[YIELD]!]]);
      const captured = await captureLenderCollateralBacking(mockD1(), provenance, frozen.registryFingerprint, clock);
      expect(captured).toMatchObject({
        status: "unavailable", reason, publicationGenerationId: null, publishedAtSec: null,
        policyDigest: null, evaluationBuildDigest: null,
      });
      expect(captured.byAssetId).toEqual({});
      expect(captured.tokenToAssetId[`ethereum:${SAVUSD}`]).toBe("savusd-avant");
      expect(captured.tokenToAssetId[`ethereum:${FTUSD}`]).toBe("ftusd-flying-tulip");
      expect(sourceRead).toHaveBeenCalledTimes(1);
    });

    it("admits the accepted-publication freshness boundary inclusively", async () => {
      const previous = pipeline.candidate;
      vi.spyOn(acceptedProjectionReaders, "loadSafetyScoreV9LenderCollateralState").mockResolvedValue({
        kind: "accepted", projection: buildSafetyScoreV9LenderCollateralProjection(previous),
        health: {
          schemaVersion: 2, status: "current", acceptedPublicationGenerationId: previous.publicationGenerationId,
          acceptedAtSec: previous.publishedAtSec, attemptedAtSec: previous.publishedAtSec, heldSinceSec: null, reasons: [],
        },
      });
      const captured = await captureLenderCollateralBacking(mockD1(), new Map([[YIELD, frozen.liveReserveProvenanceMap[YIELD]!]]), input.registryFingerprint, input.clockSec + 3600);
      expect(captured.status).toBe("ok");
      expect(captured.publishedAtSec).toBe(previous.publishedAtSec);
      expect(captured.maxAgeSec).toBe(3600);
    });

    it("resolves a newly referenced token from the complete accepted collateral inventory", async () => {
      const previous = pipeline.candidate;
      const projection = buildSafetyScoreV9LenderCollateralProjection(previous);
      vi.spyOn(acceptedProjectionReaders, "loadSafetyScoreV9LenderCollateralState").mockResolvedValue({
        kind: "accepted", projection,
        health: {
          schemaVersion: 2, status: "current", acceptedPublicationGenerationId: previous.publicationGenerationId,
          acceptedAtSec: previous.publishedAtSec, attemptedAtSec: previous.publishedAtSec, heldSinceSec: null, reasons: [],
        },
      });
      const provenance = new Map([[YIELD, frozen.liveReserveProvenanceMap[YIELD]!]]);
      const before = await captureLenderCollateralBacking(mockD1(), provenance, input.registryFingerprint, input.clockSec + 1);
      expect(before.byAssetId).not.toHaveProperty("usdc-circle");
      const changed = structuredClone(observations[YIELD]);
      if (changed.status !== "ok") throw new Error("Expected complete fixture");
      changed.deployments[0]!.markets[0]!.collateralToken = USDC;
      Object.assign(changed, deriveLenderBookObservationIdentity(changed));
      provenance.set(YIELD, { ...provenance.get(YIELD)!, lenderBookObservation: changed });
      const after = await captureLenderCollateralBacking(mockD1(), provenance, input.registryFingerprint, input.clockSec + 1);
      expect(after.status).toBe("ok");
      expect(after.tokenToAssetId[`ethereum:${USDC}`]).toBe("usdc-circle");
      expect(after.byAssetId["usdc-circle"]).toEqual(projection.byAssetId["usdc-circle"]);
      expect(after.byAssetId["usdc-circle"]).toBeDefined();
    });

    it.each(["ambiguous", "unmapped"] as const)("omits %s token identities without losing uniquely mapped collateral", async scenario => {
      const resolveTokens = lenderRegistry.resolveLenderTokenIds;
      vi.spyOn(lenderRegistry, "resolveLenderTokenIds").mockImplementation(contracts => resolveTokens(
        scenario === "ambiguous"
          ? [...contracts, { assetId: "ftusd-flying-tulip", chain: "ethereum", address: SAVUSD }]
          : contracts.filter(contract => !(contract.chain === "ethereum" && contract.address.toLowerCase() === SAVUSD)),
      ));
      const previous = pipeline.candidate;
      const projection = buildSafetyScoreV9LenderCollateralProjection(previous);
      vi.spyOn(acceptedProjectionReaders, "loadSafetyScoreV9LenderCollateralState").mockResolvedValue({
        kind: "accepted", projection,
        health: {
          schemaVersion: 2, status: "current", acceptedPublicationGenerationId: previous.publicationGenerationId,
          acceptedAtSec: previous.publishedAtSec, attemptedAtSec: previous.publishedAtSec, heldSinceSec: null, reasons: [],
        },
      });
      const captured = await captureLenderCollateralBacking(
        mockD1(), new Map([[YIELD, frozen.liveReserveProvenanceMap[YIELD]!]]), input.registryFingerprint, input.clockSec + 1,
      );
      expect(captured.status).toBe("ok");
      expect(captured.tokenToAssetId).toEqual({ [`ethereum:${FTUSD}`]: "ftusd-flying-tulip" });
      expect(captured.byAssetId).toEqual({ "ftusd-flying-tulip": projection.byAssetId["ftusd-flying-tulip"] });
      expect(captured.byAssetId["ftusd-flying-tulip"]).toBeDefined();
    });

    it.each(["not-rated", "pipeline-gap", "excluded", "missing", "causal-identity-missing"] as const)(
      "keeps the accepted source but rejects an ineligible %s collateral card", async scenario => {
        const previous: SafetyScoreV9CurrentResponse = structuredClone(pipeline.candidate);
        const card = previous.cards.find(row => row.id === "savusd-avant")!;
        if (scenario === "not-rated" || scenario === "pipeline-gap") card.ratingStatus = scenario;
        if (scenario === "excluded") card.pillars.backing.aggregationDisposition = "excluded-a-b";
        if (scenario === "missing") previous.cards = previous.cards.filter(row => row.id !== card.id);
        if (scenario === "causal-identity-missing") {
          card.pillars.backing.limitedEvidenceCauses = ["U"];
          card.pillars.backing.causeGapRefs = [];
        }
        vi.spyOn(acceptedProjectionReaders, "loadSafetyScoreV9LenderCollateralState").mockResolvedValue({
          kind: "accepted", projection: buildSafetyScoreV9LenderCollateralProjection(previous),
          health: {
            schemaVersion: 2, status: "current", acceptedPublicationGenerationId: previous.publicationGenerationId,
            acceptedAtSec: previous.publishedAtSec, attemptedAtSec: previous.publishedAtSec, heldSinceSec: null, reasons: [],
          },
        });
        const captured = await captureLenderCollateralBacking(mockD1(), new Map([[YIELD, frozen.liveReserveProvenanceMap[YIELD]!]]), input.registryFingerprint, input.clockSec + 1);
        expect(captured.status).toBe("ok");
        expect(captured.byAssetId).not.toHaveProperty("savusd-avant");
        expect(captured.tokenToAssetId[`ethereum:${SAVUSD}`]).toBe("savusd-avant");
      },
    );

    it("isolates a malformed raw book and preserves independently valid denomination and peer inputs", () => {
      const malformed = structuredClone(observations[YIELD]);
      if (malformed.status !== "ok") throw new Error("Expected complete fixture");
      malformed.deployments[0]!.markets[0]!.includedAssetsRaw = "unreadable";
      const normalized = subsetInput(input, { ...observations, [YIELD]: malformed }, acceptedBundle(input));
      expect(normalized.liveReserveProvenanceMap[YIELD]!.lenderBookObservation).toBeUndefined();
      expect(normalized.liveReserveProvenanceMap[YIELD]!.lenderBookObservationFailure).toMatchObject({
        code: "producer-failed", reason: "malformed-lender-book-observation", sourceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(normalized.liveReserveProvenanceMap[YIELD]!.fetchedAt).toBe(input.clockSec - 60);
      const result = buildSafetyScoreV9Candidate({ fixedInput: normalized, publishedAtSec: input.clockSec });
      expect(result.candidate.cards.find(card => card.id === PRIME)!.pillars.backing.score).toBe(admitted.candidate.cards.find(card => card.id === PRIME)!.pillars.backing.score);
      expect(result.candidate.cards.find(card => card.id === YIELD)!.pillars.backing.score).toBe(baseline.candidate.cards.find(card => card.id === YIELD)!.pillars.backing.score);
      expect(result.compiledFacts.assets.find(asset => asset.assetId === YIELD)!.lenderBook?.observation).toBeNull();
    });

    it("replays frozen token resolutions against a supplied registry without network or recapture", () => {
      const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline replay must not fetch"));
      const source = vi.spyOn(acceptedProjectionReaders, "loadSafetyScoreV9LenderCollateralState").mockRejectedValue(new Error("Offline replay must not recapture"));
      const metaById = new Map([PRIME, YIELD, "usdc-circle"].map(id => [id, structuredClone(ACTIVE_META_BY_ID.get(id)!)] as const));
      const resolve = vi.spyOn(lenderRegistry, "resolveLenderTokenIds").mockImplementation(() => {
        throw new Error("Offline replay must consume frozen token identities");
      });
      const replayed = buildSafetyScoreV9Candidate({
        fixedInput: frozen, publishedAtSec: frozen.clockSec,
        registry: { metaById, registryFingerprint: frozen.registryFingerprint },
      });
      expect(cardsById(replayed.candidate)).toEqual(cardsById(admitted.candidate));
      expect(replayed.compiledFacts.assets.find(asset => asset.assetId === YIELD)!.lenderBook).toEqual(admitted.compiledFacts.assets.find(asset => asset.assetId === YIELD)!.lenderBook);
      expect(fetch).not.toHaveBeenCalled();
      expect(source).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
    });

    it("retains lender inputs in accepted replay base bytes and validates public factor transport", async () => {
      const identity = buildSafetyScoreV9InputIdentity({
        methodologyVersion: frozen.methodologyVersion, baseInputGenerationId: frozen.baseInputGenerationId,
        publicationGenerationId: frozen.sourceGeneration,
      });
      const base = await buildNativeV9InputCacheEntry(frozen, identity);
      const enriched = {
        ...frozen, safetyScoreV9SupplyAttributionById: {}, evidenceJournalById: {},
        supplyAttributionJournalById: {}, pegProvenanceById: {},
      };
      const delta = await buildSafetyScoreV9PublicationReplayCapture(admitted.candidate, enriched, null);
      const restoredBase = (await parseNativeV9InputCacheArtifact(base.value)).input;
      const replay = await parseSafetyScoreV9PublicationReplayCapture(delta.value, restoredBase);
      expect(replay.fixedInput.baseInputGenerationId).toBe(frozen.baseInputGenerationId);
      expect(replay.fixedInput.lenderCollateralBacking).toEqual(frozen.lenderCollateralBacking);
      expect(replay.fixedInput.liveReserveProvenanceMap).toEqual(frozen.liveReserveProvenanceMap);
      expect(replay.publicationGenerationId).toBe(admitted.candidate.publicationGenerationId);
      const publication = await parseSafetyScoreV9Publication(await serializeSafetyScoreV9Publication(admitted.candidate));
      expect(publication).toEqual(admitted.candidate);
    });

    it("applies authored quality fallback rather than zero or missing-book inheritance when accepted scores are unavailable", () => {
      const source = acceptedBundle(input);
      const unavailable: LenderCollateralBacking = {
        ...source, status: "unavailable", reason: "accepted-source-held", publicationGenerationId: null,
        publishedAtSec: null, policyDigest: null, evaluationBuildDigest: null, byAssetId: {},
      };
      const result = buildSafetyScoreV9Candidate({
        fixedInput: subsetInput(input, observations, unavailable), publishedAtSec: input.clockSec,
      });
      const fact = result.compiledFacts.assets.find(asset => asset.assetId === YIELD)!.lenderBook!;
      expect(fact.status.observationState).toBe("known");
      expect(fact.status.gapIds).toEqual([]);
      expect(fact.acceptedSourceStatus?.gapIds).toContain(`${YIELD}:gap:lender-collateral-accepted-source`);
      for (const id of ["savusd-avant", "ftusd-flying-tulip"]) {
        expect(fact.collaterals).toContainEqual(expect.objectContaining({
          trackedAssetId: id, quality: 55, qualitySource: "authored-class",
          fallbackReason: "accepted-source-held", acceptedPublicationGenerationId: null,
        }));
      }
      const parentBacking = result.candidate.cards.find(card => card.id === "usdc-circle")!.pillars.backing.score!;
      const quality = .799999 * (100 - .915 ** 2 * 45) + .2 * (100 - .86 ** 2 * 45) + .000001 * (100 - .77 ** 2 * 20);
      const card = result.candidate.cards.find(row => row.id === YIELD)!;
      expect(card.ratingStatus).toBe("rated");
      expect(card.breakdowns).not.toBeNull();
      expect(card.breakdowns!.backing.groups.find(group => group.key === "reserves")!.score).toBeCloseTo(parentBacking * quality / 100, 7);
      const diagnostic = card.breakdowns!.backing.components.flatMap(component => component.factors ?? [])
        .find(factor => factor.componentKey.endsWith(":lender-book:accepted-source"));
      expect(diagnostic).toMatchObject({ score: null, cause: "A", scoringDisposition: "excluded-pipeline" });
      expect(diagnostic!.normalizedWeight ?? 0).toBe(0);
      expect(resolveV9EffectiveScoringWeight(diagnostic!)).toBe(0);
      for (const ref of diagnostic!.causeGapRefs ?? []) {
        expect(resolveCauseGapId(result.candidate, card, ref)).toBe(`${YIELD}:gap:lender-collateral-accepted-source`);
      }
    });

    it("prepares an explicit outcome for every admitted asset without adding network observation work", async () => {
      const observedAt = input.clockSec - 100;
      vi.spyOn(snapshotInputs, "loadReportCardsSnapshotInputs").mockResolvedValue({
        stablecoinsCached: { kind: "ok", updatedAt: input.clockSec, payload: { peggedAssets: [] } },
        dexLiquiditySnapshot: createV9CaptureDexSnapshot(legacy, observedAt),
        redemptionBackstopMap: {},
        redemptionSnapshotProvenance: { runId: null, latestUpdatedAt: null, methodologyVersion: null },
        liveReserveMap: new Map([[PRIME, ACTIVE_META_BY_ID.get(PRIME)!.reserves!]]),
        liveReserveProvenanceMap: new Map([[PRIME, frozen.liveReserveProvenanceMap[PRIME]!]]),
        liquidityStale: false, redemptionStale: true, inputFreshness: input.inputFreshness,
        v9PublicationInputHealth: {
          dex: { state: "current", generationId: input.dexGenerationId, updatedAtSec: observedAt },
          redemption: { state: "unavailable", generationId: null, updatedAtSec: null },
          liveReserves: { state: "available", coverageRatio: 1 },
        },
      });
      vi.spyOn(pegAnalytics, "derivePegAnalyticsSnapshot").mockResolvedValue({
        nowSec: input.clockSec, allEvents: [], eventsByCoin: new Map(), pegDataById: new Map(),
      });
      vi.spyOn(pegCache, "publishPegAnalyticsCache").mockResolvedValue(true);
      vi.spyOn(snapshot, "loadExactDexPublicationGeneration").mockResolvedValue({
        generationId: input.dexGenerationId, updatedAt: observedAt,
      });
      vi.spyOn(evidenceJournalStore, "loadReportCardEvidenceJournalByIdV1").mockResolvedValue({});
      vi.spyOn(acceptedProjectionReaders, "loadSafetyScoreV9LenderCollateralState").mockResolvedValue({ kind: "bootstrap", health: null });
      const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Preparation must only consume captured lender data"));
      const captured = await buildNativeSafetyScoreV9Capture(mockD1(), { expectedDexGenerationId: input.dexGenerationId });
      expect(captured.input.lenderCollateralBacking).toMatchObject({
        status: "unavailable", reason: "accepted-source-unavailable",
      });
      expect(captured.input.lenderCollateralBacking!.byAssetId).toEqual({});
      const policy = loadV9CandidateMethodologyPolicy().policy.semantic.backing.lenderCollateralBook;
      for (const admitted of policy.admittedAssets) {
        const observation = captured.input.liveReserveProvenanceMap[admitted.assetId]!.lenderBookObservation!;
        expect(observation.assetId).toBe(admitted.assetId);
        if (admitted.assetId === PRIME) expect(observation).toEqual(observations[PRIME]);
        else expect(observation).toMatchObject({ status: "unavailable", reason: "missing-observation", deployments: null });
      }
      expect(captured.input.liveReserveMap[PRIME]).toEqual(ACTIVE_META_BY_ID.get(PRIME)!.reserves);
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});

describe("v10.19 lender-book wire and policy admission", () => {
  const clockSec = 1_792_022_400;
  const policy = loadV9CandidateMethodologyPolicy().policy.semantic.backing.lenderCollateralBook;
  const complete = book(YIELD, clockSec);

  it("enrolls every configured direct Morpho lender and every catalog deployment, excluding unrelated vaults", () => {
    const direct = ACTIVE_STABLECOINS.filter(coin => {
      if (coin.liveReservesConfig?.adapter !== "erc4626-single-asset") return false;
      const params = LIVE_RESERVE_ADAPTER_DESCRIPTOR_DECLARATIONS["erc4626-single-asset"].paramsSchema.parse(coin.liveReservesConfig.params);
      const source = params.redemptionLiquidity?.source;
      return source === "morpho-vault-v1" || source === "morpho-vault-v2";
    });
    expect(policy.admittedAssets.map(asset => asset.assetId)).toEqual(direct.map(coin => coin.id).sort());
    expect(policy.admittedAssets).toHaveLength(33);
    expect(policy.admittedAssets.reduce((sum, asset) => sum + asset.deployments.length, 0)).toBe(35);
    for (const admitted of policy.admittedAssets) {
      const coin = ACTIVE_META_BY_ID.get(admitted.assetId)!;
      expect(admitted.deployments.map(deployment => deployment.chain).sort()).toEqual(coin.contracts!.map(contract => contract.chain).sort());
      expect(coin.liveReservesConfig!.adapter).toBe("erc4626-single-asset");
      const params = LIVE_RESERVE_ADAPTER_DESCRIPTOR_DECLARATIONS["erc4626-single-asset"].paramsSchema.parse(coin.liveReservesConfig!.params);
      expect(params.redemptionLiquidity).toBeDefined();
      const primaryChain = coin.liveReservesConfig!.inputs.primary;
      if (primaryChain.kind !== "onchain-evm") throw new Error("Missing direct on-chain source");
      const primaryKind = admitted.deployments.find(deployment => deployment.chain === primaryChain.chain)!.kind;
      expect(params.redemptionLiquidity!.source === "morpho-vault-v2" ? primaryKind === "vault-v2" : primaryKind.startsWith("metamorpho-")).toBe(true);
    }
    expect(policy.admittedAssets.find(asset => asset.assetId === "gtusdcp-gauntlet")!.deployments).toEqual([
      { chain: "arbitrum", kind: "metamorpho-v1.1" },
      { chain: "base", kind: "metamorpho-v1" },
      { chain: "ethereum", kind: "vault-v2" },
    ]);
    expect(policy.admittedAssets.some(asset => asset.assetId === "susds-sky" || asset.assetId === "syrupusdc-maple")).toBe(false);
  });

  it("pins all eleven fallback classes and rejects malformed policy identities rather than defaulting", () => {
    expect(policy.classQuality).toEqual({
      "native-eth": 95, "btc-wrapper": 85, "eth-lst": 85, "eth-yield-or-restaked": 80,
      "precious-metal-receipt": 85, "major-alt-l1": 70,
      "principal-token": 55, "yield-bearing-stable": 55, "synthetic-dollar": 55,
      "structured-credit": 35, "other-unknown": 35,
    });
    const missingClass = structuredClone(policy);
    const { "native-eth": _native, ...incompleteClassQuality } = missingClass.classQuality;
    expect(LenderCollateralBookPolicySchema.safeParse({ ...missingClass, classQuality: incompleteClassQuality }).success).toBe(false);
    const duplicate = structuredClone(policy);
    duplicate.admittedAssets[1] = duplicate.admittedAssets[0]!;
    expect(LenderCollateralBookPolicySchema.safeParse(duplicate).success).toBe(false);
    expect(LenderCollateralBookPolicySchema.safeParse({ ...policy, admittedAssets: policy.admittedAssets.slice(1) }).success).toBe(false);
    expect(LenderCollateralBookPolicySchema.safeParse({ ...policy, collateralClasses: [] }).success).toBe(false);
  });

  it("resolves exact active savUSD/USD3/ftUSD without aliasing siUSD or PT-siUSD to iUSD", () => {
    const index = resolveLenderTokenIds(ACTIVE_STABLECOINS.flatMap(coin => (coin.contracts ?? []).map(contract => ({
      assetId: coin.id, chain: contract.chain, address: contract.address,
    }))));
    expect(index.get(`ethereum:${SAVUSD}`)).toEqual(["savusd-avant"]);
    expect(index.get("ethereum:0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc")).toEqual(["usd3-3jane"]);
    expect(index.get(`ethereum:${FTUSD}`)).toEqual(["ftusd-flying-tulip"]);
    expect(index.get("ethereum:0xdbdc1ef57537e34680b898e1febd3d68c7389bcb")).toBeUndefined();
    expect(index.get("ethereum:0x76543ac61ba84c6feeee76c6a918127bf0ca5fd1")).toBeUndefined();
    expect(index.get(`base:${SAVUSD}`)).toBeUndefined();
    const ambiguous = resolveLenderTokenIds([
      { assetId: "z-collateral", chain: "ethereum", address: SAVUSD },
      { assetId: "a-collateral", chain: "ethereum", address: SAVUSD },
      { assetId: "a-collateral", chain: "ethereum", address: SAVUSD },
    ]);
    expect(ambiguous.get(`ethereum:${SAVUSD}`)).toEqual(["a-collateral", "z-collateral"]);
  });

  type OkBook = Extract<LenderBookObservation, { status: "ok" }>;
  const invalidBooks: Array<[string, (observation: OkBook) => void]> = [
    ["uint256 overflow", observation => { observation.deployments[0]!.markets[0]!.includedAssetsRaw = (1n << 256n).toString(); }],
    ["malformed raw value", observation => { observation.deployments[0]!.markets[0]!.lltvRaw = "unreadable"; }],
    ["signed raw value", observation => { observation.deployments[0]!.markets[0]!.includedAssetsRaw = "-1"; }],
    ["noncanonical raw value", observation => { observation.deployments[0]!.markets[0]!.includedAssetsRaw = "01"; }],
    ["duplicate deployments", observation => { observation.deployments.push(structuredClone(observation.deployments[0]!)); }],
    ["unsorted deployments", observation => {
      const later = structuredClone(observation.deployments[0]!);
      later.chain = "z-chain"; later.pin.chain = "z-chain";
      observation.deployments.unshift(later);
    }],
    ["duplicate market/account claims", observation => { observation.deployments[0]!.markets.push(structuredClone(observation.deployments[0]!.markets[0]!)); }],
    ["unsorted markets", observation => { observation.deployments[0]!.markets.reverse(); }],
    ["duplicate selectors", observation => { observation.deployments[0]!.selectorsRead.push(observation.deployments[0]!.selectorsRead[0]!); }],
    ["unsorted selectors", observation => { observation.deployments[0]!.selectorsRead.reverse(); }],
    ["one-unit unexplained residual", observation => { observation.deployments[0]!.totalAssetsRaw = "1000001"; }],
    ["signed residual", observation => { observation.deployments[0]!.reconciliationResidualRaw = "-1"; }],
    ["pin/chain mismatch", observation => { observation.deployments[0]!.pin.chain = "base"; }],
    ["market/loan mismatch", observation => { observation.deployments[0]!.markets[0]!.loanToken = FTUSD; }],
    ["LLTV above WAD", observation => { observation.deployments[0]!.markets[0]!.lltvRaw = "1000000000000000001"; }],
    ["fee above WAD", observation => { observation.deployments[0]!.markets[0]!.marketFeeRaw = "1000000000000000001"; }],
    ["borrower position", observation => { observation.deployments[0]!.markets[0]!.positionBorrowSharesRaw = "1"; }],
    ["posted collateral", observation => { observation.deployments[0]!.markets[0]!.positionCollateralRaw = "1"; }],
    ["zero NAV as successful book", observation => { observation.deployments[0]!.totalAssetsRaw = "0"; }],
  ];
  it.each(invalidBooks)("rejects %s as a schema result without throwing or repairing quantities", (_label, mutate) => {
    if (complete.status !== "ok") throw new Error("Expected complete fixture");
    const observation = structuredClone(complete);
    mutate(observation);
    let accepted: boolean | undefined;
    expect(() => { accepted = LenderBookObservationSchema.safeParse(observation).success; }).not.toThrow();
    expect(accepted).toBe(false);
  });

  it("rejects a truncated unavailable book rather than admitting its surviving deployments", () => {
    expect(LenderBookObservationSchema.safeParse({
      ...complete, status: "unavailable", reason: "incomplete-census", failedDeploymentKey: null,
    }).success).toBe(false);
  });

  it("checks exact content identity and inclusive original-clock freshness independently of schema parsing", () => {
    expect(lenderBookAdmissionReason(complete, YIELD, clockSec, policy)).toBeNull();
    expect(lenderBookAdmissionReason({ ...complete, contentSha256: "0".repeat(64) }, YIELD, clockSec, policy)).toBe("identity-mismatch");
    expect(lenderBookAdmissionReason(complete, PRIME, clockSec, policy)).toBe("identity-mismatch");
    expect(lenderBookAdmissionReason(complete, YIELD, clockSec - 101, policy)).toBe("future-dated");
    expect(lenderBookAdmissionReason(complete, YIELD, clockSec - 100 + 28800, policy)).toBeNull();
    expect(lenderBookAdmissionReason(complete, YIELD, clockSec - 100 + 28801, policy)).toBe("stale");
  });

  it("requires accepted-row identity joins, canonical gap IDs and explicit unavailable nullability", () => {
    const template = createNativeSafetyScoreV9FullRegistryInput();
    const bundle = acceptedBundle(template);
    expect(LenderCollateralBackingSchema.safeParse(bundle).success).toBe(true);
    expect(LenderCollateralBackingSchema.safeParse({ ...bundle, status: "unavailable", reason: "accepted-source-unavailable" }).success).toBe(false);
    const unavailable = {
      ...bundle, status: "unavailable", reason: "accepted-source-unavailable", publicationGenerationId: null,
      publishedAtSec: null, policyDigest: null, evaluationBuildDigest: null, byAssetId: {},
    };
    expect(LenderCollateralBackingSchema.safeParse(unavailable).success).toBe(true);
    const row = bundle.byAssetId["savusd-avant"]!;
    expect(LenderCollateralBackingSchema.safeParse({ ...bundle, byAssetId: { "savusd-avant": { ...row, assetId: "iusd-infinifi" } } }).success).toBe(false);
    expect(LenderCollateralBackingSchema.safeParse({ ...bundle, tokenToAssetId: {} }).success).toBe(false);
    for (const sourceGapIds of [["gap:2", "gap:1"], ["gap:1", "gap:1"]]) {
      expect(LenderCollateralBackingSchema.safeParse({ ...bundle, byAssetId: { "savusd-avant": { ...row, sourceGapIds } } }).success).toBe(false);
    }
    for (const backingScore of [NaN, Infinity, -1, 101]) {
      expect(LenderCollateralBackingSchema.safeParse({ ...bundle, byAssetId: { "savusd-avant": { ...row, backingScore } } }).success).toBe(false);
    }
    expect(LenderCollateralBackingSchema.safeParse({ ...bundle, byAssetId: { "savusd-avant": { ...row, sourceCause: "U", sourceGapIds: [] } } }).success).toBe(false);
  });
});
