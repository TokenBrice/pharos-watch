import type { V9ValidatedPolicyEnvelope } from "../../types/safety-score-v9";
import type { V1019LenderBookFact } from "../../types/safety-score-v9-facts";
import type { LenderMarketObservation } from "../../types/safety-score-v9-lender-book";
import { lenderMarketKey } from "./lender-book-registry";

export interface V1019LenderBookEvaluation {
  readonly reserveQuality: number;
  readonly deploymentQualities: readonly {
    readonly deploymentKey: string;
    readonly bookQuality: number | null;
    readonly bookAdjusted: number | null;
    readonly reserveQuality: number;
  }[];
}

const WAD = 1_000_000_000_000_000_000n;
const MAX_UINT256 = (1n << 256n) - 1n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function raw(value: string): bigint | null {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78) return null;
  const parsed = BigInt(value);
  return parsed <= MAX_UINT256 ? parsed : null;
}

/** Already-admitted market quality; raw LLTV is never inferred from utilization. */
export function v1019LenderMarketQuality(
  market: LenderMarketObservation,
  collateralQuality: number,
  transmissionExponent: 2,
): number {
  const transmission = market.collateralMode === "unsecured"
    ? 1
    : (Number(BigInt(market.lltvRaw)) / Number(WAD)) ** transmissionExponent;
  return 100 - transmission * (100 - collateralQuality);
}

/** Pure, frozen-fact evaluation. Null preserves the old inheritance path. */
export function evaluateV1019LenderBook(
  fact: V1019LenderBookFact,
  parentBacking: number,
  policy: V9ValidatedPolicyEnvelope,
): V1019LenderBookEvaluation | null {
  if (
    (!Number.isFinite(parentBacking) || parentBacking < 0 || parentBacking > 100) ||
    fact.status.applicability.state !== "required" ||
    (fact.status.observationState !== "known" && fact.status.observationState !== "bounded-unknown") ||
    fact.observation?.status !== "ok"
  ) return null;
  const observation = fact.observation;
  const bookPolicy = policy.policy.semantic.backing.lenderCollateralBook;
  if (observation.censusScope !== "complete-nav-accounted-current-book" || observation.deployments.length === 0) return null;
  const resolutions = new Map(fact.collaterals.map(row => [row.marketKey, row]));
  if (resolutions.size !== fact.collaterals.length) return null;
  const usedMarkets = new Set<string>();
  const usedDeployments = new Set<string>();
  const deploymentQualities: V1019LenderBookEvaluation["deploymentQualities"][number][] = [];
  for (const deployment of observation.deployments) {
    const deploymentKey = `${deployment.chain}:${deployment.vault}`;
    if (
      usedDeployments.has(deploymentKey) ||
      (deployment.kind !== "vault-v2" && deployment.kind !== "metamorpho-v1" && deployment.kind !== "metamorpho-v1.1") ||
      deployment.pin.chain !== deployment.chain
    ) return null;
    usedDeployments.add(deploymentKey);
    const nav = raw(deployment.totalAssetsRaw);
    const total = raw(deployment.realAssetsRaw ?? deployment.totalAssetsRaw);
    const buffer = raw(deployment.undistributedAssetsRaw ?? "0");
    const idle = raw(deployment.idleAssetsRaw);
    if (nav === null || nav === 0n || total === null || total === 0n || idle === null || idle > total || buffer === null ||
      total < nav || total - nav !== buffer ||
      ((deployment.realAssetsRaw !== undefined || deployment.undistributedAssetsRaw !== undefined) &&
        (deployment.kind !== "vault-v2" || deployment.realAssetsRaw === undefined || deployment.undistributedAssetsRaw === undefined))) return null;
    let deployed = 0n;
    let weightedQuality = 0;
    for (const market of deployment.markets) {
      const key = lenderMarketKey(deployment.chain, market.morpho, market.marketId, market.account);
      const resolution = resolutions.get(key);
      const amount = raw(market.includedAssetsRaw);
      const lltv = raw(market.lltvRaw);
      if (
        usedMarkets.has(key) || !resolution || !Number.isFinite(resolution.quality) || resolution.quality < 0 || resolution.quality > 100 ||
        amount === null || lltv === null || lltv > WAD ||
        market.loanToken !== deployment.loanToken ||
        market.positionBorrowSharesRaw !== "0" || market.positionCollateralRaw !== "0" ||
        (market.collateralMode === "unsecured" &&
          (market.collateralToken !== ZERO_ADDRESS || raw(market.marketBorrowAssetsRaw) === null ||
            BigInt(market.marketBorrowAssetsRaw) === 0n || resolution.collateralClass !== "structured-credit")) ||
        (market.collateralMode === "collateralized" && market.collateralToken === ZERO_ADDRESS)
      ) return null;
      usedMarkets.add(key);
      deployed += amount;
      weightedQuality += Number(amount) * v1019LenderMarketQuality(market, resolution.quality, bookPolicy.transmissionExponent);
    }
    if (
      idle + deployed !== total || deployment.reconciledAssetsRaw !== total.toString() ||
      deployment.reconciliationResidualRaw !== "0"
    ) return null;
    const bookQuality = deployed === 0n ? null : weightedQuality / Number(deployed);
    const bookAdjusted = bookQuality === null ? null : parentBacking * bookQuality / 100;
    const reserveQuality = deployed === 0n ? parentBacking : Math.min(parentBacking,
      Number(idle) / Number(total) * parentBacking + Number(deployed) / Number(total) * bookAdjusted!);
    deploymentQualities.push({ deploymentKey, bookQuality, bookAdjusted, reserveQuality });
  }
  if (usedMarkets.size !== resolutions.size || deploymentQualities.length === 0) return null;
  return {
    reserveQuality: Math.min(...deploymentQualities.map(row => row.reserveQuality)),
    deploymentQualities,
  };
}
