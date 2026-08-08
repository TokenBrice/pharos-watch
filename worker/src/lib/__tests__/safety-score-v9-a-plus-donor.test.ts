import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { describe, expect, it } from "vitest";
import {
  computeReportCardsRegistryFingerprint,
  createReportCardsFixedInput,
  type ReportCardsFixedInputDraft,
} from "../report-cards-fixed-input";
import { buildSafetyScoreV9Candidate, computeSafetyScoreV9CandidateId } from "../safety-score-v9-candidate";
import {
  SafetyScoreV9FactSetExtensionV2Schema,
  type SafetyScoreV9FactSetExtensionV2,
} from "../safety-score-v9-fact-set";

const COMPOSITE_ID = "fixture-a-plus-composite";
const SUPPORT_ID = "usdc-circle";
const PUBLISHED_AT_SEC = 1_784_199_880;
const RETAINED_DONOR_REGISTRY_FINGERPRINT = "1778128d7fb2310eaac57c924f3a7b1110915427ab6dadd5c18b4712b6e6d76c";
const DAI_DEX_ROUTE_ID =
  "dex:dai-makerdao:dl:ethereum%3Afp%3Aethereum%3Acurve%3A0x6b175474e89094c44da98b954eedeac495271d0f%3A0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48%3A0xdac17f958d2ee523a2206206994597c13d831ec7:ethereum%3A0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const DAI_REDEMPTION_ROUTE_ID = "redemption:dai-makerdao:psm-swap";
const RETAINED_344_ASSET_IDENTITY = {
  baseInputGenerationId: "report-cards-input:v1:eb6291212ca82c28388f2db1241b33749a677ea152515076fa0df0e27d03fd58",
  dexPayloadFingerprint: "9a11470413bf238373e5309e95ed89bc2b893ca4a5cfc254f20046c5fd2f13fe",
  redemptionPayloadFingerprint: "d84911de7b257e4754e6a5c7c4853b87c1c99812a2fecca6978481396203c33f",
  researchOverlayDigest: "0a6721d265d85611dc8b7d88fcccfabefb158e63013ebee72c3f9746b0b1dc15",
  factSetDigest: "89ae515b8be840a209988bfc73f5bea305bb3e66dce2b79f5340b47f687eaf99",
  evaluatedSetDigest: "26211b579c0699539d75692b2955e4b6befa15f0c256df63e40e0619335072a5",
  scoreResultDigest: "62928bec680d4f7137d7265f2f3f88300645c6f32885a865fe71370151e89718",
  publicationGenerationId:
    "report-cards:v9:candidate:v1:c88f3b245540f83e157d7948d9a1b239a493e7bdafe205a9ec2354bca51a7596",
} as const;

// These frozen capture fragments intentionally stay raw until the production
// fixed-input and extension schemas validate the assembled two-asset fixture.
type DonorFixedInputFragment = Pick<
  ReportCardsFixedInputDraft,
  | "capturedAt"
  | "sourceGeneration"
  | "dexGenerationId"
  | "redemptionGenerationId"
  | "registryRevision"
  | "methodologyVersion"
  | "clockSec"
  | "updatedAt"
  | "liquidityStale"
  | "redemptionStale"
  | "inputFreshness"
  | "pegDataById"
  | "redemptionBackstopMap"
  | "resolvedBlacklistStatuses"
  | "liveReserveMap"
  | "liveReserveProvenanceMap"
  | "chainCirculatingById"
> & {
  dexLiqMap: Record<string, Partial<ReportCardsFixedInputDraft["dexLiqMap"][string]>>;
};

const donorFixed = {
  capturedAt: "2026-07-16T11:04:30.000Z",
  sourceGeneration: "report-cards:8.17:1784199667",
  dexGenerationId: "dex-liquidity-1784198459",
  redemptionGenerationId: "redemption:c34304f1-70b6-47d1-8949-8ba9e63dcccc",
  registryRevision: "sha256:1778128d7fb2310eaac57c924f3a7b1110915427ab6dadd5c18b4712b6e6d76c",
  methodologyVersion: "8.17",
  clockSec: 1784199870,
  updatedAt: 1784199667,
  liquidityStale: false,
  redemptionStale: false,
  inputFreshness: {
    dexLiquidity: {
      updatedAt: 1784198459,
      ageSeconds: 1411,
      stale: false,
    },
    redemptionBackstops: {
      updatedAt: 1784175209,
      ageSeconds: 24661,
      stale: false,
    },
  },
  pegDataById: {
    "bold-liquity": {
      id: "bold-liquity",
      symbol: "BOLD",
      name: "Liquity BOLD",
      pegType: "peggedUSD",
      pegCurrency: "USD",
      governance: "decentralized",
      currentDeviationBps: 11,
      depegEventCoverageLimited: false,
      pegScore: 100,
      pegPct: 99.97056337115818,
      severityScore: 99.76436351026942,
      spreadPenalty: 0.15939338129295078,
      eventCount: 6,
      worstDeviationBps: 134,
      activeDepeg: false,
      lastEventAt: 1773394239,
      trackingSpanDays: 423,
      methodologyVersion: "6.096",
    },
    "usdc-circle": {
      id: "usdc-circle",
      symbol: "USDC",
      name: "USD Coin",
      pegType: "peggedUSD",
      pegCurrency: "USD",
      governance: "centralized",
      currentDeviationBps: 0,
      depegEventCoverageLimited: false,
      pegScore: 93,
      pegPct: 99.84874562704388,
      severityScore: 99.77995322882757,
      spreadPenalty: 7.22367981017985,
      eventCount: 3,
      worstDeviationBps: -1211,
      activeDepeg: false,
      lastEventAt: 1678683726,
      trackingSpanDays: 1461,
      methodologyVersion: "6.096",
    },
  },
  dexLiqMap: {
    "dai-makerdao": {
      liquidityScore: 52,
      effectiveTvlUsd: 56588372,
      balanceMeasuredTvlUsd: 160908368.1562387,
      organicMeasuredTvlUsd: 208127513.99127698,
      methodologyVersion: "5.84",
      updatedAt: 1784198459,
      exitRouteObservations: [
        {
          routeId:
            "dex:dai-makerdao:dl:ethereum%3Afp%3Aethereum%3Acurve%3A0x6b175474e89094c44da98b954eedeac495271d0f%3A0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48%3A0xdac17f958d2ee523a2206206994597c13d831ec7:ethereum%3A0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          routeFamily: "dex-amm",
          scope: {
            kind: "chain-contract",
            chain: "Ethereum",
            contractOrPoolId:
              "fp:ethereum:curve:0x6b175474e89094c44da98b954eedeac495271d0f:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:0xdac17f958d2ee523a2206206994597c13d831ec7",
            protocol: "curve",
          },
          requestedNotionalUsd: 1000000,
          settlementHorizonSec: 300,
          maxCostBps: 200,
          executableUsd: 1000000,
          completionRatio: 1,
          output: {
            kind: "tracked-stablecoin",
            trackedAssetIds: ["usdc-circle"],
            assetKeys: ["ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
          },
          evidenceKind: "reserve-based-amm-simulation",
          confidence: "high",
          scoreEligible: true,
          observedAt: 1784198459,
          freshnessSeconds: 0,
          commonModeKeys: [
            "asset:usdc-circle",
            "chain:ethereum",
            "pool:ethereum:fp:ethereum:curve:0x6b175474e89094c44da98b954eedeac495271d0f:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:0xdac17f958d2ee523a2206206994597c13d831ec7",
            "protocol:curve",
            "token:ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          ],
          capacityCurve: [
            {
              requestedNotionalUsd: 100000,
              maxCostBps: 200,
              executableUsd: 100000,
              completionRatio: 1,
            },
            {
              requestedNotionalUsd: 1000000,
              maxCostBps: 200,
              executableUsd: 1000000,
              completionRatio: 1,
            },
            {
              requestedNotionalUsd: 10000000,
              maxCostBps: 200,
              executableUsd: 10000000,
              completionRatio: 1,
            },
            {
              requestedNotionalUsd: 25000000,
              maxCostBps: 200,
              executableUsd: 25000000,
              completionRatio: 1,
            },
          ],
        },
      ],
    },
  },
  redemptionBackstopMap: {
    "dai-makerdao": {
      stablecoinId: "dai-makerdao",
      score: 100,
      dexLiquidityScore: 54,
      accessScore: 100,
      settlementScore: 100,
      executionCertaintyScore: 100,
      capacityScore: 100,
      outputAssetQualityScore: 100,
      costScore: 100,
      routeFamily: "psm-swap",
      accessModel: "permissionless-onchain",
      settlementModel: "atomic",
      executionModel: "deterministic-onchain",
      outputAssetType: "stable-single",
      provider: "reserve-sync-metadata",
      sourceMode: "dynamic",
      resolutionState: "resolved",
      routeStatus: "open",
      routeStatusSource: "onchain",
      routeStatusReason: "Sky LitePSM USDC pocket balance is readable on-chain",
      holderEligibility: "any-holder",
      capacityConfidence: "live-direct",
      capacityBasis: "live-direct-telemetry",
      capacitySemantics: "immediate-bounded",
      capacityProfile: {
        immediateUsd: 4278091764.838237,
        eventualUsd: 4855567035.570997,
        scoringUsd: 4278091764.838237,
        scoringHorizon: "immediate",
        capacityProfileConfidence: "live-direct",
        modeledExitSizeUsd: 25000000,
        exitRouteObservations: [
          {
            routeId: "redemption:dai-makerdao:psm-swap",
            routeFamily: "protocol-redemption",
            scope: {
              kind: "protocol",
              protocol: "dai-makerdao",
            },
            requestedNotionalUsd: 25000000,
            settlementHorizonSec: 300,
            maxCostBps: 200,
            executableUsd: 25000000,
            completionRatio: 1,
            output: {
              kind: "tracked-stablecoin",
              trackedAssetIds: ["usdc-circle"],
            },
            evidenceKind: "onchain-contract-state",
            confidence: "high",
            scoreEligible: true,
            observedAt: 1784175209,
            freshnessSeconds: 0,
            commonModeKeys: ["protocol:dai-makerdao"],
            capacityCurve: [
              {
                requestedNotionalUsd: 100000,
                maxCostBps: 200,
                executableUsd: 100000,
                completionRatio: 1,
              },
              {
                requestedNotionalUsd: 1000000,
                maxCostBps: 200,
                executableUsd: 1000000,
                completionRatio: 1,
              },
              {
                requestedNotionalUsd: 5000000,
                maxCostBps: 200,
                executableUsd: 5000000,
                completionRatio: 1,
              },
              {
                requestedNotionalUsd: 25000000,
                maxCostBps: 200,
                executableUsd: 25000000,
                completionRatio: 1,
              },
            ],
          },
        ],
      },
      feeConfidence: "fixed",
      feeModelKind: "fixed-bps",
      modelConfidence: "high",
      confidenceDetails: {
        capacityEvidenceQuality: 100,
        feeEvidenceQuality: 100,
        routeStatusFreshness: 100,
        holderCohortBreadth: 100,
        sourceQuality: 100,
        reviewedDocAgeDays: 108,
        reasons: [],
      },
      immediateCapacityUsd: 4278091764.838237,
      immediateCapacityRatio: 0.881069447398773,
      eventualRedeemabilityScore: 100,
      capacityKind: "live-direct",
      freshnessKind: "same-run-onchain",
      sourceUrls: [
        "https://developers.sky.money/quick-start/guides/lite-psm/",
        "https://github.com/makerdao/dss-lite-psm",
      ],
      settlementDelaySec: 0,
      liveHolderEligibility: "any-holder",
      feeBps: 0,
      feeDescription: "LitePSM docs show fees are not activated for DAI <-> USDC",
      costScenarioScores: {
        retail: 100,
        activeUser: 100,
        institutional: 100,
      },
      routeExitCorrelation: "same-stablecoin-pool-backing",
      queueEnabled: false,
      methodologyVersion: "4.18",
      updatedAt: 1784175209,
      docs: {
        label: "Sky Info",
        url: "https://info.sky.money/",
        reviewedAt: "2026-03-30",
        provenance: "config-reviewed",
        sources: [
          {
            label: "Sky Info",
            url: "https://info.sky.money/",
            supports: ["capacity"],
          },
          {
            label: "Website",
            url: "https://makerdao.com/",
          },
          {
            label: "Docs",
            url: "https://docs.makerdao.com/",
          },
        ],
      },
      notes: [
        "Fresh Sky reserve telemetry uses current PSM USDC balance as immediate capacity; fallback retains the reviewed 33% heuristic when live metadata is unavailable",
        "Live redemption settlement delay is surfaced as a route constraint",
        "Sky LitePSM USDC pocket balance is readable on-chain",
      ],
      capsApplied: [],
    },
  },
  resolvedBlacklistStatuses: {
    "ausd-agora": true,
    "usdc-circle": true,
  },
  liveReserveMap: {
    "usdc-circle": [
      {
        name: "<3-Month U.S. Treasuries",
        pct: 73.9,
        risk: "very-low",
      },
      {
        name: "Other Bank Deposits",
        pct: 14.5,
        risk: "very-low",
      },
      {
        name: "Deposits at Systemically Important Institutions",
        pct: 10.3,
        risk: "very-low",
      },
      {
        name: "Overnight Reverse Treasury Repo",
        pct: 1.3,
        risk: "very-low",
      },
    ],
  },
  liveReserveProvenanceMap: {
    "usdc-circle": {
      source: "circle-transparency",
      fetchedAt: 1784189546,
    },
  },
  chainCirculatingById: {
    "pusd-polymarket": {
      Polygon: {
        current: 599351821.6545392,
        circulatingPrevDay: 600645177.3905188,
        circulatingPrevWeek: 580085866.3442531,
        circulatingPrevMonth: 0,
      },
    },
  },
} satisfies DonorFixedInputFragment;

type ExtensionAsset = SafetyScoreV9FactSetExtensionV2["assets"][number];
type DonorExtensionFragment = Omit<SafetyScoreV9FactSetExtensionV2, "assets"> & {
  assets: Array<{ assetId: string } & Partial<ExtensionAsset>>;
};

const donorReplay = {
  extension: {
    compiledAtSec: 1784199870,
    registryFingerprint: "1778128d7fb2310eaac57c924f3a7b1110915427ab6dadd5c18b4712b6e6d76c",
    routeFreshness: {
      dexMaxAgeSec: 3600,
      documentedTermsMaxAgeSec: 31536000,
      redemptionMaxAgeSec: 28800,
    },
    schemaVersion: 2,
    sources: {
      chainSupply: {
        generationId: "chain-supply:v1:f39db0df57b99d4bd71927dda131757cf4e6b5fd71d3949153d11c8872fcf681",
        maxAgeSec: 1800,
        observedAtSec: 1784199667,
      },
      liveReserves: {
        generationId: "live-reserves:v1:d8eea2ec198aa4772bb22e7e73d2bb63c13be4d17a8753a0e11aa56995b474f5",
        maxAgeSec: 28800,
        observedAtSec: 1784189884,
      },
      peg: {
        generationId: "peg:v1:2b3414cddf778c629265e466540c3fad0ef66507a776c21f462079b73554f377",
        maxAgeSec: 1800,
        observedAtSec: 1784199667,
      },
      registryObservedAtSec: 1784199667,
      researchOverlays: {
        generationId: "registry:sha256:1778128d7fb2310eaac57c924f3a7b1110915427ab6dadd5c18b4712b6e6d76c",
        maxAgeSec: 31536000,
        observedAtSec: 1784199667,
      },
      unavailableRedemptionObservedAtSec: 1784175209,
    },
    assets: [
      {
        assetId: "ausd-agora" as const,
        mechanismRiskReview: {
          archetype: "fiat-cash",
          assuranceAndReconciliation: {
            failureDomains: [],
            quality: "strong",
            status: {
              applicability: {
                gapId: null,
                policyRuleId: "v9.backing.mechanism-review",
                rationale: null,
                state: "required",
              },
              evidenceRefIds: ["extension-evidence:mechanism:assurance-and-reconciliation"],
              gapIds: [],
              observationState: "known",
            },
          },
          claimAndSegregation: {
            failureDomains: [],
            quality: "strong",
            status: {
              applicability: {
                gapId: null,
                policyRuleId: "v9.backing.mechanism-review",
                rationale: null,
                state: "required",
              },
              evidenceRefIds: ["extension-evidence:mechanism:claim-and-segregation"],
              gapIds: [],
              observationState: "known",
            },
          },
          custodyContinuity: {
            failureDomains: [],
            quality: "adequate",
            status: {
              applicability: {
                gapId: null,
                policyRuleId: "v9.backing.mechanism-review",
                rationale: null,
                state: "required",
              },
              evidenceRefIds: ["extension-evidence:mechanism:custody-continuity"],
              gapIds: [],
              observationState: "known",
            },
          },
        },
        accessReview: {
          freeze: {
            reviews: [
              {
                controlKey: null,
                failureDomains: [],
                reach: "individual",
                reviewKey: "blacklist:ausd-agora",
                source: "blacklist",
                status: {
                  applicability: {
                    gapId: null,
                    policyRuleId: "v9.access.freeze-review",
                    rationale: null,
                    state: "required",
                  },
                  evidenceRefIds: ["stablecoin-meta.blacklistability-review:0:b9898c8ea93851f6"],
                  gapIds: [],
                  observationState: "known",
                },
                upstreamAssetId: null,
              },
            ],
            status: {
              applicability: {
                gapId: null,
                policyRuleId: "v9.access.freeze-review",
                rationale: null,
                state: "required",
              },
              evidenceRefIds: ["stablecoin-meta.blacklistability-review:0:b9898c8ea93851f6"],
              gapIds: [],
              observationState: "known",
            },
          },
          transfer: {
            posture: "restrictable",
            status: {
              applicability: {
                gapId: null,
                policyRuleId: "v9.access.transfer-review",
                rationale: null,
                state: "required",
              },
              evidenceRefIds: ["stablecoin-meta.blacklistability-review:0:b9898c8ea93851f6"],
              gapIds: [],
              observationState: "known",
            },
          },
        },
        researchEvidence: [
          {
            confidence: "manual-review",
            contentSha256: "b9898c8ea93851f6b4aa923fd630e92d448a25d276eccb9d958fc0b142fd9803",
            evidenceKey: "stablecoin-meta.blacklistability-review:0:b9898c8ea93851f6",
            maxAgeSec: null,
            observedAtSec: 1778544000,
            publishedAtSec: null,
            sourceId: "stablecoin-meta.blacklistability-review",
            url: null,
          },
        ],
        componentEvidence: [
          {
            componentKey: "access:freeze",
            evidenceKeys: ["stablecoin-meta.blacklistability-review:0:b9898c8ea93851f6"],
          },
          {
            componentKey: "access:freeze:blacklist:ausd-agora",
            evidenceKeys: ["stablecoin-meta.blacklistability-review:0:b9898c8ea93851f6"],
          },
          {
            componentKey: "access:transfer",
            evidenceKeys: ["stablecoin-meta.blacklistability-review:0:b9898c8ea93851f6"],
          },
        ],
      },
      {
        assetId: "bold-liquity" as const,
        pegReference: {
          failureDomains: [],
          referenceKey: "USD",
          referenceKind: "fiat",
        },
      },
      {
        assetId: "dai-makerdao" as const,
        routeReviews: [
          {
            coverageClass: "exact-lower-bound",
            executionCertainty: "bounded",
            modelConfidence: "medium",
            executionCosts: [
              {
                executionCostBps: 200,
                maxCostBps: 200,
                requestedNotionalUsd: 100000,
              },
              {
                executionCostBps: 200,
                maxCostBps: 200,
                requestedNotionalUsd: 1000000,
              },
              {
                executionCostBps: 200,
                maxCostBps: 200,
                requestedNotionalUsd: 10000000,
              },
              {
                executionCostBps: 200,
                maxCostBps: 200,
                requestedNotionalUsd: 25000000,
              },
            ],
            executionModel: "market-depth",
            failureDomains: [],
            holderAccess: "permissionless",
            lane: "dex",
            output: {
              assetKeys: ["usdc-circle"],
              basketWeights: [],
              kind: "tracked-stablecoin",
              valuation: {
                basis: "price",
                confidence: "medium",
                contentSha256: null,
                expectedUnitValueUsd: 1,
                maxAgeSec: null,
                observedAtSec: 1784198459,
                referenceAssetKey: "usdc-circle",
                sourceGenerationId: "dex-liquidity-1784198459",
                sourceId: "report-cards-peg-summary",
                unitValueUsd: 1,
                url: null,
              },
            },
            physicalResourceKeys: [
              "pool:Ethereum:fp:ethereum:curve:0x6b175474e89094c44da98b954eedeac495271d0f:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:0xdac17f958d2ee523a2206206994597c13d831ec7",
            ],
            routeId:
              "dex:dai-makerdao:dl:ethereum%3Afp%3Aethereum%3Acurve%3A0x6b175474e89094c44da98b954eedeac495271d0f%3A0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48%3A0xdac17f958d2ee523a2206206994597c13d831ec7:ethereum%3A0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            settlementModel: "atomic",
            settlementSlaSec: 0,
          },
          {
            coverageClass: "exact-lower-bound",
            executionCertainty: "bounded",
            modelConfidence: "medium",
            executionCosts: [
              {
                executionCostBps: 0,
                maxCostBps: 200,
                requestedNotionalUsd: 100000,
              },
              {
                executionCostBps: 0,
                maxCostBps: 200,
                requestedNotionalUsd: 1000000,
              },
              {
                executionCostBps: 0,
                maxCostBps: 200,
                requestedNotionalUsd: 25000000,
              },
              {
                executionCostBps: 0,
                maxCostBps: 200,
                requestedNotionalUsd: 5000000,
              },
            ],
            executionModel: "deterministic",
            failureDomains: [],
            holderAccess: "permissionless",
            lane: "redemption",
            output: {
              assetKeys: ["usdc-circle"],
              basketWeights: [],
              kind: "tracked-stablecoin",
              valuation: {
                basis: "price",
                confidence: "medium",
                contentSha256: null,
                expectedUnitValueUsd: 1,
                maxAgeSec: null,
                observedAtSec: 1784175209,
                referenceAssetKey: "usdc-circle",
                sourceGenerationId: "redemption:c34304f1-70b6-47d1-8949-8ba9e63dcccc",
                sourceId: "report-cards-peg-summary",
                unitValueUsd: 1,
                url: null,
              },
            },
            physicalResourceKeys: ["protocol:dai-makerdao"],
            routeId: "redemption:dai-makerdao:psm-swap",
            settlementModel: "atomic",
            settlementSlaSec: 0,
          },
        ],
      },
      {
        assetId: "europ-schuman" as const,
        mechanismRiskReview: {
          archetype: "fiat-cash",
          assuranceAndReconciliation: {
            failureDomains: [],
            quality: "adequate",
            status: {
              applicability: {
                gapId: null,
                policyRuleId: "v9.backing.mechanism-review",
                rationale: null,
                state: "required",
              },
              evidenceRefIds: ["extension-evidence:mechanism:assurance-and-reconciliation"],
              gapIds: [],
              observationState: "known",
            },
          },
          claimAndSegregation: {
            failureDomains: [],
            quality: "strong",
            status: {
              applicability: {
                gapId: null,
                policyRuleId: "v9.backing.mechanism-review",
                rationale: null,
                state: "required",
              },
              evidenceRefIds: ["extension-evidence:mechanism:claim-and-segregation"],
              gapIds: [],
              observationState: "known",
            },
          },
          custodyContinuity: {
            failureDomains: [],
            quality: "strong",
            status: {
              applicability: {
                gapId: null,
                policyRuleId: "v9.backing.mechanism-review",
                rationale: null,
                state: "required",
              },
              evidenceRefIds: ["extension-evidence:mechanism:custody-continuity"],
              gapIds: [],
              observationState: "known",
            },
          },
        },
      },
      {
        assetId: "sdola-inverse-finance" as const,
        controlReview: {
          controls: [
            {
              authority: {
                authorityKey: "ethereum:0xb45ad160634c528cc3d2926d9807104fa3157305",
                model: "contract",
                threshold: null,
              },
              capSemantics: {
                bound: null,
                kind: "not-applicable",
              },
              capabilities: [],
              claimImpairment: "none",
              controlKey: "mint-meta:sdola-inverse-finance:0:2e2408be382ca94f84cc",
              controlKind: "mint",
              delaySec: null,
              deploymentKey: "asset:sdola-inverse-finance",
              economicLossScope: "access-only",
              failureDomains: [
                {
                  key: "ethereum:0xb45ad160634c528cc3d2926d9807104fa3157305",
                  kind: "mint-control",
                },
              ],
              keyCustody: "unknown",
              modulesOrGuards: "unknown",
              incidentState: "none",
              materialSupplyShare: null,
              scope: "global",
            },
          ],
          state: "reviewed-controls",
        },
        economicControlReview: {
          bridge: {
            routes: [],
            status: {
              applicability: {
                gapId: null,
                policyRuleId: "v9.control.bridge-review",
                rationale: "Every reviewed deployment route is native issuance; no bridge control carries the claim.",
                state: "not-applicable",
              },
              evidenceRefIds: [
                "stablecoin-meta.bridge-route-risk:0:b203420e4331b092",
                "stablecoin-meta.bridge-route-risk:1:11466b79ead57814",
                "stablecoin-meta.bridge-route-risk:2:2fa668e2df97413e",
              ],
              gapIds: [],
              observationState: "known",
            },
          },
          mint: {
            controlKey: null,
            reconciliation: "not-applicable",
            status: {
              applicability: {
                gapId: null,
                policyRuleId: "v9.control.mint-review",
                rationale: null,
                state: "required",
              },
              evidenceRefIds: [
                "stablecoin-meta.mint-authority:0:8e07e78f0fb9a457",
                "stablecoin-meta.mint-authority:1:a0f7405d0bc5755d",
              ],
              gapIds: [],
              observationState: "known",
            },
            supervision: "unknown",
            latestResolvedIncidentAtSec: null,
            upgrade: {
              controlKey: null,
              state: "immutable",
            },
          },
          oracle: {
            branches: [],
            status: {
              applicability: {
                gapId: null,
                policyRuleId: "v9.control.oracle-review",
                rationale:
                  "Inverse documents sDOLA as a DOLA savings wrapper: users deposit and withdraw DOLA while FiRM revenue accrues through the exchange rate. sDOLA holders do not open FiRM borrower positions, so there are no sDOLA collateral-market or liquidation branches to inventory; the underlying DOLA parent carries the separate FiRM oracle profile.",
                state: "not-applicable",
              },
              evidenceRefIds: [
                "stablecoin-meta.oracle-risk:0:3d569028a463fce3",
                "stablecoin-meta.oracle-risk:1:479582b567ec9ab7",
              ],
              gapIds: [],
              observationState: "known",
            },
            tier: null,
          },
        },
        researchEvidence: [
          {
            confidence: "verified",
            contentSha256: "b203420e4331b092ff7e519bf5a64e48ea24068b19dfef1bf913cd6985b84875",
            evidenceKey: "stablecoin-meta.bridge-route-risk:0:b203420e4331b092",
            maxAgeSec: null,
            observedAtSec: 1781308800,
            publishedAtSec: null,
            sourceId: "stablecoin-meta.bridge-route-risk",
            url: "https://docs.chain.link/ccip",
          },
          {
            confidence: "verified",
            contentSha256: "11466b79ead57814b4c501d9e899d07be211c6c547dc3d620f872696716eda86",
            evidenceKey: "stablecoin-meta.bridge-route-risk:1:11466b79ead57814",
            maxAgeSec: null,
            observedAtSec: 1781308800,
            publishedAtSec: null,
            sourceId: "stablecoin-meta.bridge-route-risk",
            url: "https://docs.inverse.finance/inverse-finance/inverse-finance/products/tokens/dola/dola-cross-chain-guide",
          },
          {
            confidence: "verified",
            contentSha256: "2fa668e2df97413e3288b303a3a3fa76f8c4b2396d25ed58817c2af4d447679a",
            evidenceKey: "stablecoin-meta.bridge-route-risk:2:2fa668e2df97413e",
            maxAgeSec: null,
            observedAtSec: 1781308800,
            publishedAtSec: null,
            sourceId: "stablecoin-meta.bridge-route-risk",
            url: "https://docs.inverse.finance/inverse-finance/inverse-finance/products/tokens/dola/sdola",
          },
          {
            confidence: "verified",
            contentSha256: "8e07e78f0fb9a457dc62e61b74489443702ce0baf4080e99f398dd7d52c466ff",
            evidenceKey: "stablecoin-meta.mint-authority:0:8e07e78f0fb9a457",
            maxAgeSec: null,
            observedAtSec: 1784073600,
            publishedAtSec: null,
            sourceId: "stablecoin-meta.mint-authority",
            url: "https://etherscan.io/address/0xb45ad160634c528Cc3D2926d9807104FA3157305#code",
          },
          {
            confidence: "verified",
            contentSha256: "a0f7405d0bc5755d80a8dac4ef5d9b38678483a2f4c0603b52fde661f9621b87",
            evidenceKey: "stablecoin-meta.mint-authority:1:a0f7405d0bc5755d",
            maxAgeSec: null,
            observedAtSec: 1784073600,
            publishedAtSec: null,
            sourceId: "stablecoin-meta.mint-authority",
            url: "https://github.com/InverseFinance/dola-savings/blob/f9467b932c4cce460dc1267c6bc280327cf66a72/src/sDola.sol",
          },
          {
            confidence: "verified",
            contentSha256: "3d569028a463fce3b53f7e109305fd0039c4f48be239658cdc69a2aaa9c60295",
            evidenceKey: "stablecoin-meta.oracle-risk:0:3d569028a463fce3",
            maxAgeSec: null,
            observedAtSec: 1783987200,
            publishedAtSec: null,
            sourceId: "stablecoin-meta.oracle-risk",
            url: "https://docs.inverse.finance/inverse-finance/inverse-finance/product-guide/firm",
          },
          {
            confidence: "verified",
            contentSha256: "479582b567ec9ab7f8dbcdabfddb101b7adb274b1e46407ffd8bc281ce9602df",
            evidenceKey: "stablecoin-meta.oracle-risk:1:479582b567ec9ab7",
            maxAgeSec: null,
            observedAtSec: 1783987200,
            publishedAtSec: null,
            sourceId: "stablecoin-meta.oracle-risk",
            url: "https://docs.inverse.finance/inverse-finance/inverse-finance/product-guide/tokens/sdola",
          },
        ],
        componentEvidence: [
          {
            componentKey: "control",
            evidenceKeys: [
              "stablecoin-meta.bridge-route-risk:0:b203420e4331b092",
              "stablecoin-meta.bridge-route-risk:1:11466b79ead57814",
              "stablecoin-meta.bridge-route-risk:2:2fa668e2df97413e",
              "stablecoin-meta.mint-authority:0:8e07e78f0fb9a457",
              "stablecoin-meta.mint-authority:1:a0f7405d0bc5755d",
            ],
          },
          {
            componentKey: "economic-control:bridge",
            evidenceKeys: [
              "stablecoin-meta.bridge-route-risk:0:b203420e4331b092",
              "stablecoin-meta.bridge-route-risk:1:11466b79ead57814",
              "stablecoin-meta.bridge-route-risk:2:2fa668e2df97413e",
            ],
          },
          {
            componentKey: "economic-control:mint",
            evidenceKeys: [
              "stablecoin-meta.mint-authority:0:8e07e78f0fb9a457",
              "stablecoin-meta.mint-authority:1:a0f7405d0bc5755d",
            ],
          },
          {
            componentKey: "economic-control:oracle",
            evidenceKeys: [
              "stablecoin-meta.oracle-risk:0:3d569028a463fce3",
              "stablecoin-meta.oracle-risk:1:479582b567ec9ab7",
            ],
          },
          {
            componentKey: "economic-control:oracle:backstop",
            evidenceKeys: [
              "stablecoin-meta.oracle-risk:0:3d569028a463fce3",
              "stablecoin-meta.oracle-risk:1:479582b567ec9ab7",
            ],
          },
          {
            componentKey: "economic-control:oracle:collateral-parameter",
            evidenceKeys: [
              "stablecoin-meta.oracle-risk:0:3d569028a463fce3",
              "stablecoin-meta.oracle-risk:1:479582b567ec9ab7",
            ],
          },
          {
            componentKey: "economic-control:oracle:feed",
            evidenceKeys: [
              "stablecoin-meta.oracle-risk:0:3d569028a463fce3",
              "stablecoin-meta.oracle-risk:1:479582b567ec9ab7",
            ],
          },
          {
            componentKey: "economic-control:oracle:liquidation",
            evidenceKeys: [
              "stablecoin-meta.oracle-risk:0:3d569028a463fce3",
              "stablecoin-meta.oracle-risk:1:479582b567ec9ab7",
            ],
          },
          {
            componentKey: "economic-control:oracle:shutdown-bad-debt",
            evidenceKeys: [
              "stablecoin-meta.oracle-risk:0:3d569028a463fce3",
              "stablecoin-meta.oracle-risk:1:479582b567ec9ab7",
            ],
          },
        ],
      },
      {
        assetId: "usdc-circle" as const,
        dependencies: {
          baseSource: "live-unmapped",
          dependencyFromLive: true,
          diagnostics: {
            graphState: "valid",
            issueCodes: [],
            sccMemberAssetIds: [],
          },
          edges: [],
          fallbackReason: null,
          mappedLiveReserveWeight: 0,
          source: "live-unmapped",
        },
        reserveApplicability: {
          state: "required",
        },
        reserveClassifications: [
          {
            assetClass: "treasury-bill",
            classificationKey: "registry-reviewed:reserve:09933f5382674273c4266be0:2a966dcb71e45571",
            exposureKey: "reserve:09933f5382674273c4266be0",
            failureDomains: [
              {
                key: "United States Treasury",
                kind: "reserve-issuer",
              },
            ],
            issuerOrObligorKey: "United States Treasury",
            liquidityHorizon: "one-day",
            maturityDaysMax: 92,
            riskFactors: ["custody", "duration", "liquidity"],
          },
          {
            assetClass: "bank-deposit",
            classificationKey: "registry-reviewed:reserve:266b42c10fda0e890acbf4d8:2a966dcb71e45571",
            exposureKey: "reserve:266b42c10fda0e890acbf4d8",
            failureDomains: [
              {
                key: "Systemically important financial institutions",
                kind: "reserve-issuer",
              },
            ],
            issuerOrObligorKey: "Systemically important financial institutions",
            liquidityHorizon: "immediate",
            maturityDaysMax: null,
            riskFactors: ["concentration", "counterparty", "custody"],
          },
          {
            assetClass: "repo",
            classificationKey: "registry-reviewed:reserve:2b522c9a32bfa55000f159ea:2a966dcb71e45571",
            exposureKey: "reserve:2b522c9a32bfa55000f159ea",
            failureDomains: [
              {
                key: "Leading global banks",
                kind: "reserve-issuer",
              },
            ],
            issuerOrObligorKey: "Leading global banks",
            liquidityHorizon: "one-day",
            maturityDaysMax: 1,
            riskFactors: ["counterparty", "custody", "liquidity"],
          },
          {
            assetClass: "bank-deposit",
            classificationKey: "registry-reviewed:reserve:3f98b119d81209e7ecc14b13:2a966dcb71e45571",
            exposureKey: "reserve:3f98b119d81209e7ecc14b13",
            failureDomains: [
              {
                key: "Other regulated financial institutions",
                kind: "reserve-issuer",
              },
            ],
            issuerOrObligorKey: "Other regulated financial institutions",
            liquidityHorizon: "immediate",
            maturityDaysMax: null,
            riskFactors: ["concentration", "counterparty", "custody"],
          },
        ],
        pegReference: {
          failureDomains: [],
          referenceKey: "USD",
          referenceKind: "fiat",
        },
      },
      {
        assetId: "usdt-tether" as const,
        launchedAtSec: 1412553600,
      },
    ],
  },
} satisfies { extension: DonorExtensionFragment };

type DonorAsset = (typeof donorReplay.extension.assets)[number];

function donorAsset<AssetId extends DonorAsset["assetId"]>(
  assetId: AssetId,
): Extract<DonorAsset, { assetId: AssetId }> {
  const asset = donorReplay.extension.assets.find((candidate) => candidate.assetId === assetId);
  if (!asset) throw new Error(`Missing donor asset ${assetId}`);
  return asset as Extract<DonorAsset, { assetId: AssetId }>;
}

type DonorRouteReview = SafetyScoreV9FactSetExtensionV2["assets"][number]["routeReviews"][number];

function findDonorRouteReview(asset: { routeReviews: readonly DonorRouteReview[] }, routeId: string): DonorRouteReview {
  const review = asset.routeReviews.find((candidate) => candidate.routeId === routeId);
  if (!review) throw new Error(`Missing donor route review ${routeId}`);
  return review;
}

function findRoute<TRoute extends { routeId: string }>(routes: readonly TRoute[], routeId: string): TRoute {
  const route = routes.find((candidate) => candidate.routeId === routeId);
  if (!route) throw new Error(`Missing donor route ${routeId}`);
  return route;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function ownerRekey(value: string): string {
  return value
    .replaceAll("dai-makerdao", COMPOSITE_ID)
    .replaceAll("sdola-inverse-finance", COMPOSITE_ID)
    .replaceAll("ausd-agora", COMPOSITE_ID);
}

function objectKeysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(objectKeysDeep);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...objectKeysDeep(child)]);
}

function buildFixture() {
  const sourceDex = donorFixed.dexLiqMap["dai-makerdao"];
  const dexObservation = clone(findRoute(sourceDex.exitRouteObservations, DAI_DEX_ROUTE_ID));
  dexObservation.routeId = ownerRekey(dexObservation.routeId);
  const aggregateExecutableUsd = dexObservation.executableUsd;
  const sourceRedemption = donorFixed.redemptionBackstopMap["dai-makerdao"];
  const redemptionObservation = clone(sourceRedemption.capacityProfile.exitRouteObservations[0]);
  redemptionObservation.routeId = ownerRekey(redemptionObservation.routeId);

  const fixedInput = createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    activeAssetIds: [COMPOSITE_ID, SUPPORT_ID],
    capturedAt: donorFixed.capturedAt,
    sourceGeneration: donorFixed.sourceGeneration,
    dexGenerationId: donorFixed.dexGenerationId,
    redemptionGenerationId: donorFixed.redemptionGenerationId,
    registryRevision: donorFixed.registryRevision,
    methodologyVersion: donorFixed.methodologyVersion,
    clockSec: donorFixed.clockSec,
    updatedAt: donorFixed.updatedAt,
    liquidityStale: donorFixed.liquidityStale,
    redemptionStale: donorFixed.redemptionStale,
    inputFreshness: clone(donorFixed.inputFreshness),
    pegDataById: {
      [COMPOSITE_ID]: {
        ...clone(donorFixed.pegDataById["bold-liquity"]),
        id: COMPOSITE_ID,
        symbol: "A+FIXTURE",
        name: "A+ donor composite",
      },
      [SUPPORT_ID]: clone(donorFixed.pegDataById[SUPPORT_ID]),
    },
    activeDepegPeakBpsById: {},
    dexLiqMap: {
      [COMPOSITE_ID]: {
        liquidityScore: dexObservation.completionRatio * 100,
        concentrationHhi: 1,
        poolCount: 1,
        chainCount: 1,
        coverageClass: "primary",
        coverageConfidence: 1,
        liquidityEvidenceClass: "measured",
        hasMeasuredLiquidityEvidence: true,
        effectiveTvlUsd: aggregateExecutableUsd,
        balanceMeasuredTvlUsd: aggregateExecutableUsd,
        organicMeasuredTvlUsd: aggregateExecutableUsd,
        deploymentCoverage: { observedPools: 1, verifiedNoPools: 0, providerInaccessible: 0 },
        exitRouteObservations: [dexObservation],
        exitRouteObservationCoverage: {
          status: "populated",
          capabilityMatrixVersion: "p4a.8",
          retainedPoolCount: 1,
          observationCount: 1,
          scoreEligibleObservationCount: 1,
          scoreEligiblePoolCount: 1,
          scoreEligibleCapabilityPoolCount: 1,
          unsupportedPoolCount: 0,
          evidenceCounts: { "reserve-based-amm-simulation": 1 },
          unsupportedReasons: {},
        },
        methodologyVersion: sourceDex.methodologyVersion,
        updatedAt: sourceDex.updatedAt,
      },
      [SUPPORT_ID]: {
        liquidityScore: null,
        concentrationHhi: null,
        poolCount: 0,
        chainCount: 0,
        coverageClass: "unobserved",
        coverageConfidence: 0,
        liquidityEvidenceClass: "unobserved",
        hasMeasuredLiquidityEvidence: false,
        effectiveTvlUsd: 0,
        balanceMeasuredTvlUsd: 0,
        organicMeasuredTvlUsd: 0,
        deploymentCoverage: { observedPools: 0, verifiedNoPools: 0, providerInaccessible: 0 },
        exitRouteObservations: [],
        methodologyVersion: sourceDex.methodologyVersion,
        updatedAt: sourceDex.updatedAt,
      },
    },
    redemptionBackstopMap: {
      [COMPOSITE_ID]: {
        ...clone(sourceRedemption),
        stablecoinId: COMPOSITE_ID,
        capacityProfile: {
          ...clone(sourceRedemption.capacityProfile),
          exitRouteObservations: [redemptionObservation],
        },
      },
    },
    bluechipMap: {},
    resolvedBlacklistStatuses: {
      [COMPOSITE_ID]: donorFixed.resolvedBlacklistStatuses["ausd-agora"],
      [SUPPORT_ID]: donorFixed.resolvedBlacklistStatuses[SUPPORT_ID],
    },
    liveReserveMap: { [COMPOSITE_ID]: clone(donorFixed.liveReserveMap[SUPPORT_ID]) },
    liveReserveProvenanceMap: {
      [COMPOSITE_ID]: clone(donorFixed.liveReserveProvenanceMap[SUPPORT_ID]),
    },
    chainCirculatingById: {
      [COMPOSITE_ID]: clone(donorFixed.chainCirculatingById["pusd-polymarket"]),
    },
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });

  const agora = donorAsset("ausd-agora");
  const schuman = donorAsset("europ-schuman");
  const sdola = donorAsset("sdola-inverse-finance");
  const usdc = donorAsset(SUPPORT_ID);
  const dai = donorAsset("dai-makerdao");
  const bold = donorAsset("bold-liquity");
  const usdt = donorAsset("usdt-tether");
  const evidenceKeys = new Set([
    "stablecoin-meta.blacklistability-review:0:b9898c8ea93851f6",
    "stablecoin-meta.bridge-route-risk:0:b203420e4331b092",
    "stablecoin-meta.bridge-route-risk:1:11466b79ead57814",
    "stablecoin-meta.bridge-route-risk:2:2fa668e2df97413e",
    "stablecoin-meta.mint-authority:0:8e07e78f0fb9a457",
    "stablecoin-meta.mint-authority:1:a0f7405d0bc5755d",
    "stablecoin-meta.oracle-risk:0:3d569028a463fce3",
    "stablecoin-meta.oracle-risk:1:479582b567ec9ab7",
  ]);
  const researchEvidence = [...agora.researchEvidence, ...sdola.researchEvidence].filter((entry) =>
    evidenceKeys.has(entry.evidenceKey),
  );
  const componentEvidence = [...agora.componentEvidence, ...sdola.componentEvidence]
    .filter((binding) => binding.evidenceKeys.every((key: string) => evidenceKeys.has(key)))
    .map((binding) => ({ ...clone(binding), componentKey: ownerRekey(binding.componentKey) }));
  const sourceControl = clone(sdola.controlReview);
  sourceControl.controls = sourceControl.controls.map((control) => ({
    ...control,
    controlKey: ownerRekey(control.controlKey),
    deploymentKey: ownerRekey(control.deploymentKey),
  }));
  const accessReview = clone(agora.accessReview);
  accessReview.freeze.reviews = accessReview.freeze.reviews.map((review) => ({
    ...review,
    reviewKey: ownerRekey(review.reviewKey),
  }));
  const routeReviews = [
    findDonorRouteReview(dai, DAI_DEX_ROUTE_ID),
    findDonorRouteReview(dai, DAI_REDEMPTION_ROUTE_ID),
  ].map((review) => ({ ...clone(review), routeId: ownerRekey(review.routeId) }));

  const extension = SafetyScoreV9FactSetExtensionV2Schema.parse({
    ...clone(donorReplay.extension),
    registryFingerprint: fixedInput.registryFingerprint,
    assets: [
      {
        assetId: COMPOSITE_ID,
        archetype: "fiat-cash",
        launchedAtSec: usdt.launchedAtSec,
        mechanismRiskReview: {
          archetype: "fiat-cash",
          assuranceAndReconciliation: clone(agora.mechanismRiskReview.assuranceAndReconciliation),
          claimAndSegregation: clone(agora.mechanismRiskReview.claimAndSegregation),
          custodyContinuity: clone(schuman.mechanismRiskReview.custodyContinuity),
        },
        dependencies: clone(usdc.dependencies),
        reserveApplicability: clone(usdc.reserveApplicability),
        reserveClassifications: clone(usdc.reserveClassifications),
        routeReviews,
        retainedRoutes: [],
        controlReview: sourceControl,
        economicControlReview: clone(sdola.economicControlReview),
        accessReview,
        pegReference: clone(bold.pegReference),
        supplyReview: {
          selectedBridgeRoutes: [],
          selectedRouteSupplyShare: 0,
          unknownRouteSupplyShare: 1,
          unreviewedRouteSupplyShare: 0,
          failureDomains: [],
        },
        researchEvidence,
        componentEvidence,
      },
      {
        assetId: SUPPORT_ID,
        archetype: "unresolved",
        launchedAtSec: null,
        mechanismRiskReview: null,
        dependencies: null,
        reserveApplicability: { state: "not-applicable", rationale: "Support-only tracked output." },
        reserveClassifications: [],
        routeReviews: [],
        retainedRoutes: [],
        controlReview: null,
        economicControlReview: null,
        accessReview: null,
        pegReference: clone(usdc.pegReference),
        supplyReview: null,
        researchEvidence: [],
        componentEvidence: [],
      },
    ],
  } satisfies SafetyScoreV9FactSetExtensionV2);
  return { fixedInput, extension, donors: { agora, schuman, sdola, usdc, dai, bold, usdt } };
}

describe("Safety Score v9 real-donor A+ fixture", { timeout: 30_000 }, () => {
  it("attains A+ through the normal production compiler and evaluator", () => {
    const { fixedInput, extension, donors } = buildFixture();
    const result = buildSafetyScoreV9Candidate({
      fixedInput,
      extension,
      publishedAtSec: PUBLISHED_AT_SEC,
      policy: V9_CANDIDATE_POLICY_V1,
    });
    const repeatedFixture = buildFixture();
    const repeatedResult = buildSafetyScoreV9Candidate({
      fixedInput: repeatedFixture.fixedInput,
      extension: repeatedFixture.extension,
      publishedAtSec: PUBLISHED_AT_SEC,
      policy: V9_CANDIDATE_POLICY_V1,
    });
    const card = result.candidate.cards.find((candidate) => candidate.id === COMPOSITE_ID)!;
    const evaluated = result.evaluatedSet.assets.find((asset) => asset.assetId === COMPOSITE_ID)!;
    const compiled = result.compiledFacts.assets.find((asset) => asset.assetId === COMPOSITE_ID)!;
    const compositeExtension = extension.assets.find((asset) => asset.assetId === COMPOSITE_ID)!;
    const supportExtension = extension.assets.find((asset) => asset.assetId === SUPPORT_ID)!;
    const fixedDex = fixedInput.dexLiqMap[COMPOSITE_ID]!;
    const fixedDexObservation = fixedDex.exitRouteObservations![0]!;
    const fixedRedemptionObservation =
      fixedInput.redemptionBackstopMap[COMPOSITE_ID]!.capacityProfile!.exitRouteObservations![0]!;
    const sourceDexObservation = donorFixed.dexLiqMap["dai-makerdao"].exitRouteObservations[0];
    const sourceRedemptionObservation =
      donorFixed.redemptionBackstopMap["dai-makerdao"].capacityProfile.exitRouteObservations[0];
    const sourceDexReview = findDonorRouteReview(donors.dai, DAI_DEX_ROUTE_ID);
    const sourceRedemptionReview = findDonorRouteReview(donors.dai, DAI_REDEMPTION_ROUTE_ID);
    const dexReview = compositeExtension.routeReviews.find((review) => review.lane === "dex")!;
    const redemptionReview = compositeExtension.routeReviews.find((review) => review.lane === "redemption")!;
    const currentGlobalRegistryFingerprint = computeReportCardsRegistryFingerprint();

    expect(stableJsonStringifyV1(repeatedResult)).toBe(stableJsonStringifyV1(result));
    expect(SafetyScoreV9FactSetExtensionV2Schema.parse(extension)).toEqual(extension);

    expect(fixedInput).toMatchObject({
      capturedAt: "2026-07-16T11:04:30.000Z",
      clockSec: 1_784_199_870,
      updatedAt: 1_784_199_667,
      inputFreshness: {
        dexLiquidity: { updatedAt: 1_784_198_459, ageSeconds: 1_411, stale: false },
        redemptionBackstops: { updatedAt: 1_784_175_209, ageSeconds: 24_661, stale: false },
      },
    });
    expect(extension).toMatchObject({
      compiledAtSec: 1_784_199_870,
      routeFreshness: {
        dexMaxAgeSec: 3_600,
        redemptionMaxAgeSec: 28_800,
        documentedTermsMaxAgeSec: 31_536_000,
      },
      sources: {
        registryObservedAtSec: 1_784_199_667,
        unavailableRedemptionObservedAtSec: 1_784_175_209,
        liveReserves: { observedAtSec: 1_784_189_884, maxAgeSec: 28_800 },
        chainSupply: { observedAtSec: 1_784_199_667, maxAgeSec: 1_800 },
        peg: { observedAtSec: 1_784_199_667, maxAgeSec: 1_800 },
        researchOverlays: { observedAtSec: 1_784_199_667, maxAgeSec: 31_536_000 },
      },
    });
    expect(fixedInput.dexLiqMap[COMPOSITE_ID]!.updatedAt).toBe(1_784_198_459);
    expect(fixedInput.dexLiqMap[SUPPORT_ID]!.updatedAt).toBe(1_784_198_459);
    expect(fixedInput.redemptionBackstopMap[COMPOSITE_ID]!.updatedAt).toBe(1_784_175_209);
    expect(fixedInput.liveReserveProvenanceMap[COMPOSITE_ID]!.fetchedAt).toBe(1_784_189_546);
    expect(result.compiledFacts).toMatchObject({ asOfSec: 1_784_199_870, compiledAtSec: 1_784_199_870 });
    expect(result.compiledFacts.sourceFingerprints).toMatchObject({
      registry: { observedAtSec: 1_784_199_667 },
      dex: { observedAtSec: 1_784_198_459 },
      redemption: { observedAtSec: 1_784_175_209 },
      liveReserves: { observedAtSec: 1_784_189_884 },
      chainSupply: { observedAtSec: 1_784_199_667 },
      peg: { observedAtSec: 1_784_199_667 },
      researchOverlays: { observedAtSec: 1_784_199_667 },
    });
    expect(result.evaluatedSet.asOfSec).toBe(1_784_199_870);
    expect(result.candidate).toMatchObject({ asOfSec: 1_784_199_870, publishedAtSec: PUBLISHED_AT_SEC });

    expect(fixedInput.activeAssetIds).toEqual([COMPOSITE_ID, SUPPORT_ID]);
    expect(extension.assets.map((asset) => asset.assetId)).toEqual([COMPOSITE_ID, SUPPORT_ID]);
    // The assembled fixture follows the current full catalog identity; the
    // frozen revision below remains the point-in-time Day1 donor receipt.
    expect(donorFixed.registryRevision).toBe(`sha256:${RETAINED_DONOR_REGISTRY_FINGERPRINT}`);
    expect(donorReplay.extension.registryFingerprint).toBe(RETAINED_DONOR_REGISTRY_FINGERPRINT);
    expect(fixedInput.registryFingerprint).toBe(currentGlobalRegistryFingerprint);
    expect(extension.registryFingerprint).toBe(currentGlobalRegistryFingerprint);
    expect(result.compiledFacts.sourceFingerprints.registry.payloadSha256).toBe(currentGlobalRegistryFingerprint);
    expect(fixedInput.baseInputGenerationId).not.toBe(RETAINED_344_ASSET_IDENTITY.baseInputGenerationId);
    expect(fixedInput.dexPayloadFingerprint).not.toBe(RETAINED_344_ASSET_IDENTITY.dexPayloadFingerprint);
    expect(fixedInput.redemptionPayloadFingerprint).not.toBe(RETAINED_344_ASSET_IDENTITY.redemptionPayloadFingerprint);
    expect(result.compiledFacts.sourceFingerprints.researchOverlays.payloadSha256).not.toBe(
      RETAINED_344_ASSET_IDENTITY.researchOverlayDigest,
    );

    expect(fixedDex).toMatchObject({
      liquidityScore: fixedDexObservation.completionRatio * 100,
      concentrationHhi: 1,
      poolCount: 1,
      chainCount: 1,
      effectiveTvlUsd: fixedDexObservation.executableUsd,
      balanceMeasuredTvlUsd: fixedDexObservation.executableUsd,
      organicMeasuredTvlUsd: fixedDexObservation.executableUsd,
      exitRouteObservationCoverage: {
        status: "populated",
        capabilityMatrixVersion: "p4a.8",
        retainedPoolCount: 1,
        observationCount: 1,
        scoreEligibleObservationCount: 1,
        scoreEligiblePoolCount: 1,
        scoreEligibleCapabilityPoolCount: 1,
        unsupportedPoolCount: 0,
        evidenceCounts: { "reserve-based-amm-simulation": 1 },
        unsupportedReasons: {},
      },
    });
    expect(fixedInput.dexLiqMap[SUPPORT_ID]).toMatchObject({
      liquidityScore: null,
      poolCount: 0,
      chainCount: 0,
      coverageClass: "unobserved",
      exitRouteObservations: [],
    });

    expect(fixedDexObservation.routeId).toBe(ownerRekey(sourceDexObservation.routeId));
    expect({ ...fixedDexObservation, routeId: sourceDexObservation.routeId }).toEqual(sourceDexObservation);
    expect(fixedRedemptionObservation.routeId).toBe(ownerRekey(sourceRedemptionObservation.routeId));
    expect({ ...fixedRedemptionObservation, routeId: sourceRedemptionObservation.routeId }).toEqual(
      sourceRedemptionObservation,
    );
    expect(fixedDexObservation.scope).toEqual(sourceDexObservation.scope);
    if (fixedDexObservation.scope.kind !== "chain-contract") throw new Error("Expected DAI chain-contract donor");
    expect(fixedDexObservation.scope.protocol).toBe("curve");
    expect(fixedRedemptionObservation.scope).toEqual({ kind: "protocol", protocol: "dai-makerdao" });
    expect(fixedDexObservation.output).toEqual(sourceDexObservation.output);
    expect(fixedRedemptionObservation.output).toEqual(sourceRedemptionObservation.output);
    expect(fixedDexObservation.output.trackedAssetIds).toEqual([SUPPORT_ID]);
    expect(fixedRedemptionObservation.output.trackedAssetIds).toEqual([SUPPORT_ID]);

    expect(dexReview.routeId).toBe(ownerRekey(sourceDexReview.routeId));
    expect({ ...dexReview, routeId: sourceDexReview.routeId }).toEqual(sourceDexReview);
    expect(redemptionReview.routeId).toBe(ownerRekey(sourceRedemptionReview.routeId));
    expect({ ...redemptionReview, routeId: sourceRedemptionReview.routeId }).toEqual(sourceRedemptionReview);
    expect(compositeExtension.routeReviews.map((review) => review.coverageClass)).toEqual([
      "exact-lower-bound",
      "exact-lower-bound",
    ]);
    expect(dexReview.physicalResourceKeys).toEqual([
      "pool:Ethereum:fp:ethereum:curve:0x6b175474e89094c44da98b954eedeac495271d0f:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:0xdac17f958d2ee523a2206206994597c13d831ec7",
    ]);
    expect(redemptionReview.physicalResourceKeys).toEqual(["protocol:dai-makerdao"]);
    expect(dexReview.output).toEqual(sourceDexReview.output);
    expect(redemptionReview.output).toEqual(sourceRedemptionReview.output);
    expect(fixedInput.pegDataById[SUPPORT_ID]).toEqual(donorFixed.pegDataById[SUPPORT_ID]);

    expect(compositeExtension.mechanismRiskReview).toEqual({
      archetype: "fiat-cash",
      assuranceAndReconciliation: donors.agora.mechanismRiskReview.assuranceAndReconciliation,
      claimAndSegregation: donors.agora.mechanismRiskReview.claimAndSegregation,
      custodyContinuity: donors.schuman.mechanismRiskReview.custodyContinuity,
    });
    expect(compositeExtension.dependencies).toEqual(donors.usdc.dependencies);
    expect(compositeExtension.reserveApplicability).toEqual(donors.usdc.reserveApplicability);
    expect(compositeExtension.reserveClassifications).toEqual(donors.usdc.reserveClassifications);
    expect(fixedInput.liveReserveMap[COMPOSITE_ID]).toEqual(donorFixed.liveReserveMap[SUPPORT_ID]);
    expect(fixedInput.liveReserveProvenanceMap[COMPOSITE_ID]).toEqual(donorFixed.liveReserveProvenanceMap[SUPPORT_ID]);
    expect(fixedInput.chainCirculatingById[COMPOSITE_ID]).toEqual(donorFixed.chainCirculatingById["pusd-polymarket"]);
    expect(compositeExtension.launchedAtSec).toBe(donors.usdt.launchedAtSec);
    expect(compositeExtension.pegReference).toEqual(donors.bold.pegReference);
    expect({
      ...fixedInput.pegDataById[COMPOSITE_ID],
      id: donorFixed.pegDataById["bold-liquity"].id,
      symbol: donorFixed.pegDataById["bold-liquity"].symbol,
      name: donorFixed.pegDataById["bold-liquity"].name,
    }).toEqual(donorFixed.pegDataById["bold-liquity"]);

    const sourceControl = donors.sdola.controlReview.controls[0];
    if (!compositeExtension.controlReview || !("controls" in compositeExtension.controlReview)) {
      throw new Error("Expected reviewed sDOLA control donor");
    }
    const compositeControl = compositeExtension.controlReview.controls[0]!;
    expect(compositeControl.controlKey).toBe(ownerRekey(sourceControl.controlKey));
    expect(compositeControl.deploymentKey).toBe(ownerRekey(sourceControl.deploymentKey));
    expect({
      ...compositeControl,
      controlKey: sourceControl.controlKey,
      deploymentKey: sourceControl.deploymentKey,
    }).toEqual(sourceControl);
    expect(compositeExtension.economicControlReview).toEqual(donors.sdola.economicControlReview);
    expect(compositeExtension.accessReview!.freeze.reviews[0]!.reviewKey).toBe(`blacklist:${COMPOSITE_ID}`);
    expect({
      ...compositeExtension.accessReview!.freeze.reviews[0],
      reviewKey: donors.agora.accessReview.freeze.reviews[0].reviewKey,
    }).toEqual(donors.agora.accessReview.freeze.reviews[0]);

    expect(compositeExtension.researchEvidence).toHaveLength(8);
    expect(compositeExtension.researchEvidence.map((entry) => entry.evidenceKey)).toEqual([
      "stablecoin-meta.blacklistability-review:0:b9898c8ea93851f6",
      "stablecoin-meta.bridge-route-risk:0:b203420e4331b092",
      "stablecoin-meta.bridge-route-risk:1:11466b79ead57814",
      "stablecoin-meta.bridge-route-risk:2:2fa668e2df97413e",
      "stablecoin-meta.mint-authority:0:8e07e78f0fb9a457",
      "stablecoin-meta.mint-authority:1:a0f7405d0bc5755d",
      "stablecoin-meta.oracle-risk:0:3d569028a463fce3",
      "stablecoin-meta.oracle-risk:1:479582b567ec9ab7",
    ]);
    expect(compositeExtension.researchEvidence).toEqual(
      [...donors.agora.researchEvidence, ...donors.sdola.researchEvidence].sort((left, right) =>
        left.evidenceKey.localeCompare(right.evidenceKey),
      ),
    );
    expect(compositeExtension.researchEvidence.filter((entry) => entry.sourceId.includes("blacklist"))).toHaveLength(1);
    expect(compositeExtension.researchEvidence.filter((entry) => entry.sourceId.includes("bridge-route"))).toHaveLength(
      3,
    );
    expect(
      compositeExtension.researchEvidence.filter((entry) => entry.sourceId.includes("mint-authority")),
    ).toHaveLength(2);
    expect(compositeExtension.researchEvidence.filter((entry) => entry.sourceId.includes("oracle-risk"))).toHaveLength(
      2,
    );
    expect(compositeExtension.componentEvidence).toHaveLength(12);
    expect(compositeExtension.componentEvidence).toEqual(
      [...donors.agora.componentEvidence, ...donors.sdola.componentEvidence]
        .map((binding) => ({ ...binding, componentKey: ownerRekey(binding.componentKey) }))
        .sort((left, right) => left.componentKey.localeCompare(right.componentKey)),
    );
    expect(
      compositeExtension.componentEvidence.filter((binding) => binding.componentKey.startsWith("access:")),
    ).toHaveLength(3);
    expect(
      compositeExtension.componentEvidence.filter(
        (binding) => binding.componentKey === "control" || binding.componentKey.startsWith("economic-control:"),
      ),
    ).toHaveLength(9);
    expect(
      compositeExtension.componentEvidence.find((binding) =>
        binding.componentKey.startsWith("access:freeze:blacklist:"),
      )!.componentKey,
    ).toBe(`access:freeze:blacklist:${COMPOSITE_ID}`);
    expect(compositeExtension.researchEvidence.some((entry) => entry.sourceId.includes("schuman"))).toBe(false);
    const compiledMechanismReview = compiled.mechanismRiskReview.review;
    if (!compiledMechanismReview || compiledMechanismReview.archetype !== "fiat-cash") {
      throw new Error("Expected compiled fiat-cash donor review");
    }
    expect(compiledMechanismReview.custodyContinuity.status.evidenceRefIds).toEqual([
      `${COMPOSITE_ID}:research-overlay`,
    ]);

    expect(supportExtension).toMatchObject({
      assetId: SUPPORT_ID,
      archetype: "unresolved",
      routeReviews: [],
      researchEvidence: [],
      componentEvidence: [],
    });
    const directResultKeys = [
      "score",
      "grade",
      "pillarScores",
      "weightedQuality",
      "preCapScore",
      "caps",
      "bindingCap",
      "scoreOverride",
      "assetSpecificException",
    ];
    expect(objectKeysDeep(compositeExtension).filter((key) => directResultKeys.includes(key))).toEqual([]);
    expect(objectKeysDeep(compiled).filter((key) => directResultKeys.includes(key))).toEqual([]);

    const compiledDexRoute = compiled.exitRoutes.find((route) => route.routeId === fixedDexObservation.routeId)!;
    const compiledRedemptionRoute = compiled.exitRoutes.find(
      (route) => route.routeId === fixedRedemptionObservation.routeId,
    )!;
    expect(compiledDexRoute.output.assetKeys).toEqual([SUPPORT_ID]);
    expect(compiledRedemptionRoute.output.assetKeys).toEqual([SUPPORT_ID]);
    expect(compiledDexRoute.output.valuation).toMatchObject({
      basis: dexReview.output!.valuation!.basis,
      referenceAssetKey: SUPPORT_ID,
      unitValueUsd: dexReview.output!.valuation!.unitValueUsd,
      expectedUnitValueUsd: dexReview.output!.valuation!.expectedUnitValueUsd,
      sourceId: dexReview.output!.valuation!.sourceId,
      sourceGenerationId: dexReview.output!.valuation!.sourceGenerationId,
      observedAtSec: dexReview.output!.valuation!.observedAtSec,
    });
    expect(compiledRedemptionRoute.output.valuation).toMatchObject({
      basis: redemptionReview.output!.valuation!.basis,
      referenceAssetKey: SUPPORT_ID,
      unitValueUsd: redemptionReview.output!.valuation!.unitValueUsd,
      expectedUnitValueUsd: redemptionReview.output!.valuation!.expectedUnitValueUsd,
      sourceId: redemptionReview.output!.valuation!.sourceId,
      sourceGenerationId: redemptionReview.output!.valuation!.sourceGenerationId,
      observedAtSec: redemptionReview.output!.valuation!.observedAtSec,
    });

    expect(card).toMatchObject({ id: COMPOSITE_ID, score: 88, grade: "A+", evidence: { level: "strong" } });
    expect(evaluated).toMatchObject({
      backing: { score: 92.42609075 },
      exit: { score: 79.44 },
      control: { score: 95 },
      trace: {
        pegMultiplier: 1,
        weightedQuality: 88.5244,
        aggregation: { weightedQuality: 88.5244, weakestScore: 79.44, headroom: 20, score: 87.9473 },
        preCapScore: 87.9473,
        bindingCap: null,
      },
    });
    const rawAuditScore = evaluated.trace.pillarContributions.reduce(
      (sum, contribution) => sum + contribution.score * contribution.weight,
      0,
    );
    expect(rawAuditScore).toBe(88.5244363);
    expect(card.pillars).toMatchObject({
      backing: { score: 92.42609075, evidenceLevel: "strong", reasons: [] },
      exit: { score: 79.44, evidenceLevel: "strong", reasons: [] },
      control: { score: 95, evidenceLevel: "strong", reasons: [] },
    });
    expect(compiled.gaps).toEqual([]);
    expect(card.nrReasons).toEqual([]);
    expect(card.evidence).toMatchObject({ level: "strong", reasons: [] });
    expect(card.caps).toEqual([]);
    expect(card.bindingCap).toBeNull();
    expect(evaluated.trace.bindingCap).toBeNull();

    expect(result.compiledFacts.baseInputGenerationId).toBe(fixedInput.baseInputGenerationId);
    expect(result.compiledFacts.activeAssetIds).toEqual(fixedInput.activeAssetIds);
    expect(result.compiledFacts.sourceFingerprints.dex.payloadSha256).toBe(fixedInput.dexPayloadFingerprint);
    expect(result.compiledFacts.sourceFingerprints.redemption.payloadSha256).toBe(
      fixedInput.redemptionPayloadFingerprint,
    );
    expect(result.evaluatedSet.baseInputGenerationId).toBe(fixedInput.baseInputGenerationId);
    expect(result.candidate.baseInputGenerationId).toBe(fixedInput.baseInputGenerationId);
    expect(result.evaluatedSet.factSetDigest).toBe(result.compiledFacts.v9FactSetDigest);
    expect(result.candidate.factSetDigest).toBe(result.compiledFacts.v9FactSetDigest);
    expect(result.candidate.resultDigest).toBe(result.evaluatedSet.scoreResultDigest);
    expect(evaluated.trace.factSetDigest).toBe(result.compiledFacts.v9FactSetDigest);
    expect(evaluated.trace.baseInputGenerationId).toBe(fixedInput.baseInputGenerationId);
    expect(result.candidate.policy.semanticDigest).toBe(result.evaluatedSet.policyDigest);
    expect(result.candidate.evaluationBuildDigest).toBe(result.evaluatedSet.evaluationBuildDigest);
    expect(result.candidate.candidateId).toBe(computeSafetyScoreV9CandidateId(result.candidateIdentity));
    expect(result.compiledFacts.v9FactSetDigest).not.toBe(RETAINED_344_ASSET_IDENTITY.factSetDigest);
    expect(result.evaluatedSet.evaluatedSetDigest).not.toBe(RETAINED_344_ASSET_IDENTITY.evaluatedSetDigest);
    expect(result.evaluatedSet.scoreResultDigest).not.toBe(RETAINED_344_ASSET_IDENTITY.scoreResultDigest);
    expect(result.candidate.resultDigest).not.toBe(RETAINED_344_ASSET_IDENTITY.scoreResultDigest);
    expect(result.candidate.publicationGenerationId).not.toBe(RETAINED_344_ASSET_IDENTITY.publicationGenerationId);
    expect(compiled.evidence.every((entry) => entry.evidenceId.startsWith(`${COMPOSITE_ID}:`))).toBe(true);
    expect(
      compiled.evidence.some((entry) =>
        ["ausd-agora:", "dai-makerdao:", "europ-schuman:", "sdola-inverse-finance:"].some((prefix) =>
          entry.evidenceId.startsWith(prefix),
        ),
      ),
    ).toBe(false);
  });
});
