import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { describe, expect, it } from "vitest";
import { createReportCardsFixedInput } from "../report-cards-fixed-input";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9-fact-set";
import {
  buildSafetyScoreV9BaselineExtension,
  type V9ExtensionRegistryMeta,
} from "../safety-score-v9-extension";
import { createSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input";

const CHILD_ID = "apyusd-apyx";
const PARENT_ID = "apxusd-apyx";
const CLOCK_SEC = createSafetyScoreV9FullRegistryInput().clockSec;

type FullInput = ReturnType<typeof createSafetyScoreV9FullRegistryInput>;
type TestMeta = V9ExtensionRegistryMeta & { pegReferenceId?: string };

function pick<T>(record: Readonly<Record<string, T>>, ids: readonly string[]): Record<string, T> {
  return Object.fromEntries(
    ids.flatMap((id) => (record[id] === undefined ? [] : [[id, record[id]!]])),
  );
}

function reseal(
  input: FullInput,
  overrides: Partial<Parameters<typeof createReportCardsFixedInput>[0]>,
) {
  const {
    schemaVersion: _schemaVersion,
    dexPayloadFingerprint: _dexPayloadFingerprint,
    redemptionPayloadFingerprint: _redemptionPayloadFingerprint,
    registryFingerprint: _registryFingerprint,
    inputMethodologyVersions: _inputMethodologyVersions,
    baseInputGenerationId: _baseInputGenerationId,
    ...draft
  } = input;
  return createReportCardsFixedInput({ ...draft, ...overrides });
}

function twoAssetInput(overrides: Partial<Parameters<typeof createReportCardsFixedInput>[0]> = {}) {
  const full = createSafetyScoreV9FullRegistryInput();
  const ids = [CHILD_ID, PARENT_ID] as const;
  return reseal(full, {
    activeAssetIds: [...ids],
    pegDataById: pick(full.pegDataById, ids),
    activeDepegPeakBpsById: pick(full.activeDepegPeakBpsById, ids),
    dexLiqMap: pick(full.dexLiqMap, ids),
    redemptionBackstopMap: pick(full.redemptionBackstopMap, ids),
    bluechipMap: pick(full.bluechipMap, ids),
    resolvedBlacklistStatuses: pick(full.resolvedBlacklistStatuses, ids),
    liveReserveMap: pick(full.liveReserveMap, ids),
    liveReserveProvenanceMap: pick(full.liveReserveProvenanceMap, ids),
    chainCirculatingById: pick(full.chainCirculatingById, ids),
    aggregateCirculatingById: pick(full.aggregateCirculatingById, ids),
    safetyScoreV9SupplyAttributionById: pick(full.safetyScoreV9SupplyAttributionById, ids),
    evidenceJournalById: pick(full.evidenceJournalById, ids),
    supplyAttributionJournalById: pick(full.supplyAttributionJournalById, ids),
    pegProvenanceById: pick(full.pegProvenanceById, ids),
    collateralDriftCoins: full.collateralDriftCoins.filter((coin) => ids.includes(coin.id)),
    liveToFallbackCoins: full.liveToFallbackCoins.filter((id) => ids.includes(id)),
    ...overrides,
  });
}

function metadata(overrides: Partial<Record<string, TestMeta>> = {}) {
  return new Map<string, V9ExtensionRegistryMeta>([
    [CHILD_ID, { ...ACTIVE_META_BY_ID.get(CHILD_ID)!, ...overrides[CHILD_ID] }],
    [PARENT_ID, { ...ACTIVE_META_BY_ID.get(PARENT_ID)!, ...overrides[PARENT_ID] }],
  ]);
}

function compiledChild(
  fixedInput: ReturnType<typeof twoAssetInput>,
  metaById: ReadonlyMap<string, V9ExtensionRegistryMeta> = metadata(),
) {
  return compileSafetyScoreV9FactSetFromFixedInput(
    fixedInput,
    buildSafetyScoreV9BaselineExtension(fixedInput, { metaById }),
  ).assets.find((asset) => asset.assetId === CHILD_ID)!;
}

function childPeg(
  fixedInput: ReturnType<typeof twoAssetInput>,
  metaById: ReadonlyMap<string, V9ExtensionRegistryMeta> = metadata(),
) {
  return compiledChild(fixedInput, metaById).peg;
}

function parentDepegPeg(fixedInput: ReturnType<typeof twoAssetInput>, peakBps: number) {
  const parent = fixedInput.pegDataById[PARENT_ID]!;
  return twoAssetInput({
    pegDataById: {
      ...fixedInput.pegDataById,
      [PARENT_ID]: {
        ...parent,
        activeDepeg: true,
        currentDeviationBps: peakBps,
        eventCount: 1,
        lastEventAt: CLOCK_SEC - 100,
        worstDeviationBps: peakBps,
      },
    },
    activeDepegPeakBpsById: { [PARENT_ID]: peakBps },
  });
}

describe("Safety Score V9 peg-reference inheritance", () => {
  it("passes apyUSD's tracked parent active-depeg peak into the child peg fact", () => {
    const fixed = parentDepegPeg(twoAssetInput(), 2_500);
    const extension = buildSafetyScoreV9BaselineExtension(fixed, { metaById: metadata() });
    const childExtension = extension.assets.find((asset) => asset.assetId === CHILD_ID)!;

    expect(childExtension.pegReference).toMatchObject({
      referenceKind: "nav",
      referenceKey: "nav:" + CHILD_ID + ":peg-reference:" + PARENT_ID,
    });
    const child = compiledChild(fixed);
    expect(child.peg).toMatchObject({
      pegScore: 100,
      activeDepeg: true,
      activeDepegBps: 2_500,
    });
    expect(child.wrapperLocalFacts).toMatchObject({
      applicability: "wrapper",
      facts: {
        shareAccountingNavOracle: {
          disposition: "reviewed",
          assessment: "moderate",
        },
      },
    });
  });

  it("leaves an asset without pegReferenceId on its own peg data", () => {
    const fixed = parentDepegPeg(twoAssetInput(), 700);
    const parent = compileSafetyScoreV9FactSetFromFixedInput(
      fixed,
      buildSafetyScoreV9BaselineExtension(fixed, { metaById: metadata() }),
    ).assets.find((asset) => asset.assetId === PARENT_ID)!.peg;

    expect(parent.referenceKind).toBe("fiat");
    expect(parent.activeDepegBps).toBe(700);
  });

  it("keeps an inactive NAV wrapper on its child-local not-applicable peg path", () => {
    const fixed = twoAssetInput({ activeDepegPeakBpsById: {} });
    const child = compiledChild(fixed);

    expect(child.peg.status.applicability.state).toBe("not-applicable");
    expect(child.peg.pegScore).toBeNull();
    expect(child.peg.activeDepegBps).toBeNull();
    expect(child.wrapperLocalFacts?.facts.shareAccountingNavOracle).toMatchObject({
      disposition: "reviewed",
      assessment: "moderate",
    });
  });

  it.each([
    ["self-reference", CHILD_ID, { [CHILD_ID]: { variantOf: CHILD_ID, pegReferenceId: CHILD_ID } }],
    [
      "unresolvable reference",
      "missing-parent",
      { [CHILD_ID]: { variantOf: "missing-parent", pegReferenceId: "missing-parent" } },
    ],
    [
      "two-node cycle",
      PARENT_ID,
      {
        [CHILD_ID]: { pegReferenceId: PARENT_ID },
        [PARENT_ID]: { pegReferenceId: CHILD_ID },
      },
    ],
  ] as const)("fails closed for %s", (_label, _referenceId, overrides) => {
    const fixed = parentDepegPeg(twoAssetInput(), 2_500);
    const extension = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: metadata(overrides),
    });
    const childExtension = extension.assets.find((asset) => asset.assetId === CHILD_ID)!;
    const peg = childPeg(fixed, metadata(overrides));

    expect(childExtension.pegReference?.referenceKey).toMatch(/^unresolved:peg-reference:/);
    expect(peg.status.observationState).toBe("bounded-unknown");
    expect(peg.activeDepegBps).toBeNull();
  });

  it("rejects a variantOf / pegReferenceId mismatch with an explicit data error", () => {
    const fixed = twoAssetInput();
    expect(() =>
      buildSafetyScoreV9BaselineExtension(fixed, {
        metaById: metadata({
          [CHILD_ID]: { variantOf: PARENT_ID, pegReferenceId: "different-parent" },
        }),
      }),
    ).toThrow(/peg reference data error.*variantOf.*pegReferenceId/);
  });
});
