import { describe, it, expect } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { resolveTrackedContractConfig } from "@shared/lib/tracked-stablecoin-utils";
import {
  buildMintBurnScope,
  collectMintBurnBridgeValidationErrors,
  getMintBurnConfigsForStablecoin,
  MINT_BURN_BRIDGE_VALIDATION_ERRORS,
  MINT_BURN_CONFIGS,
  validateMintBurnBridgeDetection,
} from "../mint-burn-pipeline/mint-burn-contracts";
import { MINT_BURN_CONFIG_SPECS } from "../mint-burn-pipeline/mint-burn-contracts-data";
import { MINT_BURN_COVERED_COIN_IDS } from "../../cron/depeg-resolver/mint-burn-coverage";
import { getMintBurnConservationRuntimeEntry, requiresReviewedSupplyBurnProof } from "../mint-burn-pipeline/mint-burn-conservation";
import { reviewedBurnFixture, reviewedFalseBurnEntries } from "./mint-burn-supply-proof.test-support";
import { projectMintBurnConservationRuntime } from "../../../../scripts/maintenance/generate-mint-burn-conservation-runtime";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_ADDRESS_PADDED = "0x0000000000000000000000000000000000000000000000000000000000000000";
const EXPECTED_TRANSFER_EVENTS = [
      {
        signature: "Transfer(address,address,uint256)",
        topicHash: TRANSFER_TOPIC,
        direction: "mint",
        amountEncoding: "transfer-value",
        filterTopic: { index: 1, value: ZERO_ADDRESS_PADDED },
      },
      {
        signature: "Transfer(address,address,uint256)",
        topicHash: TRANSFER_TOPIC,
        direction: "burn",
        amountEncoding: "transfer-value",
        filterTopic: { index: 2, value: ZERO_ADDRESS_PADDED },
      },
    ];
const REMOVED_STABLECOIN_IDS = [
  "253",
  "uscc-legacy",
  "pht-pht",
] as const;

describe("mint-burn-contracts removals", () => {
  it("does not track explicitly removed no-signal tokens", () => {
    for (const removedId of REMOVED_STABLECOIN_IDS) {
      expect(MINT_BURN_COVERED_COIN_IDS.has(removedId)).toBe(false);
    }
  });
});

describe("mint-burn-contracts configured scope", () => {
  it("exposes every configured issuance chain exactly once", () => {
    expect(buildMintBurnScope()).toEqual({
      chainIds: [...new Set(MINT_BURN_CONFIGS.map((config) => config.chain.chainId))],
      label: "Configured issuance chains",
    });
  });

  it("resolves tracked token identities from shared metadata unless explicitly overridden", () => {
    for (const config of MINT_BURN_CONFIGS) {
      const meta = TRACKED_META_BY_ID.get(config.stablecoinId);
      expect(meta, `missing tracked metadata for ${config.stablecoinId}`).toBeDefined();
      expect(config.symbol).toBe(meta!.symbol);

      const matchingDeployment = meta?.contracts?.find(
        (deployment) =>
          deployment.chain === config.chain.chainId
          && deployment.address.toLowerCase() === config.contractAddress.toLowerCase()
          && deployment.decimals === config.decimals,
      );
      if (matchingDeployment) continue;

      throw new Error(
        `expected ${config.stablecoinId} ${config.contractAddress} to be declared in shared metadata`,
      );
    }
  });
});

describe("mint-burn-contracts resolved specs", () => {
  it("preserves authored scan policy and infers the canonical transfer adapter for every spec", () => {
    expect(MINT_BURN_CONFIGS).toHaveLength(MINT_BURN_CONFIG_SPECS.length);
    for (const [index, spec] of MINT_BURN_CONFIG_SPECS.entries()) {
      const config = MINT_BURN_CONFIGS[index];
      const identity = resolveTrackedContractConfig(spec.stablecoinId, spec.chain.chainId, {
        source: spec.contractSource, addressOverride: spec.contractAddressOverride, decimalsOverride: spec.decimalsOverride,
      });
      expect(identity).not.toBeNull();
      expect(config, spec.stablecoinId).toMatchObject({
        symbol: identity!.stablecoin.symbol, contractAddress: identity!.contractAddress, decimals: identity!.decimals,
        stablecoinId: spec.stablecoinId, chain: spec.chain, dustThreshold: spec.dustThreshold,
        startBlock: spec.startBlock, events: spec.events, tier: spec.tier,
        startBlockSource: spec.startBlockSource ?? (spec.isDefaultStartBlock
          ? "default-coverage-floor-2026-03-24" : "reviewed-contract-specific"),
        startBlockConfidence: spec.startBlockConfidence ?? (spec.isDefaultStartBlock ? "low" : "high"),
      });
      if (!spec.events.some((event) => event.signature === "Transfer(address,address,uint256)")) {
        expect(config.adapterKind).toBe(spec.adapterKind ?? "custom-events");
      }
      if (spec.events.length === 2 && spec.events.every((event) => event.signature === "Transfer(address,address,uint256)")) {
        expect(config).toMatchObject({ adapterKind: "transfer-zero-address", events: EXPECTED_TRANSFER_EVENTS });
      }
    }
  });
});

describe("validateMintBurnBridgeDetection", () => {
  it("keeps checked-in bridge configs clean at module load", () => {
    expect(MINT_BURN_BRIDGE_VALIDATION_ERRORS).toEqual([]);
    expect(collectMintBurnBridgeValidationErrors(MINT_BURN_CONFIGS)).toEqual([]);
  });

  it("rejects malformed deployment identities, versions and route ids", () => {
    for (const config of MINT_BURN_CONFIGS.filter((entry) => entry.bridgeDetection)) {
      const detection = config.bridgeDetection!;
      expect(() => validateMintBurnBridgeDetection({ ...detection, tokenAddress: "0xnot-an-address" })).toThrow(/address/i);
      if (detection.protocol === "cctp") {
        expect(() => validateMintBurnBridgeDetection({ ...detection, deployments: [] })).toThrow(/version/i);
        expect(() => validateMintBurnBridgeDetection({ ...detection, deployments: [{ ...detection.deployments[0], tokenMinter: "bad" }] })).toThrow(/address/i);
      }
      if (detection.protocol === "layerzero-oft") {
        expect(() => validateMintBurnBridgeDetection({ ...detection, endpointId: 0 })).toThrow(/endpoint id/i);
        expect(() => validateMintBurnBridgeDetection({ ...detection, oappAddress: "bad" })).toThrow(/address/i);
      }
    }
    const base = MINT_BURN_CONFIGS.find((config) => config.bridgeDetection)!;
    expect(collectMintBurnBridgeValidationErrors([{ ...base, bridgeDetection: { ...base.bridgeDetection!, tokenAddress: "bad" } }]))
      .toEqual([`${base.chain.chainId}/${base.stablecoinId}: mint-burn bridge config: invalid address "bad" for protocol ${base.bridgeDetection!.protocol}`]);
  });
});

describe("BUIDL Ethereum supply scope", () => {
  it("tracks both registered Ethereum share-class tokens", () => {
    const configs = getMintBurnConfigsForStablecoin("buidl-blackrock");
    const registered = TRACKED_META_BY_ID.get("buidl-blackrock")!.contracts!
      .filter((contract) => contract.chain === "ethereum");
    expect(configs).toHaveLength(2);
    expect(configs.map((config) => config.contractAddress.toLowerCase()).sort())
      .toEqual(registered.map((contract) => contract.address.toLowerCase()).sort());

  });
});

describe("reviewed false-burn identity admission", () => {
  it("derives its complete guard set from the reviewed sidecar, not generic conservation support", () => {
    expect(reviewedFalseBurnEntries).toHaveLength(11);
    for (const entry of reviewedFalseBurnEntries) {
      const { config, source } = reviewedBurnFixture(entry.stablecoinId);
      expect(getMintBurnConfigsForStablecoin(entry.stablecoinId)
        .filter((item) => item.chain.chainId === entry.chainId), entry.stablecoinId).toHaveLength(1);
      expect(requiresReviewedSupplyBurnProof(config), entry.stablecoinId).toBe(true);
      const runtime = getMintBurnConservationRuntimeEntry(config)!;
      expect(runtime.supplyBurnProof).toEqual(entry.supplyBurnProof);
      expect(source.eventTopic ?? source.selector).toBeTruthy();
      const range = runtime.supplyBurnProof!.range;
      expect(range).toMatchObject({ law: "paired-supply-zero-transfers-v1",
        mintEvidence: entry.stablecoinId === "usyc-hashnote" ? "require-empty" : "source-only" });
      if (entry.identity?.proxy?.isProxy) {
        expect(range?.guard).toBeDefined();
        if (range?.guard?.status === "pinned") expect(range.guard.expected).toBe(entry.identity.proxy.implementation);
      } else expect(range?.guard).toBeUndefined();
      const project = (patch = {}) => projectMintBurnConservationRuntime({ version: 1, entries: [{ ...entry, ...patch }] });
      expect(project().entries[0]).toMatchObject({ disposition: "unsupported", supplyBurnProof: entry.supplyBurnProof });
      for (const [patch, reason] of [
        [{ unsupportedReason: "rebasing-supply-without-events" }, "reviewed zero-address Transfer family"],
        [{ supplyBurnProof: { range: { ...range, law: "unreviewed-law" } } }, "invalid law"],
        ...(entry.identity?.proxy?.isProxy ? [[{ supplyBurnProof: { range: { ...range, guard: undefined } } },
          "explicit implementation/delegate guard"] as const] : []),
      ] as const) expect(() => project(patch)).toThrow(reason);
      expect(requiresReviewedSupplyBurnProof({ ...config, decimals: config.decimals + 1 })).toBe(false);
      expect(requiresReviewedSupplyBurnProof({ ...config, contractAddress: "0x1111111111111111111111111111111111111111" })).toBe(false);
    }
    for (const config of MINT_BURN_CONFIGS) {
      const reason = getMintBurnConservationRuntimeEntry(config)?.unsupportedReason;
      if (!reason?.startsWith("zero-address-transfer-without-supply-change:")) {
        expect(requiresReviewedSupplyBurnProof(config), config.stablecoinId).toBe(false);
        expect(getMintBurnConservationRuntimeEntry(config)?.supplyBurnProof?.range, config.stablecoinId).toBeUndefined();
      }
    }
  });
});
