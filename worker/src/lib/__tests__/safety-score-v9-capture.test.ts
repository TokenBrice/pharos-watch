import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_STABLECOINS, ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { assessReserveFetchFreshness } from "../live-reserves/store-snapshot-state";
import { makeRedemptionWriteRecord } from "./redemption-backstops-store.test-support";
import type * as SnapshotModule from "../report-cards-snapshot";

const mocks = vi.hoisted(() => ({ inputs: vi.fn(), peg: vi.fn() }));
vi.mock("../report-cards-snapshot-inputs", () => ({ loadReportCardsSnapshotInputs: mocks.inputs }));
vi.mock("../peg-analytics", () => ({ derivePegAnalyticsSnapshot: mocks.peg }));
vi.mock("@shared/lib/report-cards-fixed-input-identity", () => ({
  computeReportCardsRegistryFingerprint: () => "a".repeat(64),
  computeRedemptionPayloadFingerprint: () => "b".repeat(64),
  projectReportCardsFixedInputMethodologyVersions: () => ({}),
}));
vi.mock("../peg-analytics-cache", () => ({ publishPegAnalyticsCache: vi.fn(async () => true) }));
vi.mock("../report-card-evidence-journal-store", () => ({ loadReportCardEvidenceJournalByIdV1: vi.fn(async () => ({})) }));
vi.mock("../collateral-drift", () => ({ summarizeCollateralDriftFromLiveReserveMap: () => ({ fallbackCoins: [] }) }));
vi.mock("../report-cards-snapshot", async (original) => ({
  ...(await original<typeof SnapshotModule>()), loadExactDexPublicationGeneration: vi.fn(async () => ({ generationId: "dex:test", updatedAt: 1790000000 })),
}));
// Isolate capture orchestration from the separately tested full-catalog normalizer.
vi.mock("../safety-score-v9/native-input", () => ({
  computeNativeDexLiquidityPayloadFingerprint: () => "c".repeat(64),
  normalizeNativeV9Input: (value: unknown) => value,
}));
import { buildNativeSafetyScoreV9Capture } from "../safety-score-v9/capture";
const RUN = 1790000000;

function fixture(scoringClock: number, fetchedAt = RUN - 48 * 3600 + 60, metadataValid = true) {
  const entry = { ...makeRedemptionWriteRecord(), stablecoinId: "iusd-infinifi", updatedAt: RUN };
  const reserveInput = { generationId: "reserve:1790000000:test", contentSha256: "a".repeat(64), stablecoinId: entry.stablecoinId, attemptId: "success",
    configFingerprint: computeLiveReserveConfigFingerprint(ACTIVE_META_BY_ID.get(entry.stablecoinId)!.liveReservesConfig!),
    freshness: assessReserveFetchFreshness({ fetchedAt, attemptId: "success" }, RUN, 172800) };
  const runMetadata = metadataValid ? { reserveViewSchemaVersion: 1, reserveGenerationId: reserveInput.generationId, reserveContentSha256: reserveInput.contentSha256,
    runClockSec: RUN, consumedReserveInputs: { [entry.stablecoinId]: reserveInput } } : {};
  mocks.inputs.mockResolvedValue({
    stablecoinsCached: { kind: "ok", updatedAt: RUN, payload: { peggedAssets: [] } },
    dexLiquiditySnapshot: { latestUpdatedAt: RUN, map: Object.fromEntries(ACTIVE_STABLECOINS.map((coin) => [coin.id, { methodologyVersion: "1.0" }])) },
    redemptionBackstopMap: { [entry.stablecoinId]: { ...entry, reserveInput } },
    redemptionSnapshotProvenance: { runId: "redemption:actual", latestUpdatedAt: RUN, methodologyVersion: entry.methodologyVersion, runMetadata },
    liveReserveMap: new Map(), liveReserveProvenanceMap: new Map(), liquidityStale: false, redemptionStale: false,
    inputFreshness: { dexLiquidity: { updatedAt: RUN, ageSeconds: 0, stale: false }, redemptionBackstops: { updatedAt: RUN, ageSeconds: 0, stale: false } },
    v9PublicationInputHealth: { dex: { state: "current" }, redemption: { state: "current", generationId: "redemption:actual", updatedAtSec: RUN }, liveReserves: { state: "available", coverageRatio: 1 } },
  });
  mocks.peg.mockResolvedValue({ nowSec: scoringClock, pegDataById: new Map(), eventsByCoin: new Map() });
}

beforeEach(() => vi.clearAllMocks());
describe("V9 consumed reserve scoring-clock admission", () => {
  it.each([[59, "current"], [60, "current"], [61, "stale"]] as const)("reassesses 47h59m evidence %s seconds later as %s", async (delta, state) => {
    fixture(RUN + delta);
    const { input } = await buildNativeSafetyScoreV9Capture(mockD1());
    expect(input.v9PublicationInputHealth.redemption).toMatchObject({ state, generationId: "redemption:actual", updatedAtSec: RUN });
    expect(input.inputFreshness.redemptionBackstops.ageSeconds).toBe(delta);
    expect(Object.keys(input.redemptionBackstopMap).length).toBe(state === "current" ? 1 : 0);
  });
  it("uses unavailable for incompatible bindings while retaining actual run diagnostics", async () => {
    fixture(RUN + 1, RUN - 60, false);
    const { input } = await buildNativeSafetyScoreV9Capture(mockD1());
    expect(input.v9PublicationInputHealth.redemption).toMatchObject({ state: "unavailable", generationId: "redemption:actual", updatedAtSec: RUN });
  });
  it.each([[8 * 3600, "current"], [8 * 3600 + 1, "stale"]] as const)("preserves output expiry at %s seconds", async (delta, state) => {
    fixture(RUN + delta, RUN - 60);
    const { input } = await buildNativeSafetyScoreV9Capture(mockD1());
    expect(input.v9PublicationInputHealth.redemption.state).toBe(state);
  });
});
