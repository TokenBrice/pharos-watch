import type { Metadata } from "next";
import { AlertsHeaderLink } from "@/components/alerts-header-link";
import { FaqSection } from "@/components/faq-section";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { ShareButton } from "@/components/share-button";
import type { FaqItem } from "@/lib/faq";
import { buildPageMetadata } from "@/lib/page-metadata";
import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import FreezeWatchClient from "./client";
import { FreezeWatchRegistryBlock } from "./registry-block";

const FREEZEWATCH_DESCRIPTION =
  "Live log of issuer freezes, unfreezes and token wipes across tracked stablecoins, including USDT, USDC and PAXG, with frozen value, addresses and transactions.";

const FREEZEWATCH_FAQ_ITEMS = [
  {
    question: "What does FreezeWatch track?",
    answer:
      "FreezeWatch logs on-chain address freezes, releases, and token wipes emitted by supported stablecoin contracts, and classifies active tracked stablecoins by whether their contracts or backing carry freeze controls.",
  },
  {
    question: "What is the difference between Direct freeze, Upstream exposure, Possible controls, and Unfreezable?",
    answer:
      "Direct freeze means the token contract or issuer can block or seize holder balances on a material deployment. Upstream exposure means no direct lock exists, but the coin relies on freezable collateral or a freezable parent. Possible controls marks upgradeable or globally pausable admin paths without confirmed address freezing. Unfreezable means no direct, upstream, or admin freeze path is identified in the reviewed model.",
  },
  {
    question: "Does an empty address check mean a wallet cannot be frozen?",
    answer:
      "No. An empty result means Pharos has no recorded freeze, release, or wipe event for that address on the contracts currently scanned. Unsupported chains, non-emitting contracts, and future issuer actions fall outside observed history.",
  },
  {
    question: "How are tracked frozen totals calculated?",
    answer:
      "Tracked frozen totals sum contract-scoped, last-known balance snapshots for recorded frozen addresses. Destroyed or confiscated funds are tracked separately as wiped value, and missing balances stay marked unavailable rather than zero.",
  },
] as const satisfies readonly FaqItem[];

export const metadata: Metadata = buildPageMetadata({
  title: "USDT & USDC Freeze Tracker: Live Blacklist Events",
  description: FREEZEWATCH_DESCRIPTION,
  canonical: "/freezewatch/",
});

export default function FreezeWatchPage() {
  return (
    <FeaturePageShell
      breadcrumbName="FreezeWatch"
      path="/freezewatch/"
      title="FreezeWatch"
      methodology={{
        version: BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
        changelogPath: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
        docsPath: "/docs/blacklist-tracker/",
      }}
      header="instrument"
      headerActions={
        <>
          <AlertsHeaderLink
            href="/pharoswatchbot/#getting-started"
            description="Get Telegram alerts when an issuer freezes, releases, or wipes a tracked stablecoin"
          />
          <ShareButton />
        </>
      }
      leadParagraphs={[
        "Live issuer freezes, releases, and wipes, with frozen value and direct vs. upstream exposure per asset.",
      ]}
    >
      <FreezeWatchClient>
        <FreezeWatchRegistryBlock />
      </FreezeWatchClient>
      <FaqSection items={FREEZEWATCH_FAQ_ITEMS} includeJsonLd />
    </FeaturePageShell>
  );
}
