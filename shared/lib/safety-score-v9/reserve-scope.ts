import type { ProofOfReservesLatestReport } from "../../types/stablecoin-meta-schemas";
import type { ReserveObservationEnvelope, ReserveScopedAdmission } from "../../types/safety-score-v9-reserve-scope";
import type { ReviewedEconomicDeploymentPartition } from "../../types/safety-score-v9-supply-attribution";
import type { V9MethodologyPolicy } from "../../types/safety-score-v9";
import { normalizeDeploymentId } from "../deployment-id";

function exactDecimal(value: string): [bigint, number] {
  const [whole, fraction = ""] = value.split(".");
  return [BigInt(whole + fraction), fraction.length];
}
function decimalSumMatches(values: string[], expected: string): boolean {
  const parsed = [...values, expected].map(exactDecimal);
  const scale = Math.max(...parsed.map(([, decimals]) => decimals));
  const integers = parsed.map(([amount, decimals]) => amount * 10n ** BigInt(scale - decimals));
  return integers.slice(0, -1).reduce((sum, amount) => sum + amount, 0n) === integers[integers.length - 1];
}
export function admitV10ReserveReportScope(input: {
  report: ProofOfReservesLatestReport; deploymentRefs: readonly string[]; clockSec: number;
  policy: V9MethodologyPolicy; currentPartition?: ReviewedEconomicDeploymentPartition | null;
  baseInputGenerationId?: string;
}): ReserveScopedAdmission | null {
  const coverage = input.report.coverage;
  if (!coverage) return null;
  const { report, clockSec, policy } = input;
  const partition = input.currentPartition;
  const nativeRef = coverage.nativeLiabilityRef;
  const admitsNativeIdentity = nativeRef != null && nativeRef.includes(":native:") && partition?.quantitativeCompleteness === true &&
    partition.baseInputGenerationId === input.baseInputGenerationId && partition.scoringClockSec === clockSec &&
    partition.deployments.some(row => row.deploymentKey === nativeRef);
  const codes: string[] = [];
  const period = report.periodEnd == null ? null : Date.parse(`${report.periodEnd}T00:00:00Z`) / 1000;
  const published = report.publishedAt == null ? null : Date.parse(`${report.publishedAt}T00:00:00Z`) / 1000 + 86400 - 1;
  if (report.confidence !== "verified" || coverage.confidence !== "verified") codes.push("unverified");
  if (coverage.reviewedAtSec > clockSec || published === null || published >= clockSec || period === null || period > clockSec) codes.push("future-evidence");
  if (coverage.liabilityExclusions.some(row => row.source.accessedAtSec > clockSec)) codes.push("future-evidence");
  if (coverage.liabilityExclusions.some(row => row.source.accessedAtSec > coverage.reviewedAtSec)) codes.push("checkpoint-mismatch");
  if (period !== null && clockSec - period > policy.semantic.evidence.evidenceExpiry.assuranceReportMaxAgeSec) codes.push("expired");
  if (coverage.deploymentRefs.some(ref => !input.deploymentRefs.includes(ref) && !(admitsNativeIdentity && ref === nativeRef)) ||
    (nativeRef != null && !coverage.deploymentRefs.includes(nativeRef))) codes.push("identity-mismatch");
  if (coverage.denominator.completeness !== "complete" || !decimalSumMatches(coverage.denominator.included.map(row => row.amount), coverage.denominator.totalCoveredLiabilities) || Number(coverage.denominator.totalCoveredLiabilities) <= 0) codes.push("denominator-incomplete");
  if (coverage.denominator.periodEnd !== report.periodEnd || coverage.denominator.asOfSec !== coverage.assetsAsOfSec ||
    period === null || coverage.denominator.asOfSec < period || coverage.denominator.asOfSec >= period + 86400 ||
    coverage.liabilityExclusions.some(row => row.asOfSec !== coverage.denominator.asOfSec || row.currency !== coverage.denominator.currency || row.unitBasis !== coverage.denominator.unitBasis)) codes.push("checkpoint-mismatch");
  if (report.scope !== "assets-and-liabilities" || coverage.reconciliationWithinScope !== "full" || policy.semantic.backing.reserveScope.financialMethodQuality[report.assuranceMethod] == null) codes.push("financial-method-ineligible");
  const admitted = codes.length === 0;
  let share: number | null = null;
  const books = coverage.currentBookPartition;
  if (!partition || !partition.quantitativeCompleteness || !books || partition.baseInputGenerationId !== input.baseInputGenerationId || books.baseInputGenerationId !== partition.baseInputGenerationId || books.sourceGeneration !== partition.sourceGeneration || books.observedAtSec !== partition.observedAtSec || partition.scoringClockSec !== clockSec || partition.unattributedSupplyUsd !== 0 || partition.aggregate.supplyUsd <= 0) {
    codes.push("current-partition-unavailable");
  } else {
    const keys = books.books.map(row => `${row.deploymentRef}:${row.bookKey}`);
    const sumsMatch = new Set(keys).size === keys.length && partition.deployments.every(deployment => {
      const rows = books.books.filter(row => row.deploymentRef === deployment.deploymentKey);
      const sum = rows.reduce((total, row) => total + row.currentLiabilityUsd, 0);
      const tolerance = policy.semantic.supplyAttribution.conservationAbsoluteToleranceUsd + deployment.currentSupplyUsd * policy.semantic.supplyAttribution.conservationRelativeTolerance;
      return rows.length > 0 && Math.abs(sum - deployment.currentSupplyUsd) <= tolerance;
    }) && books.books.every(row => partition.deployments.some(deployment => deployment.deploymentKey === row.deploymentRef));
    if (!sumsMatch) codes.push("identity-mismatch");
    const covered = books.books.filter(row => row.bookKey === coverage.liabilityBookKey && coverage.deploymentRefs.includes(row.deploymentRef));
    const unresolved = coverage.liabilityExclusions.some(exclusion => exclusion.amount === null || exclusion.economicallyOwed === null || !covered.some(row => row.deploymentRef === exclusion.identity.deploymentRef && row.exclusions.some(current => current.id === exclusion.id))) ||
      covered.some(row => new Set(row.exclusions.map(exclusion => exclusion.id)).size !== row.exclusions.length ||
        row.exclusions.some(current => !coverage.liabilityExclusions.some(exclusion => exclusion.id === current.id && exclusion.identity.deploymentRef === row.deploymentRef && exclusion.identity.bookKey === row.bookKey)));
    if (unresolved) codes.push("exclusion-unresolved");
    if (admitted && sumsMatch && !unresolved && coverage.deploymentRefs.every(ref => covered.some(row => row.deploymentRef === ref))) {
      const total = covered.reduce((sum, row) => sum + row.currentLiabilityUsd - row.exclusions.reduce((excluded, exclusion) => excluded + exclusion.currentAmountUsd, 0), 0);
      if (total >= 0 && total <= partition.aggregate.supplyUsd) share = total / partition.aggregate.supplyUsd;
      else codes.push("exclusion-unresolved");
    }
  }
  return { kind: "financial-report", scopeId: coverage.scopeId, liabilityBookKey: coverage.liabilityBookKey,
    deploymentRefs: coverage.deploymentRefs, admitted, rejectionCodes: [...new Set(codes)].sort(), currentLiabilityShare: share,
    wholeAssetComposition: false, observedAtSec: coverage.denominator.asOfSec, evidenceRefIds: coverage.denominator.evidenceRefIds };
}

/**
 * A scope without a current economic/book join is diagnostic, not a reason to
 * withdraw legacy report credit. Explicit still-owed exclusions are different:
 * they establish that the old whole-book interpretation was overbroad.
 */
export function shouldApplyV10ReserveReportScope(
  report: ProofOfReservesLatestReport,
  admission: ReserveScopedAdmission | null,
): boolean {
  if (!admission?.admitted) return false;
  if (admission.currentLiabilityShare !== null) return true;
  const coverage = report.coverage;
  return coverage?.liabilityExclusions.some(exclusion =>
    exclusion.economicallyOwed === true &&
    exclusion.amount !== "0" &&
    exclusion.source.accessedAtSec <= coverage.reviewedAtSec,
  ) === true;
}
/**
 * Observation identities include reviewed reserve/escrow-side adapter contracts,
 * not just holder token deployments. This does not expand financial liabilities.
 */
export function resolveV10ReserveObservationDeploymentRefs(meta: {
  contracts?: readonly { chain: string; address: string }[];
  liveReservesConfig?: { adapter: string; params?: Record<string, unknown> };
}): string[] {
  const refs = (meta.contracts ?? []).map(row => normalizeDeploymentId(`${row.chain}:${row.address}`));
  if (meta.liveReservesConfig?.adapter !== "xdai-bridge") return refs;
  const chainByParam: Record<string, string> = {
    foreignBridgeAddress: "ethereum", homeBridgeAddress: "gnosis",
    usdsAddress: "ethereum", susdsAddress: "ethereum",
    blockRewardAddress: "gnosis", usdsDepositContractAddress: "gnosis",
  };
  for (const [key, value] of Object.entries(meta.liveReservesConfig.params ?? {})) {
    const chain = chainByParam[key];
    if (chain && typeof value === "string") refs.push(normalizeDeploymentId(`${chain}:${value}`));
  }
  // B4 native economic identity; technical observation only, never a supply join.
  refs.push("gnosis:native:xdai");
  return refs;
}

export function admitV10ReserveObservation(input: { observation: ReserveObservationEnvelope; deploymentRefs: readonly string[]; clockSec: number; policy: V9MethodologyPolicy }): ReserveScopedAdmission {
  const { observation: row, policy, clockSec } = input;
  const codes: string[] = [];
  const expiry = policy.semantic.evidence.evidenceExpiry;
  const budget = row.kind === "standing-structure" ? expiry.standingStructureMaxAgeSec : row.kind === "onchain-observation" ? expiry.onchainObservationMaxAgeSec : expiry.reviewedReserveCompositionMaxAgeSec + expiry.reviewedReserveCompositionGraceSec;
  const date = row.observedAtSec ?? row.reviewedAtSec;
  if (row.confidence !== "verified") codes.push("unverified");
  if (row.reviewedAtSec > clockSec || date > clockSec || row.sources.some(source => source.accessedAtSec > clockSec)) codes.push("future-evidence");
  if (date > row.reviewedAtSec || row.sources.some(source => source.accessedAtSec > row.reviewedAtSec)) codes.push("checkpoint-mismatch");
  if (row.expiresAtSec <= row.reviewedAtSec || clockSec > row.expiresAtSec || clockSec - date > budget) codes.push("expired");
  if (row.deploymentRefs.some(ref => !input.deploymentRefs.includes(ref))) codes.push("identity-mismatch");
  if ((row.kind === "standing-structure" || row.kind === "portfolio-observation") &&
    row.obligations.some(obligation => obligation.disposition !== "included")) codes.push("denominator-incomplete");
  if (row.kind === "standing-structure" && (!row.wholeHolderClaim || row.completeness !== "complete")) codes.push("structure-not-whole-claim");
  if (row.kind === "onchain-observation") {
    const timestamps = row.blocks.map(block => block.timestamp);
    if (Math.max(...timestamps) - Math.min(...timestamps) > policy.semantic.backing.reserveScope.crossChainObservationMaxSkewSec) codes.push("block-skew");
    if (row.blocks.some(block => block.timestamp > clockSec)) codes.push("future-evidence");
    if (Math.min(...timestamps) !== row.observedAtSec || new Set(row.blocks.map(block => block.chain)).size !== row.blocks.length || row.quantities.some(quantity => !row.deploymentRefs.includes(quantity.deploymentRef))) codes.push("checkpoint-mismatch");
    if (row.ratio !== null && Number(row.ratio.denominator) <= 0) codes.push("denominator-incomplete");
  }
  const wholeAssets = row.kind === "standing-structure" || (row.kind === "portfolio-observation" && row.completeness === "complete" && row.wholeAssetDenominator !== null && row.wholeAssetDenominator.asOfSec === row.observedAtSec && Number(row.wholeAssetDenominator.amount) > 0);
  return { kind: row.kind, scopeId: row.scopeId, liabilityBookKey: row.liabilityBookKey, deploymentRefs: row.deploymentRefs,
    admitted: codes.length === 0, rejectionCodes: [...new Set(codes)].sort(), currentLiabilityShare: null,
    wholeAssetComposition: codes.length === 0 && wholeAssets, observedAtSec: row.observedAtSec, evidenceRefIds: row.sources.map(source => source.sha256) };
}
export function resolveV10ReserveScopeWeights(admissions: readonly ReserveScopedAdmission[]): { scopes: ReserveScopedAdmission[]; unknownShare: number } {
  const scopes = admissions.map(row => ({ ...row }));
  for (const [index, row] of scopes.entries()) {
    if (row.kind !== "financial-report" || row.currentLiabilityShare === null) continue;
    if (admissions.some((other, otherIndex) => otherIndex !== index && other.kind === "financial-report" && other.currentLiabilityShare !== null && (other.liabilityBookKey === row.liabilityBookKey && other.deploymentRefs.some(ref => row.deploymentRefs.includes(ref))))) {
      row.currentLiabilityShare = null; row.rejectionCodes = [...row.rejectionCodes, "overlapping-scope"];
    }
  }
  const total = scopes.reduce((sum, row) => sum + (row.currentLiabilityShare ?? 0), 0);
  if (total > 1) for (const row of scopes) { row.currentLiabilityShare = null; row.rejectionCodes = [...row.rejectionCodes, "overlapping-scope"]; }
  return { scopes, unknownShare: total > 1 ? 1 : 1 - total };
}
export function resolveV10ScopedAssuranceFragments(admission: ReserveScopedAdmission, quality: "strong" | "adequate") {
  if (!admission.admitted || admission.currentLiabilityShare === null) return [];
  const share = admission.currentLiabilityShare;
  return [{ scopeId: admission.scopeId, share, quality, evidenceRefIds: admission.evidenceRefIds }, ...(share < 1 ? [{ scopeId: `${admission.scopeId}:unknown`, share: 1 - share, quality: null, evidenceRefIds: [] }] : [])];
}
