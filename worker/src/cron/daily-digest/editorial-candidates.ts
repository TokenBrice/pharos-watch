import type {
  DigestEditorialCandidate,
  DigestEditorialCandidateArtifactRisk,
  DigestEditorialCandidateConfidence,
  DigestEditorialCandidateKind,
  DigestEditorialCandidateNovelty,
  DigestInputData,
} from "@shared/types/digest";
import { formatCurrency } from "@shared/lib/format";
import { round1 } from "@shared/lib/math";
import { THREAT_BAND_ORDER } from "@shared/lib/classification";
import {
  getDepegEditorialImpactScore,
  getDepegMarketImpactScore,
  isCriticalDepegRisk,
} from "@shared/lib/digest-risk";
import { UNCORROBORATED_TVL_DROP_RATIO } from "@shared/lib/digest-liquidity-admission";

const BAND_RANK: Record<string, number> = THREAT_BAND_ORDER;

function candidateId(kind: DigestEditorialCandidateKind, parts: string[]): string {
  return [kind, ...parts]
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9:.-]+/g, "-")
    .replace(/-+/g, "-");
}

export function activeDepegEditorialCandidateId(
  depeg: DigestInputData["topDepegs"][number],
): string {
  // Candidate IDs are persisted in digest metadata and lead history. They
  // identify the active coin-level policy signal, not the underlying event;
  // weekly event deduplication keeps its separate startedAt-based identity.
  return candidateId("depeg", [
    depeg.stablecoinId ?? depeg.symbol,
    "active",
  ]);
}

export function resolvedDepegEditorialCandidateId(
  depeg: NonNullable<DigestInputData["resolvedDepegs"]>[number],
): string {
  return candidateId("resolved-depeg", [
    depeg.stablecoinId ?? depeg.symbol,
    String(depeg.startedAt ?? depeg.peakBps),
  ]);
}

function addCandidate(
  candidates: DigestEditorialCandidate[],
  candidate: DigestEditorialCandidate,
): void {
  candidates.push({
    ...candidate,
    impactScore: Math.max(0, round1(candidate.impactScore)),
    symbols: [...new Set(candidate.symbols.map((symbol) => symbol.toUpperCase()))].slice(0, 4),
    headlineFacts: candidate.headlineFacts.filter(Boolean).slice(0, 4),
  });
}

function artifactRiskForSuppression(
  suppressReason: string | undefined,
  fallback: DigestEditorialCandidateArtifactRisk,
): DigestEditorialCandidateArtifactRisk {
  return suppressReason ? "high" : fallback;
}

function confidenceForData(
  degradedSources: readonly string[] | undefined,
  relevantSource: string,
): DigestEditorialCandidateConfidence {
  return degradedSources?.some((source) => source.includes(relevantSource)) ? "medium" : "high";
}

function sign(value: number): string {
  return value >= 0 ? "+" : "";
}

function depegSeverityBps(depeg: DigestInputData["topDepegs"][number]): number {
  return depeg.currentBps ?? depeg.bps;
}

function activeDepegNovelty(
  depeg: DigestInputData["topDepegs"][number],
  previousData: DigestInputData | null,
): DigestEditorialCandidate["novelty"] {
  if (depeg.suppressReason) return "chronic";
  if (depeg.ageHours != null && depeg.ageHours <= 24) return "new";
  const previous = (previousData?.topDepegs ?? []).find((entry) =>
    depeg.stablecoinId != null && entry.stablecoinId != null
      ? entry.stablecoinId === depeg.stablecoinId
      : entry.symbol.toUpperCase() === depeg.symbol.toUpperCase(),
  );
  // Without a prior observation to diff against, a multi-day depeg is a
  // standing condition, not a developing story.
  if (!previous) return "chronic";
  const delta = Math.abs(depegSeverityBps(depeg)) - Math.abs(depegSeverityBps(previous));
  if (delta >= 100) return "worsening";
  if (delta <= -100) return "improving";
  return depeg.ageHours != null && depeg.ageHours >= 72 ? "chronic" : "recurring";
}

function addActiveDepegCandidates(
  candidates: DigestEditorialCandidate[],
  data: DigestInputData,
  previousData: DigestInputData | null,
): void {
  for (const depeg of data.topDepegs) {
    const severityBps = depegSeverityBps(depeg);
    const marketImpactScore = depeg.impactScore ?? getDepegMarketImpactScore(severityBps, depeg.mcapUsd);
    const impactScore = getDepegEditorialImpactScore(severityBps, depeg.mcapUsd);
    const isCritical = isCriticalDepegRisk({ bps: severityBps, mcapUsd: depeg.mcapUsd });
    const age = depeg.ageHours != null ? `${depeg.ageHours}h old` : "age unknown";
    const severityDirection = severityBps >= 0 ? "above" : "below";
    addCandidate(candidates, {
      id: activeDepegEditorialCandidateId(depeg),
      kind: "depeg",
      title: `${depeg.symbol} active ${Math.abs(severityBps)} bps ${severityDirection} peg`,
      symbols: [depeg.symbol],
      impactScore,
      novelty: activeDepegNovelty(depeg, previousData),
      confidence: "high",
      artifactRisk: artifactRiskForSuppression(depeg.suppressReason, depeg.mcapUsd < 50_000_000 ? "medium" : "low"),
      headlineFacts: [
        `${Math.abs(severityBps)} bps ${severityDirection} peg${depeg.severityBasis === "peak-fallback" ? " (stored peak; live price unavailable)" : ""}`,
        depeg.currentPriceUsd != null ? `current price $${depeg.currentPriceUsd.toFixed(3)}` : "",
        depeg.peakBps != null && Math.abs(depeg.peakBps) !== Math.abs(severityBps)
          ? `peak was ${Math.abs(depeg.peakBps)} bps`
          : "",
        `${formatCurrency(depeg.mcapUsd)} market cap`,
        `${age}`,
        `market impact score ${marketImpactScore}`,
        isCritical ? "critical depeg override threshold met" : "",
      ],
      whyItMatters: "Active peg stress matters when deviation and market cap combine into real holder exposure.",
      ...(depeg.suppressReason ? { suppressReason: depeg.suppressReason } : {}),
    });
  }
}

function addResolvedDepegCandidates(candidates: DigestEditorialCandidate[], data: DigestInputData): void {
  for (const depeg of data.resolvedDepegs ?? []) {
    const impactScore = depeg.impactScore ?? getDepegMarketImpactScore(depeg.peakBps, depeg.mcapUsd);
    addCandidate(candidates, {
      id: resolvedDepegEditorialCandidateId(depeg),
      kind: "resolved-depeg",
      title: `${depeg.symbol} recovered from ${depeg.peakBps} bps`,
      symbols: [depeg.symbol],
      impactScore,
      novelty: "improving",
      confidence: "high",
      artifactRisk: depeg.durationHours <= 0 ? "medium" : "low",
      headlineFacts: [
        `${depeg.peakBps} bps peak`,
        `${formatCurrency(depeg.mcapUsd)} market cap`,
        `${depeg.durationHours}h duration`,
      ],
      whyItMatters: "Fast recovery after a material deviation is useful recovery evidence, not just a scare headline.",
    });
  }
}

function addSupplyCandidates(candidates: DigestEditorialCandidate[], data: DigestInputData): void {
  for (const velocity of data.supplyVelocity ?? []) {
    const impactScore = Math.max(Math.abs(velocity.change1d), Math.abs(velocity.change7d) / 7) / 1_000_000;
    const novelty: DigestEditorialCandidateNovelty = velocity.signal === "reversed"
      ? "reversal"
      : velocity.signal === "decelerating"
        ? "decelerating"
        : "accelerating";
    addCandidate(candidates, {
      id: candidateId("supply", [velocity.coin, velocity.signal]),
      kind: "supply",
      title: `${velocity.coin} supply ${velocity.signal}`,
      symbols: [velocity.coin],
      impactScore,
      novelty,
      confidence: confidenceForData(data.degradedSources, "supply"),
      artifactRisk: Math.abs(velocity.change1d) < 5_000_000 ? "medium" : "low",
      headlineFacts: [
        `${sign(velocity.change1d)}${formatCurrency(velocity.change1d)} in 1d`,
        `${sign(velocity.change7d)}${formatCurrency(velocity.change7d)} in 7d`,
        `${velocity.signal}`,
      ],
      whyItMatters: "Top-tier supply velocity shows capital preference changing before peg data moves.",
    });
  }

  if (data.biggestSupplyChange) {
    const mover = data.biggestSupplyChange;
    addCandidate(candidates, {
      id: candidateId("market", [mover.id, "weekly-supply"]),
      kind: "market",
      title: `${mover.symbol} is the largest weekly supply mover`,
      symbols: [mover.symbol],
      impactScore: Math.abs(mover.changeUsd) / 1_000_000,
      novelty: "structural",
      confidence: "high",
      artifactRisk: Math.abs(mover.changeUsd) < 10_000_000 ? "medium" : "low",
      headlineFacts: [
        `${sign(mover.changeUsd)}${formatCurrency(mover.changeUsd)} in 7d`,
        `${formatCurrency(mover.currentMcap)} current market cap`,
      ],
      whyItMatters: "The largest weekly mover frames where balance-sheet growth or contraction actually landed.",
    });
  }
}

function addMintBurnCandidates(candidates: DigestEditorialCandidate[], data: DigestInputData): void {
  const flows = data.mintBurnFlows;
  if (!flows) return;

  if (flows.flightToQuality.active) {
    addCandidate(candidates, {
      id: candidateId("mint-burn", ["flight-to-quality"]),
      kind: "mint-burn",
      title: "Flight-to-quality is active",
      symbols: flows.topPressure.map((pressure) => pressure.symbol),
      impactScore: (Math.abs(flows.flightToQuality.safeNetUsd) + Math.abs(flows.flightToQuality.riskyNetUsd)) / 1_000_000,
      novelty: "new",
      confidence: "high",
      artifactRisk: "low",
      headlineFacts: [
        `${formatCurrency(flows.flightToQuality.safeNetUsd)} into safe havens`,
        `${formatCurrency(flows.flightToQuality.riskyNetUsd)} out of risky coins`,
        `Bank Run Gauge ${round1(flows.gaugeScore)} [${flows.gaugeBand}]`,
      ],
      whyItMatters: "Flow rotation reveals holder preference before market-cap totals fully settle.",
    });
  }

  for (const pressure of flows.topPressure) {
    addCandidate(candidates, {
      id: candidateId("mint-burn", [pressure.symbol, "pressure"]),
      kind: "mint-burn",
      title: `${pressure.symbol} mint/burn pressure shifted`,
      symbols: [pressure.symbol],
      impactScore: Math.abs(pressure.net24hUsd) / 1_000_000 + Math.abs(pressure.intensity),
      novelty: pressure.intensity < 0 ? "worsening" : "accelerating",
      confidence: "high",
      artifactRisk: Math.abs(pressure.net24hUsd) < 5_000_000 ? "medium" : "low",
      headlineFacts: [
        `intensity ${Math.round(pressure.intensity)}`,
        `net ${formatCurrency(pressure.net24hUsd)} over 24h`,
        `Bank Run Gauge ${round1(flows.gaugeScore)} [${flows.gaugeBand}]`,
      ],
      whyItMatters: "A large pressure shift against the 30-day baseline can flag changing holder behavior.",
    });
  }
}

function addDewsCandidates(candidates: DigestEditorialCandidate[], data: DigestInputData): void {
  const dews = data.dewsStress;
  if (!dews) return;

  for (const change of dews.bandChanges) {
    const fromRank = BAND_RANK[change.from] ?? 0;
    const toRank = BAND_RANK[change.to] ?? 0;
    const worsened = toRank > fromRank;
    const mcapUsd = change.mcapUsd ?? 0;
    addCandidate(candidates, {
      id: candidateId("dews", [change.symbol, change.from, change.to]),
      kind: "dews",
      title: `${change.symbol} moved ${change.from} to ${change.to}`,
      symbols: [change.symbol],
      // Per $1B of market cap, matching `getDepegMarketImpactScore`. On the old
      // per-$1M basis a single-rank move on a mega-cap scored ~6,710 and
      // outranked every real peg break on mcap alone — the same arithmetic that
      // handed edition #179's lead to a liquidity artifact. DEWS matters here
      // because its liquidity input reads the same `dex_liquidity` rows, so one
      // partial pool snapshot can move a band and buy the headline.
      impactScore: Math.max(1, Math.abs(toRank - fromRank) * mcapUsd / 1_000_000_000),
      novelty: worsened ? "worsening" : "improving",
      confidence: confidenceForData(data.degradedSources, "dews"),
      artifactRisk: mcapUsd > 0 && mcapUsd < 20_000_000 ? "medium" : "low",
      headlineFacts: [
        `${change.from} -> ${change.to}`,
        `score ${change.score}`,
        `driver: ${change.topDriver}`,
        mcapUsd > 0 ? `${formatCurrency(mcapUsd)} market cap` : "",
      ],
      whyItMatters: "A fresh DEWS band change is usually more editorially useful than a stale elevated score.",
    });
  }

  const elevatedMcap = dews.elevatedCoins.reduce((sum, coin) => sum + coin.mcapUsd, 0);
  if (elevatedMcap > 0) {
    addCandidate(candidates, {
      id: candidateId("dews", ["alert-plus-breadth"]),
      kind: "dews",
      title: "ALERT+ stress has material market cap",
      symbols: dews.elevatedCoins.map((coin) => coin.symbol),
      // Breadth frames the market; it should not outrank a specific coin's
      // peg break. Same per-$1B basis as every other mcap-scaled candidate.
      impactScore: elevatedMcap / 1_000_000_000,
      novelty: "structural",
      confidence: confidenceForData(data.degradedSources, "dews"),
      artifactRisk: elevatedMcap < 50_000_000 ? "medium" : "low",
      headlineFacts: [
        `${dews.bandCounts.alert} ALERT, ${dews.bandCounts.warning} WARNING, ${dews.bandCounts.danger} DANGER`,
        `${formatCurrency(elevatedMcap)} ALERT+ market cap`,
      ],
      whyItMatters: "Stress breadth matters when elevated coins carry enough size to be more than background noise.",
      ...(elevatedMcap < 50_000_000 ? { suppressReason: "ALERT+ market cap is too small for a lead" } : {}),
    });
  }
}

function addRiskCandidates(candidates: DigestEditorialCandidate[], data: DigestInputData): void {
  for (const transition of data.gradeTransitions ?? []) {
    const scoreDelta = (transition.toScore ?? 0) - (transition.fromScore ?? 0);
    const downgraded = scoreDelta < 0;
    addCandidate(candidates, {
      id: candidateId("grade", [transition.symbol, transition.fromGrade, transition.toGrade]),
      kind: "grade",
      title: `${transition.symbol} grade ${downgraded ? "fell" : "rose"} to ${transition.toGrade}`,
      symbols: [transition.symbol],
      impactScore: Math.abs(scoreDelta) * transition.mcapUsd / 1_000_000_000,
      novelty: downgraded ? "worsening" : "improving",
      confidence: confidenceForData(data.degradedSources, "grade"),
      artifactRisk: transition.mcapUsd < 20_000_000 ? "medium" : "low",
      headlineFacts: [
        `${transition.fromGrade} (${transition.fromScore}) -> ${transition.toGrade} (${transition.toScore})`,
        `${formatCurrency(transition.mcapUsd)} market cap`,
      ],
      whyItMatters: "A report-card move summarizes a material change in the active model's reviewed safety evidence.",
    });
  }

  for (const anomaly of data.yieldAnomalies ?? []) {
    const highApy = anomaly.currentApy >= 100;
    addCandidate(candidates, {
      id: candidateId("yield", [anomaly.symbol]),
      kind: "yield",
      title: `${anomaly.symbol} yield warning`,
      symbols: [anomaly.symbol],
      impactScore: anomaly.mcapUsd / 1_000_000 + anomaly.warnings.length * 25,
      novelty: "new",
      confidence: confidenceForData(data.degradedSources, "yield"),
      artifactRisk: highApy ? "high" : "medium",
      headlineFacts: [
        `${anomaly.currentApy}% APY`,
        `7d avg ${anomaly.apy7d}%, 30d avg ${anomaly.apy30d}%`,
        anomaly.warnings.join(", "),
        `${formatCurrency(anomaly.mcapUsd)} market cap`,
      ],
      whyItMatters: "Yield warnings can flag incentives or data issues, but they need corroboration before becoming the lead.",
      ...(highApy ? { suppressReason: "very high APY warning, require corroboration before leading" } : {}),
    });
  }
}

/**
 * Independent same-coin evidence that a liquidity move is a market event and
 * not a measurement change. DEX liquidity is a single-source signal: every
 * pool number comes from the same ingestion path, so a partial upstream
 * inventory moves score and TVL together and looks exactly like a real drain.
 * Edition #179 led on a $6.71B coin's uncorroborated 91% TVL collapse that
 * never happened.
 *
 * DEWS is deliberately excluded: its liquidity signal reads the same
 * `dex_liquidity` rows, so a band move can be the artifact agreeing with
 * itself. Only pipelines with independent inputs count — peg prices,
 * mint/burn transfer flows, and supply history.
 */
function liquidityCorroboration(data: DigestInputData, symbol: string): string | undefined {
  const target = symbol.toUpperCase();

  if (data.topDepegs.some((depeg) => depeg.symbol.toUpperCase() === target)) return "active depeg";
  const pressure = (data.mintBurnFlows?.topPressure ?? []).find((entry) => entry.symbol.toUpperCase() === target);
  if (pressure) return `mint/burn pressure ${pressure.intensity}`;
  const velocity = (data.supplyVelocity ?? []).find((entry) => entry.coin.toUpperCase() === target);
  if (velocity) return `supply ${velocity.signal}`;
  if (data.biggestSupplyChange?.symbol.toUpperCase() === target) return "largest supply mover";
  return undefined;
}

function addLiquidityAndBlacklistCandidates(candidates: DigestEditorialCandidate[], data: DigestInputData): void {
  for (const shift of data.liquidityShifts ?? []) {
    const tinyTvl = shift.currentTvl < 100_000 || shift.previousTvl < 100_000;
    const corroboration = liquidityCorroboration(data, shift.symbol);
    const tvlMovePct = shift.tvlChangePct != null ? Math.round(shift.tvlChangePct * 100) : null;
    // A cliff this deep is either a partial pool snapshot or a genuine crisis,
    // and magnitude alone cannot tell them apart. This is the only layer that
    // can: it sees prices, flows, and supply. Edition #179's 91% USDS drop had
    // none of them.
    const cliff = shift.tvlChangePct != null && shift.tvlChangePct <= -UNCORROBORATED_TVL_DROP_RATIO;
    const suppressReason = tinyTvl
      ? "liquidity TVL too thin, likely artifact-prone"
      : corroboration
        ? undefined
        : cliff
          ? "unverified single-source DEX TVL collapse, no independent pipeline confirms it"
          : "single-source liquidity move with no independent depeg, flow, or supply corroboration";
    addCandidate(candidates, {
      id: candidateId("liquidity", [shift.symbol]),
      kind: "liquidity",
      title: `${shift.symbol} DEX liquidity score moved ${shift.scoreDelta > 0 ? "up" : "down"}`,
      symbols: [shift.symbol],
      // Scored per $1B of market cap, matching `getDepegMarketImpactScore`.
      // The old `|scoreDelta| * mcap / 1e6` put liquidity on a 1000x inflated
      // scale against every depeg, so an 8-point move on a mega-cap outranked
      // real peg breaks and only a suppressReason could stop it leading.
      impactScore: Math.abs(shift.scoreDelta) * shift.mcapUsd / 1_000_000_000,
      novelty: shift.scoreDelta > 0 ? "improving" : "worsening",
      confidence: shift.coverageClass === "primary" ? "high" : "medium",
      artifactRisk: artifactRiskForSuppression(suppressReason, "medium"),
      headlineFacts: [
        `score ${shift.previousScore} -> ${shift.currentScore}`,
        tvlMovePct != null
          ? `TVL ${formatCurrency(shift.previousTvl)} -> ${formatCurrency(shift.currentTvl)} (${sign(tvlMovePct)}${tvlMovePct}%)`
          : `TVL ${formatCurrency(shift.previousTvl)} -> ${formatCurrency(shift.currentTvl)}`,
        `${formatCurrency(shift.mcapUsd)} market cap`,
        corroboration ? `corroborated by ${corroboration}` : `coverage ${shift.coverageClass}, no corroborating signal`,
      ],
      whyItMatters: "Liquidity score changes matter when exit capacity changed alongside meaningful market cap.",
      ...(suppressReason ? { suppressReason } : {}),
    });
  }

  if (data.blacklistActivity) {
    const total = data.blacklistActivity.totalAmountUsd;
    const count = data.blacklistActivity.eventCount;
    const zeroValue = total <= 0;
    addCandidate(candidates, {
      id: candidateId("blacklist", ["last-24h"]),
      kind: "blacklist",
      title: "Blacklist activity changed",
      symbols: data.blacklistActivity.topEvents.map((event) => event.symbol),
      impactScore: total / 1_000_000 + count,
      novelty: "new",
      confidence: confidenceForData(data.degradedSources, "blacklist"),
      artifactRisk: zeroValue ? "high" : total < 1_000_000 ? "medium" : "low",
      headlineFacts: [
        `${count} events`,
        `${formatCurrency(total)} affected`,
        ...data.blacklistActivity.topEvents.slice(0, 2).map((event) => `${event.symbol} ${event.type} on ${event.chain}: ${formatCurrency(event.amountUsd)}`),
      ],
      whyItMatters: "Issuer enforcement becomes market-relevant when value, issuer, or chain concentration changes.",
      ...(zeroValue ? { suppressReason: "zero-dollar blacklist activity, do not dramatize without a pattern change" } : {}),
    });
  }
}

function addPsiCandidate(candidates: DigestEditorialCandidate[], data: DigestInputData): void {
  const psi = data.stabilityIndex;
  if (!psi) return;

  const alertPlusMcap = (data.dewsStress?.elevatedCoins ?? []).reduce((sum, coin) => sum + coin.mcapUsd, 0);
  addCandidate(candidates, {
    id: candidateId("psi", [psi.band]),
    kind: "psi",
    title: `PSI reads ${psi.score} [${psi.band}]`,
    symbols: [],
    impactScore: Math.max(1, psi.components.severity * 25 + psi.components.breadth * 10 + alertPlusMcap / 1_000_000_000),
    novelty: "structural",
    confidence: "high",
    artifactRisk: "none",
    headlineFacts: [
      `PSI ${psi.score} [${psi.band}]`,
      `severity ${psi.components.severity}`,
      `breadth ${psi.components.breadth}`,
      data.historicalContext ? `${data.historicalContext.psiBandStreak} day ${psi.band} streak` : "",
    ],
    whyItMatters: "PSI frames the market regime, but it should lead only when context or breadth changed.",
  });
}

const ARTIFACT_RISK_RANK: Record<DigestEditorialCandidateArtifactRisk, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

/**
 * Kinds whose entire evidence base is one ingestion pipeline, so an upstream
 * gap produces a coherent-looking story with no contradicting input.
 */
const SINGLE_SOURCE_KINDS: Partial<Record<DigestEditorialCandidateKind, true>> = {
  liquidity: true,
  yield: true,
};

const MOMENTUM_NOVELTIES = new Set<DigestEditorialCandidateNovelty>(["new", "accelerating", "reversal"]);

export function selectMomentumCandidates(candidates: DigestEditorialCandidate[]): DigestEditorialCandidate[] {
  return candidates
    .filter((c) => !c.suppressReason && c.artifactRisk !== "high" && MOMENTUM_NOVELTIES.has(c.novelty))
    .slice(0, 4);
}

export function buildEditorialCandidates(
  data: DigestInputData,
  previousData: DigestInputData | null = null,
): DigestEditorialCandidate[] {
  const candidates: DigestEditorialCandidate[] = [];

  addActiveDepegCandidates(candidates, data, previousData);
  addResolvedDepegCandidates(candidates, data);
  addSupplyCandidates(candidates, data);
  addMintBurnCandidates(candidates, data);
  addDewsCandidates(candidates, data);
  addRiskCandidates(candidates, data);
  addLiquidityAndBlacklistCandidates(candidates, data);
  addPsiCandidate(candidates, data);

  return candidates.sort((a, b) => {
    const aSuppressed = a.suppressReason ? 1 : 0;
    const bSuppressed = b.suppressReason ? 1 : 0;
    if (aSuppressed !== bSuppressed) return aSuppressed - bSuppressed;

    const riskDelta = ARTIFACT_RISK_RANK[a.artifactRisk] - ARTIFACT_RISK_RANK[b.artifactRisk];
    // Single-source kinds cede to cleaner evidence at any impact gap. The
    // 25-point window below is why a medium-risk USDS liquidity shift still
    // outranked every corroborated signal in edition #179.
    if (riskDelta !== 0 && (SINGLE_SOURCE_KINDS[a.kind] || SINGLE_SOURCE_KINDS[b.kind])) return riskDelta;
    if (riskDelta !== 0 && Math.abs(a.impactScore - b.impactScore) < 25) return riskDelta;

    return b.impactScore - a.impactScore;
  });
}
