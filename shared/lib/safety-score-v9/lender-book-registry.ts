import { canonicalEvmAddress } from "../evm-address";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";
import { isRecord } from "../type-guards";
import {
  LenderBookObservationSchema,
  type LenderBookObservation,
  type LenderBookReason,
  type LenderCollateralBookPolicy,
} from "../../types/safety-score-v9-lender-book";

type ObservationPayload =
  | Omit<Extract<LenderBookObservation, { status: "ok" }>, "contentSha256" | "sourceGenerationId">
  | Omit<Extract<LenderBookObservation, { status: "unavailable" }>, "contentSha256" | "sourceGenerationId">;

export function resolveLenderTokenIds(
  contracts: readonly { assetId: string; chain: string; address: string }[],
): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, Set<string>>();
  for (const contract of contracts) {
    const address = canonicalEvmAddress(contract.address, { allowZero: false });
    if (address === null || contract.assetId.length === 0 || !/^[a-z0-9][a-z0-9._-]*$/.test(contract.chain)) continue;
    const key = `${contract.chain}:${address}`;
    let ids = index.get(key);
    if (!ids) {
      ids = new Set<string>();
      index.set(key, ids);
    }
    ids.add(contract.assetId);
  }
  return new Map<string, readonly string[]>([...index.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, ids]): [string, readonly string[]] => [key, [...ids].sort()]));
}

export function lenderMarketKey(chain: string, morpho: string, marketId: string, account: string): string {
  return `${chain}:${morpho}:${marketId}:${account}`;
}

export function lenderOracleBranchKey(chain: string, morpho: string, marketId: string): string {
  return `${chain}:${morpho}:${marketId}`;
}

// Sort only structurally readable arrays. Never discard duplicate identities or repair invalid quantities.
export function canonicalizeLenderBookObservation(observation: LenderBookObservation): LenderBookObservation;
export function canonicalizeLenderBookObservation(observation: unknown): unknown;
export function canonicalizeLenderBookObservation(observation: unknown): unknown {
  if (!isRecord(observation) || observation.status !== "ok" || !Array.isArray(observation.deployments)) return observation;
  if (!observation.deployments.every((deployment) => isRecord(deployment) && typeof deployment.chain === "string" && typeof deployment.vault === "string")) return observation;
  const deployments = observation.deployments.map((deployment): Record<string, unknown> => {
    const row = deployment as Record<string, unknown>;
    let markets = row.markets;
    if (Array.isArray(markets) && markets.every((market) => isRecord(market) && typeof market.morpho === "string" && typeof market.marketId === "string" && typeof market.account === "string")) {
      markets = [...markets].sort((left, right) => {
        const a = left as Record<string, string>;
        const b = right as Record<string, string>;
        const aKey = lenderMarketKey(row.chain as string, a.morpho!, a.marketId!, a.account!);
        const bKey = lenderMarketKey(row.chain as string, b.morpho!, b.marketId!, b.account!);
        return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
      });
    }
    const selectorsRead = Array.isArray(row.selectorsRead) && row.selectorsRead.every((selector) => typeof selector === "string")
      ? [...row.selectorsRead].sort()
      : row.selectorsRead;
    return { ...row, markets, selectorsRead };
  }).sort((left, right) => {
    const a = `${left.chain}:${left.vault}`;
    const b = `${right.chain}:${right.vault}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return { ...observation, deployments };
}

/** One content identity for producer, capture and replay; hash/generation are not self-hashed. */
export function deriveLenderBookObservationIdentity(payload: ObservationPayload): {
  contentSha256: string;
  sourceGenerationId: string;
} {
  // Also accept an observation at runtime without accidentally hashing its identity fields.
  const { contentSha256: _hash, sourceGenerationId: _generation, ...content } = payload as ObservationPayload & {
    contentSha256?: string; sourceGenerationId?: string;
  };
  const contentSha256 = sha256Hex(stableJsonStringifyV1(canonicalizeLenderBookObservation(content)));
  return { contentSha256, sourceGenerationId: `morpho-lender-book:v1:${contentSha256}` };
}

/** Admission uses only captured bytes and the supplied fixed clock, never a live registry/publication. */
export function lenderBookAdmissionReason(
  observation: LenderBookObservation,
  assetId: string,
  clockSec: number,
  policy: LenderCollateralBookPolicy,
): LenderBookReason | null {
  if (!Number.isSafeInteger(clockSec) || clockSec < 0) return "malformed";
  const parsed = LenderBookObservationSchema.safeParse(observation);
  if (!parsed.success) return "malformed";
  const value = parsed.data;
  if (value.assetId !== assetId) return "identity-mismatch";
  const identity = deriveLenderBookObservationIdentity(value);
  if (value.contentSha256 !== identity.contentSha256 || value.sourceGenerationId !== identity.sourceGenerationId) return "identity-mismatch";
  if (value.maxAgeSec !== policy.observationMaxAgeSec) return "malformed";
  if (value.acquiredAtSec > clockSec) return "future-dated";
  if (clockSec - value.acquiredAtSec > policy.observationMaxAgeSec) return "stale";
  if (value.status === "unavailable") return value.reason;
  const admission = policy.admittedAssets.find((asset) => asset.assetId === assetId);
  if (!admission || admission.deployments.length !== value.deployments.length) return "identity-mismatch";
  const observedKeys = value.deployments.map((deployment) => `${deployment.chain}:${deployment.kind}`).sort();
  const expectedKeys = admission.deployments.map((deployment) => `${deployment.chain}:${deployment.kind}`).sort();
  if (observedKeys.some((key, index) => key !== expectedKeys[index])) return "identity-mismatch";
  if (value.deployments.some((deployment) => deployment.pin.timestampSec > clockSec)) return "future-dated";
  if (value.deployments.some((deployment) => clockSec - deployment.pin.timestampSec > policy.observationMaxAgeSec)) return "stale";
  if (value.deployments.some((deployment) => deployment.markets.length > policy.maxMarketsPerDeployment)) return "census-limit";
  if (value.deployments.some((deployment) => deployment.totalAssetsRaw === "0")) return "zero-nav";
  return null;
}
