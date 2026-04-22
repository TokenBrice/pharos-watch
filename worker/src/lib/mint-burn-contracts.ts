import { CHAIN_META } from "@shared/lib/chains";
import { MINT_BURN_CONFIG_SPECS } from "./mint-burn-contracts-data";
export type {
  MintBurnAdapterKind,
  MintBurnBridgeDetectionConfig,
  MintBurnCcipBridgeDetectionConfig,
  MintBurnCctpBridgeDetectionConfig,
  MintBurnContractConfig,
  MintBurnContractConfigSpec,
  MintBurnDirection,
  MintBurnEventDef,
  MintBurnLayerZeroOftBridgeDetectionConfig,
  MintBurnStartBlockConfidence,
  MintBurnTier,
  MintBurnType,
} from "./mint-burn-contracts-types";
import type {
  MintBurnBridgeDetectionConfig,
  MintBurnContractConfig,
} from "./mint-burn-contracts-types";
import {
  resolveMintBurnContractConfig,
  uniqueChainIds,
} from "./mint-burn-contracts-helpers";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TOPIC_RE = /^0x[0-9a-fA-F]{64}$/;
const SELECTOR_RE = /^0x[0-9a-fA-F]{8}$/;

/**
 * Validate the hex-string format of every address/topic/selector in a bridge
 * detection config. Optional fields on non-discriminated protocol variants are
 * accessed via `as any` because the keys differ per-protocol but we want a
 * single uniform validation sweep.
 */
export function validateMintBurnBridgeDetection(d: MintBurnBridgeDetectionConfig): void {
  const all: { kind: "address" | "topic" | "selector"; values: string[] }[] = [
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- discriminated-union: address fields differ per protocol; uniform sweep across all variants
    { kind: "address", values: (d as any).knownBridgePoolAddresses ?? [] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- discriminated-union: see above
    { kind: "address", values: (d as any).knownBridgeRouterAddresses ?? [] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- discriminated-union: see above
    { kind: "address", values: (d as any).knownBridgeContractAddresses ?? [] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- discriminated-union: see above
    { kind: "address", values: (d as any).bridgeSignalEmitterAddresses ?? [] },
    { kind: "topic", values: d.bridgeSignalTopics ?? [] },
    { kind: "selector", values: d.bridgeSignalSelectors ?? [] },
  ];
  for (const { kind, values } of all) {
    for (const v of values) {
      const re = kind === "address" ? ADDRESS_RE : kind === "topic" ? TOPIC_RE : SELECTOR_RE;
      if (!re.test(v)) {
        throw new Error(`mint-burn bridge config: invalid ${kind} "${v}" for protocol ${d.protocol}`);
      }
    }
  }
}

export const MINT_BURN_CONFIGS: MintBurnContractConfig[] = MINT_BURN_CONFIG_SPECS.map(
  resolveMintBurnContractConfig,
);

// Audit-and-report: validate every existing bridge config without aborting
// the worker. If any errors surface in CF logs, fix them. Once the operator
// confirms two full cron cycles with an empty error list, escalate to
// throw-on-error by uncommenting the strict gate at the bottom of this file
// (see `STRICT_BRIDGE_CONFIG_VALIDATION` comment below).
const bridgeValidationErrors: string[] = [];
for (const cfg of MINT_BURN_CONFIGS) {
  if (!cfg.bridgeDetection) continue;
  try {
    validateMintBurnBridgeDetection(cfg.bridgeDetection);
  } catch (e) {
    bridgeValidationErrors.push(
      `${cfg.chain.chainId}/${cfg.stablecoinId}: ${(e as Error).message}`,
    );
  }
}
if (bridgeValidationErrors.length > 0) {
  console.error("[mint-burn-contracts] BRIDGE CONFIG VALIDATION ERRORS:", bridgeValidationErrors);
}

// STRICT_BRIDGE_CONFIG_VALIDATION (deferred, see plan task 2.1 commit 3):
// When ops confirm the log above is silent across two full cron cycles,
// replace the `console.error(...)` block above with:
//   if (bridgeValidationErrors.length > 0) {
//     throw new Error(`mint-burn bridge config validation failed:\n${bridgeValidationErrors.join("\n")}`);
//   }
// AND add this line to resolveMintBurnContractConfig(), before returning:
//   if (resolved.bridgeDetection) validateMintBurnBridgeDetection(resolved.bridgeDetection);

export function getMintBurnConfigsForStablecoin(stablecoinId: string): MintBurnContractConfig[] {
  return MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === stablecoinId);
}

export function getMintBurnTrackedPairs(configs: MintBurnContractConfig[] = MINT_BURN_CONFIGS): Set<string> {
  return new Set(
    configs.map((config) => `${config.stablecoinId}|${config.chain.chainId}`),
  );
}

export function buildMintBurnScope(configs: MintBurnContractConfig[] = MINT_BURN_CONFIGS): {
  chainIds: string[];
  label: string;
} {
  const chainIds = uniqueChainIds(configs);
  if (chainIds.length === 0) {
    return { chainIds, label: "No tracked chains" };
  }
  if (chainIds.length === 1) {
    const chainId = chainIds[0]!;
    const chainName = CHAIN_META[chainId]?.name ?? chainId;
    return { chainIds, label: `${chainName}-only` };
  }
  return { chainIds, label: "Configured issuance chains" };
}
