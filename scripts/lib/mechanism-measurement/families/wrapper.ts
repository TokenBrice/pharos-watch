import {
  decodeAddressWord,
  decodeUintWord,
  normalizeAddress,
  ratioToRounded,
  relativeDeltaPct,
  requireCheck,
  type EthCallJournal,
  type MeasurementCheck,
  type PinnedBlock,
} from "../core";
import type { WrapperMechanismMeasurementEvidence } from "../schema";
import type { WrapperMechanismMeasurementTarget } from "../targets";

const CR_NA = "The wrapper has no independent CDP collateralization system; solvency inherits from its parent asset.";
const LIQUIDATION_NA =
  "The wrapper conversion path is not a debt-liquidation pool; liquidation mechanics inherit from the parent asset.";

export async function measureWrapperMechanism(
  caller: EthCallJournal,
  target: WrapperMechanismMeasurementTarget,
  block: PinnedBlock,
  rpcUrl: string,
): Promise<WrapperMechanismMeasurementEvidence> {
  const checks: MeasurementCheck[] = [];
  const wrapper = normalizeAddress(target.contracts.wrapper);
  const asset = decodeAddressWord(
    await caller.call({ name: "wrapper.asset", to: wrapper, signature: "asset()", selector: "0x38d52e0f" }),
    "wrapper asset",
  );
  caller.recordDecoded(asset);
  requireCheck(
    checks,
    "graph.asset",
    asset === normalizeAddress(target.contracts.expectedAsset),
    `wrapper asset ${asset} matches configured parent token`,
  );
  const totalSupplyRaw = decodeUintWord(
    await caller.call({ name: "wrapper.totalSupply", to: wrapper, signature: "totalSupply()", selector: "0x18160ddd" }),
    0,
    "wrapper supply",
  );
  caller.recordDecoded(totalSupplyRaw.toString());
  const totalAssetsRaw = decodeUintWord(
    await caller.call({ name: "wrapper.totalAssets", to: wrapper, signature: "totalAssets()", selector: "0x01e1d114" }),
    0,
    "wrapper total assets",
  );
  caller.recordDecoded(totalAssetsRaw.toString());
  requireCheck(
    checks,
    "wrapper.positive-state",
    totalSupplyRaw > 0n && totalAssetsRaw > 0n,
    `wrapper supply ${totalSupplyRaw} and assets ${totalAssetsRaw} are positive`,
  );
  const convertedAssetsRaw = decodeUintWord(
    await caller.call({
      name: "wrapper.convertToAssets(totalSupply)",
      to: wrapper,
      signature: "convertToAssets(uint256)",
      selector: "0x07a2d13a",
      args: [totalSupplyRaw],
    }),
    0,
    "wrapper converted assets",
  );
  caller.recordDecoded(convertedAssetsRaw.toString());
  const accountingDeltaPct = Math.abs(relativeDeltaPct(convertedAssetsRaw, totalAssetsRaw));
  requireCheck(
    checks,
    "derivation.wrapper-accounting",
    accountingDeltaPct <= target.maxAccountingDeltaPct,
    `convertToAssets(totalSupply) diverges ${accountingDeltaPct.toFixed(6)}% from totalAssets`,
  );

  const blockers = target.complete
    ? []
    : [target.blocker ?? "Wrapper parent evidence and deployment completeness are not attached."];
  return {
    schemaVersion: 1,
    kind: "cdp-mechanism-measurement",
    assetId: target.assetId,
    archetype: "cdp",
    family: "wrapper-mechanism-v1",
    chain: target.chain,
    rpcUrl,
    block,
    calls: caller.calls,
    metrics: {
      collateralizationRatio: null,
      liquidationCapacityRatio: null,
      applicability: {
        collateralizationRatio: { state: "not-applicable", rationale: CR_NA },
        liquidationCapacityRatio: { state: "not-applicable", rationale: LIQUIDATION_NA },
      },
    },
    completeness: { complete: blockers.length === 0, blockers },
    ...(blockers.length > 0 ? { warnings: blockers } : {}),
    derived: {
      wrapper,
      parentAssetId: target.parentAssetId,
      asset,
      totalSupplyRaw: totalSupplyRaw.toString(),
      totalAssetsRaw: totalAssetsRaw.toString(),
      convertedAssetsRaw: convertedAssetsRaw.toString(),
      accountingDeltaPct: Math.round(accountingDeltaPct * 1_000_000) / 1_000_000,
    },
    analogousMetrics: { localBackingRatio: ratioToRounded(convertedAssetsRaw, totalAssetsRaw) },
    checks,
    overlaySources: [...target.overlaySources],
    tool: { name: "measure-cdp-mechanism-metrics", version: "2" },
  };
}
