import { decodeAbiParameters } from "viem/utils";
import {
  decodeAddressWord,
  decodeBoolWord,
  decodeUintWord,
  normalizeAddress,
  ratioToRounded,
  requireCheck,
  type EthCallJournal,
  type MeasurementCheck,
  type PinnedBlock,
} from "../core";
import type { GhoMeasurementEvidence } from "../schema";
import type { GhoMeasurementTarget } from "../targets";

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const CR_NA =
  "GHO facilitators mint against heterogeneous shared lending markets and modules; no honest GHO-only system collateralization ratio exists.";
const LIQUIDATION_NA =
  "Aave liquidations depend on external liquidators rather than a GHO-dedicated pool contractually committed to debt offset.";

export async function measureGho(
  caller: EthCallJournal,
  target: GhoMeasurementTarget,
  block: PinnedBlock,
  rpcUrl: string,
): Promise<GhoMeasurementEvidence> {
  const checks: MeasurementCheck[] = [];
  const token = normalizeAddress(target.contracts.token);
  const totalSupplyRaw = decodeUintWord(
    await caller.call({ name: "token.totalSupply", to: token, signature: "totalSupply()", selector: "0x18160ddd" }),
    0,
    "totalSupply",
  );
  caller.recordDecoded(totalSupplyRaw.toString());
  requireCheck(checks, "supply.positive", totalSupplyRaw > 0n, `GHO supply ${totalSupplyRaw} is positive`);

  const rawList = await caller.call({
    name: "token.getFacilitatorsList",
    to: token,
    signature: "getFacilitatorsList()",
    selector: "0x1ec90f2e",
  });
  const [rawFacilitators] = decodeAbiParameters([{ type: "address[]" }], rawList as `0x${string}`);
  const facilitatorAddresses = rawFacilitators.map((address) => normalizeAddress(address));
  caller.recordDecoded(`count=${facilitatorAddresses.length}`);
  requireCheck(
    checks,
    "facilitators.count",
    facilitatorAddresses.length > 0 && facilitatorAddresses.length <= target.maxFacilitators,
    `registry enumerates ${facilitatorAddresses.length} facilitators`,
  );
  requireCheck(
    checks,
    "facilitators.unique",
    new Set(facilitatorAddresses).size === facilitatorAddresses.length,
    "facilitator addresses are unique",
  );

  const facilitators: GhoMeasurementEvidence["derived"]["facilitators"] = [];
  let facilitatorLevelTotalRaw = 0n;
  let facilitatorUnusedCapacityRaw = 0n;
  for (let index = 0; index < facilitatorAddresses.length; index += 1) {
    const address = facilitatorAddresses[index]!;
    const raw = await caller.call({
      name: `token.getFacilitator(${index})`,
      to: token,
      signature: "getFacilitator(address)",
      selector: "0xd46ec0ed",
      args: [BigInt(address)],
    });
    const [facilitator] = decodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "bucketCapacity", type: "uint128" },
            { name: "bucketLevel", type: "uint128" },
            { name: "label", type: "string" },
          ],
        },
      ],
      raw as `0x${string}`,
    );
    caller.recordDecoded(
      `capacity=${facilitator.bucketCapacity} level=${facilitator.bucketLevel} label=${facilitator.label}`,
    );
    requireCheck(
      checks,
      `facilitator[${index}].bounds`,
      facilitator.bucketLevel <= facilitator.bucketCapacity,
      `bucket level ${facilitator.bucketLevel} does not exceed capacity ${facilitator.bucketCapacity}`,
    );
    facilitatorLevelTotalRaw += facilitator.bucketLevel;
    facilitatorUnusedCapacityRaw += facilitator.bucketCapacity - facilitator.bucketLevel;
    facilitators.push({
      address,
      label: facilitator.label,
      bucketCapacityRaw: facilitator.bucketCapacity.toString(),
      bucketLevelRaw: facilitator.bucketLevel.toString(),
    });
  }
  requireCheck(
    checks,
    "derivation.facilitator-levels-vs-supply",
    facilitatorLevelTotalRaw === totalSupplyRaw,
    `sum of facilitator levels ${facilitatorLevelTotalRaw} exactly equals supply`,
  );

  const trackedGsms: GhoMeasurementEvidence["derived"]["trackedGsms"] = [];
  let directSwappableRaw = 0n;
  for (let index = 0; index < target.trackedGsms.length; index += 1) {
    const address = normalizeAddress(target.trackedGsms[index]!);
    const usedRaw = decodeUintWord(
      await caller.call({ name: `gsm[${index}].getUsed`, to: address, signature: "getUsed()", selector: "0x9abeb940" }),
      0,
      `gsm ${index} used`,
    );
    caller.recordDecoded(usedRaw.toString());
    const backingReturn = await caller.call({
      name: `gsm[${index}].getCurrentBacking`,
      to: address,
      signature: "getCurrentBacking()",
      selector: "0x476cce03",
    });
    const excessRaw = decodeUintWord(backingReturn, 0, `gsm ${index} excess`);
    const deficitRaw = decodeUintWord(backingReturn, 1, `gsm ${index} deficit`);
    caller.recordDecoded(`excess=${excessRaw} deficit=${deficitRaw}`);
    const isFrozen = decodeBoolWord(
      await caller.call({
        name: `gsm[${index}].getIsFrozen`,
        to: address,
        signature: "getIsFrozen()",
        selector: "0x236fc8ad",
      }),
      0,
      `gsm ${index} frozen`,
    );
    caller.recordDecoded(String(isFrozen));
    const isSeized = decodeBoolWord(
      await caller.call({
        name: `gsm[${index}].getIsSeized`,
        to: address,
        signature: "getIsSeized()",
        selector: "0x80bc659a",
      }),
      0,
      `gsm ${index} seized`,
    );
    caller.recordDecoded(String(isSeized));
    const feeStrategy = decodeAddressWord(
      await caller.call({
        name: `gsm[${index}].getFeeStrategy`,
        to: address,
        signature: "getFeeStrategy()",
        selector: "0x4101d9f4",
      }),
      `gsm ${index} fee strategy`,
    );
    caller.recordDecoded(feeStrategy);

    let buyFeeBps: number | null = null;
    if (feeStrategy !== ZERO_ADDRESS) {
      const buyFeeRaw = decodeUintWord(
        await caller.call({
          name: `gsm[${index}].feeStrategy.getBuyFee`,
          to: feeStrategy,
          signature: "getBuyFee(uint256)",
          selector: "0x45d6494d",
          args: [10n ** 18n],
        }),
        0,
        `gsm ${index} buy fee`,
      );
      caller.recordDecoded(buyFeeRaw.toString());
      buyFeeBps = Number((buyFeeRaw * 10_000n) / 10n ** 18n);
    }

    const currentBackingRaw =
      deficitRaw > 0n ? (usedRaw > deficitRaw ? usedRaw - deficitRaw : 0n) : usedRaw + excessRaw;
    if (!isFrozen && !isSeized) directSwappableRaw += currentBackingRaw;
    trackedGsms.push({
      address,
      usedRaw: usedRaw.toString(),
      excessRaw: excessRaw.toString(),
      deficitRaw: deficitRaw.toString(),
      currentBackingRaw: currentBackingRaw.toString(),
      isFrozen,
      isSeized,
      feeStrategy,
      buyFeeBps,
    });
  }

  return {
    schemaVersion: 1,
    kind: "cdp-mechanism-measurement",
    assetId: target.assetId,
    archetype: "cdp",
    family: "gho-facilitator-evidence-v1",
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
    completeness: { complete: true, blockers: [] },
    warnings: [
      "The two tracked GSM contracts are a direct swappable-capacity lower bound, not exhaustive coverage of every module represented by the aggregate GSM facilitator level.",
    ],
    derived: {
      totalSupplyRaw: totalSupplyRaw.toString(),
      facilitatorLevelTotalRaw: facilitatorLevelTotalRaw.toString(),
      facilitators,
      trackedGsms,
    },
    analogousMetrics: {
      facilitatorUnusedCapacityRatio: ratioToRounded(facilitatorUnusedCapacityRaw, totalSupplyRaw),
      directSwappableGsmCapacityRatio: ratioToRounded(directSwappableRaw, totalSupplyRaw),
    },
    checks,
    overlaySources: [...target.overlaySources],
    tool: { name: "measure-cdp-mechanism-metrics", version: "2" },
  };
}
