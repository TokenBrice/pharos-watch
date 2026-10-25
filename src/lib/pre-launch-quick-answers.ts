import { LAUNCH_PHASE_LABELS } from "@shared/lib/classification/pre-launch";
import { CHAIN_META } from "@shared/types/chain-identity";
import type { StablecoinMeta } from "@shared/types";
import type { FaqItem } from "@/lib/faq";
import { formatFuzzyDate, isLaunchedAwaitingData } from "@/lib/pre-launch";
import { pluralize } from "@/lib/pre-launch-dossier";

type QuickAnswerCoin = Pick<
  StablecoinMeta,
  | "symbol" | "launchPhase" | "expectedLaunchDate" | "dateHistory" | "announcedDate" | "oneLiner" | "contracts"
  | "launchDate" | "listingStatusReview"
>;

/** `oneLiner` up to its first clause break, as one sentence: "QEUR is … from Qivalis." */
export function firstOneLinerClause(oneLiner: string | undefined): string | null {
  const clause = oneLiner?.split(/,\s|;\s|\.\s|\s—\s|\s–\s/)[0]?.trim().replace(/[.,;:]+$/, "");
  return clause ? `${clause}.` : null;
}

function describeLaunchTiming(coin: QuickAnswerCoin): string {
  const phase = coin.launchPhase
    ? `Pharos records ${coin.symbol} in the ${LAUNCH_PHASE_LABELS[coin.launchPhase].toLowerCase()} phase`
    : `Pharos has not recorded a launch phase for ${coin.symbol}`;
  const announced = coin.announcedDate
    ? `. It was announced ${/^\d{4}-\d{2}-\d{2}$/.test(coin.announcedDate) ? "on" : "in"} ${formatFuzzyDate(coin.announcedDate)}`
    : "";
  const moves = coin.dateHistory?.length ?? 0;
  const target = coin.expectedLaunchDate
    ? `The current launch target is ${formatFuzzyDate(coin.expectedLaunchDate)}${moves > 0 ? `, after ${pluralize(moves, "earlier target")}` : ""}.`
    : moves > 0
      ? "An earlier target was retired and no target date is set."
      : "No target date is set.";
  return `${phase}${announced}. ${target} Targets come from issuer statements; Pharos does not estimate launch dates.`;
}

function listTargetChains(coin: QuickAnswerCoin): string[] {
  return [...new Set((coin.contracts ?? []).map((contract) => contract.chain))].map(
    (chain) => CHAIN_META[chain]?.name ?? chain,
  );
}

/**
 * Answers for a `launched` row: live since its sourced launch date, while
 * Pharos holds no admitted price or supply lane. Missing figures are named
 * unavailable, never zero (R1), and the missing lane comes from the review.
 */
function buildLaunchedQuickAnswers(coin: QuickAnswerCoin, issuer: string | null, chains: string[]): FaqItem[] {
  const since = coin.launchDate ? formatFuzzyDate(coin.launchDate) : null;
  const onOrIn = coin.launchDate && /^\d{4}-\d{2}-\d{2}$/.test(coin.launchDate) ? "on" : "in";
  const reason = coin.listingStatusReview?.reason.trim().replace(/\.?$/, ".") ?? "";
  return [
    {
      question: `When did ${coin.symbol} launch?`,
      answer: since
        ? `${coin.symbol} launched publicly on-chain ${onOrIn} ${since}, per its sourced launch milestone.`
        : `${coin.symbol} has launched publicly on-chain; the registry records no launch date.`,
    },
    ...(issuer ? [{ question: `Who issues ${coin.symbol}?`, answer: issuer }] : []),
    {
      question: `Is ${coin.symbol} live yet?`,
      answer: `Yes, ${coin.symbol} has been live${since ? ` since ${since}` : ""}. Pharos does not track it yet.${reason ? ` ${reason}` : ""} Its price, supply, liquidity and Safety Score are unavailable on Pharos, not zero, until both a price and a supply source can be verified.`,
    },
    ...(chains.length > 0
      ? [{ question: `Which chains does ${coin.symbol} use?`, answer: `The registry records ${coin.symbol} deployments on ${chains.join(", ")}.` }]
      : []),
  ];
}

/**
 * "Launch status: quick answers" for a pre-launch profile, built only from
 * registry fields. A date is never inferred: an absent target is the answer
 * (R2), and the chain question appears only when deployments are recorded.
 */
export function buildPreLaunchQuickAnswers(coin: QuickAnswerCoin): FaqItem[] {
  const issuer = firstOneLinerClause(coin.oneLiner);
  const chains = listTargetChains(coin);
  if (isLaunchedAwaitingData(coin)) return buildLaunchedQuickAnswers(coin, issuer, chains);
  const phaseLabel = coin.launchPhase ? `the ${LAUNCH_PHASE_LABELS[coin.launchPhase].toLowerCase()} phase` : "no recorded phase";

  return [
    { question: `When will ${coin.symbol} launch?`, answer: describeLaunchTiming(coin) },
    ...(issuer ? [{ question: `Who issues ${coin.symbol}?`, answer: issuer }] : []),
    {
      question: `Is ${coin.symbol} live yet?`,
      answer: `Pharos lists ${coin.symbol} as pre-launch (${phaseLabel}): no price and market-cap source is admitted for it yet, so Pharos shows no price, supply, liquidity or Safety Score. Live tracking starts once both can be verified.`,
    },
    ...(chains.length > 0
      ? [{ question: `Which chains will ${coin.symbol} use?`, answer: `The registry records ${coin.symbol} deployments on ${chains.join(", ")}.` }]
      : []),
  ];
}
