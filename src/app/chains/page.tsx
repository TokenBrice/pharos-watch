import type { Metadata } from "next";
import Link from "next/link";
import {
  CHAIN_HEALTH_METHODOLOGY_VERSION,
  CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
} from "@shared/lib/methodology-versions/constants";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { methodologyAnchorFor } from "@/lib/methodology-anchors";
import { buildLiveRouteOgImageUrl, buildPageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/json-ld";
import { buildChainDirectoryJsonLd } from "@/lib/chain-json-ld";
import type { FaqItem } from "@/lib/faq";
import { FaqSection } from "@/components/faq-section";
import { JsonLdScript } from "@/components/json-ld-script";
import { ChainTypeBadge } from "@/components/chain-type-badge";
import { ShareButton } from "@/components/share-button";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { ChainsLeaderboardClient } from "./client";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { getChainDirectoryEntries, type ChainDirectoryEntry } from "./static-chain-content";

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoin Distribution by Chain",
  description:
    "Ranking blockchain networks by stablecoin supply, health score, and composition. Explore per-chain stablecoin analytics on Pharos.",
  canonical: "/chains/",
  ogImage: buildLiveRouteOgImageUrl("chains"),
});

const CHAINS_FAQ_ITEMS = [
  {
    question: "What is the Chain Health Score?",
    answer:
      "The Chain Health Score is a composite rating (0–100) that evaluates a blockchain's stablecoin ecosystem across five dimensions: stablecoin quality (supply-weighted Safety Scores), chain environment (resilience tier), concentration risk (supply distribution across coins), peg stability (supply-weighted proximity to target prices), and backing diversity (RWA-backed vs crypto-backed supply mix).",
  },
  {
    question: "Which chains have the most stablecoin supply?",
    answer:
      "The leaderboard ranks chains by the latest stablecoin supply snapshot, but supply alone doesn't tell the full story. Concentration risk and backing diversity also matter: a chain with slightly lower total supply but better distribution across high-quality, diverse stablecoins may have a higher Chain Health Score.",
  },
] satisfies readonly FaqItem[];

const SUPPLY_REFRESH_MINUTES = Math.round(FRONTEND_API_QUERY_DESCRIPTORS.chains.producerIntervalMs / 60_000);

/**
 * Every static chain profile as a folded multi-column link list. The fold is a native `<details>`, so all links stay
 * in the static HTML for crawlers alongside the ItemList JSON-LD; readers get one line per chain instead of a card wall.
 */
function ChainDirectory({ entries }: { entries: readonly ChainDirectoryEntry[] }) {
  return (
    <ModuleDisclosure label={`All ${entries.length} chain profiles`}>
      <nav aria-label="Chain profile directory" className="mt-2">
        <ul className="columns-2 gap-x-6 sm:columns-3 lg:columns-4 xl:columns-5">
          {entries.map((entry) => (
            <li key={entry.id} className="break-inside-avoid">
              <Link
                href={entry.href}
                className="pharos-focus-ring flex min-h-8 items-center justify-between gap-2 rounded-sm py-1 text-sm text-foreground underline-offset-4 hover:underline"
              >
                <span className="min-w-0 truncate">{entry.name}</span>
                <ChainTypeBadge type={entry.type} />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </ModuleDisclosure>
  );
}

export default function ChainsPage() {
  const chainEntries = getChainDirectoryEntries();
  const chainDirectoryJsonLd = buildChainDirectoryJsonLd(chainEntries);

  return (
    <FeaturePageShell
      breadcrumbName="Chains"
      path="/chains/"
      title="Chains"
      header="instrument"
      methodology={{
        label: "Chain Health methodology",
        version: CHAIN_HEALTH_METHODOLOGY_VERSION,
        changelogPath: CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
      }}
      headerActions={<ShareButton ogPath={API_PATHS.ogPage("chains")} />}
      leadParagraphs={[
        "Where stablecoin supply lives, how concentrated it is, and which chains are moving.",
        "Shares divide each chain's observed supply by observed global supply, so supply Pharos cannot place on a chain shows as Unattributed rather than being spread across chains. Chain Health rates each chain's stablecoin mix from 0 to 100; chains without enough evidence are NR, with the reason.",
      ]}
      preface={
        <JsonLdScript json={safeJsonLd(chainDirectoryJsonLd)} />
      }
    >
      <ChainsLeaderboardClient />
      <div className="space-y-0">
        <ModuleDisclosure label="FAQ and Chain Health methodology">
          <div className="mt-2 space-y-3">
            <FaqSection items={CHAINS_FAQ_ITEMS} title="Chains FAQ" includeJsonLd />
            <p className="text-sm">
              <Link href={methodologyAnchorFor("chain-health")} className="pharos-focus-ring rounded-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
                How the Chain Health score is built &rarr;
              </Link>
            </p>
          </div>
        </ModuleDisclosure>
        <ChainDirectory entries={chainEntries} />
      </div>
      <p className="pharos-meta border-t border-border/50 pt-3">
        Supply from the Pharos stablecoin snapshot, refreshed every {SUPPLY_REFRESH_MINUTES} minutes; Chain Health from
        the latest accepted Safety Score publication.
      </p>
    </FeaturePageShell>
  );
}
