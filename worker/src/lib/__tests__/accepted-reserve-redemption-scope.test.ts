import { describe, expect, it } from "vitest";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { AcceptedReserveGenerationSchema, RedemptionReserveRunMetadataSchema, type AcceptedReserveGeneration } from "@shared/types/accepted-reserve-generation";
import { acceptedReserveMetadataMap, assessConsumedRedemptionReserves, consumedReserveInput } from "../accepted-reserve-generation";
import { makeSupplyFullRedemption } from "./redemption-backstops-store.test-support";
import { readRedemptionBackstopLiveMetadata } from "../redemption-backstop/live-metadata";

const clock = 1791663719;
const sourceTimestamp = 1791663359;

function fixture(assetId = "rusd-reservoir", capacityUsd = 62449.143835) {
  const meta = WORKER_TRACKED_META_BY_ID.get(assetId)!;
  const envelope = AcceptedReserveGenerationSchema.parse({
    schemaVersion: 2, generationId: `reserve:${clock}:scope-test`,
    root: { scheduleKey: "fourHourlyReserveSync", slotStartedAt: clock, queueHash: "scope-test" },
    sealedBy: { attemptNo: 1, executionGeneration: 1, invocationId: "scope-test" },
    producerCompletedAtSec: clock, contentSha256: "a".repeat(64),
    members: [{
      stablecoinId: assetId, latestAttempt: { attemptId: "scope-test", attemptedAt: sourceTimestamp + 1, status: "ok" },
      snapshot: {
        stablecoinId: assetId, fetchedAt: sourceTimestamp + 1, attemptId: "scope-test", source: meta.liveReservesConfig!.adapter,
        metadata: { freshnessMode: "unverified", redemption: {
          capacityUsd, capacityKind: "live-direct", freshnessKind: "same-run-onchain",
          sourceTimestamp, blockNumber: 26164363, outputAssetKeys: ["usdc-circle"],
          holderEligibility: "any-holder", routeStatus: "open", routeStatusSource: "onchain", settlementDelaySec: 0,
        } },
        warnings: [], warningCount: 0, adapterSourceModel: "dynamic-mix", adapterEvidenceClass: "independent",
        configFingerprint: computeLiveReserveConfigFingerprint(meta.liveReservesConfig!), sliceCount: 13,
        lastSuccessAt: sourceTimestamp + 1, lastSuccessAttemptId: "scope-test",
      },
    }],
  });
  return { assetId, envelope };
}

function consume({ assetId, envelope }: { assetId: string; envelope: AcceptedReserveGeneration }) {
  const record = acceptedReserveMetadataMap(envelope, clock).get(assetId)!;
  const input = consumedReserveInput(envelope, assetId, record);
  const row = makeSupplyFullRedemption({
    stablecoinId: assetId, updatedAt: clock, routeFamily: "stablecoin-redeem", sourceMode: "dynamic",
    freshnessKind: "same-run-onchain", capacityKind: "live-direct", sourceTimestamp,
    liveHolderEligibility: "any-holder", reserveInput: input,
  });
  const metadata = RedemptionReserveRunMetadataSchema.parse(JSON.parse(JSON.stringify({
    reserveViewSchemaVersion: 2, reserveGenerationId: envelope.generationId,
    reserveContentSha256: envelope.contentSha256, runClockSec: clock, consumedReserveInputs: { [assetId]: input },
  })));
  return { record, input, row, metadata };
}

describe("independent redemption evidence in consumed reserve bindings", () => {
  it.each(["rusd-reservoir", "wsrusd-reservoir", "srusd-reservoir"])("retains %s's exact on-chain route while composition remains unverified", (assetId) => {
    const { record, input, row, metadata } = consume(fixture(assetId));
    expect(record.admission?.eligible).toBe(false);
    expect(input.freshness.freshnessMode).toBe("unverified");
    expect(input.freshness.sourceTimestamp).toBeNull();
    expect(input.redemptionCapacityEvidence).toEqual({ sourceTimestamp, blockNumber: 26164363, outputAssetKeys: ["usdc-circle"] });
    expect(assessConsumedRedemptionReserves([row], metadata, clock, clock + 60)).toEqual({ state: "fresh", quarantined: {} });
  });

  it("preserves observed zero rather than replacing it with absent capacity", () => {
    const { record, input, row, metadata } = consume(fixture("rusd-reservoir", 0));
    expect(readRedemptionBackstopLiveMetadata(row.stablecoinId, record, clock).immediateRedeemableUsd).toBe(0);
    expect(input.redemptionCapacityEvidence).toBeDefined();
    expect(assessConsumedRedemptionReserves([row], metadata, clock, clock)).toEqual({ state: "fresh", quarantined: {} });
  });

  it.each(["blockNumber", "outputAssetKeys", "sourceTimestamp", "routeStatusSource", "holderEligibility"] as const)("cannot seal independently admitted capacity without %s", (field) => {
    const draft = fixture();
    delete draft.envelope.members[0]!.snapshot!.metadata.redemption![field];
    const { input, row, metadata } = consume(draft);
    expect(input.redemptionCapacityEvidence).toBeUndefined();
    expect(assessConsumedRedemptionReserves([row], metadata, clock, clock)).toEqual({ state: "fresh", quarantined: { [draft.assetId]: "freshness-unverified" } });
  });

  it("keeps old composition-only consumed rows quarantined instead of reconstructing an unsealed proof", () => {
    const { input, row, metadata } = consume(fixture());
    delete input.redemptionCapacityEvidence;
    delete metadata.consumedReserveInputs[row.stablecoinId]!.redemptionCapacityEvidence;
    expect(assessConsumedRedemptionReserves([row], metadata, clock, clock)).toEqual({ state: "fresh", quarantined: { [row.stablecoinId]: "freshness-unverified" } });
  });

  it("rejects changed row/census identities and exact output mismatches", () => {
    const { input, row, metadata } = consume(fixture());
    const altered = { ...input, redemptionCapacityEvidence: { ...input.redemptionCapacityEvidence!, blockNumber: 26164364 } };
    expect(assessConsumedRedemptionReserves([{ ...row, reserveInput: altered }], metadata, clock, clock).state).toBe("unavailable");
    input.redemptionCapacityEvidence!.outputAssetKeys = ["usdt-tether"];
    metadata.consumedReserveInputs[row.stablecoinId] = input;
    expect(assessConsumedRedemptionReserves([row], metadata, clock, clock).quarantined[row.stablecoinId]).toBe("freshness-unverified");
  });

  it("never admits an invalid composition freshness diagnosis through the scoped exception", () => {
    const draft = fixture();
    draft.envelope.members[0]!.snapshot!.metadata.diag = { invalidFreshness: true };
    const { input, row, metadata } = consume(draft);
    expect(input.redemptionCapacityEvidence).toBeUndefined();
    expect(assessConsumedRedemptionReserves([row], metadata, clock, clock).quarantined[row.stablecoinId]).toBe("freshness-unverified");
  });

  it("expires the source block independently at its inclusive 48-hour boundary", () => {
    const { row, metadata } = consume(fixture());
    expect(assessConsumedRedemptionReserves([row], metadata, clock, sourceTimestamp + 172800).quarantined).toEqual({});
    expect(assessConsumedRedemptionReserves([row], metadata, clock, sourceTimestamp + 172801).quarantined[row.stablecoinId]).toBe("stale");
  });
});
