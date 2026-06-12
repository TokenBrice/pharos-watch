#!/usr/bin/env tsx
/**
 * Prints the direct CDP oracle-risk Decentralization movement table.
 *
 * This is intentionally advisory: run it after reviewed oracleRisk metadata is
 * populated across CDPs, then decide whether the blend weight or tier scores
 * need a methodology bump.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  ORACLE_RISK_BLEND_WEIGHT,
  ORACLE_RISK_SCORE,
  resolveOracleRiskScore,
  scoreDecentralization,
} from "../../shared/lib/report-cards";
import {
  computeMintAuthorityScore,
  stablecoinToMintAuthorityScoringInput,
  type MintAuthorityParentResolver,
} from "../../shared/lib/mint-authority-scoring";
import type { GovernanceType, StablecoinMeta } from "../../shared/types";
import { loadPerCoinStablecoinEntries } from "../lib/stablecoin-catalog-sources";

const WATCHLIST_IDS = new Set([
  "usds-sky",
  "bold-liquity",
  "dai-makerdao",
  "crvusd-curve",
  "gho-aave",
  "lusd-liquity",
  "mim-abracadabra",
]);

interface CalibrationRow {
  id: string;
  symbol: string;
  tier: string;
  oracleScore: number | null;
  before: number | null;
  after: number | null;
  delta: number | null;
  mintAuthorityScore: number | null;
  watchlist: boolean;
}

function isDirectActiveCryptoCdp(coin: StablecoinMeta): boolean {
  return (
    (coin.status ?? "active") === "active" &&
    coin.flags.backing === "crypto-backed" &&
    coin.mechanismArchetype === "cdp" &&
    !coin.variantOf
  );
}

function formatValue(value: number | string | null): string {
  if (value == null) return "—";
  return String(value);
}

function buildRows(coins: readonly StablecoinMeta[]): CalibrationRow[] {
  const byId = new Map(coins.map((coin) => [coin.id, coin]));
  const parentResolver: MintAuthorityParentResolver = (id) =>
    stablecoinToMintAuthorityScoringInput(byId.get(id) ?? null);

  return coins
    .filter(isDirectActiveCryptoCdp)
    .map((coin) => {
      const mintAuthorityScore = computeMintAuthorityScore(
        stablecoinToMintAuthorityScoringInput(coin),
        parentResolver,
      ).score;
      const withoutOracleMeta: StablecoinMeta = { ...coin, oracleRisk: undefined };
      const before = scoreDecentralization(coin.flags.governance as GovernanceType, withoutOracleMeta, {
        mintAuthorityScore,
      }).score;
      const after = scoreDecentralization(coin.flags.governance as GovernanceType, coin, { mintAuthorityScore }).score;
      const resolved = resolveOracleRiskScore(coin);

      return {
        id: coin.id,
        symbol: coin.symbol,
        tier: resolved?.tier ?? "missing",
        oracleScore: resolved?.score ?? null,
        before,
        after,
        delta: before != null && after != null ? after - before : null,
        mintAuthorityScore,
        watchlist: WATCHLIST_IDS.has(coin.id),
      };
    })
    .sort((left, right) => {
      const impact = Math.abs(right.delta ?? 0) - Math.abs(left.delta ?? 0);
      return impact || Number(right.watchlist) - Number(left.watchlist) || left.id.localeCompare(right.id);
    });
}

function renderMarkdown(rows: readonly CalibrationRow[]): string {
  const tierScores = Object.entries(ORACLE_RISK_SCORE)
    .map(([tier, score]) => `${tier}=${score}`)
    .join(", ");
  const lines = [
    "# Oracle Risk Score Calibration",
    "",
    "Scope: active crypto-backed CDPs without `variantOf`; resolvable variants inherit parent oracle exposure and do not receive a duplicate direct blend.",
    "",
    `Blend weight: ${ORACLE_RISK_BLEND_WEIGHT}`,
    `Tier scores: ${tierScores}`,
    "",
    "| coin | tier | oracle | before | after | delta | MAS | watchlist |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...rows.map(
      (row) =>
        `| ${row.symbol} (${row.id}) | ${row.tier} | ${formatValue(row.oracleScore)} | ${formatValue(row.before)} | ${formatValue(row.after)} | ${formatValue(row.delta)} | ${formatValue(row.mintAuthorityScore)} | ${row.watchlist ? "yes" : ""} |`,
    ),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

const entries = loadPerCoinStablecoinEntries();
const rows = buildRows(entries.map((entry) => entry.coin));
const markdown = renderMarkdown(rows);
const reportArg = process.argv.find((arg) => arg.startsWith("--report="));

if (reportArg) {
  const reportPath = resolve(process.cwd(), reportArg.slice("--report=".length));
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, markdown, "utf8");
  process.stdout.write(`Wrote oracle-risk calibration report to ${reportPath}\n`);
} else {
  process.stdout.write(markdown);
}
