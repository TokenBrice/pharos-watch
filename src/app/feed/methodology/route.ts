import { renderRss20, toRfc822, type RssItem } from "@/lib/rss";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { CHAIN_HEALTH_METHODOLOGY_CHANGELOG, CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH } from "@shared/lib/chains/health-version";
import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG,
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
} from "@shared/lib/methodology-versions/blacklist-tracker";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG,
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
} from "@shared/lib/methodology-versions/depeg-dews";
import {
  LIQUIDITY_METHODOLOGY_CHANGELOG,
  LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
} from "@shared/lib/methodology-versions/liquidity-score";
import {
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG,
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
} from "@shared/lib/methodology-versions/mint-burn-flow";
import {
  PRICING_PIPELINE_CHANGELOG,
  PRICING_PIPELINE_CHANGELOG_PATH,
} from "@shared/lib/methodology-versions/pricing-pipeline";
import {
  SAFETY_SCORE_CHANGELOG,
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
} from "@shared/lib/methodology-versions/safety-score";
import {
  PSI_METHODOLOGY_CHANGELOG,
  PSI_METHODOLOGY_CHANGELOG_PATH,
} from "@shared/lib/methodology-versions/stability-index";
import {
  YIELD_METHODOLOGY_CHANGELOG,
  YIELD_METHODOLOGY_CHANGELOG_PATH,
} from "@shared/lib/methodology-versions/yield-methodology";
import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const dynamic = "force-static";
export const revalidate = false;

const FEED_PATH = "/feed/methodology/";
const MAX_ITEMS = 50;

interface Source {
  key: string;
  label: string;
  path: string;
  entries: readonly MethodologyChangelogEntry[];
}

const SOURCES: readonly Source[] = [
  { key: "safety-score", label: "Safety Score", path: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH, entries: SAFETY_SCORE_CHANGELOG },
  { key: "depeg-dews", label: "Depeg + DEWS", path: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH, entries: DEPEG_DEWS_METHODOLOGY_CHANGELOG },
  { key: "psi", label: "Pharos Stability Index", path: PSI_METHODOLOGY_CHANGELOG_PATH, entries: PSI_METHODOLOGY_CHANGELOG },
  { key: "liquidity-score", label: "Liquidity Score", path: LIQUIDITY_METHODOLOGY_CHANGELOG_PATH, entries: LIQUIDITY_METHODOLOGY_CHANGELOG },
  { key: "chain-health", label: "Chain Health", path: CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH, entries: CHAIN_HEALTH_METHODOLOGY_CHANGELOG },
  { key: "blacklist-tracker", label: "Blacklist Tracker", path: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH, entries: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG },
  { key: "mint-burn-flow", label: "Mint/Burn Flow", path: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH, entries: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG },
  { key: "pricing-pipeline", label: "Pricing Pipeline", path: PRICING_PIPELINE_CHANGELOG_PATH, entries: PRICING_PIPELINE_CHANGELOG },
  { key: "yield", label: "Yield Intelligence", path: YIELD_METHODOLOGY_CHANGELOG_PATH, entries: YIELD_METHODOLOGY_CHANGELOG },
];

function methodologyItems(): RssItem[] {
  const all = SOURCES.flatMap((source) =>
    source.entries.map((entry) => ({ source, entry })),
  );
  return all
    .sort((a, b) => b.entry.effectiveAt - a.entry.effectiveAt)
    .slice(0, MAX_ITEMS)
    .map(({ source, entry }) => {
      const impactHtml = entry.impact.length
        ? `<ul>${entry.impact.map((line) => `<li>${line}</li>`).join("")}</ul>`
        : "";
      const description = `<p>${entry.summary}</p>${impactHtml}`;
      return {
        title: `${source.label} v${entry.version} — ${entry.title}`,
        link: `${SITE_URL}${source.path}`,
        description,
        guid: `pharos:methodology:${source.key}:${entry.version}`,
        pubDate: toRfc822(entry.effectiveAt * 1000),
      };
    });
}

export async function GET(): Promise<Response> {
  const items = methodologyItems();
  const lastBuildDate = items[0]?.pubDate ?? toRfc822(new Date());
  const xml = renderRss20({
    title: "Pharos Methodology Changelog",
    link: `${SITE_URL}/methodology/`,
    feedUrl: `${SITE_URL}${FEED_PATH}`,
    description:
      "Versioned methodology updates from pharos.watch — Safety Score, DEWS, PSI, Liquidity, Chain Health, Blacklist Tracker, Mint/Burn Flow, Pricing Pipeline, and Yield Intelligence.",
    language: "en-US",
    lastBuildDate,
    items,
  });
  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
