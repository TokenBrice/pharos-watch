import type { PhysicalToUsdRoute } from "./redemption-backstop-configs/schema";
import { PHYSICAL_TO_USD_EXIT_POLICY } from "./exit-route-scoring";
import type { PhysicalToUsdTrace } from "../types/exit-route";

type Policy = typeof PHYSICAL_TO_USD_EXIT_POLICY;
type Branch = "modelled-metal-sale" | "best-effort-issuer-cash-out";

/** Calendar bound includes intervening weekends; business-day maxima are sequential. */
function businessDaysToSeconds(days: number, clockSec: number): number {
  if (days === 0) return 0;
  const start = new Date(clockSec * 1000);
  const weekday = start.getUTCDay();
  const whole = Math.ceil(days);
  const weeks = Math.floor(whole / 5);
  let calendarDays = weeks * 7;
  let remaining = whole % 5;
  let day = weekday;
  while (remaining > 0) {
    calendarDays++;
    day = (day + 1) % 7;
    if (day !== 0 && day !== 6) remaining--;
  }
  return calendarDays * 86400;
}

/** Terms and captured reference only: no quote, inventory or price-movement assumption. */
export function evaluatePhysicalToUsdExit(
  terms: PhysicalToUsdRoute,
  reference: { usdPerTroyOunce: number; observedAtSec: number },
  requestedNotionalUsd: number,
  clockSec: number,
  branch: Branch = "modelled-metal-sale",
  policy: Policy = PHYSICAL_TO_USD_EXIT_POLICY,
): PhysicalToUsdTrace {
  const assumptions: PhysicalToUsdTrace["assumptions"] = [];
  const base = { endpoint: "USD" as const, holderScope: terms.eligibility, branch,
    requestedNotionalUsd, reviewedAt: terms.reviewedAt, reviewExpiresAt: terms.reviewExpiresAt,
    termsMaxAgeSec: policy.termsMaxAgeSec, metalPriceMaxAgeSec: policy.metalPriceMaxAgeSec,
    metalPriceObservedAtSec: reference.observedAtSec };
  const rejected = (rejectionReason: string): PhysicalToUsdTrace => ({ ...base,
    lots: null, tokens: null, grossUsd: null, netUsd: null, costBps: null,
    minimumUsd: null, maximumSettlementSec: null, modelConfidence: branch === "best-effort-issuer-cash-out" || assumptions.length > 0 ? "low" : "medium", assumptions: [...new Set(assumptions)], rejectionReason });
  const reviewed = Date.parse(`${terms.reviewedAt}T00:00:00Z`) / 1000;
  const expires = Date.parse(`${terms.reviewExpiresAt}T00:00:00Z`) / 1000;
  if (!Number.isFinite(reviewed) || !Number.isFinite(expires) || reviewed > clockSec || expires < reviewed ||
      clockSec > Math.min(expires, reviewed + policy.termsMaxAgeSec)) return rejected("physical-review-expired-or-invalid");
  if (!terms.evidence.length) return rejected("physical-evidence-missing");
  if (!Number.isFinite(reference.usdPerTroyOunce) || reference.usdPerTroyOunce <= 0 ||
      !Number.isFinite(reference.observedAtSec) || reference.observedAtSec > clockSec ||
      clockSec - reference.observedAtSec > policy.metalPriceMaxAgeSec) return rejected("physical-metal-price-unavailable-or-stale");
  if (!Number.isFinite(requestedNotionalUsd) || requestedNotionalUsd <= 0) return rejected("physical-request-unavailable");
  const selected = branch === "best-effort-issuer-cash-out" ? terms.bestEffortIssuerCashOut : terms;
  if (!selected) return rejected("physical-cash-process-missing");
  const fee = {} as Record<keyof typeof selected.fees, number>;
  const inVault = terms.saleLocation === "in-vault" && branch === "modelled-metal-sale";
  const modelledTax = inVault ? policy.inVaultTaxBps : Math.max(...terms.vaultLocations.map((location) => {
    const needsFineness = location === "singapore" || (location === "other" && terms.metal === "XAU");
    const minimum = location === "singapore" ? policy.taxExemptionMinimumFineness.singapore[terms.metal] : policy.taxExemptionMinimumFineness.otherGold;
    return needsFineness && (terms.fineness == null || terms.fineness < minimum)
      ? policy.unqualifiedTaxBps : policy.deliveredTaxBps[location][terms.metal];
  }));
  for (const field of Object.keys(selected.fees) as Array<keyof typeof selected.fees>) {
    const value = selected.fees[field];
    if (value === "unbounded") return rejected(`physical-${field}-unbounded`);
    if (typeof value === "number") {
      if (!Number.isFinite(value) || value < 0) return rejected(`physical-${field}-invalid`);
      fee[field] = value;
      continue;
    }
    const logistics = field === "deliveryUsdPerLot" || field === "insuranceBps" || field === "assayUsdPerLot";
    if (logistics && !inVault && terms.deliveryScope === "cross-border") return rejected(`physical-${field}-cross-border-unpriced`);
    fee[field] = logistics ? inVault ? 0 : policy.deliveredLogistics[terms.barClass][field]
      : field === "issuerFeeBps" ? policy.assumptions.issuerFeeBps
      : field === "issuerFixedUsd" ? policy.assumptions.unknownFixedUsd
      : field === "conversionBps" ? policy.assumptions.conversionBps
      : modelledTax;
    assumptions.push("fee-policy-assumed");
  }
  let maximumSettlementSec = 0;
  for (const leg of selected.settlementLegs) {
    let maximum = leg.maximumBusinessDays;
    if (maximum === "unbounded") return rejected("physical-final-settlement-unbounded");
    if (maximum === null) {
      const typical = typeof leg.typicalBusinessDays === "string"
        ? policy.vagueTypicalBusinessDays[leg.typicalBusinessDays]
        : leg.typicalBusinessDays;
      if (typical == null || !Number.isFinite(typical) || typical < 0) return rejected("physical-final-settlement-missing");
      maximum = Math.max(policy.assumptions.minimumBusinessDays,
        Math.min(policy.assumptions.maximumBusinessDays, policy.assumptions.typicalTimeMultiplier * typical));
      assumptions.push("settlement-maximum-policy-assumed");
    }
    if (!Number.isFinite(maximum) || maximum < 0) return rejected("physical-final-settlement-invalid");
    maximumSettlementSec += businessDaysToSeconds(maximum, clockSec + maximumSettlementSec);
  }
  if (branch === "modelled-metal-sale") {
    const saleMaximum = Math.max(policy.assumptions.minimumBusinessDays,
      Math.min(policy.assumptions.maximumBusinessDays, policy.assumptions.typicalTimeMultiplier * policy.modelledSaleTypicalBusinessDays));
    maximumSettlementSec += businessDaysToSeconds(saleMaximum, clockSec + maximumSettlementSec);
  }
  const unitUsd = terms.fineTroyOuncesPerToken * reference.usdPerTroyOunce;
  const minimum = selected.lot.minimumTokens;
  if (minimum === null || !Number.isFinite(minimum) || minimum <= 0) return rejected("physical-lot-minimum-missing");
  const issuerBps = fee.issuerFeeBps as number;
  const fixedUsd = fee.issuerFixedUsd as number;
  const budgetTokens = Math.max(0, (requestedNotionalUsd - fixedUsd) / unitUsd / (1 + issuerBps / 10000));
  let tokens = 0;
  let lots = 0;
  if (selected.lot.bars.length > 0) {
    let bestGross = -1;
    for (const bar of selected.lot.bars) {
      if (bar.fineTroyOunces === null || !Number.isFinite(bar.fineTroyOunces) || bar.fineTroyOunces <= 0) return rejected("physical-bar-weight-missing");
      const maximum = bar.maximumFineTroyOunces ?? bar.fineTroyOunces;
      if (maximum < bar.fineTroyOunces) return rejected("physical-bar-weight-conflict");
      const depositTokens = Math.max(minimum, maximum / terms.fineTroyOuncesPerToken);
      const count = Math.floor(budgetTokens / depositTokens + 1e-12);
      const delivered = count * bar.fineTroyOunces / terms.fineTroyOuncesPerToken;
      if (delivered > bestGross) { bestGross = delivered; tokens = delivered; lots = count; }
    }
  } else {
    const increment = selected.lot.incrementTokens;
    if (increment === null || !Number.isFinite(increment) || increment <= 0) return rejected("physical-lot-increment-missing");
    lots = Math.floor(budgetTokens / increment + 1e-12);
    tokens = lots * increment;
    if (tokens < minimum) { tokens = 0; lots = 0; }
  }
  const grossUsd = tokens * unitUsd;
  const tier = terms.vaultLocations.every((location) => location === "london" || location === "zurich") ? "primaryVault" : "otherVault";
  const saleSpreads = terms.metal === "XAG" ? policy.silverSaleSpreadBps : policy.saleSpreadBps;
  const spread = branch === "best-effort-issuer-cash-out" ? 0 : saleSpreads[terms.barClass][tier];
  const bps = issuerBps + (fee.insuranceBps as number) + (fee.taxBps as number) + (fee.conversionBps as number) + spread;
  const netUsd = grossUsd - grossUsd * bps / 10000 - fixedUsd - lots * ((fee.deliveryUsdPerLot as number) + (fee.assayUsdPerLot as number));
  const costBps = grossUsd > 0 ? (grossUsd - netUsd) / grossUsd * 10000 : null;
  return { ...base, lots, tokens, grossUsd, netUsd: grossUsd > 0 ? Math.max(0, netUsd) : 0,
    costBps, minimumUsd: minimum * unitUsd, maximumSettlementSec,
    modelConfidence: branch === "best-effort-issuer-cash-out" || assumptions.length > 0 ? "low" : "medium",
    assumptions: [...new Set(assumptions)],
    rejectionReason: grossUsd === 0 ? "physical-request-below-minimum" : costBps !== null && costBps > policy.maxCostBps + 1e-8 ? "physical-cost-ceiling-exceeded" : null };
}
