import {
  TELEGRAM_RECAP_MAX_COINS,
  TELEGRAM_RECAP_MAX_FACT_LINES,
} from "@shared/lib/telegram-recap-policy";
import type { TelegramRecapFact, TelegramRecapSeverity } from "./recap-facts";

export type TelegramRecapMembership = "direct" | "preset" | "global";

export interface TelegramRecapScopedFact extends TelegramRecapFact {
  membership: TelegramRecapMembership;
}

export interface TelegramRecapFactSelection {
  facts: TelegramRecapScopedFact[];
  omittedFactCount: number;
}

const SEVERITY_RANK: Record<TelegramRecapSeverity, number> = {
  critical: 4,
  warning: 3,
  notice: 2,
  info: 1,
};

const MEMBERSHIP_RANK: Record<TelegramRecapMembership, number> = {
  direct: 3,
  preset: 2,
  global: 1,
};

function transitionRank(fact: TelegramRecapFact): number {
  if (
    fact.type === "depeg.opened" ||
    fact.type === "depeg.peak_worsened" ||
    fact.type === "dews.escalated" ||
    fact.type === "score.downgraded" ||
    fact.type === "freeze.blocked" ||
    fact.type === "freeze.destroyed" ||
    fact.type === "mint_burn.large_burn" ||
    fact.type === "yield.warning_emitted" ||
    fact.type === "yield.pys_dropped"
  ) return 2;
  return 1;
}

function compareFacts(a: TelegramRecapScopedFact, b: TelegramRecapScopedFact): number {
  return (
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    transitionRank(b) - transitionRank(a) ||
    MEMBERSHIP_RANK[b.membership] - MEMBERSHIP_RANK[a.membership] ||
    b.ts - a.ts ||
    a.eventId.localeCompare(b.eventId)
  );
}

function depegMagnitude(fact: TelegramRecapFact): number {
  const value = fact.payload.absDeviationBps;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Collapse repeated facts to their material state before applying stable ordering. */
export function collapseTelegramRecapFacts(facts: readonly TelegramRecapScopedFact[]): TelegramRecapScopedFact[] {
  const grouped = new Map<string, TelegramRecapScopedFact[]>();
  for (const fact of facts) {
    const key = `${fact.coinId}\u0000${fact.family}`;
    const existing = grouped.get(key);
    if (existing) existing.push(fact);
    else grouped.set(key, [fact]);
  }

  const collapsed: TelegramRecapScopedFact[] = [];
  for (const group of grouped.values()) {
    const depegResolution = group.filter((fact) => fact.type === "depeg.resolved").sort(compareFacts)[0];
    const depegOpenOrWorsened = group
      .filter((fact) => fact.type === "depeg.opened" || fact.type === "depeg.peak_worsened")
      .sort((a, b) => depegMagnitude(b) - depegMagnitude(a) || compareFacts(a, b))[0];
    if (depegResolution && depegOpenOrWorsened) {
      collapsed.push(depegResolution);
      continue;
    }
    if (depegOpenOrWorsened) {
      collapsed.push(depegOpenOrWorsened);
      continue;
    }
    collapsed.push([...group].sort(compareFacts)[0]!);
  }
  return collapsed.sort(compareFacts);
}

/** Rank and cap recap facts without ever expanding into a second message. */
export function selectTelegramRecapFacts(facts: readonly TelegramRecapScopedFact[]): TelegramRecapFactSelection {
  const collapsed = collapseTelegramRecapFacts(facts);
  const selected: TelegramRecapScopedFact[] = [];
  const selectedCoins = new Set<string>();
  for (const fact of collapsed) {
    if (selected.length >= TELEGRAM_RECAP_MAX_FACT_LINES) break;
    if (!selectedCoins.has(fact.coinId) && selectedCoins.size >= TELEGRAM_RECAP_MAX_COINS) continue;
    selected.push(fact);
    selectedCoins.add(fact.coinId);
  }
  const firstCoinIndex = new Map<string, number>();
  for (const [index, fact] of selected.entries()) {
    if (!firstCoinIndex.has(fact.coinId)) firstCoinIndex.set(fact.coinId, index);
  }
  selected.sort((a, b) => firstCoinIndex.get(a.coinId)! - firstCoinIndex.get(b.coinId)! || compareFacts(a, b));
  return { facts: selected, omittedFactCount: Math.max(0, collapsed.length - selected.length) };
}
