import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { CcipPendingRead, EconomicSupplyObservation } from "@shared/types/safety-score-v9-supply-attribution";

/** Compiler seam: bind every chain proof to this capture's exact holdings and
 * amounts. It does not infer pending from escrow-minus-receipts. */
export function authenticateCcipPendingObservation(source: CcipPendingRead, observation: EconomicSupplyObservation,
  holdings: readonly EconomicSupplyObservation[], deployments: readonly { chainId: string; deploymentKey: string }[]): boolean {
  const proof = observation.ccipPendingProof;
  if (!proof || proof.sourceDigest !== sha256Hex(stableJsonStringifyV1(source)) || proof.lanes.length !== source.lanes.length ||
    observation.responseSha256 !== sha256Hex(stableJsonStringifyV1({ proof, amount: observation.amount }))) return false;
  const chains = [...new Set(source.lanes.flatMap(lane => [lane.source.chainId, lane.destination.chainId]))];
  if (proof.pins.length !== chains.length || new Set(proof.pins.map(pin => pin.chainId)).size !== chains.length ||
    proof.pins.some(pin => !chains.includes(pin.chainId) || deployments.filter(row => row.chainId === pin.chainId).length === 0 ||
      deployments.filter(row => row.chainId === pin.chainId).some(row => { const holding = holdings.find(value => value.id === row.deploymentKey);
        return !holding || holding.anchor !== String(pin.anchor) || holding.anchorHash !== pin.anchorHash || holding.observedAtSec !== pin.observedAtSec; }))) return false;
  const anchor = proof.pins.find(pin => pin.chainId === source.chainId);
  if (!anchor || observation.anchor !== String(anchor.anchor) || observation.anchorHash !== anchor.anchorHash || observation.observedAtSec !== anchor.observedAtSec) return false;
  return proof.lanes.every((row, i) => { const lane = source.lanes[i]!; return row.id === lane.id && row.sourcePoolAddress === lane.source.tokenPoolAddress &&
    row.destinationPoolAddress === lane.destination.tokenPoolAddress && row.sourceChainSelector === lane.source.chainSelector &&
    row.destinationChainSelector === lane.destination.chainSelector && BigInt(row.lastSequence) >= BigInt(row.initialSequence) - 1n && row.failedCount <= row.pendingCount; }) &&
    proof.lanes.reduce((sum, row) => sum + BigInt(row.amount), 0n).toString() === observation.amount;
}
